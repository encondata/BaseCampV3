# Scans — design

**Date:** 2026-08-27
**Status:** approved
**Scope:** `raw_scans` + `processed_scans` tables, `/scans` API, Admin → Scans portal page (Raw / Processed tabs). The processing script that matches raw scans and moves them to processed scans is **explicitly deferred**, as are the ingest endpoint and the raw-scan pruning job.

## Background

Scan surfaces were anticipated from the start: `assets.last_seen_at`, `containers.last_audit_at` / `audit_by`, and `container_assets.last_validated_at` are all commented "written by future scan surfaces". Raw scans will eventually arrive from the planned kiosk/iOS app and directly from fixed hardware RFID readers. This phase builds the storage and the admin viewing surfaces only — tables and lists, no ingest, no matcher.

## Decisions (from brainstorming)

- Sources are the **future kiosk/iOS app and hardware readers**; device identity is a first-class column. No ingest endpoint this phase — test data comes from SQL/fixtures.
- A raw scan carries: scanned value, timestamps, **device identity, operator person, site + location detail**. No session/batch grouping (YAGNI).
- Processing (future) matches a raw scan to an **asset, container, or person**. It is a **true move**: the processed row copies the raw data and the raw row is deleted. Unmatched scans simply remain in `raw_scans` — it is the inbox; `processed_scans` is the permanent record.
- **Hybrid list architecture**: raw scans are a high-volume firehose → paged like the Audit log; processed scans are a curated record → full standard list (a pruning job will eventually cap growth, deferred).
- **One Admin nav item** ("Scans", `/admin/scans`) with Raw / Processed tabs; one `scans` resource in access control.
- Revised 2026-08-27 (user feedback): the Raw tab uses the same standard list layout as Processed — full client-side load is acceptable because pruning keeps raw_scans bounded; the API's paging/filter params remain for future kiosk/debug callers.

## Architecture

Asymmetric table pair, each following its nearest existing precedent:

| Table | Precedent | PK | List style |
|---|---|---|---|
| `raw_scans` | `log_entries` (0024) | BigInteger `Identity()` | Paged, Audit-style |
| `processed_scans` | `containers` (0015) | UUID `gen_random_uuid()` | Full standard list |

Alternatives rejected: a single `scans` table with a `state` column (contradicts true-move semantics, complicates pruning); two symmetric UUID domain tables (wrong shape for the append-only firehose).

## 1. Data model — migration `0025_scans.py`

### Vocabulary seeds (`status_values`)

- `record_type='scan'`, keys `rfid`, `barcode`, `manual` — scan method, rendered as colored chips.
- `record_type='processed_scan'`, keys `asset`, `container`, `person` — match type chips.

### `raw_scans`

| Column | Type | Notes |
|---|---|---|
| `id` | BigInteger, `Identity()`, PK | log-style, high volume |
| `scanned_value` | CITEXT, not null | RFID tag / barcode string |
| `scan_type` | Text, not null | FK into `status_values` via generated `scan_type_record_type = 'scan'` discriminator |
| `scanned_at` | timestamptz, not null | device-reported time |
| `device_id` | Text, not null, default `''` | reader/kiosk identity string; no devices table yet |
| `operator_id` | UUID FK → `people.id`, nullable | null for unattended fixed readers |
| `site_id` | UUID FK → `sites.id`, nullable | |
| `location_detail` | Text, not null, default `''` | dock door, room, zone |
| `source` | Text, not null, default `''` | provenance: `kiosk` / `reader` / `import` |
| `created_at` | timestamptz, not null, default `now()` | ingest time |

Indexes: `raw_scans_scanned_at_idx` (desc), `raw_scans_scanned_value_idx`. No `updated_at`/`archived_at` — rows are append-only until moved or pruned.

### `processed_scans`

Copies every raw context column (`scanned_value`, `scan_type` + its own `'scan'` discriminator, `scanned_at`, `device_id`, `operator_id`, `site_id`, `location_detail`, `source`), plus:

| Column | Type | Notes |
|---|---|---|
| `id` | UUID, PK, `gen_random_uuid()` | domain-style |
| `raw_scan_id` | BigInteger, nullable, **no FK** | raw row is deleted on move; kept for traceability |
| `match_type` | Text, not null | FK into `status_values` via generated `match_record_type = 'processed_scan'` discriminator |
| `asset_id` | UUID FK → `assets.id`, nullable | |
| `container_id` | UUID FK → `containers.id`, nullable | |
| `person_id` | UUID FK → `people.id`, nullable | the **matched** person (badge scan) — distinct from `operator_id` |
| `processed_at` | timestamptz, not null | when the matcher ran |
| `created_at` / `updated_at` | timestamptz, not null, default `now()` | standard |
| `archived_at` | timestamptz, nullable | soft delete for the standard list |

CHECK constraint `processed_scans_match_target_chk`: the FK matching `match_type` is non-null (`match_type='asset' AND asset_id IS NOT NULL`, etc.).

Indexes: `processed_scans_scanned_at_idx` (desc), `processed_scans_scanned_value_idx`, plus one per match FK.

Migration seeds `role_permissions` for the `scans` resource and has a clean `downgrade()` (delete grants + vocab rows, drop tables in reverse). Both tables mirrored as `RawScan` / `ProcessedScan` in `db/models.py`.

## 2. Access control

- `access/resources.py`: `Resource("scans", "Scans", routes=("/admin/scans",), visible_to=frozenset({"global"}))`.
- `access/defaults.py`: add `"scans"` to `_ALL`; grants — **superadmin/admin: view + change + delete; staff: view; all other roles: none.** Admin-section forensic surface, same posture as Audit.

## 3. API — `api/routes/scans.py`, router prefix `/scans`

- `GET /scans/raw` — `limit` optional (`None` = all, else `1..500`), `offset` (default 0); optional scalar filters `device_id`, `operator_id`, `site_id`, `scan_type`, `since`, `until`, `value` (substring match on `scanned_value`). Bare JSON array, newest `scanned_at` first, rows denormalized (`scan_type_label`/`color`, `operator_name`, `site_name`) with batch lookups — never per-row queries. Read-only this phase. The portal loads the full list unpaged (client-side filter/sort, standard list); paging/filter params remain for future kiosk/debug callers.
- `GET /scans/processed` — bare denormalized full array: everything above plus `match_type_label`/`color`, `matched_name` (asset name / container name / person name), `asset_id`/`container_id`/`person_id` for linking. Ordered `scanned_at desc`.
- `PATCH /scans/processed/{id}` — god-edit only fields: `site_id`, `location_detail`, `operator_id` (fixing bad context on a historical record). **Match fields are not editable** — re-matching is the (future) processor's job. Snapshot → diff → `audit(...)`.
- God delete follows the house pending-delete flow (no custom DELETE endpoint): register `"processed_scan": ProcessedScan` in the `DELETABLE` map in `routes/devtools.py`; the portal wires `GodDeleteButton` + `usePendingDeletes` as on Containers.
- Pydantic models `RawScanItem`, `ProcessedScanItem`, `ProcessedScanPatch` in `api/schemas.py`; errors via `_err()` with snake codes.
- `services/entity_refs.py`: resolve `processed_scan` audit rows to a display name (scanned value + match label).
- Register router in `api/app.py`.

## 4. Portal

### Navigation & routing

- `layout/navSections.tsx`: "Scans" item in the **Admin** section (inline 24×24 stroke-1.7 SVG — a barcode/scan glyph), `resource: "scans"`.
- `App.tsx`: `<Route path="/admin/scans" element={<ProtectedRoute resource="scans"><Scans /></ProtectedRoute>} />`.
- `components/CommandPalette.tsx`: ⌘K nav entry via `navGated(...)`.
- **Deliberate omissions:** no global-search registration this phase (log-type data), no `NotesFilesPanel` on scan rows (machine records, not curated entities).

### Page — `pages/Scans.tsx`

One page, **Raw | Processed** tabs following the existing tab pattern. Standard `.dir-head` (eyebrow "Admin", title "Scans", live count badge for the active tab, one-line hint).

**Raw tab** — cloned from `Containers.tsx`, matching the Processed tab's standard-list layout exactly:
- Toolbar in house order: `.dir-search` "Filter this list…", `.result-count`, `FilterSummaryChip`, `ColumnsButton` (+ header drag reorder), `ExportButton` (CSV of visible rows). No god-edit, no god-delete, no Import/New — raw scans are read-only (rows arrive via ingest, leave via the future matcher/pruner).
- Column model: primary = scanned value (`mono`); columns: scan type chip, scanned at, device, operator, site, location detail, source, ingested at. No archived pseudo-column (raw scans have no `archived_at`). `usePersistentListState(pageKey: 'raw_scans', ...)`.
- Excel-style `ColumnMenu` on every visible column; `naturalCompare` sorting; `.dir-empty` + `EmptyClearFilters`; no deep-link focus (nothing links to raw rows).
- Row expansion: read-only `.detail-grid`, no actions block.
- Full client-side load (`listRawScans({})`, no limit/offset) — acceptable because the future pruning job keeps `raw_scans` bounded.

**Processed tab** — cloned from `Containers.tsx` with the full standard kit:
- Toolbar in house order: `.dir-search` "Filter this list…", `.result-count`, `FilterSummaryChip`, `ColumnsButton` (+ header drag reorder), `ExportButton` (CSV of visible rows), `GodEditToggle`. No New/Import buttons — rows are created only by the (future) processor.
- Column model: primary = scanned value (`mono`); columns: match type chip, matched record (links to the asset / container / person page), scanned at, processed at, device, operator, site, location detail, source, archived pseudo-column. `usePersistentListState(pageKey: 'processed_scans', ...)`.
- Excel-style `ColumnMenu` on every visible column; `naturalCompare` sorting; archived rows hidden unless filtered in; `.dir-empty` + `EmptyClearFilters`; deep-link focus via `useRecordFocus` (`?open=<id>`).
- Row expansion: read-only `.detail-grid` (all fields incl. `raw_scan_id`, ids) + `GodDeleteButton`. No NotesFilesPanel.
- God-edit fields (via `useGodEdit`/`GodCell`): site, location detail, operator — matching the PATCH surface.

### Pure-logic module — `lib/scans.ts` (+ `lib/scans.test.ts`)

`processedScanSearchText`, `processedScanCellText` (mirrors cell rendering exactly, `—` for blanks), `rawScanSearchText`, `rawScanCellText` (same shape, no archived pseudo-column), `SCANS_ERRORS` code→message map, god-field factory `PROCESSED_SCAN_GOD_FIELDS(lookups)`.

`lib/api.ts`: `RawScanRow` / `ProcessedScanRow` interfaces, `listRawScans(params)`, `listProcessedScans()`, `updateProcessedScan()`. Deletion goes through the existing pending-deletes API.

## 5. Testing

- **API** (`api/tests/test_scans.py`, real Postgres per conftest): migration round-trip (upgrade/downgrade), permission gates per role, raw paging + each filter, processed list denormalization, PATCH field whitelist + audit row, DELETE + audit row, CHECK constraint rejects mismatched match_type/FK.
- **Portal** (`lib/scans.test.ts`, bare node): searchText/cellText parity, god-field payloads, error map.

## 6. Build order

1. Migration `0025_scans.py` + `db/models.py` mirrors
2. `access/resources.py` + `access/defaults.py`
3. `routes/scans.py` + `schemas.py` + `entity_refs.py` + `app.py` registration + API tests
4. `lib/api.ts` types + fetchers
5. Nav item, route, ⌘K entry
6. `pages/Scans.tsx` Raw tab
7. Processed tab + `lib/scans.ts` + portal tests

## Deferred (explicitly out of scope)

- Processing/matching script (raw → processed move; writes `assets.last_seen_at`, `containers.last_audit_at`/`audit_by`, `container_assets.last_validated_at`). **The matcher phase must also decide a growth story for `processed_scans`** — either a retention/rollup policy or pagination of `GET /scans/processed` — since the full-load standard list has no cap once every matched read becomes a permanent row (final-review finding, 2026-08-27).
- Ingest endpoint + device authentication
- Raw-scan pruning/retention job
- Global-search registration for scans
- Devices table / device management UI
