# ServerSherpa status page

Public, read-only status page for `status.serversherpa.com`. No login. It checks
the API, Portal, Kiosk, and (optionally) the Wiki every minute and shows green/red plus
90-day uptime. Each service appears by its title only; URLs are never shown or sent.

## What "up" means

| Service | Check | Up when |
|---|---|---|
| API | `GET {STATUS_API_URL}/system/status` | 200 + JSON object (this reads the database) |
| Portal | `GET {STATUS_PORTAL_URL}/` | 200 + the app's `id="root"` in the page |
| Kiosk | `GET {STATUS_KIOSK_URL}/config.js` | 200 |
| Wiki (optional) | `GET {STATUS_WIKI_URL}/` | 200 + the app's `id="root"` in the page |

A service shows **down** after 2 failed checks in a row and **up** again on the first
success. Every check counts toward uptime. History lives in SQLite at `/data/status.db`
(raw checks 7 days, daily totals 90 days) — mount a volume there. Daily uptime bars are
**UTC calendar days** (the page's axis and tooltips say so); the footer's "Checks run
every…" line is generated from `STATUS_INTERVAL_SECONDS`/`STATUS_FAILURE_THRESHOLD`, so it
always matches the configured cadence rather than a hardcoded guess.

## Configuration

| Variable | Default | |
|---|---|---|
| `STATUS_API_URL` | required | |
| `STATUS_PORTAL_URL` | required | |
| `STATUS_KIOSK_URL` | required | |
| `STATUS_WIKI_URL` | unset | optional; when set, a Wiki card is added |
| `STATUS_INTERVAL_SECONDS` | 60 | minimum 10 |
| `STATUS_TIMEOUT_SECONDS` | 10 | |
| `STATUS_FAILURE_THRESHOLD` | 2 | |
| `STATUS_DB_PATH` | `/data/status.db` | |
| `PORT` | 8080 | container listen port; the Docker `HEALTHCHECK` follows it |
| `STATUS_STATIC_DIR` | `/app/static` in the image | where the built page is served from |

## Deploy

On a Docker host (needs git, Docker, and the compose plugin), `install.sh` fetches only `status/` and `portal/src/styles` with a sparse
checkout, pulls the base images, and builds and starts the container. The first run
creates `status/.env` and stops so you can fill in the URLs. Run it again to deploy, and
re-run it any time to update (status history in the `status-data` volume is kept).

    curl -fsSL -o install.sh https://raw.githubusercontent.com/encondata/BaseCampV3/status-page/status/install.sh
    bash install.sh

Settings: `STATUS_DIR` (default `/opt/serversherpa-status`), `STATUS_BRANCH` (default
`status-page`), `REPO_URL` (default `https://github.com/encondata/BaseCampV3.git`).

Or by hand from a full checkout:

    cp status/.env.example status/.env
    docker compose -f status/docker-compose.yml --env-file status/.env up -d --build

Point the reverse proxy's `status.serversherpa.com` host at the container's port
(default host port 8095 → container 8080). `GET /healthz` is the container health check —
it returns `200 {"status":"ok"}` when a recent checker cycle has completed cleanly, and a
`503` otherwise: `{"status":"stale"}` when no cycle has completed within roughly three
check intervals (the checker loop itself is stuck or dead), or `{"status":"store_error"}`
when the last cycle ran but its SQLite writes failed (displayed state is still current —
only history/uptime storage is broken).

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
