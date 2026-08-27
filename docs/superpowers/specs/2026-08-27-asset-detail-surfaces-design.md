# Asset detail surfaces — design

**Date:** 2026-08-27
**Status:** approved
**Scope:** Replaces the initiative roster row expansion (user feedback: the kv scan-history dump "looks horrible") with a button-bar + tabbed expansion, and adds two full-detail pages (move asset, parent asset) plus an env-configured scan-history depth. Supersedes the expansion layout in 2026-08-27-asset-scan-history-design.md; its endpoint and the seeded data carry forward.

**Standing constraint (user): every element reuses the house UI/UX vocabulary — no new visual idioms.** The house elements used here, by name: page chrome `.portal-page`/`.eyebrow`/`.page-title`/`.page-hint`, back link `.idet-back` (`← Label`), header `.idet-header`/`.idet-heading`/`.idet-header-actions`, panels `.init-panel` with `.eyebrow-sm`, key-value `.dl.kv`, chips `.chip.custom` with `--chip` + `.dot`, tables `.activity-changes` (Field/Before/After table styling from the audit viewers), tab bar `.sysconf-tabbar`/`.sysconf-tab`, buttons `.mini-btn`/`.btn-solid`, expansion `.detail`/`.detail-clip`/`.detail-inner`/`.detail-grid`/`.detail-block`, `NotesFilesPanel`, modals `AssetEditModal` (assets) and `AssetEditDialog` (roster rows).

## 1. Shared component — `ScanHistoryTable`

`portal/src/components/scans/ScanHistoryTable.tsx`, used by all three surfaces so the layout cannot fork.

- Props: `{ assetId: string; limit?: number }` — `limit` passed through to `listAssetScans` when set, omitted otherwise (server default applies).
- Fetch once per assetId (existing `listAssetScans`); states: Loading… / Could not load scan history. / No scans recorded for this asset. — all `page-hint`, copy unchanged from AssetScanHistory.
- Layout: a real table using the house `.activity-changes` table styling — columns **Scanned · Method · Device · Operator · Site · Location**:
  - Scanned: `td.mono`, `new Date(s.scanned_at).toLocaleString()`, `white-space: nowrap` (a `.scan-when` helper class in `initiatives.css` if needed — nowrap only, no new visual style).
  - Method: `.chip.custom` with `scan_type_color`/`scan_type_label`.
  - Device: `td.mono`, `—` when blank. Operator / Site / Location: plain text, `—` when blank. One field per column — never joined strings.
- Optional `capHint?: number` prop: when provided and `rows.length >= capHint`, render footer `page-hint` "Latest {capHint} scans shown.". The roster tab passes `limit={15} capHint={15}`; the pages pass neither (no hint — their depth is the env-configured default).
- Replaces `AssetScanHistory.tsx` (delete it).

## 2. Roster expansion — button bar + tabs

In `pages/InitiativeDetail.tsx`, the expansion (`.detail-inner`) becomes:

- A control row: left, a `.sysconf-tabbar` with two `.sysconf-tab`s **Move Details** (default active) and **Scan History**; right (via `.idet-header-actions`-style flex spacing), two `Link`s styled `.mini-btn`: **Full Details** → `/initiatives/:id/assets/:rowId` and **Parent Asset** → `/assets/:assetId`.
- Tab state per open row, resets to Move Details on each expand (`useState` inside the expansion component — remounts on open, matching the lazy pattern).
- **Move Details** view: `.detail-grid` with three `.detail-block`s of `dl.kv`:
  - *Placement*: Source rack, Source RU, Source position, Source verified (the roster's Yes+check rendering), Destination rack, Destination RU, Destination position, Destination verified.
  - *Logistics*: Wave, Disposition, Owner, Cable info, Vendor involved (Yes/No/—).
  - *Status*: Move status chip, Asset status chip, Added (locale date), Updated (locale date).
  - All values reuse `moveAssetCellText` fallbacks where a matching column key exists; `—` for blanks.
- **Scan History** view: `<ScanHistoryTable assetId={a.asset_id} limit={15} capHint={15} />`.
- Everything else about the row (chevron, gating on `can('scans','view')`… ) — unchanged? **No**: the expansion itself is no longer scans-only. Gating changes: rows are expandable for anyone who can see the page; the **Scan History tab and the two page links' history panels** are the scans-gated parts. Concretely: chevron + expansion always available; the Scan History tab hidden when `!can('scans','view')` (Move Details still useful); the pages render their Scan History panel only with the permission.

## 3. New page — Move Asset Details (`/initiatives/:id/assets/:rowId`)

`portal/src/pages/MoveAssetDetail.tsx`, route registered in App.tsx under `ProtectedRoute resource="initiatives"` (nested like `/initiatives/:id/import-assets`).

- Chrome: `.idet-back` "← {initiative name}" linking to `/initiatives/:id` (falls back to "← Initiative" while loading), `.idet-header` with `.page-title` = asset name (fallback serial), `.page-hint` = serial · make/model, `.idet-header-actions` holding `.btn-solid` **Edit** (opens `AssetEditDialog`) when `can('initiatives','change')`.
- Panels (`.init-panel` grid, like InitiativeDetail):
  - **Parent Asset**: `dl.kv` — Name, Serial (`mono`), RFID (`mono`), Make/Model, Category, Status chip, Client, Site, Location, Last seen, Created. Data: `getAsset(asset_id)` (`GET /assets/{asset_id}`, exists).
  - **Move Details**: the same three blocks as the inline tab (complete field set).
  - **Scan History**: `<ScanHistoryTable assetId={...} />` (no limit → env-configured depth), rendered only with `can('scans','view')`.
- Data: `listInitiativeAssets(initiativeId)` → find `rowId` (roster sizes make this fine; no new endpoint), `getInitiative(id)` for the name, `getAsset` for the parent panel. Row missing → `.dir-empty`-style "This asset is no longer on the initiative." with the back link.
- Editable: `AssetEditDialog` **extracted** from InitiativeDetail.tsx to `portal/src/components/initiatives/AssetEditDialog.tsx` verbatim (props unchanged) and imported by both. After save, the page refetches its row.

## 4. New page — Asset Details (`/assets/:assetId`)

`portal/src/pages/AssetDetail.tsx`, route under `ProtectedRoute resource="assets"`.

- Chrome: `.idet-back` "← Assets" → `/assets`; `.idet-header` with name/serial + `.page-hint` make/model · status; **Edit** `.btn-solid` opens the existing `AssetEditModal` when `can('assets','change')`.
- Panels: **Identity** (name, serial, RFID, external refs the Assets expansion shows), **Model** (make/model/category + model summary fields the Assets expansion shows), **Location & status** (status chip, client, site, location, last seen, has rails), **Notes & files** (`NotesFilesPanel entityType="asset"`), **Scan History** (`<ScanHistoryTable assetId={...} />`, scans-gated). Field set = superset of the current Assets list row expansion — mirror that expansion's blocks; add nothing novel.
- Unknown id → `.dir-empty` "Asset not found" + back link.
- Reached from the Parent Asset button. (Wiring other surfaces — Assets list, matched-scan links — to this page: out of scope this slice.)

## 5. Config — scan-history depth

- `.env` / `.env.example`: new section in the house style, placed after the Login lockout section:

```
# ── Scans ──────────────────────────────────────────────────
# Default number of scan-history entries returned when a caller
# doesn't specify a limit (asset/move detail pages). The inline
# roster tab always requests 15. More scan settings will land here.
SS_SCANS_HISTORY_DEFAULT=100
```

- `Settings.scans_history_default: int = 100` (pydantic-settings, validated ge=1).
- `GET /scans/asset/{asset_id}`: `limit: int | None = Query(None, ge=1, le=500)`; `None` ⇒ `get_settings().scans_history_default`. Existing behavior (`limit=15` from the roster tab) unchanged; `le` raised 100→500 so the env value has headroom.

## 6. Testing

- **API**: omitted limit uses the settings default (override the setting in-test to a small value and assert the count); explicit limit still wins; bounds 1..500.
- **Portal**: suites stay green (extraction of `AssetEditDialog` must not change behavior — its usage sites compile untouched). Browser pass: expansion defaults to Move Details; tab switch to Scan History shows the table (aligned columns, nowrap timestamps, chips); Full Details and Parent Asset navigate; both pages render all panels, Edit round-trips on each page; scans-gating hides the history tab/panels for a non-scans role; cap hint only on the roster tab.

## Out of scope

- Editing on pages beyond the existing modals; pagination of history; linking Assets list / audit / matched-scan cells to the new asset page; container/person detail pages.
