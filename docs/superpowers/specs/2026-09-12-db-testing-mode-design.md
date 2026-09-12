# DB Testing mode — `/dev/database` › Testing

**Date:** 2026-09-12 · **Status:** approved by standing instruction · **Branch:** `db-testing`

## Purpose

Jimmy: a Testing tab on Developer › Database, password-protected above the dev permission and god mode (env `SS_DB_TESTING_PASSWORD`, default `admin`). Option 1 "Set DB for Testing": snapshot the database (its own worker process) so every change made while testing mode is on can be tracked and reverted to the snapshot taken before testing started. Option 2: end testing — revert to the snapshot, or keep the changes.

## Security model

- Server: every Testing action requires `devtools:change` AND `password` in the request body matching `SS_DB_TESTING_PASSWORD` (constant-time compare; 403 `invalid_testing_password`; audited as `db_testing.auth_failed` with no password material). The status read requires `devtools:view` only. Rate limit auth failures: after 5 failures in 10 minutes per person → 429 `too_many_attempts`.
- Portal: the Testing tab renders its controls only while god mode is unlocked (otherwise a locked notice), and asks for the testing password on each action; the password lives in component state only.

## Data (migration 0059, `down_revision = "0058"`)

- `db_testing_sessions`: `id`, `status` (`snapshotting | active | reverting | ended | failed`), `snapshot_backup_id` FK `db_backups` (null until the dump lands), `row_counts jsonb` (table → row count captured right after the dump), `audit_watermark timestamptz` (start time; changes are audit rows after it), `started_by` FK people, `started_at`, `ended_at`, `ended_with` (`reverted | kept | null`), `error text`, `worker_id`, `heartbeat_at`, `previous_banner jsonb` (the admin banner config to put back). Partial unique index: one session where status in (`snapshotting`,`active`,`reverting`).
- `db_backups.purpose text NOT NULL DEFAULT 'manual'` (`manual | testing_snapshot`) so the Backups tab can label snapshots.

## Worker `db-testing-worker` (`api/src/serversherpa/devtools/testing/{worker,jobs,runner,restore}.py`)

- Mirrors `reports/worker.py` (heartbeat name `db-testing-worker`, `db_logging.install`, claim with `FOR UPDATE SKIP LOCKED`, stale sweep on `heartbeat_at`). CLI `serversherpa db-testing-worker [--poll-seconds] [--once] [--reload]`; Procfile.dev `dbtestsvc:`. It does NOT honor the read-only worker pause (it is the process that sets it during a revert).
- **Snapshot** (`snapshotting` → `active`): `run_pg_dump` (existing) → `put_object` under `backups/testing/<uuid>.sql` (plain SQL, never encrypted) → `DbBackup(purpose='testing_snapshot', filename='testing_snapshot_<stamp>.sql')` → capture `row_counts` (every public table via `pg_class.reltuples` is approximate; use `SELECT count(*)` per table — dev-scale) → set the admin broadcast banner "Database testing mode is ON since <time> — changes will be reverted when testing ends" (saving the previous banner config in `previous_banner`) → `active`. Failure → `failed` with `error`.
- **Revert** (`reverting` → `ended/reverted`): (1) enable read-only + pause workers in admin config; (2) terminate every other backend on this database (`pg_terminate_backend` where `datname = current_database() AND pid <> pg_backend_pid()`), (3) `DROP SCHEMA public CASCADE; CREATE SCHEMA public;` then feed the dump through `psql` (new `restore.py`: `run_psql_restore(database_url, sql_bytes)` next to `run_pg_dump`, `PsqlUnavailable`/`PsqlFailed`), (4) the restore wipes rows created after the snapshot — including this session's own row, its snapshot's `db_backups` row, and the admin-config banner/read-only rows — so the worker re-inserts the session (as `ended/reverted` with `ended_at`) and the snapshot backup row from values held in memory, then restores `previous_banner` and turns read-only off. Failure at any step → `failed` with `error` and read-only left ON (a half-restored database must not be written to) — the tab shows the error and a "Clear read-only" hint pointing at Settings › Maintenance.
- **Keep** (`active` → `ended/kept`): API-side, immediate: restore `previous_banner`, `ended_with='kept'`; the snapshot backup stays in the Backups tab.

## API (`api/routes/devtools.py`)

- `GET /devtools/db-testing/status` → `{ session: SessionOut | null (the non-ended one), changes: { audit_rows: int, tables: [{table, before, after, delta}] (delta ≠ 0 only, from row_counts vs live counts), since: ts } | null, recent: SessionOut[] (last 10), worker_online: bool (heartbeat within 30 s) }`.
- `POST /devtools/db-testing/start {password}` → 202 `SessionOut` (`snapshotting`); 409 `session_active`; 503 `worker_offline` when no fresh heartbeat (the snapshot would never run).
- `POST /devtools/db-testing/end {password, revert: bool}` → `revert=true`: session → `reverting` (202); `revert=false`: → `ended/kept` (200). 409 when the session is not `active`.
- Audit rows: `db_testing.start`, `db_testing.end` (`{revert}`), `db_testing.reverted` (worker), `db_testing.failed`.

## Portal — `/dev/database` › **Testing** tab

- Tab bar gains Testing (after Backups). If god mode is off: a locked notice "Unlock god mode to use database testing." Otherwise a page-section layout (roomy, like the report steps): **Status card** (Idle / Snapshotting… with spinner / **Testing mode ON** since <time> by <name>, snapshot name, live **Changes** block: "N audited changes · tables: containers +15, generated_labels +185 …" polled every 5 s / Reverting… / Failed with the error and the read-only hint) and a **Worker** line (online/offline chip from `worker_online`). **Actions**: a password field (`type=password`, autocomplete off, cleared after each action) and buttons: "Set DB for Testing" (disabled while a session exists or the worker is offline), "End testing · Revert to snapshot" and "End testing · Keep changes" (only when active) — Revert opens a confirmation modal (roomy header: eyebrow Database, title "Revert to the testing snapshot?", description naming the snapshot time and the change counts, the password re-entered inside the modal). **Recent sessions** list (`dir-list`): started, by, ended, outcome chip (Reverted / Kept / Failed), snapshot, changes count. The global broadcast banner (existing `useSystemStatus`) shows the testing message while active.
- Backups tab: rows with `purpose === 'testing_snapshot'` get a "Testing snapshot" chip.

## Testing

- API/worker: password gate (wrong → 403 + audit; 5 fails → 429; missing → 422), permission (viewer 403), start → 202 + row, 409 second start, 503 when worker offline; worker snapshot path with `run_pg_dump`/`put_object` monkeypatched (row_counts captured, banner set + previous saved, status active); keep path; revert path with `run_psql_restore` + `pg_terminate_backend` monkeypatched (read-only on during, off after; re-inserted session + backup rows; banner restored); failure path leaves read-only ON and status failed; status `changes` deltas (insert rows after snapshot → delta); migration + single head 0059; CLI command exists.
- Portal: locked notice without god mode; status states; start posts password and clears the field; revert modal requires the password and posts `{revert: true}`; keep posts `{revert: false}`; polling refreshes changes; recent list; backups chip; guardrail.
- Live (controller): start testing on the dev DB via the tab (Jimmy signed in) or via API script, create a few containers, see the deltas, revert, confirm they are gone.

## Deliberate limits

A revert interrupted after a successful restore but before its final bookkeeping commit can be re-claimed by the stale sweep as a fresh `snapshotting` session (the restored database is snapshotted again and the banner comes back); the operator ends it with Keep — nothing is lost. The schema drop travels inside `psql --single-transaction` with the restore, so a failed restore rolls back to the pre-revert state. Plain-SQL snapshots only (no encryption — the snapshot is an internal safety net); dev-scale row counting; the revert briefly kills every DB connection (API requests in flight fail once; workers reconnect); a failed revert leaves the system read-only on purpose.
