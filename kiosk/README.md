# ServerSherpa Kiosk (web mode)

The scanning-floor app. This build is the web mode: a static React app that
talks to the same API as the portal and mirrors its design. Laptop Mode,
RFID Middleware, and the Device App come later and share this code.

Design: `docs/superpowers/specs/2026-09-13-kiosk-web-design.md`.

## Run it in development

```bash
npm install
npm run dev          # http://localhost:5174 (also on the LAN via --host)
npm test             # vitest
npx tsc -b           # type-check
```

Or from the repo root, `api/.venv/bin/honcho start -f Procfile.dev` runs
the API, portal, workers, and the kiosk together.

## Configuration

Resolved per request, first match wins:

1. `window.__KIOSK_CONFIG__` from `/config.js` (the Docker entrypoint writes it)
2. `VITE_API_URL` / `VITE_PORTAL_URL` at build time
3. `http://<this host>:8000` and `http://<this host>:5173`

## Docker

```bash
cp kiosk/.env.example kiosk/.env        # edit the URLs
docker compose -f kiosk/docker-compose.yml --env-file kiosk/.env up --build
# → http://localhost:8090
```

The build context is the repo root because the kiosk imports stylesheets
and React-free helpers from `portal/src` (see `vite.config.ts` and the
`portalImports.test.ts` guardrail).

## Sign-in methods

- **Email & password** — the portal login with `client: "kiosk"`; the API
  refuses accounts without the `kiosk` permission.
- **Link with phone** — the kiosk shows a QR of `<portal>/link/<code>`;
  the signed-in person approves on their phone and the kiosk signs in as
  them within two seconds.
- **Move password** — placeholder; not available yet.

Every signed-in kiosk heartbeats to `/kiosk/heartbeat` once a minute and
appears on the portal's Kiosk Devices page. Register/Renew stays there.
