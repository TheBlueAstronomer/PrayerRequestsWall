#!/usr/bin/env bash
set -euo pipefail

# ------------- config (edit if needed) -------------
# Allow overriding HOST_DATA_PATH externally (Cloud Build/SSH sets this to /var/intercessor/data in prod).
# Default to ./data to keep local Windows/macOS dev working.
HOST_DATA_PATH="${HOST_DATA_PATH:-./data}"
export HOST_DATA_PATH

# ensure HOST_DATA_PATH exists (fail early if a production run forgot to set it)
if [ ! -d "${HOST_DATA_PATH}" ]; then
  echo "HOST_DATA_PATH=${HOST_DATA_PATH} does not exist. Creating it..."
  mkdir -p "${HOST_DATA_PATH}" || { echo "Failed to create ${HOST_DATA_PATH}"; exit 4; }
fi
DB_FILE="${HOST_DATA_PATH}/sqlite.db"
BACKUP_DIR="${HOST_DATA_PATH}/backups"
APP_SERVICE_NAME="app"             
HEALTH_URL="http://127.0.0.1:80/api/health"
HEALTH_RETRIES=12
HEALTH_INTERVAL=5
# ---------------------------------------------------

if [ -z "${DEPLOY_IMAGE:-}" ]; then
  echo "ERROR: DEPLOY_IMAGE must be set (full image URL with tag)"
  exit 2
fi

echo "Deployment started: ${DEPLOY_IMAGE}"
mkdir -p "${BACKUP_DIR}"

# 1. Save current image for rollback (if running)
CURRENT_CONTAINER_ID="$(docker-compose ps -q ${APP_SERVICE_NAME} || true)"
CURRENT_IMAGE=""
if [ -n "${CURRENT_CONTAINER_ID}" ]; then
  CURRENT_IMAGE="$(docker inspect --format='{{.Config.Image}}' "${CURRENT_CONTAINER_ID}" || true)"
  echo "Current running image: ${CURRENT_IMAGE:-<none>}"
else
  echo "No current container running for service ${APP_SERVICE_NAME}"
fi

# 2. Backup DB (absolute path)
if [ -f "${DB_FILE}" ]; then
  BACKUP_NAME="$(date -u +%Y%m%dT%H%M%SZ)"
  echo "Backing up DB -> ${BACKUP_DIR}/sqlite.db.${BACKUP_NAME}"
  cp "${DB_FILE}" "${BACKUP_DIR}/sqlite.db.${BACKUP_NAME}"
  # optional: upload to GCS
  # gsutil cp "${BACKUP_DIR}/sqlite.db.${BACKUP_NAME}" gs://YOUR_BACKUP_BUCKET/
fi

# 3. Pull image
export DEPLOY_IMAGE="${DEPLOY_IMAGE}"
echo "Pulling image ${DEPLOY_IMAGE}"
docker pull "${DEPLOY_IMAGE}"

# 4. Update Container
echo "Refreshing service with docker-compose..."
# Ensure docker-compose uses the exported HOST_DATA_PATH
docker-compose pull "${APP_SERVICE_NAME}" || true
docker-compose up -d --no-deps --remove-orphans "${APP_SERVICE_NAME}"

# 5. Healthcheck
echo "Waiting for ${HEALTH_URL} (retries=${HEALTH_RETRIES}, interval=${HEALTH_INTERVAL}s)"
i=0
until curl --fail --silent --show-error --max-time 5 "${HEALTH_URL}" >/dev/null 2>&1; do
  i=$((i+1))
  if [ "${i}" -ge "${HEALTH_RETRIES}" ]; then
    echo "ERROR: Health check failed after ${HEALTH_RETRIES} attempts."
    echo "=== app logs (tail 200) ==="
    docker-compose logs --tail=200 "${APP_SERVICE_NAME}" || true

    # ROLLBACK: restore previous image if available
    if [ -n "${CURRENT_IMAGE}" ]; then
      echo "Attempting rollback to previous image: ${CURRENT_IMAGE}"
      export DEPLOY_IMAGE="${CURRENT_IMAGE}"
      docker pull "${DEPLOY_IMAGE}" || true
      docker-compose up -d --no-deps --remove-orphans "${APP_SERVICE_NAME}" || true
      echo "Rollback attempted; check logs."
    else
      echo "No previous image available to rollback to."
    fi

    exit 3
  fi
  echo "health attempt ${i}/${HEALTH_RETRIES} failed; sleeping ${HEALTH_INTERVAL}s..."
  sleep "${HEALTH_INTERVAL}"
done

echo "Health check passed. Cleaning up old images..."
docker image prune -f --filter "until=168h" || true

echo "Deploy successful: ${DEPLOY_IMAGE}"
exit 0
