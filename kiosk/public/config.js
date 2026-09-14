// Dev default: nothing set, so lib/config.ts falls back to VITE_* env
// and then to http://<this host>:8000 / :5173. The Docker image's
// entrypoint overwrites this file from KIOSK_API_URL / KIOSK_PORTAL_URL.
window.__KIOSK_CONFIG__ = {};
