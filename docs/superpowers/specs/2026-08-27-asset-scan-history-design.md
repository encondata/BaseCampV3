# Asset scan history on initiative detail — design

**Date:** 2026-08-27
**Status:** approved
**Scope:** Expandable asset-roster rows on `/initiatives/:id` showing the asset's scan history (newest first, latest 15) from `processed_scans`, plus the read endpoint behind it and dev seed data. Builds on the scans feature (2026-08-27-scans-design.md) and list virtualization (2026-08-27-list-virtualization-design.md).

## Decisions

- History source is **`processed_scans` only** (rows with `match_type='asset'` and matching `asset_id`). Raw scans are by definition unmatched — no matching-by-value heuristics; history is the matched record, consistent with the pipeline model. (User-confirmed: test data means adding processed-scan entries.)
- Strictly the **latest 15** entries, newest `scanned_at` first. No pagination / "load more".
- The expansion shows **only scan history** — the roster row's move fields stay in the Edit modal.
- Viewers without `scans: view` never see the expansion (chevron hidden, fetch never fires); the 403 path never surfaces in the UI.

## 1. API — `GET /scans/asset/{asset_id}` (routes/scans.py)

- Declared above `PATCH /scans/processed/{scan_id}` in the file (house route-ordering hygiene; paths don't collide but grouping reads top-down).
- `require_permission("scans", "view")`; params: `limit: int = Query(15, ge=1, le=100)`.
- Query: `ProcessedScan` where `asset_id == asset_id` (match_type='asset' rows are the only ones with asset_id set, enforced by the CHECK constraint — filtering on asset_id alone is sufficient), ordered `scanned_at desc, id`, limited.
- Response: `list[AssetScanItem]` (new schema in api/schemas.py): `id`, `scanned_value`, `scan_type` + `scan_type_label`/`scan_type_color`, `scanned_at`, `processed_at`, `device_id`, `operator_id`/`operator_name`, `site_id`/`site_name`, `location_detail`, `source`. Batch lookups via the module's existing `_vocab`/`_people_names`/`_site_names` helpers — no per-row queries.
- No existence check on the asset id: an unknown/unscanned asset returns `[]` (the UI treats both the same).

## 2. Portal

### Roster row expansion (pages/InitiativeDetail.tsx, assets list)

- Rows gain the standard expansion mechanics used by every directory list: a trailing 30px chevron cell in the grid, `row-main` click toggles `openAssetRowId` (one open at a time, like other lists), `.dir-row.open` + `.detail`/`.detail-clip`/`.detail-inner` slide. Edit/Remove buttons get `e.stopPropagation()` so they never toggle.
- Gated: `const canViewScans = can('scans', 'view')` — when false, no chevron cell, rows don't toggle, nothing fetches (grid template unchanged from today).
- Rows render inside `VirtualRows` — dynamic measurement already handles expansion (proven on the scans tabs).

### `AssetScanHistory` component (components/initiatives/AssetScanHistory.tsx)

- Props: `{ assetId: string }`. Fetches `listAssetScans(assetId)` once on mount (the detail only mounts when open — same lazy pattern as ContainerRowDetail).
- Renders `.detail-grid` with one full-width `.detail-block`, eyebrow "Scan history":
  - Loading: `page-hint` "Loading…"; error: `page-hint` "Could not load scan history."
  - Empty: `page-hint` "No scans recorded for this asset."
  - Entries (newest first, as returned): one compact row each — scanned-at locale string (`mono`), scan-type chip (label + color), device (`mono`, `—` fallback), operator (`—` fallback), site · location (joined, `—` when both blank).
  - When exactly 15 arrive: `page-hint` "Latest 15 scans shown."
- Read-only; no actions, no NotesFilesPanel.

### lib/api.ts

`AssetScanRow` interface mirroring `AssetScanItem` field-for-field; `listAssetScans(assetId: string, limit = 15): Promise<AssetScanRow[]>`.

## 3. Dev seed data

Insert a few hundred `processed_scans` rows with `match_type='asset'` targeting asset ids drawn from `initiative_assets` (the live rosters), spread over the last ~45 days with varied devices/operators/sites, distribution such that several roster assets have >15 scans (cap visible), some 1–5, some none.

## 4. Testing

- **API** (`api/tests/test_scans_api.py`): newest-first ordering; default limit 15 with a 20-scan asset (cap + hint case); `limit` param respected; scans for other assets/containers/people excluded; empty list for unknown asset id; staff (scans view) 200, worker 403.
- **Portal**: no new pure-logic module (formatting reuses inline patterns); existing suites must stay green. Browser verification: expand a roster asset with >15 scans (order, cap hint), one with none (empty state), Edit/Remove still work without toggling, non-scans-view user sees no chevron.

## Out of scope

- Raw-scan value-matching heuristics; pagination of history; scan history on the global Assets page rows (future — the component is reusable there); container/person scan history surfaces.
