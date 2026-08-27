# Asset Scan History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expandable asset-roster rows on `/initiatives/:id` showing the asset's processed-scan history (newest first, latest 15), backed by `GET /scans/asset/{asset_id}`.

**Architecture:** One read endpoint reusing routes/scans.py's existing vocab/name helpers; roster rows gain the house `.detail` expansion (already virtualization-safe via `VirtualRows` measurement) with a lazy-fetch `AssetScanHistory` component. Spec: `docs/superpowers/specs/2026-08-27-asset-scan-history-design.md`.

**Tech Stack:** FastAPI + SQLAlchemy async; React 18 + TS.

## Global Constraints

- History source: `processed_scans` with matching `asset_id` only — no raw-scan value matching.
- Strictly latest 15 by default (`limit: int = Query(15, ge=1, le=100)`), ordered `scanned_at desc, id`; no pagination UI.
- Expansion shows only scan history; gated on `can('scans', 'view')` — without it: no chevron, rows don't toggle, no fetch.
- Unknown asset id returns `[]` (no 404).
- Batch lookups, never per-row queries. Never commit `api/src/serversherpa/_dev_reload.py`.
- Suites: API `.venv/bin/python -m pytest -q` from `api/` (foreground, long timeout); portal `npm test` + `npm run build`. Commits carry the `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.

---

### Task 1: API — `GET /scans/asset/{asset_id}`

**Files:**
- Modify: `api/src/serversherpa/api/routes/scans.py` (insert the endpoint above `update_processed_scan`)
- Modify: `api/src/serversherpa/api/schemas.py` (append `AssetScanItem` after `ProcessedScanPatch`)
- Test: `api/tests/test_scans_api.py` (append)

**Interfaces:**
- Consumes: existing module helpers `_vocab`, `_people_names`, `_site_names`, `_raw_context`; models `ProcessedScan`; test helpers `login`/`make_login`, module constant `T0`.
- Produces: `GET /scans/asset/{asset_id}?limit=` → `list[AssetScanItem]` with fields exactly: `id: uuid`, `scanned_value: str`, `scan_type: str`, `scan_type_label: str`, `scan_type_color: str`, `scanned_at: datetime`, `processed_at: datetime`, `device_id: str`, `operator_id: uuid|None`, `operator_name: str|None`, `site_id: uuid|None`, `site_name: str|None`, `location_detail: str`, `source: str`. Task 2's `AssetScanRow` TS interface mirrors this field-for-field.

- [ ] **Step 1: Write the failing tests** (append to `api/tests/test_scans_api.py`)

```python
async def test_asset_scan_history(client, db, seeded_user):
    hdrs = await login(client)
    target = Asset(name="hist-target")
    other = Asset(name="hist-other")
    box = Container(name="hist-crate")
    db.add_all([target, other, box])
    await db.flush()

    def _scan(minutes, **kw):
        ts = T0 + timedelta(minutes=minutes)
        return ProcessedScan(
            scanned_value=f"EPC-H-{minutes:03d}", scan_type="rfid",
            scanned_at=ts, processed_at=ts, **kw)

    # 20 scans for the target (exceeds the 15 cap), plus noise rows that
    # must be excluded: another asset, and a container match.
    db.add_all([_scan(i, match_type="asset", asset_id=target.id)
                for i in range(20)])
    db.add(_scan(99, match_type="asset", asset_id=other.id))
    db.add(_scan(98, match_type="container", container_id=box.id))
    await db.commit()

    resp = await client.get(f"/scans/asset/{target.id}", headers=hdrs)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert len(rows) == 15                       # default cap
    values = [r["scanned_value"] for r in rows]  # newest first: 19..5
    assert values[0] == "EPC-H-019"
    assert values[-1] == "EPC-H-005"
    assert "EPC-H-099" not in values             # other asset excluded
    assert rows[0]["scan_type_label"] == "RFID"

    resp = await client.get(f"/scans/asset/{target.id}?limit=3", headers=hdrs)
    assert [r["scanned_value"] for r in resp.json()] == [
        "EPC-H-019", "EPC-H-018", "EPC-H-017"]

    # unknown asset id -> empty list, not 404
    resp = await client.get(
        "/scans/asset/00000000-0000-0000-0000-000000000000", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json() == []


async def test_asset_scan_history_gate(client, db, seeded_user):
    w = Person(first_name="Wk", last_name="NoHist")
    asset = Asset(name="hist-gate")
    db.add_all([w, asset])
    await db.flush()
    db.add(PersonRole(person_id=w.id, role="worker"))
    await db.commit()
    hdrs = await make_login(db, client, w, "wk-nohist@test.example.com")
    resp = await client.get(f"/scans/asset/{asset.id}", headers=hdrs)
    assert resp.status_code == 403
```

(`timedelta` is already imported at the top of the file; `Asset`, `Container`, `Person`, `PersonRole`, `ProcessedScan` too — verify and extend the import if any is missing.)

- [ ] **Step 2: Run to verify failure**

Run (from `api/`): `.venv/bin/python -m pytest tests/test_scans_api.py -x -q`
Expected: the new tests FAIL with 404 (route missing).

- [ ] **Step 3: Add the schema** (append to `api/src/serversherpa/api/schemas.py` after `ProcessedScanPatch`)

```python
class AssetScanItem(BaseModel):
    """One processed scan of a given asset — the per-asset history row
    (initiative roster expansion). Match fields omitted: they are the
    asset by construction."""

    id: uuid.UUID
    scanned_value: str
    scan_type: str
    scan_type_label: str
    scan_type_color: str
    scanned_at: datetime
    processed_at: datetime
    device_id: str
    operator_id: uuid.UUID | None = None
    operator_name: str | None = None
    site_id: uuid.UUID | None = None
    site_name: str | None = None
    location_detail: str
    source: str
```

- [ ] **Step 4: Add the endpoint** (in `api/src/serversherpa/api/routes/scans.py`, directly above `_processed_item`; add `AssetScanItem` to the schemas import)

```python
@router.get("/asset/{asset_id}", response_model=list[AssetScanItem])
async def list_asset_scans(
    asset_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("scans", "view"),
    limit: int = Query(15, ge=1, le=100),
) -> list[AssetScanItem]:
    """Per-asset scan history, newest first. Only matched (processed)
    scans carry an asset linkage; an unknown or never-scanned asset is
    an empty history, not an error."""
    scans = list(await db.scalars(
        select(ProcessedScan).where(ProcessedScan.asset_id == asset_id)
        .order_by(ProcessedScan.scanned_at.desc(), ProcessedScan.id)
        .limit(limit)))
    scan_types, _ = await _vocab(db)
    people = await _people_names(db, {s.operator_id for s in scans})
    sites = await _site_names(db, {s.site_id for s in scans})
    return [AssetScanItem(id=s.id, processed_at=s.processed_at,
                          **_raw_context(s, scan_types, people, sites))
            for s in scans]
```

- [ ] **Step 5: Run the tests**

Run: `.venv/bin/python -m pytest tests/test_scans_api.py -q` → all pass (12 tests). Then the full suite once: `.venv/bin/python -m pytest -q` (foreground, long timeout) → all pass.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/api/routes/scans.py api/src/serversherpa/api/schemas.py api/tests/test_scans_api.py
git commit -m "feat(api): per-asset scan history endpoint"
```

---

### Task 2: Portal — roster expansion + `AssetScanHistory` + seed + verify

**Files:**
- Modify: `portal/src/lib/api.ts` (append to the scans section)
- Create: `portal/src/components/initiatives/AssetScanHistory.tsx`
- Modify: `portal/src/pages/InitiativeDetail.tsx` (assets list only)

**Interfaces:**
- Consumes: Task 1's endpoint; `chip` helper already in InitiativeDetail.tsx; the assets list structures at `InitiativeDetail.tsx` (`assetsGrid` ~line 530, `list-head` ~744, `VirtualRows` row ~772).
- Produces: `AssetScanRow` + `listAssetScans(assetId: string, limit = 15): Promise<AssetScanRow[]>` in api.ts; `<AssetScanHistory assetId={string} />`.

- [ ] **Step 1: api.ts** (append after `updateProcessedScan`)

```typescript
export interface AssetScanRow {
  id: string; scanned_value: string;
  scan_type: string; scan_type_label: string; scan_type_color: string;
  scanned_at: string; processed_at: string;
  device_id: string;
  operator_id: string | null; operator_name: string | null;
  site_id: string | null; site_name: string | null;
  location_detail: string; source: string;
}

export async function listAssetScans(
  assetId: string, limit = 15,
): Promise<AssetScanRow[]> {
  const resp = await apiFetch(`/scans/asset/${assetId}?limit=${limit}`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

- [ ] **Step 2: AssetScanHistory component**

Create `portal/src/components/initiatives/AssetScanHistory.tsx`:

```tsx
/**
 * AssetScanHistory — the initiative roster row expansion: the asset's
 * processed-scan history, newest first, latest 15. Lazy: mounts only
 * when the row opens, fetches once. Read-only by design.
 */
import { useEffect, useState, type CSSProperties } from 'react';

import { listAssetScans, type AssetScanRow } from '../../lib/api';

const CAP = 15;

export default function AssetScanHistory({ assetId }: { assetId: string }) {
  const [scans, setScans] = useState<AssetScanRow[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    setScans(null);
    setError(false);
    void listAssetScans(assetId)
      .then(setScans)
      .catch(() => setError(true));
  }, [assetId]);

  return (
    <div className="detail-grid">
      <div className="detail-block" style={{ gridColumn: '1 / -1' }}>
        <p className="eyebrow-sm">Scan history</p>
        {error && <p className="page-hint">Could not load scan history.</p>}
        {!error && scans === null && <p className="page-hint">Loading…</p>}
        {scans?.length === 0 && (
          <p className="page-hint">No scans recorded for this asset.</p>
        )}
        {scans && scans.length > 0 && (
          <>
            <dl className="kv">
              {scans.map((s) => (
                <span key={s.id} style={{ display: 'contents' }}>
                  <dt className="mono">
                    {new Date(s.scanned_at).toLocaleString()}
                  </dt>
                  <dd>
                    <span className="chip custom"
                          style={{ '--chip': s.scan_type_color } as CSSProperties}>
                      <span className="dot" />{s.scan_type_label}
                    </span>
                    {' '}
                    <span className="mono">{s.device_id || '—'}</span>
                    {' · '}{s.operator_name ?? '—'}
                    {' · '}
                    {[s.site_name, s.location_detail].filter(Boolean).join(' · ') || '—'}
                  </dd>
                </span>
              ))}
            </dl>
            {scans.length === CAP && (
              <p className="page-hint">Latest {CAP} scans shown.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
```

(`display: contents` on the `<span>` keying each dt/dd pair is the existing house idiom — see ContainerRowDetail's contents list in `pages/Containers.tsx` — and is fine here: `.kv` is the grid, and `:last-child`-style selectors aren't used inside `.kv`.)

- [ ] **Step 3: Wire the expansion into InitiativeDetail.tsx (assets list only)**

All edits are within the assets panel:

1. Imports: `AssetScanHistory` from `../components/initiatives/AssetScanHistory`.
2. Near the other assets state (~line 251): `const [openAssetId, setOpenAssetId] = useState<string | null>(null);` and `const canViewScans = can('scans', 'view');` (the `can` destructure already exists).
3. Grid (~line 530): append a chevron column when gated on:

```tsx
const assetsGrid = { gridTemplateColumns:
  `${assetsShownCols.map((c) => c.width).join(' ')}${canChange ? ' 132px' : ''}${canViewScans ? ' 30px' : ''}` };
```

4. List head (~line 762): after `{canChange && <span className="col-head" />}` add `{canViewScans && <span className="col-head" />}`.
5. The `VirtualRows` row (~lines 772-798) becomes (structure copied from the house pattern in `ProcessedScansTab.tsx`; note `stopPropagation` on the two action buttons and the chevron + detail additions):

```tsx
<VirtualRows rows={visibleAssets}
  renderRow={(a, vp) => {
    const open = openAssetId === a.id;
    return (
      <div key={a.id} className={`dir-row ${open ? 'open' : ''}`} {...vp} style={vp?.style}>
        <div className="row-main" style={assetsGrid}
             onClick={canViewScans
               ? () => setOpenAssetId(open ? null : a.id)
               : undefined}>
          {assetsShownCols.map((c) => (
            <div className={`cell${ASSET_CENTERED_COLS.has(c.key)
              ? ' idet-col-center' : ''}`}
                 key={c.key}>{assetCellFor(a, c.key)}</div>
          ))}
          {canChange && (
            <div className="cell idet-assets-actions">
              <button type="button" className="mini-btn sm"
                      disabled={assetsBusy}
                      onClick={(e) => { e.stopPropagation(); setEditingAsset(a); }}>
                Edit
              </button>
              <button type="button" className="mini-btn sm danger"
                      disabled={assetsBusy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void runAssets(() => removeInitiativeAsset(a.id));
                      }}>
                Remove
              </button>
            </div>
          )}
          {canViewScans && (
            <div className="cell chevron-cell">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
            </div>
          )}
        </div>
        <div className="detail">
          <div className="detail-clip">
            <div className="detail-inner">
              {open && <AssetScanHistory assetId={a.asset_id} />}
            </div>
          </div>
        </div>
      </div>
    );
  }} />
```

(Note `AssetScanHistory` gets `a.asset_id` — the asset, not the roster-row id; `openAssetId` tracks `a.id`, the roster-row id.)

- [ ] **Step 4: Suites**

From `portal/`: `npm test` (514 expected) and `npm run build` — clean.

- [ ] **Step 5: Seed asset-matched processed scans**

Run against the dev DB (`docker compose -f docker-compose.dev.yml exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`):

```sql
-- Scan history for roster assets: 0–25 scans per asset (deterministic per
-- asset via hashtext), scanned over the last 45 days, value = the asset's
-- own tag/serial when present.
WITH roster AS (SELECT DISTINCT asset_id FROM initiative_assets),
     ops AS (SELECT array_agg(id) x FROM people WHERE archived_at IS NULL),
     sts AS (SELECT array_agg(id) x FROM sites WHERE archived_at IS NULL)
INSERT INTO processed_scans (scanned_value, scan_type, scanned_at, match_type,
  asset_id, processed_at, device_id, operator_id, site_id, location_detail, source)
SELECT
  coalesce(a.rfid_tag, a.serial_number, 'EPC-AST-' || substr(a.id::text, 1, 8)),
  CASE WHEN g.n % 5 = 0 THEN 'barcode' ELSE 'rfid' END,
  g.ts, 'asset', r.asset_id, g.ts + interval '30 minutes',
  (ARRAY['dock-reader-1','dock-reader-2','handheld-3','handheld-5','kiosk-1'])[1 + g.n % 5],
  CASE WHEN g.n % 3 = 0 THEN NULL
       ELSE ops.x[1 + floor(random() * cardinality(ops.x))::int] END,
  sts.x[1 + floor(random() * cardinality(sts.x))::int],
  (ARRAY['Dock 1','Row 12','Cage B','Staging',''])[1 + g.n % 5],
  'reader'
FROM roster r
JOIN assets a ON a.id = r.asset_id
CROSS JOIN ops CROSS JOIN sts
CROSS JOIN LATERAL (
  SELECT n, now() - (random() * interval '45 days') AS ts
  FROM generate_series(1, abs(hashtext(r.asset_id::text)) % 26) AS n
) g;

SELECT count(*) FILTER (WHERE match_type = 'asset') AS asset_scans,
       count(DISTINCT asset_id) AS assets_with_history
FROM processed_scans;
```

If `initiative_assets` is empty in dev, say so in the report and seed a handful of roster rows onto an existing initiative first (assets from the `assets` table, `status` left default) — check with `SELECT count(*) FROM initiative_assets;`.

- [ ] **Step 6: Browser verification**

Dev servers via launch.json (`api`; portal likely already on 5173 — open the URL directly). Sign in (claude-dev@test.example.com; recipes in `.superpowers/sdd/task-6-report.md`). On an initiative with roster assets:
- Expand an asset with >15 scans: entries newest→oldest, exactly 15, "Latest 15 scans shown." hint, chips colored, site · location joined.
- Expand an asset with no scans: empty-state copy.
- Edit and Remove buttons still work and do NOT toggle the row.
- Row expansion works mid-list (VirtualRows measurement) if the roster is large; fine to note plain-branch if the roster is small.
- Column menus / sort / god-edit on the roster unaffected; no new console errors.

- [ ] **Step 7: Commit**

```bash
git add portal/src/lib/api.ts portal/src/components/initiatives/AssetScanHistory.tsx portal/src/pages/InitiativeDetail.tsx
git commit -m "feat(portal): expandable roster rows with asset scan history"
```
