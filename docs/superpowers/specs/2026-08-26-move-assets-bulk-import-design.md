# Move Assets Bulk Import — Design

**Date:** 2026-08-26
**Status:** Approved (design conversation 2026-08-26)
**Scope:** Port of BaseCampV2's move upload-ft feature (`/moves/:id/upload-ft` →
`POST /moves/assets/upload` + bulk-job path) onto the V3 schema, restructured so
the import runs in a separate worker process and never impacts API readiness or
response times.
**Out of scope:** label printing (the `label_info` column is added but nothing
writes or reads it), other import kinds reusing the job queue (designed for, not
built), LISTEN/NOTIFY wakeups, multi-worker scaling (works by just running more
workers, but untested this slice).

## Background

The move-assets spec (2026-08-25) shipped the per-move asset roster
(`initiative_assets`) with bulk import as the ONLY real attach path, deferring
the importer plus the `raw_ft`/`label_info` columns to this slice. V2's
implementation lives in `portal_routes.py::upload_move_assets_csv` (synchronous,
≤5,000 rows) and a `BulkUploadJob`-based background path for larger files — but
that "background" work still ran inside the API process. V3 keeps V2's pipeline
semantics and moves execution out of the API entirely.

## Decisions (from brainstorm)

1. **Separate worker process.** Same codebase/package, new entrypoint
   `serversherpa import-worker`. The API only creates job rows and serves
   status; the worker does all parsing and DB writes.
2. **Queue = Postgres table** (`import_jobs`), claimed with
   `FOR UPDATE SKIP LOCKED`, worker polls every ~2s. No Redis/celery, no
   LISTEN/NOTIFY yet.
3. **Full V2 behavior parity:** make/model modes (fuzzy / force / hybrid),
   serial generation toggle, RFID skip-and-flag, post-import destination
   collision detection.
4. **Schema:** add BOTH deferred columns — `raw_ft` JSONB (importer stores the
   complete original spreadsheet row) and `label_info` JSONB (parity only,
   unused for now).
5. **Flow: validate first, then commit.** The worker runs a no-write validation
   pass producing the full per-row report; the user reviews and explicitly
   commits (re-using the stored file, no re-upload).
6. **Per-row commit semantics (V2 style), not all-or-nothing.** Good rows land,
   bad rows are reported with reasons. The validate step is the abort point.
7. **Portal: dedicated page** `/initiatives/:id/import-assets`, linked from the
   move's Assets section.
8. **Template headers stay V2-compatible** so existing facility-tracker
   spreadsheets keep working unchanged.

## 1. Module layout

New package `api/src/serversherpa/imports/`:

- `parsing.py` — CSV/XLSX bytes → normalized dict rows (openpyxl; server-side,
  same convention as `sites/bulk_import.py`). Header mapping is
  case-insensitive against the V2 header names.
- `move_assets.py` — the ported pipeline, free of HTTP concerns: row parsing
  (serial normalization, RU floats, cable_info assembly, raw_ft capture), batch
  lookups (assets by serial, RFID holders, make/model exact + alias fuzzy),
  make/model resolution modes, serial generation, RFID skip-and-flag, per-row
  create/attach/update against the V3 schema, and collision detection writing
  `location_collision`. Exposes `validate(...)` (no writes) and `commit(...)`
  (batched writes) over the same core.
- `jobs.py` — job-queue helpers: claim-next (`FOR UPDATE SKIP LOCKED`),
  progress updates, cancel checks, terminal-state transitions.
- `worker.py` — the loop (claim → dispatch by `kind`/`phase` → record result),
  wired to a `serversherpa import-worker` Typer command in `cli.py`.

API routes stay thin (create job / status / commit / cancel / template) and
live with the other initiative asset routes in `routes/initiatives.py`.

Dev: run `serversherpa import-worker` alongside `uvicorn`. Prod: its own
process/container. The API never imports worker code paths that parse or write.

## 2. Data model (migration chained on current head)

`initiative_assets` gains:

- `raw_ft: JSONB | None` — the complete original spreadsheet row for this
  asset's most recent import touch. Nothing from an upload is ever dropped.
- `label_info: JSONB | None` — v2 parity; unused this slice.

New table `import_jobs`:

- `id` UUID PK; `kind: str` (`'move_assets'` only for now);
  `initiative_id` UUID FK → initiatives (CASCADE);
  `created_by` UUID FK → people.
- `filename: str`; `file_key: str` — object key in Spaces/minio (uploaded file
  is stored once via `services/storage.py::put_object` and reused by both
  phases).
- `options: JSONB` — `{"make_model_mode": "fuzzy"|"force"|"hybrid",
  "generate_serials": bool}`.
- `phase: str` (`'validate'` | `'commit'`);
  `status: str` (`'queued'` | `'running'` | `'completed'` | `'failed'` |
  `'cancelled'`).
- Progress: `total_rows`, `processed_rows`, `created_count`, `updated_count`,
  `error_count` (ints, default 0).
- `results: JSONB | None` — summary + per-row details (shape in §4).
- `cancel_requested: bool` default false; `error: str | None` (terminal failure
  message); `started_at`, `finished_at` nullable timestamps; `created_at`
  default now().

## 3. Spreadsheet contract (V2-compatible)

Headers (case-insensitive): `Serial Number`, `Asset Name`, `Asset Make`,
`Asset Model`, `RFID Tag`, `Priority`, `Disposition`, `Owner`, `Source Rack`,
`Source RU`, `Destination Rack`, `Destination RU`, `Data 1`–`Data 6`,
`Mgmt 1`–`Mgmt 2`, `Vendor Involvment` (v2's spelling accepted, plus the
correct `Vendor Involvement`).

Parsing rules (V2 parity):

- `Serial Number` required; lowercased. Blank serial: error — unless serial
  generation is enabled and `Asset Name` present, then generate
  `<name lowercased>.<13 random digits>` and flag `serial_generated`.
- `Asset Name` blank → falls back to the serial. Stored lowercased.
- Make/model search string: `"{make} {model}"`, or whichever half is present.
- `Source RU` / `Destination RU`: float parse; unparseable → null (kept
  visible in `raw_ft`).
- `cable_info`: dict from non-blank `Data 1..6` → `data_1..6`,
  `Mgmt 1..2` → `mgmt_1..2`; stored as JSON text in the existing
  `cable_info` column.
- `vendor_involved`: true iff the cell is non-blank.
- `Priority` → `priority_wave` (truncated to 30 chars, noted if truncated).
- Unknown/extra columns are NOT errors — they ride along in `raw_ft`.
- `raw_ft` = the entire original row dict, always.

## 4. Pipeline semantics

Shared core (validate = same path, writes suppressed):

1. **Batch lookups** (per file, not per row): existing assets by serial;
   current RFID holders (case-insensitive); make/model exact match on
   `lower(make || ' ' || model)`; alias fuzzy match via `asset_model_aliases`
   for the misses.
2. **Make/model resolution** for rows whose serial has no existing asset:
   - `fuzzy` (default): exact → alias; no match → row reported `review`
     ("Make/Model '<x>' not found") and skipped at commit.
   - `force`: no match → create `AssetModel` (make/model split via the ported
     `resolve_make_model_for_creation` helper, knowledge note
     "FORCED: make model creation for move F-T"); dedup within the file.
   - `hybrid`: exact → alias → create-if-missing (note "FORCED: hybrid mode
     creation (fuzzy match not found) for move F-T").
3. **RFID skip-and-flag:** a tag already held by a DIFFERENT asset (in the DB
   or claimed by an earlier row in this file) is not written; the row still
   imports, carrying a note. A non-conflicting tag is written onto the asset
   (existing or new).
4. **Asset create** (serial not found): new `Asset` with serial, name, rfid,
   resolved `model_id`, `source='import'`, `source_ref` naming the job id and
   filename; lifecycle `status` left to the Asset default vocabulary value.
5. **Roster attach/update:** existing `(initiative, asset)` row → UPDATE of
   the imported fields (+ `raw_ft`, `updated_at`); otherwise INSERT with
   roster `status` default `loaded_in_system`, `added_by` = job creator.
6. **Per-row report entry:** `{row, serial_number, status: created|updated|
   review|error, message, asset_id, asset_created, serial_generated,
   match_method: exact|fuzzy|force_created|existing_asset|none|review,
   make_model_final, rfid_note?}`.
7. **Commit batching:** writes flushed/committed every ~500 rows; progress
   counters updated on the job row per batch; `cancel_requested` checked per
   batch (cancel → status `cancelled`, work already committed stays — per-row
   semantics make that consistent).
8. **Collision detection** (commit only, after all rows): group this move's
   roster rows by `destination_rack`; expand each to its occupied RU range
   (`int(destination_ru)` .. + model `ru_size`, default 1); overlapping pairs
   get roster `status='location_collision'`. Failures here are reported in the
   summary, never fail the job.
9. **Audit:** ONE `audit_log` summary entry per commit (actor, initiative,
   filename, counts) — not one per row.

Validate results additionally include `total_rows` and counts by status so the
portal can render summary chips without scanning details.

## 5. API (routes/initiatives.py, `initiatives` resource)

All gated on the initiative-change permission the existing asset routes use;
422 `not_a_move` when the initiative isn't a move.

- `POST /initiatives/{id}/assets/import-jobs` — multipart: file
  (`.csv`/`.xlsx`/`.xls`, max 20 MB) + options fields. Stores the file to
  Spaces, inserts job (`phase='validate'`, `status='queued'`), returns the job.
  Milliseconds regardless of file size.
- `GET /initiatives/assets/import-jobs/{job_id}` — full job state: phase,
  status, progress counters, results. The portal polls this (~2s).
- `POST /initiatives/assets/import-jobs/{job_id}/commit` — allowed only from
  `phase='validate'` + `status='completed'`; flips to `phase='commit'`,
  `status='queued'`. 409 `job_not_ready` otherwise.
- `POST /initiatives/assets/import-jobs/{job_id}/cancel` — sets
  `cancel_requested`; 409 if already terminal.
- `GET /initiatives/assets/import-template?format=xlsx|csv` — V2 headers +
  2 sample rows; xlsx adds a read-only `Reference` sheet listing the
  make/model modes and required columns.

Errors use the `_err` code pattern; the portal maps codes to friendly text.

## 6. Worker

`serversherpa import-worker`: loop — claim next `status='queued'` job
(`FOR UPDATE SKIP LOCKED`, oldest first), mark `running` + `started_at`,
dispatch (`move_assets.validate` or `.commit`), write `results`/counters,
mark terminal (`completed`/`failed` + `error`), sleep ~2s when idle. SIGTERM
finishes the current batch, releases cleanly. A crashed worker leaves the job
`running`; jobs `running` with no progress update for >10 min are re-queued on
worker startup (progress timestamps make this safe).

## 7. Portal

New portal page at route `/initiatives/:id/import-assets` (edit-gated like other
change surfaces), reached via an **Import assets** button on the move's Assets
section header (renders for canChange on moves only). Page sections:

1. **Setup:** file picker (`.csv/.xlsx/.xls`), make/model mode radio
   (fuzzy default / force / hybrid), serial-generation toggle, template
   download menu (xlsx/csv), Validate button → creates the job, starts polling.
2. **Validation report:** summary chips (total / will create / will update /
   review / errors) + paginated per-row table (row #, serial, status chip,
   message, match method). Import button proceeds; changing the file starts a
   new job.
3. **Progress:** phase label, processed/total bar, rows/sec + ETA (client-side
   from poll deltas, V2-style), Cancel button.
4. **Final report:** same table shape from the commit results + collision
   summary line; link back to the Assets section, which refetches.

All state renders from the polled job — refresh mid-import loses nothing.

## 8. Testing

- **Unit (no DB):** `parsing.py` (csv/xlsx normalize identically,
  case-insensitive headers, V2 misspelling), row parsing (serial lowering,
  RU floats, cable_info, vendor flag, raw_ft completeness), ported
  `resolve_make_model_for_creation` and serial-generation helpers.
- **Pipeline (async DB):** validate report correctness per mode
  (fuzzy/force/hybrid, review rows); per-row commit semantics (bad rows
  skipped, good rows land); re-upload updates instead of duplicating; RFID
  skip-and-flag (DB conflict + intra-file conflict); collision flagging incl.
  ru_size expansion; batching + cancel between batches; audit summary row.
- **Routes:** permission gate, not_a_move, file type/size rejection, job
  lifecycle transitions (commit only from validated, cancel races, 409s),
  template self-consistency (template sample passes validate cleanly).
- **Worker:** claim → run → terminal via a real job row; stale-`running`
  re-queue on startup.
- **Portal:** helper-level tests for report/summary shaping only; page stays
  thin per repo convention. Live browser verification with a seeded move.
