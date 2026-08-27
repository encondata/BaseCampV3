# Scan Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scans carry the asset/move status they asserted ("scanned to be Labeled"), shown as the first column of every scan-history list and as a column on both Admin → Scans tabs.

**Architecture:** Nullable `status` column on both scans tables FK'd into the existing `asset` vocabulary (generated-discriminator pattern, MATCH SIMPLE so NULL skips); denormalized through the existing `_vocab`/`_raw_context` helpers; chip-rendered portal-side. Spec: `docs/superpowers/specs/2026-08-27-scan-status-design.md`.

**Tech Stack:** Alembic/SQLAlchemy async; FastAPI; React 18 + TS.

## Global Constraints

- Vocabulary is the existing `status_values` record_type `asset` — no new vocabulary, no seeded keys.
- `status` is nullable; NULL renders `—` (`status_label`/`status_color` null in payloads).
- Scan-history column order: **Status · Scanned · Method · Device · Operator · Site · Location**.
- Recording/display only — nothing applies the status to assets/rosters.
- No god-edit on scan status; PATCH surface unchanged.
- Suites: API `.venv/bin/python -m pytest -q` from `api/` (FOREGROUND, long timeout — never background a suite and stop); portal `npm test` + `npm run build`. Never commit `api/src/serversherpa/_dev_reload.py` or `.env`. Commits carry the `Co-Authored-By: Claude <noreply@anthropic.com>` trailer.

---

### Task 1: Migration `0026_scan_status.py` + models + registry

**Files:**
- Create: `api/migrations/versions/0026_scan_status.py`
- Modify: `api/src/serversherpa/db/models.py` (RawScan + ProcessedScan)
- Modify: `api/src/serversherpa/status/registry.py` (asset entry's sources)
- Test: `api/tests/test_scans_model.py` (append + registry assertion update), `api/tests/test_status_registry.py` (update asset sources expectation)

**Interfaces:**
- Produces: nullable `raw_scans.status` / `processed_scans.status` FK'd to `status_values('asset', key)`; ORM fields `RawScan.status` / `ProcessedScan.status` (`str | None`).

- [ ] **Step 1: Write the failing tests** (append to `api/tests/test_scans_model.py`)

```python
async def test_scan_status_vocabulary_fk(db):
    ok = RawScan(scanned_value="ST-1", scan_type="rfid", scanned_at=NOW,
                 status="labeled")
    db.add(ok)
    await db.commit()
    assert ok.status == "labeled"

    db.add(RawScan(scanned_value="ST-2", scan_type="rfid", scanned_at=NOW,
                   status="not_a_status"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_scan_status_nullable(db):
    asset = Asset(name="st-null")
    db.add(asset)
    await db.flush()
    p = ProcessedScan(scanned_value="ST-3", scan_type="rfid", scanned_at=NOW,
                      match_type="asset", asset_id=asset.id, processed_at=NOW)
    db.add(p)
    await db.commit()
    assert p.status is None
```

Also update `test_scans_registry_shape` in the same file: the STATUS_REGISTRY assertion for `asset` sources (if asserted here — it is asserted in `api/tests/test_status_registry.py`; update whichever file pins it) must now expect `(("assets", "status"), ("initiative_assets", "status"), ("raw_scans", "status"), ("processed_scans", "status"))` — match the existing tuple order with the two new pairs appended.

- [ ] **Step 2: Run to verify failure**

`.venv/bin/python -m pytest tests/test_scans_model.py -x -q` → FAIL (`status` is an invalid keyword argument for RawScan).

- [ ] **Step 3: Migration** — create `api/migrations/versions/0026_scan_status.py`:

```python
"""scan status — what status the asset was scanned to be. Nullable
`status` on raw_scans and processed_scans, FK'd into the EXISTING
'asset' vocabulary (one vocabulary across scan → matcher → roster;
several keys are literally scan checkpoints, e.g. rfid_2_loading_dock).
MATCH SIMPLE composite FK: NULL status (bare presence read) skips the
check. Recording only — applying the status stays with the deferred
matcher.

Revision ID: 0026
Revises: 0025
Create Date: 2026-08-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0026"
down_revision: str | None = "0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("raw_scans", sa.Column(
        "status", sa.Text,
        comment="asset/move status this scan asserted; NULL = presence read"))
    op.execute("""
        ALTER TABLE raw_scans ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('asset') STORED
    """)
    op.create_foreign_key(
        "raw_scans_status_fkey", "raw_scans", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])

    op.add_column("processed_scans", sa.Column(
        "status", sa.Text,
        comment="asset/move status this scan asserted; NULL = presence read"))
    op.execute("""
        ALTER TABLE processed_scans ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('asset') STORED
    """)
    op.create_foreign_key(
        "processed_scans_status_fkey", "processed_scans", "status_values",
        ["status_record_type", "status"], ["record_type", "key"])


def downgrade() -> None:
    op.drop_constraint("processed_scans_status_fkey", "processed_scans",
                       type_="foreignkey")
    op.drop_column("processed_scans", "status_record_type")
    op.drop_column("processed_scans", "status")
    op.drop_constraint("raw_scans_status_fkey", "raw_scans",
                       type_="foreignkey")
    op.drop_column("raw_scans", "status_record_type")
    op.drop_column("raw_scans", "status")
```

- [ ] **Step 4: Models** — in `api/src/serversherpa/db/models.py`, add to BOTH `RawScan` and `ProcessedScan` (after their `scan_type_record_type` field):

```python
    status: Mapped[str | None]
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'asset'"))  # GENERATED column; never written
```

- [ ] **Step 5: Registry** — in `api/src/serversherpa/status/registry.py`, the `asset` StatusRecordType's `sources` gains `("raw_scans", "status"), ("processed_scans", "status")` appended after the existing pairs. Update `api/tests/test_status_registry.py`'s expectation accordingly.

- [ ] **Step 6: Migrate + test**

```
.venv/bin/alembic upgrade head
.venv/bin/alembic downgrade 0025 && .venv/bin/alembic upgrade head
.venv/bin/python -m pytest tests/test_scans_model.py tests/test_status_registry.py -q
```
All pass, downgrade clean. Then the full suite once (FOREGROUND, long timeout).

- [ ] **Step 7: Commit**

```bash
git add api/migrations/versions/0026_scan_status.py api/src/serversherpa/db/models.py api/src/serversherpa/status/registry.py api/tests/test_scans_model.py api/tests/test_status_registry.py
git commit -m "feat(api): scans record the asserted asset status"
```

---

### Task 2: API — denormalize status through all three endpoints + raw filter

**Files:**
- Modify: `api/src/serversherpa/api/routes/scans.py`
- Modify: `api/src/serversherpa/api/schemas.py`
- Test: `api/tests/test_scans_api.py` (append + touch)

**Interfaces:**
- Consumes: Task 1's columns.
- Produces: `RawScanItem`/`ProcessedScanItem`/`AssetScanItem` each gain `status: str | None`, `status_label: str | None`, `status_color: str | None` (all None when status NULL); `GET /scans/raw` gains optional `status: str | None` scalar filter. Task 3's TS interfaces mirror the three fields.

- [ ] **Step 1: Failing tests** (append to `api/tests/test_scans_api.py`)

```python
async def test_scan_status_denormalized(client, db, seeded_user):
    hdrs = await login(client)
    asset = Asset(name="st-denorm")
    db.add(asset)
    await db.flush()
    db.add(RawScan(scanned_value="ST-R", scan_type="rfid", scanned_at=T0,
                   status="labeled"))
    db.add(RawScan(scanned_value="ST-R2", scan_type="rfid",
                   scanned_at=T0 + timedelta(minutes=1)))
    p = ProcessedScan(scanned_value="ST-P", scan_type="rfid", scanned_at=T0,
                      match_type="asset", asset_id=asset.id, processed_at=T0,
                      status="labeled")
    db.add(p)
    await db.commit()

    rows = (await client.get("/scans/raw", headers=hdrs)).json()
    by_val = {r["scanned_value"]: r for r in rows}
    assert by_val["ST-R"]["status"] == "labeled"
    assert by_val["ST-R"]["status_label"] == "Labeled"
    assert by_val["ST-R"]["status_color"]
    assert by_val["ST-R2"]["status"] is None
    assert by_val["ST-R2"]["status_label"] is None

    row = (await client.get("/scans/processed", headers=hdrs)).json()[0]
    assert row["status_label"] == "Labeled"

    hist = (await client.get(f"/scans/asset/{asset.id}", headers=hdrs)).json()
    assert hist[0]["status_label"] == "Labeled"

    # raw status filter
    resp = await client.get("/scans/raw", headers=hdrs,
                            params={"status": "labeled"})
    assert [r["scanned_value"] for r in resp.json()] == ["ST-R"]
```

(The `"Labeled"` label comes from the seeded `asset` vocabulary — migration 0014/0022 seeds; if the dev vocabulary spells it differently, assert against a `StatusValue` row fetched in-test instead of the literal.)

- [ ] **Step 2: Verify failure** — `.venv/bin/python -m pytest tests/test_scans_api.py -x -q` → FAIL (`status` not in payload).

- [ ] **Step 3: Schemas** — add to `RawScanItem`, `ProcessedScanItem`, and `AssetScanItem` (each, after their `scan_type_color` field):

```python
    status: str | None = None
    status_label: str | None = None
    status_color: str | None = None
```

- [ ] **Step 4: Router** — in `api/src/serversherpa/api/routes/scans.py`:

`_vocab` grows a third map (single query still):

```python
async def _vocab(db: DbSession) -> tuple[dict, dict, dict]:
    rows = (await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(("scan", "processed_scan", "asset"))))).all()
    scan_types = {s.key: (s.label, s.color)
                  for s in rows if s.record_type == "scan"}
    match_types = {s.key: (s.label, s.color)
                   for s in rows if s.record_type == "processed_scan"}
    asset_statuses = {s.key: (s.label, s.color)
                      for s in rows if s.record_type == "asset"}
    return scan_types, match_types, asset_statuses
```

`_raw_context` gains the statuses map and the three fields:

```python
def _raw_context(s: RawScan | ProcessedScan, scan_types: dict,
                 asset_statuses: dict, people: dict, sites: dict) -> dict:
    st_label, st_color = scan_types.get(
        s.scan_type, (s.scan_type, FALLBACK_COLOR))
    if s.status is not None:
        a_label, a_color = asset_statuses.get(
            s.status, (s.status, FALLBACK_COLOR))
    else:
        a_label = a_color = None
    return {
        "scanned_value": s.scanned_value,
        "scan_type": s.scan_type,
        "scan_type_label": st_label, "scan_type_color": st_color,
        "status": s.status,
        "status_label": a_label, "status_color": a_color,
        "scanned_at": s.scanned_at, "device_id": s.device_id,
        "operator_id": s.operator_id,
        "operator_name": people.get(s.operator_id),
        "site_id": s.site_id, "site_name": sites.get(s.site_id),
        "location_detail": s.location_detail, "source": s.source,
    }
```

Update ALL FOUR call sites together (`list_raw_scans`, `list_processed_scans`, `list_asset_scans`, `_processed_item`): unpack three from `_vocab` (`scan_types, match_types, asset_statuses = await _vocab(db)` — use `_` for unused maps) and pass `asset_statuses` into `_raw_context`.

`list_raw_scans` gains the filter param `status: str | None = None` (next to `scan_type`) and, with the other conditionals:

```python
    if status is not None:
        query = query.where(RawScan.status == status)
```

- [ ] **Step 5: Run** — `.venv/bin/python -m pytest tests/test_scans_api.py -q` (all pass), then the full suite once (FOREGROUND, long timeout).

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/api/routes/scans.py api/src/serversherpa/api/schemas.py api/tests/test_scans_api.py
git commit -m "feat(api): denormalize scan status in scan payloads + raw filter"
```

---

### Task 3: Portal — status first in history, columns on both tabs, seed refresh, verify

**Files:**
- Modify: `portal/src/lib/api.ts` (three interfaces)
- Modify: `portal/src/components/scans/ScanHistoryTable.tsx`
- Modify: `portal/src/components/scans/RawScansTab.tsx`, `ProcessedScansTab.tsx`
- Modify: `portal/src/lib/scans.ts` + `portal/src/lib/scans.test.ts`

**Interfaces:**
- Consumes: Task 2's payload fields (`status`/`status_label`/`status_color`, all `| null` in TS).

- [ ] **Step 1: Failing lib tests** — in `portal/src/lib/scans.test.ts`: add `status: 'labeled', status_label: 'Labeled', status_color: '#178a4c'` to the existing `ProcessedScanRow` fixture (and the `RawScanRow` fixture likewise) — TS forces this once the interfaces change; then add assertions:

```typescript
    expect(processedScanCellText(row, 'status')).toBe('Labeled');
    expect(processedScanCellText({ ...row, status_label: null }, 'status')).toBe('—');
    expect(rawScanCellText(rawRow, 'status')).toBe('Labeled');
    expect(rawScanCellText({ ...rawRow, status_label: null }, 'status')).toBe('—');
    expect(processedScanSearchText(row)).toContain('labeled');
    expect(rawScanSearchText(rawRow)).toContain('labeled');
```

(The colKey `'status'` is free on both tabs — neither COLUMNS list uses it today; verify with a grep before assuming.)

- [ ] **Step 2: Interfaces** (`portal/src/lib/api.ts`) — add to `RawScanRow`, `ProcessedScanRow`, `AssetScanRow`, each after `scan_type_color`:

```typescript
  status: string | null; status_label: string | null; status_color: string | null;
```

- [ ] **Step 3: lib/scans.ts** — `rawScanCellText` and `processedScanCellText` gain `case 'status': return s.status_label ?? '—';` and both search-text builders add `s.status_label` to their field arrays.

- [ ] **Step 4: ScanHistoryTable** — Status becomes the FIRST column:
  - `<th>Status</th>` before `<th>Scanned</th>`;
  - first `<td>`: the house chip when present, `—` when null:

```tsx
              <td>
                {s.status_label && s.status_color ? (
                  <span className="chip custom"
                        style={{ '--chip': s.status_color } as CSSProperties}>
                    <span className="dot" />{s.status_label}
                  </span>
                ) : '—'}
              </td>
```

- [ ] **Step 5: Admin tabs** —
  - `RawScansTab.tsx`: insert `{ key: 'status', label: 'Scan status', width: '1.1fr', default: true }` as the FIRST entry of `COLUMNS`; `sortValueFor` gains `case 'status': return (r.status_label ?? '').toLowerCase();`; `cellFor` gains a `status` case rendering the same chip-or-`—` as Step 4; CSV columns gain `['Scan status', (r) => r.status_label ?? '']` after Value.
  - `ProcessedScansTab.tsx`: same column object inserted after the `match` entry; same sortValueFor/cellFor/CSV additions.

- [ ] **Step 6: Suites** — `npm test` + `npm run build` clean.

- [ ] **Step 7: Seed refresh** — against the dev DB (`docker compose -f docker-compose.dev.yml exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'`):

```sql
-- ~80% of scans get a weighted checkpoint-ish status; ~20% stay NULL.
WITH keys AS (
  SELECT ARRAY['labeled','loaded_in_system','pre_stage','pack_logistics',
               'rfid_1_cage_exit','rfid_2_loading_dock','rfid_3_staging',
               'rfid_4_into_cage','rfid_10_dock_to_truck','on_truck',
               'received','racked','staged','qa','complete'] AS a
)
UPDATE raw_scans r SET status = k.a[1 + (r.id % cardinality(k.a))::int]
FROM keys k WHERE r.id % 5 <> 0;

WITH keys AS (
  SELECT ARRAY['labeled','loaded_in_system','rfid_2_loading_dock','on_truck',
               'received','racked','re_racked','staged','qa','complete'] AS a
)
UPDATE processed_scans p
SET status = k.a[1 + (abs(hashtext(p.id::text)) % cardinality(k.a))::int]
FROM keys k WHERE abs(hashtext(p.id::text)) % 5 <> 0;

SELECT count(*) FILTER (WHERE status IS NULL) AS null_raw,
       count(*) FILTER (WHERE status IS NOT NULL) AS with_status
FROM raw_scans;
```

(Verify each key exists first: `SELECT key FROM status_values WHERE record_type='asset'` — drop any array entry not present.)

- [ ] **Step 8: Browser verify** — portal 5173, api 8000 (RESTART the API so migration-fresh models serve; login claude-dev@test.example.com per .superpowers/sdd/task-6-report.md): scan-history surfaces (roster tab, move page, asset page) show Status chips first with some `—` rows; Admin → Scans Raw tab has "Scan status" as first data column with working column-menu filter; Processed tab likewise; CSV export includes it; no console errors.

- [ ] **Step 9: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/scans.ts portal/src/lib/scans.test.ts portal/src/components/scans/ScanHistoryTable.tsx portal/src/components/scans/RawScansTab.tsx portal/src/components/scans/ProcessedScansTab.tsx
git commit -m "feat(portal): scan status column across history + admin tabs"
```
