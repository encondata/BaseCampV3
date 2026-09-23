#!/usr/bin/env bash
# Install or update the ServerSherpa status page on a Docker host.
#
# Fetches ONLY what the status image needs from the BaseCampV3 repo (a sparse
# checkout of status/ + portal/src/styles — the page imports the portal's
# stylesheets), pulls the base images, then builds and starts the container.
# Re-run it any time to pull the latest code and redeploy; status history in
# the status-data volume is kept.
#
#   bash install.sh
#
# Overridable via environment:
#   STATUS_DIR     checkout location        (default /opt/serversherpa-status)
#   STATUS_BRANCH  branch to deploy         (default status-page)
#   REPO_URL       repository               (default https://github.com/encondata/BaseCampV3.git)
set -euo pipefail

STATUS_DIR="${STATUS_DIR:-/opt/serversherpa-status}"
STATUS_BRANCH="${STATUS_BRANCH:-status-page}"
REPO_URL="${REPO_URL:-https://github.com/encondata/BaseCampV3.git}"
BASE_IMAGES=(node:20-alpine python:3.13-slim)

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git is not installed"
command -v docker >/dev/null || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"
docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon (is it running? do you need sudo?)"

if [ -d "$STATUS_DIR/.git" ]; then
  say "Updating $STATUS_DIR ($STATUS_BRANCH)"
  git -C "$STATUS_DIR" fetch --depth 1 origin "$STATUS_BRANCH"
  git -C "$STATUS_DIR" checkout -q -B "$STATUS_BRANCH" FETCH_HEAD
else
  say "Fetching the status page from $REPO_URL ($STATUS_BRANCH)"
  mkdir -p "$(dirname "$STATUS_DIR")"
  git clone --depth 1 --filter=blob:none --sparse --branch "$STATUS_BRANCH" "$REPO_URL" "$STATUS_DIR"
fi
git -C "$STATUS_DIR" sparse-checkout set status portal/src/styles

say "Pulling base images"
for image in "${BASE_IMAGES[@]}"; do docker pull "$image"; done

ENV_FILE="$STATUS_DIR/status/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$STATUS_DIR/status/.env.example" "$ENV_FILE"
  say "Created $ENV_FILE"
  echo "Edit the three STATUS_*_URL values (and STATUS_PORT if 8095 is taken), then re-run this script."
  exit 0
fi

say "Building and starting the status page"
docker compose -f "$STATUS_DIR/status/docker-compose.yml" --env-file "$ENV_FILE" up -d --build

port="$(sed -n 's/^STATUS_PORT=//p' "$ENV_FILE" | tail -1)"
port="${port:-8095}"
say "Waiting for http://localhost:$port/healthz"
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$port/healthz" >/dev/null 2>&1; then
    echo "Status page is up on port $port. Point status.serversherpa.com at it in the reverse proxy."
    exit 0
  fi
  sleep 2
done
die "the container did not become healthy; check: docker compose -f $STATUS_DIR/status/docker-compose.yml logs"
