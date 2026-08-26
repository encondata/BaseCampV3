# Merge move_asset_status Into asset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `asset` status vocabulary serves both `assets.status` and `initiative_assets.status`; the `move_asset_status` record type disappears from DB, API, and portal.

**Architecture:** A data migration (0022) copies the 23 non-colliding move rows into `record_type='asset'` (weights verbatim, `sort_order` 0), flips the one collision (`in_transit`) to move's look, rebuilds the `GENERATED` `status_record_type` column on `initiative_assets` as `'asset'`, and deletes the old vocabulary. The API's status registry gains multi-table usage counting; two route lookups and the portal's fetch/editor gates repoint from `move_asset_status` to `asset`.

**Tech Stack:** Alembic/SQLAlchemy/FastAPI (api/), React+TypeScript+vitest (portal/).

**Spec:** `docs/superpowers/specs/2026-08-25-merge-asset-status-design.md` (approved).

## Global Constraints

- Branch: `claude/merge-asset-status` in THIS worktree (`/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/brave-aryabhata-01fbe0`). Never touch the main checkout at `/Users/jrh1812/Developer/BaseCampV3` — another session works there.
- Migrated rows keep `progress_weight` VERBATIM. Null is load-bearing (null = excluded from progress; 0 = counts at zero). Merged `in_transit`: label `In Transit`, color `#f52727`, weight `50`, keeps `sort_order` 2. The five original lifecycle values keep weight NULL. Migrated rows get `sort_order` 0.
- No status keys are renamed, ever — the portal maps progress weights by key.
- Migration numbering: 0022 revises 0021. If `feature/initiatives` gains a 0022 before this lands, rebase and renumber ours.
- API tests: run with `SS_TEST_DB=serversherpa_test_masq` so we never collide with the main checkout's test DB (`serversherpa_test`).
- Never run bare `alembic upgrade` against the dev DB (the copied `.env` points at the live `serversherpa` DB on port 5433). The dev DB gets 0022 only when the user merges to `feature/initiatives`.
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 0: Worktree test infrastructure (one-time setup)

**Files:** none in git (venv + env file only).

The worktree has no `api/.venv` and no `.env` (gitignored). API tests need both: `tests/conftest.py` reads `Settings()` (which loads `<repo root>/.env`) and shells out to `api/.venv/bin/alembic`.

- [ ] **Step 1: Copy the env file and build the venv**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/brave-aryabhata-01fbe0
cp /Users/jrh1812/Developer/BaseCampV3/.env .env
python3 -m venv api/.venv
api/.venv/bin/pip install -e './api[dev]'
```

Expected: pip finishes with `Successfully installed ... serversherpa-api ...`.

- [ ] **Step 2: Prove the API test suite runs (pre-change baseline)**

```bash
cd api && SS_TEST_DB=serversherpa_test_masq .venv/bin/pytest tests/test_status_values_model.py -q
```

Expected: PASS (all tests green on the un-changed branch). If this fails, STOP — fix infrastructure before any code change. Postgres runs in docker (`serversherpa-dev-postgres-1`, port 5433); conftest creates `serversherpa_test_masq` itself.

No commit (nothing in git changed).

---

### Task 1: Migration 0022 + model defaults + test seeds

**Files:**
- Create: `api/migrations/versions/0022_merge_asset_status.py`
- Modify: `api/src/serversherpa/db/models.py` (~line 369 comment, ~line 646 `server_default`)
- Modify: `api/tests/conftest.py` (asset seed block ~line 135; move seed block ~line 213)
- Test: `api/tests/test_status_values_model.py` (~lines 100–140)

**Interfaces:**
- Produces: DB state where `record_type='asset'` holds 28 rows (5 lifecycle + 23 workflow) and `move_asset_status` holds none; `initiative_assets.status_record_type` generates `'asset'`. Tasks 2–3 rely on this.

- [ ] **Step 1: Rewrite the weights test to the merged expectation (failing test)**

In `api/tests/test_status_values_model.py`, replace the whole `test_move_asset_status_weights_seeded_verbatim` function with:

```python
async def test_merged_asset_weights_seeded_verbatim(db):
    """0021 seeded the move workflow weights; 0022 merged those rows into
    the asset vocabulary (docs/superpowers/specs/
    2026-08-25-merge-asset-status-design.md) with weights VERBATIM, plus
    the five original lifecycle keys at null (excluded from progress —
    an asset parked on a lifecycle status must not drag a move's number).
    in_transit is the one collision: the asset row keeps its key and
    sort_order but takes move's weight (50). Pinned as a literal map so
    drift in the migration, the conftest seeds, or the doc fails loudly."""
    rows = (await db.execute(
        select(StatusValue.key, StatusValue.progress_weight)
        .where(StatusValue.record_type == "asset"))).all()
    weights = dict(rows)
    assert weights == {
        "active": None,
        "in_transit": 50,
        "in_storage": None,
        "decommissioned": None,
        "unknown": None,
        "loaded_in_system": 0,
        "pre_stage": 8,
        "racked": 15,
        "labeled": 23,
        "pack_logistics": 31,
        "in_container": 38,
        "on_truck": 46,
        "received": 54,
        "un_pack": 62,
        "staged": 69,
        "re_racked": 77,
        "cabling": 85,
        "qa": 92,
        "complete": 100,
        "rfid_1_cage_exit": 35,
        "rfid_2_loading_dock": 40,
        "rfid_3_staging": 65,
        "rfid_4_into_cage": 72,
        "rfid_10_dock_to_truck": 44,
        "e_waste": 100,
        "pending_client_handover": 95,
        "historical": None,
        "location_collision": None,
    }


async def test_move_asset_status_record_type_is_gone(db):
    """0022 deletes the old vocabulary outright — nothing may linger."""
    n = await db.scalar(
        select(func.count()).select_from(StatusValue)
        .where(StatusValue.record_type == "move_asset_status"))
    assert n == 0
```

Add `func` to the existing `from sqlalchemy import ...` line in that file if it is not already imported.

- [ ] **Step 2: Run to verify both fail**

```bash
cd api && SS_TEST_DB=serversherpa_test_masq .venv/bin/pytest tests/test_status_values_model.py -q
```

Expected: FAIL — `test_merged_asset_weights_seeded_verbatim` (map has only 5 keys, all None) and `test_move_asset_status_record_type_is_gone` (24 rows remain). Failing because the migration/seeds don't exist yet, not because of an import error.

- [ ] **Step 3: Write migration 0022**

Create `api/migrations/versions/0022_merge_asset_status.py`:

```python
"""Merge the move_asset_status vocabulary into asset — one status list
serves assets.status and initiative_assets.status (docs/superpowers/
specs/2026-08-25-merge-asset-status-design.md).

The 23 non-colliding move keys copy over verbatim (label/description/
color/is_active/progress_weight) at sort_order 0 — "unset"; the user
renumbers by hand in Variables. The one collision, in_transit, keeps
the asset row (and its sort_order 2) but takes move's look and weight
(In Transit, #f52727, 50). initiative_assets.status_record_type
(GENERATED) rebuilds as 'asset'.

Downgrade note: it fails (FK violation) if any assets.status row uses a
moved workflow key by then — loud failure beats silently corrupting
asset statuses.

Revision ID: 0022
Revises: 0021
Create Date: 2026-08-26
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# The 0019 seed keys (as amended by 0020/0021) — the rows this migration
# moves. Literal so downgrade never guesses which asset rows came from
# the merge. Values are the 0019/0020 sort orders downgrade restores.
MOVED_KEY_SORT_ORDERS: dict[str, int] = {
    "loaded_in_system": 1,
    "pre_stage": 2,
    "racked": 3,
    "labeled": 4,
    "pack_logistics": 5,
    "in_container": 6,
    "on_truck": 7,
    "received": 8,
    "un_pack": 9,
    "staged": 10,
    "re_racked": 11,
    "cabling": 12,
    "qa": 13,
    "complete": 14,
    "rfid_1_cage_exit": 20,
    "rfid_2_loading_dock": 21,
    "rfid_3_staging": 22,
    "rfid_4_into_cage": 23,
    "rfid_10_dock_to_truck": 24,
    "in_transit": 50,
    "e_waste": 51,
    "pending_client_handover": 96,
    "historical": 99,
    "location_collision": 100,
}


def upgrade() -> None:
    conn = op.get_bind()
    # 1. copy the non-colliding rows into the asset vocabulary — weights
    #    verbatim, sort_order 0 ("unset"; renumbered by hand later)
    conn.execute(sa.text("""
        INSERT INTO status_values
          (record_type, key, label, description, color, sort_order,
           is_active, progress_weight)
        SELECT 'asset', key, label, description, color, 0,
               is_active, progress_weight
        FROM status_values
        WHERE record_type = 'move_asset_status' AND key <> 'in_transit'
    """))
    # 2. the collision keeps the asset row, takes move's look and weight
    conn.execute(sa.text("""
        UPDATE status_values
        SET label = 'In Transit', color = '#f52727', progress_weight = 50
        WHERE record_type = 'asset' AND key = 'in_transit'
    """))
    # 3. re-point initiative_assets at the asset vocabulary. A generated
    #    column's expression can't be altered in place — rebuild it (the
    #    0019 idiom), FK dropped around the rebuild.
    op.drop_constraint("initiative_assets_status_fkey", "initiative_assets",
                       type_="foreignkey")
    op.drop_column("initiative_assets", "status_record_type")
    op.execute("""
        ALTER TABLE initiative_assets ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('asset') STORED
    """)
    op.create_foreign_key(
        "initiative_assets_status_fkey", "initiative_assets",
        "status_values",
        ["status_record_type", "status"], ["record_type", "key"])
    # 4. the old vocabulary is now unreferenced
    conn.execute(sa.text(
        "DELETE FROM status_values WHERE record_type = 'move_asset_status'"))


def downgrade() -> None:
    conn = op.get_bind()
    # re-create the move vocabulary from the merged rows, restoring the
    # 0019/0020 sort orders (in_transit copies back with move's look —
    # exactly what it had pre-merge)
    for key, sort_order in MOVED_KEY_SORT_ORDERS.items():
        conn.execute(sa.text("""
            INSERT INTO status_values
              (record_type, key, label, description, color, sort_order,
               is_active, progress_weight)
            SELECT 'move_asset_status', key, label, description, color,
                   :sort_order, is_active, progress_weight
            FROM status_values
            WHERE record_type = 'asset' AND key = :key
        """), {"key": key, "sort_order": sort_order})
    op.drop_constraint("initiative_assets_status_fkey", "initiative_assets",
                       type_="foreignkey")
    op.drop_column("initiative_assets", "status_record_type")
    op.execute("""
        ALTER TABLE initiative_assets ADD COLUMN status_record_type text
          GENERATED ALWAYS AS ('move_asset_status') STORED
    """)
    op.create_foreign_key(
        "initiative_assets_status_fkey", "initiative_assets",
        "status_values",
        ["status_record_type", "status"], ["record_type", "key"])
    # the asset vocabulary sheds the moved rows; in_transit reverts to
    # its 0014 look and unset weight
    keys = [k for k in MOVED_KEY_SORT_ORDERS if k != "in_transit"]
    conn.execute(
        sa.text("DELETE FROM status_values "
                "WHERE record_type = 'asset' AND key IN :keys")
        .bindparams(sa.bindparam("keys", expanding=True)),
        {"keys": keys})
    conn.execute(sa.text("""
        UPDATE status_values
        SET label = 'In transit', color = '#0f7c86', progress_weight = NULL
        WHERE record_type = 'asset' AND key = 'in_transit'
    """))
```

- [ ] **Step 4: Update the ORM model**

In `api/src/serversherpa/db/models.py`:

(a) ~line 369, replace the `progress_weight` comment:

```python
    # 0-100 or null (excluded from the weighted-progress calc); generic
    # column, seeded for the asset vocabulary's workflow statuses
    progress_weight: Mapped[int | None] = mapped_column(Integer)
```

(b) ~line 646, in `InitiativeAsset`, change the generated-column default:

```python
    status_record_type: Mapped[str] = mapped_column(
        server_default=text("'asset'"))  # GENERATED column; never written
```

Also update the `InitiativeAsset` class docstring's mention of seeding "the move_asset_status vocabulary" if present (reword to "the asset vocabulary's workflow statuses") — keep the rest of the docstring as is.

- [ ] **Step 5: Merge the conftest seed blocks**

In `api/tests/conftest.py`:

(a) Replace the asset seed block (~lines 135–147) with the merged 28-row block. Workflow rows carry `sort_order` 0 and their weights; `in_transit` takes move's look/weight but keeps sort 2 and its description:

```python
        # asset vocabulary — restore canonical seeds (0014 as merged by
        # 0022: lifecycle keys + the former move_asset_status workflow
        # keys at sort_order 0, weights VERBATIM from the weighted-
        # progress design doc; in_transit is the merged collision row —
        # move's look and weight, asset's key/sort/description)
        await session.execute(text(
            "DELETE FROM status_values WHERE record_type = 'asset'"))
        await session.execute(text("""
            INSERT INTO status_values
              (record_type, key, label, description, color, sort_order, progress_weight)
            VALUES
              ('asset','active','Active','Racked and in service.','#178a4c',1,NULL),
              ('asset','in_transit','In Transit','Between locations.','#f52727',2,50),
              ('asset','in_storage','In storage','Warehoused, not in service.','#51606f',3,NULL),
              ('asset','decommissioned','Decommissioned','Retired; retained for history.','#c03540',4,NULL),
              ('asset','unknown','Unknown','Not yet verified.','#a36207',5,NULL),
              ('asset','loaded_in_system','Loaded In System','','#808080',0,0),
              ('asset','pre_stage','Pre-Stage','','#caa0a0',0,8),
              ('asset','racked','Racked','','#273ff5',0,15),
              ('asset','labeled','Labeled','','#f5be27',0,23),
              ('asset','pack_logistics','Pack / Logistics','','#31f527',0,31),
              ('asset','in_container','In Container','','#31f527',0,38),
              ('asset','on_truck','On Truck','','#31f527',0,46),
              ('asset','received','Received','','#31f527',0,54),
              ('asset','un_pack','Un-Pack','','#31f527',0,62),
              ('asset','staged','Staged','','#27f5ad',0,69),
              ('asset','re_racked','Re-Racked','','#31f527',0,77),
              ('asset','cabling','Cabling','','#31f527',0,85),
              ('asset','qa','QA','','#31f527',0,92),
              ('asset','complete','Complete','','#8e27f5',0,100),
              ('asset','rfid_1_cage_exit','RFID 1 - Cage Exit','','#31f527',0,35),
              ('asset','rfid_2_loading_dock','RFID 2 - Loading Dock','','#29d3f5',0,40),
              ('asset','rfid_3_staging','RFID 3 - Staging','','#f58b29',0,65),
              ('asset','rfid_4_into_cage','RFID 4 - Into Cage','','#f5297a',0,72),
              ('asset','rfid_10_dock_to_truck','RFID 10 - Dock to Truck (Auto Container Pack)','','#1890ff',0,44),
              ('asset','e_waste','e-waste','','#ee27f5',0,100),
              ('asset','pending_client_handover','Pending Client Handover','','#00ff00',0,95),
              ('asset','historical','Historical','','#27f5f2',0,NULL),
              ('asset','location_collision','Location Collision','','#ff0000',0,NULL)
        """))
```

Note the merged block contains exactly ONE `in_transit` row (the lifecycle one at sort 2 with weight 50) and 28 rows total — the workflow list above deliberately has no second `in_transit`.

(b) Delete the entire `move_asset_status` seed block (~lines 213–248: the comment, the `DELETE FROM status_values WHERE record_type = 'move_asset_status'` execute, and the 24-row INSERT execute).

- [ ] **Step 6: Run model tests to verify pass**

```bash
cd api && SS_TEST_DB=serversherpa_test_masq .venv/bin/pytest tests/test_status_values_model.py -q
```

Expected: PASS. (conftest re-runs `alembic upgrade head`, applying 0022 to the test DB.) Other suites (read/write/registry/initiative-assets) are EXPECTED to fail until Tasks 2–3 — do not chase them here.

- [ ] **Step 7: Round-trip the migration on the test DB only**

```bash
cd api && SS_DATABASE_URL="$(python3 -c "
from sqlalchemy.engine import make_url
import pathlib, re
env = pathlib.Path('../.env').read_text()
url = re.search(r'SS_DATABASE_URL=(.*)', env).group(1).strip()
print(str(make_url(url).set(database='serversherpa_test_masq')))
")" .venv/bin/alembic downgrade 0021 && SS_DATABASE_URL="$(python3 -c "
from sqlalchemy.engine import make_url
import pathlib, re
env = pathlib.Path('../.env').read_text()
url = re.search(r'SS_DATABASE_URL=(.*)', env).group(1).strip()
print(str(make_url(url).set(database='serversherpa_test_masq')))
")" .venv/bin/alembic upgrade head
```

Expected: both commands exit 0 (downgrade prints `Running downgrade 0022 -> 0021`, upgrade prints `Running upgrade 0021 -> 0022`). NEVER run this without the `SS_DATABASE_URL` override — bare alembic here targets the live dev DB.

- [ ] **Step 8: Commit**

```bash
git add api/migrations/versions/0022_merge_asset_status.py api/src/serversherpa/db/models.py api/tests/conftest.py api/tests/test_status_values_model.py
git commit -m "feat(api): merge move_asset_status vocabulary into asset (migration 0022)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Registry multi-source usage counting + status-values test repoints

**Files:**
- Modify: `api/src/serversherpa/status/registry.py` (whole registry)
- Modify: `api/src/serversherpa/api/routes/status_values.py` (`_usage_counts`, ~lines 59–75)
- Test: `api/tests/test_status_registry.py` (rewrite target-column tests)
- Test: `api/tests/test_status_values_read.py` (~lines 88–135 + new test)
- Test: `api/tests/test_status_values_write.py` (~lines 368–415)

**Interfaces:**
- Consumes: Task 1's DB state.
- Produces: `StatusRecordType(id, label, sources: tuple[tuple[str, str], ...], resource, array=False)` — `sources` replaces `table`/`column`. `_usage_counts(db, rt) -> dict[str, int]` sums across all sources. Task 3 does not touch these; nothing else consumes them.

- [ ] **Step 1: Rewrite the registry tests (failing tests)**

In `api/tests/test_status_registry.py`:

(a) Replace `test_launch_types_are_site_worker_asset_and_container`'s expected set — delete the `"move_asset_status"` member:

```python
def test_launch_types_are_site_worker_asset_and_container():
    assert set(STATUS_REGISTRY) == {
        "site", "worker", "asset", "container", "container_type",
        "initiative", "initiative_type", "initiative_sub_type",
        "initiative_work_type", "shipping_type", "partner_type"}
```

(b) Rewrite every per-type target test from `(rt.table, rt.column, rt.resource)` tuples to `sources`. The pattern, applied to each existing test (site shown; worker/container/container_type/asset follow identically with their own values):

```python
def test_site_type_targets_the_sites_status_column():
    site = STATUS_REGISTRY["site"]
    assert site.sources == (("sites", "status"),)
    assert site.resource == "sites"
```

(c) Replace `test_move_asset_status_targets_the_initiative_assets_status_column` with:

```python
def test_asset_type_counts_both_status_tables():
    """The merged vocabulary is referenced from two tables — usage counts
    must span assets.status AND initiative_assets.status."""
    asset = STATUS_REGISTRY["asset"]
    assert asset.sources == (("assets", "status"),
                             ("initiative_assets", "status"))
    assert asset.resource == "assets"
```

(d) `test_asset_type_targets_the_assets_status_column` becomes redundant with (c) — delete it.

- [ ] **Step 2: Run to verify failure**

```bash
cd api && SS_TEST_DB=serversherpa_test_masq .venv/bin/pytest tests/test_status_registry.py -q
```

Expected: FAIL — `AttributeError: ... no attribute 'sources'` and the set test failing on the extra `move_asset_status` member.

- [ ] **Step 3: Rewrite the registry**

Replace the entire contents of `api/src/serversherpa/status/registry.py` with:

```python
"""Status record types — the code-side list of entities that carry a status
vocabulary. Deploys introduce record types; the DB stores only the values.

Shaped after access/resources.py deliberately: a record_type is not data. A
row saying record_type='invoice' is inert until an invoices feature ships,
and that feature ships as a deploy anyway."""

from dataclasses import dataclass


@dataclass(frozen=True)
class StatusRecordType:
    id: str
    label: str
    # the (table, column) pairs carrying this entity's status — usage
    # counting sums across all of them (asset spans two tables since the
    # 0022 vocabulary merge)
    sources: tuple[tuple[str, str], ...]
    # the resource whose "view" permission gates reading these values
    resource: str
    # True when the columns are text[] — usage counting must unnest
    array: bool = False


STATUS_RECORD_TYPES: list[StatusRecordType] = [
    StatusRecordType("site", "Site",
                     sources=(("sites", "status"),), resource="sites"),
    StatusRecordType("worker", "Worker",
                     sources=(("worker_profiles", "status"),),
                     resource="workers"),
    StatusRecordType("asset", "Asset",
                     sources=(("assets", "status"),
                              ("initiative_assets", "status")),
                     resource="assets"),
    StatusRecordType("container", "Container",
                     sources=(("containers", "status"),),
                     resource="containers"),
    StatusRecordType("container_type", "Container type",
                     sources=(("containers", "container_type"),),
                     resource="containers"),
    StatusRecordType("initiative", "Initiative",
                     sources=(("initiatives", "status"),),
                     resource="initiatives"),
    StatusRecordType("initiative_type", "Initiative type",
                     sources=(("initiatives", "initiative_type"),),
                     resource="initiatives"),
    StatusRecordType("initiative_sub_type", "Initiative sub-type",
                     sources=(("initiatives", "sub_type"),),
                     resource="initiatives"),
    StatusRecordType("initiative_work_type", "Initiative work type",
                     sources=(("initiative_people", "work_type"),),
                     resource="initiatives"),
    StatusRecordType("shipping_type", "Shipping type",
                     sources=(("initiatives", "shipping_types"),),
                     resource="initiatives", array=True),
    StatusRecordType("partner_type", "Partner type",
                     sources=(("partners", "partner_types"),),
                     resource="partners", array=True),
]

STATUS_REGISTRY: dict[str, StatusRecordType] = {
    rt.id: rt for rt in STATUS_RECORD_TYPES}
```

- [ ] **Step 4: Rewrite `_usage_counts`**

In `api/src/serversherpa/api/routes/status_values.py`, replace the `_usage_counts` function (~lines 59–75) with:

```python
async def _usage_counts(db: DbSession, rt: StatusRecordType) -> dict[str, int]:
    """Count referencing rows per key, summed across every source table.
    Table/column come from the frozen code registry, never from user
    input."""
    totals: dict[str, int] = {}
    for tbl, col in rt.sources:
        if rt.array:
            rows = (await db.execute(sqla_text(
                f"SELECT k, count(*) FROM {tbl}, unnest({col}) AS k "
                f"GROUP BY k"))).all()
        else:
            t = table(tbl, column(col))
            rows = (await db.execute(
                select(t.c[col], func.count())
                .group_by(t.c[col]))).all()
        for key, n in rows:
            if key is not None:
                totals[key] = totals.get(key, 0) + n
    return totals
```

- [ ] **Step 5: Repoint the read tests**

In `api/tests/test_status_values_read.py`:

(a) ~line 88: delete `"move_asset_status"` from the expected record-type set (it becomes the same 11-member set as the registry test in Step 1a).

(b) ~line 117: in `test_every_row_includes_progress_weight`'s docstring, change `(everything but move_asset_status, for now)` to `(everything but the asset workflow statuses)`.

(c) ~line 127: rewrite `test_move_asset_status_reads_carry_seeded_weights` to read the merged vocabulary:

```python
async def test_asset_reads_carry_seeded_weights(client, db, seeded_user):
    """Spot-checks a live weighted, a zero weight, an excluded (null)
    workflow status, and a null lifecycle status from the merged asset
    vocabulary, straight off the wire."""
    dev = await _make(db, client, "developer", "devweights@test.example.com")
    rows = (await client.get("/status-values?record_type=asset",
                             headers=dev)).json()
    by_key = {r["key"]: r["progress_weight"] for r in rows}
    assert by_key["loaded_in_system"] == 0
    assert by_key["complete"] == 100
    assert by_key["in_transit"] == 50
    assert by_key["historical"] is None
    assert by_key["active"] is None
```

(Keep whatever assertions the original had beyond these if they still apply — port them to the `asset` record type rather than deleting coverage.)

(d) Add the multi-source usage test at the end of the file:

```python
async def test_asset_usage_counts_span_assets_and_initiative_assets(
        client, db, seeded_user):
    """The merged vocabulary is referenced from assets.status AND
    initiative_assets.status — the Variables page count must be the sum,
    or delete-protection undercounts move usage."""
    from serversherpa.db.models import Asset, Initiative, InitiativeAsset

    hdrs = await _make(db, client, "developer", "devusage@test.example.com")
    a1 = Asset(serial_number="USG-1", name="usage-1", status="staged")
    a2 = Asset(serial_number="USG-2", name="usage-2")
    move = Initiative(name="Usage Move", initiative_type="move")
    db.add_all([a1, a2, move])
    await db.flush()
    db.add(InitiativeAsset(initiative_id=move.id, asset_id=a2.id,
                           status="staged"))
    await db.commit()

    rows = (await client.get("/status-values", headers=hdrs)).json()
    staged = next(r for r in rows
                  if r["record_type"] == "asset" and r["key"] == "staged")
    assert staged["usage_count"] == 2
```

- [ ] **Step 6: Repoint the write tests**

In `api/tests/test_status_values_write.py` (~lines 368–415), in the four progress-weight tests, replace every
`/status-values/move_asset_status/racked` with `/status-values/asset/racked`, every
`/status-values?record_type=move_asset_status` with `/status-values?record_type=asset`, and the audit assertion
`AuditLog.entity_id == "move_asset_status:racked"` with `AuditLog.entity_id == "asset:racked"`. The asserted values (33, None, 422 codes, weight 15 after rejected writes) stay identical — `racked` still seeds weight 15.

Also grep the whole file for any other `move_asset_status` occurrence and repoint the same way:

```bash
grep -n "move_asset_status" api/tests/test_status_values_write.py
```

- [ ] **Step 7: Run the status suites to verify pass**

```bash
cd api && SS_TEST_DB=serversherpa_test_masq .venv/bin/pytest tests/test_status_registry.py tests/test_status_values_read.py tests/test_status_values_write.py tests/test_status_values_model.py -q
```

Expected: PASS, zero failures.

- [ ] **Step 8: Commit**

```bash
git add api/src/serversherpa/status/registry.py api/src/serversherpa/api/routes/status_values.py api/tests/test_status_registry.py api/tests/test_status_values_read.py api/tests/test_status_values_write.py
git commit -m "feat(api): registry usage counts span both asset status tables

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Repoint the initiatives routes

**Files:**
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (~lines 613–632, ~line 740)

**Interfaces:**
- Consumes: Task 1's DB state (asset vocabulary carries the workflow keys).
- Produces: nothing new — behavior-preserving repoint; response shapes unchanged.

- [ ] **Step 1: Run the initiative-asset suite to see the current failures**

```bash
cd api && SS_TEST_DB=serversherpa_test_masq .venv/bin/pytest tests/test_initiative_assets_api.py -q
```

Expected: FAIL — after Task 1, `record_type = 'move_asset_status'` queries return no rows, so status labels fall back to raw keys (e.g. assertion on `status_label == "Loaded In System"` fails) and status writes 422. These pre-existing tests are the failing tests for this task; do not write new ones.

- [ ] **Step 2: Collapse the two status maps in `_initiative_asset_rows`**

In `api/src/serversherpa/api/routes/initiatives.py` (~lines 613–618), replace:

```python
    move_statuses = {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(
            StatusValue.record_type == "move_asset_status"))}
    asset_statuses = {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "asset"))}
```

with:

```python
    # one merged vocabulary (0022) labels both the roster row's own
    # status and the embedded asset's status
    statuses = {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "asset"))}
```

Then in the loop below (~lines 630–632), replace both lookups:
`move_statuses.get(ia.status, ...)` → `statuses.get(ia.status, ...)` and
`asset_statuses.get(asset.status, ...)` → `statuses.get(asset.status, ...)` (keep each line's existing fallback tuple exactly as it is).

- [ ] **Step 3: Repoint the write validation**

In `_check_asset_status` (~line 740), replace `StatusValue.record_type == "move_asset_status"` with `StatusValue.record_type == "asset"`. Keep the rest of the function unchanged.

Then confirm nothing else in the API references the old record type:

```bash
grep -rn "move_asset_status" api/src/
```

Expected: no matches.

- [ ] **Step 4: Run the initiative suites to verify pass**

```bash
cd api && SS_TEST_DB=serversherpa_test_masq .venv/bin/pytest tests/test_initiative_assets_api.py tests/test_initiatives_api.py tests/test_search_initiatives.py -q
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/initiatives.py
git commit -m "feat(api): initiative asset routes read the merged asset vocabulary

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Portal — repoint the detail page fetch

**Files:**
- Modify: `portal/src/lib/api.ts` (~lines 1524–1527)
- Modify: `portal/src/pages/InitiativeDetail.tsx` (~line 34 import, ~lines 353–358 effect)
- Modify: `portal/src/lib/initiatives.ts` (~line 333 comment)
- Test: `portal/src/lib/initiatives.test.ts` (~line 193 fixture)

**Interfaces:**
- Consumes: `listAssetStatuses(): Promise<StatusValue[]>` — already exported from `portal/src/lib/api.ts` (~line 1124), fetches `/status-values?record_type=asset`.
- Produces: `listMoveAssetStatuses` no longer exists; any other reference to it is a compile error caught by `tsc`.

- [ ] **Step 1: Update the fixture (test-first)**

In `portal/src/lib/initiatives.test.ts` (~line 193), in the `statusValue` helper, change `record_type: 'move_asset_status'` to `record_type: 'asset'`. Run:

```bash
cd portal && npm test -- src/lib/initiatives.test.ts
```

Expected: PASS — `moveAssetProgress` maps by key, not record type. This step is fixture hygiene, not a red-green cycle; the real gate for this task is `tsc` failing while any `listMoveAssetStatuses` reference survives.

- [ ] **Step 2: Delete the helper**

In `portal/src/lib/api.ts`, delete the comment and function (~lines 1524–1527):

```typescript
/** Move-asset status vocabulary (record type `move_asset_status`) — feeds
 *  the per-row Status ComboBox on a move's Assets table edit dialog. */
export const listMoveAssetStatuses = () => statusValuesFor('move_asset_status');
```

- [ ] **Step 3: Verify the compiler catches the dangling references**

```bash
cd portal && npx tsc -b
```

Expected: FAIL with errors in `InitiativeDetail.tsx` — `Module '"../lib/api"' has no exported member 'listMoveAssetStatuses'`. (If it passes, a reference was missed — stop and grep.)

- [ ] **Step 4: Repoint the detail page**

In `portal/src/pages/InitiativeDetail.tsx`:

(a) In the import block from `../lib/api` (~line 34), remove `listMoveAssetStatuses,` and ensure `listAssetStatuses,` is present in the same alphabetized import list.

(b) Replace the effect (~lines 353–358):

```typescript
  // Asset status vocabulary (merged: lifecycle + move workflow keys) —
  // only needed for moves, feeds the edit dialog's Status ComboBox below.
  useEffect(() => {
    if (!initiative || initiative.initiative_type !== 'move') return;
    void listAssetStatuses().then(setMoveStatuses).catch(() => {});
  }, [initiative?.id, initiative?.initiative_type]);
```

(c) In `portal/src/lib/initiatives.ts` ~line 333, reword the comment `/** Weighted move progress — each move_asset_status vocabulary value carries` to `/** Weighted move progress — each asset vocabulary value carries` (leave the rest of the comment unchanged).

- [ ] **Step 5: Verify clean build and tests**

```bash
cd portal && npx tsc -b && npm test
```

Expected: tsc clean, all portal tests PASS. Then confirm zero stragglers:

```bash
grep -rn "listMoveAssetStatuses\|move_asset_status" portal/src --include='*.ts' --include='*.tsx' | grep -v -E "StatusEditModal|lib/variables"
```

Expected: no matches (the editor-gate files are Task 5's).

- [ ] **Step 6: Commit**

```bash
git add portal/src/lib/api.ts portal/src/pages/InitiativeDetail.tsx portal/src/lib/initiatives.ts portal/src/lib/initiatives.test.ts
git commit -m "feat(portal): initiative detail reads the merged asset status vocabulary

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Portal — weight editor gates to 'asset'

**Files:**
- Modify: `portal/src/components/variables/StatusEditModal.tsx` (~lines 98, 213)
- Modify: `portal/src/lib/variables.ts` (comments ~lines 89, 176, 196)
- Test: `portal/src/lib/variables.test.ts` (~lines 18–22 fixture, ~line 114 test)

**Interfaces:**
- Consumes: nothing from other tasks (pure gate flip).
- Produces: the Progress weight field renders when editing ANY `asset` status value.

- [ ] **Step 1: Update the test fixtures and naming (test-first)**

In `portal/src/lib/variables.test.ts`:

(a) ~line 18, rename/replace the `moveStatus` fixture — same shape, merged record type:

```typescript
const assetStatus: StatusValue = {
  record_type: 'asset', key: 'racked', label: 'Racked',
  description: '', color: '#273FF5',
  sort_order: 3, is_active: true, usage_count: 12, progress_weight: 15,
};
```

Update every use of `moveStatus` in the file to `assetStatus` (mechanical rename).

(b) ~line 114, retitle the negative test and its comment — the behavior is unchanged, the wording tracked the old gate:

```typescript
  it('never touches progress_weight for a row whose editor hides the field', () => {
    // `value` is a `site` row; its form seeds progress_weight to '' (the
    // field only renders for asset rows, so the form state stays
    // whatever statusFormFromValue seeded). A stale/irrelevant value here
    // must never leak into the patch for an unrelated field edit.
    const form = { ...statusFormFromValue(value), label: 'Scheduled' };
    expect(statusUpdatePayload(form, value)).toEqual({ label: 'Scheduled' });
  });
```

Run:

```bash
cd portal && npm test -- src/lib/variables.test.ts
```

Expected: PASS (payload logic is record-type-agnostic — this is naming hygiene; the gate itself lives in the modal, next step).

- [ ] **Step 2: Flip the modal gates**

In `portal/src/components/variables/StatusEditModal.tsx`:

(a) ~line 98 (submit validation), change:

```typescript
    if (original?.record_type === 'asset'
        && parseProgressWeight(form.progress_weight) === undefined) {
```

(b) ~line 213 (render gate), change:

```typescript
              {original?.record_type === 'asset' && (
```

- [ ] **Step 3: Update the variables.ts comments**

In `portal/src/lib/variables.ts`:

(a) ~line 89 (StatusForm interface), replace the `progress_weight` comment lines:

```typescript
  // asset only (editor gates on record_type); form state is a
  // string, and unlike sort_order an EMPTY string is a *valid* input here
  // (it means "null" — the status is excluded from progress). See
  // parseProgressWeight.
```

(b) ~line 176 (statusCreatePayload comment): change `move_asset_status row` to `asset row`.

(c) ~line 196 (statusUpdatePayload comment): change `Only move_asset_status rows render this field;` to `Only asset rows render this field;`.

- [ ] **Step 4: Verify**

```bash
cd portal && npx tsc -b && npm test
```

Expected: clean and green. Then:

```bash
grep -rn "move_asset_status" portal/src
```

Expected: no matches anywhere in the portal.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/variables/StatusEditModal.tsx portal/src/lib/variables.ts portal/src/lib/variables.test.ts
git commit -m "feat(portal): progress-weight editor gates on the merged asset vocabulary

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Full verification sweep

**Files:** none (verification only; fix-forward anything found, amending the task commit it belongs to).

- [ ] **Step 1: Full API suite**

```bash
cd api && SS_TEST_DB=serversherpa_test_masq .venv/bin/pytest -q
```

Expected: ALL tests pass (~271+). Any failure traces back to a Task 1–3 file — fix there, re-run.

- [ ] **Step 2: Full portal suite + typecheck**

```bash
cd portal && npm test && npx tsc -b
```

Expected: all green, tsc silent.

- [ ] **Step 3: Whole-repo residue check**

```bash
grep -rn "move_asset_status" api/src portal/src
```

Expected: no matches. (Migrations 0019–0021, old specs/plans, and tests of the *migration itself* legitimately keep the string; `api/src` and `portal/src` must not.)

- [ ] **Step 4: Report**

Do NOT migrate the live dev DB and do NOT merge to `feature/initiatives` — the user decides when. Report: branch name, commit list (`git log --oneline feature/initiatives..HEAD`), test totals, and the one-command merge for the user to run from the main checkout when ready.
