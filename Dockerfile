FROM node:20-bookworm-slim

# Install system dependencies required for Puppeteer / Chromium
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libc6 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libexpat1 \
    libfontconfig1 \
    libgbm1 \
    libgcc1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libstdc++6 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    lsb-release \
    wget \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy dependency files first (better caching)
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy full application
COPY . .

# Build Next.js production bundle
RUN npm run build

# Create startup script
RUN echo '#!/bin/sh\n\
echo "Running database migrations..."\n\
npm run db:push\n\
echo "Starting application..."\n\
exec npm start\n' > /app/start.sh \
    && chmod +x /app/start.sh

# Expose port
EXPOSE 3000

# Use startup script instead of raw npm start
CMD ["/app/start.sh"]
