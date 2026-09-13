#!/bin/sh
# Writes the runtime config the kiosk reads before its bundle loads, then
# hands off to Caddy. Both URLs are required — a kiosk with no API is a
# blank screen, so fail loudly here instead.
set -eu
: "${KIOSK_API_URL:?KIOSK_API_URL is required (e.g. https://api.example.com)}"
: "${KIOSK_PORTAL_URL:?KIOSK_PORTAL_URL is required (e.g. https://portal.example.com)}"
cat > /srv/config.js <<EOF
window.__KIOSK_CONFIG__ = { apiUrl: "${KIOSK_API_URL}", portalUrl: "${KIOSK_PORTAL_URL}" };
EOF
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
