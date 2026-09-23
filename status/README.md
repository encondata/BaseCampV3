# ServerSherpa status page

Public, read-only status page for `status.serversherpa.com`. No login. It checks
the API, Portal, and Kiosk every minute and shows green/red plus 90-day uptime.

## What "up" means

| Service | Check | Up when |
|---|---|---|
| API | `GET {STATUS_API_URL}/system/status` | 200 + JSON object (this reads the database) |
| Portal | `GET {STATUS_PORTAL_URL}/` | 200 + the app's `id="root"` in the page |
| Kiosk | `GET {STATUS_KIOSK_URL}/config.js` | 200 |

A service shows **down** after 2 failed checks in a row and **up** again on the first
success. Every check counts toward uptime. History lives in SQLite at `/data/status.db`
(raw checks 7 days, daily totals 90 days) — mount a volume there.

## Configuration

| Variable | Default | |
|---|---|---|
| `STATUS_API_URL` | required | |
| `STATUS_PORTAL_URL` | required | |
| `STATUS_KIOSK_URL` | required | |
| `STATUS_INTERVAL_SECONDS` | 60 | minimum 10 |
| `STATUS_TIMEOUT_SECONDS` | 10 | |
| `STATUS_FAILURE_THRESHOLD` | 2 | |
| `STATUS_DB_PATH` | `/data/status.db` | |

## Deploy

    cp status/.env.example status/.env
    docker compose -f status/docker-compose.yml --env-file status/.env up -d --build

Point the reverse proxy's `status.serversherpa.com` host at the container's port
(default host port 8095 → container 8080). `GET /healthz` is the container health check.

## Develop

    python3.13 -m venv status/.venv && status/.venv/bin/pip install -e 'status[dev]'
    (cd status && .venv/bin/pytest -q)
    npm --prefix status/web install && npm --prefix status/web test

Run the checker + API locally and the page with hot reload:

    STATUS_API_URL=http://localhost:8000 STATUS_PORTAL_URL=http://localhost:5173 \
    STATUS_KIOSK_URL=http://localhost:5174 STATUS_DB_PATH=status/dev.db \
    status/.venv/bin/python -m serversherpa_status
    npm --prefix status/web run dev      # http://localhost:5176, proxies /api to :8080

The page imports the portal's stylesheets (`portal/src/styles`) so it always matches
the portal's look.
