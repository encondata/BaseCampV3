#!/bin/sh
# `serve` (default): migrate, then run the API + SPA on :8080.
# Anything else is a sirdar CLI command, e.g. `import-users`, `create-admin …`.
set -e
if [ "${1:-serve}" = "serve" ]; then
  cd /app/api
  alembic upgrade head
  exec uvicorn --factory sirdar_api.api.app:create_app --host 0.0.0.0 --port 8080 \
    --proxy-headers --forwarded-allow-ips='*'
fi
exec sirdar "$@"
