# Process Monitor & Logging — Design

**Date:** 2026-08-26
**Status:** Approved (design conversation 2026-08-26)
**Scope:** A process registry with status page (System nav), a per-process live
log viewer (developer-only), a Postgres-backed logging pipeline shared by all
ServerSherpa processes, a new `log-service` worker (retention, SIEM
forwarding, web probe), and a tabbed System Config page (Developer nav) whose
first tab configures logging (local/remote modes, limits, syslog target).
**Out of scope:** capturing `uvicorn.access` request logs (app logs only; the
audit trail covers user actions), portal/web log capture (status probe only),
process start/stop control from the UI, HTTP(S)/HEC SIEM transport (syslog
first; transport dropdown can grow later), multi-host aggregation concerns
beyond what the schema already tolerates (hostname is recorded), historical
process-run records (one row per process name, no run history).

## Decisions (from brainstorm)

1. **Architecture A — Postgres pipeline.** Processes write log rows directly
   to Postgres via a batching handler; the log-service worker handles
   retention + forwarding. Log writes never route through the log-service, so
   logs still land when it is down.
2. **Gating:** Processes list = global actors with `max_rank >= 80`
   (super_admin and founder). Logs page, clear, config = `devtools` resource
   (god mode), `godOnly` in nav, like the existing `/dev` pages.
3. **Remote-only mode keeps a small local buffer** (`remote_buffer_rows` per
   process) so the live viewer and dev debugging keep working.
4. **Web server entry = health-check probe** (synthetic registry row, no logs
   page). Probed by the log-service.
5. **App logs only** — root logger + `uvicorn.error`; `uvicorn.access`
   excluded.
6. **Remote transports = Loki HTTP push AND syslog RFC 5424** (amended
   2026-08-26 after Plan 1 landed: the user's remote collector will be
   Grafana Loki, with Wazuh possible later for security auditing). Loki
   does not ingest syslog natively — its native path is the HTTP push API
   (`POST {url}/loki/api/v1/push`, JSON streams) — while Wazuh ingests
   syslog. The logging config therefore carries a `transport` selector:
   - `loki`: `url` (base URL), optional `username`/`password` (HTTP basic
     auth — covers Grafana Cloud), optional `tenant_id` (sent as
     `X-Scope-OrgID`). Stream labels stay low-cardinality:
     `{app: "serversherpa", process, level, host}`; the line is
     `"<logger>: <message>"`; timestamps are nanosecond strings from `at`.
     One push per forwarding batch, streams grouped by (process, level).
   - `syslog`: `host`, `port`, `protocol` (`udp` | `tcp` | `tls`) —
     RFC 5424 frames, JSON structured payload, octet-counting on TCP/TLS.
7. **One spec, two implementation plans:** Plan 1 = registry + pipeline +
   pages + wiring + log-service (hardcoded default retention, probe, no
   remote) — SHIPPED. Plan 2 = system_config API + System Config page
   (Logging tab with the transport selector) + Loki/syslog forwarding +
   remote modes.

## 1. Data model (migration 0024, revises 0023)

**`processes`** — one row per process name, upserted at startup (a restart
overwrites; no run history):

- `name: text` PK — `'api'`, `'import-worker'`, `'log-service'`, `'web'`.
- `kind: text` — `'service'` | `'worker'` | `'probe'`.
- `pid: int | null`, `hostname: text`, `started_at: timestamptz`,
  `heartbeat_at: timestamptz`, `stopped_at: timestamptz | null`,
  `meta: jsonb` default `{}` (free-form; the log-service stores
  `forwarding_degraded: true` + last error here; the web probe stores the
  probed URL and last HTTP status).

Status is DERIVED at read time, never stored:

- `running` — `stopped_at` is null or older than `heartbeat_at`, and
  `heartbeat_at` is fresher than 15 s (3 × the 5 s heartbeat interval).
- `stopped` — `stopped_at` set and >= `heartbeat_at` (clean shutdown).
- `failed` — `heartbeat_at` stale and no clean stop (crashed / killed).

**`log_entries`**:

- `id: bigserial` PK (the ordering + streaming cursor), `process: text`,
  `level: text` (name, e.g. `INFO`), `levelno: int` (numeric, for `>=`
  filters), `logger: text`, `message: text` (formatted, traceback appended),
  `extra: jsonb` default `{}`, `at: timestamptz` default now().
- Indexes: `(process, id)` and `(process, levelno, id)`. Search is `ILIKE`
  on `message` — acceptable because retention caps table size.

**`system_config`**:

- `section: text` PK, `data: jsonb`, `updated_at`, `updated_by` FK people.
- Seeded `logging` section (migration 0024): `{"mode": "local",
  "local_max_rows_per_process": 20000, "local_max_age_days": 14,
  "remote_buffer_rows": 10000, "min_level": "INFO",
  "syslog": {"host": "", "port": 514, "protocol": "udp"}}`.
- Plan 2 extends the section IN CODE (config_store `DEFAULTS`), not by
  migration — the defaults-merge supplies missing keys on old rows:
  `"transport": "loki"` and `"loki": {"url": "", "username": "",
  "password": "", "tenant_id": ""}` join the shape above.
- `mode`: `local` | `local_remote` | `remote`. In `remote`, retention uses
  `remote_buffer_rows` as the per-process cap instead of
  `local_max_rows_per_process` (age cap still applies); rows are deleted
  locally only after cap/age, NOT after forwarding, so the buffer window
  stays inspectable.
- One forwarding cursor row: section `logging_cursor`, data
  `{"last_forwarded_id": 0}` — written only by the log-service.

## 2. Process runtime — new `api/src/serversherpa/system/` package

**`registry.py`**

- `async heartbeat_loop(name, kind)` — upsert the process row (pid, hostname,
  started_at once, heartbeat_at) every 5 s. On cancellation (clean shutdown)
  set `stopped_at`. Uses the normal async engine.
- `attach(name, kind)` helpers so a process enables everything in one call:
  API from the FastAPI lifespan; workers from inside their run loop.

**`db_logging.py`**

- `DbLogHandler(process_name)` — a stdlib `logging.Handler`:
  - `emit()` formats the record (traceback included) and puts a small dict on
    a bounded in-memory queue (drop-oldest beyond 10k pending: losing debug
    lines under pressure beats unbounded memory).
  - A dedicated daemon THREAD owns a small sync engine (psycopg) and flushes
    batches (up to 200 rows or 1 s, whichever first) with `executemany`.
    Logging therefore never blocks the event loop and behaves identically in
    every process.
  - Recursion guard: the handler's own logger and any `serversherpa.system.
    db_logging` records are ignored; flush errors print to stderr once per
    minute, never re-enter logging.
  - Min level comes from the logging config, re-read at most every 30 s
    (cheap SELECT from the flusher thread); default INFO if unreadable.
- `install(process_name)` — attaches the handler to the ROOT logger,
  guarantees `uvicorn.error` propagates, and never touches `uvicorn.access`.

Config readers live in **`config_store.py`**: `get_section("logging")` with
the 30 s cache + seeded defaults fallback; used by the handler, the
log-service, and the API routes (API routes read/write uncached).

## 3. The log-service worker

New CLI command `serversherpa log-service` (mirrors `import-worker`:
`--reload` via watchfiles, `--once` for tests, same hard-kill safety). New
line in `Procfile.dev`. Registers as process `log-service`. Loop every 10 s:

1. **Retention** — per process: delete `log_entries` beyond the row cap
   (`local_max_rows_per_process`, or `remote_buffer_rows` when mode =
   `remote`) and older than `local_max_age_days`. One DELETE per process
   using the `(process, id)` index.
2. **Forwarding** (mode includes remote and the selected transport is
   configured — `loki.url` or `syslog.host` non-empty) — read rows with
   `id > last_forwarded_id` (batches of 500) and ship per the configured
   `transport`:
   - `loki`: one `POST {url}/loki/api/v1/push` per batch; streams grouped
     by (process, level) with labels `{app: "serversherpa", process,
     level, host}`; values `[ns-timestamp-string, "<logger>: <message>"]`;
     optional basic auth and `X-Scope-OrgID` from config. Non-2xx = failure.
   - `syslog`: one RFC 5424 frame per row (facility 16/local0; severity
     mapped from levelno; APP-NAME = `serversherpa-<process>`; MSG = JSON
     `{process, level, logger, message, at, extra}`), over UDP datagrams
     or TCP/TLS with octet-counting framing.
   Advance the cursor only after successful send. On failure: exponential
   backoff (10 s → 5 min max), set `meta.forwarding_degraded = true` + the
   error on its own registry row (cleared on recovery); retention keeps
   running regardless.
3. **Web probe** every 3rd tick (~30 s) — HTTP GET the portal origin
   (settings `SS_PORTAL_ORIGIN`, default `http://localhost:5173`; add to
   config template), timeout 3 s; upsert registry row `web` (kind `probe`)
   with heartbeat on success and `meta = {url, status_code}`; on failure
   leave heartbeat stale (derives to `failed`) and record the error in meta.

The log-service uses the same `install()` logging, so its own activity is
viewable like any other process.

## 4. API — new `routes/system.py` (`/system` prefix)

Rank gate helper `_require_super_admin(actor)`: global actor with
`max_rank >= 80`, else 403 (`_err` codes convention). Dev gate =
`require_permission("devtools", "change")`.

- `GET /system/processes` — super_admin+. Rows: name, kind, status (derived
  server-side), pid, hostname, started_at, heartbeat_at, stopped_at, uptime
  seconds (running only), meta. Ordered service → worker → probe, then name.
- `GET /system/processes/{name}/logs` — devtools. Params: `min_level`
  (name, default DEBUG), `q` (ILIKE substring), `before_id` (exclusive) +
  `limit` (default 200, max 1000). Returns newest-first page + `has_more`.
- `WS /system/processes/{name}/logs/stream` — devtools. Auth: the portal
  passes its bearer token as query param `token` (WebSocket cannot set
  Authorization headers from browsers); validated with the same session
  machinery before accept, else close 4401/4403. Optional params `min_level`,
  `q` (server-side filtering identical to the GET). Server tails: every 1 s,
  SELECT rows with `id > cursor` (cap 500) and push as one JSON message
  `{"entries": [...]}`; also pushes `{"ping": true}` every 30 s idle.
  Disconnect ends the poll task. (Per-connection polling is fine at this
  scale — dev-only audience, a handful of concurrent viewers.)
- `DELETE /system/processes/{name}/logs` — devtools. Deletes that process's
  rows; audited (`entity_type="system"`, `action="logs_clear"`, count in
  changes). Returns `{"deleted": n}`.
- `GET /system/config/logging` — devtools. Returns the section (uncached).
- `PUT /system/config/logging` — devtools. Full-section replace, validated:
  mode in the enum; caps positive ints (rows 1k–1M, days 1–365); min_level a
  real level name; `transport` in loki/syslog; when mode includes remote,
  the SELECTED transport's requireds apply — loki: `loki.url` a valid
  http(s) URL; syslog: `syslog.host` required, port 1–65535, protocol in
  udp/tcp/tls. 422 `invalid_logging_config` with field errors. Audited with
  before/after diff (secrets redacted in the audit changes: `loki.password`
  never appears in plaintext). Password round-trip rule: GET never returns
  the stored password (it returns `loki.password_set: bool` instead); a PUT
  whose `loki.password` is empty keeps the stored password, a non-empty
  value replaces it.
- `POST /system/config/logging/test` — devtools. Emits one WARNING log line
  ("Test event from System Config") through the normal pipeline and, when
  remote is configured, attempts one immediate send via the selected
  transport (Loki push or syslog); returns
  `{"logged": true, "forwarded": bool, "error": str | null}` so the user can
  verify Loki/SIEM receipt without waiting for the cursor loop.

Registry lists `web` like any process, but log routes 404
(`process_has_no_logs`) for kind `probe`.

## 5. Portal

**Nav/gating plumbing:** nav items and `ProtectedRoute` gain an optional
`minRank` (alongside the existing `resource`/`godOnly` gates). The Processes
item and route use `minRank: 80` with no resource requirement: the item
renders and the route resolves only when the actor's `maxRank >= 80`.

**System → Processes** (`/system/processes`):

- List (dir-list idiom): status dot + label (running = green pulse, stopped =
  gray, failed = red; "failed" shows heartbeat age in the tooltip), name,
  kind chip, hostname, pid, uptime, last heartbeat ("4 s ago", live-ticking),
  and for `log-service` a "forwarding degraded" warning chip when meta says
  so. Auto-refetches every 10 s.
- Rows navigate to the logs page only for god-mode users (`devtools` +
  godFlag); otherwise rows are inert.

**Logs page** (`/system/processes/:name/logs`, devtools + godOnly route):

- Header: back link, process name + live status dot, connection indicator
  (Live / Reconnecting…, WS state), Clear logs button (confirm dialog; calls
  DELETE, empties the view).
- Toolbar: level filter (segmented DEBUG/INFO/WARNING/ERROR — a minimum, not
  multi-select), search box (debounced; re-queries GET and re-opens the WS
  with `q`), Follow toggle.
- Body: monospace log lines, level-colored gutter, timestamp, logger,
  message (tracebacks collapse behind a "show N more lines" expander).
  Newest at the bottom; Follow on = auto-scroll pinned to bottom, and
  scrolling up automatically pauses Follow. "Load older" prepends the
  previous page (GET `before_id`).
- Transport: WS to the stream endpoint with token query param;
  auto-reconnect with backoff (1 s → 30 s), re-syncing via GET on reconnect
  so no gap is shown.

**Developer → System Config** (`/dev/system-config`, devtools + godOnly):

- Tab shell (one file per tab, tabs declared in a small array) — first tab
  **Logging**:
  - Mode radio: "Local only" / "Local + remote" / "Remote (small local
    buffer)" with one-line explainers.
  - Local limits: max rows per process, max age days; buffer rows field
    shown for remote mode.
  - Transport radio (shown when mode includes remote): "Grafana Loki"
    (URL, optional username/password, optional tenant id — password
    rendered as a password field, never echoed back by GET, which returns
    `password_set: bool` instead) / "Syslog (RFC 5424)" (host, port,
    protocol) — one option set visible at a time.
  - Minimum level select.
  - Syslog fields (shown when mode includes remote): host, port, protocol
    (udp/tcp/tls).
  - Actions: Save (PUT, inline field errors), "Send test event" (POST test;
    shows logged/forwarded/error result inline).
- Nav: new Developer item "System Config" between Developer tools and
  Database.

### 5b. System Config addendum (amended 2026-08-26, post-Plan-2)

**Design pass (user feedback: first cut "looks like crap").** The page
gets a real visual treatment: a proper underline-style tab bar (not
button chips); each settings group in its own card with an eyebrow
title + one-line description; a consistent labeled field grid; a
persistent actions row (Save + secondary actions + status text) per tab.
Copy stays sentence-case/active.

**ENV tab** (second tab, devtools-gated like everything here):

- Server module `system/env_file.py` reads the repo `.env` (same path
  Settings loads), preserving line order and comments. Classification:
  - HIDDEN — never returned or writable via the API: keys matching the
    DB/Spaces surface plus their compose-only companions
    (`SS_DATABASE_*`, `SS_SPACES_*`, `POSTGRES_*`, `MINIO_*`).
  - SECRET — introspected from `Settings`: every field typed `SecretStr`
    maps to its `SS_<UPPER>` env name (JWT secret, password pepper, TOTP
    key, god-mode words, SMTP password — and any future SecretStr
    automatically). Returned as `{key, secret: true, set: bool}`, value
    NEVER returned.
  - Everything else returns `{key, value}` plainly.
- `GET /system/env` → ordered list of visible entries.
- `PUT /system/env` body `{values: {KEY: "..."}}` — existing visible
  keys only (unknown or hidden key → 422 `invalid_env_update` listing
  offenders). Secret keys: empty string = keep, non-empty = replace.
  Writes atomically (temp file + rename) after copying the previous file
  to `.env.bak`; comments, ordering, and untouched lines preserved.
  Audited (`action="env_update"`, changed key NAMES only — never
  values).
- `POST /system/env/restart` — touch-triggered dev restart: rewrites the
  sentinel module `api/src/serversherpa/_dev_reload.py` (a tracked .py
  whose body is a timestamp comment) so uvicorn `--reload` and every
  watchfiles `--reload` worker restart and re-read `.env`. Audited.
  Returns `{"restarting": true}`. Production later maps this to a
  supervisor restart — documented, not built.
- Tab UI (amended per user feedback): the portal's STANDARD table idiom
  (list-head + grid rows, like the Processes page) with columns
  Key (mono) | Value (input; secrets as password fields with the
  set/unset chip) | Description. Description is read from a trailing
  same-line comment in the .env (`KEY=value  # description text`) —
  parsed on read (value splits from the first " #"), PRESERVED verbatim
  on rewrite, read-only in the UI. Searchable (key + description),
  changed-row rail, Save, and Restart (confirm dialog; banner
  "Processes are restarting — they reappear on the Processes page within
  ~15 s"). A note when saved-but-not-restarted: "Changes take effect
  after a restart."

**Grafana as the Loki front end (dev stack).** Loki has no UI of its
own; Grafana is the viewer. `docker-compose.dev.yml` gains BOTH:
- `loki` (grafana/loki:3.x, port 127.0.0.1:3100) — replaces the
  manually-run container; the portal logging config keeps pointing at
  `http://localhost:3100`.
- `grafana` (grafana/grafana, port 127.0.0.1:3000) — provisioned
  datasource file mounting Loki at `http://loki:3100` as the default
  datasource, admin credentials from `.env`
  (`GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD`, documented in
  `.env.example`), persistent volume. Browsing/searching logs happens in
  Grafana Explore at `http://localhost:3000`.

## 6. Wiring existing processes

- **API**: lifespan calls `system.attach("api", "service")` → installs the
  DB log handler + starts the heartbeat task; shutdown cancels it cleanly.
- **import-worker**: `run_forever` wraps its loop with
  `attach("import-worker", "worker")`; existing `print(...)` diagnostics in
  `worker.py`/`jobs.py` become `logger.info(...)` calls, and job
  lifecycle events (claimed, completed, failed, cancelled, requeued) log at
  INFO with job id + counts so the viewer shows real activity.
- **log-service**: attaches itself the same way.
- `Procfile.dev` gains `logsvc: api/.venv/bin/serversherpa log-service
  --reload`.

## 7. Error handling

API errors use `_err` codes; portal maps them (`SYSTEM_ERRORS` map) like the
import page. Pipeline failure stances: handler flush errors → stderr, never
recursive; WS auth failure → close codes, portal shows "Reconnecting…" then
"Session expired" after repeated 4401; forwarding failure → degraded chip +
backoff, never blocks retention; probe failure → `web` row shows failed.

## 8. Testing

API (pytest, real Postgres):
- Registry: heartbeat upsert; derived status for fresh/stale/clean-stop rows.
- Handler: batches land; level threshold honored; recursion guard (a failing
  flush must not emit new rows); bounded queue drops oldest.
- Log-service: retention row/age caps per mode; Loki pushes captured by a
  local HTTP test server (payload shape: streams grouped by process/level,
  ns timestamps, labels, basic-auth + X-Scope-OrgID headers when
  configured); syslog frames captured by an in-test UDP listener
  (RFC 5424 shape, severity mapping, cursor
  advances); failure sets degraded meta + cursor holds; probe upserts web row
  (httpx mock/local server).
- Routes: rank-80 gate vs devtools gate per endpoint; logs pagination/filter/
  search; WS streams appended rows then closes cleanly (httpx/starlette test
  client); WS rejects bad token; clear deletes + audits; config validation
  matrix; test-event endpoint.
- CLI: `log-service --help`, `--reload` wiring (mirrors import-worker tests).

Portal (vitest): status derivation/format helpers, log-line
formatting/collapse logic, follow-scroll pause logic, config form validation
mapping. Pages stay thin; live browser verification drives the rest.

## 9. Execution slicing

- **Plan 1 (monitor + pipeline):** migration 0024 (all three tables — schema
  lands once), system package (registry, db_logging, config_store reading
  seeded defaults), log-service worker WITHOUT forwarding (retention from the
  seeded config + web probe), API routes except the two config endpoints +
  test endpoint, both portal pages + nav/minRank plumbing, api/import-worker
  wiring, Procfile line.
- **Plan 2 (config + SIEM):** config GET/PUT/test endpoints, System Config
  page + Logging tab, syslog forwarding + cursor + degraded handling in the
  log-service, remote/buffer retention modes, portal error map additions.
