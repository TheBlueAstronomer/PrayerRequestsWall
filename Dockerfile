FROM node:20-bookworm-slim

# Baileys speaks WhatsApp's binary WebSocket protocol directly, so this image no
# longer contains a browser. The ~35 Chromium shared libraries that used to be
# installed here (fonts-liberation, libatk*, libgtk-3-0, libnss3, libnspr4,
# libgbm1, libcups2, libasound2, the whole libx* set, lsb-release, xdg-utils, ...)
# existed only so a downloaded Chrome could start, and are deleted.
#
# Two packages are kept on purpose, because dropping either breaks something that
# is easy to miss and slow to diagnose:
#
#   wget            - the docker-compose.prod.yml healthcheck literally shells out
#                     to `wget ... http://127.0.0.1:3000/api/health`. It was pulled
#                     in for Chromium's benefit; nothing guarantees the slim base
#                     image ships it, and a base-image change that dropped it would
#                     leave the container permanently `unhealthy` while the app is
#                     perfectly fine — the exact false signal the healthcheck exists
#                     to avoid.
#   ca-certificates - Node verifies TLS against its own compiled-in CA bundle, so
#                     the WhatsApp socket does not strictly need this. `npm ci`
#                     below and anything that ever reaches HTTPS through wget/curl
#                     use the SYSTEM store. It is ~250 KB. Removing it to save that
#                     is not a trade worth making on a box that has twice died of
#                     causes nobody predicted.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Fail the build loudly, now, if the healthcheck's only dependency is missing,
# rather than shipping an image that reports unhealthy forever.
RUN command -v wget > /dev/null || { echo "FATAL: wget missing; the compose healthcheck would never pass"; exit 1; }

WORKDIR /app

# Copy dependency files first (better caching)
COPY package.json package-lock.json ./

# Install dependencies
#
# --foreground-scripts so dependency lifecycle scripts print into the Cloud Build
# log. Two of them matter and are otherwise completely invisible:
#   @whiskeysockets/baileys  preinstall:  node ./engine-requirements.js
#                            (exits 1 below Node 20; this base image is Node 20)
#   protobufjs               postinstall: node scripts/postinstall
# npm 11 on a dev machine DEFERS these scripts, so a local `npm install` proves
# nothing about them. The npm 10 in node:20-bookworm-slim runs them normally, and
# this flag is the only way to observe that they ran. See plan section 5, R7.
RUN npm ci --foreground-scripts

# Copy full application
COPY . .

# Build Next.js production bundle
RUN npm run build

# Create startup script
#
# The Chromium lock sweep that used to run here is gone with Chromium. It deleted
# `Singleton*` / `Lockfile` / `ChromeSingleton*` under ${WA_DATA_PATH:-/app/.wwebjs_auth}
# so a hard-killed browser could not wedge its own profile on the next boot.
# Baileys has no profile and no lock files: useMultiFileAuthState writes plain JSON
# and creates its own directory. WA_DATA_PATH had no other reader — src/lib/whatsapp.ts
# reads WA_AUTH_PATH and deliberately ignores WA_DATA_PATH — so the variable dies here.
RUN echo '#!/bin/sh\n\
set -e\n\
echo "Running database migrations..."\n\
npm run db:push\n\
echo "Starting application..."\n\
exec npm start\n' > /app/start.sh \
    && chmod +x /app/start.sh

# Expose port
EXPOSE 3000

# Use startup script instead of raw npm start
CMD ["/app/start.sh"]
