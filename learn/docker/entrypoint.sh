#!/bin/sh
# Writes the runtime config the learn site reads before its bundle loads,
# then hands off to Caddy. The API URL is required — a learn site with no
# API is a sign-in page that can't sign anyone in, so fail loudly here.
set -eu
: "${LEARN_API_URL:?LEARN_API_URL is required (e.g. https://api.example.com)}"
if [ "$(printf '%s' "$LEARN_API_URL" | wc -l)" -ne 0 ]; then
  echo "LEARN_API_URL must not contain a newline" >&2
  exit 1
fi
api_url=$(printf '%s' "$LEARN_API_URL" | sed 's/[\\"]/\\&/g')
cat > /srv/config.js <<CONFIG
window.__LEARN_CONFIG__ = { apiUrl: "${api_url}" };
CONFIG
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
