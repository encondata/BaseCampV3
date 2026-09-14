#!/bin/sh
# Writes the runtime config the kiosk reads before its bundle loads, then
# hands off to Caddy. Both URLs are required — a kiosk with no API is a
# blank screen, so fail loudly here instead.
set -eu
: "${KIOSK_API_URL:?KIOSK_API_URL is required (e.g. https://api.example.com)}"
: "${KIOSK_PORTAL_URL:?KIOSK_PORTAL_URL is required (e.g. https://portal.example.com)}"
for v in "$KIOSK_API_URL" "$KIOSK_PORTAL_URL"; do
  if [ "$(printf '%s' "$v" | wc -l)" -ne 0 ]; then
    echo "KIOSK_API_URL and KIOSK_PORTAL_URL must not contain a newline" >&2
    exit 1
  fi
done
api_url=$(printf '%s' "$KIOSK_API_URL" | sed 's/[\\"]/\\&/g')
portal_url=$(printf '%s' "$KIOSK_PORTAL_URL" | sed 's/[\\"]/\\&/g')
cat > /srv/config.js <<EOF
window.__KIOSK_CONFIG__ = { apiUrl: "${api_url}", portalUrl: "${portal_url}" };
EOF
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
