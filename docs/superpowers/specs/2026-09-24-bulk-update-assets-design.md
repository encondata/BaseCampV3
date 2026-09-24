# Update assets in bulk — design

**Date:** 2026-09-24
**Branch:** `bulk-update-assets` (worktree `.claude/worktrees/bulk-assets`)
**Parity:** To-Do #5, feature "Bulk update existing assets". V2 matched by serial and changed name / RFID / location / rails / damage; it silently ignored status and make/model and failed on notes.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Matching | **Asset ID first, then serial.** Asset ID pins the asset; otherwise the serial (case-insensitive) among live assets; a serial on 2+ live assets needs a per-line pick. |
| Fields | **Everything the asset page edits:** name, serial number (via `new_serial_number`, only on Asset-ID rows), RFID tag, make + model, client, site, location detail, Pod #, status, has rails. Blank = no change; nothing is cleared. |
| Status changes | **Recorded as a manual scan and run through the status rules** (like a scanner read: no roster anchor, the engine resolves the in-progress move). A rule failure refuses the whole apply, naming row and rule. |
| Scale | **Up to 15,000 rows / 20 MB; apply runs as a background job** with progress; still all-or-nothing. |
| Layout | **Exactly the other bulk tools** (sites / workers / trucks / job team): hint → Columns → Download → Upload; preview Row / Name / Matched by / Action / Details with `bulk-row-*` tinting; per-line match dropdowns and Skip inside Details (as in the job-team tool); "Skip all unmatched" beside Update all / Skip all. |

## Flow

1. Admin opens **Bulk Actions › Update assets in bulk** (`/bulk/assets`; admin rank + `assets:change`).
2. Downloads a blank template or **Current assets** (live assets only, in template layout, Asset IDs filled, status as key, has rails yes/no/blank). xlsx carries a Reference sheet: Statuses (key and label), Makes and models, Clients, Sites.
3. Uploads a file → the API parses it, stores the rows on an `import_jobs` row (kind `asset_bulk_update`, status `preview`), and returns the job id plus the preview.
4. Resolves attention rows with per-line dropdowns or Skip; each change re-previews against the stored rows (`{overrides, skip}` only). Checks Update per row or Update all.
5. Apply → the job is validated, stores the picks/approvals, and is queued. The page polls the job; the import worker applies everything in one transaction, publishing progress through a separate session. On completion the page shows the per-row summary with the CSV download.

## Columns

| Column | Required | Meaning (blank = no change) |
|---|---|---|
| `asset_id` | one of these two | The Asset ID (`assets.legacy_id`). Pins the asset. |
| `serial_number` | | Finds the asset when `asset_id` is blank. |
| `name` | | New name, stored as typed. |
| `new_serial_number` | | New serial; allowed only when `asset_id` is filled. |
| `rfid_tag` | | Normalized like the kiosk (whitespace out, upper-case, alphanumeric, ≤ 24, zero-padded to 24). A tag on another asset is an error. |
| `make`, `model` | together | Resolved against the catalog: exact "make model" or alias, then the roster importer's normalized key; unknown/ambiguous → pick. Only one of the two filled is an error. |
| `client` | | A non-archived client by name. |
| `site` | | A non-archived site by name. |
| `location` | | `location_detail`, free text. |
| `pod` | | `pod_number`, free text. |
| `status` | | An active asset status by key or label. |
| `has_rails` | | yes/no, true/false, y/n, 1/0. |

## Row outcomes (preview)

`update` (with `diff {field: {old, new}}`), `unchanged`, `attention` (`issues: [{field, kind: unknown|ambiguous, value, candidates}]` — fields `asset` (ambiguous serial), `model`, `client`, `site`, `status`), `error` (sentences: no key, asset not found, archived asset, new serial without Asset ID, only make or model, RFID already on asset X, bad has_rails, two rows on the same asset, a pick that no longer exists), `skipped`. `matched_by`: `asset ID`, `serial`, `your pick`. `can_commit` = no `attention`/`error` rows and at least one row.

Not-found rows are errors; "Skip all unmatched" skips every error/attention row in one click.

## API (routes in `routes/assets.py`, declared above `/{asset_id}`)

All require admin bulk rank (`require_bulk_rank`) + `assets:change` + global actor.

| Method / path | Body | Returns |
|---|---|---|
| `GET /assets/bulk-update/template?format=csv|xlsx` | – | template file |
| `GET /assets/bulk-update/export?format=csv|xlsx` | – | current live assets in template layout |
| `POST /assets/bulk-update` | multipart `file` | `{job_id, preview}`; job status `preview` |
| `POST /assets/bulk-update/{job_id}/preview` | `{overrides, skip}` | preview |
| `POST /assets/bulk-update/{job_id}/commit` | `{overrides, skip, approved_updates, approve_all}` | job (status `queued`); 422 `rows_invalid` if not committable |
| `GET /assets/bulk-update/{job_id}` | – | job (status, progress, `results.summary` when done) |
| `POST /assets/bulk-update/{job_id}/cancel` | – | 204; only while `preview`/`queued` |

Jobs belong to their creator (another admin gets 404). Preview payloads omit `unchanged` rows (they are counted) and list `attention`/`error` first, then `update`, then `skipped`.

`overrides`: `{"<row>": {"asset": asset_id_uuid, "model": model_uuid, "client": uuid, "site": uuid, "status": key}}`.

## Apply (worker, kind `asset_bulk_update`)

Re-run the preview with the stored picks; not committable → job `failed`, `error = "rows_invalid"`, `results.rows` = the offending rows. Otherwise, in one transaction: for each update row that is approved (or `approve_all`), set the changed fields, `updated_at`, one `audit(entity_type="asset", action="update", changes=diff)`; when status changed, add a `ProcessedScan` (scan_type `manual`, source `asset_bulk_update`, device `portal`, operator = job creator, match_type `asset`, asset_id) and `apply_rules(db, scan)`; a `RuleExecutionError` rolls back and fails the job with `error = "rule_failed"` and `results = {row, rule_name, message}`. After all rows: `recheck_placement(db, initiative_id)` once per move containing an asset whose model changed. Then one `bulk_import` audit (entity `asset`, counts + source filename), commit, job `completed` with `results = {summary: {updated, skipped, unchanged}, rows: [{row, name, asset_id, action, diff}]}`. Progress (`processed_rows`) is written through a second session every 250 rows so the page can poll.

## Data

Migration **0073** `bulk_asset_jobs`: `import_jobs.initiative_id` becomes nullable; add `import_jobs.payload JSONB NULL` (the parsed rows for bulk jobs). `ImportJobOut.initiative_id` becomes optional. The bulk core gains optional `max_rows`/`max_bytes` parameters (defaults unchanged) so this tool can use 15,000 / 20 MB.

## Portal

- Card "Update assets in bulk" (`resource: "assets"`, `action: "change"`) → `/bulk/assets`.
- `pages/BulkAssets.tsx` on `BulkToolPage` (new optional `limitNote` prop so the note reads 15,000 rows / 20 MB).
- `components/assets/AssetBulkUpload.tsx` mirrors `BulkUpload` markup and wording: file field, Preview, "Update N assets", Update all / Skip all / Skip all unmatched, the same summary line (updates/unchanged/skip/need a match/errors), `DataTable` with Row / Name / Matched by / Action / Details and `bulk-row-*` classes, the diff lines + Update checkbox, error sentences, and per-line portaled `ComboBox` matchers + Skip for attention rows. Rows render 200 at a time with "Show more". Apply shows a progress line ("Applying… 1,250 of 9,800") from polling `GET /assets/bulk-update/{job_id}` every 1.5 s, then `BulkApplySummary` (entity "Asset", link `/assets/{id}`).

## Out of scope

Creating assets; clearing fields; archiving; editing roster (move) fields; RFID enrollment history; notes.
