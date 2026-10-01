#!/usr/bin/env bash
# Install or update Sirdar from GitHub with a sparse checkout (sirdar/ plus
# the portal files its SPA imports). Run as a user who can use docker.
#   SIRDAR_DIR=/opt/sirdar SIRDAR_BRANCH=main ./install.sh
set -euo pipefail
REPO_URL=${REPO_URL:-https://github.com/encondata/BaseCampV3.git}
DIR=${SIRDAR_DIR:-/opt/sirdar}
BRANCH=${SIRDAR_BRANCH:-main}

if [[ ! -d "$DIR/.git" ]]; then
  git clone --filter=blob:none --no-checkout --branch "$BRANCH" "$REPO_URL" "$DIR"
  git -C "$DIR" sparse-checkout init --cone
  git -C "$DIR" sparse-checkout set sirdar portal/src portal/public
  git -C "$DIR" checkout "$BRANCH"
else
  git -C "$DIR" fetch origin "$BRANCH"
  git -C "$DIR" checkout "$BRANCH"
  git -C "$DIR" reset --hard "origin/$BRANCH"
fi

if [[ ! -f "$DIR/sirdar/.env" ]]; then
  cp "$DIR/sirdar/.env.example" "$DIR/sirdar/.env"
  chmod 600 "$DIR/sirdar/.env"
  echo "Created $DIR/sirdar/.env — fill it in, then re-run this script."
  exit 0
fi

docker compose -f "$DIR/sirdar/docker-compose.yml" --env-file "$DIR/sirdar/.env" up -d --build
PORT=$(grep -E '^SIRDAR_PORT=' "$DIR/sirdar/.env" | cut -d= -f2- || true)
echo "Sirdar is starting on 127.0.0.1:${PORT:-8098}."
