#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/var/intercessor/app"
DATA_DIR="/var/intercessor/data"
BACKUP_DIR="${APP_DIR}/migrate-backups-$(date -u +%Y%m%dT%H%M%SZ)"

echo "=== Migrating to ${APP_DIR} ==="

sudo mkdir -p "${APP_DIR}" "${DATA_DIR}" "${BACKUP_DIR}"
# make sure directories exist and have reasonable perms
sudo chown -R "$(whoami):$(whoami)" /var/intercessor || true
sudo chmod -R 750 /var/intercessor

# If repo exists in homedir, copy (don't clobber). Use rsync so incremental and safe.
if [ -d "${HOME}/PrayerRequestsWall" ]; then
  echo "Found ${HOME}/PrayerRequestsWall — copying code to ${APP_DIR} (no overwrite of existing files)..."
  rsync -av --ignore-existing "${HOME}/PrayerRequestsWall/" "${APP_DIR}/"
fi

# Move or copy .env only if exists and not already present at target
if [ -f "${HOME}/PrayerRequestsWall/.env" ]; then
  if [ -f "${APP_DIR}/.env" ]; then
    echo ".env already present in ${APP_DIR}; backing up source to ${BACKUP_DIR}"
    cp "${HOME}/PrayerRequestsWall/.env" "${BACKUP_DIR}/.env.from_home"
  else
    echo "Copying .env to ${APP_DIR}"
    cp "${HOME}/PrayerRequestsWall/.env" "${APP_DIR}/.env"
    sudo chmod 600 "${APP_DIR}/.env"
    sudo chown "$(whoami):$(whoami)" "${APP_DIR}/.env"
  fi
fi

# Move session state to persistent data dir (rsync for safety)
if [ -d "${HOME}/PrayerRequestsWall/.wwebjs_auth" ]; then
  echo "Migrating WhatsApp session to ${DATA_DIR}"
  rsync -av --ignore-existing "${HOME}/PrayerRequestsWall/.wwebjs_auth/" "${DATA_DIR}/.wwebjs_auth/"
  sudo chmod -R 700 "${DATA_DIR}/.wwebjs_auth"
  sudo chown -R "$(whoami):$(whoami)" "${DATA_DIR}/.wwebjs_auth"
fi

# Ensure deploy folder for scripts
sudo mkdir -p /opt/deploy
sudo chown root:root /opt/deploy
sudo chmod 755 /opt/deploy

echo "Migration completed. Backups (if any) stored under ${BACKUP_DIR}"
