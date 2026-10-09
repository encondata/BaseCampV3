# Database health tab — design

**Date:** 2026-10-09
**Tracker:** System and operations › "Database health and table statistics" (Feature Parity 366, Gaps line 91; marked Retired — building it makes it Complete). To-Do #36 part 2.
**Branch:** `db-health`

## Goal

A **Health** tab on `/dev/database` (after Reconcile, Backups, Testing,
Cleanup), developer-only, showing database health, who is connected,
per-table statistics with a per-table Vacuum & analyze action, and file
storage usage. Manual **Refresh**; no polling.

## Jimmy's decisions (2026-10-09)

- Placement: a new tab on `/dev/database`.
- Extras on top of V2's read-only stats: who's connected, file storage
  usage, and a per-table Vacuum & analyze button.

## What V2 had

Size, version, host, latency, uptime; connections vs `max_connections`;
`pg_stat_user_tables` rows, total/table/index size, dead tuples, last
vacuum/analyze. No server-side role check (V3 fixes that).

## Access

`/devtools/health/*`: `devtools:view` for everything read-only,
`devtools:change` for vacuum. Same dependency style as
`api/routes/cleanup.py`.

## 1. Connection names (prerequisite)

No V3 process names its database connections today, so Postgres can't tell
the API from a worker. `db/engine.py` gains
`set_application_name(name: str)` (call before the engine is first built)
and passes `server_settings={"application_name": name}` through
`connect_args`. Default when nothing is set: `serversherpa`. The API app
sets `serversherpa-api` at startup; every CLI worker process entry point
(`_run_*_process` and the non-reload paths: import, report, label, wiki,
spec-lookup, db-testing, log-service, notification, scan-matching, and any
others found in `cli.py`) sets `serversherpa-<worker-name>` (the CLI
command name, e.g. `serversherpa-report-worker`). Names are ≤ 63 chars.

## 2. Summary (`GET /devtools/health/summary`)

- `database_size_bytes` — `pg_database_size(current_database())`
- `version` — `server_version` setting (short form, e.g. "16.4")
- `started_at` — `pg_postmaster_start_time()`; the UI shows uptime
- `latency_ms` — round-trip of `SELECT 1` measured in the API
- `connections` / `max_connections`
- `cache_hit_ratio` — `blks_hit / (blks_hit + blks_read)` from
  `pg_stat_database` for this database (null when no reads yet)

No host, user or password is returned.

## 3. Who's connected (`GET /devtools/health/connections`)

From `pg_stat_activity` for the current database, excluding this request's
own backend: grouped by `application_name` (empty → "Other") and `state`
(`active`, `idle`, `idle in transaction`, `idle in transaction (aborted)`,
other → as is). Per group: `count`, `oldest_query_seconds` (for active:
`now() - query_start`), `oldest_transaction_seconds` (for anything with an
open transaction: `now() - xact_start`), `waiting_on_lock` count
(`wait_event_type = 'Lock'`). Groups sorted by app name, then state.
No query text, client address or user name is returned.

The UI flags a group amber when its oldest transaction or query is over
5 minutes, and shows "N waiting on a lock" when any are.

## 4. Tables (`GET /devtools/health/tables`)

All tables in schema `public` (from `pg_stat_user_tables` joined to size
functions): `name`, `rows` (`n_live_tup` estimate), `total_bytes`
(`pg_total_relation_size`), `table_bytes` (`pg_relation_size`),
`index_bytes` (`pg_indexes_size`), `dead_rows` (`n_dead_tup`),
`dead_ratio` (dead / (live + dead), null when both are 0),
`last_vacuum_at` (greatest of manual and auto), `last_analyze_at`
(greatest of manual and auto). Sorted by `total_bytes` desc.

## 5. Vacuum & analyze (`POST /devtools/health/tables/{name}/vacuum`)

- `name` must be one of the current `public` tables (looked up, never
  interpolated from input); unknown → 404 `unknown_table`.
- Refused with 409 `testing_session_active` while a DB Testing session is
  unfinished (reuse the Cleanup check).
- Runs `VACUUM (ANALYZE) public."<name>"` on an autocommit connection
  (VACUUM can't run in a transaction), quoting the identifier safely.
- Returns the table's refreshed stats row and `duration_ms`.
- One audit row: `entity_type="system"`, action `db.vacuum`,
  `changes={"table": name, "duration_ms": n}`.

## 6. File storage (`GET /devtools/health/storage`)

Lists every object in the configured bucket (paginated, in a thread like
`services/storage.list_keys`) and returns per top-level folder (first path
segment; objects without a `/` → "(root)"): `objects`, `bytes`; plus
totals and `measured_at`. Sorted by bytes desc. Only on demand (the UI's
**Measure storage** button); it may take a while on a big bucket. Errors
(storage unreachable) → 502 `storage_unavailable` with a short message.

## Portal

`/dev/database` gains a fifth tab **Health** (same `.sysconf-tab` bar).
Content, top to bottom, each an `init-panel sysconf-card`:

1. **Summary** — tiles: Database size, Postgres version, Uptime, Response
   time, Connections ("23 of 100"), Cache hit rate. **Refresh** button
   reloads summary, connections and tables.
2. **Connections** — rows per app/state: app, state, count, oldest query,
   oldest transaction, waiting on a lock; amber chip when over 5 minutes.
3. **Tables** — a standard portal list (`dir-list`, `ColHead`,
   `listGridStyle`, column floors per the list recipe), sortable by
   name/rows/total/table/index/dead/last vacuum/last analyze, default total
   size desc; sizes human-readable (KB/MB/GB); a row action **Vacuum &
   analyze** (only with `devtools:change`) with a confirm naming the table,
   then the row updates and a short "Vacuumed in 1.2 s" note shows; the
   409 during DB Testing shows as a `pf-error`.
4. **File storage** — **Measure storage** button, then a list of folders
   with objects and size, totals, and "Measured at …".

House idioms only; American English.

## Testing

API: application name passed through `connect_args` (unit) and set by the
API app and each worker entry point (inspect the callables or a small
registry); summary fields and types, no host/user leaked; connections
grouping (open a second connection with a known application_name in an
open transaction and assert its group, state, ages and that the requesting
backend is excluded); tables includes known tables with sane numbers and
sort; vacuum on a real table updates `last_vacuum_at`, writes the audit
row, unknown table 404, identifier quoting (a table name with an uppercase
letter or quote can't be injected — the name comes from the catalog
lookup), 409 during an unfinished testing session, permission split
(view vs change, non-developer 403); storage grouping with a fake bucket
listing, error → 502.

Portal: the tab renders; summary tiles formatted; connections flags; table
sorting and the vacuum flow (confirm, call, row update, error); storage
measuring and the error state.

## Out of scope

Killing connections, editing Postgres settings, storage cleanup, polling
or history charts, database host details.
