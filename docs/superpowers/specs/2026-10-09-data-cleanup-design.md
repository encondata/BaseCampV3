# Data cleanup tab — design

**Date:** 2026-10-09
**Tracker:** System and operations › "Data cleanup tools" (Feature Parity 368, Partial): "Purge old logs, duplicate records and stale sessions."
**Branch:** `data-cleanup`

## Goal

A **Cleanup** tab on `/dev/database` (after Reconcile, Backups, Testing) where
a developer previews and then purges data that can never be used again or
is older than a chosen age, and lists likely duplicate records. On demand
only — nothing runs on a schedule.

## What V2 had, and what V3 already does (not duplicated)

- V2's Maintenance screen purged API logs older than 24 h and expired
  refresh tokens (immediately, no preview). Its "duplicates" card was
  hard-coded to 0; its "Purge logs" button called a route that didn't exist.
- V3 already trims automatically: process logs (row cap + age, System
  Config › logging), stale import drafts/previews, kiosk pair requests,
  DHCP leases, password history, wiki exports/views/searches/jobs/trash.
- V3 already has elsewhere: Reconcile (hard delete, force, cascade
  Override), Backups, Testing, model merge/review (`/assets/models`),
  Clear offline kiosks, revoke-all sessions.

None of those change.

## Jimmy's decisions (2026-10-09)

- Scope: sign-in leftovers, old history rows, deleted files + storage, and
  a report-only duplicate finder.
- Age: picked on each run — an "Older than N days" field prefilled with 90.
- Only on demand.

## Access

Everything is under `/devtools/cleanup/*`: `devtools:view` to preview and
list duplicates, `devtools:change` to run a purge (developer role only, the
existing resource). Developers are already exempt from read-only mode.

## Groups and categories

Each group is a card. Each category inside it can be turned on or off
(all on by default). **Preview** shows rows (and stored files, where
relevant) per category; **Delete** confirms, then recomputes at run time
and reports what was actually removed.

### 1. Sign-in leftovers (`signin`, no age field)

| Category | Rows deleted |
|---|---|
| `sessions` "Expired sessions" | `auth_sessions` with `expires_at < now()` (portal and kiosk). Rotated or revoked sessions still inside their lifetime are **kept** — refresh-token reuse detection needs them. An expired session that a kept (unexpired) session still points at through `replaced_by` is also kept (the `auth_sessions_rotation_pair_check` constraint ties `rotated_at` to `replaced_by`, and clearing them would revive a spent refresh token). Real rotation chains share one absolute expiry, so this only affects odd data. |
| `reset_links` "Used or expired password-reset links" | `password_reset_tokens` with `used_at IS NOT NULL OR expires_at < now()` |
| `trusted_browsers` "Expired or revoked trusted browsers" | `trusted_devices` with `revoked_at IS NOT NULL OR expires_at < now()` |

### 2. Old history (`history`, "Older than N days")

`cutoff = now() - N days`, computed by the database.

| Category | Rows deleted | Files |
|---|---|---|
| `mail` "Sent, failed and skipped mail" | `email_outbox` with status sent/failed/skipped and `created_at < cutoff` | — |
| `notifications` "Read or hidden notifications" | `notifications` with (`read_at` or `dismissed_at` set) and `created_at < cutoff`, **except** rows whose `payload->>'state'` is `pending` or `open` (approval cards still waiting) | — |
| `imports` "Finished import jobs" | `import_jobs` in a terminal status with `finished_at < cutoff` | the job's `file_key` object, unless another kept import job uses the same key |
| `reports` "Report runs" | `report_runs` in a terminal status with `finished_at < cutoff` | the run's `storage_key` object, unless a non-deleted attachment (a move's Files) uses the same key |
| `label_runs` "Label generation runs" | `label_generation_runs` in a terminal status with `finished_at < cutoff`. **Generated labels are kept**: their `run_id` is set to NULL first | — |
| `spec_lookups` "Finished spec lookups" | `spec_lookup_jobs` in a terminal status with `finished_at < cutoff` (their suggestions are kept; `job_id` becomes NULL by the existing FK) | — |
| `rule_logs` "Status rule run logs" | `status_rule_executions` with `executed_at < cutoff` | — |

"Terminal status" for each table is taken from the code/CHECK constraints
(e.g. completed/done, failed, cancelled) — never `queued`/`running`/
`preview`/draft states. The audit log and raw scans are never touched.

Any code path that reads old rows of these tables by something other than
an FK (for example a From-To import report built from `import_jobs.results`,
or re-upload reuse) is checked during implementation; the card text says
what goes with the rows ("their reports go too").

### 3. Deleted files (`deleted`, "Older than N days")

| Category | Rows deleted | Files |
|---|---|---|
| `attachments` "Deleted files" | `attachments` with `deleted_at < cutoff`; any `report_runs.attachment_id` pointing at them is set to NULL first | the `storage_key` object, unless still used by a non-deleted attachment, a `report_runs.storage_key`, or a person/client/partner `avatar_key`/`logo_key` |
| `notes` "Deleted notes" | `notes` with `deleted_at < cutoff` | — |
| `label_fonts` "Deleted label fonts" | `label_fonts` with `deleted_at < cutoff` | the font object, unless another non-deleted font uses the key |

The wiki is excluded (its own trash already empties after 30 days).

### 4. Duplicate finder (report only)

- **Assets sharing a serial number:** non-archived assets grouped by
  `lower(trim(serial_number))` (non-empty), groups of 2+, largest groups
  first, at most 200 groups. Each item: name, serial, site, status, link
  `/assets/<id>`.
- **People with the same name:** non-archived people grouped by
  `lower(trim(first_name)), lower(trim(last_name))`, groups of 2+, excluding
  hidden kiosk move identities, at most 200 groups. Each item: display
  name, email, whether they have a login / worker profile, link to
  `/people/users/<id>` when they have a login, else `/people/workers/<id>`
  when they have a worker profile, else no link.
- Text: "Fix them on the record, or mark one for delete and remove it on
  the Reconcile tab." No merge.

## How a purge runs

- `POST /devtools/cleanup/run` `{group, categories[], older_than_days?}`
  (`older_than_days` required for `history` and `deleted`, integer
  1–3650; 422 `invalid_age` otherwise; unknown group/category → 422
  `unknown_category`).
- Rows are deleted in chunks of 5,000 per statement, each chunk committed,
  so a large table never holds one huge transaction.
- Storage objects are deleted **after** their rows' chunk commits; a failed
  object delete is counted (`files_failed`) and logged, never retried
  silently, and does not stop the run.
- Response: per category `{key, rows_deleted, files_deleted, files_kept,
  files_failed}`.
- One audit row per run: `entity_type="system"`, action `cleanup.run`,
  `changes` = group, age, and the per-category counts.
- `GET /devtools/cleanup/preview?older_than_days=N` returns every group's
  categories with `{key, label, rows, files}` (files = objects that would be
  deleted). Counts only — no row data.
- `GET /devtools/cleanup/duplicates` returns the two duplicate lists.

## Portal

`/dev/database` gains a fourth tab **Cleanup** (same `.sysconf-tab` tab
bar). Inside: a short intro ("Remove data that can never be used again or is
older than you choose. Take a backup first — deletes can't be undone.") with
a link to the Backups tab, then one `init-panel sysconf-card` per group:

- Card header: eyebrow + title + one-line description.
- History/Deleted cards: "Older than [90] days" numeric field.
- A list of the group's categories, each with its on/off toggle (house
  toggle idiom), label, short description, and the preview count
  ("1,204 rows · 38 files"), "—" before preview.
- Buttons: **Preview** (`mini-btn`), then **Delete selected** (`btn-solid`
  danger style), enabled after a preview with at least one non-zero
  selected category. Confirm with the page's existing confirm pattern,
  naming the totals. After a run, the card shows the result line per
  category and refreshes its preview.
- Duplicate finder card: **Find duplicates** button, then two lists
  (house `dir-list` rows) grouped by serial / name with record links;
  "No duplicates found." when empty.

## Testing

API: each category deletes exactly its rows and nothing else (seed rows on
both sides of every condition: expired vs live session, used vs fresh
token, read vs unread notification, pending approval card kept, terminal vs
running job, generated labels kept with `run_id` nulled, suggestions kept,
`replaced_by` nulled, report run whose file is still attached keeps its
object, attachment whose key is shared keeps its object); storage deletes
happen after commit and failures are counted (fake storage); chunking
(small chunk size in tests); validation (age, unknown category, group);
permissions (view vs change vs non-developer 403); audit row contents;
preview counts match a subsequent run; duplicate lists (serial case/trim,
archived excluded, kiosk identities excluded, links).

Portal: the tab renders and is reachable; preview shows counts; toggles
change the request; Delete confirms and shows results; age validation;
duplicate lists render links and the empty state.

## Out of scope

Database health and table statistics (separate tracker row); scheduled
purges; merging duplicates; orphaned storage objects with no row at all;
audit log and raw scan purges.
