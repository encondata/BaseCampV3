# Bulk Trucks Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `/bulk/trucks` tool that adds or updates trucks from a csv/xlsx upload, matching existing trucks by name, with per-row update-or-skip, template, export, and the per-row review summary; plus the portal's bulk page shell and upload pane extracted into shared components used by sites, workers, and trucks.

**Architecture:** `api/src/serversherpa/trucks/bulk_import.py` on the shared core (`imports/bulk.py`), four routes in the trucks router using `api/bulk_routes.py`. Portal: new `components/bulk/BulkToolPage.tsx` and `components/bulk/BulkUpload.tsx`; `BulkSites`/`BulkWorkers` pages and `WorkerBulkUpload` become thin configurations; `BulkTrucks`/`TruckBulkUpload` are the third.

**Tech Stack:** FastAPI + SQLAlchemy async + openpyxl; React + TypeScript + vitest + Testing Library. Real Postgres test DB via `SS_TEST_DB`.

Spec: `docs/superpowers/specs/2026-09-22-bulk-trucks-import-design.md`.

## Global Constraints

- Work in the worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks` (branch `bulk-trucks-import`). Never `cd` to the main checkout.
- API commands run from `<worktree>/api` with `PYTHONPATH=<worktree>/api/src` and `SS_TEST_DB=serversherpa_test_bulk_trucks`. Example: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_trucks .venv/bin/pytest tests/test_x.py -q`. PYTHONPATH is mandatory.
- Portal commands run from `<worktree>/portal`: `npx vitest run <file>`, `npx tsc --noEmit`, `npm run build`. Never `npm install` in the worktree.
- Every test command runs in the FOREGROUND in one call with a 600000 ms timeout; never background a suite.
- `git checkout -- api/src/serversherpa/_dev_reload.py` before every commit if it shows modified; never commit it.
- American English in copy, comments, and docs.
- No new `.bulk-*` typography rules in CSS.
- Sites and workers bulk behavior stays byte-identical: `api/tests/test_sites_bulk_import_*.py`, `api/tests/test_workers_bulk_import_*.py`, `test_containers_bulk_import.py`, `portal/src/components/sites/SiteBulkUpload.test.tsx`, `portal/src/components/workers/WorkerBulkUpload.test.tsx`, `portal/src/pages/BulkSites.test.tsx`, `portal/src/pages/BulkWorkers.test.tsx` pass with their assertions unchanged.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## File Structure

API
- Create `api/src/serversherpa/trucks/bulk_import.py` — columns, `parse_bool`, `split_names`, wrappers, `reference_lists`, `export_rows`, `preview_rows`, `commit_rows`.
- Modify `api/src/serversherpa/api/routes/trucks.py` — bulk block above `GET /{truck_id}`.
- Create `api/tests/test_trucks_bulk_import_service.py`, `api/tests/test_trucks_bulk_import_api.py`.

Portal
- Create `portal/src/components/bulk/BulkToolPage.tsx`, `portal/src/components/bulk/BulkUpload.tsx`.
- Modify `portal/src/components/bulk/BulkApplySummary.tsx` (`changesText` add/remove for any field), `portal/src/pages/BulkSites.tsx`, `portal/src/pages/BulkWorkers.tsx`, `portal/src/components/workers/WorkerBulkUpload.tsx` (wrappers).
- Create `portal/src/lib/truckBulk.ts` + test, `portal/src/components/trucks/TruckBulkUpload.tsx` + test, `portal/src/pages/BulkTrucks.tsx` + test.
- Modify `portal/src/lib/api.ts`, `portal/src/pages/BulkActions.tsx` + test, `portal/src/App.tsx`, `portal/src/pages/Trucks.tsx`.

---

### Task 1: Trucks importer — columns, parsers, template, export

**Files:**
- Create: `api/src/serversherpa/trucks/bulk_import.py`
- Test: `api/tests/test_trucks_bulk_import_service.py`

**Interfaces:**
- Consumes: `serversherpa.imports.bulk` (`number_json_rows(rows, columns)`, `parse_upload(filename, content, columns, sheet)`, `build_rows_csv(rows, columns)`, `build_rows_xlsx(rows, columns, sheet, reference)`), models `Truck`, `TruckContainer`, `Container`, `Site`, `Initiative`, `StatusValue`.
- Produces: `COLUMNS` (15), `SHEET = "Trucks"`, `TEXT_COLUMNS`, `TRACKING_KEYS`, `REF_COLUMNS`, `SEAL_MAX = 24`, `SAMPLE_ROWS`, `parse_bool(text) -> bool | None`, `split_names(cell) -> list[str]`, `number_json_rows`, `parse_upload`, `build_rows_csv`, `build_rows_xlsx(rows, statuses, initiatives, sites)`, `build_template_csv()`, `build_template_xlsx(statuses, initiatives, sites)`, `async reference_lists(db) -> (statuses, initiative names, site names)`, `async export_rows(db)`, `async _linked_containers(db, truck_ids) -> dict[truck_id, dict[container_id, name]]`.

- [ ] **Step 1: Write the failing tests**

Create `api/tests/test_trucks_bulk_import_service.py`:

```python
"""Trucks bulk import pipeline (no HTTP): parsers, template, export,
preview, commit."""
import io
import uuid

import openpyxl
import pytest
from sqlalchemy import func, select

from serversherpa.db.models import (
    AuditLog, Container, Initiative, Site, Truck, TruckContainer,
)
from serversherpa.trucks import bulk_import as bi


async def preview(db, rows):
    return await bi.preview_rows(db, bi.number_json_rows(rows))


async def one(db, row):
    return (await preview(db, [row]))["rows"][0]


async def commit(db, actor, rows, approved=(), source="test.csv"):
    return await bi.commit_rows(db, actor.id, bi.number_json_rows(rows),
                                approved_updates=set(approved), source_label=source)


async def mk_truck(db, name, **fields):
    containers = fields.pop("containers", [])
    truck = Truck(name=name, **fields)
    db.add(truck)
    await db.flush()
    for c in containers:
        db.add(TruckContainer(truck_id=truck.id, container_id=c.id))
    await db.commit()
    return truck


async def mk_initiative(db, name):
    """A minimal initiative row; the model needs a kind and dates — copy the
    columns tests/test_initiative_assets_api.py::_move posts, filled directly."""
    init = Initiative(name=name, kind="move")
    db.add(init)
    await db.commit()
    return init


# ── shape / parsers / template ──────────────────────────────────────

def test_columns_match_canonical_shape():
    assert bi.COLUMNS == [
        "name", "status", "driver_name", "co_driver_name", "team_drive",
        "contact_info", "load_number", "seal_id", "tracking_type",
        "tracking_update_type", "tracker_id", "initiative", "start_site",
        "end_site", "containers"]


def test_parse_bool_and_split_names():
    assert bi.parse_bool("Yes") is True and bi.parse_bool("TRUE") is True
    assert bi.parse_bool("1") is True and bi.parse_bool("y") is True
    assert bi.parse_bool("no") is False and bi.parse_bool("0") is False
    assert bi.parse_bool("maybe") is None and bi.parse_bool("") is None
    assert bi.split_names(" Crate A ; Crate B;;") == ["Crate A", "Crate B"]
    assert bi.split_names("") == []


def test_csv_and_json_normalize_identically():
    from_csv = bi.parse_upload("t.csv", bi.build_template_csv().encode())
    from_json = bi.number_json_rows(bi.SAMPLE_ROWS)
    assert [r for _, r in from_csv] == [r for _, r in from_json]
    assert [n for n, _ in from_csv] == [2, 3]


def test_xlsx_template_round_trips_with_reference_blocks():
    blob = bi.build_template_xlsx(["created", "active"], ["Move A"], ["DC-East"])
    wb = openpyxl.load_workbook(io.BytesIO(blob))
    assert wb.sheetnames == ["Trucks", "Reference"]
    ref = [row[0].value for row in wb["Reference"].iter_rows()]
    assert ref == ["Valid statuses", "created", "active", None,
                   "Initiative names", "Move A", None, "Site names", "DC-East"]
    rows = bi.parse_upload("t.xlsx", blob)
    assert [r for _, r in rows] == [r for _, r in bi.number_json_rows(bi.SAMPLE_ROWS)]


# ── export ──────────────────────────────────────────────────────────

async def test_export_rows_shape_and_round_trip(db, seeded_user):
    site_a, site_b = Site(name="DC-East"), Site(name="DC-West")
    crate_a, crate_b = Container(name="Crate A"), Container(name="Crate B")
    db.add_all([site_a, site_b, crate_a, crate_b])
    await db.flush()
    move = await mk_initiative(db, "Move A")
    await mk_truck(db, "Zulu", status="in_transit", driver_name="Marcus", team_drive=True,
                   contact_info="+1 555", load_number="L-1", seal_id="S-1",
                   tracking_type={"type": "gps", "update_type": "API", "tracker_id": "T-1"},
                   initiative_id=move.id, start_site_id=site_a.id, end_site_id=site_b.id,
                   containers=[crate_b, crate_a])
    await mk_truck(db, "Alpha")
    await mk_truck(db, "Gone", archived_at=func.now())
    rows = await bi.export_rows(db)
    assert [r["name"] for r in rows] == ["Alpha", "Zulu"]
    assert set(rows[0]) == set(bi.COLUMNS)
    assert rows[0]["status"] == "created" and rows[0]["team_drive"] == "no"
    z = rows[1]
    assert z["team_drive"] == "yes" and z["tracking_type"] == "gps"
    assert z["tracking_update_type"] == "API" and z["tracker_id"] == "T-1"
    assert z["initiative"] == "Move A" and z["start_site"] == "DC-East"
    assert z["end_site"] == "DC-West" and z["containers"] == "Crate A; Crate B"

    csv_text = bi.build_rows_csv(rows)
    out = await preview(db, [r for _, r in bi.parse_upload("e.csv", csv_text.encode())])
    assert [r["action"] for r in out["rows"]] == ["unchanged", "unchanged"]


async def test_reference_lists(db, seeded_user):
    db.add(Site(name="Bee Site"))
    db.add(Site(name="Ant Site"))
    await db.flush()
    await mk_initiative(db, "Move Z")
    statuses, initiatives, sites = await bi.reference_lists(db)
    assert statuses == ["created", "active", "in_transit", "at_destination",
                        "inactive", "historical"]
    assert initiatives == ["Move Z"]
    assert sites == ["Ant Site", "Bee Site"]
```

Before running, check the `Initiative` model's required columns (`grep -n "class Initiative(" -A40 api/src/serversherpa/db/models.py`) and how `api/tests/test_initiative_assets_api.py::_move` creates one; adjust `mk_initiative` to supply whatever NOT NULL columns the model has (for example `kind`, `client_id`, `start_date`) and note the adjustment in your report. The intent is one initiative row with the given name.

- [ ] **Step 2: Run to verify it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_trucks .venv/bin/pytest tests/test_trucks_bulk_import_service.py -q`
Expected: `ModuleNotFoundError: No module named 'serversherpa.trucks.bulk_import'`.

- [ ] **Step 3: Create the module**

Create `api/src/serversherpa/trucks/bulk_import.py`:

```python
"""Trucks bulk import: parse (via imports/bulk) → match by name →
preview/commit. Mirrors people/bulk_import.py.

Rows match an existing (non-archived) truck by name, case-insensitively.
Blank-cell rule: on create rows a blank status / team_drive / contact_info
takes the default (created / no / empty); on update rows a blank cell means
"no change", never a clear. Each preview row carries `cells` (the uploaded
cells before defaults) — the commit replays those, never `data`.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Container, Initiative, Site, StatusValue, Truck, TruckContainer,
)
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import MAX_BYTES, MAX_ROWS, BulkImportError
from serversherpa.services.audit import audit, snapshot

__all__ = ["BulkImportError", "MAX_BYTES", "MAX_ROWS"]

COLUMNS = [
    "name", "status", "driver_name", "co_driver_name", "team_drive",
    "contact_info", "load_number", "seal_id", "tracking_type",
    "tracking_update_type", "tracker_id", "initiative", "start_site",
    "end_site", "containers",
]
SHEET = "Trucks"
TEXT_COLUMNS = ("name", "driver_name", "co_driver_name", "contact_info",
                "load_number", "seal_id")
# template column → key inside trucks.tracking_type (the edit modal's split)
TRACKING_KEYS = {"tracking_type": "type", "tracking_update_type": "update_type",
                 "tracker_id": "tracker_id"}
# template column → Truck foreign-key attribute
REF_COLUMNS = {"initiative": "initiative_id", "start_site": "start_site_id",
               "end_site": "end_site_id"}
AUDIT_FIELDS = [
    "name", "driver_name", "co_driver_name", "team_drive", "contact_info",
    "status", "load_number", "seal_id", "tracking_type",
    "initiative_id", "start_site_id", "end_site_id",
]
SEAL_MAX = 24
TRUE_WORDS = {"yes", "y", "true", "1"}
FALSE_WORDS = {"no", "n", "false", "0"}

SAMPLE_ROWS: list[dict] = [
    {"name": "Truck 12", "status": "active", "driver_name": "Marcus Reyes",
     "co_driver_name": "Dana Whitfield", "team_drive": "yes",
     "contact_info": "+1 (555) 010-2231", "load_number": "L-1042",
     "seal_id": "SEAL-88231", "tracking_type": "gps",
     "tracking_update_type": "API", "tracker_id": "TRK-0012",
     "initiative": "Example Move", "start_site": "Example DC West",
     "end_site": "Example Office", "containers": "Crate A; Crate B"},
    {"name": "Truck 13", "status": "", "driver_name": "Priya Natarajan",
     "co_driver_name": "", "team_drive": "no", "contact_info": "",
     "load_number": "L-1043", "seal_id": "", "tracking_type": "",
     "tracking_update_type": "", "tracker_id": "", "initiative": "",
     "start_site": "", "end_site": "", "containers": ""},
]


# ── parsers ─────────────────────────────────────────────────────────

def parse_bool(text: str) -> bool | None:
    """yes / no (also true / false, 1 / 0) in any case; None when the text
    is blank or not recognized."""
    key = (text or "").strip().lower()
    if key in TRUE_WORDS:
        return True
    if key in FALSE_WORDS:
        return False
    return None


def split_names(cell: str) -> list[str]:
    return [part.strip() for part in (cell or "").split(";") if part.strip()]


# ── parsing / templates (thin wrappers over the shared core) ────────

def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    return core.number_json_rows(rows, COLUMNS)


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    return core.parse_upload(filename, content, COLUMNS, SHEET)


def build_rows_csv(rows: list[dict]) -> str:
    return core.build_rows_csv(rows, COLUMNS)


def build_rows_xlsx(rows: list[dict], statuses: list[str],
                    initiatives: list[str], sites: list[str]) -> bytes:
    return core.build_rows_xlsx(rows, COLUMNS, SHEET, [
        ("Valid statuses", statuses), ("Initiative names", initiatives),
        ("Site names", sites)])


def build_template_csv() -> str:
    return build_rows_csv(SAMPLE_ROWS)


def build_template_xlsx(statuses: list[str], initiatives: list[str],
                        sites: list[str]) -> bytes:
    return build_rows_xlsx(SAMPLE_ROWS, statuses, initiatives, sites)


async def reference_lists(db: AsyncSession) -> tuple[list[str], list[str], list[str]]:
    """What the xlsx Reference sheet lists: truck status keys by sort order,
    initiative names, live site names, both alphabetical."""
    statuses = list(await db.scalars(
        select(StatusValue.key).where(StatusValue.record_type == "truck")
        .order_by(StatusValue.sort_order)))
    initiatives = list(await db.scalars(
        select(Initiative.name).order_by(Initiative.name)))
    sites = list(await db.scalars(
        select(Site.name).where(Site.archived_at.is_(None)).order_by(Site.name)))
    return statuses, initiatives, sites


# ── export ──────────────────────────────────────────────────────────

async def _linked_containers(
    db: AsyncSession, truck_ids: list[uuid.UUID],
) -> dict[uuid.UUID, dict[uuid.UUID, str]]:
    """truck_id → {container_id: container name} for the given trucks."""
    out: dict[uuid.UUID, dict[uuid.UUID, str]] = {}
    if not truck_ids:
        return out
    rows = (await db.execute(
        select(TruckContainer.truck_id, Container.id, Container.name)
        .join(Container, Container.id == TruckContainer.container_id)
        .where(TruckContainer.truck_id.in_(truck_ids)))).all()
    for truck_id, container_id, cname in rows:
        out.setdefault(truck_id, {})[container_id] = cname
    return out


async def export_rows(db: AsyncSession) -> list[dict]:
    """Every live truck in template shape, so an export re-uploads clean."""
    trucks = list(await db.scalars(
        select(Truck).where(Truck.archived_at.is_(None)).order_by(Truck.name)))
    initiative_names = dict((await db.execute(
        select(Initiative.id, Initiative.name))).all())
    site_names = dict((await db.execute(select(Site.id, Site.name))).all())
    linked = await _linked_containers(db, [t.id for t in trucks])
    out = []
    for t in trucks:
        tracking = t.tracking_type or {}
        row = {
            "name": t.name, "status": t.status or "",
            "driver_name": t.driver_name or "",
            "co_driver_name": t.co_driver_name or "",
            "team_drive": "yes" if t.team_drive else "no",
            "contact_info": t.contact_info or "",
            "load_number": t.load_number or "", "seal_id": t.seal_id or "",
            "initiative": (initiative_names.get(t.initiative_id, "")
                           if t.initiative_id else ""),
            "start_site": site_names.get(t.start_site_id, "") if t.start_site_id else "",
            "end_site": site_names.get(t.end_site_id, "") if t.end_site_id else "",
            "containers": "; ".join(sorted(linked.get(t.id, {}).values(),
                                           key=str.lower)),
        }
        for col, key in TRACKING_KEYS.items():
            value = tracking.get(key)
            row[col] = str(value) if value not in (None, "") else ""
        out.append(row)
    return out
```

- [ ] **Step 4: Run the tests that don't need preview**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_trucks .venv/bin/pytest tests/test_trucks_bulk_import_service.py -q -k "columns or parse_bool or normalize_identically or round_trips_with_reference or reference_lists"`
Expected: `5 passed`. (`test_export_rows_shape_and_round_trip` waits on `preview_rows` from Task 2.)

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks
git checkout -- api/src/serversherpa/_dev_reload.py 2>/dev/null
git add api/src/serversherpa/trucks/bulk_import.py api/tests/test_trucks_bulk_import_service.py
git commit -m "feat(trucks): bulk import columns, parsers, template, export

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Trucks importer — validation, matching, preview, diff

**Files:**
- Modify: `api/src/serversherpa/trucks/bulk_import.py` (append)
- Test: `api/tests/test_trucks_bulk_import_service.py` (append)

**Interfaces:**
- Produces: `async preview_rows(db, numbered) -> {"rows": [...], "can_commit": bool}`; row `{row, name, action, matched_by ("name" | None), matched_name, errors, diff, truck_id, cells, data}`; `data["team_drive"]` is a bool, `data["containers"]` a list of canonical container names, `data["initiative"|"start_site"|"end_site"]` canonical names. Diff keys are column names; `containers` diff is `{"add": [...], "remove": [...]}`.

- [ ] **Step 1: Append the failing preview tests**

Append to `api/tests/test_trucks_bulk_import_service.py`:

```python
# ── preview: validation ─────────────────────────────────────────────

async def test_validation_errors(db, seeded_user):
    db.add(Site(name="Twin Site"))
    db.add(Site(name="twin site"))
    db.add(Container(name="Crate A"))
    await db.commit()
    out = await preview(db, [
        {"name": ""},
        {"name": "A", "status": "flying"},
        {"name": "B", "team_drive": "maybe"},
        {"name": "C", "seal_id": "S" * 25},
        {"name": "D", "initiative": "Nowhere"},
        {"name": "E", "start_site": "Twin Site"},
        {"name": "F", "end_site": "Nowhere"},
        {"name": "G", "containers": "Crate A; Crate Z"},
        {"name": "Dup"},
        {"name": "dup"},
    ])
    errs = {r["row"]: r["errors"] for r in out["rows"]}
    assert errs[1] == ["name is required"]
    assert errs[2] == ["unknown status 'flying'"]
    assert errs[3] == ["team_drive must be yes or no"]
    assert errs[4] == ["seal_id is longer than 24 characters"]
    assert errs[5] == ["unknown initiative 'Nowhere'"]
    assert errs[6] == ["ambiguous site 'Twin Site'"]
    assert errs[7] == ["unknown site 'Nowhere'"]
    assert errs[8] == ["unknown container 'Crate Z'"]
    assert errs[9] == errs[10] == ["duplicate name 'Dup' within the import"] or \
        errs[10] == ["duplicate name 'dup' within the import"]
    assert out["can_commit"] is False


async def test_create_row_normalizes_and_defaults(db, seeded_user):
    site = Site(name="DC-East")
    crate = Container(name="Crate A")
    db.add_all([site, crate])
    await db.flush()
    await mk_initiative(db, "Move A")
    out = await preview(db, [{
        "name": "  Truck 1 ", "team_drive": "YES", "initiative": "move a",
        "start_site": "dc-east", "containers": "crate a", "tracking_type": "gps"}])
    row = out["rows"][0]
    assert row["action"] == "create" and row["matched_by"] is None
    assert row["name"] == "Truck 1"
    assert row["data"]["status"] == "created" and row["data"]["team_drive"] is True
    assert row["data"]["initiative"] == "Move A" and row["data"]["start_site"] == "DC-East"
    assert row["data"]["containers"] == ["Crate A"]
    assert row["cells"]["status"] == "" and row["cells"]["initiative"] == "move a"
    assert out["can_commit"] is True


# ── preview: matching ───────────────────────────────────────────────

async def test_match_by_name_and_ambiguity(db, seeded_user):
    await mk_truck(db, "Truck 7", driver_name="Old Driver")
    await mk_truck(db, "Twin")
    await mk_truck(db, "twin")
    await mk_truck(db, "Retired", archived_at=func.now())
    out = await preview(db, [
        {"name": "truck 7", "driver_name": "New Driver"},
        {"name": "Twin", "driver_name": "x"},
        {"name": "Retired"},
    ])
    rows = out["rows"]
    assert rows[0]["action"] == "update" and rows[0]["matched_by"] == "name"
    assert rows[0]["matched_name"] == "Truck 7"
    assert rows[0]["diff"]["driver_name"] == {"old": "Old Driver", "new": "New Driver"}
    assert rows[0]["diff"]["name"] == {"old": "Truck 7", "new": "truck 7"}
    assert rows[1]["errors"] == ["multiple existing trucks named 'Twin'"]
    assert rows[2]["action"] == "create"          # archived trucks never match


async def test_two_rows_on_one_truck_are_errors(db, seeded_user):
    await mk_truck(db, "Truck 7")
    out = await preview(db, [
        {"name": "Truck 7", "driver_name": "A"},
        {"name": "TRUCK 7", "driver_name": "B"},
    ])
    # both rows collide on the in-upload name key before the target check
    assert all("within the import" in r["errors"][0] for r in out["rows"])


async def test_update_diff_every_column_kind(db, seeded_user):
    site_a, site_b = Site(name="DC-East"), Site(name="DC-West")
    crate_a, crate_b, crate_c = Container(name="Crate A"), Container(name="Crate B"), Container(name="Crate C")
    db.add_all([site_a, site_b, crate_a, crate_b, crate_c])
    await db.flush()
    move_a = await mk_initiative(db, "Move A")
    move_b = await mk_initiative(db, "Move B")
    await mk_truck(db, "Truck 1", status="created", team_drive=False, contact_info="",
                   tracking_type={"type": "gps", "tracker_id": "T-1"},
                   initiative_id=move_a.id, start_site_id=site_a.id,
                   containers=[crate_a, crate_b])
    row = await one(db, {
        "name": "Truck 1", "status": "in_transit", "team_drive": "yes",
        "contact_info": "", "load_number": "L-9", "tracking_type": "cell",
        "tracking_update_type": "manual", "tracker_id": "T-1",
        "initiative": "Move B", "start_site": "DC-East", "end_site": "DC-West",
        "containers": "Crate B; Crate C"})
    assert row["action"] == "update"
    assert row["diff"] == {
        "status": {"old": "created", "new": "in_transit"},
        "team_drive": {"old": False, "new": True},
        "load_number": {"old": None, "new": "L-9"},
        "tracking_type": {"old": "gps", "new": "cell"},
        "tracking_update_type": {"old": None, "new": "manual"},
        "initiative": {"old": "Move A", "new": "Move B"},
        "end_site": {"old": None, "new": "DC-West"},
        "containers": {"add": ["Crate C"], "remove": ["Crate A"]},
    }


async def test_blank_cells_are_no_change_on_update(db, seeded_user):
    crate = Container(name="Crate A")
    db.add(crate)
    await db.flush()
    await mk_truck(db, "Truck 1", status="active", team_drive=True,
                   contact_info="call me", tracking_type={"type": "gps"},
                   containers=[crate])
    row = await one(db, {"name": "Truck 1"})
    assert row["action"] == "unchanged" and row["diff"] is None
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_trucks .venv/bin/pytest tests/test_trucks_bulk_import_service.py -q`
Expected: the preview tests and the export round trip fail with `AttributeError: ... has no attribute 'preview_rows'`.

- [ ] **Step 3: Append the preview code**

Append to `api/src/serversherpa/trucks/bulk_import.py`:

```python
# ── validation + preview ────────────────────────────────────────────

def _index(objs) -> dict[str, list]:
    out: dict[str, list] = {}
    for o in objs:
        out.setdefault(o.name.lower(), []).append(o)
    return out


async def _reference_data(db: AsyncSession) -> dict:
    statuses = set(await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == "truck")))
    initiatives = _index(await db.scalars(select(Initiative)))
    sites = _index(await db.scalars(select(Site).where(Site.archived_at.is_(None))))
    containers = _index(await db.scalars(
        select(Container).where(Container.archived_at.is_(None))))
    trucks = list(await db.scalars(select(Truck).where(Truck.archived_at.is_(None))))
    return {
        "statuses": statuses, "initiatives": initiatives, "sites": sites,
        "containers": containers, "by_name": _index(trucks),
        "linked": await _linked_containers(db, [t.id for t in trucks]),
        "initiative_names": {i.id: i.name for group in initiatives.values() for i in group},
        "site_names": {s.id: s.name for group in sites.values() for s in group},
    }


def _resolve_one(index: dict, name: str, label: str, errors: list[str]):
    """Exactly one record by name, else a row error. None when blank or
    unresolved."""
    if not name:
        return None
    matches = index.get(name.lower(), [])
    if not matches:
        errors.append(f"unknown {label} '{name}'")
        return None
    if len(matches) > 1:
        errors.append(f"ambiguous {label} '{name}'")
        return None
    return matches[0]


async def preview_rows(db: AsyncSession, numbered: list[tuple[int, dict]]) -> dict:
    ref = await _reference_data(db)
    names_seen: dict[str, list[int]] = {}
    for n, row in numbered:
        if row["name"]:
            names_seen.setdefault(row["name"].lower(), []).append(n)

    pending: list[dict] = []
    for n, row in numbered:
        errors: list[str] = []
        name = row["name"]
        if not name:
            errors.append("name is required")
        elif len(names_seen[name.lower()]) > 1:
            errors.append(f"duplicate name '{name}' within the import")
        if row["status"] and row["status"] not in ref["statuses"]:
            errors.append(f"unknown status '{row['status']}'")
        team_drive = parse_bool(row["team_drive"])
        if row["team_drive"] and team_drive is None:
            errors.append("team_drive must be yes or no")
        if len(row["seal_id"]) > SEAL_MAX:
            errors.append(f"seal_id is longer than {SEAL_MAX} characters")
        refs = {
            "initiative": _resolve_one(ref["initiatives"], row["initiative"], "initiative", errors),
            "start_site": _resolve_one(ref["sites"], row["start_site"], "site", errors),
            "end_site": _resolve_one(ref["sites"], row["end_site"], "site", errors),
        }
        container_objs = []
        for cname in split_names(row["containers"]):
            obj = _resolve_one(ref["containers"], cname, "container", errors)
            if obj is not None:
                container_objs.append(obj)

        blank = {"status": row["status"] == "", "team_drive": row["team_drive"] == "",
                 "contact_info": row["contact_info"] == "",
                 "containers": row["containers"] == ""}
        data = dict(row)
        data["status"] = row["status"] or "created"
        data["team_drive"] = team_drive if team_drive is not None else False
        for col, obj in refs.items():
            if obj is not None:
                data[col] = obj.name
        data["containers"] = [c.name for c in container_objs]

        target: Truck | None = None
        matched_by: str | None = None
        if not errors:
            hits = ref["by_name"].get(name.lower(), [])
            if len(hits) > 1:
                errors.append(f"multiple existing trucks named '{name}'")
            elif hits:
                target, matched_by = hits[0], "name"

        pending.append({"row": n, "cells": dict(row), "name": name,
                        "errors": errors, "data": data, "blank": blank,
                        "target": target, "matched_by": matched_by,
                        "refs": refs, "container_objs": container_objs})

    # two upload rows resolving to the same truck would apply twice, last
    # write winning silently — both rows are errors instead
    same_target: dict[uuid.UUID, list[dict]] = {}
    for p in pending:
        if p["target"] is not None:
            same_target.setdefault(p["target"].id, []).append(p)
    for group in same_target.values():
        if len(group) > 1:
            for p in group:
                p["errors"].append("two rows match the same existing truck "
                                   f"'{p['target'].name}'")

    results = []
    for p in pending:
        errors, target = p["errors"], p["target"]
        action, diff_out, truck_id = "create", None, None
        if errors:
            action = "error"
        elif target is not None:
            truck_id = str(target.id)
            changes = _diff_row(target, p["data"], p["blank"], p["refs"],
                                p["container_objs"],
                                ref["linked"].get(target.id, {}), ref)
            action = "update" if changes else "unchanged"
            diff_out = changes or None
        results.append({"row": p["row"], "name": p["name"] or None,
                        "action": action,
                        "matched_by": p["matched_by"] if action != "error" else None,
                        "matched_name": (target.name if target is not None
                                         and action != "error" else None),
                        "errors": errors, "diff": diff_out, "truck_id": truck_id,
                        "cells": p["cells"],
                        "data": p["data"] if action != "error" else None})

    can_commit = bool(results) and all(r["action"] != "error" for r in results)
    return {"rows": results, "can_commit": can_commit}


def _diff_row(truck: Truck, data: dict, blank: dict, refs: dict,
              container_objs: list, linked: dict, ref: dict) -> dict:
    """Changed fields only; blank in the row = no change. `blank` remembers
    the create-only defaults so they never read as edits."""
    out: dict = {}
    for col in TEXT_COLUMNS:
        raw = data[col]
        if col == "contact_info" and blank["contact_info"]:
            continue
        if raw == "":
            continue
        old = getattr(truck, col)
        if (old or "") != raw:
            out[col] = {"old": old, "new": raw}
    if not blank["status"] and (truck.status or "") != data["status"]:
        out["status"] = {"old": truck.status, "new": data["status"]}
    if not blank["team_drive"] and bool(truck.team_drive) != data["team_drive"]:
        out["team_drive"] = {"old": bool(truck.team_drive), "new": data["team_drive"]}
    tracking = truck.tracking_type or {}
    for col, key in TRACKING_KEYS.items():
        raw = data[col]
        if raw == "":
            continue
        old = tracking.get(key)
        old_text = str(old) if old not in (None, "") else ""
        if old_text != raw:
            out[col] = {"old": old if old_text else None, "new": raw}
    for col, attr in REF_COLUMNS.items():
        obj = refs[col]
        if obj is None:
            continue
        current = getattr(truck, attr)
        if current != obj.id:
            names = ref["initiative_names"] if col == "initiative" else ref["site_names"]
            out[col] = {"old": names.get(current) if current else None, "new": obj.name}
    if not blank["containers"]:
        want = {c.id: c.name for c in container_objs}
        add = sorted(n for i, n in want.items() if i not in linked)
        remove = sorted(n for i, n in linked.items() if i not in want)
        if add or remove:
            out["containers"] = {"add": add, "remove": remove}
    return out
```

- [ ] **Step 4: Run the whole service file**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks/api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_trucks .venv/bin/pytest tests/test_trucks_bulk_import_service.py -q`
Expected: all pass (12). If `test_validation_errors` row 9/10 assertion is awkward, simplify it to assert both rows' single error starts with `"duplicate name '"` and ends with `"' within the import"`.

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks
git checkout -- api/src/serversherpa/_dev_reload.py 2>/dev/null
git add api/src/serversherpa/trucks/bulk_import.py api/tests/test_trucks_bulk_import_service.py
git commit -m "feat(trucks): bulk preview — name matching, validation, diff incl. tracking keys and container links

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Trucks importer — commit

**Files:**
- Modify: `api/src/serversherpa/trucks/bulk_import.py` (append)
- Test: `api/tests/test_trucks_bulk_import_service.py` (append)

**Interfaces:**
- Produces: `async commit_rows(db, actor_id, numbered, *, approved_updates: set[str], source_label: str) -> {"created", "updated", "skipped", "unchanged", "rows": [{row, name, truck_id, action, diff}]}`; raises `BulkImportError("rows_invalid", rows=...)`.

- [ ] **Step 1: Append the failing commit tests**

```python
# ── commit ──────────────────────────────────────────────────────────

async def test_commit_creates_truck_with_links_and_audit(db, seeded_user):
    site = Site(name="DC-East")
    crate = Container(name="Crate A")
    db.add_all([site, crate])
    await db.flush()
    move = await mk_initiative(db, "Move A")
    out = await commit(db, seeded_user, [{
        "name": "Truck 1", "status": "active", "team_drive": "yes",
        "driver_name": "Marcus", "tracking_type": "gps", "tracker_id": "T-1",
        "initiative": "Move A", "start_site": "DC-East", "containers": "Crate A"}],
        source="fleet.xlsx")
    assert (out["created"], out["updated"], out["skipped"], out["unchanged"]) == (1, 0, 0, 0)
    row = out["rows"][0]
    assert row["action"] == "created" and row["name"] == "Truck 1" and row["diff"] is None
    truck = await db.get(Truck, uuid.UUID(row["truck_id"]))
    assert truck.status == "active" and truck.team_drive is True
    assert truck.driver_name == "Marcus" and truck.contact_info == ""
    assert truck.tracking_type == {"type": "gps", "tracker_id": "T-1"}
    assert truck.initiative_id == move.id and truck.start_site_id == site.id
    assert truck.created_by == seeded_user.id
    assert set(await db.scalars(select(TruckContainer.container_id).where(
        TruckContainer.truck_id == truck.id))) == {crate.id}
    actions = sorted(await db.scalars(select(AuditLog.action).where(
        AuditLog.entity_type == "truck")))
    assert actions == ["bulk_import", "create"]
    bulk_row = await db.scalar(select(AuditLog).where(AuditLog.action == "bulk_import"))
    assert bulk_row.changes == {"created": 1, "updated": 0, "skipped": 0,
                                "unchanged": 0, "source": "fleet.xlsx"}


async def test_commit_updates_approved_skips_unapproved(db, seeded_user):
    crate_a, crate_b = Container(name="Crate A"), Container(name="Crate B")
    db.add_all([crate_a, crate_b])
    await db.flush()
    a = await mk_truck(db, "Truck A", tracking_type={"type": "gps", "tracker_id": "T-A"},
                       containers=[crate_a])
    b = await mk_truck(db, "Truck B", driver_name="Keep Me")
    await mk_truck(db, "Truck C")
    out = await commit(db, seeded_user, [
        {"name": "Truck A", "status": "in_transit", "tracking_type": "cell",
         "containers": "Crate B"},
        {"name": "Truck B", "driver_name": "Changed"},
        {"name": "Truck C"},
        {"name": "Truck D"},
    ], approved=[str(a.id)])
    assert (out["created"], out["updated"], out["skipped"], out["unchanged"]) == (1, 1, 1, 1)
    by_name = {r["name"]: r for r in out["rows"]}
    assert by_name["Truck A"]["action"] == "updated"
    assert by_name["Truck A"]["diff"]["containers"] == {"add": ["Crate B"], "remove": ["Crate A"]}
    assert by_name["Truck B"]["action"] == "skipped"
    assert by_name["Truck B"]["diff"] == {"driver_name": {"old": "Keep Me", "new": "Changed"}}
    assert by_name["Truck C"]["action"] == "unchanged"
    assert by_name["Truck D"]["action"] == "created"
    await db.refresh(a)
    await db.refresh(b)
    assert a.status == "in_transit"
    assert a.tracking_type == {"type": "cell", "tracker_id": "T-A"}      # merged, not replaced
    assert set(await db.scalars(select(TruckContainer.container_id).where(
        TruckContainer.truck_id == a.id))) == {crate_b.id}
    assert b.driver_name == "Keep Me"                                    # skipped row untouched
    update_audit = await db.scalar(select(AuditLog).where(
        AuditLog.action == "update", AuditLog.entity_type == "truck"))
    assert update_audit.entity_id == str(a.id)
    assert update_audit.changes["containers"] == {"add": ["Crate B"], "remove": ["Crate A"]}


async def test_commit_blank_cells_never_clear(db, seeded_user):
    t = await mk_truck(db, "Truck 1", status="active", team_drive=True,
                       contact_info="keep", tracking_type={"type": "gps"})
    out = await commit(db, seeded_user, [
        {"name": "Truck 1", "status": "", "team_drive": "", "contact_info": "",
         "tracking_type": "", "load_number": "L-1"}], approved=[str(t.id)])
    assert out["updated"] == 1
    await db.refresh(t)
    assert t.status == "active" and t.team_drive is True
    assert t.contact_info == "keep" and t.tracking_type == {"type": "gps"}
    assert t.load_number == "L-1"


async def test_commit_is_all_or_nothing(db, seeded_user):
    with pytest.raises(bi.BulkImportError) as exc:
        await commit(db, seeded_user, [{"name": "Good"}, {"name": ""}])
    assert exc.value.code == "rows_invalid"
    assert [r["action"] for r in exc.value.extra["rows"]] == ["create", "error"]
    assert await db.scalar(select(func.count()).select_from(Truck)) == 0
    with pytest.raises(bi.BulkImportError):
        await commit(db, seeded_user, [])
```

- [ ] **Step 2: Run to verify the commit tests fail**

Run: `... .venv/bin/pytest tests/test_trucks_bulk_import_service.py -q -k commit`
Expected: `AttributeError: ... has no attribute 'commit_rows'`.

- [ ] **Step 3: Append the commit code**

```python
# ── commit ──────────────────────────────────────────────────────────

async def commit_rows(db: AsyncSession, actor_id: uuid.UUID,
                      numbered: list[tuple[int, dict]], *,
                      approved_updates: set[str], source_label: str) -> dict:
    """All-or-nothing: re-validates everything, then writes creates plus
    APPROVED updates in one transaction; unapproved updates are skipped.
    Raises rows_invalid (carrying the full preview payload) if any row
    errors — nothing is written. `numbered` must be the ORIGINAL uploaded
    cells (the preview's `cells`), never its normalized `data`."""
    preview = await preview_rows(db, numbered)
    if not preview["rows"] or any(r["action"] == "error" for r in preview["rows"]):
        raise BulkImportError("rows_invalid", rows=preview["rows"])

    ref = await _reference_data(db)
    counts = {"created": 0, "updated": 0, "skipped": 0, "unchanged": 0}
    applied: list[dict] = []
    for r in preview["rows"]:
        if r["action"] == "unchanged":
            action = "unchanged"
        elif r["action"] == "create":
            truck = await _create_truck(db, actor_id, r["data"], ref)
            r["truck_id"] = str(truck.id)
            action = "created"
        elif r["truck_id"] in approved_updates:
            await _apply_update(db, actor_id, r, ref)
            action = "updated"
        else:
            action = "skipped"
        counts[action] += 1
        applied.append({"row": r["row"], "name": r["name"],
                        "truck_id": r["truck_id"], "action": action,
                        "diff": r["diff"] if action in ("updated", "skipped") else None})
    audit(db, actor_id=actor_id, entity_type="truck", entity_id=None,
          action="bulk_import", changes={**counts, "source": source_label})
    await db.commit()
    return {**counts, "rows": applied}


def _ref_id(ref: dict, col: str, name: str) -> uuid.UUID | None:
    """The id for a canonical reference name resolved at preview time; a
    name that vanished between preview and commit raises so the whole
    transaction rolls back rather than auditing a change never applied."""
    if not name:
        return None
    index = ref["initiatives"] if col == "initiative" else ref["sites"]
    matches = index.get(name.lower(), [])
    if len(matches) != 1:
        raise ValueError(f"{col} '{name}' vanished between preview and commit")
    return matches[0].id


def _container_ids(ref: dict, names: list[str]) -> set[uuid.UUID]:
    out = set()
    for cname in names:
        matches = ref["containers"].get(cname.lower(), [])
        if len(matches) != 1:
            raise ValueError(f"container '{cname}' vanished between preview and commit")
        out.add(matches[0].id)
    return out


async def _create_truck(db: AsyncSession, actor_id: uuid.UUID, data: dict,
                        ref: dict) -> Truck:
    tracking = {key: data[col] for col, key in TRACKING_KEYS.items() if data[col]}
    truck = Truck(
        name=data["name"], driver_name=data["driver_name"] or None,
        co_driver_name=data["co_driver_name"] or None,
        team_drive=data["team_drive"], contact_info=data["contact_info"],
        status=data["status"], load_number=data["load_number"] or None,
        seal_id=data["seal_id"] or None, tracking_type=tracking,
        initiative_id=_ref_id(ref, "initiative", data["initiative"]),
        start_site_id=_ref_id(ref, "start_site", data["start_site"]),
        end_site_id=_ref_id(ref, "end_site", data["end_site"]),
        created_by=actor_id)
    db.add(truck)
    await db.flush()
    for container_id in sorted(_container_ids(ref, data["containers"]), key=str):
        db.add(TruckContainer(truck_id=truck.id, container_id=container_id))
    changes = {field: {"from": None, "to": value}
               for field, value in snapshot(truck, AUDIT_FIELDS).items()
               if value not in (None, "", {}, False)}
    if data["containers"]:
        changes["containers"] = {"from": [], "to": sorted(data["containers"])}
    audit(db, actor_id=actor_id, entity_type="truck",
          entity_id=str(truck.id), action="create", changes=changes)
    return truck


async def _apply_update(db: AsyncSession, actor_id: uuid.UUID, r: dict,
                        ref: dict) -> None:
    truck = await db.get(Truck, uuid.UUID(r["truck_id"]))
    changes: dict = {}
    tracking = dict(truck.tracking_type or {})
    tracking_changed = False
    for col, change in (r["diff"] or {}).items():
        if col in TEXT_COLUMNS or col in ("status", "team_drive"):
            setattr(truck, col, change["new"])
        elif col in TRACKING_KEYS:
            tracking[TRACKING_KEYS[col]] = change["new"]
            tracking_changed = True
        elif col in REF_COLUMNS:
            setattr(truck, REF_COLUMNS[col], _ref_id(ref, col, change["new"]))
        elif col == "containers":
            want = _container_ids(ref, r["data"]["containers"])
            current = set(await db.scalars(
                select(TruckContainer.container_id)
                .where(TruckContainer.truck_id == truck.id)))
            for container_id in current - want:
                await db.execute(delete(TruckContainer).where(
                    TruckContainer.truck_id == truck.id,
                    TruckContainer.container_id == container_id))
            for container_id in want - current:
                db.add(TruckContainer(truck_id=truck.id, container_id=container_id))
            changes["containers"] = change
            continue
        changes[col] = {"from": change["old"], "to": change["new"]}
    if tracking_changed:
        truck.tracking_type = tracking
    truck.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor_id, entity_type="truck",
          entity_id=str(truck.id), action="update", changes=changes)
```

- [ ] **Step 4: Run the whole service file**

Run: `... .venv/bin/pytest tests/test_trucks_bulk_import_service.py -q`
Expected: all 16 pass, no warnings. If `snapshot` cannot serialize the JSONB dict, check `serversherpa/services/audit.py::_jsonable` — it handles dicts already for the trucks route.

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks
git checkout -- api/src/serversherpa/_dev_reload.py 2>/dev/null
git add api/src/serversherpa/trucks/bulk_import.py api/tests/test_trucks_bulk_import_service.py
git commit -m "feat(trucks): bulk commit — create with links, approved update with tracking merge and container replace, skip

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Trucks bulk endpoints

**Files:**
- Modify: `api/src/serversherpa/api/routes/trucks.py` (bulk block after `GET /map`, before `GET /{truck_id}`)
- Test: `api/tests/test_trucks_bulk_import_api.py`

**Interfaces:**
- Consumes: `serversherpa.api.bulk_routes` (`require_bulk_rank`, `bulk_http_error`, `rows_from_request`), `serversherpa.trucks.bulk_import`.
- Produces: `GET /trucks/bulk-import/template?format=csv|xlsx`, `GET /trucks/bulk-import/export?format=csv|xlsx`, `POST /trucks/bulk-import/preview`, `POST /trucks/bulk-import/commit`.

- [ ] **Step 1: Write the failing API tests**

Create `api/tests/test_trucks_bulk_import_api.py`:

```python
"""Trucks bulk-import endpoints: rank gating, formats, preview, commit."""
import io

import openpyxl
import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    Container, PermissionOverride, Person, PersonRole, Truck, TruckContainer,
)
from serversherpa.trucks import bulk_import as bi
from tests.test_sites_api import login, make_login


@pytest.fixture
async def admin_hdrs(db, client):
    person = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return await make_login(db, client, person, "ada@test.example.com")


async def test_staff_rank_forbidden_on_all_four(client, seeded_user):
    hdrs = await login(client)
    assert (await client.get("/trucks/bulk-import/template?format=csv", headers=hdrs)).status_code == 403
    assert (await client.get("/trucks/bulk-import/export?format=csv", headers=hdrs)).status_code == 403
    assert (await client.post("/trucks/bulk-import/preview", headers=hdrs,
                              json={"rows": [{"name": "X"}]})).status_code == 403
    assert (await client.post("/trucks/bulk-import/commit", headers=hdrs,
                              json={"rows": [{"name": "X"}]})).status_code == 403


async def test_template_and_export_formats(client, db, seeded_user, admin_hdrs):
    csv_resp = await client.get("/trucks/bulk-import/template?format=csv", headers=admin_hdrs)
    assert csv_resp.status_code == 200
    assert csv_resp.headers["content-disposition"] == 'attachment; filename="trucks-template.csv"'
    assert csv_resp.text.splitlines()[0] == ",".join(bi.COLUMNS)
    xlsx_resp = await client.get("/trucks/bulk-import/template?format=xlsx", headers=admin_hdrs)
    assert xlsx_resp.headers["content-disposition"] == 'attachment; filename="trucks-template.xlsx"'
    wb = openpyxl.load_workbook(io.BytesIO(xlsx_resp.content))
    assert wb.sheetnames == ["Trucks", "Reference"]
    ref_cells = [row[0].value for row in wb["Reference"].iter_rows()]
    assert "in_transit" in ref_cells and "Site names" in ref_cells
    assert (await client.get("/trucks/bulk-import/template?format=doc",
                             headers=admin_hdrs)).status_code == 422

    db.add(Truck(name="Exported", driver_name="Dee"))
    await db.commit()
    csv_resp = await client.get("/trucks/bulk-import/export?format=csv", headers=admin_hdrs)
    assert csv_resp.headers["content-disposition"] == 'attachment; filename="trucks-export.csv"'
    assert csv_resp.text.splitlines()[1].startswith("Exported,created,Dee,,no,")
    xlsx_resp = await client.get("/trucks/bulk-import/export?format=xlsx", headers=admin_hdrs)
    assert openpyxl.load_workbook(io.BytesIO(xlsx_resp.content))["Trucks"]["A2"].value == "Exported"


async def test_preview_json_and_file_paths(client, db, seeded_user, admin_hdrs):
    json_resp = await client.post("/trucks/bulk-import/preview", headers=admin_hdrs,
                                  json={"rows": [{"name": "Jay"}]})
    assert json_resp.status_code == 200
    assert json_resp.json()["rows"][0]["action"] == "create"
    csv_bytes = b"name,status\nCee,flying\n"
    file_resp = await client.post("/trucks/bulk-import/preview", headers=admin_hdrs,
                                  files={"file": ("fleet.csv", csv_bytes, "text/csv")})
    row = file_resp.json()["rows"][0]
    assert row["row"] == 2 and row["errors"] == ["unknown status 'flying'"]
    bad = await client.post("/trucks/bulk-import/preview", headers=admin_hdrs,
                            json={"rows": [{"nope": 1}]})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "unknown_columns"


async def test_commit_end_to_end_with_approved_and_skipped(client, db, seeded_user, admin_hdrs):
    crate = Container(name="Crate A")
    existing = Truck(name="Truck A")
    other = Truck(name="Truck B", driver_name="Keep")
    db.add_all([crate, existing, other])
    await db.commit()
    rows = [
        {"name": "Truck A", "status": "active", "containers": "Crate A"},
        {"name": "Truck B", "driver_name": "Changed"},
        {"name": "Truck C", "team_drive": "yes"},
    ]
    preview = (await client.post("/trucks/bulk-import/preview", headers=admin_hdrs,
                                 json={"rows": rows})).json()
    assert [r["action"] for r in preview["rows"]] == ["update", "update", "create"]
    resp = await client.post("/trucks/bulk-import/commit", headers=admin_hdrs, json={
        "rows": [r["cells"] for r in preview["rows"]],
        "approved_updates": [str(existing.id)], "source": "fleet.csv"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert (body["created"], body["updated"], body["skipped"], body["unchanged"]) == (1, 1, 1, 0)
    assert [r["action"] for r in body["rows"]] == ["updated", "skipped", "created"]
    assert body["rows"][0]["diff"]["containers"] == {"add": ["Crate A"], "remove": []}
    await db.refresh(existing)
    await db.refresh(other)
    assert existing.status == "active" and other.driver_name == "Keep"
    assert set(await db.scalars(select(TruckContainer.container_id).where(
        TruckContainer.truck_id == existing.id))) == {crate.id}
    bad = await client.post("/trucks/bulk-import/commit", headers=admin_hdrs, json={
        "rows": [{"name": ""}], "approved_updates": []})
    assert bad.status_code == 422 and bad.json()["detail"]["code"] == "rows_invalid"


async def test_commit_also_requires_trucks_change(client, db, seeded_user, admin_hdrs):
    ada = await db.scalar(select(Person).where(Person.email == "ada@test.example.com"))
    db.add(PermissionOverride(person_id=ada.id, resource="trucks", action="change", allow=False))
    await db.commit()
    assert (await client.post("/trucks/bulk-import/preview", headers=admin_hdrs,
                              json={"rows": [{"name": "X"}]})).status_code == 200
    resp = await client.post("/trucks/bulk-import/commit", headers=admin_hdrs,
                             json={"rows": [{"name": "X"}], "approved_updates": []})
    assert resp.status_code == 403
    assert await db.scalar(select(Truck).where(Truck.name == "X")) is None
```

Check the `PermissionOverride` constructor columns against `api/tests/test_workers_bulk_import_api.py::test_commit_also_requires_workers_change` (it was written this way there) and copy its exact form.

- [ ] **Step 2: Run to verify they fail**

Run: `... .venv/bin/pytest tests/test_trucks_bulk_import_api.py -q`
Expected: 404/422 failures on the missing routes.

- [ ] **Step 3: Add the bulk block to the trucks router**

In `api/src/serversherpa/api/routes/trucks.py`, extend the fastapi import to include `Request, Response`, and add:

```python
from serversherpa.api.bulk_routes import bulk_http_error, require_bulk_rank, rows_from_request
from serversherpa.trucks import bulk_import as bulk
```

Insert immediately before `@router.get("/{truck_id}", response_model=TruckDetail)`:

```python
# ── bulk import ────────────────────────────────────────────────────
# Declared ABOVE get_truck, like /map: /trucks/bulk-import/* must never be
# swallowed by GET /trucks/{truck_id}.

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _attachment(filename: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


@router.get("/bulk-import/template")
async def bulk_import_template(
    db: DbSession,
    format: str = "csv",
    actor: AuthContext = require_permission("trucks", "add"),
):
    require_bulk_rank(actor)
    if format == "csv":
        return Response(bulk.build_template_csv(), media_type="text/csv",
                        headers=_attachment("trucks-template.csv"))
    if format == "xlsx":
        statuses, initiatives, sites = await bulk.reference_lists(db)
        return Response(bulk.build_template_xlsx(statuses, initiatives, sites),
                        media_type=_XLSX, headers=_attachment("trucks-template.xlsx"))
    raise _err(422, "unknown_format")


@router.get("/bulk-import/export")
async def bulk_import_export(
    db: DbSession,
    format: str = "xlsx",
    actor: AuthContext = require_permission("trucks", "add"),
):
    """The current trucks in the template's layout — fill in, re-upload."""
    require_bulk_rank(actor)
    if format not in ("csv", "xlsx"):
        raise _err(422, "unknown_format")
    rows = await bulk.export_rows(db)
    if format == "csv":
        return Response(bulk.build_rows_csv(rows), media_type="text/csv",
                        headers=_attachment("trucks-export.csv"))
    statuses, initiatives, sites = await bulk.reference_lists(db)
    return Response(bulk.build_rows_xlsx(rows, statuses, initiatives, sites),
                    media_type=_XLSX, headers=_attachment("trucks-export.xlsx"))


@router.post("/bulk-import/preview")
async def bulk_import_preview(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "add"),
) -> dict:
    require_bulk_rank(actor)
    numbered = await rows_from_request(
        request, parse_upload=bulk.parse_upload, number_json_rows=bulk.number_json_rows)
    return await bulk.preview_rows(db, numbered)


@router.post("/bulk-import/commit")
async def bulk_import_commit(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "add"),
) -> dict:
    require_bulk_rank(actor)
    # updates go through here too, so the change permission is required as well
    if not actor.access.can("trucks", "change"):
        raise _err(403, "forbidden")
    try:
        body = await request.json()
    except ValueError:
        raise _err(422, "invalid_json") from None
    try:
        numbered = bulk.number_json_rows(body.get("rows"))
    except bulk.BulkImportError as exc:
        raise bulk_http_error(exc) from None
    approved = {str(s) for s in body.get("approved_updates") or []}
    try:
        return await bulk.commit_rows(
            db, actor.person.id, numbered, approved_updates=approved,
            source_label=str(body.get("source") or "upload"))
    except bulk.BulkImportError as exc:
        raise bulk_http_error(exc) from None
```

- [ ] **Step 4: Run the trucks suites and the neighbors**

Run: `... .venv/bin/pytest tests/test_trucks_bulk_import_api.py tests/test_trucks_bulk_import_service.py tests/test_trucks_api.py tests/test_sites_bulk_import_api.py tests/test_workers_bulk_import_api.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks
git checkout -- api/src/serversherpa/_dev_reload.py 2>/dev/null
git add api/src/serversherpa/api/routes/trucks.py api/tests/test_trucks_bulk_import_api.py
git commit -m "feat(api): trucks bulk-import endpoints (template, export, preview, commit)

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Portal — shared BulkToolPage and BulkUpload; sites and workers move onto them

**Files:**
- Create: `portal/src/components/bulk/BulkToolPage.tsx`, `portal/src/components/bulk/BulkUpload.tsx`
- Modify: `portal/src/components/bulk/BulkApplySummary.tsx` (`changesText`), `portal/src/pages/BulkSites.tsx`, `portal/src/pages/BulkWorkers.tsx`, `portal/src/components/workers/WorkerBulkUpload.tsx`
- Existing tests that must pass unchanged: `portal/src/pages/BulkSites.test.tsx`, `portal/src/pages/BulkWorkers.test.tsx`, `portal/src/components/workers/WorkerBulkUpload.test.tsx`, `portal/src/components/sites/SiteBulkUpload.test.tsx`, `portal/src/components/bulk/BulkApplySummary.test.tsx`, `portal/src/styles/listTypography.test.ts`

**Interfaces:**
- `BulkToolPage` props: `{ title: string; hint: ReactNode; guide: { key: string; required: boolean; accepts: string; example: string }[]; downloads: { key: string; label: string; run: () => Promise<void>; accent?: boolean }[]; children: ReactNode }`. Renders exactly the DOM the current pages render: `.portal-page` > `.eyebrow` "Bulk Actions", `h1.page-title`, `p.page-hint`, three `.bulk-section`s (Columns table, Download buttons + `.set-note` limit text, Upload with children).
- `BulkUpload` generic component: `BulkUpload<P extends BulkPreviewRow, R extends BulkSummaryRow>({ config, onDone })` with `BulkUploadConfig<P, R> = { idPrefix; noun; newLabel; errors; preview(file, filename); commit(rows, approved, source); idOf(row: P): string | null; summary: { entityLabel; linkFor(row: R); filename; openTo; openLabel } }`. Exported types `BulkPreviewRow`, `BulkPreviewResult<P>`, `BulkUploadConfig<P, R>`.

- [ ] **Step 1: Create BulkToolPage**

```tsx
/**
 * BulkToolPage — the page shell every Bulk Actions tool shares: title and
 * hint, the column guide, the template / export downloads with the upload
 * limit note, and an Upload section holding the tool's own pane.
 */
import { useState, type ReactNode } from 'react';

import DataTable from '../DataTable';
import '../../styles/bulk.css';

export interface BulkColumnGuide { key: string; required: boolean; accepts: string; example: string }
export interface BulkDownload { key: string; label: string; run: () => Promise<void>; accent?: boolean }

interface Props {
  title: string;
  hint: ReactNode;
  guide: BulkColumnGuide[];
  downloads: BulkDownload[];
  children: ReactNode;
}

export default function BulkToolPage({ title, hint, guide, downloads, children }: Props) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const download = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try { await fn(); } catch { setError('Download failed — try again.'); } finally { setBusy(''); }
  };

  return (
    <div className="portal-page">
      <div className="eyebrow">Bulk Actions</div>
      <h1 className="page-title">{title}</h1>
      <p className="page-hint">{hint}</p>

      <section className="bulk-section">
        <p className="eyebrow-sm">Columns</p>
        <DataTable
          ariaLabel="Template columns"
          columns={[
            { key: 'key', label: 'Column', mono: true },
            { key: 'required', label: 'Required' },
            { key: 'accepts', label: 'Accepts' },
            { key: 'example', label: 'Example', mono: true },
          ]}
          rows={guide.map((c) => ({
            key: c.key, cells: [c.key, c.required ? 'Yes' : '', c.accepts, c.example || '—'],
          }))}
        />
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Download</p>
        <div className="bulk-actions">
          {downloads.map((d) => (
            <button key={d.key} className={d.accent ? 'mini-btn accent' : 'mini-btn'} disabled={!!busy}
                    onClick={() => void download(d.key, d.run)}>
              {d.label}
            </button>
          ))}
          {error && <span className="pf-error">{error}</span>}
        </div>
        <p className="set-note">
          Uploads are limited to 1,000 rows and 5 MB. Larger exports need to be split before re-uploading.
        </p>
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Upload</p>
        {children}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Create BulkUpload (generic pane)**

`portal/src/components/bulk/BulkUpload.tsx` is `WorkerBulkUpload.tsx` with the worker specifics replaced by `config`:

```tsx
/**
 * BulkUpload — the upload → preview → apply pane for Bulk Actions tools
 * with per-row update-or-skip (workers, trucks). Pick a csv/xlsx file,
 * Preview renders per-row results, matched rows are skipped unless their
 * Update box is ticked, and Apply posts the uploaded cells plus the
 * approved record ids. Everything entity-specific comes in through config.
 */

import { useRef, useState } from 'react';

import { ApiError } from '../../lib/api';
import BulkApplySummary, { type BulkDiff, type BulkSummaryResult, type BulkSummaryRow } from './BulkApplySummary';
import DataTable from '../DataTable';

export interface BulkPreviewRow {
  row: number;
  name: string | null;
  action: 'create' | 'update' | 'unchanged' | 'error';
  matched_by: string | null;
  matched_name: string | null;
  errors: string[];
  diff: BulkDiff | null;
  /** The uploaded cells, no defaults — what the commit replays. */
  cells: Record<string, string>;
  data: Record<string, unknown> | null;
}

export interface BulkPreviewResult<P extends BulkPreviewRow> {
  rows: P[];
  can_commit: boolean;
}

export interface BulkUploadConfig<P extends BulkPreviewRow, R extends BulkSummaryRow> {
  /** File input id becomes `${idPrefix}-bulk-file`. */
  idPrefix: string;
  /** Singular noun for button copy ("worker" → "Add 2 workers"). */
  noun: string;
  /** Matched-by cell for rows with no match ("new worker"). */
  newLabel: string;
  errors: Record<string, string>;
  preview(file: File, filename: string): Promise<BulkPreviewResult<P>>;
  commit(rows: Record<string, unknown>[], approved: string[], source: string): Promise<BulkSummaryResult<R>>;
  /** The existing record's id on a matched preview row. */
  idOf(row: P): string | null;
  summary: {
    entityLabel: string;
    linkFor: (row: R) => string;
    filename: string;
    openTo: string;
    openLabel: string;
  };
}

const ACTION_LABEL: Record<BulkPreviewRow['action'], string> = {
  create: 'Add',
  update: 'Update',
  unchanged: 'No change',
  error: 'Error',
};

/** One line per changed field; list fields (add/remove) render as +name / −name. */
export function describeDiff(diff: BulkDiff): { field: string; from: string; to: string }[] {
  return Object.entries(diff).map(([field, change]) => {
    if (change.add !== undefined || change.remove !== undefined) {
      const add = (change.add ?? []).map((n) => `+${n}`);
      const remove = (change.remove ?? []).map((n) => `−${n}`);
      return { field, from: '', to: [...add, ...remove].join(', ') };
    }
    return {
      field,
      from: change.old === null || change.old === undefined ? '—' : String(change.old),
      to: String(change.new),
    };
  });
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface Props<P extends BulkPreviewRow, R extends BulkSummaryRow> {
  config: BulkUploadConfig<P, R>;
  onDone?(result: BulkSummaryResult<R>): void;
}

export default function BulkUpload<P extends BulkPreviewRow, R extends BulkSummaryRow>({ config, onDone }: Props<P, R>) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<BulkPreviewResult<P> | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<BulkSummaryResult<R> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const mapError = (err: unknown): string =>
    err instanceof ApiError
      ? (config.errors[err.code] ?? 'Import failed — try again.')
      : 'Network error.';

  const runPreview = async () => {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      setPreview(await config.preview(file, file.name));
      setApproved(new Set());          // every matched row starts as a skip
    } catch (err) {
      setPreview(null);
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  const rows = preview?.rows ?? [];
  const idOf = config.idOf;
  const adds = rows.filter((r) => r.action === 'create').length;
  const matched = rows.filter((r) => r.action === 'update');
  const updating = matched.filter((r) => { const id = idOf(r); return id !== null && approved.has(id); }).length;
  const skipping = matched.length - updating;
  const unchanged = rows.filter((r) => r.action === 'unchanged').length;
  const errors = rows.filter((r) => r.action === 'error').length;
  const canApply = !!preview && preview.can_commit && (adds > 0 || updating > 0);

  const runImport = async () => {
    if (!preview || !file) return;
    setBusy(true);
    setError('');
    try {
      // the ORIGINAL cells, never the preview's normalized `data` — replaying
      // `data` would write its create-only defaults onto existing records
      const posted = preview.rows.filter((r) => r.action !== 'error');
      const counts = await config.commit(posted.map((r) => r.cells), [...approved], file.name);
      // The commit numbers rows from 1 (JSON path); the preview numbered the
      // spreadsheet lines from 2. Relabel so the summary ties back to the file.
      const applied = {
        ...counts,
        rows: counts.rows.map((r, i) => ({ ...r, row: posted[i]?.row ?? r.row })),
      };
      setPreview(null);
      setFile(null);
      if (fileRef.current) fileRef.current.value = '';
      setResult(applied);
      onDone?.(applied);
    } catch (err) {
      setError(mapError(err));
      setPreview(null);   // stale after a failed commit — force re-preview
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) =>
    setApproved((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const inputId = `${config.idPrefix}-bulk-file`;

  return (
    <div className="bulk-import">
      <div className="bulk-file-row">
        <label htmlFor={inputId}>Upload a file (.csv or .xlsx)</label>
        <input
          id={inputId}
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setResult(null);
            setError('');
          }}
        />
      </div>

      <div className="bulk-actions">
        <button className="btn-solid" type="button" disabled={busy || !file}
                onClick={() => void runPreview()}>
          {busy ? 'Working…' : 'Preview'}
        </button>
        <button className="btn-solid" type="button" disabled={busy || !canApply}
                onClick={() => void runImport()}>
          {`Add ${plural(adds, config.noun)} and update ${plural(updating, config.noun)}`}
        </button>
        {matched.length > 0 && (
          <>
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => setApproved(new Set(matched.map((r) => idOf(r) as string)))}>
              Update all
            </button>
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => setApproved(new Set())}>
              Skip all
            </button>
          </>
        )}
      </div>

      {error && <p className="pf-error">{error}</p>}

      {result && (
        <BulkApplySummary
          result={result}
          entityLabel={config.summary.entityLabel}
          linkFor={config.summary.linkFor}
          filename={config.summary.filename}
          openTo={config.summary.openTo}
          openLabel={config.summary.openLabel}
        />
      )}

      {preview && (
        <>
          <p className="set-note">
            {`${adds} to add · ${updating} to update · ${skipping} to skip · ${unchanged} unchanged · ${plural(errors, 'error')}`}
          </p>
          <DataTable
            ariaLabel="Import preview"
            className="bulk-preview"
            columns={[
              { key: 'row', label: 'Row', width: '64px', mono: true },
              { key: 'name', label: 'Name' },
              { key: 'matched_by', label: 'Matched by' },
              { key: 'action', label: 'Action' },
              { key: 'details', label: 'Details' },
            ]}
            rows={preview.rows.map((r) => {
              const id = idOf(r);
              const willUpdate = id !== null && approved.has(id);
              return {
                key: String(r.row),
                className: `bulk-row-${r.action === 'update' && !willUpdate ? 'skipped' : r.action}`,
                cells: [
                  r.row,
                  r.name ?? '—',
                  r.matched_by ?? config.newLabel,
                  r.action === 'update' ? (willUpdate ? 'Update' : 'Skip') : ACTION_LABEL[r.action],
                  <>
                    {r.action === 'error' && r.errors.map((e) => (
                      <span key={e} className="pf-error">{e}</span>
                    ))}
                    {r.action === 'update' && r.diff && (
                      <div className="bulk-diff">
                        {describeDiff(r.diff).map((d) => (
                          <span key={d.field}>{d.field}: {d.from ? `${d.from} → ` : ''}{d.to}</span>
                        ))}
                        <label>
                          <input
                            type="checkbox"
                            aria-label={`Update ${r.name}`}
                            checked={willUpdate}
                            disabled={busy}
                            onChange={() => id && toggle(id)}
                          />
                          {' '}Update
                        </label>
                      </div>
                    )}
                  </>,
                ],
              };
            })}
          />
        </>
      )}
    </div>
  );
}
```

Note the diff line renders `field: from → to` for scalar changes (the `from` is `—` when old was null, so `describeDiff` still yields the same text the worker tests assert, e.g. `trade: — → Cable`) and `field: +A, −B` for list changes.

- [ ] **Step 3: Generalize changesText and rewrite the wrappers**

In `portal/src/components/bulk/BulkApplySummary.tsx`, change the `if (field === 'clients')` branch to `if (change.add !== undefined || change.remove !== undefined)` and use `${field}:` in the returned string (the sites case still renders `clients: +X, −Y`).

Replace `portal/src/components/workers/WorkerBulkUpload.tsx` with:

```tsx
/**
 * WorkerBulkUpload — the /bulk/workers upload pane: the shared BulkUpload
 * configured for workers (email / phone / name matching, per-row update or
 * skip, summary linking to each worker's page).
 */
import {
  commitWorkerBulk,
  previewWorkerBulk,
  type WorkerBulkAppliedRow,
  type WorkerBulkCommitResult,
  type WorkerBulkRowResult,
} from '../../lib/api';
import { WORKER_BULK_ERRORS } from '../../lib/workerBulk';
import BulkUpload, { type BulkUploadConfig } from '../bulk/BulkUpload';

const CONFIG: BulkUploadConfig<WorkerBulkRowResult, WorkerBulkAppliedRow> = {
  idPrefix: 'worker',
  noun: 'worker',
  newLabel: 'new worker',
  errors: WORKER_BULK_ERRORS,
  preview: previewWorkerBulk,
  commit: commitWorkerBulk,
  idOf: (r) => r.person_id,
  summary: {
    entityLabel: 'Worker',
    linkFor: (r) => `/people/workers/${r.person_id}`,
    filename: 'workers-bulk-summary',
    openTo: '/people/workers',
    openLabel: 'Open Workers',
  },
};

export default function WorkerBulkUpload({ onDone }: { onDone?(result: WorkerBulkCommitResult): void }) {
  return <BulkUpload config={CONFIG} onDone={onDone} />;
}
```

The worker test mocks `../../lib/api` with hoisted `vi.fn()`s before this module loads, so `CONFIG.preview` IS the mock; keep the `preview: previewWorkerBulk` reference style (not a wrapper arrow) so `mockReset` in the test's `beforeEach` keeps working. If TypeScript rejects `preview: previewWorkerBulk` because `File | Blob` widens, write `preview: (file, name) => previewWorkerBulk(file, name)` — the mock is still called through.

Replace `portal/src/pages/BulkWorkers.tsx` with:

```tsx
/**
 * BulkWorkers — /bulk/workers: the shared page shell configured for
 * workers, with WorkerBulkUpload as the upload pane.
 */
import BulkToolPage from '../components/bulk/BulkToolPage';
import WorkerBulkUpload from '../components/workers/WorkerBulkUpload';
import { downloadWorkerExport, downloadWorkerTemplate } from '../lib/api';
import { WORKER_COLUMN_GUIDE } from '../lib/workerBulk';

export default function BulkWorkers() {
  return (
    <BulkToolPage
      title="Add or update workers in bulk"
      hint={<>
        Download the template or the current list, fill it in, upload it, and review every add before applying.
        Rows match existing people by email, phone, or name; matched rows are skipped unless you tick Update.
        Every imported person gets the worker role. Login accounts are not created here.
      </>}
      guide={WORKER_COLUMN_GUIDE}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: () => downloadWorkerTemplate('xlsx') },
        { key: 't-csv', label: 'Template (.csv)', run: () => downloadWorkerTemplate('csv') },
        { key: 'e-xlsx', label: 'Current workers (.xlsx)', run: () => downloadWorkerExport('xlsx'), accent: true },
        { key: 'e-csv', label: 'Current workers (.csv)', run: () => downloadWorkerExport('csv'), accent: true },
      ]}
    >
      <WorkerBulkUpload />
    </BulkToolPage>
  );
}
```

Replace `portal/src/pages/BulkSites.tsx` the same way (title "Add or update sites in bulk", the existing hint text verbatim, `SITE_COLUMN_GUIDE`, downloads `Template (.xlsx)`, `Template (.csv)`, `Current sites (.xlsx)` accent, `Current sites (.csv)` accent, child `<SiteBulkUpload onDone={() => {}} />`; keep the `import '../styles/sites.css';` line since the sites pane's styles live partly there).

- [ ] **Step 4: Run the portal tests and the type check**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks/portal && npx vitest run src/components/bulk src/components/workers src/components/sites src/pages/BulkSites.test.tsx src/pages/BulkWorkers.test.tsx src/lib/siteBulk.test.ts src/lib/workerBulk.test.ts src/styles/listTypography.test.ts && npx tsc --noEmit`
Expected: all pass with their assertions unchanged; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks
git add portal/src/components/bulk portal/src/components/workers/WorkerBulkUpload.tsx portal/src/pages/BulkSites.tsx portal/src/pages/BulkWorkers.tsx
git commit -m "refactor(portal): shared BulkToolPage and BulkUpload; sites and workers pages become configuration

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Portal — trucks bulk client, guide, upload pane, page, card, route, toolbar

**Files:**
- Modify: `portal/src/lib/api.ts` (after the workers bulk section)
- Create: `portal/src/lib/truckBulk.ts` + `truckBulk.test.ts`, `portal/src/components/trucks/TruckBulkUpload.tsx` + `.test.tsx`, `portal/src/pages/BulkTrucks.tsx` + `.test.tsx`
- Modify: `portal/src/pages/BulkActions.tsx` + `.test.tsx`, `portal/src/App.tsx`, `portal/src/pages/Trucks.tsx`

**Interfaces:**
- `api.ts`: `TruckBulkRowResult` (like `WorkerBulkRowResult` with `truck_id`), `TruckBulkPreview`, `TruckBulkAppliedRow` (`truck_id`, action incl. `skipped`), `TruckBulkCommitResult`, `previewTruckBulk(file, filename)`, `commitTruckBulk(rows, approved, source)`, `downloadTruckTemplate(format)` (`trucks-template.<fmt>`), `downloadTruckExport(format)` (`trucks-export.<fmt>`).
- `truckBulk.ts`: `TRUCK_COLUMN_GUIDE` (15 keys in template order, only `name` required), `TRUCK_BULK_ERRORS` (same ten codes as `WORKER_BULK_ERRORS`).

- [ ] **Step 1: Write the failing tests**

`portal/src/lib/truckBulk.test.ts`:

```ts
import { expect, it } from 'vitest';

import { TRUCK_BULK_ERRORS, TRUCK_COLUMN_GUIDE } from './truckBulk';

it('describes exactly the template columns, name first and required', () => {
  expect(TRUCK_COLUMN_GUIDE.map((c) => c.key)).toEqual([
    'name', 'status', 'driver_name', 'co_driver_name', 'team_drive', 'contact_info',
    'load_number', 'seal_id', 'tracking_type', 'tracking_update_type', 'tracker_id',
    'initiative', 'start_site', 'end_site', 'containers',
  ]);
  expect(TRUCK_COLUMN_GUIDE.filter((c) => c.required).map((c) => c.key)).toEqual(['name']);
});

it('maps every error code the bulk endpoints can raise', () => {
  expect(Object.keys(TRUCK_BULK_ERRORS).sort()).toEqual([
    'file_too_large', 'forbidden', 'invalid_csv', 'invalid_json', 'invalid_xlsx',
    'missing_file', 'rows_invalid', 'too_many_rows', 'unknown_columns', 'unsupported_file',
  ]);
});
```

`portal/src/components/trucks/TruckBulkUpload.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ previewTruckBulk: vi.fn(), commitTruckBulk: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
vi.mock('../../lib/listTools', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/listTools')>()), exportCsv: vi.fn(),
}));
const { default: TruckBulkUpload } = await import('./TruckBulkUpload');

beforeEach(() => { api.previewTruckBulk.mockReset(); api.commitTruckBulk.mockReset(); });
afterEach(cleanup);

const row = (over: Record<string, unknown>) => ({
  row: 2, name: 'Truck 1', action: 'create', matched_by: null, matched_name: null,
  errors: [], diff: null, truck_id: null,
  cells: { name: 'Truck 1', status: '' }, data: { name: 'Truck 1', status: 'created' },
  ...over,
});

function pickFile() {
  const input = screen.getByLabelText('Upload a file (.csv or .xlsx)') as HTMLInputElement;
  expect(input.id).toBe('truck-bulk-file');
  fireEvent.change(input, { target: { files: [new File(['name\nX'], 'fleet.csv', { type: 'text/csv' })] } });
}

it('renders truck copy, list diffs, and commits approved truck ids', async () => {
  api.previewTruckBulk.mockResolvedValue({ can_commit: true, rows: [
    row({ row: 2, name: 'Truck 1', action: 'update', matched_by: 'name', matched_name: 'Truck 1',
          truck_id: 't1', diff: { status: { old: 'created', new: 'active' },
                                  containers: { add: ['Crate B'], remove: ['Crate A'] } } }),
    row({ row: 3, name: 'Truck 9', cells: { name: 'Truck 9', status: '' } }),
  ] });
  api.commitTruckBulk.mockResolvedValue({
    created: 1, updated: 1, skipped: 0, unchanged: 0,
    rows: [
      { row: 1, name: 'Truck 1', truck_id: 't1', action: 'updated',
        diff: { containers: { add: ['Crate B'], remove: ['Crate A'] } } },
      { row: 2, name: 'Truck 9', truck_id: 't9', action: 'created', diff: null },
    ],
  });
  render(<MemoryRouter><TruckBulkUpload /></MemoryRouter>);
  pickFile();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByText('new truck')).toBeTruthy();
  expect(screen.getByText('status: created → active')).toBeTruthy();
  expect(screen.getByText('containers: +Crate B, −Crate A')).toBeTruthy();
  expect(screen.getByText('1 to add · 0 to update · 1 to skip · 0 unchanged · 0 errors')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Update Truck 1'));
  fireEvent.click(screen.getByRole('button', { name: 'Add 1 truck and update 1 truck' }));
  await waitFor(() => expect(api.commitTruckBulk).toHaveBeenCalledWith(
    [{ name: 'Truck 1', status: '' }, { name: 'Truck 9', status: '' }], ['t1'], 'fleet.csv'));
  expect(await screen.findByText('Applied: 1 added · 1 updated · 0 skipped · 0 unchanged')).toBeTruthy();
  expect((screen.getByRole('link', { name: 'Truck 1' }) as HTMLAnchorElement).getAttribute('href'))
    .toMatch(/\/logistics\/trucks\/t1$/);
  expect(screen.getByRole('link', { name: 'Open Trucks' })).toBeTruthy();
  expect(screen.getByText('containers: +Crate B, −Crate A')).toBeTruthy();   // summary changes text
});
```

`portal/src/pages/BulkTrucks.test.tsx` — copy `BulkWorkers.test.tsx`, replacing the worker api mocks with `downloadTruckTemplate`, `downloadTruckExport`, `previewTruckBulk`, `commitTruckBulk`; the heading `'Add or update trucks in bulk'`; the guide check `screen.getByText('tracker_id')` and `screen.getByText('containers')`; the buttons `'Current trucks (.xlsx)'` and `'Template (.csv)'`.

In `portal/src/pages/BulkActions.test.tsx`: add `canTrucks: true` to `authMock`, extend `can` with `resource === 'trucks' ? authMock.canTrucks`, reset it in `afterEach`, set it false in the empty-state test, change the sites test's `getAllByRole('button', { name: 'Open' })` length to 3, and add:

```tsx
it('lists the trucks card only when the viewer can add trucks', () => {
  authMock.canTrucks = false;
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.queryByText('Add or update trucks in bulk')).toBeNull();
  cleanup();
  authMock.canTrucks = true;
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByText('Add or update trucks in bulk')).toBeTruthy();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd .../portal && npx vitest run src/lib/truckBulk.test.ts src/components/trucks/TruckBulkUpload.test.tsx src/pages/BulkTrucks.test.tsx src/pages/BulkActions.test.tsx`
Expected: unresolved modules / missing card.

- [ ] **Step 3: api client, guide, pane, page, card, route, toolbar**

Append to the workers bulk section of `portal/src/lib/api.ts`:

```ts
// ── trucks bulk import ──────────────────────────────────────────────

export interface TruckBulkRowResult {
  row: number;
  name: string | null;
  action: 'create' | 'update' | 'unchanged' | 'error';
  matched_by: string | null;
  matched_name: string | null;
  errors: string[];
  diff: BulkDiff | null;
  truck_id: string | null;
  cells: Record<string, string>;
  data: Record<string, unknown> | null;
}

export interface TruckBulkPreview {
  rows: TruckBulkRowResult[];
  can_commit: boolean;
}

export interface TruckBulkAppliedRow {
  row: number;
  name: string | null;
  truck_id: string;
  action: 'created' | 'updated' | 'skipped' | 'unchanged';
  diff: BulkDiff | null;
}

export interface TruckBulkCommitResult {
  created: number;
  updated: number;
  skipped: number;
  unchanged: number;
  rows: TruckBulkAppliedRow[];
}

export async function previewTruckBulk(file: File | Blob, filename: string): Promise<TruckBulkPreview> {
  const fd = new FormData();
  fd.append('file', file, filename);
  const resp = await apiFetch('/trucks/bulk-import/preview', { method: 'POST', body: fd });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function commitTruckBulk(
  rows: Record<string, unknown>[], approved: string[], source: string,
): Promise<TruckBulkCommitResult> {
  const resp = await apiFetch('/trucks/bulk-import/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rows, approved_updates: approved, source }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export function downloadTruckTemplate(format: 'csv' | 'xlsx'): Promise<void> {
  return downloadAttachment(`/trucks/bulk-import/template?format=${format}`, `trucks-template.${format}`);
}

export function downloadTruckExport(format: 'csv' | 'xlsx'): Promise<void> {
  return downloadAttachment(`/trucks/bulk-import/export?format=${format}`, `trucks-export.${format}`);
}
```

`portal/src/lib/truckBulk.ts`:

```ts
/** What each trucks bulk-import column accepts. Keys mirror the API's
 *  trucks/bulk_import.py COLUMNS — the service test pins that list, the
 *  test beside this file pins this one, and the two must agree. */
export interface TruckColumnGuide { key: string; required: boolean; accepts: string; example: string }

export const TRUCK_COLUMN_GUIDE: TruckColumnGuide[] = [
  { key: 'name', required: true, accepts: 'Truck name. Matches an existing truck by name (case does not matter).', example: 'Truck 12' },
  { key: 'status', required: false, accepts: 'A truck status key from the Reference sheet. Blank means created for new trucks.', example: 'active' },
  { key: 'driver_name', required: false, accepts: 'Free text.', example: 'Marcus Reyes' },
  { key: 'co_driver_name', required: false, accepts: 'Free text.', example: 'Dana Whitfield' },
  { key: 'team_drive', required: false, accepts: 'yes or no. Blank means no for new trucks.', example: 'yes' },
  { key: 'contact_info', required: false, accepts: 'Driver phone or other contact, free text.', example: '+1 (555) 010-2231' },
  { key: 'load_number', required: false, accepts: 'Free text.', example: 'L-1042' },
  { key: 'seal_id', required: false, accepts: 'Up to 24 characters.', example: 'SEAL-88231' },
  { key: 'tracking_type', required: false, accepts: 'How the truck is tracked, free text (gps, cell, none).', example: 'gps' },
  { key: 'tracking_update_type', required: false, accepts: 'How updates arrive, free text (API, manual).', example: 'API' },
  { key: 'tracker_id', required: false, accepts: 'Tracker or device id, free text.', example: 'TRK-0012' },
  { key: 'initiative', required: false, accepts: 'An existing move, project, or event name from the Reference sheet.', example: 'Example Move' },
  { key: 'start_site', required: false, accepts: 'An existing site name from the Reference sheet.', example: 'Example DC West' },
  { key: 'end_site', required: false, accepts: 'An existing site name from the Reference sheet.', example: 'Example Office' },
  { key: 'containers', required: false, accepts: 'Existing container names separated by semicolons. On an update the list replaces what is on the truck.', example: 'Crate A; Crate B' },
];

export const TRUCK_BULK_ERRORS: Record<string, string> = {
  unknown_columns: 'The file has columns that are not in the template.',
  too_many_rows: 'Too many rows — the limit is 1,000 per upload.',
  file_too_large: 'File too large — the limit is 5 MB.',
  invalid_json: 'The server could not read the rows — preview again.',
  invalid_csv: 'That CSV could not be read.',
  invalid_xlsx: 'That spreadsheet could not be read.',
  unsupported_file: 'Unsupported file type — use .csv or .xlsx.',
  missing_file: 'Choose a file first.',
  rows_invalid: 'Some rows have problems — fix them and preview again.',
  forbidden: 'You do not have permission to bulk import.',
};
```

`portal/src/components/trucks/TruckBulkUpload.tsx`:

```tsx
/**
 * TruckBulkUpload — the /bulk/trucks upload pane: the shared BulkUpload
 * configured for trucks (match by name, per-row update or skip, summary
 * linking to each truck's page).
 */
import {
  commitTruckBulk,
  previewTruckBulk,
  type TruckBulkAppliedRow,
  type TruckBulkCommitResult,
  type TruckBulkRowResult,
} from '../../lib/api';
import { TRUCK_BULK_ERRORS } from '../../lib/truckBulk';
import BulkUpload, { type BulkUploadConfig } from '../bulk/BulkUpload';

const CONFIG: BulkUploadConfig<TruckBulkRowResult, TruckBulkAppliedRow> = {
  idPrefix: 'truck',
  noun: 'truck',
  newLabel: 'new truck',
  errors: TRUCK_BULK_ERRORS,
  preview: previewTruckBulk,
  commit: commitTruckBulk,
  idOf: (r) => r.truck_id,
  summary: {
    entityLabel: 'Truck',
    linkFor: (r) => `/logistics/trucks/${r.truck_id}`,
    filename: 'trucks-bulk-summary',
    openTo: '/logistics/trucks',
    openLabel: 'Open Trucks',
  },
};

export default function TruckBulkUpload({ onDone }: { onDone?(result: TruckBulkCommitResult): void }) {
  return <BulkUpload config={CONFIG} onDone={onDone} />;
}
```

`portal/src/pages/BulkTrucks.tsx`:

```tsx
/**
 * BulkTrucks — /bulk/trucks: the shared page shell configured for trucks,
 * with TruckBulkUpload as the upload pane.
 */
import BulkToolPage from '../components/bulk/BulkToolPage';
import TruckBulkUpload from '../components/trucks/TruckBulkUpload';
import { downloadTruckExport, downloadTruckTemplate } from '../lib/api';
import { TRUCK_COLUMN_GUIDE } from '../lib/truckBulk';

export default function BulkTrucks() {
  return (
    <BulkToolPage
      title="Add or update trucks in bulk"
      hint={<>
        Download the template or the current fleet, fill it in, upload it, and review every add before applying.
        Rows match existing trucks by name; matched rows are skipped unless you tick Update.
        Moves, sites, and containers are matched by name and must already exist.
      </>}
      guide={TRUCK_COLUMN_GUIDE}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: () => downloadTruckTemplate('xlsx') },
        { key: 't-csv', label: 'Template (.csv)', run: () => downloadTruckTemplate('csv') },
        { key: 'e-xlsx', label: 'Current trucks (.xlsx)', run: () => downloadTruckExport('xlsx'), accent: true },
        { key: 'e-csv', label: 'Current trucks (.csv)', run: () => downloadTruckExport('csv'), accent: true },
      ]}
    >
      <TruckBulkUpload />
    </BulkToolPage>
  );
}
```

`portal/src/pages/BulkActions.tsx` — append to `BULK_TOOLS`:

```ts
  {
    key: 'trucks', title: 'Add or update trucks in bulk',
    description: 'Load a fleet list from a spreadsheet. Existing trucks match by name; update or skip each one.',
    resource: 'trucks', action: 'add', to: '/bulk/trucks', button: 'Open',
  },
```

`portal/src/App.tsx` — import `BulkTrucks` after `BulkSites`, and after the `/bulk/workers` route add:

```tsx
                <Route path="/bulk/trucks" element={
                  <ProtectedRoute resource="trucks" minRank={ADMIN_RANK}><BulkTrucks /></ProtectedRoute>
                } />
```

`portal/src/pages/Trucks.tsx` — `const { can, godMode, maxRank } = useAuth();`, import `ADMIN_RANK` from `'../lib/access'`, add `const canBulk = canAdd && maxRank >= ADMIN_RANK;   // mirrors the API's bulk gate` after `canChange`, and after the `+ New truck` button block add:

```tsx
          {canBulk && (
            <button className="mini-btn accent" onClick={() => navigate('/bulk/trucks')}>
              Bulk import…
            </button>
          )}
```

- [ ] **Step 4: Run the tests, the type check, and the Trucks page test**

Run: `cd .../portal && npx vitest run src/lib/truckBulk.test.ts src/components/trucks src/pages/BulkTrucks.test.tsx src/pages/BulkActions.test.tsx src/pages/Trucks.test.tsx && npx tsc --noEmit`
Expected: all pass; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-trucks
git add portal/src/lib/api.ts portal/src/lib/truckBulk.ts portal/src/lib/truckBulk.test.ts portal/src/components/trucks/TruckBulkUpload.tsx portal/src/components/trucks/TruckBulkUpload.test.tsx portal/src/pages/BulkTrucks.tsx portal/src/pages/BulkTrucks.test.tsx portal/src/pages/BulkActions.tsx portal/src/pages/BulkActions.test.tsx portal/src/App.tsx portal/src/pages/Trucks.tsx
git commit -m "feat(portal): /bulk/trucks — trucks bulk import page, pane, card, route, toolbar button

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Full suites and build

- [ ] **Step 1: API suite** — `cd .../api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_bulk_trucks .venv/bin/pytest -q 2>&1 | tail -15` (foreground, 600000 ms; if the harness cuts it at 10 minutes, split the run in two halves by test-file listing order, each foreground). Expected: all pass except known WeasyPrint environment failures if any, named.
- [ ] **Step 2: Portal** — `cd .../portal && npx vitest run 2>&1 | tail -15 && npx tsc --noEmit && npm run build 2>&1 | tail -5`. Expected: all pass, clean build.
- [ ] **Step 3: Report** counts; no commit is needed unless something was fixed.
