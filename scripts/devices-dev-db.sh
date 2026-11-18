#!/usr/bin/env bash
# devices-dev-db.sh — create the Devices service's dev database and bucket on
# the Mac dev stack (docker-compose.dev.yml). Safe to re-run: each step only
# creates what is missing.
#
#   scripts/devices-dev-db.sh
#
#   - database serversherpa_devices on the dev Postgres (127.0.0.1:5433)
#   - bucket serversherpa-devices on dev MinIO
#
# Then migrate it: cd devices/api && .venv/bin/alembic upgrade head
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
DB=serversherpa_devices
BUCKET=serversherpa-devices

cd "$REPO"
compose() { docker compose -f docker-compose.dev.yml "$@"; }

# The container's own POSTGRES_USER / POSTGRES_DB; nothing secret is printed.
exists=$(compose exec -T postgres sh -c \
  "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT 1 FROM pg_database WHERE datname = '$DB'\"")
if [[ "$exists" == "1" ]]; then
  echo "database $DB already exists"
else
  compose exec -T postgres sh -c \
    "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -qc 'CREATE DATABASE $DB'"
  echo "created database $DB"
fi

compose exec -T minio sh -c \
  "mc alias set local http://localhost:9000 \"\$MINIO_ROOT_USER\" \"\$MINIO_ROOT_PASSWORD\" >/dev/null \
   && mc mb --ignore-existing local/$BUCKET"
