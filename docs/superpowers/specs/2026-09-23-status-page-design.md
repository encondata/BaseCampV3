# ServerSherpa status page — design

**Date:** 2026-09-23 · **Branch:** `status-page` · **Approved by:** Jimmy (chat, 2026-09-23)

## Goal

A standalone, public, view-only status page at `status.serversherpa.com` that shows the
current state (green/red) and 90-day uptime of the three V3 services: **API**, **Portal**,
**Kiosk**. No login, no permissions, no write surface. It ships as its own Docker image and
sits behind the existing reverse proxy (Nginx Proxy Manager).

## Non-goals

- No incident posts, maintenance notes, subscriptions, or email alerts.
- No amber/"degraded" state — green or red only (a grey "no data" is shown only for
  days the status service itself recorded nothing).
- No monitoring of workers, Postgres, MinIO, or other internals beyond what the API
  probe implies.
- No dark theme (the portal is light-only today; follow it).

## Architecture

One container, one process, one port (8080), one volume (`/data`).

```
status/
  Dockerfile               multi-stage: node:20-alpine builds web/, python:3.13-slim runs app
  docker-compose.yml       example deployment (port, env, volume)
  README.md
  .env.example
  pyproject.toml           package `serversherpa_status`
  src/serversherpa_status/
    config.py              env → Settings (frozen dataclass)
    probes.py              one probe per service kind → ProbeResult(ok, latency_ms, detail)
    store.py               SQLite: checks + daily rollup, prune, summary queries
    state.py               2-strike rule: per-service consecutive-failure tracking
    checker.py             asyncio loop: probe all services concurrently every interval;
                           on start, replays the last N checks so a restart keeps its state
    summary.py             builds the public /api/summary JSON
    app.py                 FastAPI: GET /api/summary, GET /healthz, static files for the page
    __main__.py            `python -m serversherpa_status`: config check, then uvicorn :8080
  tests/                   pytest (+ respx for HTTP)
  web/                     Vite + React + TS page (index.html, src/, vite config)
```

The build context is the **repo root** (same as `kiosk/Dockerfile`) so the page can import
`portal/src/styles/base.css` and `portal/src/styles/portal-theme.css` for the exact portal
tokens and fonts. The page wraps itself in `.portal-shell` (overriding its grid layout) to
inherit the light token set (`--paper`, `--ink`, `--accent`, `--c-green*`, `--c-red*`, etc.).

## Probes (server-side, via httpx)

| Service | Request | Green when |
|---|---|---|
| API | `GET {STATUS_API_URL}/system/status` | HTTP 200 and body parses as a JSON object |
| Portal | `GET {STATUS_PORTAL_URL}/` | HTTP 200 and body contains `id="root"` |
| Kiosk | `GET {STATUS_KIOSK_URL}/config.js` | HTTP 200 |

`/system/status` is chosen over `/healthz` because it reads the database, so a dead DB
reads red. Everything else — non-200, bad body, timeout, connection error — is a failed
check. Redirects are followed. Timeout default 10 s.

**2-strike rule:** a service's *displayed* state flips to red only after 2 consecutive
failed checks, and back to green on the first successful check. Every raw check (pass or
fail) is still recorded for uptime math. Before any check has run the state is `unknown`.

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `STATUS_API_URL` | required | may be an internal Docker hostname |
| `STATUS_PORTAL_URL` | required | |
| `STATUS_KIOSK_URL` | required | |
| `STATUS_INTERVAL_SECONDS` | `60` | min 10 |
| `STATUS_TIMEOUT_SECONDS` | `10` | |
| `STATUS_FAILURE_THRESHOLD` | `2` | the 2-strike rule |
| `STATUS_DB_PATH` | `/data/status.db` | |

Missing required URLs → the container exits at start with a clear message (kiosk
entrypoint precedent).

## Storage and uptime math (SQLite)

- `checks(id, service, at, ok, latency_ms, detail)` — raw rows, pruned after **7 days**.
- `daily(service, day, ok_count, total_count)` — UTC-day rollup, upserted on each check,
  pruned after **90 days**.
- Pruning runs once per hour inside the checker loop.
- Uptime % for the window = Σok / Σtotal over the `daily` rows in the last 90 days;
  `null` when there are no rows.
- Each daily bar: `ok_count / total_count`; a day with no row renders grey "No data".

## API (read-only)

`GET /api/summary` →

```json
{
  "generated_at": "2026-09-23T15:04:05Z",
  "overall": "operational" | "degraded" | "unknown",
  "interval_seconds": 60,
  "failure_threshold": 2,
  "services": [
    {
      "key": "api", "name": "API",
      "state": "up" | "down" | "unknown",
      "last_checked_at": "…", "latency_ms": 42,
      "uptime_90d": 99.93,
      "days": [ { "day": "2026-06-26", "ok": 1440, "total": 1440 }, … 90 entries, oldest first; ok/total null when no data ]
    }
  ]
}
```

`overall` = `degraded` when any service is down, `operational` when all are up, otherwise
`unknown` (some service not yet established, or a service's last check has gone stale — see
below). The response **never** contains service URLs or probe error detail (`detail` stays in
SQLite for operators). `interval_seconds`/`failure_threshold` mirror the checker's own config
and drive the page footer's copy, so it can never drift from what the checker actually does.
The response is cached server-side for `SUMMARY_TTL_SECONDS` (5s) so unauthenticated traffic
can't hammer SQLite; `Cache-Control: no-store` still applies (the cache is server-side, not a
promise to the client). A service whose `last_checked_at` is older than
`3 * interval_seconds + timeout_seconds` reports `state: "unknown"` rather than trusting a
check that may never run again.

`GET /healthz` → `{"status":"ok"}` (Docker HEALTHCHECK), or `503 {"status":"stale"}` when no
checker cycle has completed within that same staleness window, or `503 {"status":"store_error"}`
when the last cycle's store writes failed. All other paths are the built page's static files
(unknown paths 404). Security headers mirror the kiosk Caddyfile: `X-Frame-Options DENY`,
`X-Content-Type-Options nosniff`, `Referrer-Policy same-origin`. Only GET/HEAD are routed.

## Checker resilience

The checker runs as a lifespan background task. Each cycle is wrapped: an unexpected
exception is logged and the loop continues next interval (it never dies silently). The
three probes in a cycle run concurrently.

## Page (portal look)

- Page header: ServerSherpa logo (copied from `portal/public/images/serversherpa-logo.png`)
  + "System Status" in Geologica; small mono "Updated HH:MM:SS".
- Overall banner: green "All systems operational" / red "N service(s) down" /
  slate "Checking…" (unknown), using the portal's `--c-green*` / `--c-red*` / `--c-slate*`
  chip tokens.
- One card per service: status dot + name + state word ("Operational" / "Down"),
  response time (mono), 90-day uptime % (mono; exactly 100 shows "100%", otherwise two decimals
  truncated, never rounded up to 100 — e.g. "99.99%"; "—" when null),
  and a 90-bar daily strip. Bar color: green when the day is 100%, red when the day has
  any failure, grey when there's no data. Hover/focus a bar → tooltip with date, uptime %
  for the day, and checks count. Axis labels "90 days ago" / "Today" under the strip.
- Polls `/api/summary` every 30 s and on `visibilitychange`. If a fetch fails, keep the
  last data and show a notice "Status data may be stale — last updated HH:MM" — never
  fabricate green.
- Responsive: at phone width the strip shows the last 30 days (keeps bars tappable),
  16 px gutter, no horizontal scroll.
- American English throughout.

## Testing

- **pytest** (`status/tests`): probe classification per service (200/500/bad body/timeout/
  connection error, via respx); 2-strike state transitions; store upsert/rollup/prune and
  uptime math with explicit timestamps; summary shape (90 days, nulls for gaps, no URLs
  leaked); app routes (summary, healthz, headers, static fallback, POST → 405).
- **vitest** (`status/web`): banner variants, card rendering, strip colors, stale notice.
- **Live**: build the image, run it against the dev stack (`api.dev`, `portal.dev`,
  `kiosk.dev` or localhost ports), confirm green; stop one service and watch it go red
  after two intervals (run with a short interval for the check).
