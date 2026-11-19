#!/bin/sh
# `serve` (default): migrate, then run the API + the web app on :8080.
# `worker`: the background worker (Apple registration, profiles, re-signing).
# Anything else is a devices CLI command, e.g. `--help`.
set -e
case "${1:-serve}" in
  serve)
    cd /app/api
    alembic upgrade head
    # X-Forwarded-For is honored only from FORWARDED_ALLOW_IPS (the proxy,
    # compose sets it from STACK_PROXY_IP): the audit records' client
    # address comes from it. Unset: uvicorn's own default.
    exec uvicorn --factory serversherpa_devices.api.app:create_app --host 0.0.0.0 --port 8080 \
      --proxy-headers --forwarded-allow-ips="${FORWARDED_ALLOW_IPS:-127.0.0.1}"
    ;;
  worker)
    shift
    exec devices worker "$@"
    ;;
esac
exec devices "$@"
