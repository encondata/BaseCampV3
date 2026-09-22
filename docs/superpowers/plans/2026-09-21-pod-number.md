# Pod # Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the pod an asset sits in (`assets.pod_number`) and the pod it leaves from and lands in on a move (`initiative_assets.source_pod`, `initiative_assets.destination_pod`), imported from the From-To sheet and shown as optional columns in the portal.

**Architecture:** Three nullable text columns added by migration 0069. The API mirrors the existing `owner` (roster) and `rfid_tag` (asset) plumbing: schema field, route field list, nullable-text coercion, row builder. The From-To importer reads new header aliases and writes the roster pair, and copies the source pod onto the asset. The portal adds the columns to its column-picker lists, cell-text accessors, edit forms and detail pages.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 async, Alembic, pytest (asyncio auto). React 18, TypeScript, Vite, Vitest with jsdom.

Spec: `docs/superpowers/specs/2026-09-21-pod-number-design.md`.

## Global Constraints

- Work in the git worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/pod-number`, branch `pod-number`. Run every command from that directory. Never `cd` to the primary checkout.
- `api/.venv` and `portal/node_modules` in the worktree are symlinks to the primary checkout. Never `npm install` or `pip install` in the worktree. Never commit `api/src/serversherpa/_dev_reload.py`.
- API tests: always `SS_TEST_DB=serversherpa_test_podnumber PYTHONPATH=api/src api/.venv/bin/python -m pytest <files> -q`. The `SS_TEST_DB` value gives this branch its own test database (created on first run and migrated to this branch's head). `PYTHONPATH=api/src` is required or the venv's editable install imports the primary checkout's code. Run one pytest process at a time. Run targeted files per task; the full API suite (about 20 minutes) runs once, in Task 7.
- Portal tests: always the whole suite plus the type check, both from the worktree root: `npm --prefix portal run test` (about 20 seconds) and `(cd portal && node_modules/.bin/tsc --noEmit)`.
- Migration number: `0069`, `down_revision = "0068"`. Confirmed free across every worktree and the dev database.
- Columns: `assets.pod_number`, `initiative_assets.source_pod`, `initiative_assets.destination_pod`. All nullable text, no check constraint, no backfill.
- Import aliases (lower-case keys of `HEADER_MAP`): `source pod`, `source pod #`, `source pod number` → `source_pod`; `destination pod`, `destination pod #`, `destination pod number` → `destination_pod`; `pod`, `pod #`, `pod number` → `source_pod`.
- Template header order: `Source Pod` immediately before `Source Rack`; `Destination Pod` immediately before `Destination Rack`.
- Importer asset rule: a new asset gets `pod_number = source_pod`; an existing asset gets `pod_number` overwritten when the row's `source_pod` is present; a blank `source_pod` never clears an existing `pod_number`; `destination_pod` is never written to the asset.
- Portal labels: `Pod #` (assets list, asset form, asset detail, roster column `pod_number`), `Source Pod` / `Destination Pod` (roster columns). Roster column keys: `source_pod`, `destination_pod`, `pod_number`. Assets list column key: `pod`. Every new column is `default: false`. Blank cells show `—`.
- American English in all copy, comments and docs. Commit after every task with the attribution line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Ledger: append one line per task to `.superpowers/sdd/progress.md` in the worktree (create it if absent).

---

### Task 1: Migration 0069, model columns, asset API field

**Files:**
- Create: `api/migrations/versions/0069_pod_number.py`
- Modify: `api/src/serversherpa/db/models.py:604` (Asset, after `rfid_tag`) and `:1107` (InitiativeAsset, after `owner`)
- Modify: `api/src/serversherpa/api/schemas.py:1197,1218,1231` (`AssetItem`, `AssetCreateIn`, `AssetUpdateIn`)
- Modify: `api/src/serversherpa/api/routes/assets.py:26-29` (`ASSET_FIELDS`) and `:81` (`_item`)
- Test: `api/tests/test_assets_write.py`

**Interfaces:**
- Produces: `Asset.pod_number: str | None`, `InitiativeAsset.source_pod: str | None`, `InitiativeAsset.destination_pod: str | None`; `AssetItem.pod_number`, `AssetCreateIn.pod_number`, `AssetUpdateIn.pod_number` (all `str | None = None`).

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_assets_write.py`:

```python
async def test_pod_number_create_patch_and_clear(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/assets", headers=hdrs, json={
        "serial_number": "SN-POD", "name": "pod-01", "pod_number": "14"})
    assert resp.status_code == 201, resp.text
    assert resp.json()["pod_number"] == "14"
    asset_id = resp.json()["id"]

    resp = await client.patch(f"/assets/{asset_id}", headers=hdrs,
                              json={"pod_number": "P-07"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["pod_number"] == "P-07"
    upd = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset", AuditLog.action == "update"))
    assert upd.changes["pod_number"] == {"from": "14", "to": "P-07"}

    resp = await client.patch(f"/assets/{asset_id}", headers=hdrs,
                              json={"pod_number": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["pod_number"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SS_TEST_DB=serversherpa_test_podnumber PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_assets_write.py -q -k pod_number`
Expected: FAIL (422 from `extra="forbid"` on `AssetCreateIn`).

- [ ] **Step 3: Write the migration**

Create `api/migrations/versions/0069_pod_number.py`:

```python
"""Pod numbers on assets and move rosters.

A pod is the group of racks a device sits in (Nap 14 numbers its pods,
Nap 9 does not). `assets.pod_number` is where the asset is today;
`initiative_assets.source_pod` / `destination_pod` are where it leaves
from and lands on one move, so a move between Naps records both.

Free text, no format check, no backfill.

Revision ID: 0069
Revises: 0068
Create Date: 2026-09-21
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0069"
down_revision: str | None = "0068"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("assets", sa.Column("pod_number", sa.Text(), nullable=True))
    op.add_column("initiative_assets",
                  sa.Column("source_pod", sa.Text(), nullable=True))
    op.add_column("initiative_assets",
                  sa.Column("destination_pod", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("initiative_assets", "destination_pod")
    op.drop_column("initiative_assets", "source_pod")
    op.drop_column("assets", "pod_number")
```

- [ ] **Step 4: Add the ORM columns**

In `api/src/serversherpa/db/models.py`, class `Asset`, after the `rfid_tag` line:

```python
    pod_number: Mapped[str | None]
```

Class `InitiativeAsset`, after the `owner` line:

```python
    source_pod: Mapped[str | None]
    destination_pod: Mapped[str | None]
```

- [ ] **Step 5: Add the schema and route fields**

In `api/src/serversherpa/api/schemas.py`, add `pod_number: str | None = None` after the `rfid_tag` line in each of `AssetItem`, `AssetCreateIn`, `AssetUpdateIn`.

In `api/src/serversherpa/api/routes/assets.py`:

```python
ASSET_FIELDS = [
    "serial_number", "name", "rfid_tag", "pod_number", "model_id",
    "client_id", "site_id", "location_detail", "status", "has_rails",
]
```

and in `_item()` change the `rfid_tag` line to:

```python
        "rfid_tag": a.rfid_tag, "pod_number": a.pod_number,
        "model_id": a.model_id,
```

- [ ] **Step 6: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_podnumber PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_assets_write.py api/tests/test_assets_api.py -q`
Expected: all PASS (the first run creates and migrates the branch test database).

- [ ] **Step 7: Commit**

```bash
git add api/migrations/versions/0069_pod_number.py api/src/serversherpa/db/models.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/assets.py api/tests/test_assets_write.py
git commit -m "feat(api): pod_number on assets, source/destination pod columns on move rosters (migration 0069)"
```

---

### Task 2: Roster API fields

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py:1882-1948` (`InitiativeAssetSummary`, `InitiativeAssetOut`, `InitiativeAssetUpdateIn`)
- Modify: `api/src/serversherpa/api/routes/initiatives.py:770-774` (`NULLABLE_TEXT_ASSET_FIELDS`) and `:812-836` (`_initiative_asset_rows`)
- Test: `api/tests/test_initiative_assets_api.py`

**Interfaces:**
- Consumes: Task 1's ORM columns.
- Produces: `InitiativeAssetSummary.pod_number`, `InitiativeAssetOut.source_pod`, `InitiativeAssetOut.destination_pod`, `InitiativeAssetUpdateIn.source_pod`, `InitiativeAssetUpdateIn.destination_pod` (all `str | None = None`). PATCH `/initiatives/assets/{id}` accepts both roster fields and treats `""` as `null`.

- [ ] **Step 1: Write the failing test**

Append to `api/tests/test_initiative_assets_api.py`:

```python
async def test_patch_pods_and_embedded_asset_pod(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    a = await _asset(db, serial_number="SN-pod", pod_number="14")
    await db.commit()
    rows = (await client.post(
        f"/initiatives/{iid}/assets", headers=headers,
        json={"asset_ids": [str(a.id)]})).json()
    assert rows[0]["asset"]["pod_number"] == "14"
    assert rows[0]["source_pod"] is None
    assoc_id = rows[0]["id"]

    resp = await client.patch(f"/initiatives/assets/{assoc_id}",
                              headers=headers,
                              json={"source_pod": "14", "destination_pod": "9"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["source_pod"] == "14"
    assert resp.json()["destination_pod"] == "9"

    resp = await client.patch(f"/initiatives/assets/{assoc_id}",
                              headers=headers, json={"destination_pod": ""})
    assert resp.status_code == 200, resp.text
    assert resp.json()["destination_pod"] is None
    assert resp.json()["source_pod"] == "14"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `SS_TEST_DB=serversherpa_test_podnumber PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_initiative_assets_api.py -q -k pods`
Expected: FAIL (`KeyError: 'pod_number'` on the embedded asset, or 422 on PATCH).

- [ ] **Step 3: Add the schema fields**

In `api/src/serversherpa/api/schemas.py`:

- `InitiativeAssetSummary`: add `pod_number: str | None = None` after `rfid_tag`.
- `InitiativeAssetOut`: add `source_pod: str | None = None` after `source_position`, and `destination_pod: str | None = None` after `destination_position`.
- `InitiativeAssetUpdateIn`: the same two lines in the same positions.

- [ ] **Step 4: Wire the route**

In `api/src/serversherpa/api/routes/initiatives.py`:

```python
NULLABLE_TEXT_ASSET_FIELDS = (
    "priority_wave", "disposition", "owner", "source_rack",
    "source_position", "source_pod", "destination_rack",
    "destination_position", "destination_pod", "cable_info",
)
```

In `_initiative_asset_rows()`, inside `InitiativeAssetOut(...)`, after `source_position=ia.source_position,` add `source_pod=ia.source_pod,`; after `destination_position=ia.destination_position,` add `destination_pod=ia.destination_pod,`. Inside the nested `InitiativeAssetSummary(...)`, after `rfid_tag=asset.rfid_tag,` add `pod_number=asset.pod_number,`.

- [ ] **Step 5: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_podnumber PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_initiative_assets_api.py -q`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/initiatives.py api/tests/test_initiative_assets_api.py
git commit -m "feat(api): source_pod/destination_pod on move roster rows, pod_number on the embedded asset"
```

---

### Task 3: From-To headers, template and sample rows

**Files:**
- Modify: `api/src/serversherpa/imports/parsing.py:15-71` (`CANONICAL`, `HEADER_MAP`, `TEMPLATE_HEADERS`, `SAMPLE_ROWS`)
- Test: `api/tests/test_move_asset_import_parsing.py`

**Interfaces:**
- Produces: canonical keys `source_pod` and `destination_pod` present in every parsed row dict (empty string when the column is absent), template columns `Source Pod` and `Destination Pod`.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_move_asset_import_parsing.py`:

```python
def test_pod_headers_map():
    content = (b"Serial Number,Source Pod #,Destination Pod Number\n"
               b"sn-1,14,9\n")
    [(_, canonical, _)] = parse_upload("a.csv", content)
    assert canonical["source_pod"] == "14"
    assert canonical["destination_pod"] == "9"


def test_bare_pod_header_is_the_source_pod():
    content = b"Serial Number,Pod #\nsn-1,14\n"
    [(_, canonical, _)] = parse_upload("a.csv", content)
    assert canonical["source_pod"] == "14"
    assert canonical["destination_pod"] == ""


def test_template_places_pod_before_rack():
    assert TEMPLATE_HEADERS.index("Source Pod") + 1 == \
        TEMPLATE_HEADERS.index("Source Rack")
    assert TEMPLATE_HEADERS.index("Destination Pod") + 1 == \
        TEMPLATE_HEADERS.index("Destination Rack")
    for sample in SAMPLE_ROWS:
        assert set(sample) == set(TEMPLATE_HEADERS)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_podnumber PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_move_asset_import_parsing.py -q -k pod`
Expected: 3 FAIL (`KeyError: 'source_pod'`, `ValueError: 'Source Pod' is not in list`).

- [ ] **Step 3: Declare the columns**

In `api/src/serversherpa/imports/parsing.py` replace the four declarations:

```python
CANONICAL = [
    "serial_number", "asset_name", "asset_make", "asset_model", "rfid_tag",
    "priority", "disposition", "owner",
    "source_pod", "source_rack", "source_ru", "source_position",
    "destination_pod", "destination_rack", "destination_ru",
    "destination_position",
    "data_1", "data_2", "data_3", "data_4", "data_5", "data_6",
    "mgmt_1", "mgmt_2", "vendor_involvement",
]

HEADER_MAP = {
    "serial number": "serial_number", "asset name": "asset_name",
    "asset make": "asset_make", "asset model": "asset_model",
    "rfid tag": "rfid_tag", "priority": "priority",
    "disposition": "disposition", "owner": "owner",
    # a sheet with one pod column is saying where the gear is today
    "pod": "source_pod", "pod #": "source_pod", "pod number": "source_pod",
    "source pod": "source_pod", "source pod #": "source_pod",
    "source pod number": "source_pod",
    "source rack": "source_rack", "source ru": "source_ru",
    "source position": "source_position",
    "destination pod": "destination_pod",
    "destination pod #": "destination_pod",
    "destination pod number": "destination_pod",
    "destination rack": "destination_rack",
    "destination ru": "destination_ru",
    "destination position": "destination_position",
    "data 1": "data_1", "data 2": "data_2", "data 3": "data_3",
    "data 4": "data_4", "data 5": "data_5", "data 6": "data_6",
    "mgmt 1": "mgmt_1", "mgmt 2": "mgmt_2",
    "vendor involvement": "vendor_involvement",
    "vendor involvment": "vendor_involvement",   # v2 template's spelling
}

TEMPLATE_HEADERS = [
    "Serial Number", "Asset Name", "Asset Make", "Asset Model", "RFID Tag",
    "Priority", "Disposition", "Owner", "Source Pod", "Source Rack",
    "Source RU", "Source Position", "Destination Pod", "Destination Rack",
    "Destination RU", "Destination Position", "Data 1", "Data 2", "Data 3",
    "Data 4", "Data 5", "Data 6", "Mgmt 1", "Mgmt 2", "Vendor Involvement",
]

SAMPLE_ROWS: list[dict] = [
    {"Serial Number": "SN-0001", "Asset Name": "web-01", "Asset Make": "Dell",
     "Asset Model": "PowerEdge R740", "RFID Tag": "", "Priority": "Wave 1",
     "Disposition": "Relocate", "Owner": "Platform",
     "Source Pod": "14", "Source Rack": "11.01.01.01A.02", "Source RU": "12",
     "Source Position": "Front",
     "Destination Pod": "9", "Destination Rack": "BJ08",
     "Destination RU": "24", "Destination Position": "Rear",
     "Data 1": "sw1:eth1/1", "Data 2": "", "Data 3": "", "Data 4": "",
     "Data 5": "", "Data 6": "", "Mgmt 1": "mgmt-sw:1", "Mgmt 2": "",
     "Vendor Involvement": ""},
    {"Serial Number": "SN-0002", "Asset Name": "san-01", "Asset Make": "HPE",
     "Asset Model": "Nimble HF20", "RFID Tag": "", "Priority": "Wave 2",
     "Disposition": "", "Owner": "", "Source Pod": "", "Source Rack": "BJ01",
     "Source RU": "3.5", "Source Position": "",
     "Destination Pod": "", "Destination Rack": "", "Destination RU": "",
     "Destination Position": "",
     "Data 1": "", "Data 2": "", "Data 3": "", "Data 4": "", "Data 5": "",
     "Data 6": "", "Mgmt 1": "", "Mgmt 2": "", "Vendor Involvement": "yes"},
]
```

`parse_upload` only strips and lower-cases each header before the `HEADER_MAP` lookup (it does not remove `#`), and it pre-fills every `CANONICAL` key with `""`, which is why the `# ` aliases are needed and why a missing column reads as an empty string.

- [ ] **Step 4: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_podnumber PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_move_asset_import_parsing.py api/tests/test_move_asset_import_validate.py -q`
Expected: all PASS (the template round-trip tests read the lists symbolically).

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/imports/parsing.py api/tests/test_move_asset_import_parsing.py
git commit -m "feat(imports): Source Pod / Destination Pod columns in the From-To headers and template"
```

---

### Task 4: Importer writes pods to the roster and the asset

**Files:**
- Modify: `api/src/serversherpa/imports/move_assets.py:135-151` (`parse_row` return dict), `:154-162` (`_SimAsset`), `:247-264` (`_apply_row`), `:390-406` (asset create / existing-asset branch)
- Test: `api/tests/test_move_asset_import_rows.py`, `api/tests/test_move_asset_import_commit.py`

**Interfaces:**
- Consumes: Task 1 columns, Task 3 canonical keys.
- Produces: `parse_row` rows carry `"source_pod"` and `"destination_pod"` (`str | None`).

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_move_asset_import_rows.py`:

```python
def test_pods_parse_stripped_and_blank_is_none():
    out = parse_row(2, _canonical(serial_number="SN-1", source_pod=" 14 ",
                                  destination_pod=""), {},
                    generate_serials=False)
    assert out["source_pod"] == "14"
    assert out["destination_pod"] is None
```

Append to `api/tests/test_move_asset_import_commit.py`:

```python
async def test_pods_land_on_roster_and_source_pod_on_asset(db):
    ini = await _move(db)
    kept = Asset(serial_number="sn-kept", pod_number="3")
    moved = Asset(serial_number="sn-moved", pod_number="3")
    db.add_all([kept, moved])
    await db.commit()
    rows = [
        _row(2, serial_number="SN-NEW", source_pod="14", destination_pod="9"),
        _row(3, serial_number="SN-KEPT", destination_pod="9"),   # blank source keeps 3
        _row(4, serial_number="SN-MOVED", source_pod="14"),      # overwrites 3
    ]
    await run_import(db, initiative_id=ini.id, added_by=None, rows=rows,
                     write=True)
    new = await db.scalar(select(Asset).where(Asset.serial_number == "sn-new"))
    assert new.pod_number == "14"
    await db.refresh(kept)
    await db.refresh(moved)
    assert kept.pod_number == "3"
    assert moved.pod_number == "14"
    assoc = await db.scalar(select(InitiativeAsset).where(
        InitiativeAsset.asset_id == new.id))
    assert (assoc.source_pod, assoc.destination_pod) == ("14", "9")
    assoc_kept = await db.scalar(select(InitiativeAsset).where(
        InitiativeAsset.asset_id == kept.id))
    assert (assoc_kept.source_pod, assoc_kept.destination_pod) == (None, "9")


async def test_validate_mode_writes_no_pods(db):
    ini = await _move(db)
    bare = Asset(serial_number="sn-bare")
    db.add(bare)
    await db.commit()
    rows = [_row(2, serial_number="SN-BARE", source_pod="14")]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=False)
    assert result["summary"]["created"] == 1
    await db.refresh(bare)
    assert bare.pod_number is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_podnumber PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_move_asset_import_rows.py api/tests/test_move_asset_import_commit.py -q -k pod`
Expected: FAIL (`KeyError: 'source_pod'`).

- [ ] **Step 3: Emit the fields from `parse_row`**

In the return dict of `parse_row`, after the `"owner"` line:

```python
        "source_pod": canonical["source_pod"].strip() or None,
        "destination_pod": canonical["destination_pod"].strip() or None,
```

- [ ] **Step 4: Write them in `_apply_row`**

After `assoc.owner = r["owner"]`:

```python
    assoc.source_pod = r["source_pod"]
    assoc.destination_pod = r["destination_pod"]
```

- [ ] **Step 5: Copy the source pod onto the asset**

In `_SimAsset.__init__` add `self.pod_number: str | None = None` after the `rfid_tag` line (validate mode must not touch the ORM).

In the asset-creation branch, add `pod_number=r["source_pod"],` to the `Asset(...)` constructor after `rfid_tag=rfid_to_write,`.

Replace the `elif rfid_to_write:` existing-asset branch with:

```python
        else:
            if rfid_to_write:
                if write:
                    asset.rfid_tag = rfid_to_write
                    asset.updated_at = now
                rfid_map[rfid_to_write.lower()] = asset
            # The import states where the asset is today; a blank cell
            # says nothing and never clears a known pod.
            if write and r["source_pod"] and asset.pod_number != r["source_pod"]:
                asset.pod_number = r["source_pod"]
                asset.updated_at = now
```

- [ ] **Step 6: Run the tests**

Run: `SS_TEST_DB=serversherpa_test_podnumber PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_move_asset_import_rows.py api/tests/test_move_asset_import_commit.py api/tests/test_move_asset_import_validate.py api/tests/test_move_asset_import_api.py -q`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/imports/move_assets.py api/tests/test_move_asset_import_rows.py api/tests/test_move_asset_import_commit.py
git commit -m "feat(imports): From-To rows write source/destination pods to the roster and the source pod onto the asset"
```

---

### Task 5: Portal move roster — types, columns, dialog, detail page

**Files:**
- Modify: `portal/src/lib/api.ts:2293-2318` (`InitiativeAssetSummary`, `InitiativeAssetRow`)
- Modify: `portal/src/lib/initiatives.ts:283-306` (`MOVE_ASSET_COLUMNS`), `:315-346` (`moveAssetCellText`), `:446-475` (`MOVE_ASSET_EDIT_FIELDS`)
- Modify: `portal/src/components/initiatives/AssetEditDialog.tsx:30-60,123-160`
- Modify: `portal/src/pages/MoveAssetDetail.tsx:146-155`
- Modify (fixtures only): every test file `tsc` flags — known: `portal/src/lib/initiatives.test.ts:205`, `portal/src/pages/InitiativeDetail.test.tsx:92`, `portal/src/components/initiatives/AssetEditDialog.test.tsx:17,29`, `portal/src/components/initiatives/RackViewModal.render.test.tsx:23,35`, and any `InitiativeAssetRow`/`InitiativeAssetSummary` literal in `PrintAssetList.test.tsx`, `SiteMoveSurveyOptions.test.tsx`, `printLabels.test.ts`, `siteMoveSurvey.test.ts`, `labelCache.test.ts`, `PrintLabels.test.tsx`
- Test: `portal/src/lib/initiatives.test.ts`

**Interfaces:**
- Consumes: Task 2 API fields.
- Produces: `InitiativeAssetSummary.pod_number: string | null`; `InitiativeAssetRow.source_pod: string | null`, `InitiativeAssetRow.destination_pod: string | null`; column keys `source_pod`, `destination_pod`, `pod_number`.

- [ ] **Step 1: Write the failing tests**

In `portal/src/lib/initiatives.test.ts`, inside `describe('moveAssetCellText', ...)` add:

```ts
  it('reads the pod columns, dashing when blank', () => {
    const row = assetRow({ source_pod: '14', destination_pod: null,
                           asset: { ...assetRow().asset, pod_number: '3' } });
    expect(moveAssetCellText(row, 'source_pod')).toBe('14');
    expect(moveAssetCellText(row, 'destination_pod')).toBe('—');
    expect(moveAssetCellText(row, 'pod_number')).toBe('3');
  });
```

In `describe('MOVE_ASSET_EDIT_FIELDS', ...)` change the first test to expect 16 fields:

```ts
  it('covers exactly the 16 per-move fields, none of the asset-identity columns', () => {
    expect(fields.map((f) => f.column).sort()).toEqual([
      'cable_info', 'destination_pod', 'destination_position', 'destination_rack',
      'destination_ru', 'destination_verified', 'disposition', 'owner',
      'source_pod', 'source_position', 'source_rack', 'source_ru',
      'source_verified', 'status', 'vendor_involved', 'wave',
    ].sort());
  });
```

Add to the `assetRow` fixture in the same file: `source_pod: null, destination_pod: null,` after `owner: 'Jane Doe',` and `pod_number: null,` after `rfid_tag: 'RFID-1',` in the nested asset.

- [ ] **Step 2: Run the type check to see every fixture that needs the fields**

Run: `(cd portal && node_modules/.bin/tsc --noEmit)`
Expected: errors only in test fixtures (object literals missing `source_pod`, `destination_pod`, `pod_number`) once Step 3's types are in. Run it after Step 3 and fix each flagged literal by adding the three keys with `null`.

- [ ] **Step 3: Types**

In `portal/src/lib/api.ts`:

- `InitiativeAssetSummary`: after `name: string | null; rfid_tag: string | null;` add `pod_number: string | null;`.
- `InitiativeAssetRow`: change the source/destination lines to:

```ts
  source_pod: string | null; source_rack: string | null; source_ru: number | null;
  source_verified: boolean | null; source_position: string | null;
  destination_pod: string | null; destination_rack: string | null;
  destination_ru: number | null;
  destination_verified: boolean | null; destination_position: string | null;
```

- [ ] **Step 4: Columns, cell text, god-edit fields**

In `portal/src/lib/initiatives.ts`, `MOVE_ASSET_COLUMNS`: insert after the `source_position` entry

```ts
  { key: 'source_pod', label: 'Source Pod', width: '0.8fr', default: false },
```

after the `destination_position` entry

```ts
  { key: 'destination_pod', label: 'Destination Pod', width: '0.9fr', default: false },
```

and after the `location` entry

```ts
  { key: 'pod_number', label: 'Pod #', width: '0.7fr', default: false },
```

In `moveAssetCellText`, after `case 'source_position'`: `case 'source_pod': return row.source_pod ?? BLANK;`; after `case 'destination_position'`: `case 'destination_pod': return row.destination_pod ?? BLANK;`; after `case 'location'`: `case 'pod_number': return row.asset.pod_number ?? BLANK;`.

In `MOVE_ASSET_EDIT_FIELDS`, after the `source_position` entry:

```ts
    { column: 'source_pod', field: 'source_pod', kind: 'text',
      fromRow: (r) => r.source_pod ?? '' },
```

and after the `destination_position` entry:

```ts
    { column: 'destination_pod', field: 'destination_pod', kind: 'text',
      fromRow: (r) => r.destination_pod ?? '' },
```

- [ ] **Step 5: Edit dialog**

In `portal/src/components/initiatives/AssetEditDialog.tsx`, add state after `sourceRack`/`destinationRack`:

```ts
  const [sourcePod, setSourcePod] = useState(asset.source_pod ?? '');
  const [destinationPod, setDestinationPod] = useState(asset.destination_pod ?? '');
```

In the `updateInitiativeAsset` payload add `source_pod: sourcePod || null,` before `source_rack` and `destination_pod: destinationPod || null,` before `destination_rack`.

In the Source & destination `pf-form` grid, insert as the first pair (before the two Rack inputs):

```tsx
              <div><label>Pod</label>
                <input value={sourcePod} disabled={saving}
                       onChange={(e) => setSourcePod(e.target.value)} /></div>
              <div><label>Pod</label>
                <input value={destinationPod} disabled={saving}
                       onChange={(e) => setDestinationPod(e.target.value)} /></div>
```

- [ ] **Step 6: Detail page**

In `portal/src/pages/MoveAssetDetail.tsx`, Placement list: add `<dt>Source pod</dt><dd>{row.source_pod ?? '—'}</dd>` before `Source rack` and `<dt>Destination pod</dt><dd>{row.destination_pod ?? '—'}</dd>` before `Destination rack`.

- [ ] **Step 7: Run the suite and type check**

Run: `npm --prefix portal run test` then `(cd portal && node_modules/.bin/tsc --noEmit)`
Expected: all PASS, no type errors. Fix every fixture the type check flags by adding the missing keys as `null`.

- [ ] **Step 8: Commit**

```bash
git add portal/src
git commit -m "feat(portal): Source Pod / Destination Pod / Pod # columns on the move roster, edit dialog and detail page"
```

---

### Task 6: Portal assets list, form, and detail page

**Files:**
- Modify: `portal/src/lib/api.ts:1312-1319` (`AssetItem`)
- Modify: `portal/src/pages/Assets.tsx:63-81` (`COLUMNS`), `:97-116` (`sortValueFor`), `:118-133` (`CSV_COLUMNS`), `:392-397` (`cellFor`)
- Modify: `portal/src/lib/assets.ts:54-73` (`assetCellText`), `:181-224` (form state, `formFromAsset`, `assetPayload`), `:367-389` (`ASSET_GOD_FIELDS`)
- Modify: `portal/src/components/assets/AssetEditModal.tsx:163-168`
- Modify: `portal/src/pages/AssetDetail.tsx:124-126`
- Modify (fixtures only): `portal/src/lib/assets.test.ts:13`, `portal/src/pages/Assets.test.tsx:50`, and every `AssetItem` literal `tsc` flags in `AssetDetail.test.tsx`, `ClientDashboard.test.tsx`, `clientDashboard.test.ts`, `Warehouse.test.tsx`
- Test: `portal/src/lib/assets.test.ts`

**Interfaces:**
- Consumes: Task 1 `AssetItem.pod_number`.
- Produces: `AssetItem.pod_number: string | null`; `AssetFormState.pod_number: string`; assets list column key `pod`.

- [ ] **Step 1: Write the failing tests**

In `portal/src/lib/assets.test.ts`:

- Add `pod_number: null,` to the `asset()` builder after `rfid_tag: null,`.
- Add `'pod_number'` to the `ASSET_WRITABLE_FIELDS` set.
- In `describe('assetCellText', ...)`, add `pod_number: '14',` to the `full` fixture and `pod_number: null,` to `blank`, then add:

```ts
  it('pod reads pod_number, dashing when null', () => {
    expect(assetCellText(full, 'pod')).toBe('14');
    expect(assetCellText(blank, 'pod')).toBe('—');
  });
```

- In `describe('asset form round-trip', ...)` add:

```ts
  it('pod_number round-trips and nulls when blank', () => {
    const f = formFromAsset(asset({ pod_number: '14' }));
    expect(f.pod_number).toBe('14');
    f.pod_number = '  ';
    expect(assetPayload(f).pod_number).toBeNull();
    f.pod_number = ' P-07 ';
    expect(assetPayload(f).pod_number).toBe('P-07');
  });
```

- In the `ASSET_GOD_FIELDS` round-trip test add `pod_number: '14'` to the sample `asset({...})` and `pod: '14'` to `expected`.

- [ ] **Step 2: Types**

In `portal/src/lib/api.ts`, `AssetItem`: change `rfid_tag: string | null; model_id: string | null;` to `rfid_tag: string | null; pod_number: string | null; model_id: string | null;`.

- [ ] **Step 3: Library**

In `portal/src/lib/assets.ts`:

`assetCellText`, after `case 'rfid'`: `case 'pod': return a.pod_number ?? '—';`

`AssetFormState`: `serial_number: string; name: string; rfid_tag: string; pod_number: string;`

`formFromAsset`: add `pod_number: a?.pod_number ?? '',` after `rfid_tag`.

`assetPayload`: add `put('pod_number', form.pod_number);` after `put('rfid_tag', form.rfid_tag);`.

`ASSET_GOD_FIELDS`: after the `rfid` entry add

```ts
    { column: 'pod', field: 'pod_number', kind: 'text',
      fromRow: (a) => a.pod_number ?? '' },
```

- [ ] **Step 4: Assets page**

In `portal/src/pages/Assets.tsx`:

`COLUMNS`, after `location`: `{ key: 'pod', label: 'Pod #', width: '0.7fr', default: false },`

`sortValueFor`, after `case 'rfid'`: `case 'pod': return (a.pod_number ?? '').toLowerCase();`

`CSV_COLUMNS`, after `['Location', ...]`: `['Pod #', (a) => a.pod_number ?? ''],`

`cellFor`, after the `case 'rfid'` return:

```tsx
      case 'pod':
        return <span className="mono">{a.pod_number ?? '—'}</span>;
```

- [ ] **Step 5: Edit modal and detail page**

In `portal/src/components/assets/AssetEditModal.tsx`, after the Location detail input:

```tsx
              <div><label>Pod #</label>
                <input value={form.pod_number} disabled={locked}
                       onChange={(e) => setField('pod_number', e.target.value)} /></div>
```

In `portal/src/pages/AssetDetail.tsx`, Identity list, after the RFID tag row:

```tsx
              <dt>Pod #</dt><dd className="mono">{asset.pod_number ?? '—'}</dd>
```

- [ ] **Step 6: Run the suite and type check**

Run: `npm --prefix portal run test` then `(cd portal && node_modules/.bin/tsc --noEmit)`
Expected: all PASS, no type errors. Fix every `AssetItem` fixture the type check flags by adding `pod_number: null`.

- [ ] **Step 7: Commit**

```bash
git add portal/src
git commit -m "feat(portal): Pod # column, form field, god edit and detail row on assets"
```

---

### Task 7: Full suites and rebuild check

**Files:** none new.

- [ ] **Step 1: Full API suite**

Run: `SS_TEST_DB=serversherpa_test_podnumber PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests -q -x`
Expected: all PASS (about 20 minutes). WeasyPrint-backed tests need `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` in front of the command.

- [ ] **Step 2: Portal suite and type check**

Run: `npm --prefix portal run test` then `(cd portal && node_modules/.bin/tsc --noEmit)`
Expected: all PASS.

- [ ] **Step 3: Record**

Append `Task 7: full suites green` to `.superpowers/sdd/progress.md`. No commit unless a fix was needed.
