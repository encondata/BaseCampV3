# Rack Node Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop chassis nodes at fractional RUs (`33.1`) from being flagged as rack collisions, draw them inside their chassis, add an `orphan_node` review status and a re-check action, add a model `form_factor`, and normalize make/model lookup keys.

**Architecture:** One pure placement rule (`serversherpa.racks.placement`) is shared by the importer, the Move Report and a new re-check endpoint, so the three cannot drift. The portal's `rackLayout()` gains the same slot awareness and, because the report's Node renderer reuses that portal code, the PDF drawing follows for free. Migration 0068 adds `asset_models.form_factor` and the `orphan_node` status; the form factor enriches the rule and the rail report but the rule never depends on it.

**Tech Stack:** Python 3.13, FastAPI, SQLAlchemy 2 async, Alembic, pytest (asyncio auto). React 18, TypeScript, Vite, Vitest with jsdom.

**Spec:** `docs/superpowers/specs/2026-09-21-rack-node-slots-design.md`

## Global Constraints

- Work in the git worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/rack-nodes`, branch `rack-node-slots`. Run every command from that directory. Never `cd` to the primary checkout.
- `api/.venv` and `portal/node_modules` in the worktree are symlinks to the primary checkout. Never `npm install` or `pip install` in the worktree. Never commit `api/src/serversherpa/_dev_reload.py`.
- API tests: always `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest <files> -q`. The `SS_TEST_DB` value gives this branch its own test database (created on first run and migrated to this branch's head), so the branch's migration 0068 never clashes with the shared database `main` uses. `PYTHONPATH=api/src` is required or the venv's editable install imports the primary checkout's code instead of the worktree's. Run one pytest process at a time. Run targeted files per task; the full API suite (about 20 minutes) runs once, in Task 13.
- Portal tests: always the whole suite plus the type check, both from the worktree root: `npm --prefix portal run test` (about 20 seconds) and `npm --prefix portal exec -- tsc --noEmit`.
- Migration number: `0068`, `down_revision = "0067"`. Confirmed free across every worktree and the dev database.
- Status keys are `loaded_in_system`, `location_collision`, `orphan_node`. Placement statuses are only ever applied to rows whose current status is one of those three; a progressed row is never touched. They are set directly, never through `record_status_edit`.
- Form factor values: `standalone`, `chassis`, `node`. Null means unknown and behaves as `standalone`.
- Collision kinds after this work: `ru_overlap`, `slot_conflict`. The kind `ru_and_slot_conflict` is retired. Orphan reasons: `no_chassis`, `form_factor_mismatch`.
- American English in all copy, comments and docs. Commit after every task with the attribution line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Ledger: append one line per task to `.superpowers/sdd/progress.md` in the worktree (create it if absent).

---

## File Structure

| File | Responsibility |
|---|---|
| `api/src/serversherpa/racks/__init__.py` | new package |
| `api/src/serversherpa/racks/placement.py` | the pure placement rule: `place()`, `evaluate()`, `Placed`, `Conflict`, `Orphan`, `PlacementResult` |
| `api/src/serversherpa/racks/recheck.py` | `recheck_placement(db, initiative_id)`: loads a roster, runs the rule, applies status transitions |
| `api/src/serversherpa/imports/move_assets.py` | importer calls `recheck_placement`; `flag_collisions` removed; `normalize_model_key` added and used for lookups |
| `api/src/serversherpa/reports/move_report/compute.py` | `collisions()` delegates to the rule; `CollisionReport.orphans`; `rail_summary` skips nodes |
| `api/src/serversherpa/reports/move_report/gather.py` | `MoveAsset.form_factor` |
| `api/src/serversherpa/reports/move_report/render.py` | labels for the surviving kinds and the orphan reasons |
| `api/src/serversherpa/reports/move_report/templates/move_report.html` | orphan table under the collision table |
| `api/src/serversherpa/api/routes/initiatives.py` | `POST /{id}/assets/recheck-placement` |
| `api/src/serversherpa/api/routes/asset_models.py` | `FORM_FACTORS`, validation, output |
| `api/src/serversherpa/api/schemas.py` | `PlacementRecheckOut`; `form_factor` on the model schemas |
| `api/src/serversherpa/db/models.py` | `AssetModel.form_factor` |
| `api/migrations/versions/0068_model_form_factor_and_orphan_status.py` | column, check constraint, status seed, name-based backfill |
| `api/tests/conftest.py` | `orphan_node` in the canonical asset status seed |
| `portal/src/lib/initiatives.ts` | `ruSlot()`, `RackChild`, slot-aware `rackLayout()`, `deviceListRows()` with children and orphans |
| `portal/src/components/initiatives/RackElevation.tsx` | child pills, orphan marker, `onHoverChild`, `tooltipRows` additions |
| `portal/src/components/initiatives/RackViewModal.tsx` | child hover state and tooltip |
| `portal/src/components/initiatives/RackDeviceList.tsx` | indented child rows, orphan rows |
| `portal/src/lib/rackPrint.ts` | indented child rows on the print sheet |
| `portal/src/styles/rack-svg.css`, `portal/src/styles/initiatives.css` | pill label, child and orphan list styling |
| `portal/src/lib/api.ts` | `recheckInitiativePlacement()`, `PlacementRecheck`, `form_factor` on `AssetModelItem` |
| `portal/src/pages/InitiativeDetail.tsx` | "Re-check placement" action |
| `portal/src/lib/assets.ts`, `portal/src/components/assets/ModelEditModal.tsx`, `portal/src/pages/AssetModels.tsx` | form factor field, column, chip, errors |

---

### Task 1: The placement rule

**Files:**
- Create: `api/src/serversherpa/racks/__init__.py`
- Create: `api/src/serversherpa/racks/placement.py`
- Test: `api/tests/test_rack_placement.py`

**Interfaces:**
- Produces: `place(key: str, label: str, rack: str, ru: float | Decimal, height: int | None, form_factor: str | None = None) -> Placed`; `evaluate(rows: list[Placed]) -> PlacementResult` with `.conflicts: list[Conflict]`, `.orphans: list[Orphan]`, `.checked: int`, `.colliding_keys: set[str]`, `.orphan_keys: set[str]`. `Conflict` has `rack, kind, a, b, overlapping_rus, slot`. `Orphan` has `rack, row, reason`. `Placed` has `key, label, rack, base, slot, height, form_factor` and properties `is_slot`, `span`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_rack_placement.py
"""The rack placement rule (spec: docs/superpowers/specs/2026-09-21-rack-
node-slots-design.md, "The placement rule"). Pure, no DB. Every row of
the rule table has a case here; the example initiative's rack is the
last one."""

from serversherpa.racks.placement import evaluate, place


def _p(key, ru, height=1, rack="R1", form_factor=None):
    return place(key=key, label=key, rack=rack, ru=ru, height=height,
                 form_factor=form_factor)


def _kinds(result):
    return sorted((c.a.key, c.b.key, c.kind) for c in result.conflicts)


def _orphans(result):
    return sorted((o.row.key, o.reason) for o in result.orphans)


def test_place_splits_base_and_slot_and_defaults_height():
    p = _p("a", 33.4, height=None)
    assert (p.base, p.slot, p.height) == (33, 4, 1)
    assert p.is_slot and p.span == frozenset()
    q = _p("b", 10, height=4)
    assert (q.base, q.slot, q.height) == (10, 0, 4)
    assert not q.is_slot and q.span == frozenset({10, 11, 12, 13})


def test_place_accepts_decimal_and_rounds_slot():
    from decimal import Decimal
    assert _p("a", Decimal("5.3")).slot == 3
    assert _p("a", 5.30000001).slot == 3


def test_two_spans_sharing_an_ru_overlap():
    r = evaluate([_p("a", 10, 2), _p("b", 11), _p("c", 30)])
    assert _kinds(r) == [("a", "b", "ru_overlap")]
    assert r.conflicts[0].overlapping_rus == [11]
    assert r.colliding_keys == {"a", "b"} and r.checked == 3


def test_slot_zero_is_never_a_slot_conflict():
    r = evaluate([_p("a", 5), _p("b", 5)])
    assert _kinds(r) == [("a", "b", "ru_overlap")]
    assert r.conflicts[0].slot is None


def test_nodes_inside_a_chassis_are_contained_not_colliding():
    rows = [_p("chassis", 33, 4)] + [_p(f"n{i}", 33 + i / 10) for i in (1, 2, 3, 4)]
    r = evaluate(rows)
    assert r.conflicts == [] and r.orphans == []
    assert r.colliding_keys == set() and r.orphan_keys == set()


def test_containment_holds_even_when_chassis_height_is_unknown():
    r = evaluate([_p("chassis", 33, None), _p("n1", 33.1), _p("n2", 33.2)])
    assert r.conflicts == [] and r.orphans == []


def test_two_nodes_in_the_same_slot_are_a_slot_conflict():
    r = evaluate([_p("chassis", 20), _p("x", 20.1), _p("y", 20.1)])
    assert _kinds(r) == [("x", "y", "slot_conflict")]
    c = r.conflicts[0]
    assert c.slot == 1 and c.overlapping_rus == [20]
    assert r.orphans == []


def test_node_with_nothing_at_its_base_is_an_orphan_not_a_collision():
    r = evaluate([_p("n", 20.1), _p("other", 30)])
    assert r.conflicts == []
    assert _orphans(r) == [("n", "no_chassis")]
    assert r.orphan_keys == {"n"}


def test_node_whose_base_is_covered_from_below_collides_and_is_orphaned():
    # a 2U server at 32 reaches into 33; the node at 33.1 claims a chassis
    # that is not there, so it collides with the server AND has no chassis
    r = evaluate([_p("srv", 32, 2), _p("n", 33.1)])
    assert _kinds(r) == [("n", "srv", "ru_overlap")]
    assert r.conflicts[0].overlapping_rus == [33]
    assert _orphans(r) == [("n", "no_chassis")]


def test_node_contained_by_chassis_but_also_covered_from_below():
    r = evaluate([_p("srv", 32, 2), _p("chassis", 33, 4), _p("n", 33.1)])
    assert _kinds(r) == [("chassis", "srv", "ru_overlap"), ("n", "srv", "ru_overlap")]
    assert r.orphans == []


def test_racks_are_independent_and_rows_without_placement_are_not_here():
    r = evaluate([_p("a", 10, rack="R1"), _p("b", 10, rack="R2")])
    assert r.conflicts == [] and r.checked == 2


def test_half_ru_reads_as_slot_five_and_orphans_without_a_base_device():
    r = evaluate([_p("san", 3.5)])
    assert _orphans(r) == [("san", "no_chassis")]


def test_form_factor_mismatches():
    r = evaluate([
        _p("chassis", 10, 4, form_factor="chassis"),
        _p("ok_node", 10.1, form_factor="node"),
        _p("bad_node", 10.2, form_factor="standalone"),   # standalone at a slot
        _p("loose", 20, form_factor="node"),               # node at an integer RU
    ])
    assert r.conflicts == []
    assert _orphans(r) == [("bad_node", "form_factor_mismatch"),
                           ("loose", "form_factor_mismatch")]


def test_form_factor_never_changes_spans():
    # a chassis-flagged 4U row still spans four RUs; a node-flagged row at an
    # integer RU still spans one and can still overlap
    r = evaluate([_p("chassis", 10, 4, form_factor="chassis"),
                  _p("loose", 12, form_factor="node")])
    assert _kinds(r) == [("chassis", "loose", "ru_overlap")]


def test_example_rack_from_the_las_vegas_cluster_move():
    rows = []
    for base, nodes in ((1, 4), (5, 4), (9, 4), (13, 4), (17, 4),
                        (21, 4), (25, 2), (29, 2), (33, 4)):
        rows.append(_p(f"chassis{base}", base, None))
        rows += [_p(f"node{base}.{i}", base + i / 10) for i in range(1, nodes + 1)]
    rows += [_p("switch45", 45), _p("brush47", 47), _p("sw48", 48),
             _p("sw49", 49), _p("sw51", 51)]
    r = evaluate(rows)
    assert r.checked == 46
    assert r.conflicts == [] and r.orphans == []
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_rack_placement.py -q`
Expected: collection error, `ModuleNotFoundError: No module named 'serversherpa.racks'`.

- [ ] **Step 3: Write the rule**

`api/src/serversherpa/racks/__init__.py` is an empty file.

```python
# api/src/serversherpa/racks/placement.py
"""The rack placement rule, shared by the move-assets importer, the Move
Report and the re-check endpoint so the three cannot drift.

A roster row at an integer RU occupies a span (base .. base + height - 1)
in slot 0. A row at a fractional RU `N.x` is a node in slot x of RU N: it
occupies that one cell and contributes no span. Two spans that share an
RU are an `ru_overlap`. Two nodes at the same base and slot are a
`slot_conflict`. A node whose base RU is the START of a span is contained
by it. A node whose base RU is covered by a span that starts elsewhere
collides with that span (it claims a chassis that is not there). A node
with no span starting at its base is an orphan. Slot 0 is never a slot
conflict.

The model form factor only adds orphan reasons: a `standalone` row at a
slot, or a `node` row at an integer RU, is a `form_factor_mismatch`. It
never changes what a row occupies.

Design: docs/superpowers/specs/2026-09-21-rack-node-slots-design.md
"""

from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal
from itertools import combinations
from math import floor

RU_OVERLAP = "ru_overlap"
SLOT_CONFLICT = "slot_conflict"
NO_CHASSIS = "no_chassis"
FORM_FACTOR_MISMATCH = "form_factor_mismatch"


@dataclass(frozen=True)
class Placed:
    key: str
    label: str
    rack: str
    base: int
    slot: int
    height: int
    form_factor: str | None = None

    @property
    def is_slot(self) -> bool:
        return self.slot > 0

    @property
    def span(self) -> frozenset[int]:
        if self.is_slot:
            return frozenset()
        return frozenset(range(self.base, self.base + self.height))


def place(key: str, label: str, rack: str, ru: float | Decimal, height: int | None,
          form_factor: str | None = None) -> Placed:
    raw = float(ru)
    base = floor(raw)
    slot = round((raw - base) * 10)
    return Placed(key=key, label=label, rack=rack, base=base, slot=slot,
                  height=max(1, int(height or 1)), form_factor=form_factor)


@dataclass(frozen=True)
class Conflict:
    rack: str
    kind: str                  # RU_OVERLAP | SLOT_CONFLICT
    a: Placed
    b: Placed
    overlapping_rus: list[int]
    slot: int | None           # set for SLOT_CONFLICT


@dataclass(frozen=True)
class Orphan:
    rack: str
    row: Placed
    reason: str                # NO_CHASSIS | FORM_FACTOR_MISMATCH


@dataclass(frozen=True)
class PlacementResult:
    conflicts: list[Conflict] = field(default_factory=list)
    orphans: list[Orphan] = field(default_factory=list)
    checked: int = 0

    @property
    def colliding_keys(self) -> set[str]:
        return {p.key for c in self.conflicts for p in (c.a, c.b)}

    @property
    def orphan_keys(self) -> set[str]:
        return {o.row.key for o in self.orphans}


def _pair(rack: str, pa: Placed, pb: Placed) -> Conflict | None:
    if not pa.is_slot and not pb.is_slot:
        overlap = pa.span & pb.span
        if overlap:
            return Conflict(rack, RU_OVERLAP, pa, pb, sorted(overlap), None)
        return None
    if pa.is_slot and pb.is_slot:
        if pa.base == pb.base and pa.slot == pb.slot:
            return Conflict(rack, SLOT_CONFLICT, pa, pb, [pa.base], pa.slot)
        return None
    node, span_row = (pa, pb) if pa.is_slot else (pb, pa)
    if node.base in span_row.span and span_row.base != node.base:
        return Conflict(rack, RU_OVERLAP, pa, pb, [node.base], None)
    return None


def evaluate(rows: list[Placed]) -> PlacementResult:
    racks: dict[str, list[Placed]] = defaultdict(list)
    for r in rows:
        racks[r.rack].append(r)
    conflicts: list[Conflict] = []
    orphans: list[Orphan] = []
    for rack in sorted(racks):
        placed = sorted(racks[rack], key=lambda p: (p.base, p.slot, p.label, p.key))
        starts = {p.base for p in placed if not p.is_slot}
        for pa, pb in combinations(placed, 2):
            c = _pair(rack, pa, pb)
            if c is not None:
                conflicts.append(c)
        for p in placed:
            if p.is_slot:
                if p.base not in starts:
                    orphans.append(Orphan(rack, p, NO_CHASSIS))
                elif p.form_factor == "standalone":
                    orphans.append(Orphan(rack, p, FORM_FACTOR_MISMATCH))
            elif p.form_factor == "node":
                orphans.append(Orphan(rack, p, FORM_FACTOR_MISMATCH))
    return PlacementResult(conflicts=conflicts, orphans=orphans, checked=len(rows))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_rack_placement.py -q`
Expected: `15 passed`.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/racks api/tests/test_rack_placement.py
git commit -m "feat(racks): shared slot-aware placement rule (nodes at N.x live inside the device at N)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: The importer uses the rule; `orphan_node` status; `recheck_placement`

**Files:**
- Create: `api/src/serversherpa/racks/recheck.py`
- Modify: `api/src/serversherpa/imports/move_assets.py:379-431` (replace the `flag_collisions` call and delete the function)
- Modify: `api/tests/conftest.py:249` (add the `orphan_node` row to the asset status seed)
- Modify: `api/tests/test_move_asset_import_commit.py:15-17,144-167`
- Test: `api/tests/test_rack_recheck.py`

**Interfaces:**
- Consumes: `place`, `evaluate` from Task 1.
- Produces: `recheck_placement(db: AsyncSession, initiative_id: uuid.UUID) -> dict` returning `{"checked": int, "collisions": int, "orphans": int, "cleared": int}`. The caller owns the commit. `run_import`'s summary gains `orphans_flagged` next to `collisions_flagged`.

- [ ] **Step 1: Seed the new status in the test harness**

In `api/tests/conftest.py`, the asset vocabulary INSERT ends at line 249 with the `location_collision` row. Change that line so the list ends:

```sql
              ('asset','location_collision','Location Collision','','#ff0000',0,NULL),
              ('asset','orphan_node','Orphan node','A node (fractional RU) with no device starting at its RU. Review the rack position.','#d97706',0,NULL)
```

(The comma after the `location_collision` row is new; the `orphan_node` row is new.)

- [ ] **Step 2: Write the failing tests**

Update the import at `api/tests/test_move_asset_import_commit.py:15-17` to drop `flag_collisions`:

```python
from serversherpa.imports.move_assets import (
    parse_row, run_import,
)
```

Replace `test_collision_detection_flags_overlaps` (lines 144-167) with these three tests:

```python
async def test_collision_detection_flags_overlaps(db):
    ini = await _move(db)
    model = AssetModel(make="Big", model="4U", ru_size=4)
    db.add(model)
    await db.commit()
    rows = [
        _row(2, serial_number="SN-A", asset_make="Big", asset_model="4U",
             destination_rack="R1", destination_ru="10"),    # RUs 10-13
        _row(3, serial_number="SN-B",
             destination_rack="R1", destination_ru="12"),    # RU 12 (size 1)
        _row(4, serial_number="SN-C",
             destination_rack="R1", destination_ru="30"),    # clear
        _row(5, serial_number="SN-D",
             destination_rack="R2", destination_ru="12"),    # other rack
    ]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True)
    assert result["summary"]["collisions_flagged"] == 2
    assert result["summary"]["orphans_flagged"] == 0
    statuses = dict((await db.execute(
        select(Asset.serial_number, InitiativeAsset.status)
        .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id))).all())
    assert statuses["sn-a"] == "location_collision"
    assert statuses["sn-b"] == "location_collision"
    assert statuses["sn-c"] == "loaded_in_system"
    assert statuses["sn-d"] == "loaded_in_system"


async def test_nodes_inside_a_chassis_are_not_collisions(db):
    """The example initiative's shape: a chassis at an integer RU with
    nodes at .1 to .4 under it. Neither model carries an ru_size, exactly
    as the import force-creates them."""
    ini = await _move(db)
    rows = [_row(2, serial_number="CH-33", asset_make="Dell",
                 asset_model="Isilon H5600",
                 destination_rack="R1", destination_ru="33")]
    rows += [_row(2 + i, serial_number=f"ND-33-{i}", asset_make="Dell",
                  asset_model="H5600 node",
                  destination_rack="R1", destination_ru=f"33.{i}")
             for i in (1, 2, 3, 4)]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, make_model_mode="force", write=True)
    assert result["summary"]["collisions_flagged"] == 0
    assert result["summary"]["orphans_flagged"] == 0
    statuses = set(await db.scalars(select(InitiativeAsset.status)))
    assert statuses == {"loaded_in_system"}


async def test_node_without_a_chassis_is_flagged_orphan(db):
    ini = await _move(db)
    rows = [_row(2, serial_number="ND-1", destination_rack="R1",
                 destination_ru="20.1"),
            _row(3, serial_number="SRV-1", destination_rack="R1",
                 destination_ru="30")]
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=rows, write=True)
    assert result["summary"]["collisions_flagged"] == 0
    assert result["summary"]["orphans_flagged"] == 1
    statuses = dict((await db.execute(
        select(Asset.serial_number, InitiativeAsset.status)
        .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id))).all())
    assert statuses["nd-1"] == "orphan_node"
    assert statuses["srv-1"] == "loaded_in_system"
```

Create `api/tests/test_rack_recheck.py`:

```python
"""recheck_placement: applies the placement rule to a roster and moves
rows between loaded_in_system / location_collision / orphan_node without
ever touching a row that has progressed past those three."""

from decimal import Decimal

from sqlalchemy import select

from serversherpa.db.models import Asset, AssetModel, Initiative, InitiativeAsset
from serversherpa.racks.recheck import recheck_placement


async def _roster(db, *specs):
    """specs: (serial, status, rack, ru, ru_size_or_None)"""
    ini = Initiative(name="Move R", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    out = {}
    for serial, status, rack, ru, size in specs:
        model = None
        if size is not None:
            model = AssetModel(make="M", model=f"{serial}-model", ru_size=size)
            db.add(model)
            await db.flush()
        asset = Asset(serial_number=serial, name=serial,
                      model_id=model.id if model else None)
        db.add(asset)
        await db.flush()
        ia = InitiativeAsset(initiative_id=ini.id, asset_id=asset.id, status=status,
                             destination_rack=rack,
                             destination_ru=Decimal(str(ru)) if ru is not None else None)
        db.add(ia)
        out[serial] = ia
    await db.commit()
    return ini, out


async def _statuses(db, ini):
    rows = (await db.execute(
        select(Asset.serial_number, InitiativeAsset.status)
        .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id)
        .where(InitiativeAsset.initiative_id == ini.id))).all()
    return dict(rows)


async def test_flags_collisions_and_orphans_and_reports_counts(db):
    ini, _ = await _roster(
        db,
        ("big", "loaded_in_system", "R1", 10, 4),
        ("hit", "loaded_in_system", "R1", 12, None),
        ("node", "loaded_in_system", "R1", 20.1, None),
        ("free", "loaded_in_system", "R1", 30, None),
        ("nowhere", "loaded_in_system", None, None, None),
    )
    result = await recheck_placement(db, ini.id)
    await db.commit()
    assert result == {"checked": 4, "collisions": 2, "orphans": 1, "cleared": 0}
    assert await _statuses(db, ini) == {
        "big": "location_collision", "hit": "location_collision",
        "node": "orphan_node", "free": "loaded_in_system",
        "nowhere": "loaded_in_system"}


async def test_a_progressed_row_is_never_dragged_back(db):
    ini, _ = await _roster(
        db,
        ("racked", "racked", "R1", 10, 4),
        ("hit", "loaded_in_system", "R1", 12, None),
    )
    result = await recheck_placement(db, ini.id)
    await db.commit()
    # the racked row IS in a collision but keeps its status and is not counted
    assert result["collisions"] == 1
    assert await _statuses(db, ini) == {"racked": "racked", "hit": "location_collision"}


async def test_clears_stale_flags_when_the_condition_is_gone(db):
    ini, rows = await _roster(
        db,
        ("a", "location_collision", "R1", 10, None),
        ("b", "location_collision", "R1", 30, None),
        ("n", "orphan_node", "R1", 10.1, None),          # now contained by "a"
        ("moved", "location_collision", None, None, None),   # no placement any more
    )
    result = await recheck_placement(db, ini.id)
    await db.commit()
    assert result == {"checked": 3, "collisions": 0, "orphans": 0, "cleared": 4}
    assert set((await _statuses(db, ini)).values()) == {"loaded_in_system"}


async def test_collision_wins_over_orphan_for_the_same_row(db):
    ini, _ = await _roster(
        db,
        ("srv", "loaded_in_system", "R1", 32, 2),
        ("node", "loaded_in_system", "R1", 33.1, None),
    )
    result = await recheck_placement(db, ini.id)
    await db.commit()
    assert result["collisions"] == 2 and result["orphans"] == 0
    assert (await _statuses(db, ini))["node"] == "location_collision"
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_rack_recheck.py api/tests/test_move_asset_import_commit.py -q`
Expected: `test_rack_recheck.py` errors with `ModuleNotFoundError: No module named 'serversherpa.racks.recheck'`; the two new importer tests fail on `KeyError: 'orphans_flagged'` or on the status assertions.

- [ ] **Step 4: Write `recheck_placement`**

```python
# api/src/serversherpa/racks/recheck.py
"""Apply the placement rule to one move's roster and move rows between the
three placement statuses. Called by the importer after its commit pass
and by POST /initiatives/{id}/assets/recheck-placement.

Only rows currently in one of RESETTABLE are ever restated; a row that
has progressed (labeled, racked, complete ...) keeps its status and is
not counted, even if it sits in a collision. A row in any conflict gets
COLLISION; a row that is only an orphan gets ORPHAN; a flagged row whose
condition is gone goes back to CLEAR. Statuses are set directly, the
same way the importer always has; this is not a manual status edit and
does not go through record_status_edit. The caller owns the commit.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Asset, AssetModel, InitiativeAsset
from serversherpa.racks.placement import Placed, evaluate, place

CLEAR = "loaded_in_system"
COLLISION = "location_collision"
ORPHAN = "orphan_node"
RESETTABLE = frozenset({CLEAR, COLLISION, ORPHAN})


async def recheck_placement(db: AsyncSession, initiative_id: uuid.UUID) -> dict:
    rows = (await db.execute(
        select(InitiativeAsset, Asset.name, Asset.serial_number, AssetModel.ru_size)
        .join(Asset, Asset.id == InitiativeAsset.asset_id)
        .outerjoin(AssetModel, AssetModel.id == Asset.model_id)
        .where(InitiativeAsset.initiative_id == initiative_id))).all()

    placed: list[Placed] = []
    for ia, name, serial, ru_size in rows:
        if ia.destination_rack and ia.destination_ru is not None:
            placed.append(place(key=str(ia.id), label=name or serial or "",
                                rack=ia.destination_rack, ru=ia.destination_ru,
                                height=ru_size))
    result = evaluate(placed)
    colliding = result.colliding_keys
    orphaned = result.orphan_keys - colliding

    collisions = orphans = cleared = 0
    for ia, *_ in rows:
        key = str(ia.id)
        want = COLLISION if key in colliding else ORPHAN if key in orphaned else None
        if want is None:
            if ia.status in (COLLISION, ORPHAN):
                ia.status = CLEAR
                cleared += 1
            continue
        if ia.status in RESETTABLE:
            ia.status = want
        if ia.status == COLLISION:
            collisions += 1
        elif ia.status == ORPHAN:
            orphans += 1
    return {"checked": result.checked, "collisions": collisions,
            "orphans": orphans, "cleared": cleared}
```

- [ ] **Step 5: Wire the importer and delete its private copy**

In `api/src/serversherpa/imports/move_assets.py`, replace lines 379-381:

```python
    if write and not cancelled:
        placement = await recheck_placement(db, initiative_id)
        summary["collisions_flagged"] = placement["collisions"]
        summary["orphans_flagged"] = placement["orphans"]
```

Add the import near the top of the file, after the `serversherpa.db.models` import:

```python
from serversherpa.racks.recheck import recheck_placement
```

Delete `flag_collisions` entirely (lines 392-431, from `async def flag_collisions(` to `return len(colliding)`). Update the module docstring line 6 from `and collision detection (flag_collisions).` to `and the post-commit placement re-check (serversherpa.racks.recheck).`

- [ ] **Step 6: Run the tests to verify they pass**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_rack_recheck.py api/tests/test_move_asset_import_commit.py api/tests/test_rack_placement.py -q`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/racks/recheck.py api/src/serversherpa/imports/move_assets.py api/tests/conftest.py api/tests/test_move_asset_import_commit.py api/tests/test_rack_recheck.py
git commit -m "feat(imports): placement re-check replaces flag_collisions; orphan_node status for nodes with no chassis

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: The Move Report uses the rule and lists orphans

**Files:**
- Modify: `api/src/serversherpa/reports/move_report/compute.py:118-185`
- Modify: `api/src/serversherpa/reports/move_report/render.py:45-46`
- Modify: `api/src/serversherpa/reports/move_report/templates/move_report.html:139-156`
- Modify: `api/tests/test_move_report_compute.py:55-79`
- Modify: `api/tests/test_move_report_render.py:80-82`

**Interfaces:**
- Consumes: `place`, `evaluate` from Task 1.
- Produces: `CollisionReport.orphans: list[OrphanRow]` where `OrphanRow(rack: str, asset: Placement, reason: str)`; `Placement` keeps `asset`, `base`, `slot`, `name` and gains `ru_text: str` (`"33"` or `"33.1"`). `Collision.collision_type` is `ru_overlap` or `slot_conflict` only. `render.py` exposes `ORPHAN_LABELS` and `ReportContext.orphan_label(reason)`.

- [ ] **Step 1: Write the failing tests**

In `api/tests/test_move_report_compute.py`, replace lines 55-79 (both collision tests) with:

```python
def test_collisions_overlap_slot_conflict_and_orphans():
    a = _asset(row_id="a", name="a", ru_size=2, destination_rack="R1", destination_ru=10)
    b = _asset(row_id="b", name="b", ru_size=1, destination_rack="R1", destination_ru=11)   # overlaps a's top RU
    c = _asset(row_id="c", name="c", ru_size=1, destination_rack="R1", destination_ru=20.1)
    d = _asset(row_id="d", name="d", ru_size=1, destination_rack="R1", destination_ru=20.1)  # same slot, no chassis
    e = _asset(row_id="e", name="e", ru_size=1, destination_rack="R2", destination_ru=10)    # other rack
    f = _asset(row_id="f", name="f", ru_size=1, destination_rack=None, destination_ru=10)    # no rack
    g = _asset(row_id="g", name="g", ru_size=4, destination_rack="R1", destination_ru=30)
    h = _asset(row_id="h", name="h", ru_size=1, destination_rack="R1", destination_ru=33)   # partial overlap at g's top
    rep = collisions([a, b, c, d, e, f, g, h])
    assert rep.assets_checked == 7                      # f has no rack
    kinds = {(x.asset_a.name, x.asset_b.name): x.collision_type for x in rep.items}
    assert kinds == {("a", "b"): "ru_overlap", ("c", "d"): "slot_conflict",
                     ("g", "h"): "ru_overlap"}
    ab = next(x for x in rep.items if x.asset_a.name == "a")
    assert ab.rack == "R1" and ab.overlapping_rus == [11]
    cd = next(x for x in rep.items if x.asset_a.name == "c")
    assert cd.slot_conflict == 1 and cd.asset_a.ru_text == "20.1"
    assert rep.collision_count == 3 and rep.assets_flagged == 6
    assert [(o.asset.name, o.reason) for o in rep.orphans] == [("c", "no_chassis"),
                                                               ("d", "no_chassis")]


def test_nodes_inside_a_chassis_do_not_collide_or_orphan():
    chassis = _asset(row_id="ch", name="ch", ru_size=4, destination_rack="R1", destination_ru=33)
    nodes = [_asset(row_id=f"n{i}", name=f"n{i}", ru_size=None, destination_rack="R1",
                    destination_ru=33 + i / 10) for i in (1, 2, 3, 4)]
    rep = collisions([chassis, *nodes])
    assert rep.items == [] and rep.orphans == []
    assert rep.assets_checked == 5


def test_collisions_slot_zero_is_plain_overlap():
    # slot 0 (integer RU) is never a "slot conflict" — plain overlap only
    a = _asset(row_id="a", name="a", destination_rack="R1", destination_ru=5)
    b = _asset(row_id="b", name="b", destination_rack="R1", destination_ru=5)
    [x] = collisions([a, b]).items
    assert x.collision_type == "ru_overlap" and x.slot_conflict is None
```

In `api/tests/test_move_report_render.py`, after `test_collision_section_says_none_when_clean` (line 82) add:

```python
def test_collision_section_lists_orphan_nodes():
    html = render_html(_ctx(assets=[_asset(1, destination_ru=20.0),
                                    _asset(2, destination_ru=31.2)]))
    assert "No collisions" in html
    assert "Orphan nodes" in html
    assert "web-02" in html and "31.2" in html
    assert "No device starts at this RU" in html
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_move_report_compute.py api/tests/test_move_report_render.py -q`
Expected: the three compute tests fail (`ru_and_slot_conflict`, missing `orphans`, missing `ru_text`); the render test fails on `"Orphan nodes"`.

- [ ] **Step 3: Rewrite the collision section of `compute.py`**

Replace lines 118-185 of `api/src/serversherpa/reports/move_report/compute.py` (from `@dataclass(frozen=True)\nclass Placement:` through the end of `collisions()`) with:

```python
@dataclass(frozen=True)
class Placement:
    asset: MoveAsset
    base: int
    slot: int

    @property
    def name(self) -> str:
        return self.asset.label

    @property
    def ru_text(self) -> str:
        return f"{self.base}.{self.slot}" if self.slot else str(self.base)


@dataclass(frozen=True)
class Collision:
    rack: str
    collision_type: str            # ru_overlap | slot_conflict
    overlapping_rus: list[int]
    slot_conflict: int | None
    asset_a: Placement
    asset_b: Placement


@dataclass(frozen=True)
class OrphanRow:
    rack: str
    asset: Placement
    reason: str                    # no_chassis | form_factor_mismatch


@dataclass(frozen=True)
class CollisionReport:
    items: list[Collision] = field(default_factory=list)
    orphans: list[OrphanRow] = field(default_factory=list)
    assets_checked: int = 0

    @property
    def collision_count(self) -> int:
        return len(self.items)

    @property
    def assets_flagged(self) -> int:
        return len({p.asset.row_id for c in self.items for p in (c.asset_a, c.asset_b)})


def collisions(assets: list[MoveAsset]) -> CollisionReport:
    """Destination-side only (V2 semantics). The rule itself lives in
    serversherpa.racks.placement and is shared with the importer and the
    re-check endpoint; this only maps MoveAsset rows in and out."""
    placed: dict[str, tuple[MoveAsset, Placed]] = {}
    for a in assets:
        if a.destination_rack and a.destination_ru is not None:
            placed[a.row_id] = (a, place(key=a.row_id, label=a.label, rack=a.destination_rack,
                                         ru=a.destination_ru, height=_ru(a),
                                         form_factor=a.form_factor))
    result = evaluate([p for _, p in placed.values()])

    def wrap(p: Placed) -> Placement:
        return Placement(asset=placed[p.key][0], base=p.base, slot=p.slot)

    items = [Collision(rack=c.rack, collision_type=c.kind,
                       overlapping_rus=list(c.overlapping_rus), slot_conflict=c.slot,
                       asset_a=wrap(c.a), asset_b=wrap(c.b)) for c in result.conflicts]
    orphans = [OrphanRow(rack=o.rack, asset=wrap(o.row), reason=o.reason)
               for o in result.orphans]
    return CollisionReport(items=items, orphans=orphans, assets_checked=result.checked)
```

Add to the imports at the top of `compute.py` (after `from math import floor`, which can now be removed):

```python
from serversherpa.racks.placement import Placed, evaluate, place
```

`MoveAsset.form_factor` does not exist until Task 11. Until then, use `getattr(a, "form_factor", None)` in the `place(...)` call above; Task 11 replaces it with `a.form_factor`.

- [ ] **Step 4: Labels and the template**

In `api/src/serversherpa/reports/move_report/render.py` replace lines 45-46:

```python
COLLISION_LABELS = {"ru_overlap": "RU overlap", "slot_conflict": "Slot conflict"}
ORPHAN_LABELS = {"no_chassis": "No device starts at this RU",
                 "form_factor_mismatch": "Model form factor does not match its position"}
```

In the `ReportContext` class, next to the existing `collision_label` method, add:

```python
    def orphan_label(self, reason: str) -> str:
        return ORPHAN_LABELS.get(reason, reason)
```

In `move_report.html`, replace line 156 (`{% else %}<p class="note">No collisions.</p>{% endif %}`) with:

```html
  {% else %}<p class="note">No collisions.</p>{% endif %}
  {% if ctx.collisions.orphans %}
  <h3>Orphan nodes</h3>
  <p class="note">A node (fractional RU) is expected to sit inside a device that starts at its RU. These do not.</p>
  <table>
    <thead><tr><th>Rack</th><th>Asset</th><th>RU</th><th>Why</th></tr></thead>
    <tbody>{% for o in ctx.collisions.orphans %}
    <tr><td>{{ o.rack }}</td>
      <td>{{ o.asset.name }}<br><small>{{ o.asset.asset.serial or "" }} · {{ o.asset.asset.make_model }}</small></td>
      <td>{{ o.asset.ru_text }}</td><td>{{ ctx.orphan_label(o.reason) }}</td></tr>
    {% endfor %}</tbody>
  </table>
  {% endif %}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_move_report_compute.py api/tests/test_move_report_render.py -q`
Expected: all pass. (`test_move_report_render.py` imports WeasyPrint; on macOS set `DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib` in the same shell if the PDF smoke test fails to import Pango.)

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/reports/move_report api/tests/test_move_report_compute.py api/tests/test_move_report_render.py
git commit -m "feat(reports): Move Report collisions use the shared placement rule and list orphan nodes

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `POST /initiatives/{id}/assets/recheck-placement`

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (after `InitiativeAssetUpdateIn`, line 1944)
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (imports at 21-28 and 37-40; new route after `add_initiative_assets`, line 897)
- Test: `api/tests/test_initiative_placement_api.py`

**Interfaces:**
- Consumes: `recheck_placement` from Task 2.
- Produces: `PlacementRecheckOut(checked, collisions, orphans, cleared)`; route writes one audit row with `action="placement_recheck"`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_initiative_placement_api.py
"""POST /initiatives/{id}/assets/recheck-placement: runs the placement
rule over the roster, restates the three placement statuses, audits
once. 403 without initiatives:change, 404 out of scope, 422 on a
non-move."""

from decimal import Decimal

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, AuditLog, Initiative, InitiativeAsset,
)

from .test_assets_api import login
from .test_initiative_assets_api import _move, _project, _view_only_headers


async def _seed_rack(db, initiative_id):
    big = AssetModel(make="Big", model="4U", ru_size=4)
    db.add(big)
    await db.flush()
    a = Asset(serial_number="A", name="a", model_id=big.id)
    b = Asset(serial_number="B", name="b")
    n = Asset(serial_number="N", name="n")
    db.add_all([a, b, n])
    await db.flush()
    db.add_all([
        InitiativeAsset(initiative_id=initiative_id, asset_id=a.id,
                        destination_rack="R1", destination_ru=Decimal("10")),
        InitiativeAsset(initiative_id=initiative_id, asset_id=b.id,
                        destination_rack="R1", destination_ru=Decimal("12")),
        InitiativeAsset(initiative_id=initiative_id, asset_id=n.id,
                        destination_rack="R1", destination_ru=Decimal("20.1")),
    ])
    await db.commit()


async def test_recheck_flags_and_audits(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    await _seed_rack(db, iid)

    resp = await client.post(f"/initiatives/{iid}/assets/recheck-placement",
                             headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"checked": 3, "collisions": 2, "orphans": 1, "cleared": 0}

    rows = (await client.get(f"/initiatives/{iid}/assets", headers=headers)).json()
    by_serial = {r["asset"]["serial_number"]: r for r in rows}
    assert by_serial["A"]["status"] == "location_collision"
    assert by_serial["B"]["status"] == "location_collision"
    assert by_serial["N"]["status"] == "orphan_node"
    assert by_serial["N"]["status_label"] == "Orphan node"

    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "initiative", AuditLog.entity_id == iid,
        AuditLog.action == "placement_recheck"))).all()
    assert len(audits) == 1
    assert audits[0].changes == {"checked": 3, "collisions": 2, "orphans": 1, "cleared": 0}

    # second run: nothing changes, nothing cleared, still one audit per run
    resp = await client.post(f"/initiatives/{iid}/assets/recheck-placement",
                             headers=headers)
    assert resp.json() == {"checked": 3, "collisions": 2, "orphans": 1, "cleared": 0}


async def test_recheck_requires_change_permission(client, db, seeded_user):
    headers = await login(client)
    iid = await _move(client, headers)
    viewer = await _view_only_headers(db, client)
    resp = await client.post(f"/initiatives/{iid}/assets/recheck-placement",
                             headers=viewer)
    assert resp.status_code == 403


async def test_recheck_rejects_a_non_move(client, db, seeded_user):
    headers = await login(client)
    pid = await _project(client, headers)
    resp = await client.post(f"/initiatives/{pid}/assets/recheck-placement",
                             headers=headers)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "not_a_move"


async def test_recheck_unknown_initiative_is_404(client, db, seeded_user):
    headers = await login(client)
    resp = await client.post(
        "/initiatives/00000000-0000-0000-0000-000000000000/assets/recheck-placement",
        headers=headers)
    assert resp.status_code == 404
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_initiative_placement_api.py -q`
Expected: the first three fail with `405` or `404` on the POST (route missing); the 404 test may pass already.

- [ ] **Step 3: Add the schema**

In `api/src/serversherpa/api/schemas.py`, after `InitiativeAssetUpdateIn` (line 1944):

```python
class PlacementRecheckOut(BaseModel):
    """Result of POST /initiatives/{id}/assets/recheck-placement."""

    checked: int
    collisions: int
    orphans: int
    cleared: int
```

- [ ] **Step 4: Add the route**

In `api/src/serversherpa/api/routes/initiatives.py`, add `PlacementRecheckOut,` to the `serversherpa.api.schemas` import list (lines 21-28, keep alphabetical: after `InitiativeUpdateIn,`), and add after line 40:

```python
from serversherpa.racks.recheck import recheck_placement
```

After `add_initiative_assets` (ends line 897), add:

```python
@router.post("/{initiative_id}/assets/recheck-placement",
             response_model=PlacementRecheckOut)
async def recheck_initiative_placement(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> PlacementRecheckOut:
    """Run the placement rule over the whole destination roster and restate
    the three placement statuses (loaded_in_system / location_collision /
    orphan_node). Rows that have progressed past those are never touched.
    The importer runs the same function after every commit pass; this is
    the way to clear stale flags without re-uploading the file."""
    initiative = await _get_initiative(db, initiative_id, actor)
    _require_global(actor)
    if initiative.initiative_type != "move":
        raise _err(422, "not_a_move")
    result = await recheck_placement(db, initiative_id)
    initiative.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="initiative",
          entity_id=str(initiative_id), action="placement_recheck",
          changes=result)
    await db.commit()
    return PlacementRecheckOut(**result)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_initiative_placement_api.py api/tests/test_initiative_assets_api.py -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/initiatives.py api/tests/test_initiative_placement_api.py
git commit -m "feat(initiatives): POST /assets/recheck-placement restates placement statuses and audits once

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Portal "Re-check placement" action

**Files:**
- Modify: `portal/src/lib/api.ts` (after `removeInitiativeAsset`, line 2477)
- Modify: `portal/src/pages/InitiativeDetail.tsx:26-59` (imports), `:781-785` (toolbar)
- Modify: `portal/src/pages/InitiativeDetail.test.tsx:52-77` (api mock), new test

**Interfaces:**
- Consumes: the endpoint from Task 4.
- Produces: `recheckInitiativePlacement(id: string): Promise<PlacementRecheck>` and `interface PlacementRecheck { checked: number; collisions: number; orphans: number; cleared: number }`.

- [ ] **Step 1: Write the failing test**

In `portal/src/pages/InitiativeDetail.test.tsx`, add `recheckInitiativePlacement: vi.fn(),` to the `api` object (after `updateInitiativeLink: vi.fn(),` on line 76). Then after the existing `assets row: Actions → Remove` test (ends line 235) add:

```tsx
it('assets toolbar: Re-check placement calls the endpoint and refetches the roster', async () => {
  api.recheckInitiativePlacement.mockResolvedValue(
    { checked: 46, collisions: 0, orphans: 1, cleared: 41 });
  const user = userEvent.setup();
  renderPage();
  await assetRow();
  const before = api.listInitiativeAssets.mock.calls.length;

  await user.click(await screen.findByRole('button', { name: 'Re-check placement' }));

  await waitFor(() => expect(api.recheckInitiativePlacement).toHaveBeenCalledWith('i1'));
  await waitFor(() => expect(api.listInitiativeAssets.mock.calls.length).toBe(before + 1));
});

it('assets toolbar: Re-check placement is hidden without change permission', async () => {
  auth.can = (resource, action) => !(resource === 'initiatives' && action === 'change');
  renderPage();
  await assetRow();
  expect(screen.queryByRole('button', { name: 'Re-check placement' })).toBeNull();
  auth.can = () => true;
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix portal run test`
Expected: the two new tests fail (button not found).

- [ ] **Step 3: Add the API function**

In `portal/src/lib/api.ts` after `removeInitiativeAsset` (line 2477):

```ts
export interface PlacementRecheck {
  checked: number; collisions: number; orphans: number; cleared: number;
}

/** POST /initiatives/{id}/assets/recheck-placement — re-run the rack
 *  placement rule over the roster; restates loaded_in_system /
 *  location_collision / orphan_node and never touches progressed rows. */
export async function recheckInitiativePlacement(id: string): Promise<PlacementRecheck> {
  const resp = await apiFetch(`/initiatives/${id}/assets/recheck-placement`,
    { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

- [ ] **Step 4: Add the button**

In `portal/src/pages/InitiativeDetail.tsx`:

Add `recheckInitiativePlacement,` to the `../lib/api` import list (alphabetical, after `listWorkerOptions,`). Add a new import line after line 83 (`import StatusHover ...`):

```ts
import { useToast } from '../lib/notificationsContext';
```

Inside the component, next to `const canChange = can('initiatives', 'change');` (line 192) add:

```ts
  const toast = useToast();
```

After the `runAssets` function (ends line 460) add:

```ts
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const recheckPlacement = () => runAssets(async () => {
    const r = await recheckInitiativePlacement(id!);
    toast(`Placement re-checked: ${plural(r.collisions, 'collision', 'collisions')}, `
      + `${plural(r.orphans, 'orphan node', 'orphan nodes')}, `
      + `${plural(r.cleared, 'flag', 'flags')} cleared.`);
  });
```

In the assets toolbar, immediately before the `<GodEditToggle` element (line 783) add:

```tsx
                  {canChange && (
                    <button type="button" className="mini-btn" disabled={assetsBusy}
                            onClick={() => void recheckPlacement()}
                            title="Re-run the rack placement rule: flags collisions and orphan nodes, clears stale flags. Rows that have progressed are never touched.">
                      Re-check placement
                    </button>
                  )}
```

- [ ] **Step 5: Run the tests and type check**

Run: `npm --prefix portal run test` then `npm --prefix portal exec -- tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add portal/src/lib/api.ts portal/src/pages/InitiativeDetail.tsx portal/src/pages/InitiativeDetail.test.tsx
git commit -m "feat(portal): Re-check placement action on the initiative Assets panel

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Slot-aware `rackLayout` and device list

**Files:**
- Modify: `portal/src/lib/initiatives.ts:487-555`
- Modify: `portal/src/lib/initiatives.test.ts:501-504,581-607`

**Interfaces:**
- Produces: `ruSlot(ru: number): { base: number; slot: number }`; `interface RackChild { id; label; slot; serial: string | null; makeModel; verified }`; `RackBlock` gains `slot: number; children: RackChild[]; orphan: boolean`; `DeviceListRow` gains `indent: boolean; orphan: boolean`. `rackLayout` returns parents (with children attached, ascending slot) followed by orphan blocks; `deviceListRows` emits each parent followed by its children.

- [ ] **Step 1: Write the failing tests**

In `portal/src/lib/initiatives.test.ts`, replace the test `passes decimal RU values through unchanged` (lines 501-504) with:

```ts
  it('attaches a node at N.x as a child of the block that starts at N', () => {
    const rows = [
      assetRow({ id: 'ch', source_rack: 'BJ08', source_ru: 33,
                 asset: { ...assetRow().asset, name: 'chassis', ru_size: 4 } }),
      assetRow({ id: 'n2', source_rack: 'BJ08', source_ru: 33.2,
                 asset: { ...assetRow().asset, name: 'node-2', serial_number: 'S2', ru_size: null } }),
      assetRow({ id: 'n1', source_rack: 'BJ08', source_ru: 33.1, source_verified: true,
                 asset: { ...assetRow().asset, name: 'node-1', serial_number: 'S1', ru_size: null } }),
    ];
    const blocks = rackLayout(rows, 'BJ08', 'source');
    expect(blocks.map((b) => b.id)).toEqual(['ch']);
    expect(blocks[0].children.map((c) => [c.id, c.slot, c.label, c.serial, c.verified]))
      .toEqual([['n1', 1, 'node-1', 'S1', true], ['n2', 2, 'node-2', 'S2', false]]);
    expect(blocks[0].slot).toBe(0);
    expect(blocks[0].orphan).toBe(false);
  });

  it('draws a node with no block at its RU as a 1U orphan block at the base', () => {
    const rows = [assetRow({ id: 'a', source_rack: 'BJ08', source_ru: 8.5,
                             asset: { ...assetRow().asset, ru_size: 2 } })];
    const [b] = rackLayout(rows, 'BJ08', 'source');
    expect([b.ru, b.slot, b.height, b.orphan, b.children]).toEqual([8, 5, 1, true, []]);
  });

  it('a node whose RU is only covered from below is still an orphan (no block STARTS there)', () => {
    const rows = [
      assetRow({ id: 'srv', source_rack: 'BJ08', source_ru: 32,
                 asset: { ...assetRow().asset, ru_size: 2 } }),
      assetRow({ id: 'n', source_rack: 'BJ08', source_ru: 33.1 }),
    ];
    const blocks = rackLayout(rows, 'BJ08', 'source');
    expect(blocks.map((b) => [b.id, b.orphan])).toEqual([['srv', false], ['n', true]]);
  });

  it('ruSlot splits base and slot', () => {
    expect(ruSlot(33.4)).toEqual({ base: 33, slot: 4 });
    expect(ruSlot(10)).toEqual({ base: 10, slot: 0 });
    expect(ruSlot(5.3000001)).toEqual({ base: 5, slot: 3 });
  });
```

Add `ruSlot` to the import list from `./initiatives` at the top of the file (line 4-10).

Replace the `block` helper (lines 581-584) with:

```ts
const block = (over: Partial<RackBlock>): RackBlock => ({
  id: 'b1', label: 'dev', ru: 1, height: 1, verified: false, position: null,
  categoryLabel: null, categoryColor: null, makeModel: '',
  slot: 0, children: [], orphan: false, ...over,
});
```

After the `formats RU ranges and model fallback` test (ends line 606) add inside `describe('deviceListRows')`:

```ts
  it('lists children indented under their block, in slot order, and marks orphans', () => {
    const rows = deviceListRows([
      block({ id: 'ch', label: 'chassis', ru: 33, height: 4, categoryColor: '#123456',
              children: [
                { id: 'n2', label: 'node-2', slot: 2, serial: null, makeModel: 'Dell node', verified: false },
                { id: 'n1', label: 'node-1', slot: 1, serial: null, makeModel: '', verified: true },
              ] }),
      block({ id: 'o', label: 'san-01', ru: 3, height: 1, slot: 5, orphan: true }),
    ], []);
    expect(rows.map((r) => [r.id, r.ruText, r.indent, r.orphan])).toEqual([
      ['ch', '33..36', false, false],
      ['n2', '33.2', true, false],
      ['n1', '33.1', true, false],
      ['o', '3.5', false, true],
    ]);
    expect(rows[1].categoryColor).toBe('#123456');
    expect(rows[2].makeModel).toBe('—');
  });
```

(Children follow the parent in the order they were attached; `rackLayout` sorts them ascending by slot, so this test deliberately feeds them unsorted to pin that `deviceListRows` does not re-sort.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix portal run test`
Expected: the new tests fail; `tsc` would also fail on the missing `ruSlot` export and `RackBlock` fields.

- [ ] **Step 3: Implement**

In `portal/src/lib/initiatives.ts` replace lines 487-530 (the `RackBlock` interface, its doc comment, and `rackLayout`) with:

```ts
/** A node housed inside another device: a roster row at RU `N.x` whose
 *  parent is the block that starts at RU N. */
export interface RackChild {
  id: string; label: string; slot: number; serial: string | null;
  makeModel: string; verified: boolean;
}

/** One asset's block in a rack elevation. `ru` is the whole RU the block
 *  starts at; `height` the RUs it occupies. A row at a fractional RU is a
 *  node in slot x of RU N: it becomes a `children` entry of the block that
 *  starts at N, or, when no block starts there, its own 1U block at N with
 *  `orphan: true` and its `slot` recorded so the RU can still be shown as
 *  "N.x". Whole-RU blocks have `slot: 0`. */
export interface RackBlock {
  id: string; label: string; ru: number; height: number;
  verified: boolean; position: string | null;
  categoryLabel: string | null; categoryColor: string | null;
  makeModel: string;
  slot: number;
  children: RackChild[];
  orphan: boolean;
}

/** Splits a stored RU into its whole part and its slot digit: 33.4 is slot
 *  4 of RU 33; 10 is slot 0. Mirrors serversherpa.racks.placement.place(). */
export function ruSlot(ru: number): { base: number; slot: number } {
  const base = Math.floor(ru);
  return { base, slot: Math.round((ru - base) * 10) };
}

/** Filters a move's asset rows down to the ones racked in `rackName` on the
 *  given side, and maps each to its elevation block. A row without an RU
 *  recorded on that side has nothing to place, so it's excluded outright.
 *  `ru_size` defaults to 1 RU. Whole-RU rows become blocks; fractional-RU
 *  rows attach to the block that starts at their RU (ascending slot) or
 *  stand alone as orphan blocks. Blocks come out in row order, orphans
 *  after the whole-RU blocks. */
export function rackLayout(
  rows: InitiativeAssetRow[], rackName: string, side: 'source' | 'destination',
): RackBlock[] {
  const rackOf = (r: InitiativeAssetRow) =>
    (side === 'source' ? r.source_rack : r.destination_rack);
  const ruOf = (r: InitiativeAssetRow) =>
    (side === 'source' ? r.source_ru : r.destination_ru);
  const verifiedOf = (r: InitiativeAssetRow) =>
    !!(side === 'source' ? r.source_verified : r.destination_verified);
  const positionOf = (r: InitiativeAssetRow) =>
    (side === 'source' ? r.source_position : r.destination_position);
  const labelOf = (r: InitiativeAssetRow) =>
    r.asset.name ?? r.asset.serial_number ?? BLANK;
  const makeModelOf = (r: InitiativeAssetRow) =>
    [r.asset.model_make, r.asset.model_name].filter(Boolean).join(' ');

  // RU 0 (or anything below the first usable unit) is "unplaced" — the
  // bottom cap is not a mounting position, so such rows never render.
  const placed = rows
    .filter((r) => rackOf(r) === rackName && (ruOf(r) ?? 0) >= 1)
    .map((r) => ({ r, ...ruSlot(ruOf(r) as number) }));

  const toBlock = (r: InitiativeAssetRow, base: number, slot: number, orphan: boolean): RackBlock => ({
    id: r.id,
    label: labelOf(r),
    ru: base,
    height: orphan ? 1 : (r.asset.ru_size ?? 1),
    verified: verifiedOf(r),
    position: positionOf(r),
    categoryLabel: r.asset.model_category_label,
    categoryColor: r.asset.model_category_color,
    makeModel: makeModelOf(r),
    slot,
    children: [],
    orphan,
  });

  const blocks: RackBlock[] = [];
  const byBase = new Map<number, RackBlock>();
  for (const { r, base, slot } of placed) {
    if (slot !== 0) continue;
    const b = toBlock(r, base, 0, false);
    blocks.push(b);
    if (!byBase.has(base)) byBase.set(base, b);
  }
  for (const { r, base, slot } of placed) {
    if (slot === 0) continue;
    const parent = byBase.get(base);
    if (parent) {
      parent.children.push({
        id: r.id, label: labelOf(r), slot, serial: r.asset.serial_number,
        makeModel: makeModelOf(r), verified: verifiedOf(r),
      });
    } else {
      blocks.push(toBlock(r, base, slot, true));
    }
  }
  for (const b of blocks) b.children.sort((a, c) => a.slot - c.slot);
  return blocks;
}
```

Replace `DeviceListRow` and `deviceListRows` (previously lines 532-555) with:

```ts
export interface DeviceListRow {
  id: string; name: string; makeModel: string; ruText: string;
  categoryColor: string | null; group: 'FRONT' | 'REAR';
  indent: boolean; orphan: boolean;
}

/** Rack-order device list rows: each elevation's REAL blocks sorted top
 *  of rack first (descending top RU, ties by name), FRONT group before
 *  REAR. RU text is a dot-range ("40..42") for multi-U devices, "33.1" for
 *  a node. A block's children follow it, indented, in the order the block
 *  carries them (rackLayout sorts them by slot). */
export function deviceListRows(
  front: RackBlock[], rear: RackBlock[],
): DeviceListRow[] {
  const ruTextOf = (b: RackBlock) => {
    if (b.orphan) return `${b.ru}.${b.slot}`;
    return b.height > 1 ? `${b.ru}..${b.ru + b.height - 1}` : String(b.ru);
  };
  const toRows = (blocks: RackBlock[], group: 'FRONT' | 'REAR') =>
    [...blocks]
      .sort((a, b) => (b.ru + b.height) - (a.ru + a.height)
        || a.label.localeCompare(b.label))
      .flatMap((b) => [
        {
          id: b.id, name: b.label,
          makeModel: b.makeModel || '—',
          ruText: ruTextOf(b),
          categoryColor: b.categoryColor, group,
          indent: false, orphan: b.orphan,
        },
        ...b.children.map((c) => ({
          id: c.id, name: c.label,
          makeModel: c.makeModel || '—',
          ruText: `${b.ru}.${c.slot}`,
          categoryColor: b.categoryColor, group,
          indent: true, orphan: false,
        })),
      ]);
  return [...toRows(front, 'FRONT'), ...toRows(rear, 'REAR')];
}
```

- [ ] **Step 4: Run the tests and type check**

Run: `npm --prefix portal run test` then `npm --prefix portal exec -- tsc --noEmit`
Expected: all pass. If `tsc` reports another test fixture constructing a `RackBlock` literal without the three new fields, add `slot: 0, children: [], orphan: false` to that fixture.

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/initiatives.ts portal/src/lib/initiatives.test.ts
git commit -m "feat(portal): rackLayout attaches N.x nodes as children of the block at N; orphans draw at the base

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Draw children and orphans; hover; device list; print sheet; renderer bundle

**Files:**
- Modify: `portal/src/components/initiatives/RackElevation.tsx:209-240,251-347`
- Modify: `portal/src/components/initiatives/RackViewModal.tsx:50,87-98,114-125,156-168`
- Modify: `portal/src/components/initiatives/RackDeviceList.tsx:22-27`
- Modify: `portal/src/lib/rackPrint.ts:37-42,69-78`
- Modify: `portal/src/styles/rack-svg.css` (append), `portal/src/styles/initiatives.css:467-477`
- Modify: `portal/src/components/initiatives/RackViewModal.render.test.tsx`, `portal/src/components/initiatives/RackViewModal.test.tsx`

**Interfaces:**
- Consumes: `RackBlock.children`, `.orphan`, `.slot`, `RackChild` from Task 6.
- Produces: `RackElevation` prop `onHoverChild?: (block: DisplayBlock, child: RackChild, e: React.MouseEvent<SVGGElement>) => void`; each child pill is `<g role="img" aria-label={`Slot ${slot}: ${label}`}>`; an orphan block's faceplate has class `rack-faceplate rack-faceplate-orphan`; `tooltipRows` accepts `ru: number | string`, `parentLabel?: string | null`, `orphan?: boolean`.

- [ ] **Step 1: Write the failing tests**

In `portal/src/components/initiatives/RackViewModal.render.test.tsx`, after the existing smoke test add:

```tsx
  it('draws nodes as labeled slot pills inside their chassis and lists them indented', () => {
    const rows = [
      makeRow({ id: 'ch', source_ru: 33, source_position: null,
                asset: makeAsset({ id: 'a-ch', name: 'nvlarch03-i', ru_size: 4 }) }),
      makeRow({ id: 'n1', source_ru: 33.1, source_position: null,
                asset: makeAsset({ id: 'a-n1', name: 'nvlarch03-mgmt032', ru_size: null }) }),
      makeRow({ id: 'n2', source_ru: 33.2, source_position: null,
                asset: makeAsset({ id: 'a-n2', name: 'nvlarch03-mgmt030', ru_size: null }) }),
    ];
    render(<RackViewModal rackName="R1" side="source" rows={rows} onClose={() => {}} />);
    expect(screen.getByRole('img', { name: 'Slot 1: nvlarch03-mgmt032' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Slot 2: nvlarch03-mgmt030' })).toBeTruthy();
    // device list: chassis, then its nodes indented with dotted RUs
    const list = document.querySelector('.rack-device-list') as HTMLElement;
    const names = [...list.querySelectorAll('.rack-list-name')].map((el) => el.textContent);
    expect(names).toEqual(['nvlarch03-i', 'nvlarch03-mgmt032', 'nvlarch03-mgmt030']);
    expect(list.querySelectorAll('.rack-list-child').length).toBe(2);
    expect(within(list).getByText('33.1')).toBeTruthy();
  });

  it('draws a node with no chassis as a dashed orphan block and names it in the list', () => {
    const rows = [makeRow({ id: 'o', source_ru: 3.5, source_position: null,
                            asset: makeAsset({ id: 'a-o', name: 'san-01', ru_size: 1 }) })];
    render(<RackViewModal rackName="R1" side="source" rows={rows} onClose={() => {}} />);
    expect(document.querySelector('.rack-faceplate-orphan')).toBeTruthy();
    expect(screen.getByText('! san-01')).toBeTruthy();
    const list = document.querySelector('.rack-device-list') as HTMLElement;
    expect(list.querySelector('.rack-list-orphan')).toBeTruthy();
    expect(within(list).getByText('3.5')).toBeTruthy();
  });

  it('hovering a slot pill shows the node with its parent', () => {
    const rows = [
      makeRow({ id: 'ch', source_ru: 33, source_position: null,
                asset: makeAsset({ id: 'a-ch', name: 'chassis-a', ru_size: 4 }) }),
      makeRow({ id: 'n1', source_ru: 33.1, source_position: null,
                asset: makeAsset({ id: 'a-n1', name: 'node-a1', serial_number: 'SN-N1', ru_size: null }) }),
    ];
    render(<RackViewModal rackName="R1" side="source" rows={rows} onClose={() => {}} />);
    fireEvent.mouseEnter(screen.getByRole('img', { name: 'Slot 1: node-a1' }));
    const tip = document.querySelector('.rack-tooltip') as HTMLElement;
    expect(within(tip).getByText('node-a1')).toBeTruthy();
    expect(within(tip).getByText('SN-N1')).toBeTruthy();
    expect(within(tip).getByText('33.1')).toBeTruthy();
    expect(within(tip).getByText('Inside')).toBeTruthy();
    expect(within(tip).getByText('chassis-a')).toBeTruthy();
  });
```

In `portal/src/components/initiatives/RackViewModal.test.tsx` add a `tooltipRows` case:

```ts
describe('tooltipRows for nodes', () => {
  it('adds Inside for a child and a Note for an orphan', () => {
    const child = tooltipRows({ serial: 'S1', makeModel: 'Dell node', ru: '33.1',
                                position: null, parentLabel: 'chassis-a' });
    expect(child.map((r) => [r.label, r.value])).toEqual([
      ['Serial', 'S1'], ['Make/Model', 'Dell node'], ['RU', '33.1'], ['Inside', 'chassis-a']]);
    const orphan = tooltipRows({ serial: null, makeModel: '', ru: '3.5', position: null, orphan: true });
    expect(orphan.map((r) => r.label)).toEqual(['Serial', 'Make/Model', 'RU', 'Note']);
    expect(orphan[3].value).toBe('No device starts at this RU');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix portal run test`
Expected: the four new tests fail.

- [ ] **Step 3: `tooltipRows` and `RackElevation`**

In `portal/src/components/initiatives/RackElevation.tsx`:

Change the import on line 21 to:

```ts
import type { RackBlock, RackChild } from '../../lib/initiatives';
```

Replace `tooltipRows` (lines 220-240) with:

```ts
export function tooltipRows(info: {
  serial: string | null | undefined;
  makeModel: string | null | undefined;
  ru: number | string;
  position: string | null | undefined;
  categoryLabel?: string | null | undefined;
  parentLabel?: string | null | undefined;
  orphan?: boolean;
}): TooltipRow[] {
  const rows: TooltipRow[] = [
    { label: 'Serial', value: info.serial ?? '—' },
    { label: 'Make/Model', value: info.makeModel || '—' },
    { label: 'RU', value: String(info.ru) },
  ];
  if (info.parentLabel) {
    rows.push({ label: 'Inside', value: info.parentLabel });
  }
  if (info.orphan) {
    rows.push({ label: 'Note', value: 'No device starts at this RU' });
  }
  if (info.categoryLabel) {
    rows.push({ label: 'Category', value: info.categoryLabel });
  }
  const position = info.position?.trim();
  if (position && position.toLowerCase() !== 'front') {
    rows.push({ label: 'Position', value: position });
  }
  return rows;
}
```

Change the component signature (lines 251-257) to:

```tsx
export function RackElevation({
  heading, ariaLabel, blocks, onHoverBlock, onLeaveBlock, onHoverChild,
}: {
  heading: string;
  ariaLabel: string;
  blocks: DisplayBlock[];
  onHoverBlock?: (block: DisplayBlock, e: React.MouseEvent<SVGGElement>) => void;
  onLeaveBlock?: () => void;
  onHoverChild?: (block: DisplayBlock, child: RackChild, e: React.MouseEvent<SVGGElement>) => void;
}) {
```

Replace the real-block branch (lines 331-346, from `const label = rackLabel(...)` to the closing `);` of that `return`) with:

```tsx
          const hasChildren = b.children.length > 0;
          // with nodes inside, the parent's label keeps the left half and the
          // slot pills take the right half
          const labelWidth = hasChildren ? width * 0.5 - 8 : width;
          const label = (b.orphan ? '! ' : '') + rackLabel(b.label, b.position, labelWidth);
          const fill = b.categoryColor ?? UNCATEGORIZED_FILL;
          const textColor = readableTextColor(fill);
          const border = b.orphan
            ? { stroke: '#b45309', strokeWidth: 1.5, strokeDasharray: '2 2' }
            : b.verified
              ? { stroke: '#15803d', strokeWidth: 2 }
              : { stroke: '#111827', strokeWidth: 1.25, strokeDasharray: '4 3' };
          const pillGap = 2;
          const pillAreaX = x + width * 0.5;
          const pillAreaWidth = width * 0.5 - 4;
          const pillWidth = Math.max(10,
            (pillAreaWidth - pillGap * (b.children.length - 1)) / Math.max(1, b.children.length));
          const pillHeight = Math.max(8, height - 4);
          const pillFill = textColor === '#fff' ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.12)';
          return (
            <g key={b.id} onMouseEnter={onHoverBlock ? (e) => onHoverBlock(b, e) : undefined}
               onMouseLeave={onLeaveBlock}>
              <rect x={x} y={y} width={width} height={height} rx={2}
                    fill={fill} {...border}
                    className={b.orphan ? 'rack-faceplate rack-faceplate-orphan' : 'rack-faceplate'} />
              <text x={x + 8} y={y + height / 2} dominantBaseline="middle"
                    fill={textColor} className="rack-block-label">
                {label}
              </text>
              {b.children.map((c, i) => {
                const px = pillAreaX + i * (pillWidth + pillGap);
                return (
                  <g key={c.id} role="img" aria-label={`Slot ${c.slot}: ${c.label}`}
                     className="rack-node"
                     onMouseEnter={onHoverChild ? (e) => { e.stopPropagation(); onHoverChild(b, c, e); } : undefined}>
                    <rect x={px} y={y + 2} width={pillWidth} height={pillHeight} rx={2}
                          fill={pillFill}
                          stroke={c.verified ? '#15803d' : textColor}
                          strokeWidth={0.75}
                          strokeDasharray={c.verified ? undefined : '2 2'} />
                    <text x={px + pillWidth / 2} y={y + 2 + pillHeight / 2}
                          textAnchor="middle" dominantBaseline="middle"
                          fill={textColor} className="rack-node-label">
                      {c.slot}
                    </text>
                  </g>
                );
              })}
            </g>
          );
```

Append to `portal/src/styles/rack-svg.css`:

```css
/* slot pills: the nodes housed inside a chassis, numbered by slot. Fill
   and stroke are inline (they derive from the parent's category color). */
.rack-node-label {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 7px;
  font-weight: 600;
}
```

- [ ] **Step 4: `RackViewModal` child hover**

In `portal/src/components/initiatives/RackViewModal.tsx`:

Line 50: `interface HoverState { block: DisplayBlock; child?: RackChild; x: number; y: number; }`

Add `RackChild` to the type import on line 35: `import type { InitiativeAssetRow } from '../../lib/api';` stays; add a new line after it:

```ts
import type { RackChild } from '../../lib/initiatives';
```

Replace `handleHover` and `handleLeave` (lines 87-98) with:

```ts
  const place = (e: React.MouseEvent<SVGGElement>) => {
    const container = containerRef.current;
    if (!container) return null;
    const targetRect = e.currentTarget.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      x: targetRect.left - containerRect.left + targetRect.width / 2,
      y: targetRect.top - containerRect.top,
    };
  };
  const handleHover = (block: DisplayBlock, e: React.MouseEvent<SVGGElement>) => {
    const at = place(e);
    if (at) setHover({ block, ...at });
  };
  const handleHoverChild = (block: DisplayBlock, child: RackChild, e: React.MouseEvent<SVGGElement>) => {
    const at = place(e);
    if (at) setHover({ block, child, ...at });
  };
  const handleLeave = () => setHover(null);
```

Replace the hovered-row block (lines 114-125) with:

```ts
  const hoveredRow = hover ? rowsById.get(hover.child?.id ?? hover.block.id) : undefined;
  const hoveredAsset = hoveredRow?.asset;
  const hoveredMakeModel = hoveredAsset
    ? [hoveredAsset.model_make, hoveredAsset.model_name].filter(Boolean).join(' ')
    : '';
  const hoveredRows = hover ? tooltipRows({
    serial: hoveredAsset?.serial_number,
    makeModel: hoveredMakeModel,
    ru: hover.child
      ? `${hover.block.ru}.${hover.child.slot}`
      : hover.block.orphan ? `${hover.block.ru}.${hover.block.slot}` : hover.block.ru,
    position: hover.child ? null : hover.block.position,
    categoryLabel: hover.child ? null : hover.block.categoryLabel,
    parentLabel: hover.child ? hover.block.label : null,
    orphan: !hover.child && hover.block.orphan,
  }) : [];
```

Pass the new handler to both `<RackElevation ...>` elements (lines 143-153): add `onHoverChild={handleHoverChild}` after `onLeaveBlock={handleLeave}` in each.

- [ ] **Step 5: Device list and print sheet**

Replace lines 22-27 of `portal/src/components/initiatives/RackDeviceList.tsx` with:

```tsx
            <div className={`rack-list-row${r.indent ? ' rack-list-child' : ''}`
              + `${r.orphan ? ' rack-list-orphan' : ''}`}>
              <span className="rack-list-swatch"
                    style={{ background: r.categoryColor ?? UNCATEGORIZED_FILL }} />
              <span className="rack-list-name">{r.orphan ? `! ${r.name}` : r.name}</span>
              <span className="rack-list-model">{r.makeModel}</span>
              <span className="rack-list-ru">{r.ruText}</span>
            </div>
```

In `portal/src/styles/initiatives.css`, after the `.rack-list-ru` rule (line 477) add:

```css
.rack-list-child .rack-list-name { padding-left: 14px; }
.rack-list-child .rack-list-swatch { opacity: 0.55; }
.rack-list-orphan .rack-list-name { color: #b45309; }
```

In `portal/src/lib/rackPrint.ts`, line 75 becomes:

```ts
      + `<span${r.indent ? ' class="child"' : ''}>${esc(r.orphan ? `! ${r.name}` : r.name)}</span>`
```

and after the `.ru` rule on line 42 add `  .child { padding-left: 10px; }`.

- [ ] **Step 6: Run the tests, type check, and rebuild the renderer bundle**

Run: `npm --prefix portal run test` then `npm --prefix portal exec -- tsc --noEmit` then `npm --prefix portal run build:rack-renderer`
Expected: all pass; the bundle builds to `portal/dist-node/render-rack.js` (git-ignored). The Python report tests mock the renderer, so this build only matters for live verification in Task 13.

- [ ] **Step 7: Commit**

```bash
git add portal/src/components/initiatives portal/src/lib/rackPrint.ts portal/src/styles/rack-svg.css portal/src/styles/initiatives.css
git commit -m "feat(portal): rack elevation draws nodes as slot pills inside their chassis, orphans dashed; device list indents children

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Migration 0068: `form_factor`, `orphan_node` seed, name backfill

**Files:**
- Create: `api/migrations/versions/0068_model_form_factor_and_orphan_status.py`
- Modify: `api/src/serversherpa/db/models.py:577` (after `rail_type`)
- Test: `api/tests/test_migration_0068_form_factor.py`

**Interfaces:**
- Produces: `AssetModel.form_factor: str | None`; migration functions `seed_orphan_status(conn)` and `backfill_form_factor(conn)` reusable from tests.

- [ ] **Step 1: Write the failing test**

```python
# api/tests/test_migration_0068_form_factor.py
"""Migration 0068: asset_models.form_factor plus the orphan_node status.

The data work lives in two plain functions taking a raw connection so it
can be re-run against the test database (clean_db re-seeds status_values
and truncates asset_models before every test), same convention as 0067's
retire_handheld_reader(conn)."""

import importlib.util
from pathlib import Path

from sqlalchemy import select, text

from serversherpa.db.models import AssetModel, StatusValue

MIGRATION_PATH = (Path(__file__).resolve().parents[1] / "migrations" / "versions"
                  / "0068_model_form_factor_and_orphan_status.py")


def _load():
    spec = importlib.util.spec_from_file_location("_migration_0068_under_test", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_column_exists_with_check_constraint(db):
    await db.execute(text("INSERT INTO asset_models (make, model, form_factor) "
                          "VALUES ('A', 'ok', 'chassis')"))
    import pytest
    from sqlalchemy.exc import DBAPIError
    with pytest.raises(DBAPIError):
        await db.execute(text("INSERT INTO asset_models (make, model, form_factor) "
                              "VALUES ('A', 'bad', 'blade')"))
    await db.rollback()


async def test_seed_orphan_status_is_idempotent(db):
    m = _load()
    await db.execute(text("DELETE FROM status_values WHERE record_type='asset' AND key='orphan_node'"))
    await db.run_sync(lambda s: m.seed_orphan_status(s.connection()))
    await db.run_sync(lambda s: m.seed_orphan_status(s.connection()))
    row = await db.scalar(select(StatusValue).where(
        StatusValue.record_type == "asset", StatusValue.key == "orphan_node"))
    assert row is not None and row.label == "Orphan node" and row.progress_weight is None


async def test_backfill_sets_form_factor_from_the_model_name_only_where_null(db):
    m = _load()
    db.add_all([
        AssetModel(make="DellEMC", model="Isilon H5600 (Chassis)"),
        AssetModel(make="Dell", model="Isilon H5600"),
        AssetModel(make="Dell", model="H5600 node"),
        AssetModel(make="DellEMC_Isilon", model="H5600 Storage (Node)"),
        AssetModel(make="Netapp", model="AFF A900 (Chassis) 8U"),
        AssetModel(make="Dell", model="R740"),
        AssetModel(make="X", model="Odd Chassis", form_factor="standalone"),  # explicit wins
    ])
    await db.commit()
    await db.run_sync(lambda s: m.backfill_form_factor(s.connection()))
    await db.commit()
    rows = dict((await db.execute(
        select(AssetModel.model, AssetModel.form_factor))).all())
    assert rows == {
        "Isilon H5600 (Chassis)": "chassis",
        "Isilon H5600": None,
        "H5600 node": "node",
        "H5600 Storage (Node)": "node",
        "AFF A900 (Chassis) 8U": "chassis",
        "R740": None,
        "Odd Chassis": "standalone",
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_migration_0068_form_factor.py -q`
Expected: fails at collection or on the first INSERT (`column "form_factor" does not exist`, migration file missing).

- [ ] **Step 3: Write the migration and the ORM column**

```python
# api/migrations/versions/0068_model_form_factor_and_orphan_status.py
"""Model form factor and the orphan_node placement status.

Multi-node chassis hold nodes at fractional RUs (33.1 .. 33.4 under the
chassis at 33). The placement rule (serversherpa.racks.placement) reads
that from the position alone; `asset_models.form_factor` only enriches
it: `standalone`, `chassis` or `node`, null meaning unknown and treated
as standalone. A `node` at an integer RU or a `standalone` at a slot is
reported as a form-factor mismatch; the rail report skips nodes.

`orphan_node` is a review status in the asset vocabulary for a node with
no device starting at its RU. Like `location_collision` it carries no
progress weight.

The backfill sets form_factor from the model NAME on rows where it is
still null: `node` where the model contains "(Node)" or ends in " node",
then `chassis` where it contains "Chassis". Nothing else is inferred; a
wrong inference is worse than a blank.

Both data steps live in plain functions taking a raw connection so the
test suite can re-run them (clean_db re-seeds status_values before every
test), the 0066/0067 convention.

Downgrade returns orphan_node rows to loaded_in_system before deleting
the vocabulary row (initiative_assets.status is foreign-keyed to it).

Revision ID: 0068
Revises: 0067
Create Date: 2026-09-21
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0068"
down_revision: str | None = "0067"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

FORM_FACTORS = ("standalone", "chassis", "node")


def seed_orphan_status(conn) -> None:
    conn.execute(sa.text("""
        INSERT INTO status_values
          (record_type, key, label, description, color, sort_order, progress_weight)
        VALUES ('asset', 'orphan_node', 'Orphan node',
                'A node (fractional RU) with no device starting at its RU. Review the rack position.',
                '#d97706', 0, NULL)
        ON CONFLICT (record_type, key) DO NOTHING
    """))


def backfill_form_factor(conn) -> None:
    conn.execute(sa.text("""
        UPDATE asset_models SET form_factor = 'node'
        WHERE form_factor IS NULL
          AND (model ILIKE '%(node)%' OR model ILIKE '% node')
    """))
    conn.execute(sa.text("""
        UPDATE asset_models SET form_factor = 'chassis'
        WHERE form_factor IS NULL AND model ILIKE '%chassis%'
    """))


def upgrade() -> None:
    op.add_column("asset_models", sa.Column("form_factor", sa.Text(), nullable=True))
    op.create_check_constraint(
        "asset_models_form_factor_check", "asset_models",
        "form_factor IN ('standalone', 'chassis', 'node')")
    conn = op.get_bind()
    seed_orphan_status(conn)
    backfill_form_factor(conn)


def downgrade() -> None:
    op.execute("UPDATE initiative_assets SET status = 'loaded_in_system' "
               "WHERE status = 'orphan_node'")
    op.execute("DELETE FROM status_values WHERE record_type = 'asset' AND key = 'orphan_node'")
    op.drop_constraint("asset_models_form_factor_check", "asset_models", type_="check")
    op.drop_column("asset_models", "form_factor")
```

In `api/src/serversherpa/db/models.py` after `rail_type: Mapped[str | None]` (line 577) add:

```python
    form_factor: Mapped[str | None]      # standalone | chassis | node | null (0068)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_migration_0068_form_factor.py api/tests/test_devices_handheld_retired.py -q`
Expected: all pass. (The test harness migrates `serversherpa_test_racknodes` to head at session start, which now applies 0068.)

- [ ] **Step 5: Commit**

```bash
git add api/migrations/versions/0068_model_form_factor_and_orphan_status.py api/src/serversherpa/db/models.py api/tests/test_migration_0068_form_factor.py
git commit -m "feat(db): migration 0068 — asset_models.form_factor, orphan_node status, name-based backfill

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 9: Form factor in the model API

**Files:**
- Modify: `api/src/serversherpa/api/routes/asset_models.py:24-31,61-77,86-92`
- Modify: `api/src/serversherpa/api/schemas.py:1123-1183` (the three model schemas)
- Test: `api/tests/test_asset_model_form_factor_api.py`

**Interfaces:**
- Produces: `FORM_FACTORS = ("standalone", "chassis", "node")`; `form_factor` on `AssetModelItem`, `AssetModelCreateIn`, `AssetModelUpdateIn`; `422 unknown_form_factor`.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_asset_model_form_factor_api.py
"""asset_models.form_factor round-trips through the catalog API and
rejects anything outside standalone / chassis / node."""

from serversherpa.db.models import Person, PersonRole, Role, RolePermission

from .test_assets_api import make_login


async def _catalog_headers(db, client):
    db.add(Role(name="catalog_editor", description="test-only", scope_anchor="global"))
    await db.flush()
    for action in ("view", "add", "change"):
        db.add(RolePermission(role="catalog_editor", resource="asset_models", action=action))
    person = Person(first_name="Cat", last_name="Editor")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="catalog_editor"))
    await db.commit()
    return await make_login(db, client, person, "catalog@test.example.com")


async def test_create_read_update_form_factor(client, db):
    headers = await _catalog_headers(db, client)
    resp = await client.post("/asset-models", headers=headers, json={
        "make": "Dell", "model": "Isilon H5600", "ru_size": 4, "form_factor": "chassis"})
    assert resp.status_code == 201, resp.text
    mid = resp.json()["id"]
    assert resp.json()["form_factor"] == "chassis"

    resp = await client.get(f"/asset-models/{mid}", headers=headers)
    assert resp.json()["form_factor"] == "chassis"
    resp = await client.get("/asset-models", headers=headers)
    assert [m["form_factor"] for m in resp.json()] == ["chassis"]

    resp = await client.patch(f"/asset-models/{mid}", headers=headers,
                              json={"form_factor": "node"})
    assert resp.status_code == 200 and resp.json()["form_factor"] == "node"
    resp = await client.patch(f"/asset-models/{mid}", headers=headers,
                              json={"form_factor": None})
    assert resp.status_code == 200 and resp.json()["form_factor"] is None


async def test_unknown_form_factor_is_422(client, db):
    headers = await _catalog_headers(db, client)
    resp = await client.post("/asset-models", headers=headers, json={
        "make": "Dell", "model": "X", "form_factor": "blade"})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "unknown_form_factor"


async def test_form_factor_is_audited(client, db):
    from sqlalchemy import select

    from serversherpa.db.models import AuditLog

    headers = await _catalog_headers(db, client)
    resp = await client.post("/asset-models", headers=headers,
                             json={"make": "Dell", "model": "Y"})
    mid = resp.json()["id"]
    await client.patch(f"/asset-models/{mid}", headers=headers, json={"form_factor": "node"})
    row = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "asset_model", AuditLog.entity_id == mid,
        AuditLog.action == "update"))
    assert row is not None and row.changes == {"form_factor": {"from": None, "to": "node"}}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_asset_model_form_factor_api.py -q`
Expected: 422 on create (`extra="forbid"` rejects `form_factor`).

- [ ] **Step 3: Implement**

In `api/src/serversherpa/api/routes/asset_models.py`:

After `MOUNT_TYPES = (...)` (line 24):

```python
FORM_FACTORS = ("standalone", "chassis", "node")
```

`MODEL_FIELDS` (lines 26-30) gains `"form_factor",` after `"rail_type",`.

In `_item` (line 74) change `"mount_type": m.mount_type, "rail_type": m.rail_type,` to:

```python
        "mount_type": m.mount_type, "rail_type": m.rail_type,
        "form_factor": m.form_factor,
```

In `_validate` (after line 92) add:

```python
    if data.get("form_factor") is not None and \
            data["form_factor"] not in FORM_FACTORS:
        raise _err(422, "unknown_form_factor")
```

In `api/src/serversherpa/api/schemas.py`, add `form_factor: str | None = None` after `rail_type: str | None = None` in each of `AssetModelItem`, `AssetModelCreateIn` and `AssetModelUpdateIn`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_asset_model_form_factor_api.py api/tests/test_asset_models_api.py -q`
Expected: all pass. (If `test_asset_models_api.py` does not exist under that name, run `api/tests/test_asset*` instead.)

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/asset_models.py api/src/serversherpa/api/schemas.py api/tests/test_asset_model_form_factor_api.py
git commit -m "feat(asset-models): form_factor (standalone | chassis | node) on the catalog API

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 10: Form factor in the portal catalog

**Files:**
- Modify: `portal/src/lib/api.ts:1322-1331` (`AssetModelItem`)
- Modify: `portal/src/lib/assets.ts:109-111,122-130,214-222,226-250,278-282,380-414`
- Modify: `portal/src/components/assets/ModelEditModal.tsx:48-53,313-324`
- Modify: `portal/src/pages/AssetModels.tsx:50-67,84-90,105-116,231-290,459-466`
- Modify: `portal/src/lib/assets.test.ts:80-118`

**Interfaces:**
- Consumes: the API field from Task 9.
- Produces: `FORM_FACTORS` option list exported from `lib/assets.ts`; `ModelFormState.form_factor`; `formFactorLabel(v)`.

- [ ] **Step 1: Write the failing tests**

In `portal/src/lib/assets.test.ts`, add `form_factor: 'chassis',` to the `model` fixture (after `rail_type: 'B7',` on line 86) and, inside `describe('model form payload')`, add:

```ts
  it('sends form_factor when changed and null when cleared', () => {
    const f = formFromModel(model);
    expect(f.form_factor).toBe('chassis');
    f.form_factor = 'node';
    expect(modelPayload(f, model)).toEqual({ form_factor: 'node' });
    f.form_factor = '';
    expect(modelPayload(f, model)).toEqual({ form_factor: null });
  });
  it('modelCellText and formFactorLabel read the form factor', () => {
    expect(modelCellText(model, 'form')).toBe('Chassis');
    expect(modelCellText({ ...model, form_factor: null }, 'form')).toBe('—');
    expect(formFactorLabel('node')).toBe('Node');
    expect(formFactorLabel(null)).toBe('—');
  });
```

Add `formFactorLabel` to the import list from `./assets` at the top of the test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix portal run test`
Expected: the two new tests fail; the type check would fail on `form_factor` not existing on `AssetModelItem`.

- [ ] **Step 3: Types and pure helpers**

In `portal/src/lib/api.ts`, in `AssetModelItem` (line 1329) change `mount_type: string | null; rail_type: string | null;` to:

```ts
  mount_type: string | null; rail_type: string | null; form_factor: string | null;
```

In `portal/src/lib/assets.ts`:

After `titleCase` (line 114) add:

```ts
export const FORM_FACTORS = [
  { value: 'standalone', label: 'Standalone' },
  { value: 'chassis', label: 'Chassis' },
  { value: 'node', label: 'Node' },
];

/** "Chassis" / "Node" / "Standalone", or a dash when unset. */
export const formFactorLabel = (v: string | null): string =>
  FORM_FACTORS.find((f) => f.value === v)?.label ?? '—';
```

In `modelCellText` add a case after `case 'mount':`:

```ts
    case 'form': return formFactorLabel(m.form_factor);
```

In `MODEL_ERRORS` (line 214) add:

```ts
  unknown_form_factor: 'Form factor must be standalone, chassis, or node.',
```

`ModelFormState` (line 231): change `mount_type: string; rail_type: string; knowledge: string;` to `mount_type: string; rail_type: string; form_factor: string; knowledge: string;`.

`formFromModel` (line 247): change `mount_type: m?.mount_type ?? '', rail_type: m?.rail_type ?? '',` to:

```ts
    mount_type: m?.mount_type ?? '', rail_type: m?.rail_type ?? '',
    form_factor: m?.form_factor ?? '',
```

`modelPayload`: after `changedStr('rail_type', orig('rail_type'));` (line 282) add `changedStr('form_factor', orig('form_factor'));`.

`MODEL_GOD_FIELDS`: after the `mount` entry (lines 407-408) add:

```ts
    { column: 'form', field: 'form_factor', kind: 'select',
      fromRow: (m) => m.form_factor ?? '', options: () => FORM_FACTORS },
```

- [ ] **Step 4: Editor and list**

In `portal/src/components/assets/ModelEditModal.tsx`, add `FORM_FACTORS,` to the import list from `../../lib/assets` (line 28-31). After the Rail type input (line 323) add:

```tsx
              <div><label>Form factor</label>
                <select className="org-select" value={form.form_factor} disabled={locked}
                        onChange={(e) => setField('form_factor', e.target.value)}>
                  <option value="">Not set</option>
                  {FORM_FACTORS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <p className="field-hint">
                  Chassis holds nodes at fractional RUs (33.1, 33.2). Node lives inside a chassis and
                  needs no rails. Leave unset for ordinary rack-mounted devices.
                </p></div>
```

In `portal/src/pages/AssetModels.tsx`:

`COLUMNS`: after the `mount` column (line 55) add `{ key: 'form', label: 'Form factor', width: '0.8fr', default: true },`.

Sort accessor: after `case 'mount':` (line 89) add `case 'form': return (m.form_factor ?? '').toLowerCase();`.

`CSV_COLUMNS`: after `['Mount type', ...]` add `['Form factor', (m) => m.form_factor ?? ''],`.

`cellFor`: after `case 'mount':` branch (lines 263-264) add:

```tsx
      case 'form':
        return m.form_factor
          ? <span className="chip tag">{formFactorLabel(m.form_factor)}</span>
          : <span className="cell-top">—</span>;
```

Add `formFactorLabel,` to the import list from `../lib/assets` (line 22).

Detail panel: after the `Mount type` row (line 466) add `<dt>Form factor</dt><dd>{formFactorLabel(model.form_factor)}</dd>`.

- [ ] **Step 5: Run the tests and type check**

Run: `npm --prefix portal run test` then `npm --prefix portal exec -- tsc --noEmit`
Expected: all pass. If `tsc` flags another `AssetModelItem` literal in a test fixture, add `form_factor: null` to it.

- [ ] **Step 6: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/assets.ts portal/src/lib/assets.test.ts portal/src/components/assets/ModelEditModal.tsx portal/src/pages/AssetModels.tsx
git commit -m "feat(portal): form factor on the Makes / Models editor, list column, chip and export

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 11: Form factor in the placement rule and the rail report

**Files:**
- Modify: `api/src/serversherpa/racks/recheck.py:31-43`
- Modify: `api/src/serversherpa/reports/move_report/gather.py:26-55,131-146`
- Modify: `api/src/serversherpa/reports/move_report/compute.py` (`rail_summary`, and the `getattr` in `collisions`)
- Test: `api/tests/test_rack_recheck.py`, `api/tests/test_move_report_compute.py`

**Interfaces:**
- Consumes: `AssetModel.form_factor` from Task 8; `Placed.form_factor` from Task 1.
- Produces: `MoveAsset.form_factor: str | None = None`; `rail_summary` excludes `form_factor == "node"` rows.

- [ ] **Step 1: Write the failing tests**

Append to `api/tests/test_rack_recheck.py`:

```python
async def test_form_factor_mismatch_is_an_orphan(db):
    ini = Initiative(name="Move F", initiative_type="move", status="planned")
    db.add(ini)
    await db.flush()
    chassis_m = AssetModel(make="Dell", model="H5600 chassis", ru_size=4, form_factor="chassis")
    node_m = AssetModel(make="Dell", model="H5600 node", form_factor="node")
    plain_m = AssetModel(make="Dell", model="R740", ru_size=1, form_factor="standalone")
    db.add_all([chassis_m, node_m, plain_m])
    await db.flush()
    specs = [("ch", chassis_m, "33"), ("n1", node_m, "33.1"),
             ("loose", node_m, "40"), ("srv", plain_m, "33.2")]
    for serial, model, ru in specs:
        a = Asset(serial_number=serial, name=serial, model_id=model.id)
        db.add(a)
        await db.flush()
        db.add(InitiativeAsset(initiative_id=ini.id, asset_id=a.id,
                               destination_rack="R1", destination_ru=Decimal(ru)))
    await db.commit()
    result = await recheck_placement(db, ini.id)
    await db.commit()
    assert result == {"checked": 4, "collisions": 0, "orphans": 2, "cleared": 0}
    st = await _statuses(db, ini)
    assert st == {"ch": "loaded_in_system", "n1": "loaded_in_system",
                  "loose": "orphan_node", "srv": "orphan_node"}
```

Append to `api/tests/test_move_report_compute.py`:

```python
def test_rail_summary_skips_nodes_but_load_summary_keeps_them():
    chassis = _asset(row_id="c", make="Dell", model="H5600", rail_type="Static",
                     ru_size=4, form_factor="chassis", weight_lbs=Decimal("120"))
    nodes = [_asset(row_id=f"n{i}", make="Dell", model="H5600 node", rail_type=None,
                    ru_size=None, form_factor="node", weight_lbs=Decimal("20"))
             for i in (1, 2)]
    r = rail_summary([chassis, *nodes])
    assert r.total_assets == 1
    assert [(x.rail_type, x.count) for x in r.rail_types] == [("Static", 1)]
    assert [(m.model, m.count) for m in r.models] == [("H5600", 1)]
    s = load_summary([chassis, *nodes])
    assert s.total_assets == 3 and s.total_weight_lbs == 160.0


def test_collisions_report_form_factor_mismatch_orphans():
    ch = _asset(row_id="c", name="c", ru_size=4, form_factor="chassis",
                destination_rack="R1", destination_ru=10)
    bad = _asset(row_id="b", name="b", form_factor="standalone",
                 destination_rack="R1", destination_ru=10.1)
    rep = collisions([ch, bad])
    assert rep.items == []
    assert [(o.asset.name, o.reason) for o in rep.orphans] == [("b", "form_factor_mismatch")]
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_rack_recheck.py api/tests/test_move_report_compute.py -q`
Expected: the recheck test reports `orphans: 0`; the compute tests fail on `form_factor` being an unexpected keyword.

- [ ] **Step 3: Implement**

`api/src/serversherpa/racks/recheck.py`: change the select to include the form factor and pass it:

```python
    rows = (await db.execute(
        select(InitiativeAsset, Asset.name, Asset.serial_number,
               AssetModel.ru_size, AssetModel.form_factor)
        .join(Asset, Asset.id == InitiativeAsset.asset_id)
        .outerjoin(AssetModel, AssetModel.id == Asset.model_id)
        .where(InitiativeAsset.initiative_id == initiative_id))).all()

    placed: list[Placed] = []
    for ia, name, serial, ru_size, form_factor in rows:
        if ia.destination_rack and ia.destination_ru is not None:
            placed.append(place(key=str(ia.id), label=name or serial or "",
                                rack=ia.destination_rack, ru=ia.destination_ru,
                                height=ru_size, form_factor=form_factor))
```

(The later loop `for ia, *_ in rows:` is unchanged.)

`gather.py`: in `MoveAsset` add after `category_color: str | None = None`:

```python
    # Model form factor (0068): standalone | chassis | node | None. Read by
    # the placement rule and the rail report; defaulted for fixtures.
    form_factor: str | None = None
```

and in `gather()` add `form_factor=m.form_factor if m else None,` after `category_color=cat.color if cat else None,`.

`compute.py`: in `collisions()` replace `form_factor=getattr(a, "form_factor", None)` with `form_factor=a.form_factor`. Replace `rail_summary` (lines 101-115) with:

```python
def rail_summary(assets: list[MoveAsset]) -> RailSummary:
    """Nodes live inside a chassis and have no rails of their own, so a
    model flagged `node` is left out of the rail counts entirely. The load
    summary still counts them: they move as separate items."""
    railed = [a for a in assets if a.form_factor != "node"]
    groups: dict[tuple[str, str], list[MoveAsset]] = defaultdict(list)
    for a in railed:
        groups[_model_key(a)].append(a)
    counts: dict[str, int] = defaultdict(int)
    models = []
    for key in sorted(groups):
        rows = groups[key]
        rail = rows[0].rail_type or "N/A"
        counts[rail] += len(rows)
        models.append(ModelRail(make=rows[0].make, model=rows[0].model, count=len(rows),
                                rail_type=rail, ru_size=_ru(rows[0])))
    rail_types = sorted((RailTypeCount(k, v) for k, v in counts.items()),
                        key=lambda x: (-x.count, x.rail_type))
    return RailSummary(total_assets=len(railed), rail_types=rail_types, models=models)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_rack_recheck.py api/tests/test_move_report_compute.py api/tests/test_move_report_render.py api/tests/test_move_asset_import_commit.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/racks/recheck.py api/src/serversherpa/reports/move_report api/tests/test_rack_recheck.py api/tests/test_move_report_compute.py
git commit -m "feat(racks): form factor feeds mismatch orphans and excludes nodes from the rail report

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 12: Make/model lookup key normalization

**Files:**
- Modify: `api/src/serversherpa/imports/move_assets.py:9-15,164-173,267-275`
- Test: `api/tests/test_model_key_normalization.py`
- Modify: `docs/superpowers/specs/2026-09-21-rack-node-slots-design.md` ("Phase three" section)

**Interfaces:**
- Produces: `normalize_model_key(text: str) -> str`, used for every `model_map` key and lookup in `run_import`. Stored make and model strings are never rewritten.

The spec's phase three claims the H5600 pair would match after normalization. It would not: the import string `Dell H5600 node` has no `Isilon` and the catalog rows have no plain `Dell`. Stripping `(Chassis)` and `(Node)` would also be wrong, because those words are what distinguish two real catalog rows. So normalization keeps every word, and only removes the noise that produces accidental duplicates: underscores, parentheses, a trailing height token like `2U`, and whitespace and case. The H5600 rows are handled by the form-factor backfill (Task 8): the force-created models now carry the right form factor, and the next import of the same strings matches them exactly, as it already does. The spec is corrected in this task.

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_model_key_normalization.py
"""normalize_model_key: the lookup key used to match an imported
make/model string against the catalog (exact rows and aliases). Keeps
every word — "(Chassis)" and "(Node)" distinguish real rows — and only
removes the noise that creates accidental duplicates."""

from serversherpa.db.models import AssetModel
from serversherpa.imports.move_assets import normalize_model_key, parse_row, run_import
from serversherpa.imports.parsing import CANONICAL

from .test_move_asset_import_commit import _move


def test_normalizes_underscores_parens_height_whitespace_and_case():
    assert normalize_model_key("DellEMC_Isilon H5600 Storage (Node)") == "dellemc isilon h5600 storage node"
    assert normalize_model_key("DellEMC Isilon H5600 (Chassis)") == "dellemc isilon h5600 chassis"
    assert normalize_model_key("Netapp AFF A900 (Chassis) 8U") == "netapp aff a900 chassis"
    assert normalize_model_key('EMC 25x2.5" Disk Array Enclosure 2U') == 'emc 25x2.5" disk array enclosure'
    assert normalize_model_key("  Dell   R740 ") == "dell r740"
    assert normalize_model_key("Dell R740") == normalize_model_key("dell r740")


def test_chassis_and_node_variants_stay_distinct():
    assert normalize_model_key("X H5600 (Chassis)") != normalize_model_key("X H5600 (Node)")


def test_a_height_token_is_only_stripped_at_the_end():
    assert normalize_model_key("2U Shelf Kit") == "2u shelf kit"


async def test_import_matches_an_underscore_and_parenthesis_variant(db):
    ini = await _move(db)
    db.add(AssetModel(make="DellEMC", model="Isilon H5600 (Chassis)", ru_size=4))
    await db.commit()
    canonical = {c: "" for c in CANONICAL}
    canonical.update(serial_number="CH-1", asset_make="DellEMC_Isilon",
                     asset_model="H5600 Chassis 4U",
                     destination_rack="R1", destination_ru="10")
    row = parse_row(2, canonical, {}, generate_serials=False)
    result = await run_import(db, initiative_id=ini.id, added_by=None,
                              rows=[row], make_model_mode="fuzzy", write=True)
    detail = result["details"][0]
    assert detail["match_method"] == "exact", detail
    assert result["summary"].get("models_created", 0) == 0
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_model_key_normalization.py -q`
Expected: `ImportError: cannot import name 'normalize_model_key'`.

- [ ] **Step 3: Implement**

In `api/src/serversherpa/imports/move_assets.py`, add `import re` to the imports (after `import random`), and after `resolve_make_model_for_creation` (ends line 50) add:

```python
_HEIGHT_TOKEN = re.compile(r"\s+\d+u$", re.IGNORECASE)


def normalize_model_key(text: str) -> str:
    """The lookup key for matching an imported make/model string against
    the catalog. Every word is kept — "(Chassis)" and "(Node)" tell two
    real rows apart — and only the noise that manufactures accidental
    duplicates goes: underscores become spaces, parentheses are dropped,
    a trailing height token such as "4U" is removed, whitespace collapses,
    case folds. Lookup only; stored make and model are never rewritten."""
    s = text.replace("_", " ").replace("(", " ").replace(")", " ")
    s = " ".join(s.split())
    s = _HEIGHT_TOKEN.sub("", s)
    return s.lower()
```

In `_lookups` (lines 164-173) change the two keying lines:

```python
    models: dict[str, tuple] = {}
    for m in await db.scalars(select(AssetModel)):
        display = f"{m.make} {m.model}".strip()
        models[normalize_model_key(display)] = (m, "exact", display)
    alias_rows = (await db.execute(
        select(AssetModelAlias.alias, AssetModel)
        .join(AssetModel, AssetModel.id == AssetModelAlias.model_id))).all()
    for alias, m in alias_rows:                # exact wins over alias
        models.setdefault(
            normalize_model_key(alias), (m, "fuzzy", f"{m.make} {m.model}".strip()))
```

In `_one_row` (lines 267-275) change `mm_key = r["make_model_str"].lower()` to `mm_key = normalize_model_key(r["make_model_str"])` and `resolved_key = resolved_display.lower()` to `resolved_key = normalize_model_key(resolved_display)`.

- [ ] **Step 4: Correct the spec**

In `docs/superpowers/specs/2026-09-21-rack-node-slots-design.md`, replace the "Phase three: matcher normalization" section body with:

```markdown
`normalize_model_key` is the lookup key for every catalog match in the
importer, exact rows and aliases alike: underscores become spaces,
parentheses are dropped, a trailing height token such as `4U` is removed,
whitespace collapses and case folds. Every word is kept, because
`(Chassis)` and `(Node)` are what tell two real catalog rows apart. The
normalized form is used for **lookup only**; stored make and model are
never rewritten.

That closes the accidental-duplicate cases (`DellEMC_Isilon H5600
Chassis 4U` now finds `DellEMC Isilon H5600 (Chassis)`). It does not,
and should not, bridge `Dell H5600 node` to `DellEMC_Isilon H5600
Storage (Node)`: the import string has no `Isilon` and the catalog row
has no bare `Dell`. Those two force-created models stay in the catalog
with their 41 assets; the migration's form-factor backfill gives them the
right form factor, and the next import of the same strings matches them
exactly as it already does. Folding them into the V2-imported rows is a
merge-tool job (a separate parity item).
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests/test_model_key_normalization.py api/tests/test_move_asset_import_commit.py api/tests/test_move_asset_import_validate.py -q`
Expected: all pass. (If `test_move_asset_import_validate.py` does not exist, run `api/tests/test_move_asset_import*`.)

- [ ] **Step 6: Commit**

```bash
git add api/src/serversherpa/imports/move_assets.py api/tests/test_model_key_normalization.py docs/superpowers/specs/2026-09-21-rack-node-slots-design.md
git commit -m "feat(imports): normalized make/model lookup keys (underscores, parentheses, height tokens); spec corrected

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 13: Full suites, dev migration, live verification, wrap-up

**Files:**
- No source changes expected. Ledger `.superpowers/sdd/progress.md`; memory note.

- [ ] **Step 1: Full API suite (once)**

Run: `SS_TEST_DB=serversherpa_test_racknodes PYTHONPATH=api/src api/.venv/bin/python -m pytest api/tests -q -x --timeout=1800 2>&1 | tail -15`
Expected: all pass, about 20 minutes. Fix anything that fails before continuing; do not merge with a red suite.

- [ ] **Step 2: Full portal suite and type check (once more)**

Run: `npm --prefix portal run test` and `npm --prefix portal exec -- tsc --noEmit`
Expected: all pass.

- [ ] **Step 3: Apply migration 0068 to the dev database**

The dev stack on ports 8000 / 5173 / 5174 runs from the primary checkout on `main`, against the dev database. Applying 0068 there ahead of the merge is safe: `main`'s code ignores the extra column and the extra status row.

Run from the worktree: `PYTHONPATH=api/src api/.venv/bin/alembic -c api/alembic.ini upgrade head` (if alembic complains about `migrations` not existing, run it as `(cd api && PYTHONPATH=src .venv/bin/alembic upgrade head)`).
Expected: `Running upgrade 0067 -> 0068`.

- [ ] **Step 4: Start a second stack from the worktree on alternate ports**

The example initiative lives in the dev database, so verification runs against it with this branch's API and portal.

```bash
PYTHONPATH=api/src api/.venv/bin/python -m uvicorn --factory serversherpa.api.app:create_app --app-dir api/src --host 0.0.0.0 --port 8001
```
in the background, and
```bash
VITE_API_URL=http://localhost:8001 npm --prefix portal run dev -- --port 5175 --strictPort
```
in the background. `npm --prefix portal run build:rack-renderer` must have been run (Task 7) so the branch's `dist-node/render-rack.js` exists; the report worker is not needed for the steps below.

- [ ] **Step 5: Live verification on the example initiative**

Sign in on `http://localhost:5175` with the documented dev account. Open `/initiatives/a1330cc7-ff79-44fa-9e83-e692796e4bb6`.

1. Before: the Assets panel shows 41 rows with the Location Collision chip.
2. Click **Re-check placement**. Expected toast: `Placement re-checked: 0 collisions, 0 orphan nodes, 41 flags cleared.` and every one of those rows now shows Loaded.
3. Click the destination rack cell `14.03.02B.01.10`. Expected: nine chassis faceplates, each with two or four numbered slot pills on its right half; no overlapping 1U boxes at 1.1 to 1.4 and so on; the device list shows each chassis followed by its nodes indented with RU text like `33.1`. Hover a pill: tooltip shows the node name, serial, RU `33.1` and `Inside <chassis name>`.
4. Open source rack `BJ01` (via the `san-01` row): the row at RU `3.5` draws as a dashed amber orphan block labeled `! san-01` and the list shows `3.5`.
5. Generate a Move Report with the Collision section on for this initiative (Reports page, this worktree's portal; the report worker is not running on 8001, so instead assert via the API test already green in Task 3 and skip the PDF here), OR run the report worker from the worktree once: `PYTHONPATH=api/src api/.venv/bin/serversherpa report-worker --once` after requesting the run. Expected: the Collision section reads `No collisions.` and lists `san-01` under Orphan nodes.
6. Makes / Models: `Dell Isilon H5600` shows form factor blank (its name has no chassis word) and `Dell H5600 node` shows **Node**; the V2-imported `DellEMC Isilon H5600 (Chassis)` shows **Chassis**. Edit `Dell Isilon H5600`, set Form factor to Chassis and RU size to 4, save. Re-check placement again: still 0 collisions, 0 orphans.
7. Take screenshots of the rack modal (step 3) and the Assets panel after the re-check (step 2) into the scratchpad for the user.

Record each step's outcome in the ledger. Then stop the two background servers.

- [ ] **Step 6: Merge**

`main` is checked out in the primary checkout, which the user's dev stack runs from. Merge there:

```bash
cd /Users/jrh1812/Developer/BaseCampV3 && git merge --no-ff rack-node-slots -m "Merge branch 'rack-node-slots': slot-aware rack placement, orphan_node status, re-check action, model form factor

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

Then in the primary checkout: `npm --prefix portal run build:rack-renderer` so the report worker on the main stack renders nodes. The running uvicorn (`--reload`) and Vite pick up the merged code; the dev database is already at 0068 from Step 3. Confirm `http://localhost:5173/initiatives/a1330cc7-ff79-44fa-9e83-e692796e4bb6` renders. Remove the worktree: `git worktree remove .claude/worktrees/rack-nodes` and `git branch -d rack-node-slots`.

- [ ] **Step 7: Memory and ledger**

Append to `/Users/jrh1812/.claude/projects/-Users-jrh1812-Developer-BaseCampV3/memory/initiatives-timeline.md` or a new `rack-node-slots.md` memory (indexed in `MEMORY.md`): the placement rule module path, that `N.x` is a slot by convention and the form factor is enrichment only, the re-check endpoint, migration 0068, the `SS_TEST_DB` per-branch trick, and the normalization finding (chassis/node words must be kept). Finalize the ledger.

---

## Self-review

**Spec coverage.** Placement rule table: Task 1 (every row has a test, including the `3.5` case and both mismatch reasons). Statuses and the never-drag-back rule: Task 2. Re-check endpoint, permission, audit, `not_a_move`: Task 4; portal action and toast: Task 5. Rack elevation children, orphan marker, hover naming the parent, indented device list, report reuse via the Node renderer: Tasks 6 and 7. Migration 0068 with column, check, status seed and name backfill: Task 8. Model API and editor, chip, export: Tasks 9 and 10. Form factor in the rule and the rail report: Task 11. Matcher normalization: Task 12, with the spec corrected where its claim did not hold. Live verification and sequencing: Task 13. Out-of-scope items untouched.

**Placeholders.** None. Two conditional instructions are deliberate and mechanical: adding missing `RackBlock` / `AssetModelItem` fields to any fixture `tsc` flags, and the fallback test-file globs in Tasks 9 and 12.

**Type consistency.** `place(key, label, rack, ru, height, form_factor)` is called with keywords everywhere. `recheck_placement` returns the four keys `checked / collisions / orphans / cleared`, which `PlacementRecheckOut`, the audit changes, the portal `PlacementRecheck` interface and the toast all use. `RackBlock.slot / children / orphan` and `RackChild` are defined in Task 6 and consumed by name in Task 7. `FORM_FACTORS` is defined in both the API route (tuple) and `lib/assets.ts` (option list) under the same name, in different languages. `Collision.collision_type` values match `COLLISION_LABELS` keys after Task 3.

---

## Amendment 2026-09-21: user direction after live review

### Task 14: Two rack elevations when nodes are present (replaces the slot pills)

**User direction (2026-09-21):** "I'm not a fan of how we are displaying the parent and child devices on the rack view. Let's generate 2 rack views when nodes or children are present, kind of the same as we do for front and rear views. One view holds parent devices and the other shows the nodes spaced evenly in the available space without the parent name."

**Files:**
- Modify: `portal/src/lib/initiatives.ts` (`RackChild`, `RackBlock`, `rackLayout`, new `nodeBlocks`)
- Modify: `portal/src/components/initiatives/RackElevation.tsx` (remove pills; label suppression for short cells; tooltip)
- Modify: `portal/src/components/initiatives/RackViewModal.tsx` (render the node elevations; hover for node cells)
- Modify: `portal/src/reports/renderRack.tsx` (mirror the modal)
- Modify: `portal/src/lib/rackPrint.ts` (captions for any number of frames)
- Modify: `portal/src/styles/rack-svg.css` (drop the pill rule), `api/tests/fixtures/rack_fragment.html` (re-capture, same in-place recipe as the Task 7 fix report)
- Modify: `api/src/serversherpa/reports/move_report/templates/move_report.html` and/or `render.py` CSS if a rack page with three or four frames overflows the page width
- Tests: `portal/src/lib/initiatives.test.ts`, `portal/src/components/initiatives/RackViewModal.test.tsx`, `RackViewModal.render.test.tsx`, `portal/src/lib/rackPrint.test.ts`, `api/tests/test_move_report_render.py`

**Interfaces:**
- Consumes: `rackLayout` output (`RackBlock` with `children: RackChild[]`), `RackElevation`, `ghostBlocksFor`, `isRearPosition`, `tooltipRows`.
- Produces: `nodeBlocks(blocks: RackBlock[]): RackBlock[]`; `RackBlock.orphan: 'no_chassis' | 'form_factor' | null` (was boolean); `RackBlock.parentRu?: number`, `RackBlock.parentLabel?: string` (set only on node cells); `RackChild` gains `position: string | null` (already), `categoryLabel: string | null`, `categoryColor: string | null`; `buildRackPrintHtml` takes `frames: { heading: string; svg: string }[]` instead of `svgs: string[]`.

#### Design

**Model (`lib/initiatives.ts`).**

1. `RackChild` carries the node's own `categoryLabel` and `categoryColor` (from `r.asset.model_category_label/color`) in addition to `id, label, slot, serial, makeModel, verified, position`.
2. `RackBlock.orphan` becomes `'no_chassis' | 'form_factor' | null`. `rackLayout` sets `'form_factor'` for a `node`-form-factor row at an integer RU and for a `standalone`-form-factor row at a slot; `'no_chassis'` for a slot row with no adoptable parent; `null` otherwise. Truthiness checks (`b.orphan ?`) keep working; update the type of the `block()` test helper and every fixture.
3. Parent lookup for a slot row (this is final-review N2): if the row's own position is set, look up `sideKey(position, base)`; if it is blank, try `F:${base}` then `R:${base}` (blank means unstated, not front). A `standalone`-form-factor row is never adopted.
4. New pure helper:

```ts
/** The node elevation's blocks: every child of every block that has
 *  children, as its own cell filling an equal share of the parent's RU
 *  span, ascending slot from the bottom. Nothing else is included; the
 *  caller adds ghosts for the child-less devices so the frame keeps its
 *  RU context. */
export function nodeBlocks(blocks: RackBlock[]): RackBlock[] {
  const out: RackBlock[] = [];
  for (const b of blocks) {
    const n = b.children.length;
    if (n === 0) continue;
    const share = b.height / n;
    b.children.forEach((c, i) => out.push({
      id: c.id, label: c.label,
      ru: b.ru + i * share, height: share,
      verified: c.verified, position: b.position,
      categoryLabel: c.categoryLabel ?? b.categoryLabel,
      categoryColor: c.categoryColor ?? b.categoryColor,
      makeModel: c.makeModel, slot: c.slot, children: [], orphan: null,
      parentRu: b.ru, parentLabel: b.label,
    }));
  }
  return out;
}
```

   A 4U chassis at 33 with nodes in slots 1 to 4 yields cells at ru 33, 34, 35, 36 each of height 1; with two nodes, cells at 33 and 35 of height 2; a 1U chassis (unknown `ru_size`) with four nodes yields four 0.25U cells. `RackElevation` already positions by `yForRu(ru + height)` and sizes by `height * U_PX`, so fractional values draw correctly.

**Drawing (`RackElevation.tsx`).**

5. Remove the slot pills entirely: `slotPillGeometry`, `SlotPillRect`, the `onHoverChild` prop, the pill JSX, and the `.rack-node-label` rule in `rack-svg.css`. Re-capture `api/tests/fixtures/rack_fragment.html` in place exactly as the Task 7 fix did (replace the three `<style>` bodies with the current stylesheet, comments stripped, outer copy filtered by `htmlOnlyCss`), then run `api/tests/test_move_report_render.py`.
6. A block whose pixel height is under 10px draws its rect but no label (a 0.25U cell is 4px tall). Keep the label logic otherwise unchanged; an orphan still gets the `! ` prefix and the dashed amber outline; the `Note` row of `tooltipRows` now says exactly one thing per reason: `'No device starts at this RU'` for `no_chassis`, `'Model form factor does not match its position'` for `form_factor` (pass the reason string in, not a boolean).
7. `tooltipRows` gains `position` for node cells (N5: the node's own side) and keeps `parentLabel` → `Inside`.

**Modal (`RackViewModal.tsx`).**

8. For each side that is rendered (FRONT always; REAR when it has real blocks), if `nodeBlocks(sideBlocks)` is non-empty, render a second `<RackElevation>` immediately after it with heading `FRONT · NODES` / `REAR · NODES`, `ariaLabel` `Rack ${rackName} — ${sideLabel} — front nodes elevation` (and `rear nodes`), and blocks `[...nodeBlocks(sideBlocks), ...ghostBlocksFor(sideBlocks.filter((b) => b.children.length === 0))]` so switches and other child-less devices appear as blank outlines for RU context while every chassis area is filled by its node cells. The devices view draws chassis as ordinary faceplates (no pills) with their children invisible there.
9. Hover on a node cell resolves the roster row by the cell's `id` (a child's id is its row id), shows the node's name as the title and `tooltipRows({ serial, makeModel, ru: `${parentRu}.${slot}`, position: <the child's own position from the roster row>, parentLabel })`. Hover on a chassis in the devices view shows the chassis as today.
10. `deviceListRows` and `RackDeviceList` are unchanged. The unplaced count already includes children; keep it.

**Print sheet and report.**

11. `buildRackPrintHtml` takes `frames: { heading: string; svg: string }[]`; caption every frame with its heading when there is more than one frame (today captions exist only for exactly two). The modal collects headings from the rendered `.rack-elevation-heading` elements next to each `.rack-svg`, or simply builds the array itself from the same conditions it used to render.
12. `renderRack.tsx` mirrors the modal: front devices, front nodes (if any), rear devices (if any real rear blocks), rear nodes (if any). Rebuild the bundle (`npm --prefix portal run build:rack-renderer`).
13. Check the report's rack page for width: a rack with rear devices and nodes on both sides is four 190px frames plus 24px gaps. Read the `.rack-page` / `.rack-elevations` CSS in `move_report.html` (and `rack-svg.css` outer copy) and, if four frames cannot fit the printable width, add `flex-wrap: wrap` to `.rack-elevations` in the report's stylesheet only (not the modal). Add an assertion in `test_move_report_render.py` only if you changed the template.

**Tests.**

- `initiatives.test.ts`: `nodeBlocks` cases for 4-in-4U, 2-in-4U, 4-in-1U (fractional), slot order bottom-up, category fallback to the parent, `parentRu`/`parentLabel`; the N2 case "a blank-position node attaches to the rear chassis at its base when no front block starts there"; the orphan reason values for both mismatch cases and for no_chassis.
- `RackViewModal.render.test.tsx`: the chassis-with-nodes test now expects two `role="img"` elevations for the source side named `… front elevation` and `… front nodes elevation`, node names as faceplate labels inside the nodes elevation (query within that svg), NO element with an aria-label starting `Slot `, no `role="status"` note; a hover test on a node cell asserting `Inside chassis-a`, RU `33.1`; a test that a rack with only child-less devices renders exactly one elevation.
- `RackViewModal.test.tsx`: delete the `slotPillGeometry` describe; extend the `tooltipRows` test for the two Note strings.
- `rackPrint.test.ts`: captions for one, two and three frames.
- Whole portal suite, `tsc`, bundle build, and `api/tests/test_move_report_render.py` all clean.

**Commit** (portal + fixture + any template change together):

```
feat(portal): rack view draws a second Nodes elevation per side, nodes filling their chassis span; pills removed

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```
