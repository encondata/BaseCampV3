#!/bin/sh
# `serve` (default): migrate, then run the API + SPA on :8080.
# Anything else is a sirdar CLI command, e.g. `import-users`, `create-admin …`.
set -e
if [ "${1:-serve}" = "serve" ]; then
  cd /app/api
  alembic upgrade head
  # --forwarded-allow-ips='*' assumes a trusted reverse proxy in front: docker-compose binds the port to
  # 127.0.0.1 by default. When SIRDAR_BIND publishes it beyond that, LAN clients can spoof X-Forwarded-For
  # (audit and session IPs only); bind to the proxy-facing address or firewall the port.
  exec uvicorn --factory sirdar_api.api.app:create_app --host 0.0.0.0 --port 8080 \
    --proxy-headers --forwarded-allow-ips='*'
fi
exec sirdar "$@"
