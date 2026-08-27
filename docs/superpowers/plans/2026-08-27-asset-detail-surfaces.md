# Asset Detail Surfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the roster-row expansion with a button-bar + tabbed layout (Move Details default / Scan History table / links to two new pages) and add the Move Asset Details and Asset Details pages, with scan-history depth driven by a new env setting.

**Architecture:** One shared `ScanHistoryTable` (activity-changes table styling) used by the roster tab and both pages; both pages reuse the house `idet-*`/`init-panel` chrome and the existing edit modals (`AssetEditDialog` extracted from InitiativeDetail.tsx, `AssetEditModal` as-is). Spec: `docs/superpowers/specs/2026-08-27-asset-detail-surfaces-design.md`.

**Tech Stack:** FastAPI + pydantic-settings; React 18 + TS + react-router-dom.

## Global Constraints

- **Every element reuses the house UI vocabulary** — the spec's opening list names them; no new visual idioms. New CSS is limited to layout helpers explicitly named below.
- Expansion default tab: Move Details. Scan History tab and page history panels are gated on `can('scans','view')`; the expansion itself is NOT scans-gated anymore.
- ScanHistoryTable columns exactly: Scanned · Method · Device · Operator · Site · Location — one field per column, `—` per blank cell, never joined strings; roster tab passes `limit={15} capHint={15}`; pages pass neither.
- Env: `SS_SCANS_HISTORY_DEFAULT=100` in its own `# ── Scans ──` section; endpoint `limit: int | None = Query(None, ge=1, le=500)`, `None` ⇒ `get_settings().scans_history_default`.
- Pages are editable only via the existing modals; everything else read-only.
- Suites: API `.venv/bin/python -m pytest -q` from `api/` (foreground, long timeout); portal `npm test` + `npm run build`. Never commit `api/src/serversherpa/_dev_reload.py`. Commits carry the `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.

---

### Task 1: API — env-configured history depth

**Files:**
- Modify: `api/src/serversherpa/config.py` (Settings class — follow the field-with-trailing-comment style around `max_failed_logins`, config.py:53)
- Modify: `.env.example` and `.env` (new section after `# ── Login lockout ──`)
- Modify: `api/src/serversherpa/api/routes/scans.py` (`list_asset_scans` limit)
- Test: `api/tests/test_scans_api.py` (append)

**Interfaces:**
- Produces: `Settings.scans_history_default: int` (default 100); `GET /scans/asset/{asset_id}` with omitted `limit` returns up to that many rows; explicit `limit` (1..500) still wins. Portal callers omitting `limit` get the env-configured depth.

- [ ] **Step 1: Write the failing test** (append to `api/tests/test_scans_api.py`)

```python
async def test_asset_scan_history_env_default(client, db, seeded_user, monkeypatch):
    from serversherpa.config import get_settings

    hdrs = await login(client)
    asset = Asset(name="hist-env")
    db.add(asset)
    await db.flush()
    db.add_all([ProcessedScan(
        scanned_value=f"EPC-E-{i:03d}", scan_type="rfid",
        scanned_at=T0 + timedelta(minutes=i),
        processed_at=T0 + timedelta(minutes=i),
        match_type="asset", asset_id=asset.id) for i in range(8)])
    await db.commit()

    # omitted limit -> settings default (patched small so the test is cheap)
    monkeypatch.setattr(get_settings(), "scans_history_default", 5)
    resp = await client.get(f"/scans/asset/{asset.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert len(resp.json()) == 5

    # explicit limit still wins over the setting
    resp = await client.get(f"/scans/asset/{asset.id}?limit=2", headers=hdrs)
    assert len(resp.json()) == 2

    # bounds: le=500
    resp = await client.get(f"/scans/asset/{asset.id}?limit=501", headers=hdrs)
    assert resp.status_code == 422
```

(`get_settings()` is cached — check how existing tests patch settings; if the codebase patches differently (e.g. a fixture), follow that pattern instead of `monkeypatch.setattr` on the cached instance, and say so in your report. Note the earlier `test_asset_scan_history` asserts a 15-row default — update that assertion to patch the setting to 15 first, or assert against the patched value, keeping the cap semantics tested.)

- [ ] **Step 2: Run to verify failure**

Run (from `api/`): `.venv/bin/python -m pytest tests/test_scans_api.py -x -q`
Expected: new test FAILS (default is currently 15, len == 8; and 501 currently 422 already — the first assertion is the failing one).

- [ ] **Step 3: Implement**

`api/src/serversherpa/config.py` — add to `Settings` near the lockout fields, matching their comment style:

```python
    # ── Scans ─────────────────────────────────────────────
    scans_history_default: int = 100  # history rows when caller omits limit
```

`.env.example` AND `.env` — after the Login lockout section:

```
# ── Scans ──────────────────────────────────────────────────
# Default number of scan-history entries returned when a caller
# doesn't specify a limit (asset/move detail pages). The inline
# roster tab always requests 15. More scan settings will land here.
SS_SCANS_HISTORY_DEFAULT=100
```

`api/src/serversherpa/api/routes/scans.py` — in `list_asset_scans`:

```python
    limit: int | None = Query(None, ge=1, le=500),
```

and at the top of the body:

```python
    if limit is None:
        limit = get_settings().scans_history_default
```

with `from serversherpa.config import get_settings` added to the imports.

- [ ] **Step 4: Run the tests**

`.venv/bin/python -m pytest tests/test_scans_api.py -q` → 13 passed. Then full suite `.venv/bin/python -m pytest -q` (foreground, long timeout) → all pass (config tests may enumerate Settings fields — update if so).

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/config.py api/src/serversherpa/api/routes/scans.py api/tests/test_scans_api.py .env.example
git commit -m "feat(api): env-configured scan-history depth (SS_SCANS_HISTORY_DEFAULT)"
```

(`.env` is git-ignored — edit it but it won't be committed.)

---

### Task 2: Portal — `ScanHistoryTable` + roster expansion rework

**Files:**
- Create: `portal/src/components/scans/ScanHistoryTable.tsx`
- Delete: `portal/src/components/initiatives/AssetScanHistory.tsx`
- Modify: `portal/src/pages/InitiativeDetail.tsx` (expansion block + gating)
- Modify: `portal/src/styles/initiatives.css` (two layout helpers)

**Interfaces:**
- Consumes: `listAssetScans(assetId, limit?)` from lib/api.ts (already exists — make `limit` optional in its signature if it isn't: `limit?: number`, appending `?limit=` only when set).
- Produces: `<ScanHistoryTable assetId={string} limit?={number} capHint?={number} />`; the expansion component `<MoveAssetExpansion row={InitiativeAssetRow} initiativeId={string} canViewScans={boolean} />` (local to InitiativeDetail.tsx). Tasks 3–4 reuse `ScanHistoryTable` with no props beyond `assetId`.

- [ ] **Step 1: ScanHistoryTable**

```tsx
/**
 * ScanHistoryTable — the one scan-history layout, shared by the roster
 * expansion tab and the asset/move detail pages so it cannot fork.
 * Real table (house .activity-changes styling): one field per column,
 * '—' per blank cell. Lazy: fetches once per assetId on mount.
 */
import { useEffect, useState, type CSSProperties } from 'react';

import { listAssetScans, type AssetScanRow } from '../../lib/api';

export default function ScanHistoryTable({ assetId, limit, capHint }: {
  assetId: string; limit?: number; capHint?: number;
}) {
  const [scans, setScans] = useState<AssetScanRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setScans(null);
    setError(false);
    void listAssetScans(assetId, limit)
      .then(setScans)
      .catch(() => setError(true));
  }, [assetId, limit]);

  if (error) return <p className="page-hint">Could not load scan history.</p>;
  if (scans === null) return <p className="page-hint">Loading…</p>;
  if (scans.length === 0) {
    return <p className="page-hint">No scans recorded for this asset.</p>;
  }
  return (
    <>
      <table className="activity-changes scan-history">
        <thead>
          <tr>
            <th>Scanned</th><th>Method</th><th>Device</th>
            <th>Operator</th><th>Site</th><th>Location</th>
          </tr>
        </thead>
        <tbody>
          {scans.map((s) => (
            <tr key={s.id}>
              <td className="mono scan-when">
                {new Date(s.scanned_at).toLocaleString()}
              </td>
              <td>
                <span className="chip custom"
                      style={{ '--chip': s.scan_type_color } as CSSProperties}>
                  <span className="dot" />{s.scan_type_label}
                </span>
              </td>
              <td className="mono">{s.device_id || '—'}</td>
              <td>{s.operator_name ?? '—'}</td>
              <td>{s.site_name ?? '—'}</td>
              <td>{s.location_detail || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {capHint !== undefined && scans.length >= capHint && (
        <p className="page-hint">Latest {capHint} scans shown.</p>
      )}
    </>
  );
}
```

`portal/src/lib/api.ts` — `listAssetScans` becomes:

```typescript
export async function listAssetScans(
  assetId: string, limit?: number,
): Promise<AssetScanRow[]> {
  const qs = limit !== undefined ? `?limit=${limit}` : '';
  const resp = await apiFetch(`/scans/asset/${assetId}${qs}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

`portal/src/styles/initiatives.css` — append (layout-only helpers, no new visual idiom):

```css
/* asset expansion: tab bar left, page links right; nowrap timestamps */
.idet-expand-bar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.idet-expand-bar .sysconf-tabbar { margin: 0; }
.idet-expand-links { margin-left: auto; display: flex; gap: 8px; }
.scan-history .scan-when { white-space: nowrap; }
```

- [ ] **Step 2: Roster expansion rework** (`portal/src/pages/InitiativeDetail.tsx`)

Delete the `AssetScanHistory` import (and its file). Add imports: `ScanHistoryTable` from `../components/scans/ScanHistoryTable`, `Link` already imported.

Add a component near `AssetEditDialog` in the same file:

```tsx
/** Roster expansion: Move Details / Scan History tabs + page links.
 *  Remounts per open, so the tab resets to Move Details each expand. */
function MoveAssetExpansion({ row, initiativeId, canViewScans }: {
  row: InitiativeAssetRow; initiativeId: string; canViewScans: boolean;
}) {
  const [view, setView] = useState<'move' | 'scans'>('move');
  const yesNo = (v: boolean | null) => (v === null ? '—' : v ? 'Yes' : 'No');
  return (
    <div>
      <div className="idet-expand-bar">
        <div className="sysconf-tabbar" role="tablist">
          <button type="button" role="tab" aria-selected={view === 'move'}
                  className={`sysconf-tab${view === 'move' ? ' active' : ''}`}
                  onClick={() => setView('move')}>
            Move Details
          </button>
          {canViewScans && (
            <button type="button" role="tab" aria-selected={view === 'scans'}
                    className={`sysconf-tab${view === 'scans' ? ' active' : ''}`}
                    onClick={() => setView('scans')}>
              Scan History
            </button>
          )}
        </div>
        <div className="idet-expand-links">
          <Link className="mini-btn"
                to={`/initiatives/${initiativeId}/assets/${row.id}`}>
            Full Details ↗
          </Link>
          <Link className="mini-btn" to={`/assets/${row.asset_id}`}>
            Parent Asset ↗
          </Link>
        </div>
      </div>
      {view === 'move' ? (
        <div className="detail-grid">
          <div className="detail-block">
            <p className="eyebrow-sm">Placement</p>
            <dl className="kv">
              <dt>Source rack</dt><dd>{row.source_rack ?? '—'}</dd>
              <dt>Source RU</dt><dd>{row.source_ru ?? '—'}</dd>
              <dt>Source position</dt><dd>{row.source_position ?? '—'}</dd>
              <dt>Source verified</dt><dd>{yesNo(row.source_verified)}</dd>
              <dt>Destination rack</dt><dd>{row.destination_rack ?? '—'}</dd>
              <dt>Destination RU</dt><dd>{row.destination_ru ?? '—'}</dd>
              <dt>Destination position</dt><dd>{row.destination_position ?? '—'}</dd>
              <dt>Destination verified</dt><dd>{yesNo(row.destination_verified)}</dd>
            </dl>
          </div>
          <div className="detail-block">
            <p className="eyebrow-sm">Logistics</p>
            <dl className="kv">
              <dt>Wave</dt><dd>{row.priority_wave ?? '—'}</dd>
              <dt>Disposition</dt><dd>{row.disposition ?? '—'}</dd>
              <dt>Owner</dt><dd>{row.owner ?? '—'}</dd>
              <dt>Cable info</dt><dd>{row.cable_info ?? '—'}</dd>
              <dt>Vendor involved</dt><dd>{yesNo(row.vendor_involved)}</dd>
            </dl>
          </div>
          <div className="detail-block">
            <p className="eyebrow-sm">Status</p>
            <dl className="kv">
              <dt>Move status</dt>
              <dd>{chip(row.status_label, row.status_color)
                ?? row.status_label}</dd>
              <dt>Asset status</dt>
              <dd>{chip(row.asset.status_label, row.asset.status_color)
                ?? row.asset.status_label}</dd>
              <dt>Added</dt><dd>{new Date(row.created_at).toLocaleDateString()}</dd>
              <dt>Updated</dt><dd>{new Date(row.updated_at).toLocaleDateString()}</dd>
            </dl>
          </div>
        </div>
      ) : (
        <ScanHistoryTable assetId={row.asset_id} limit={15} capHint={15} />
      )}
    </div>
  );
}
```

(`chip` is the existing module-level helper in this file — verify its exact signature/return and adapt the two chip lines to match how `assetCellFor` calls it.)

Gating + wiring changes in the assets list:
- `canViewScans` stays defined but no longer gates the chevron/expansion: the grid template's `' 30px'`, the head `<span className="col-head" />`, the chevron cell, and `row-main`'s `onClick` become unconditional (drop the `canViewScans ?`/`&&` around them).
- The expansion body becomes `{open && <MoveAssetExpansion row={a} initiativeId={id!} canViewScans={canViewScans} />}` (the page's `id` route param — match the existing variable).

- [ ] **Step 3: Suites**

From `portal/`: `npm test` + `npm run build` — clean. (Nothing referenced `AssetScanHistory` outside InitiativeDetail; verify with grep before deleting.)

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/scans/ScanHistoryTable.tsx portal/src/pages/InitiativeDetail.tsx portal/src/styles/initiatives.css portal/src/lib/api.ts
git rm portal/src/components/initiatives/AssetScanHistory.tsx
git commit -m "feat(portal): roster expansion with move/scan tabs + shared scan table"
```

---

### Task 3: Move Asset Details page

**Files:**
- Create: `portal/src/components/initiatives/AssetEditDialog.tsx` (extraction)
- Create: `portal/src/pages/MoveAssetDetail.tsx`
- Modify: `portal/src/pages/InitiativeDetail.tsx` (import the extracted dialog; delete the local copy)
- Modify: `portal/src/lib/api.ts` (add `getAsset`)
- Modify: `portal/src/App.tsx` (route)

**Interfaces:**
- Consumes: `ScanHistoryTable` (Task 2); `listInitiativeAssets(initiativeId)`, `getInitiative(id)`, `listMoveStatuses`-equivalent (find the exact fetcher InitiativeDetail uses for `moveStatuses` and reuse it); `AssetEditDialog` props exactly `{ asset: InitiativeAssetRow; moveStatuses: StatusValue[]; onClose: () => void; onSaved: () => Promise<void> | void }`.
- Produces: route `/initiatives/:id/assets/:rowId`; `getAsset(id: string): Promise<AssetItem>` in api.ts (Task 4 reuses it).

- [ ] **Step 1: Extract AssetEditDialog**

Move the entire `function AssetEditDialog(...)` (InitiativeDetail.tsx:1174 onward, through its closing brace) plus any module-level constants/imports ONLY it uses into `portal/src/components/initiatives/AssetEditDialog.tsx` as the default export, byte-identical logic. InitiativeDetail.tsx imports it. `npm test` must stay green after the move alone.

- [ ] **Step 2: getAsset** (api.ts, next to the other asset fetchers)

```typescript
export async function getAsset(id: string): Promise<AssetItem> {
  const resp = await apiFetch(`/assets/${id}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

- [ ] **Step 3: The page** — create `portal/src/pages/MoveAssetDetail.tsx`:

```tsx
/**
 * Move Asset Details — one roster row in full: parent-asset summary,
 * complete move details, scan history. Editable via the shared
 * AssetEditDialog; chrome mirrors InitiativeDetail (idet-*).
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AssetEditDialog from '../components/initiatives/AssetEditDialog';
import ScanHistoryTable from '../components/scans/ScanHistoryTable';
import {
  getAsset, getInitiative, listInitiativeAssets,
  type AssetItem, type InitiativeAssetRow, type StatusValue,
} from '../lib/api';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/system.css';

const chip = (label: string | null, color: string | null) =>
  label && color ? (
    <span className="chip custom" style={{ '--chip': color } as CSSProperties}>
      <span className="dot" />{label}
    </span>
  ) : null;

export default function MoveAssetDetail() {
  const { id, rowId } = useParams<{ id: string; rowId: string }>();
  const { can } = useAuth();
  const canChange = can('initiatives', 'change');
  const canViewScans = can('scans', 'view');

  const [initiativeName, setInitiativeName] = useState<string | null>(null);
  const [row, setRow] = useState<InitiativeAssetRow | null>(null);
  const [asset, setAsset] = useState<AssetItem | null>(null);
  const [moveStatuses, setMoveStatuses] = useState<StatusValue[]>([]);
  const [missing, setMissing] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(async () => {
    if (!id || !rowId) return;
    const rows = await listInitiativeAssets(id);
    const found = rows.find((r) => r.id === rowId) ?? null;
    setRow(found);
    setMissing(found === null);
    if (found) void getAsset(found.asset_id).then(setAsset).catch(() => {});
  }, [id, rowId]);

  useEffect(() => {
    void load();
    if (id) void getInitiative(id).then((i) => setInitiativeName(i.name)).catch(() => {});
    // moveStatuses: use the SAME fetcher InitiativeDetail.tsx uses (find it
    // there — the status_values vocabulary for the roster status combo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, rowId]);

  const back = (
    <Link to={`/initiatives/${id}`} className="idet-back">
      ← {initiativeName ?? 'Initiative'}
    </Link>
  );

  if (missing) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>Not on this initiative</b>This asset is no longer on the initiative.
        </div>
      </div>
    );
  }
  if (!row) {
    return <div className="portal-page">{back}<p className="page-hint">Loading…</p></div>;
  }

  const yesNo = (v: boolean | null) => (v === null ? '—' : v ? 'Yes' : 'No');
  const title = row.asset.name ?? row.asset.serial_number ?? 'Asset';

  return (
    <div className="portal-page">
      {back}
      <div className="idet-header">
        <div className="idet-heading">
          <h1 className="page-title">{title}</h1>
          <p className="page-hint">
            {[row.asset.serial_number, asset?.model
              ? `${asset.model.make} ${asset.model.model}` : null]
              .filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
        {canChange && (
          <div className="idet-header-actions">
            <button className="btn-solid" onClick={() => setEditing(true)}>Edit</button>
          </div>
        )}
      </div>

      <div className="init-panel">
        <p className="eyebrow-sm">Parent Asset</p>
        <dl className="kv">
          <dt>Name</dt><dd>{asset?.name ?? '—'}</dd>
          <dt>Serial</dt><dd className="mono">{asset?.serial_number ?? '—'}</dd>
          <dt>RFID tag</dt><dd className="mono">{asset?.rfid_tag ?? '—'}</dd>
          <dt>Model</dt>
          <dd>{asset?.model ? `${asset.model.make} ${asset.model.model}` : '—'}</dd>
          <dt>Category</dt><dd>{asset?.model?.category_label ?? '—'}</dd>
          <dt>Status</dt>
          <dd>{asset ? (chip(asset.status_label, asset.status_color)
            ?? asset.status_label) : '—'}</dd>
          <dt>Client</dt><dd>{asset?.client_name ?? 'House'}</dd>
          <dt>Site</dt><dd>{asset?.site_name ?? '—'}</dd>
          <dt>Location</dt><dd>{asset?.location_detail || '—'}</dd>
          <dt>Last seen</dt>
          <dd>{asset?.last_seen_at
            ? new Date(asset.last_seen_at).toLocaleString() : '—'}</dd>
        </dl>
      </div>

      <div className="init-panel">
        <p className="eyebrow-sm">Move Details</p>
        <div className="detail-grid">
          <div className="detail-block">
            <p className="eyebrow-sm">Placement</p>
            <dl className="kv">
              <dt>Source rack</dt><dd>{row.source_rack ?? '—'}</dd>
              <dt>Source RU</dt><dd>{row.source_ru ?? '—'}</dd>
              <dt>Source position</dt><dd>{row.source_position ?? '—'}</dd>
              <dt>Source verified</dt><dd>{yesNo(row.source_verified)}</dd>
              <dt>Destination rack</dt><dd>{row.destination_rack ?? '—'}</dd>
              <dt>Destination RU</dt><dd>{row.destination_ru ?? '—'}</dd>
              <dt>Destination position</dt><dd>{row.destination_position ?? '—'}</dd>
              <dt>Destination verified</dt><dd>{yesNo(row.destination_verified)}</dd>
            </dl>
          </div>
          <div className="detail-block">
            <p className="eyebrow-sm">Logistics</p>
            <dl className="kv">
              <dt>Wave</dt><dd>{row.priority_wave ?? '—'}</dd>
              <dt>Disposition</dt><dd>{row.disposition ?? '—'}</dd>
              <dt>Owner</dt><dd>{row.owner ?? '—'}</dd>
              <dt>Cable info</dt><dd>{row.cable_info ?? '—'}</dd>
              <dt>Vendor involved</dt><dd>{yesNo(row.vendor_involved)}</dd>
            </dl>
          </div>
          <div className="detail-block">
            <p className="eyebrow-sm">Status</p>
            <dl className="kv">
              <dt>Move status</dt>
              <dd>{chip(row.status_label, row.status_color) ?? row.status_label}</dd>
              <dt>Added</dt><dd>{new Date(row.created_at).toLocaleDateString()}</dd>
              <dt>Updated</dt><dd>{new Date(row.updated_at).toLocaleDateString()}</dd>
            </dl>
          </div>
        </div>
      </div>

      {canViewScans && (
        <div className="init-panel">
          <p className="eyebrow-sm">Scan History</p>
          <ScanHistoryTable assetId={row.asset_id} />
        </div>
      )}

      {editing && (
        <AssetEditDialog
          asset={row}
          moveStatuses={moveStatuses}
          onClose={() => setEditing(false)}
          onSaved={() => load()}
        />
      )}
    </div>
  );
}
```

Resolve the `moveStatuses` fetch by copying exactly what InitiativeDetail.tsx does for its `moveStatuses` state (same fetcher, same gating) — wire it into the mount effect where the comment marks it. If `AssetItem` lacks `status_color`/`status_label` fields shown above, check the real interface (api.ts:1058) and use only real fields — `status_label`/`status_color` DO exist; `chip` handles the rest.

- [ ] **Step 4: Route** (`portal/src/App.tsx`, next to the other initiative routes)

```tsx
            <Route path="/initiatives/:id/assets/:rowId" element={
              <ProtectedRoute resource="initiatives"><MoveAssetDetail /></ProtectedRoute>
            } />
```

with the import added alphabetically.

- [ ] **Step 5: Suites + commit**

`npm test` + `npm run build` clean.

```bash
git add portal/src/components/initiatives/AssetEditDialog.tsx portal/src/pages/MoveAssetDetail.tsx portal/src/pages/InitiativeDetail.tsx portal/src/lib/api.ts portal/src/App.tsx
git commit -m "feat(portal): move asset full-details page"
```

---

### Task 4: Asset Details page

**Files:**
- Create: `portal/src/pages/AssetDetail.tsx`
- Modify: `portal/src/App.tsx` (route)

**Interfaces:**
- Consumes: `getAsset` (Task 3), `ScanHistoryTable` (Task 2), `AssetEditModal` (existing — props per Assets.tsx:460: `asset, statuses, clients, sites, existingSerials, canChange, onClose, onSaved`), `NotesFilesPanel`. Mirror Assets.tsx's lookup loading for the modal (statuses/clients/sites/existingSerials with the same permission gates — read Assets.tsx's mount effect and copy it).
- Produces: route `/assets/:assetId` under `ProtectedRoute resource="assets"`.

- [ ] **Step 1: The page** — create `portal/src/pages/AssetDetail.tsx` following the exact structure of MoveAssetDetail (Task 3) with these differences:

- Params: `const { assetId } = useParams<{ assetId: string }>();`; back link `← Assets` → `/assets`.
- Data: `getAsset(assetId)`; unknown id (fetch throws) → `.dir-empty` "**Asset not found**This asset does not exist or was removed." with the back link.
- Header: title = `asset.name ?? asset.serial_number ?? 'Asset'`; `page-hint` = `make model · status_label` (joined with ' · ', '—' fallback); Edit `.btn-solid` gated `can('assets','change')`.
- Panels, in order (`.init-panel` each):
  1. **Identity** — `dl.kv`: Serial (mono), Name, RFID tag (mono), Model (`make model`), Category (`model.category_label`), RU (`model.ru_size`), Rails present (Unknown/Yes/No — copy AssetRowDetail's ternary, Assets.tsx:491ff).
  2. **Location & status** — Status chip (`chip(status_label, status_color)`), Client (`client_name ?? 'House'`), Site, Location, Last seen (locale string), Created (locale date).
  3. **Notes & files** — `<NotesFilesPanel entityType="asset" entityId={asset.id} canWrite={can('assets','change')} />`.
  4. **Scan History** — gated `can('scans','view')`: `<ScanHistoryTable assetId={asset.id} />`.
- Edit modal block (copy the lookup loading + modal invocation from Assets.tsx, `onSaved` refetches `getAsset`):

```tsx
      {editing && (
        <AssetEditModal
          asset={asset}
          statuses={statuses}
          clients={clients}
          sites={sites}
          existingSerials={existingSerials}
          canChange={canChange}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); void load(); }}
        />
      )}
```

(Check AssetEditModal's `onSaved`/`onClose` contract in Assets.tsx and match it — if `onSaved` already closes, drop the explicit `setEditing(false)`. `existingSerials` comes from `listAssets()` exactly as Assets.tsx derives it; load it lazily when Edit is first clicked if that's cheap to arrange, otherwise on mount like Assets.tsx.)

- [ ] **Step 2: Route** (`App.tsx`, after the `/assets` route)

```tsx
            <Route path="/assets/:assetId" element={
              <ProtectedRoute resource="assets"><AssetDetail /></ProtectedRoute>
            } />
```

- [ ] **Step 3: Suites + commit**

`npm test` + `npm run build` clean.

```bash
git add portal/src/pages/AssetDetail.tsx portal/src/App.tsx
git commit -m "feat(portal): asset full-details page"
```

---

### Task 5: Browser verification (no code unless fixes needed)

Dev servers via launch.json (`api` on 8000 — restart it so the new Settings field loads; portal on 5173). Sign in claude-dev@test.example.com (recipes: `.superpowers/sdd/task-6-report.md`). On an initiative with roster assets:

1. Expand a row → Move Details shows by default (three labeled blocks, real kv pairs); switch to Scan History → aligned table, nowrap timestamps, chips, `—` cells; cap hint only when 15 rows.
2. Full Details → the move page: back link with initiative name, three panels populated, history table at env depth; Edit round-trips (change wave, save, page updates).
3. Parent Asset → the asset page: panels + notes/files + history; Edit round-trips (change location, save, page updates); unknown-id URL shows the not-found state.
4. Set `SS_SCANS_HISTORY_DEFAULT=3` in `.env`, restart the API, reload the move page → 3 history rows; restore to 100 and restart.
5. Rack-cell buttons, Edit/Remove on the roster still don't toggle rows; no new console errors.

Record evidence in `.superpowers/sdd/`; fix-and-commit anything found (small fixes inline with `fix(portal): …`).
