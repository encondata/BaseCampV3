# Update assets in bulk — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fifth Bulk Actions tool that updates existing assets from a spreadsheet (up to 15,000 rows), matched by Asset ID or serial, with per-line matching of ambiguous values, approved updates, status changes recorded as manual scans through the rules engine, and an all-or-nothing background apply.

**Architecture:** `assets/bulk_update.py` (parse → resolve → preview; apply) on the shared bulk core; the parsed rows live on an `import_jobs` row (kind `asset_bulk_update`, status `preview`) so re-previews post only picks; the existing import worker applies queued jobs in one transaction and reports progress through a second session. Portal page mirrors the other bulk tools exactly.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, openpyxl (via `imports/bulk.py`), React + TypeScript + vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-bulk-update-assets-design.md` — read it once; it is the source of truth for columns, outcomes, endpoints and apply semantics.

## Global Constraints

- Worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-assets` (branch `bulk-update-assets`); never cd to the main checkout. `.env`, `api/.venv`, `portal/node_modules` are symlinks.
- API tests: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-assets/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_bulk_assets /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest <files> -v` — FOREGROUND, one continuous command, timeout 600000 ms; never background a run, never start a second pytest, never end a turn waiting on one.
- Portal: `cd …/bulk-assets/portal && npx vitest run <files>`; `npx tsc -b`; `npm run build`.
- Migration number **0073** (`down_revision = "0072"`), file `0073_bulk_asset_jobs.py`.
- Columns exactly: `asset_id, serial_number, name, new_serial_number, rfid_tag, make, model, client, site, location, pod, status, has_rails`. Sheet `Assets`. Reference blocks `Statuses`, `Makes and models`, `Clients`, `Sites`.
- Limits for this tool: `MAX_ROWS = 15000`, `MAX_BYTES = 20 * 1024 * 1024`. The shared core defaults (1,000 / 5 MB) are unchanged for every other tool.
- Blank = no change; nothing is ever cleared. `new_serial_number` only on rows with `asset_id`.
- RFID normalization: `"".join(raw.split()).upper()`, must be ASCII alphanumeric, ≤ 24, then `rjust(24, "0")`.
- Status: active `StatusValue(record_type="asset")` by key or label (casefolded).
- Matching: `asset_id` (int, `Asset.legacy_id`) → that asset (archived → error). Else `serial_number` among live assets (CITEXT, case-insensitive); 2+ → `attention` field `asset`.
- Preview row actions: `update`, `unchanged`, `attention`, `error`, `skipped`; `matched_by`: `asset ID` / `serial` / `your pick`. Commit/apply result actions: `updated`, `skipped`, `unchanged`.
- Status change on apply: `ProcessedScan(scan_type="manual", source="asset_bulk_update", device_id="portal", operator_id=creator, match_type="asset", asset_id, site_id=None, location_detail="")` then `apply_rules(db, scan)` (no `initiative_asset`).
- Audit: per asset `audit(entity_type="asset", entity_id=str(asset.id), action="update", changes=diff)`; one `bulk_import` summary (entity_type `asset`, entity_id None, counts + `source`).
- Routes under `/assets/bulk-update…`, declared above `@router.get("/{asset_id}")`; `require_bulk_rank` + `assets:change` + global; jobs are visible only to their creator (else 404 `job_not_found`).
- User-facing error strings are sentences in American English. Ruff line length 100.
- Portal layout: exactly the other bulk tools (read `pages/BulkTrucks.tsx`, `components/bulk/BulkUpload.tsx`, and the job-team tool `pages/BulkInitiativePeople.tsx` + `components/initiatives/TeamBulkUpload.tsx` / `TeamBulkRowDetails.tsx` for per-line matching). Memory rule: bulk tools match the existing layout.
- Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit `api/src/serversherpa/_dev_reload.py`.

---

### Task 1: Migration, model, schema, core limits

**Files:** Create `api/migrations/versions/0073_bulk_asset_jobs.py`; modify `api/src/serversherpa/db/models.py` (`ImportJob`), `api/src/serversherpa/api/schemas.py` (`ImportJobOut.initiative_id: uuid.UUID | None = None`), `api/src/serversherpa/imports/bulk.py`; test `api/tests/test_bulk_asset_jobs_schema.py`, extend `api/tests/test_bulk_core.py`.

- [ ] Migration:

```python
"""Bulk asset update jobs.

`import_jobs` also carries Bulk Actions › Update assets in bulk: those jobs
belong to no move (initiative_id NULL) and keep their parsed rows in
`payload` while the admin previews and picks.

Revision ID: 0073
Revises: 0072
Create Date: 2026-09-24
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0073"
down_revision: str | None = "0072"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("import_jobs", "initiative_id", nullable=True)
    op.add_column("import_jobs", sa.Column("payload", JSONB, nullable=True))


def downgrade() -> None:
    op.execute("DELETE FROM import_jobs WHERE initiative_id IS NULL")
    op.drop_column("import_jobs", "payload")
    op.alter_column("import_jobs", "initiative_id", nullable=False)
```

- [ ] Model: `ImportJob.initiative_id: Mapped[uuid.UUID | None]` (keep the FK), `payload: Mapped[list | None] = mapped_column(JSONB)`; update the `kind` comment to `'move_assets' | 'asset_bulk_update'`.
- [ ] Core: `numbered(rows, first_row, columns, max_rows=MAX_ROWS)`, `number_json_rows(rows, columns, max_rows=MAX_ROWS)`, `parse_upload(filename, content, columns, sheet, max_rows=MAX_ROWS, max_bytes=MAX_BYTES)`; thread the limits through; error extras use the passed limit. Defaults preserve every existing caller.
- [ ] Tests: schema test — an `ImportJob(kind="asset_bulk_update", initiative_id=None, filename="a.csv", payload=[{"row": 2}])` round-trips; `test_bulk_core.py` — `parse_upload(..., max_rows=2)` on a 3-row CSV raises `too_many_rows` with `limit == 2`, and the default still allows 1,000.
- [ ] Run the two test files plus `tests/test_import_worker.py tests/test_import_jobs_model.py tests/test_trucks_bulk_import_service.py`. Commit `feat(api): bulk asset jobs — nullable job move, payload column (0073), per-tool bulk limits`.

---

### Task 2: Service — parse, resolve, preview, template, export

**Files:** Create `api/src/serversherpa/assets/bulk_update.py`; create `api/src/serversherpa/assets/model_index.py` (extracted from `imports/move_assets.py::_lookups`); modify `imports/move_assets.py` to use it; test `api/tests/test_asset_bulk_update_service.py`.

**Interfaces (produced):**
```python
# assets/model_index.py
@dataclass
class ModelIndex:
    literal: dict[str, AssetModel]      # exact "make model" display or alias, lowercased
    normalized: dict[str, AssetModel]   # normalize_model_key(display/alias); ambiguous keys dropped
    ambiguous: dict[str, list[AssetModel]]  # normalized keys hit by 2+ models (for candidates)
async def build_model_index(db) -> ModelIndex
def find_model(index: ModelIndex, make: str, model: str) -> tuple[AssetModel | None, list[AssetModel]]
    # (match, candidates): exact literal → normalized → (None, ambiguous candidates or [])

# assets/bulk_update.py
COLUMNS, SHEET = "Assets", MAX_ROWS = 15000, MAX_BYTES = 20 * 1024 * 1024
def parse_upload(filename, content) -> list[tuple[int, dict]]
def normalize_rfid(raw: str) -> str | None        # None when invalid
def parse_overrides(raw) -> dict[int, dict[str, str]]   # fields: asset, model, client, site, status
def parse_row_list(raw, code) -> set[int]
async def load_reference(db, numbered) -> dict   # everything preview/apply need, loaded once
async def preview_rows(db, numbered, *, overrides=None, skip=None, ref=None) -> dict
def listing(preview) -> dict   # the API payload: counts, can_commit, rows without `unchanged`, sorted
def build_template_csv() -> str; async def build_template_xlsx(db) -> bytes
async def export_rows(db) -> list[dict]; build_rows_csv(rows) -> str; async def build_export_xlsx(db) -> bytes
```

`move_assets._lookups` keeps its behavior: build its `literal`/`models` maps from `build_model_index` (same keys, same tie-break: exact wins over alias; ambiguous normalized keys dropped). The roster importer's tests (`tests/test_move_assets_*.py`, `tests/test_import_*`) must stay green unchanged.

Preview rules (see spec "Row outcomes"):
- Load in one pass: live assets by `legacy_id` for the file's ids and by lowercased serial for the file's serials (all of them, to detect duplicates); archived assets by `legacy_id` (to say "archived"); RFID holders for the file's normalized tags; `ModelIndex`; non-archived clients and sites indexed by casefolded name; active asset statuses by casefolded key and label; name maps for diffs (`model_names`, `client_names`, `site_names`, `status_labels`) including archived/inactive ones.
- Per row: key → asset (`asset_id` must be an integer, else error "Asset ID must be a number."); override `asset` wins for an ambiguous serial and must be one of that serial's live assets; a row with neither key → "Each row needs an asset_id or a serial_number."; not found → "No asset with Asset ID 12345." / "No live asset with serial 'X'."; archived → "Asset 12345 is archived.".
- Fields: build `changes` only for non-blank cells whose resolved value differs from the asset. `name`, `location`→`location_detail`, `pod`→`pod_number` compared as stripped strings; `new_serial_number` (error "Change the serial only on rows with an asset_id." when no asset_id); `rfid_tag` normalized (error "RFID tag 'X' is not valid." / "RFID tag X is already on asset 12345."; also two rows setting the same tag → both errors); `make`+`model` (error "Fill both make and model, or neither." when one is blank) → `find_model`, override `model` wins; `client`, `site`, `status` by name/key/label, override wins; `has_rails` parsed with yes/no/true/false/y/n/1/0 (error "has_rails must be yes or no.").
- Unknown/ambiguous reference → `issues` entry with candidates `[{id, label, detail}]` (model: `"Make Model"`, detail = category or ""; client/site: name; status: label with key detail; asset: `"Asset 100123"`, detail `serial · name · site`). The row is `attention` unless it also has errors (then `error`, keeping issues so dropdowns still render).
- Two rows resolving to the same asset → both errors "Asset 12345 appears on more than one row (2, 7).".
- `diff` values are display names: `{"status": {"old": "Unknown", "new": "Racked"}, "model": {"old": "Dell R640", "new": "Dell R740"}, …}` using keys `name, serial_number, rfid_tag, model, client, site, location, pod, status, has_rails`.
- Row payload: `{row, name (asset name or serial), asset_id (uuid str), asset_number (legacy_id), matched_by, action, errors, issues, diff, changes}` where `changes` maps model attributes to resolved values (`{"model_id": "<uuid>", "status": "racked", "has_rails": True, …}`) for apply; `cells` not needed (rows live on the job).
- `counts` over all rows: `update, unchanged, attention, error, skipped`; `can_commit` = rows exist and no attention/error.
- `listing(preview)`: rows minus `unchanged`, ordered attention, error, update, skipped (stable by row within each); plus `counts`, `can_commit`, `total`.

Template: two sample rows (one by `asset_id` with status and site, one by serial with make/model). Export: live assets ordered by `legacy_id`, `asset_id=legacy_id`, serial, name, blank new serial, rfid (as stored), make, model, client name, site name, location_detail, pod_number, status key, has_rails `yes`/`no`/"". Reference lists: statuses as `"key — Label"`, models `"Make Model"`, client names, site names (non-archived).

- [ ] Write `tests/test_asset_bulk_update_service.py` first covering: columns constant; parse limits (15,000 accepted, 15,001 → `too_many_rows`); match by asset_id; match by serial case-insensitively; duplicate serial → attention with both candidates, override resolves; override pointing at an asset without that serial → error; archived asset_id → error; not found → error; blank means no change (unchanged row); each field's change + diff display names; `new_serial_number` without asset_id → error; RFID normalized (`" e2 80 11 "` → zero-padded upper); RFID held by another asset → error; two rows same RFID → errors; make without model → error; exact model, alias, normalized match; unknown model → attention with empty candidates, override resolves; status by label and by key; unknown client/site/status → attention; has_rails parsing; two rows on one asset → errors; skip; `listing` omits unchanged and orders rows; template round-trips through `parse_upload`; export of two assets previews as all unchanged.
- [ ] Implement; run the new tests plus the roster importer's tests (`ls tests | grep -i "move_assets\|import_"`). Commit `feat(api): update assets in bulk — resolve, preview, template, export`.

---

### Task 3: Apply — worker job, status scans, placement recheck

**Files:** Modify `assets/bulk_update.py` (add `apply_job`), `scans/manual.py` (add `record_asset_status_edit`), `imports/worker.py` (dispatch by `job.kind`); test `api/tests/test_asset_bulk_update_apply.py`.

**Interfaces:**
```python
# scans/manual.py
SOURCE_ASSET_BULK_UPDATE = "asset_bulk_update"
async def record_asset_status_edit(db, *, asset: Asset, status: str, actor_person_id, source: str) -> ProcessedScan
    # same row as record_status_edit but no roster anchor: apply_rules(db, scan) with no initiative_asset

# assets/bulk_update.py
PROGRESS_EVERY = 250
async def apply_job(db, job: ImportJob, *, progress: Callable[[int], Awaitable[None]] | None = None) -> None
    # sets job.status/results/error itself; caller commits the job row afterwards
```

`apply_job`:
1. `numbered = [(r["row"], r["cells"]) for r in job.payload]`; `opts = job.options`: `overrides` (keys stored as strings → int), `skip`, `approved_updates`, `approve_all`.
2. `preview = await preview_rows(db, numbered, overrides=…, skip=…)`. Not `can_commit` → `job.status="failed"`, `job.error="rows_invalid"`, `job.results={"rows": [attention/error rows]}`; return.
3. Loop rows; `update` rows approved (`approve_all` or row in approved) → load asset (already in session from preview's reference load), `before = snapshot(asset, fields)`, set `changes`, `asset.updated_at = now`, `audit(... diff(before, after))`; if `status` in changes → `record_asset_status_edit(...)`; if `model_id` in changes → collect the asset id. Unapproved updates → `skipped`. Every `PROGRESS_EVERY` rows await `progress(n)`.
4. After the loop: initiative ids = `select(distinct(InitiativeAsset.initiative_id)).where(InitiativeAsset.asset_id.in_(model_changed))`; `await recheck_placement(db, iid)` for each.
5. `bulk_import` audit; `await db.commit()`. On `RuleExecutionError` → `await db.rollback()`, `job.status="failed"`, `job.error="rule_failed"`, `job.results={"row": n, "rule_name": exc.rule_name, "message": str(exc)}` (read the exception's real attribute names in `status_rules/engine.py`). Success → `job.status="completed"`, `job.processed_rows = len(rows)`, `job.updated_count`, `job.results={"summary": {"updated", "skipped", "unchanged"}, "rows": [{row, name, asset_id, action, diff}]}` (only updated/skipped rows carry `diff`), `job.finished_at`.

Worker: in `process_job`, if `job.kind == "asset_bulk_update"`: build `progress` that opens a **second** session (`get_sessionmaker()()`), `UPDATE import_jobs SET processed_rows=:n, progress_at=now() WHERE id=:id`, commits; call `apply_job(db, job, progress=progress)`; then `await db.merge(job)` if needed and commit the job row (after a rollback the job instance must be re-fetched/updated in a fresh transaction — test that a rule failure still leaves the job `failed` in the DB). Move-assets path unchanged. `requeue_stale` must never re-queue a `preview` job (it only touches `running`; add an assertion test).

- [ ] Tests (real DB; build jobs via the service: parse a CSV with `bulk_update.parse_upload`, store `payload=[{"row": n, "cells": c} …]`, `status="queued"`): applies approved updates and skips unapproved; `approve_all`; audit rows per asset + one `bulk_import`; status change creates one `ProcessedScan` with source `asset_bulk_update` and runs a rule (seed a simple enabled rule the engine executes — follow an existing status-rules test for the fixture) ; a rule whose action fails → job `failed` / `rule_failed` and NO asset changed; stale job (asset changed so a row now errors) → `failed` / `rows_invalid`; model change on an asset in a move triggers `recheck_placement` for that move (assert via a roster row whose status flips to or from `location_collision`); `run_once` processes an `asset_bulk_update` job end-to-end; progress callback called for a 600-row job (≥ 2 times); a `preview`-status job is never claimed.
- [ ] Commit `feat(api): apply bulk asset updates in the import worker — status scans, placement recheck, progress`.

---

### Task 4: Routes

**Files:** Modify `api/src/serversherpa/api/routes/assets.py`; test `api/tests/test_asset_bulk_update_api.py`.

Seven endpoints exactly as the spec's API table, declared above `@router.get("/{asset_id}")`, each: `actor: AuthContext = require_permission("assets", "change")`, `require_bulk_rank(actor)`, `_require_global(actor)` (use the file's existing global guard). Upload: multipart `file` → `bulk_update.parse_upload` (map `BulkImportError` via `bulk_http_error`); empty → 422 `empty_file`; create `ImportJob(kind="asset_bulk_update", initiative_id=None, created_by=actor, filename, status="preview", phase="preview", total_rows=len, payload=[{"row": n, "cells": row}])`, audit `asset_bulk_update_job_create`, commit, return `{"job_id": str, "preview": listing(await preview_rows(...))}`. Job loader `_bulk_job(db, job_id, actor)`: kind must be `asset_bulk_update` and `created_by == actor.person.id`, else 404 `job_not_found`. Preview: status must be `preview` (else 409 `job_not_editable`); body JSON `{overrides, skip}` parsed with `parse_overrides` / `parse_row_list(…, "invalid_skip")`. Commit: status `preview`; parse `approved_updates` (`invalid_approved`) and `approve_all` (bool); re-preview; not `can_commit` → 422 `rows_invalid` with `rows`; else store `options = {overrides (string keys), skip, approved_updates, approve_all}`, `status="queued"`, `phase="commit"`, audit `asset_bulk_update_queued`, commit, return `ImportJobOut`. Get: `ImportJobOut`. Cancel: status `preview`/`queued` → `status="cancelled"`, `finished_at`; else 409 `job_not_cancellable`; 204. Template/export: `format=csv|xlsx`, filenames `assets-update-template.{fmt}` / `assets-export.{fmt}`, else 422 `unknown_format`.

- [ ] Tests: staff → 403 on all seven; upload csv returns job + preview (rows numbered from 2); another admin gets 404 on that job; preview with an override resolves an attention row; commit unresolved → 422 `rows_invalid`; commit good → job `queued` with options stored; `run_once` then completes it and GET shows `completed` with `results.summary`; cancel from preview → 204 then preview → 409; template/export csv + xlsx (xlsx has sheets `Assets`, `Reference`); `GET /assets/{uuid}` still works (route order).
- [ ] Commit `feat(api): /assets/bulk-update endpoints`.

---

### Task 5: Portal page, client, card, route

**Files:** `portal/src/lib/api.ts` (types + calls), `portal/src/lib/assetBulk.ts` (+ test) — `ASSET_BULK_COLUMN_GUIDE`, `ASSET_BULK_ERRORS`; `portal/src/pages/BulkAssets.tsx` (+ test); `components/bulk/BulkToolPage.tsx` (optional `limitNote?: string`, default keeps today's 1,000/5 MB text); `pages/BulkActions.tsx` card "Update assets in bulk" (`resource: 'assets'`, `action: 'change'`, `to: '/bulk/assets'`, description in the siblings' voice); `App.tsx` route `/bulk/assets` (`ProtectedRoute resource="assets" minRank={ADMIN_RANK}`); stub `components/assets/AssetBulkUpload.tsx`.

Client (`lib/api.ts`): `AssetBulkIssue`, `AssetBulkRow {row, name, asset_id, asset_number, matched_by, action, errors, issues, diff}`, `AssetBulkListing {rows, counts, can_commit, total}`, `AssetBulkOverrides`, `uploadAssetBulk(file, filename) → {job_id, preview}`, `previewAssetBulk(jobId, {overrides, skip})`, `commitAssetBulk(jobId, {overrides, skip, approved_updates, approve_all}) → ImportJob`, `getAssetBulkJob(jobId) → ImportJob`, `cancelAssetBulk(jobId)`, `downloadAssetBulkTemplate(format)`, `downloadAssetBulkExport(format)`. Reuse the existing `ImportJob` type if there is one (grep `import-jobs` in `lib/api.ts`), making `initiative_id` nullable.

Page: title "Update assets in bulk"; hint in the siblings' voice (download the template or the current assets, fill in only what should change, upload, review every change before applying; rows match by Asset ID, or by serial when the Asset ID is blank; blank cells leave a value alone; make/model, client, site and status must already exist, and unknown or shared values can be picked in the preview; large files apply in the background). Downloads: Template (.xlsx/.csv), Current assets (.xlsx/.csv, accent). `limitNote="Uploads are limited to 15,000 rows and 20 MB."`.

- [ ] Tests: guide keys equal the API columns; error map covers `rows_invalid`, `too_many_rows`, `file_too_large`, `job_not_found`, `job_not_editable`, `rule_failed`, `unknown_columns`, `forbidden`; page renders the siblings' sections in order with the 15,000-row note; the card appears for `assets:change`. Commit `feat(portal): Update assets in bulk — page, client, Bulk Actions card`.

---

### Task 6: Upload pane

**Files:** replace `components/assets/AssetBulkUpload.tsx`; add `components/assets/AssetBulkRowDetails.tsx`; tests `components/assets/AssetBulkUpload.test.tsx`.

Mirror `components/initiatives/TeamBulkUpload.tsx` (markup, wording, stale-response guard, portaled per-line `ComboBox`, Skip checkbox with label-in-name) and `BulkUpload.tsx` (buttons, summary line, `DataTable` columns Row / Name / Matched by / Action / Details, `bulk-row-*` classes), with these differences:
- Upload: `uploadAssetBulk(file)` → keep `jobId`; subsequent picks/skips call `previewAssetBulk(jobId, {overrides, skip})` (no rows posted).
- Apply button "Update N assets" (singular "asset"); enabled when `can_commit` and updates approved (or Update all active) and no re-preview pending. **Update all** sets `approveAll = true` (every current and future `update` row counts as approved; individual checkboxes show checked and unchecking one turns `approveAll` off and approves all-but-that-one explicitly); **Skip all** clears. **Skip all unmatched** adds every `attention`/`error` row to `skip` and re-previews.
- Name cell: `name` plus a muted "Asset 12345" line; Matched by: `matched_by`.
- Details: update rows show `describeDiff` lines + Update checkbox; attention/error rows show error sentences, per-issue portaled matchers (issue `field` ∈ asset/model/client/site/status; candidates first; for `unknown` model/client/site/status lazily load the full list via the existing loaders — models from the asset-models list call, clients from the clients list, sites from the sites list, statuses from the asset status values call; grep `lib/api.ts` for each) + Skip + Clear picks (`mini-btn`).
- Table shows the first 200 listed rows with a "Show 200 more" `mini-btn` beneath; summary line counts come from `counts` (they include unchanged rows that are not listed).
- Apply → `commitAssetBulk` → poll `getAssetBulkJob` every 1500 ms (stop on unmount), show `Applying… {processed_rows} of {total_rows}` in a `set-note`; `completed` → `BulkApplySummary` (entity "Asset", `linkFor: r => /assets/${r.asset_id}`, filename `assets-bulk-summary`, `openTo="/assets"`, `openLabel="Open Assets"`) using `results.summary` counts and `results.rows`; `failed` with `rule_failed` → error sentence naming row and rule from `results`; `rows_invalid` → the mapped message and the preview is dropped.

- [ ] Tests (mock `lib/api`): upload → preview renders; pick re-previews with `{overrides: {3: {asset: 'a2'}}, skip: []}` and no rows; Skip all unmatched posts every attention/error row; Update all → commit body `approve_all: true`; polling shows progress then the summary; `rule_failed` shows the row and rule; "Show 200 more" reveals rows 201–400; stale response ignored; new file resets state. Full suite, tsc, build. Commit `feat(portal): asset bulk update pane — per-line matching, background apply with progress`.

---

### Task 7 (controller): full suites, live verification against the other bulk tools' layout, parity sheet.
