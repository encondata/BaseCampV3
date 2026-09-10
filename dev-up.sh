#!/usr/bin/env bash
# dev-up.sh — bring up the whole ServerSherpa dev stack with one command:
#
#   ./dev-up.sh            infra (docker) + migrations + api/portal/workers
#   ./dev-up.sh --no-infra skip docker (containers already running)
#
# Process list (api, portal, and every worker) lives in Procfile.dev —
# to add a future worker, add ONE line there; this script needs no edits.
# Ctrl+C stops the honcho-managed processes; docker containers stay up
# (stop them with: docker compose -f docker-compose.dev.yml down).

set -euo pipefail
cd "$(dirname "$0")"

COMPOSE="docker compose -f docker-compose.dev.yml"
VENV="api/.venv/bin"

if [[ "${1:-}" != "--no-infra" ]]; then
  if ! docker info >/dev/null 2>&1; then
    echo "error: Docker isn't running — start Docker Desktop first." >&2
    exit 1
  fi

  echo "==> starting infra containers (postgres, minio, mailpit, loki, grafana)…"
  $COMPOSE up -d

  echo "==> waiting for postgres to be healthy…"
  for _ in $(seq 1 60); do
    status=$($COMPOSE ps --format '{{.Health}}' postgres 2>/dev/null || true)
    [[ "$status" == "healthy" ]] && break
    sleep 1
  done
  if [[ "${status:-}" != "healthy" ]]; then
    echo "error: postgres never became healthy — check '$COMPOSE ps'." >&2
    exit 1
  fi
fi

echo "==> applying database migrations…"
(cd api && "../$VENV/alembic" upgrade head)

echo "==> building the rack renderer (reports)…"
npm --prefix portal run build:rack-renderer

echo "==> starting app processes from Procfile.dev (Ctrl+C stops them all)…"
exec "$VENV/honcho" start -f Procfile.dev
