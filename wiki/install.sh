#!/usr/bin/env bash
# Install or update the ServerSherpa wiki on a Docker host.
#
# Fetches ONLY what the wiki images need from the BaseCampV3 repo (a sparse
# checkout of wiki/ + api/ + portal/src + portal/public), pulls the base
# images, then builds and starts both containers. Re-run it any time to
# pull the latest code and redeploy.
#
#   bash install.sh
#
# Overridable via environment:
#   WIKI_DIR      checkout location        (default /opt/serversherpa-wiki)
#   WIKI_BRANCH   branch to deploy         (default main)
#   REPO_URL      repository               (default https://github.com/encondata/BaseCampV3.git)
set -euo pipefail

WIKI_DIR="${WIKI_DIR:-/opt/serversherpa-wiki}"
WIKI_BRANCH="${WIKI_BRANCH:-main}"
REPO_URL="${REPO_URL:-https://github.com/encondata/BaseCampV3.git}"
BASE_IMAGES=(node:20-alpine python:3.13-slim)

say() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null || die "git is not installed"
command -v docker >/dev/null || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"
docker info >/dev/null 2>&1 || die "cannot reach the Docker daemon (is it running? do you need sudo?)"

if [ -d "$WIKI_DIR/.git" ]; then
  say "Updating $WIKI_DIR ($WIKI_BRANCH)"
  git -C "$WIKI_DIR" fetch --depth 1 origin "$WIKI_BRANCH"
  git -C "$WIKI_DIR" checkout -q -B "$WIKI_BRANCH" FETCH_HEAD
else
  say "Fetching the wiki from $REPO_URL ($WIKI_BRANCH)"
  mkdir -p "$(dirname "$WIKI_DIR")"
  git clone --depth 1 --filter=blob:none --sparse --branch "$WIKI_BRANCH" "$REPO_URL" "$WIKI_DIR"
fi
git -C "$WIKI_DIR" sparse-checkout set wiki api portal/src portal/public

say "Pulling base images"
for image in "${BASE_IMAGES[@]}"; do docker pull "$image"; done

ENV_FILE="$WIKI_DIR/wiki/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp "$WIKI_DIR/wiki/.env.example" "$ENV_FILE"
  say "Created $ENV_FILE"
  echo "Edit it: WIKI_API_URL, WIKI_SERVICE_TOKEN, and the SS_* database/Spaces"
  echo "settings wiki-worker needs (copy those from the main API's .env), then"
  echo "re-run this script."
  exit 0
fi

say "Building and starting the wiki"
docker compose -f "$WIKI_DIR/wiki/docker-compose.yml" --env-file "$ENV_FILE" up -d --build

port="$(sed -n 's/^WIKI_PORT=//p' "$ENV_FILE" | tail -1)"
port="${port:-8096}"
say "Waiting for http://localhost:$port/healthz"
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$port/healthz" >/dev/null 2>&1; then
    echo "The wiki is up on port $port. Point wiki.serversherpa.com at it in the reverse proxy (WebSockets on)."
    exit 0
  fi
  sleep 2
done
die "the container did not become healthy; check: docker compose -f $WIKI_DIR/wiki/docker-compose.yml logs"
