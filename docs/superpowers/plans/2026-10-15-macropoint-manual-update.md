# MacroPoint Manual Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Trucks page's **Manual update** action opens a tabbed modal whose MacroPoint tab turns dropped `.eml` files or pasted email text into truck location points, trip events and forward-only status changes on the right truck, with a preview first and a per-row summary after.

**Architecture:** A pure Python parser (`trucks/macropoint/parse.py`) turns emails into `ParsedMessage`s. A DB module (`trucks/macropoint/apply.py`) groups them by load, matches each load to an active truck, builds the preview, and applies it in one transaction (dedup via a per-truck `source_ref` unique constraint, `ON CONFLICT DO NOTHING`). Two thin routes in the trucks router expose preview/apply. Migration 0097 adds `truck_updates.source_ref` and a `truck_events` table. The Shipments feed gains `trip` events. The portal adds `ManualUpdateModal` → `MacroPointPanel` (input → review → summary).

**Tech Stack:** FastAPI + SQLAlchemy async + Alembic + Postgres (API, pytest), React + TypeScript + Vitest + Testing Library (portal).

**Spec:** `docs/superpowers/specs/2026-10-15-macropoint-manual-update-design.md`

## Global Constraints

- Worktree: `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/macropoint`, branch `macropoint-manual-update`. Do every command from this worktree, never the main checkout. `api/.venv`, `portal/node_modules` and `.env` are already symlinked to the main checkout — never run `npm install` or `pip install` here.
- API test command (always this shape, FOREGROUND, timeout 600000 ms, never backgrounded):
  `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/macropoint/api && SS_TEST_DB=serversherpa_test_macropoint PYTHONPATH=$PWD/src .venv/bin/pytest <tests> -q`
  (`PYTHONPATH` is mandatory: the venv's editable install points at the main checkout.)
- Portal test command: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/macropoint/portal && npx vitest run <files>`; type check: `npx tsc -b`.
- Migration number **0097**, revises **0096**. Before creating it, run `ls api/migrations/versions | tail -2` and `git log --all --format= --name-only -- 'api/migrations/versions/0097*'`; if a 0097 already exists anywhere, stop and report.
- Dedup key (`source_ref`) never includes the order token, so the same update arriving as `.eml` and as pasted text gets the same key.
- Active trucks = `archived_at IS NULL` and `status NOT IN ('inactive', 'historical')`.
- Status rule (forward only): `departed` + `pickup` → `in_transit` only from `created`/`active`; `arrived` + `drop_off` → `at_destination` only from `created`/`active`/`in_transit`. Status changes go through `trucks/trip.py` `apply_status_change(truck, new, now=event_time)`.
- Learned link lives in `trucks.tracking_type` JSONB: keys `type`, `update_type`, `tracker_id`, `macropoint_order`. Fill blanks only; never overwrite. Assign a NEW dict (JSONB persistence).
- Permission `trucks:change` on preview and apply; `trucks:view` on `GET /trucks/{id}/events`.
- Upload limits: 500 files, 2 MB per file, 20 MB total, 1 MB pasted text.
- American English in all copy, comments and docs (color, not colour).
- Portal guardrails (enforced by existing tests, run the FULL portal suite before each portal commit): no raw native `<select>` (use `ComboBox`), no `localeCompare`/bare `.sort()` on text (use `lib/naturalSort.ts`), no inline `fontSize`, no CSS selectors ending in `-head`, no `overflow:auto|scroll` + `border-radius` rule in new CSS, dropdowns in dialogs must portal (ComboBox does this itself inside `.modal-card`).
- New modals use the report-generate header: `.eyebrow`, `h3`, `p.page-hint`, `rgm-steps` for steps, wide `rgm-card`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit `api/src/serversherpa/_dev_reload.py`.

## Review Focus

1. **Same email twice in one upload, or uploaded once and pasted later** — expect one stored row, the second reported "Already recorded"/`duplicate`, never a 500 (Task 3 test `test_cross_format_and_in_batch_duplicates`, Task 4 test `test_reapply_is_all_duplicate_and_survives_many_conflicts`).
2. **Old emails dropped onto a truck that has moved on** (e.g. a Departed-at-Pickup email for a truck already `at_destination`) — status must not move backward (Task 4 `test_status_is_forward_only`).
3. **A load already linked to a different MacroPoint order, or a truck whose Tracker id is already filled** — rows still apply to the picked truck, the link is not overwritten, and the summary says so (Task 4 `test_learn_link_fills_blanks_only`).
4. **A non-MacroPoint or malformed file in the batch** (the Locus Traxx samples, an empty file, an unknown time zone) — that one file becomes an error row; the rest parse and apply (Task 2 parser error tests, Task 3 `test_preview_groups_matches_and_writes_nothing`).
5. **The user picks a truck that went inactive/archived between preview and apply, or leaves a load blank** — those rows come back `error` / `skipped`, the rest still apply (Task 4 `test_skip_and_inactive_truck`).

---

## File Structure

**API (create)**
- `api/migrations/versions/0097_truck_macropoint.py` — `truck_updates.source_ref` + unique constraint; `truck_events` table.
- `api/src/serversherpa/trucks/macropoint/__init__.py` — package marker (docstring only).
- `api/src/serversherpa/trucks/macropoint/parse.py` — pure email → `ParsedMessage | ParseError`.
- `api/src/serversherpa/trucks/macropoint/client.py` — placeholder `MacroPointClient` (raises `NotImplementedError`).
- `api/src/serversherpa/trucks/macropoint/apply.py` — grouping, matching, status rule, preview, apply, limits.
- `api/tests/fixtures/macropoint/*.eml`, `*.txt` — curated, scrubbed samples.
- Tests: `api/tests/test_migration_0097_truck_macropoint.py`, `test_macropoint_parse.py`, `test_macropoint_match.py`, `test_macropoint_api.py`, `test_truck_events_api.py`.

**API (modify)**
- `api/src/serversherpa/db/models.py` — `TruckUpdate.source_ref`; new `TruckEvent`.
- `api/src/serversherpa/api/schemas.py` — MacroPoint preview/apply schemas, `TruckEventOut`, feed `trip` kind.
- `api/src/serversherpa/api/routes/trucks.py` — preview/apply routes, `GET /{id}/events`, clear also clears events.
- `api/src/serversherpa/trucks/feed.py` — `trip` source, status `via`.
- `api/tests/test_trucks_feed.py` — trip events + via.

**Portal (create)**
- `portal/src/lib/macropoint.ts` (+ `.test.ts`) — pure helpers.
- `portal/src/components/MultiFileDropzone.tsx` (+ `.test.tsx`).
- `portal/src/components/trucks/MacroPointSummary.tsx`.
- `portal/src/components/trucks/MacroPointPanel.tsx`.
- `portal/src/components/trucks/ManualUpdateModal.tsx` (+ `.test.tsx`).
- `portal/src/styles/macropoint.css`.

**Portal (modify)**
- `portal/src/lib/api.ts` — types + `previewMacroPoint`, `applyMacroPoint`, `listTruckEvents`; feed type.
- `portal/src/pages/Trucks.tsx` (+ test) — enable Manual update.
- `portal/src/pages/TruckDetail.tsx` (+ test) — relabel, order token, Trip events table.
- `portal/src/components/trucks/TruckEditModal.tsx` — relabel.
- `portal/src/lib/shipments.ts` (+ test), `portal/src/pages/ShipmentsDashboard.tsx`, `portal/src/styles/dashboard.css` — `trip` feed events and `via`.

---

### Task 1: Migration 0097 and models

**Files:**
- Create: `api/migrations/versions/0097_truck_macropoint.py`
- Modify: `api/src/serversherpa/db/models.py` (class `TruckUpdate`, add class `TruckEvent` right after it)
- Test: `api/tests/test_migration_0097_truck_macropoint.py`

**Interfaces:**
- Produces: table `truck_events`; constraint names `uq_truck_updates_truck_source_ref`, `uq_truck_events_truck_source_ref`; ORM `TruckUpdate.source_ref: str | None`, ORM `TruckEvent` (fields below).

- [ ] **Step 1: Check the migration number is free**

Run: `ls api/migrations/versions | tail -2; git log --all --format= --name-only -- 'api/migrations/versions/0097*' | sort -u`
Expected: last file `0096_truck_trip_and_feed_indexes.py`; the git log prints nothing. Otherwise stop and report.

- [ ] **Step 2: Write the failing test**

```python
"""Migration 0097: truck_updates.source_ref (+ per-truck unique) and the
truck_events table for MacroPoint trip events."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import Truck, TruckEvent, TruckUpdate

T0 = datetime(2026, 3, 1, 12, tzinfo=UTC)


async def test_columns_and_constraints_exist(db):
    col = (await db.execute(text(
        "SELECT data_type, is_nullable FROM information_schema.columns "
        "WHERE table_name='truck_updates' AND column_name='source_ref'"))).one()
    assert col == ("text", "YES")
    names = set((await db.scalars(text(
        "SELECT conname FROM pg_constraint WHERE conname IN "
        "('uq_truck_updates_truck_source_ref', 'uq_truck_events_truck_source_ref')"))).all())
    assert names == {"uq_truck_updates_truck_source_ref", "uq_truck_events_truck_source_ref"}
    idx = set((await db.scalars(text(
        "SELECT indexname FROM pg_indexes WHERE tablename='truck_events'"))).all())
    assert {"ix_truck_events_truck_recorded", "ix_truck_events_recorded_at"} <= idx


async def test_source_ref_unique_per_truck_but_null_repeats(db):
    a, b = Truck(name="A"), Truck(name="B")
    db.add_all([a, b])
    await db.flush()
    for truck in (a, a, b):          # NULL refs never collide
        db.add(TruckUpdate(truck_id=truck.id, recorded_at=T0, location="1.000000, 2.000000",
                           lat=1.0, lng=2.0))
    db.add(TruckUpdate(truck_id=a.id, recorded_at=T0, location="1.000000, 2.000000",
                       lat=1.0, lng=2.0, source_ref="r1"))
    db.add(TruckUpdate(truck_id=b.id, recorded_at=T0, location="1.000000, 2.000000",
                       lat=1.0, lng=2.0, source_ref="r1"))   # same ref, other truck: fine
    await db.commit()
    db.add(TruckUpdate(truck_id=a.id, recorded_at=T0, location="1.000000, 2.000000",
                       lat=1.0, lng=2.0, source_ref="r1"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_truck_event_defaults_and_cascade(db):
    t = Truck(name="Evented")
    db.add(t)
    await db.flush()
    e = TruckEvent(truck_id=t.id, recorded_at=T0, event="Departed at Pickup",
                   event_kind="departed", stop="pickup", source_ref="x")
    db.add(e)
    await db.commit()
    await db.refresh(e)
    assert e.source == "manual"
    assert e.created_at is not None
    await db.delete(t)
    await db.commit()
    assert (await db.scalar(text("SELECT count(*) FROM truck_events"))) == 0
```

- [ ] **Step 3: Run it to verify it fails**

Run: `… pytest tests/test_migration_0097_truck_macropoint.py -q`
Expected: FAIL — `ImportError: cannot import name 'TruckEvent'`.

- [ ] **Step 4: Write the migration**

```python
"""MacroPoint manual update: dedup key on truck location updates and a
truck_events table for trip events (Arrived/Departed at Pickup, Drop-Off or
a named stop).

`source_ref` is a hash of the update's content (see
trucks/macropoint/parse.py `source_ref_for`), unique per truck so a
re-uploaded email is a no-op and a load re-assigned to another truck still
lands. A plain (non-partial) unique constraint: NULLs are distinct in
Postgres, so hand-entered rows never collide, and `ON CONFLICT ON
CONSTRAINT` needs no index inference.

Revision ID: 0097
Revises: 0096
Create Date: 2026-10-15
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0097"
down_revision: str | None = "0096"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TS = sa.TIMESTAMP(timezone=True)


def upgrade() -> None:
    op.add_column("truck_updates", sa.Column("source_ref", sa.Text, nullable=True))
    op.create_unique_constraint("uq_truck_updates_truck_source_ref", "truck_updates",
                                ["truck_id", "source_ref"])
    op.create_table(
        "truck_events",
        sa.Column("id", UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("truck_id", UUID(as_uuid=True),
                  sa.ForeignKey("trucks.id", ondelete="CASCADE"), nullable=False),
        sa.Column("recorded_at", TS, nullable=False),
        sa.Column("event", sa.Text, nullable=False),
        sa.Column("event_kind", sa.Text, nullable=True),
        sa.Column("stop", sa.Text, nullable=True),
        sa.Column("source", sa.Text, nullable=False, server_default="manual"),
        sa.Column("source_ref", sa.Text, nullable=True),
        sa.Column("created_by", UUID(as_uuid=True),
                  sa.ForeignKey("people.id", ondelete="SET NULL"), nullable=True),
        sa.Column("created_at", TS, nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("truck_id", "source_ref", name="uq_truck_events_truck_source_ref"),
    )
    op.create_index("ix_truck_events_truck_recorded", "truck_events",
                    ["truck_id", sa.text("recorded_at DESC")])
    op.create_index("ix_truck_events_recorded_at", "truck_events",
                    [sa.text("recorded_at DESC")])


def downgrade() -> None:
    op.drop_index("ix_truck_events_recorded_at", table_name="truck_events")
    op.drop_index("ix_truck_events_truck_recorded", table_name="truck_events")
    op.drop_table("truck_events")
    op.drop_constraint("uq_truck_updates_truck_source_ref", "truck_updates", type_="unique")
    op.drop_column("truck_updates", "source_ref")
```

- [ ] **Step 5: Update the models**

In `TruckUpdate`, extend the docstring and add the column after `source`:

```python
class TruckUpdate(Base):
    """One location report. `location` is V2's raw "lat, lng" text; lat/lng
    are the parsed numbers the map uses (NULL when unparsable). `source_ref`
    is the dedup key of an imported report (MacroPoint), unique per truck;
    NULL for hand-entered rows."""

    # … existing columns unchanged …
    source: Mapped[str] = mapped_column(server_default="manual")
    source_ref: Mapped[str | None]
```

Add right after `TruckUpdate`:

```python
class TruckEvent(Base):
    """A tracked trip event with no coordinates — e.g. MacroPoint "Departed
    at Pickup". `event` is the raw text; `event_kind` (arrived/departed) and
    `stop` (pickup/drop_off/a named stop) are parsed from it when it has the
    "<Arrived|Departed> at <stop>" shape. `source_ref` dedups like
    TruckUpdate.source_ref."""

    __tablename__ = "truck_events"

    id: Mapped[uuid.UUID] = mapped_column(
        primary_key=True, server_default=text("gen_random_uuid()"))
    truck_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("trucks.id", ondelete="CASCADE"))
    recorded_at: Mapped[datetime]
    event: Mapped[str]
    event_kind: Mapped[str | None]
    stop: Mapped[str | None]
    source: Mapped[str] = mapped_column(server_default="manual")
    source_ref: Mapped[str | None]
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("people.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(server_default=text("now()"))
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `… pytest tests/test_migration_0097_truck_macropoint.py tests/test_trucks_model.py tests/test_container_labels_report.py -q`
Expected: PASS (conftest migrates the test DB to 0097; the single-head test still passes).

- [ ] **Step 7: Commit**

```bash
git add api/migrations/versions/0097_truck_macropoint.py api/src/serversherpa/db/models.py api/tests/test_migration_0097_truck_macropoint.py
git commit -m "feat(trucks): migration 0097 — truck_updates.source_ref and truck_events

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Fixtures, parser and placeholder client

**Files:**
- Create: `api/tests/fixtures/macropoint/` (11 `.eml` + 2 `.txt`)
- Create: `api/src/serversherpa/trucks/macropoint/__init__.py`, `parse.py`, `client.py`
- Test: `api/tests/test_macropoint_parse.py`

**Interfaces:**
- Consumes: `serversherpa.trucks.location.parse_location`, `LocationError`.
- Produces (module `serversherpa.trucks.macropoint.parse`):
  - `ZONES: dict[str, str]`
  - `@dataclass(frozen=True) ParsedMessage(kind: Literal["location","trip_event"], source: str, carrier: str, id_number: str, order_token: str | None, recorded_at: datetime, source_ref: str, lat: float | None = None, lng: float | None = None, address: str = "", event: str | None = None, event_kind: str | None = None, stop: str | None = None)`
  - `@dataclass(frozen=True) ParseError(source: str, reason: str)` — reasons: `not_macropoint`, `unreadable`, `missing_field:id_number`, `missing_field:date_time`, `missing_field:location`, `missing_field:event`, `unknown_zone`, `bad_time`, `bad_location`.
  - `normalize_id(value: str) -> str`
  - `source_ref_for(kind, id_number, recorded_at, *, lat=None, lng=None, event=None) -> str`
  - `html_to_text(markup: str) -> str`
  - `parse_text(text: str, source: str, *, order_token: str | None = None) -> list[ParsedMessage | ParseError]`
  - `parse_eml(data: bytes, filename: str) -> list[ParsedMessage | ParseError]`
  - `parse_inputs(files: list[tuple[str, bytes]], text: str) -> list[ParsedMessage | ParseError]`
- Produces (module `…macropoint.client`): `class MacroPointClient` with `fetch_updates(order_token: str, since: datetime | None = None) -> list[ParsedMessage]` raising `NotImplementedError`.

Notes for the implementer:
- `recorded_at` is the email BODY's `Date/Time` in its zone converted to UTC, minute precision. The `Date:` mail header is the send time (observed up to 2 minutes later) and is ignored.
- The text/plain part of these emails is truncated at the first `&` in some messages, so `.eml` parsing reads the HTML part.
- Only `MacroPoint-Lite.com/…OrderSetup.aspx?…Data=<token>` links carry an order token. `visibility.macropoint.com/shipments?l=…` links differ per message and are ignored.

- [ ] **Step 1: Create the fixtures (scrubbed copies of the user's samples)**

Run from the worktree root:

```bash
mkdir -p api/tests/fixtures/macropoint
python3 -I - "/Users/jrh1812/Developer/BaseCampV3/Sample Data/macropoint" api/tests/fixtures/macropoint <<'EOF'
import pathlib, sys
src, dst = map(pathlib.Path, sys.argv[1:])
PICK = {
    "loc_landstar_pt.eml": "Location Update for ID Number 'QR01294949 - CA-NV'.eml",
    "loc_longboard_ct.eml": "Location Update for ID Number 'TEAM MARTHA & JOEL- BROADCOM EQUINIX- TX TO VA'.eml",
    "loc_landstar_et_slash.eml": "Location Update for ID Number 'CL01287769-TX-MN' 10.eml",
    "loc_heavy_whitespace.eml": "Location Update for ID Number 'TEAM WRIGHT WA TO NV- LARGE PROJECT' 14.eml",
    "loc_jamie.eml": "Location Update for ID Number 'JAMIE & PATRICK -NV TO PALO ALTO' 10.eml",
    "trip_arrived_pickup.eml": "Trip Event Update for ID Number - JAMIE & PATRICK -NV TO PALO ALTO 4.eml",
    "trip_departed_pickup.eml": "Trip Event Update for ID Number - JAMIE & PATRICK -NV TO PALO ALTO 3.eml",
    "trip_arrived_dropoff.eml": "Trip Event Update for ID Number - JAMIE & PATRICK -NV TO PALO ALTO 2.eml",
    "trip_departed_dropoff.eml": "Trip Event Update for ID Number - JAMIE & PATRICK -NV TO PALO ALTO.eml",
    "trip_named_stop.eml": "Trip Event Update for ID Number - TEAM MARTHA & JOEL- BROADCOM EQUINIX- TX TO VA 2.eml",
    "locus_traxx.eml": "Last Reported Location PROCESSING TRIP...(EW to LV truck 2) [7103415555].eml",
}
KEEP = {"from", "to", "subject", "date", "mime-version", "content-type"}

def scrub(data: bytes) -> bytes:
    sep = b"\r\n\r\n" if b"\r\n\r\n" in data else b"\n\n"
    nl = sep[: len(sep) // 2]
    head, body = data.split(sep, 1)
    blocks, cur = [], []
    for line in head.split(nl):
        if line[:1] in (b" ", b"\t") and cur:
            cur.append(line)
            continue
        if cur:
            blocks.append(cur)
        cur = [line]
    if cur:
        blocks.append(cur)
    kept = []
    for block in blocks:
        name = block[0].split(b":", 1)[0].strip().lower().decode("ascii", "replace")
        if name in KEEP:
            kept.append(b"To: ops@example.com" if name == "to" else nl.join(block))
    return nl.join(kept) + sep + body

for new, old in PICK.items():
    out = scrub((src / old).read_bytes())
    low = out.lower()
    assert b"cumulussg" not in low and b"henderson" not in low, new
    (dst / new).write_bytes(out)
print("ok", len(PICK))
EOF
```

Expected: `ok 11`.

Then create `api/tests/fixtures/macropoint/pasted_outlook_two.txt` (two emails copied from Outlook, headers included) with exactly:

```text
From: MacroPoint <no-reply@macropoint.com>
Sent: Tuesday, October 15, 2024 1:32 PM
To: Ops <ops@example.com>
Subject: Location Update for ID Number 'JAMIE & PATRICK -NV TO PALO ALTO'

------------------------------------------------------------------------
Location Update from Landstar - ATL
------------------------------------------------------------------------
ID Number 'JAMIE & PATRICK -NV TO PALO ALTO'

Date/Time:
10/15/2024 @ 1:32 PM PT

Location:
35.48169252,-119.14035278 (View All Updates)


Approximate Address(if available):
CA-99  Bakersfield CA 93308 United States

 Notes:
 JAMIE & PATRICK -NV TO PALO ALTO
 -------------------------------------------------------------------------------

Location Powered By MacroPoint
www.MacroPoint.com

From: MacroPoint <no-reply@macropoint.com>
Sent: Tuesday, October 15, 2024 7:36 AM
To: Ops <ops@example.com>
Subject: Trip Event Update for ID Number : JAMIE & PATRICK -NV TO PALO ALTO

------------------------------------------------------------------------
Trip Event Update from Landstar - ATL
------------------------------------------------------------------------
ID Number : JAMIE & PATRICK -NV TO PALO ALTO

Date/Time:
10/15/2024 @ 7:36 AM PT

Event:
Arrived at Pickup (View All Updates)

Notes:
JAMIE & PATRICK -NV TO PALO ALTO

------------------------------------------------------------------------

Powered By MacroPoint
www.MacroPoint.com
```

and `api/tests/fixtures/macropoint/pasted_plain_runtogether.txt` (the emails' own text/plain parts, fields run together) with exactly these two lines:

```text
------------------------------------------------------------------------Location Update from Landstar - ATL------------------------------------------------------------------------ID Number 'QR01294949 - CA-NV'
Date/Time: 6/7/2024 @ 6:24 PM PTLocation: 35.34956359,-115.94153837 (View All Updates)Approximate Address(if available): Mojave Freeway (I-15) Nipton CA 92364 United States Notes: VICTOR
------------------------------------------------------------------------Trip Event Update from Landstar - ATL------------------------------------------------------------------------ID Number : TEAM WRIGHT WA TO NV- LARGE PROJECTDate/Time:10/12/2024 @ 1:53 AM PTEvent:Departed at Pickup (View All Updates)Notes: TEAM WRIGHT WA TO NV- LARGE PROJECT ------------------------------------------------------------------------Powered By MacroPoint www.MacroPoint.com
```

- [ ] **Step 2: Write the failing parser tests**

`api/tests/test_macropoint_parse.py`:

```python
"""MacroPoint email parser — every field of each sample kind, pasted text
in both copy styles, the cross-format dedup key and the error reasons."""

from datetime import UTC, datetime
from pathlib import Path

import pytest

from serversherpa.trucks.macropoint.client import MacroPointClient
from serversherpa.trucks.macropoint.parse import (
    ParsedMessage,
    ParseError,
    normalize_id,
    parse_eml,
    parse_inputs,
    parse_text,
    source_ref_for,
)

FIX = Path(__file__).parent / "fixtures" / "macropoint"


def one(name: str) -> ParsedMessage:
    [msg] = parse_eml((FIX / name).read_bytes(), name)
    assert isinstance(msg, ParsedMessage), msg
    return msg


def utc(*args) -> datetime:
    return datetime(*args, tzinfo=UTC)


def test_location_landstar_pt():
    m = one("loc_landstar_pt.eml")
    assert m.kind == "location"
    assert m.source == "loc_landstar_pt.eml"
    assert m.carrier == "Landstar - ATL"
    assert m.id_number == "QR01294949 - CA-NV"
    assert m.order_token == "Dk4ScKJ-t64u-XiTR8UdjQ__"
    assert m.recorded_at == utc(2024, 6, 8, 1, 24)          # 6:24 PM PDT
    assert (m.lat, m.lng) == (35.34956359, -115.94153837)
    assert m.address == "Mojave Freeway (I-15) Nipton CA 92364 United States"
    assert m.event is None and m.event_kind is None and m.stop is None


def test_location_longboard_ct_has_no_order_token():
    m = one("loc_longboard_ct.eml")
    assert m.carrier == "Longboard Transportation"
    assert m.id_number == "TEAM MARTHA & JOEL- BROADCOM EQUINIX- TX TO VA"
    assert m.order_token is None                          # visibility link: per message
    assert m.recorded_at == utc(2026, 3, 13, 18, 22)        # 1:22 PM CDT
    assert m.address == "Stony Point Rd Harrisonburg VA 22802 USA"   # doubled space squashed


def test_location_et_with_slash_id_and_bang_token():
    m = one("loc_landstar_et_slash.eml")
    assert m.id_number == "CL01287769/TX-MN"
    assert m.order_token == "TU7xeFzI44nw4JRZWxxw!A__"
    assert m.recorded_at == utc(2024, 5, 17, 22, 22)        # 6:22 PM EDT
    assert m.address == "Inver Grove Heights MN 55077 United States"


def test_location_heavy_whitespace():
    m = one("loc_heavy_whitespace.eml")
    assert m.id_number == "TEAM WRIGHT WA TO NV- LARGE PROJECT"
    assert m.address == "I-90 Post Falls ID 83854 United States"
    assert m.recorded_at == utc(2024, 10, 12, 0, 47)


@pytest.mark.parametrize(("name", "event", "kind", "stop", "at"), [
    ("trip_arrived_pickup.eml", "Arrived at Pickup", "arrived", "pickup", utc(2024, 10, 15, 14, 36)),
    ("trip_departed_pickup.eml", "Departed at Pickup", "departed", "pickup", utc(2024, 10, 15, 15, 11)),
    ("trip_arrived_dropoff.eml", "Arrived at Drop-Off", "arrived", "drop_off", utc(2024, 10, 16, 2, 28)),
    ("trip_departed_dropoff.eml", "Departed at Drop-Off", "departed", "drop_off", utc(2024, 10, 16, 15, 27)),
    ("trip_named_stop.eml", "Arrived at BROADCOM DRT ACC4", "arrived", "BROADCOM DRT ACC4",
     utc(2026, 3, 13, 20, 11)),
])
def test_trip_events(name, event, kind, stop, at):
    m = one(name)
    assert m.kind == "trip_event"
    assert m.event == event
    assert m.event_kind == kind
    assert m.stop == stop
    assert m.recorded_at == at
    assert m.lat is None and m.address == ""


def test_trip_event_reads_html_not_truncated_plain():
    # The text/plain part of this email stops at "JAMIE" (truncated at "&").
    assert one("trip_departed_pickup.eml").id_number == "JAMIE & PATRICK -NV TO PALO ALTO"


def test_load_shares_one_order_token_across_kinds():
    tokens = {one(n).order_token for n in (
        "loc_jamie.eml", "trip_arrived_pickup.eml", "trip_departed_dropoff.eml")}
    assert tokens == {"VM0s7D8QTl5j92QfqQgTmQ__"}


def test_non_macropoint_email_is_an_error_not_a_crash():
    assert parse_eml((FIX / "locus_traxx.eml").read_bytes(), "locus_traxx.eml") == [
        ParseError("locus_traxx.eml", "not_macropoint")]
    assert parse_eml(b"", "empty.eml") == [ParseError("empty.eml", "not_macropoint")]


def test_pasted_outlook_two_emails():
    text = (FIX / "pasted_outlook_two.txt").read_text()
    loc, trip = parse_text(text, "Pasted text")
    assert loc.source == "Pasted text #1" and trip.source == "Pasted text #2"
    assert loc.kind == "location" and loc.order_token is None
    assert loc.id_number == "JAMIE & PATRICK -NV TO PALO ALTO"
    assert loc.recorded_at == utc(2024, 10, 15, 20, 32)
    assert (loc.lat, loc.lng) == (35.48169252, -119.14035278)
    assert loc.address == "CA-99 Bakersfield CA 93308 United States"
    assert trip.event == "Arrived at Pickup" and trip.stop == "pickup"


def test_pasted_plain_run_together():
    text = (FIX / "pasted_plain_runtogether.txt").read_text()
    loc, trip = parse_text(text, "Pasted text")
    assert loc.id_number == "QR01294949 - CA-NV"
    assert loc.recorded_at == utc(2024, 6, 8, 1, 24)
    assert loc.address == "Mojave Freeway (I-15) Nipton CA 92364 United States"
    assert trip.id_number == "TEAM WRIGHT WA TO NV- LARGE PROJECT"
    assert trip.recorded_at == utc(2024, 10, 12, 8, 53)
    assert trip.event == "Departed at Pickup"


def test_same_update_eml_and_pasted_share_source_ref():
    pasted = parse_text((FIX / "pasted_outlook_two.txt").read_text(), "Pasted text")
    assert pasted[0].source_ref == one("loc_jamie.eml").source_ref
    assert pasted[1].source_ref == one("trip_arrived_pickup.eml").source_ref
    plain = parse_text((FIX / "pasted_plain_runtogether.txt").read_text(), "Pasted text")
    assert plain[0].source_ref == one("loc_landstar_pt.eml").source_ref


def test_source_ref_shape_and_sensitivity():
    at = utc(2024, 1, 1, 10, 5, 42)
    ref = source_ref_for("location", "Load  A", at, lat=1.0, lng=2.0)
    assert len(ref) == 32
    assert ref == source_ref_for("location", "load a", utc(2024, 1, 1, 10, 5), lat=1.0, lng=2.0)
    assert ref != source_ref_for("location", "load a", at, lat=1.0, lng=2.00002)
    assert ref != source_ref_for("trip_event", "load a", at, event="Arrived at Pickup")


def test_normalize_id():
    assert normalize_id("  TEAM  Wright\tWA ") == "team wright wa"


def _loc_text(time_line: str, location: str = "35.1,-115.2") -> str:
    return ("Location Update from Landstar - ATL\nID Number 'L1'\n"
            f"Date/Time: {time_line}\nLocation: {location} (View All Updates)\n")


@pytest.mark.parametrize(("text", "reason"), [
    (_loc_text("6/7/2024 @ 6:24 PM ZZ"), "unknown_zone"),
    (_loc_text("13/45/2024 @ 6:24 PM PT"), "bad_time"),
    ("Location Update from Landstar - ATL\nID Number 'L1'\nLocation: 1,2", "missing_field:date_time"),
    (_loc_text("6/7/2024 @ 6:24 PM PT", location="none"), "missing_field:location"),
    (_loc_text("6/7/2024 @ 6:24 PM PT", location="95.0,10.0"), "bad_location"),
    ("Location Update from Landstar - ATL\nDate/Time: 6/7/2024 @ 6:24 PM PT", "missing_field:id_number"),
    ("Trip Event Update from Landstar - ATL\nID Number : L1\nDate/Time: 6/7/2024 @ 6:24 PM PT\n",
     "missing_field:event"),
    ("hello, nothing to see", "not_macropoint"),
])
def test_parse_errors(text, reason):
    [result] = parse_text(text, "Pasted text")
    assert result == ParseError("Pasted text", reason)


def test_parse_inputs_files_then_text():
    files = [("loc_jamie.eml", (FIX / "loc_jamie.eml").read_bytes()),
             ("locus_traxx.eml", (FIX / "locus_traxx.eml").read_bytes())]
    out = parse_inputs(files, (FIX / "pasted_plain_runtogether.txt").read_text())
    assert [getattr(o, "source") for o in out] == [
        "loc_jamie.eml", "locus_traxx.eml", "Pasted text #1", "Pasted text #2"]
    assert parse_inputs([], "   ") == []


def test_api_client_is_a_placeholder():
    with pytest.raises(NotImplementedError):
        MacroPointClient().fetch_updates("token")
```

- [ ] **Step 3: Run to verify it fails**

Run: `… pytest tests/test_macropoint_parse.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'serversherpa.trucks.macropoint'`.

- [ ] **Step 4: Implement the package**

`api/src/serversherpa/trucks/macropoint/__init__.py`:

```python
"""MacroPoint truck tracking: email parsing (parse.py), the manual-update
preview/apply service (apply.py) and the future API client (client.py)."""
```

`api/src/serversherpa/trucks/macropoint/parse.py`:

```python
"""MacroPoint notification emails -> structured truck updates.

Two kinds of email: "Location Update" (coordinates + approximate address)
and "Trip Event Update" (Arrived/Departed at Pickup, Drop-Off or a named
stop). Input is a .eml file or text pasted from a mail client. Pasted text
may hold several emails and may run fields together with no newline
("… PTLocation: …"), so every pattern accepts fields separated by newlines
or by nothing. Pure functions; no database.

The time is the body's "Date/Time" in its zone, converted to UTC (minute
precision). The mail `Date:` header is the send time and is ignored. The
text/plain part of these emails is truncated at the first "&" in some
messages, so a .eml is read from its HTML part. Only the MacroPoint-Lite
"View All Updates" link (`OrderSetup.aspx?…Data=<token>`) carries a stable
per-load order token; newer `visibility.macropoint.com` links differ in
every message and are ignored.
"""

import email
import hashlib
import html
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from email import policy
from typing import Literal
from zoneinfo import ZoneInfo

from serversherpa.trucks.location import LocationError, parse_location

ZONES = {
    "PT": "America/Los_Angeles",
    "MT": "America/Denver",
    "CT": "America/Chicago",
    "ET": "America/New_York",
    "AKT": "America/Anchorage",
    "HT": "Pacific/Honolulu",
}

_HEADER = re.compile(r"(Location|Trip Event) Update from\s+(.+?)\s*(?=-{3,}|\n|ID Number)")
_ID = re.compile(r"ID Number\s*(?:'(?P<q>.*?)'|:\s*(?P<c>.*?))\s*(?=Date/Time)", re.S)
_TIME = re.compile(
    r"Date/Time:\s*(?P<mo>\d{1,2})/(?P<d>\d{1,2})/(?P<y>\d{4})\s*@\s*"
    r"(?P<h>\d{1,2}):(?P<mi>\d{2})\s*(?P<ap>[AP]M)\s*(?P<zone>[A-Z]{1,4}?)"
    r"(?=\s|Location:|Event:|$)")
_LOCATION = re.compile(
    r"Location:\s*(?P<lat>-?\d+(?:\.\d+)?)\s*,\s*(?P<lng>-?\d+(?:\.\d+)?)")
_ADDRESS = re.compile(
    r"Approximate Address\(if available\):\s*(?P<a>.*?)\s*(?=Notes:|-{5,}|$)", re.S)
_EVENT = re.compile(r"Event:\s*(?P<e>.+?)\s*(?=\(View All Updates\)|Notes:|\n|$)")
_EVENT_PARTS = re.compile(r"^(Arrived|Departed) at (.+)$", re.I)
_ORDER_TOKEN = re.compile(r"OrderSetup\.aspx\?[^\"'<>\s]*?Data=([^\"'&\s<>]+)", re.I)
_STOPS = {"pickup": "pickup", "drop-off": "drop_off", "dropoff": "drop_off",
          "drop off": "drop_off"}

Kind = Literal["location", "trip_event"]


@dataclass(frozen=True)
class ParsedMessage:
    kind: Kind
    source: str
    carrier: str
    id_number: str
    order_token: str | None
    recorded_at: datetime
    source_ref: str
    lat: float | None = None
    lng: float | None = None
    address: str = ""
    event: str | None = None
    event_kind: str | None = None
    stop: str | None = None


@dataclass(frozen=True)
class ParseError:
    source: str
    reason: str


def _squash(value: str) -> str:
    return " ".join(value.split())


def normalize_id(value: str) -> str:
    """Comparison form of a MacroPoint ID Number or a truck's Tracker id."""
    return _squash(value).casefold()


def source_ref_for(kind: str, id_number: str, recorded_at: datetime, *,
                   lat: float | None = None, lng: float | None = None,
                   event: str | None = None) -> str:
    """Dedup key: the same update gives the same key whether it came from a
    .eml or pasted text, so the order token (absent from pasted text) is
    deliberately left out."""
    minute = recorded_at.astimezone(UTC).replace(second=0, microsecond=0).isoformat()
    payload = f"{lat:.5f},{lng:.5f}" if kind == "location" else normalize_id(event or "")
    raw = "|".join(("macropoint", kind, normalize_id(id_number), minute, payload))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def html_to_text(markup: str) -> str:
    text = re.sub(r"(?i)<br\s*/?>", "\n", markup)
    text = re.sub(r"(?is)<(script|style|title)\b.*?</\1>", "", text)
    text = re.sub(r"<[^>]+>", "", text)
    return html.unescape(text).replace("\xa0", " ")


def _parse_time(m: re.Match) -> datetime:
    hour = int(m["h"]) % 12 + (12 if m["ap"] == "PM" else 0)
    local = datetime(int(m["y"]), int(m["mo"]), int(m["d"]), hour, int(m["mi"]),
                     tzinfo=ZoneInfo(ZONES[m["zone"]]))
    return local.astimezone(UTC)


def _parse_block(block: str, source: str,
                 order_token: str | None) -> ParsedMessage | ParseError:
    head = _HEADER.search(block)
    kind: Kind = "location" if head.group(1) == "Location" else "trip_event"
    carrier = _squash(head.group(2))
    idm = _ID.search(block)
    id_number = _squash(idm["q"] if idm["q"] is not None else idm["c"]) if idm else ""
    if not id_number:
        return ParseError(source, "missing_field:id_number")
    tm = _TIME.search(block)
    if not tm:
        return ParseError(source, "missing_field:date_time")
    if tm["zone"] not in ZONES:
        return ParseError(source, "unknown_zone")
    try:
        recorded_at = _parse_time(tm)
    except ValueError:
        return ParseError(source, "bad_time")

    if kind == "location":
        loc = _LOCATION.search(block)
        if not loc:
            return ParseError(source, "missing_field:location")
        try:
            lat, lng = parse_location(f"{loc['lat']}, {loc['lng']}")
        except LocationError:
            return ParseError(source, "bad_location")
        addr = _ADDRESS.search(block)
        return ParsedMessage(
            kind, source, carrier, id_number, order_token, recorded_at,
            source_ref_for(kind, id_number, recorded_at, lat=lat, lng=lng),
            lat=lat, lng=lng, address=_squash(addr["a"]) if addr else "")

    ev = _EVENT.search(block)
    if not ev:
        return ParseError(source, "missing_field:event")
    event = _squash(ev["e"])
    parts = _EVENT_PARTS.match(event)
    event_kind = stop = None
    if parts:
        event_kind = parts.group(1).lower()
        where = parts.group(2).strip()
        stop = _STOPS.get(where.casefold(), where)
    return ParsedMessage(
        kind, source, carrier, id_number, order_token, recorded_at,
        source_ref_for(kind, id_number, recorded_at, event=event),
        event=event, event_kind=event_kind, stop=stop)


def parse_text(text: str, source: str, *,
               order_token: str | None = None) -> list[ParsedMessage | ParseError]:
    """Every MacroPoint email in `text`. Several emails are numbered
    "<source> #1", "#2", …; text with none is one `not_macropoint` error."""
    text = text.replace("\r\n", "\n").replace("\xa0", " ")
    starts = [m.start() for m in _HEADER.finditer(text)]
    if not starts:
        return [ParseError(source, "not_macropoint")]
    out: list[ParsedMessage | ParseError] = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(text)
        name = source if len(starts) == 1 else f"{source} #{i + 1}"
        out.append(_parse_block(text[start:end], name, order_token))
    return out


def parse_eml(data: bytes, filename: str) -> list[ParsedMessage | ParseError]:
    try:
        msg = email.message_from_bytes(data, policy=policy.default)
        part = msg.get_body(preferencelist=("html", "plain"))
        if part is None:
            return [ParseError(filename, "not_macropoint")]
        content = part.get_content()
        is_html = part.get_content_type() == "text/html"
    except Exception:  # malformed MIME / unknown charset: one bad file never fails the batch
        return [ParseError(filename, "unreadable")]
    if is_html:
        token = _ORDER_TOKEN.search(content)
        return parse_text(html_to_text(content), filename,
                          order_token=token.group(1) if token else None)
    return parse_text(content, filename)


def parse_inputs(files: list[tuple[str, bytes]],
                 text: str) -> list[ParsedMessage | ParseError]:
    """Uploaded files in order, then the pasted text (if any)."""
    out: list[ParsedMessage | ParseError] = []
    for name, data in files:
        out += parse_eml(data, name)
    if text.strip():
        out += parse_text(text, "Pasted text")
    return out
```

`api/src/serversherpa/trucks/macropoint/client.py`:

```python
"""MacroPoint API client: a placeholder until API access is set up.

When it exists, `fetch_updates` will return the same `ParsedMessage`
objects the email parser produces, so `apply.apply_messages` takes API data
unchanged. Nothing calls this yet: no route, setting or UI.
"""

from datetime import datetime

from serversherpa.trucks.macropoint.parse import ParsedMessage


class MacroPointClient:
    def fetch_updates(self, order_token: str,
                      since: datetime | None = None) -> list[ParsedMessage]:
        raise NotImplementedError("MacroPoint API access is not set up yet")
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `… pytest tests/test_macropoint_parse.py -q`, then `.venv/bin/ruff check src/serversherpa/trucks/macropoint tests/test_macropoint_parse.py`
Expected: all PASS; ruff clean (if ruff flags the broad `except Exception`, add `# noqa: BLE001` on that line and nothing else).

- [ ] **Step 6: Commit**

```bash
git add api/tests/fixtures/macropoint api/src/serversherpa/trucks/macropoint api/tests/test_macropoint_parse.py
git commit -m "feat(trucks): MacroPoint email parser, sample fixtures and API client placeholder

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Grouping, matching and the preview endpoint

**Files:**
- Create: `api/src/serversherpa/trucks/macropoint/apply.py`
- Modify: `api/src/serversherpa/api/schemas.py` (append after `TruckFeedPage`), `api/src/serversherpa/api/routes/trucks.py`
- Test: `api/tests/test_macropoint_match.py`, `api/tests/test_macropoint_api.py`

**Interfaces:**
- Consumes: Task 2 `ParsedMessage`, `ParseError`, `normalize_id`, `parse_inputs`; Task 1 `TruckEvent`, `TruckUpdate.source_ref`.
- Produces (module `serversherpa.trucks.macropoint.apply`):
  - constants `ACTIVE_EXCLUDED = ("inactive", "historical")`, `MAX_FILES = 500`, `MAX_FILE_BYTES = 2 * 1024 * 1024`, `MAX_TOTAL_BYTES = 20 * 1024 * 1024`, `MAX_TEXT_BYTES = 1024 * 1024`
  - `@dataclass Group(key: str, id_number: str, order_token: str | None, carrier: str, messages: list[ParsedMessage])`
  - `@dataclass Match(truck_id: uuid.UUID | None, by: str | None, ambiguous_ids: list[uuid.UUID])`
  - `group_messages(messages: list[ParsedMessage]) -> list[Group]`
  - `tracking_value(truck: Truck, key: str) -> str`
  - `match_group(group: Group, trucks: list[Truck]) -> Match`
  - `status_target(status: str, message: ParsedMessage) -> str | None`
  - `async active_trucks(db) -> list[Truck]`
  - `async build_preview(db, files: list[tuple[str, bytes]], text: str) -> dict` (shape = `MacroPointPreviewOut`)
- Produces (schemas): `MacroPointRowOut`, `MacroPointMatchOut`, `MacroPointGroupOut`, `MacroPointErrorOut`, `MacroPointTruckOption`, `MacroPointPreviewOut` (fields below).
- Produces (routes): `POST /trucks/manual-update/macropoint/preview` (multipart `files`, `text`); helper `_macropoint_inputs(request) -> tuple[list[tuple[str, bytes]], str, str | None]` (the third value is the raw `assignments` field, used by Task 4).

Rules (from the spec):
- Group by `order_token` (key `order:<token>`); a token-less message joins the token group whose normalized ID Number equals its own when there is exactly one such group, otherwise it goes to `id:<normalize_id(id_number)>`. Messages inside a group are sorted oldest first `(recorded_at, kind, source)`; groups are sorted by `natural_key(id_number)`.
- Match: (1) exactly one active truck whose `tracking_type.macropoint_order` equals the token → `by="order"`; several → unmatched with `ambiguous_ids`; none → (2) exactly one active truck whose normalized `tracking_type.tracker_id` equals the normalized ID Number → `by="tracker_id"`; several → ambiguous; none → unmatched.
- Preview marks a row `duplicate` when its `source_ref` already exists on the matched truck (updates or events) or appeared earlier in the same group; status preview runs oldest-first from the truck's current status, skipping duplicates.

- [ ] **Step 1: Write the failing pure-logic tests**

`api/tests/test_macropoint_match.py`:

```python
"""MacroPoint grouping, truck matching and the forward-only status rule
(pure functions; no database)."""

import uuid
from datetime import UTC, datetime, timedelta

from serversherpa.db.models import Truck
from serversherpa.trucks.macropoint.apply import (
    group_messages,
    match_group,
    status_target,
)
from serversherpa.trucks.macropoint.parse import ParsedMessage, source_ref_for

T0 = datetime(2024, 10, 15, 14, tzinfo=UTC)


def msg(id_number="Load A", token=None, minutes=0, kind="location", event=None,
        event_kind=None, stop=None, source="a.eml"):
    at = T0 + timedelta(minutes=minutes)
    ref = source_ref_for(kind, id_number, at, lat=1.0, lng=2.0, event=event)
    if kind == "location":
        return ParsedMessage("location", source, "Landstar - ATL", id_number, token, at, ref,
                             lat=1.0, lng=2.0)
    return ParsedMessage("trip_event", source, "Landstar - ATL", id_number, token, at, ref,
                         event=event, event_kind=event_kind, stop=stop)


def truck(name="T", status="active", **tracking):
    return Truck(id=uuid.uuid4(), name=name, status=status, tracking_type=tracking)


def test_group_by_token_and_merge_tokenless_by_id():
    a1 = msg("JAMIE & PATRICK", token="tok1", minutes=5)
    a2 = msg("jamie  &  patrick", token=None, minutes=1)     # pasted: joins tok1
    b = msg("Other Load", token=None)
    [g1, g2] = group_messages([a1, a2, b])
    assert g1.key == "order:tok1" and g1.id_number == "JAMIE & PATRICK"
    assert g1.messages == [a2, a1]                          # oldest first
    assert g2.key == "id:other load" and g2.order_token is None


def test_tokenless_with_two_token_owners_stays_separate():
    t1 = msg("Reused", token="tok1")
    t2 = msg("Reused", token="tok2", minutes=1)
    loose = msg("Reused", minutes=2)
    keys = [g.key for g in group_messages([t1, t2, loose])]
    assert sorted(keys) == ["id:reused", "order:tok1", "order:tok2"]


def test_groups_sorted_naturally_by_id():
    keys = [g.id_number for g in group_messages([msg("Team 10"), msg("Team 9")])]
    assert keys == ["Team 9", "Team 10"]


def test_match_by_order_token_beats_tracker_id():
    by_order = truck("A", macropoint_order="tok1")
    by_id = truck("B", tracker_id="Load A")
    [g] = group_messages([msg("Load A", token="tok1")])
    m = match_group(g, [by_id, by_order])
    assert (m.truck_id, m.by, m.ambiguous_ids) == (by_order.id, "order", [])


def test_match_by_tracker_id_normalized():
    t = truck(tracker_id="  load   a ")
    [g] = group_messages([msg("LOAD A")])
    assert match_group(g, [t]).by == "tracker_id"


def test_ambiguous_and_unmatched():
    t1, t2 = truck("A", tracker_id="Load A"), truck("B", tracker_id="load a")
    [g] = group_messages([msg("Load A")])
    m = match_group(g, [t1, t2])
    assert m.truck_id is None and set(m.ambiguous_ids) == {t1.id, t2.id}
    m = match_group(g, [truck(tracker_id="Something else")])
    assert (m.truck_id, m.by, m.ambiguous_ids) == (None, None, [])


def test_status_target_forward_only():
    dep_pick = msg(kind="trip_event", event="Departed at Pickup", event_kind="departed", stop="pickup")
    arr_drop = msg(kind="trip_event", event="Arrived at Drop-Off", event_kind="arrived", stop="drop_off")
    arr_pick = msg(kind="trip_event", event="Arrived at Pickup", event_kind="arrived", stop="pickup")
    named = msg(kind="trip_event", event="Arrived at BROADCOM", event_kind="arrived", stop="BROADCOM")
    assert status_target("created", dep_pick) == "in_transit"
    assert status_target("active", dep_pick) == "in_transit"
    assert status_target("in_transit", dep_pick) is None
    assert status_target("at_destination", dep_pick) is None
    assert status_target("in_transit", arr_drop) == "at_destination"
    assert status_target("created", arr_drop) == "at_destination"
    assert status_target("at_destination", arr_drop) is None
    assert status_target("active", arr_pick) is None
    assert status_target("in_transit", named) is None
    assert status_target("created", msg()) is None           # locations never change status
```

- [ ] **Step 2: Write the failing preview API tests**

`api/tests/test_macropoint_api.py` (this file grows in Task 4):

```python
"""MacroPoint manual update — preview and apply endpoints."""

import json
from pathlib import Path

from sqlalchemy import func, select

from serversherpa.db.models import Truck, TruckEvent, TruckUpdate
from tests.test_sites_api import login
from tests.test_trucks_api import _staff_without

FIX = Path(__file__).parent / "fixtures" / "macropoint"
PREVIEW = "/trucks/manual-update/macropoint/preview"
APPLY = "/trucks/manual-update/macropoint/apply"
JAMIE_TOKEN = "VM0s7D8QTl5j92QfqQgTmQ__"
JAMIE = ["trip_arrived_pickup.eml", "trip_departed_pickup.eml", "loc_jamie.eml",
         "trip_arrived_dropoff.eml", "trip_departed_dropoff.eml"]


def form(files=(), text=None, assignments=None):
    parts = [("files", (name, (FIX / name).read_bytes(), "message/rfc822")) for name in files]
    if text is not None:
        parts.append(("text", (None, text)))
    if assignments is not None:
        parts.append(("assignments", (None, json.dumps(assignments))))
    return parts


async def _truck(db, name, status="active", **tracking):
    t = Truck(name=name, status=status, tracking_type=tracking)
    db.add(t)
    await db.commit()
    return t


async def test_preview_groups_matches_and_writes_nothing(client, db, seeded_user):
    hdrs = await login(client)
    jp = await _truck(db, "JP Truck", tracker_id="jamie & patrick -nv to palo alto")
    resp = await client.post(PREVIEW, headers=hdrs,
                             files=form([*JAMIE, "loc_landstar_pt.eml", "locus_traxx.eml"]))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    [g1, g2] = body["groups"]
    assert g1["group_key"] == f"order:{JAMIE_TOKEN}"
    assert g1["id_number"] == "JAMIE & PATRICK -NV TO PALO ALTO"
    assert g1["carrier"] == "Landstar - ATL"
    assert g1["match"] == {"truck_id": str(jp.id), "by": "tracker_id", "ambiguous_ids": []}
    assert [r["kind"] for r in g1["rows"]] == [
        "trip_event", "trip_event", "location", "trip_event", "trip_event"]
    assert [r["status_to"] for r in g1["rows"]] == [
        None, "in_transit", None, "at_destination", None]
    assert g1["rows"][1]["status_to_label"] == "In Transit"
    assert g1["rows"][2]["location"] == "35.481693, -119.140353"
    assert (g1["new"], g1["duplicates"]) == (5, 0)
    assert g2["id_number"] == "QR01294949 - CA-NV"
    assert g2["match"]["truck_id"] is None
    assert body["errors"] == [{"source": "locus_traxx.eml", "reason": "not_macropoint"}]
    assert [t["name"] for t in body["trucks"]] == ["JP Truck"]
    assert body["trucks"][0]["status_label"] == "Active"
    assert await db.scalar(select(func.count()).select_from(TruckUpdate)) == 0
    assert await db.scalar(select(func.count()).select_from(TruckEvent)) == 0


async def test_preview_excludes_inactive_historical_archived(client, db, seeded_user):
    from datetime import UTC, datetime
    hdrs = await login(client)
    await _truck(db, "Parked", status="inactive", tracker_id="QR01294949 - CA-NV")
    await _truck(db, "Old", status="historical", tracker_id="QR01294949 - CA-NV")
    gone = await _truck(db, "Gone", tracker_id="QR01294949 - CA-NV")
    gone.archived_at = datetime.now(UTC)
    await db.commit()
    live = await _truck(db, "Live", status="created")
    body = (await client.post(PREVIEW, headers=hdrs, files=form(["loc_landstar_pt.eml"]))).json()
    assert body["groups"][0]["match"]["truck_id"] is None
    assert [t["id"] for t in body["trucks"]] == [str(live.id)]


async def test_cross_format_and_in_batch_duplicates(client, db, seeded_user):
    hdrs = await login(client)
    await _truck(db, "JP", tracker_id="JAMIE & PATRICK -NV TO PALO ALTO")
    pasted = (FIX / "pasted_outlook_two.txt").read_text()
    body = (await client.post(PREVIEW, headers=hdrs, files=form(
        ["loc_jamie.eml", "trip_arrived_pickup.eml"], text=pasted))).json()
    [g] = body["groups"]                                   # pasted rows joined the token group
    assert g["group_key"] == f"order:{JAMIE_TOKEN}"
    assert (g["new"], g["duplicates"]) == (2, 2)
    # Same-minute rows sort by (time, kind, source); "Pasted text #n" sorts
    # before the lowercase file names, so the .eml copies are the repeats.
    assert sorted(r["source"] for r in g["rows"] if r["duplicate"]) == [
        "loc_jamie.eml", "trip_arrived_pickup.eml"]


async def test_preview_requires_trucks_change(client, db, seeded_user):
    await login(client)
    hdrs = await _staff_without(db, client, "trucks", "change", "mp-noperm@test.example.com")
    resp = await client.post(PREVIEW, headers=hdrs, files=form(["loc_jamie.eml"]))
    assert resp.status_code == 403


async def test_input_limits(client, db, seeded_user, monkeypatch):
    from serversherpa.trucks.macropoint import apply as mp
    hdrs = await login(client)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(text="   "))
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "nothing_to_parse"

    monkeypatch.setattr(mp, "MAX_FILES", 2)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(JAMIE[:3]))
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "too_many_files"

    monkeypatch.setattr(mp, "MAX_FILE_BYTES", 100)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(JAMIE[:1]))
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "file_too_large"

    monkeypatch.setattr(mp, "MAX_FILE_BYTES", 2 * 1024 * 1024)
    monkeypatch.setattr(mp, "MAX_TOTAL_BYTES", 3000)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(JAMIE))
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "upload_too_large"

    monkeypatch.setattr(mp, "MAX_TEXT_BYTES", 10)
    resp = await client.post(PREVIEW, headers=hdrs, files=form(text="x" * 11))
    assert resp.status_code == 413
    assert resp.json()["detail"]["code"] == "text_too_large"
```

- [ ] **Step 3: Run to verify both fail**

Run: `… pytest tests/test_macropoint_match.py tests/test_macropoint_api.py -q`
Expected: FAIL — `ModuleNotFoundError: …macropoint.apply`.

- [ ] **Step 4: Add the schemas** (append after `class TruckFeedPage` in `schemas.py`)

```python
# ── MacroPoint manual update ─────────────────────────────────────────

class MacroPointRowOut(BaseModel):
    source: str
    kind: Literal["location", "trip_event"]
    recorded_at: datetime
    location: str | None = None
    address: str = ""
    event: str | None = None
    status_to: str | None = None
    status_to_label: str | None = None
    duplicate: bool = False


class MacroPointMatchOut(BaseModel):
    truck_id: uuid.UUID | None = None
    by: Literal["order", "tracker_id"] | None = None
    ambiguous_ids: list[uuid.UUID] = []


class MacroPointGroupOut(BaseModel):
    group_key: str
    id_number: str
    order_token: str | None = None
    carrier: str
    match: MacroPointMatchOut
    rows: list[MacroPointRowOut]
    new: int
    duplicates: int


class MacroPointErrorOut(BaseModel):
    source: str
    reason: str


class MacroPointTruckOption(BaseModel):
    id: uuid.UUID
    name: str
    status: str
    status_label: str
    tracker_id: str | None = None
    initiative_name: str | None = None


class MacroPointPreviewOut(BaseModel):
    groups: list[MacroPointGroupOut]
    errors: list[MacroPointErrorOut]
    trucks: list[MacroPointTruckOption]
```

- [ ] **Step 5: Implement `apply.py` (grouping, matching, preview)**

```python
"""MacroPoint manual update — group parsed emails by load, match each load
to an active truck, build the preview, and apply it (Task 4 adds the apply
half). Parsing is in parse.py; this module owns the database side.

Active trucks are the only match candidates and the only picker options:
not archived and not inactive/historical. A load matches (1) the one
active truck whose tracking_type.macropoint_order is the load's order
token, else (2) the one whose tracking_type.tracker_id equals the ID Number
(whitespace/case-insensitive). Several candidates at a step = ambiguous.
"""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, StatusValue, Truck, TruckEvent, TruckUpdate
from serversherpa.db.ordering import natural, natural_key
from serversherpa.trucks.location import format_location
from serversherpa.trucks.macropoint.parse import (
    ParsedMessage,
    ParseError,
    normalize_id,
    parse_inputs,
)

ACTIVE_EXCLUDED = ("inactive", "historical")
DEPART_FROM = frozenset({"created", "active"})
ARRIVE_FROM = frozenset({"created", "active", "in_transit"})

MAX_FILES = 500
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 20 * 1024 * 1024
MAX_TEXT_BYTES = 1024 * 1024


@dataclass
class Group:
    key: str
    id_number: str
    order_token: str | None
    carrier: str
    messages: list[ParsedMessage] = field(default_factory=list)


@dataclass
class Match:
    truck_id: uuid.UUID | None
    by: str | None
    ambiguous_ids: list[uuid.UUID]


def group_messages(messages: list[ParsedMessage]) -> list[Group]:
    by_token: dict[str, Group] = {}
    loose: list[ParsedMessage] = []
    for m in messages:
        if m.order_token:
            g = by_token.get(m.order_token)
            if g is None:
                g = by_token[m.order_token] = Group(
                    f"order:{m.order_token}", m.id_number, m.order_token, m.carrier)
            g.messages.append(m)
        else:
            loose.append(m)
    owners: dict[str, list[Group]] = {}
    for g in by_token.values():
        owners.setdefault(normalize_id(g.id_number), []).append(g)
    by_id: dict[str, Group] = {}
    for m in loose:
        nid = normalize_id(m.id_number)
        found = owners.get(nid, [])
        if len(found) == 1:
            found[0].messages.append(m)
            continue
        g = by_id.get(nid)
        if g is None:
            g = by_id[nid] = Group(f"id:{nid}", m.id_number, None, m.carrier)
        g.messages.append(m)
    groups = [*by_token.values(), *by_id.values()]
    for g in groups:
        g.messages.sort(key=lambda m: (m.recorded_at, m.kind, m.source))
    groups.sort(key=lambda g: (natural_key(g.id_number), g.key))
    return groups


def tracking_value(truck: Truck, key: str) -> str:
    value = (truck.tracking_type or {}).get(key)
    return value.strip() if isinstance(value, str) else ""


def match_group(group: Group, trucks: list[Truck]) -> Match:
    if group.order_token:
        hits = [t for t in trucks if tracking_value(t, "macropoint_order") == group.order_token]
        if len(hits) == 1:
            return Match(hits[0].id, "order", [])
        if hits:
            return Match(None, None, [t.id for t in hits])
    nid = normalize_id(group.id_number)
    hits = [t for t in trucks
            if tracking_value(t, "tracker_id")
            and normalize_id(tracking_value(t, "tracker_id")) == nid]
    if len(hits) == 1:
        return Match(hits[0].id, "tracker_id", [])
    return Match(None, None, [t.id for t in hits])


def status_target(status: str, message: ParsedMessage) -> str | None:
    """The status a trip event moves the truck to, or None. Forward only."""
    if message.kind != "trip_event":
        return None
    if message.event_kind == "departed" and message.stop == "pickup" and status in DEPART_FROM:
        return "in_transit"
    if message.event_kind == "arrived" and message.stop == "drop_off" and status in ARRIVE_FROM:
        return "at_destination"
    return None


async def active_trucks(db: AsyncSession) -> list[Truck]:
    return list(await db.scalars(
        select(Truck).where(Truck.archived_at.is_(None),
                            Truck.status.not_in(ACTIVE_EXCLUDED))
        .order_by(natural(Truck.name))))


async def _status_labels(db: AsyncSession) -> dict[str, str]:
    rows = await db.execute(select(StatusValue.key, StatusValue.label)
                            .where(StatusValue.record_type == "truck"))
    return dict(rows.all())


async def existing_refs(db: AsyncSession, truck_id: uuid.UUID, refs: list[str]) -> set[str]:
    if not refs:
        return set()
    updates = await db.scalars(select(TruckUpdate.source_ref).where(
        TruckUpdate.truck_id == truck_id, TruckUpdate.source_ref.in_(refs)))
    events = await db.scalars(select(TruckEvent.source_ref).where(
        TruckEvent.truck_id == truck_id, TruckEvent.source_ref.in_(refs)))
    return set(updates) | set(events)


def row_location(m: ParsedMessage) -> str | None:
    return format_location(m.lat, m.lng) if m.kind == "location" else None


async def _truck_options(db: AsyncSession, trucks: list[Truck],
                         labels: dict[str, str]) -> list[dict]:
    ini_ids = {t.initiative_id for t in trucks if t.initiative_id}
    names: dict = {}
    if ini_ids:
        names = dict((await db.execute(select(Initiative.id, Initiative.name)
                                       .where(Initiative.id.in_(ini_ids)))).all())
    return [{"id": t.id, "name": t.name, "status": t.status,
             "status_label": labels.get(t.status, t.status),
             "tracker_id": tracking_value(t, "tracker_id") or None,
             "initiative_name": names.get(t.initiative_id)} for t in trucks]


async def build_preview(db: AsyncSession, files: list[tuple[str, bytes]], text: str) -> dict:
    parsed = parse_inputs(files, text)
    messages = [p for p in parsed if isinstance(p, ParsedMessage)]
    errors = [p for p in parsed if isinstance(p, ParseError)]
    trucks = await active_trucks(db)
    by_id = {t.id: t for t in trucks}
    labels = await _status_labels(db)
    groups = []
    for g in group_messages(messages):
        match = match_group(g, trucks)
        truck = by_id.get(match.truck_id) if match.truck_id else None
        seen = (await existing_refs(db, truck.id, [m.source_ref for m in g.messages])
                if truck else set())
        status = truck.status if truck else None
        rows = []
        for m in g.messages:
            duplicate = m.source_ref in seen
            seen.add(m.source_ref)
            to = status_target(status, m) if truck and not duplicate else None
            if to:
                status = to
            rows.append({"source": m.source, "kind": m.kind, "recorded_at": m.recorded_at,
                         "location": row_location(m), "address": m.address,
                         "event": m.event, "status_to": to,
                         "status_to_label": labels.get(to, to) if to else None,
                         "duplicate": duplicate})
        dupes = sum(1 for r in rows if r["duplicate"])
        groups.append({"group_key": g.key, "id_number": g.id_number,
                       "order_token": g.order_token, "carrier": g.carrier,
                       "match": {"truck_id": match.truck_id, "by": match.by,
                                 "ambiguous_ids": match.ambiguous_ids},
                       "rows": rows, "new": len(rows) - dupes, "duplicates": dupes})
    return {"groups": groups,
            "errors": [{"source": e.source, "reason": e.reason} for e in errors],
            "trucks": await _truck_options(db, trucks, labels)}
```

- [ ] **Step 6: Add the route and the input reader** in `routes/trucks.py`

Imports to add: `from starlette.exceptions import HTTPException as StarletteHTTPException`, `MacroPointPreviewOut` in the schemas import, `from serversherpa.trucks.macropoint import apply as mp`.

Place this block directly after the `trucks_feed` route (before any `/{truck_id}` route):

```python
async def _macropoint_inputs(request: Request) -> tuple[list[tuple[str, bytes]], str, str | None]:
    """The multipart body of the MacroPoint routes: `files` (0..n .eml),
    `text` (pasted email text) and, for apply, `assignments` (JSON)."""
    if not request.headers.get("content-type", "").startswith("multipart/"):
        raise _err(422, "multipart_required")
    try:
        form = await request.form(max_files=mp.MAX_FILES + 1, max_fields=10,
                                  max_part_size=mp.MAX_TEXT_BYTES + 1024)
    except StarletteHTTPException:
        raise _err(413, "upload_too_large") from None
    uploads = [u for u in form.getlist("files") if not isinstance(u, str)]
    if len(uploads) > mp.MAX_FILES:
        raise _err(413, "too_many_files", limit=mp.MAX_FILES)
    files: list[tuple[str, bytes]] = []
    total = 0
    for upload in uploads:
        data = await upload.read(mp.MAX_FILE_BYTES + 1)
        if len(data) > mp.MAX_FILE_BYTES:
            raise _err(413, "file_too_large", file=upload.filename, limit=mp.MAX_FILE_BYTES)
        total += len(data)
        if total > mp.MAX_TOTAL_BYTES:
            raise _err(413, "upload_too_large", limit=mp.MAX_TOTAL_BYTES)
        files.append((upload.filename or "upload.eml", data))
    text = form.get("text") or ""
    if not isinstance(text, str):
        raise _err(422, "bad_text")
    if len(text.encode("utf-8")) > mp.MAX_TEXT_BYTES:
        raise _err(413, "text_too_large", limit=mp.MAX_TEXT_BYTES)
    if not files and not text.strip():
        raise _err(422, "nothing_to_parse")
    raw = form.get("assignments")
    return files, text, raw if isinstance(raw, str) else None


@router.post("/manual-update/macropoint/preview", response_model=MacroPointPreviewOut)
async def macropoint_preview(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "change"),
) -> dict:
    """Parse MacroPoint emails and show what applying would do. Writes nothing."""
    files, text, _ = await _macropoint_inputs(request)
    return await mp.build_preview(db, files, text)
```

- [ ] **Step 7: Run the tests**

Run: `… pytest tests/test_macropoint_match.py tests/test_macropoint_api.py -q`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add api/src/serversherpa/trucks/macropoint/apply.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/trucks.py api/tests/test_macropoint_match.py api/tests/test_macropoint_api.py
git commit -m "feat(trucks): MacroPoint preview — group by load, match active trucks, dedup preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Apply endpoint

**Files:**
- Modify: `api/src/serversherpa/trucks/macropoint/apply.py`, `api/src/serversherpa/api/schemas.py`, `api/src/serversherpa/api/routes/trucks.py`
- Test: `api/tests/test_macropoint_api.py` (append)

**Interfaces:**
- Consumes: Task 3 `group_messages`, `match_group` (not used here), `status_target`, `existing_refs`, `row_location`, `tracking_value`, `ACTIVE_EXCLUDED`, `_status_labels`, `_macropoint_inputs`; `trucks.trip.apply_status_change`; `services.audit.audit`.
- Produces:
  - `async apply_updates(db, actor_id: uuid.UUID, files, text, assignments: dict[str, uuid.UUID | None]) -> dict` (shape = `MacroPointApplyOut`), which calls `async apply_messages(db, actor_id, messages, errors, assignments) -> dict` (the seam the future API client will use).
  - Schemas `MacroPointResultRow`, `MacroPointApplyOut`.
  - Route `POST /trucks/manual-update/macropoint/apply` (multipart `files`, `text`, `assignments` = JSON object `{group_key: truck_id | null}`); `422 bad_assignments` for malformed JSON.
- Audit rows written: status change → action `update`, `changes={"status": {"from": old, "to": new}, "source": {"from": None, "to": "MacroPoint"}}`; learned link → action `update`, `changes={"tracking_type": {"from": old_dict, "to": new_dict}}`; one per truck per apply → action `macropoint_update`, `changes={"updates": {"from": None, "to": "<n> locations, <m> trip events"}}`.

- [ ] **Step 1: Write the failing tests** (append to `test_macropoint_api.py`)

```python
from datetime import UTC, datetime

from serversherpa.db.models import AuditLog


async def _apply(client, hdrs, files=(), text=None, assignments=None):
    resp = await client.post(APPLY, headers=hdrs,
                             files=form(files, text=text, assignments=assignments or {}))
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_apply_writes_learns_link_and_moves_status(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Unlinked", status="created")
    out = await _apply(client, hdrs, JAMIE, assignments={f"order:{JAMIE_TOKEN}": str(t.id)})
    assert (out["added"], out["duplicates"], out["skipped"], out["errors"],
            out["status_changes"]) == (5, 0, 0, 0, 2)
    assert [r["result"] for r in out["rows"]] == ["added"] * 5
    assert out["rows"][1]["status_change"] == "Created → In Transit"
    assert out["rows"][3]["status_change"] == "In Transit → At Destination"
    assert out["rows"][0]["truck_name"] == "Unlinked"

    await db.refresh(t)
    assert t.status == "at_destination"
    assert t.trip_started_at == datetime(2024, 10, 15, 15, 11, tzinfo=UTC)  # the departed time
    assert t.tracking_type == {"macropoint_order": JAMIE_TOKEN,
                               "tracker_id": "JAMIE & PATRICK -NV TO PALO ALTO",
                               "type": "MacroPoint"}
    [loc] = (await db.scalars(select(TruckUpdate).where(TruckUpdate.truck_id == t.id))).all()
    assert loc.source == "macropoint" and loc.source_ref
    assert loc.approximate_address == "CA-99 Bakersfield CA 93308 United States"
    events = (await db.scalars(select(TruckEvent).where(TruckEvent.truck_id == t.id)
                               .order_by(TruckEvent.recorded_at))).all()
    assert [e.event for e in events] == ["Arrived at Pickup", "Departed at Pickup",
                                         "Arrived at Drop-Off", "Departed at Drop-Off"]
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(t.id)).order_by(AuditLog.at))).all()
    # one transaction = one `at`, so compare as a sorted list, not by order
    statuses = [a.changes["status"]["to"] for a in audits if "status" in (a.changes or {})]
    assert sorted(statuses) == ["at_destination", "in_transit"]
    assert all(a.changes["source"] == {"from": None, "to": "MacroPoint"}
               for a in audits if "status" in (a.changes or {}))
    assert any(a.action == "macropoint_update" for a in audits)

    # The learned token now matches the next upload by itself.
    body = (await client.post(PREVIEW, headers=hdrs, files=form(["loc_jamie.eml"]))).json()
    assert body["groups"][0]["match"]["by"] == "order"


async def test_reapply_is_all_duplicate_and_survives_many_conflicts(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Busy")
    files = [*JAMIE, "loc_heavy_whitespace.eml", "loc_landstar_pt.eml", "loc_landstar_et_slash.eml"]
    groups = (await client.post(PREVIEW, headers=hdrs, files=form(files))).json()["groups"]
    assign = {g["group_key"]: str(t.id) for g in groups}
    first = await _apply(client, hdrs, files, assignments=assign)
    assert first["added"] == 8
    for _ in range(2):                                     # > 5 ON CONFLICT runs per session
        again = await _apply(client, hdrs, files, assignments=assign)
        assert (again["added"], again["duplicates"], again["status_changes"]) == (0, 8, 0)
    assert await db.scalar(select(func.count()).select_from(TruckUpdate)) == 4


async def test_status_is_forward_only(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Done", status="at_destination")
    out = await _apply(client, hdrs, ["trip_departed_pickup.eml"],
                       assignments={f"order:{JAMIE_TOKEN}": str(t.id)})
    assert out["rows"][0]["result"] == "added"
    assert out["rows"][0]["status_change"] is None
    await db.refresh(t)
    assert t.status == "at_destination"


async def test_learn_link_fills_blanks_only(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Linked", tracker_id="My name", macropoint_order="other-token",
                     type="Landstar", update_type="email")
    out = await _apply(client, hdrs, ["loc_jamie.eml"],
                       assignments={f"order:{JAMIE_TOKEN}": str(t.id)})
    assert out["rows"][0]["result"] == "added"
    assert out["rows"][0]["note"] == "linked_to_other_order"
    await db.refresh(t)
    assert t.tracking_type == {"tracker_id": "My name", "macropoint_order": "other-token",
                               "type": "Landstar", "update_type": "email"}


async def test_skip_and_inactive_truck(client, db, seeded_user):
    hdrs = await login(client)
    parked = await _truck(db, "Parked", status="inactive")
    out = await _apply(client, hdrs, ["loc_jamie.eml", "loc_landstar_pt.eml", "locus_traxx.eml"],
                       assignments={f"order:{JAMIE_TOKEN}": str(parked.id),
                                    "order:Dk4ScKJ-t64u-XiTR8UdjQ__": None})
    by_source = {r["source"]: r for r in out["rows"]}
    assert by_source["loc_jamie.eml"]["result"] == "error"
    assert by_source["loc_jamie.eml"]["reason"] == "truck_not_active"
    assert by_source["loc_landstar_pt.eml"]["result"] == "skipped"
    assert by_source["locus_traxx.eml"] == {**by_source["locus_traxx.eml"],
                                            "result": "error", "reason": "not_macropoint"}
    assert (out["added"], out["skipped"], out["errors"]) == (0, 1, 2)
    assert await db.scalar(select(func.count()).select_from(TruckUpdate)) == 0


async def test_cross_format_apply_dedups(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "JP2")
    key = {f"order:{JAMIE_TOKEN}": str(t.id)}
    await _apply(client, hdrs, ["loc_jamie.eml", "trip_arrived_pickup.eml"], assignments=key)
    out = await _apply(client, hdrs, text=(FIX / "pasted_outlook_two.txt").read_text(),
                       assignments={"id:jamie & patrick -nv to palo alto": str(t.id)})
    assert [r["result"] for r in out["rows"]] == ["duplicate", "duplicate"]


async def test_apply_bad_assignments_and_permission(client, db, seeded_user):
    hdrs = await login(client)
    parts = form(["loc_jamie.eml"])
    parts.append(("assignments", (None, "{not json")))
    resp = await client.post(APPLY, headers=hdrs, files=parts)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "bad_assignments"
    parts = form(["loc_jamie.eml"], assignments={"k": "not-a-uuid"})
    assert (await client.post(APPLY, headers=hdrs, files=parts)).status_code == 422
    nope = await _staff_without(db, client, "trucks", "change", "mp-noapply@test.example.com")
    assert (await client.post(APPLY, headers=nope, files=form(["loc_jamie.eml"]))).status_code == 403
```

- [ ] **Step 2: Run to verify they fail**

Run: `… pytest tests/test_macropoint_api.py -q`
Expected: the new tests FAIL with 405/404 (no apply route).

- [ ] **Step 3: Add the schemas** (after `MacroPointPreviewOut`)

```python
class MacroPointResultRow(BaseModel):
    row: int
    source: str
    group_key: str | None = None
    id_number: str | None = None
    truck_id: uuid.UUID | None = None
    truck_name: str | None = None
    kind: Literal["location", "trip_event"] | None = None
    recorded_at: datetime | None = None
    detail: str = ""
    result: Literal["added", "duplicate", "skipped", "error"]
    status_change: str | None = None
    reason: str | None = None
    note: str | None = None


class MacroPointApplyOut(BaseModel):
    added: int
    duplicates: int
    skipped: int
    errors: int
    status_changes: int
    rows: list[MacroPointResultRow]
```

- [ ] **Step 4: Implement apply** (append to `apply.py`; add imports `from datetime import UTC, datetime`, `from sqlalchemy.dialects.postgresql import insert as pg_insert`, `from serversherpa.services.audit import audit`, `from serversherpa.trucks.trip import apply_status_change`)

```python
def _detail(m: ParsedMessage) -> str:
    if m.kind == "location":
        loc = row_location(m)
        return f"{loc} · {m.address}" if m.address else loc
    return m.event or ""


async def _insert(db: AsyncSession, truck: Truck, m: ParsedMessage,
                  actor_id: uuid.UUID) -> bool:
    """Insert one update/event; False when the truck already has it."""
    if m.kind == "location":
        stmt = pg_insert(TruckUpdate).values(
            truck_id=truck.id, recorded_at=m.recorded_at, location=row_location(m),
            lat=m.lat, lng=m.lng, approximate_address=m.address,
            source="macropoint", source_ref=m.source_ref,
        ).on_conflict_do_nothing(constraint="uq_truck_updates_truck_source_ref"
                                 ).returning(TruckUpdate.id)
    else:
        stmt = pg_insert(TruckEvent).values(
            truck_id=truck.id, recorded_at=m.recorded_at, event=m.event,
            event_kind=m.event_kind, stop=m.stop, source="macropoint",
            source_ref=m.source_ref, created_by=actor_id,
        ).on_conflict_do_nothing(constraint="uq_truck_events_truck_source_ref"
                                 ).returning(TruckEvent.id)
    return (await db.execute(stmt)).scalar_one_or_none() is not None


def _learn_link(db: AsyncSession, actor_id: uuid.UUID, truck: Truck,
                group: Group) -> str | None:
    """Fill the truck's blank tracking keys from the load; never overwrite.
    Returns "linked_to_other_order" when the truck holds another token."""
    current = dict(truck.tracking_type or {})
    new = dict(current)
    note = None
    have = tracking_value(truck, "macropoint_order")
    if group.order_token:
        if not have:
            new["macropoint_order"] = group.order_token
        elif have != group.order_token:
            note = "linked_to_other_order"
    if not tracking_value(truck, "tracker_id"):
        new["tracker_id"] = group.id_number
    if not tracking_value(truck, "type"):
        new["type"] = "MacroPoint"
    if new != current:
        truck.tracking_type = new               # a new dict, so the JSONB change persists
        truck.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor_id, entity_type="truck", entity_id=str(truck.id),
              action="update", changes={"tracking_type": {"from": current, "to": new}})
    return note


async def apply_messages(db: AsyncSession, actor_id: uuid.UUID,
                         messages: list[ParsedMessage], errors: list[ParseError],
                         assignments: dict[str, uuid.UUID | None]) -> dict:
    """Write the assigned loads in one transaction. Loads left unassigned are
    `skipped`; a truck that is no longer active makes its rows `error`."""
    groups = group_messages(messages)
    wanted = {tid for tid in assignments.values() if tid}
    trucks = {t.id: t for t in await db.scalars(
        select(Truck).where(Truck.id.in_(wanted)).with_for_update())} if wanted else {}
    labels = await _status_labels(db)
    rows: list[dict] = []

    def add(**kw) -> None:
        rows.append({"row": len(rows) + 1, "group_key": None, "id_number": None,
                     "truck_id": None, "truck_name": None, "kind": None,
                     "recorded_at": None, "detail": "", "status_change": None,
                     "reason": None, "note": None, **kw})

    for g in groups:
        base = {"group_key": g.key, "id_number": g.id_number}
        truck_id = assignments.get(g.key)
        truck = trucks.get(truck_id) if truck_id else None
        if truck_id is None:
            for m in g.messages:
                add(**base, source=m.source, kind=m.kind, recorded_at=m.recorded_at,
                    detail=_detail(m), result="skipped", reason="no_truck")
            continue
        if truck is None or truck.archived_at is not None or truck.status in ACTIVE_EXCLUDED:
            for m in g.messages:
                add(**base, source=m.source, kind=m.kind, recorded_at=m.recorded_at,
                    detail=_detail(m), result="error", reason="truck_not_active")
            continue
        base |= {"truck_id": truck.id, "truck_name": truck.name}
        note = _learn_link(db, actor_id, truck, g)
        counts = {"location": 0, "trip_event": 0}
        for m in g.messages:
            row = {**base, "source": m.source, "kind": m.kind,
                   "recorded_at": m.recorded_at, "detail": _detail(m), "note": note}
            if not await _insert(db, truck, m, actor_id):
                add(**row, result="duplicate")
                continue
            counts[m.kind] += 1
            to = status_target(truck.status, m)
            if to:
                old = truck.status
                apply_status_change(truck, to, now=m.recorded_at)
                truck.updated_at = datetime.now(UTC)
                audit(db, actor_id=actor_id, entity_type="truck", entity_id=str(truck.id),
                      action="update", changes={
                          "status": {"from": old, "to": to},
                          "source": {"from": None, "to": "MacroPoint"}})
                row["status_change"] = f"{labels.get(old, old)} → {labels.get(to, to)}"
            add(**row, result="added")
        if counts["location"] or counts["trip_event"]:
            audit(db, actor_id=actor_id, entity_type="truck", entity_id=str(truck.id),
                  action="macropoint_update", changes={"updates": {
                      "from": None,
                      "to": f"{counts['location']} locations, "
                            f"{counts['trip_event']} trip events"}})

    for e in errors:
        add(source=e.source, result="error", reason=e.reason)
    await db.commit()

    def count(result: str) -> int:
        return sum(1 for r in rows if r["result"] == result)

    return {"added": count("added"), "duplicates": count("duplicate"),
            "skipped": count("skipped"), "errors": count("error"),
            "status_changes": sum(1 for r in rows if r["status_change"]), "rows": rows}


async def apply_updates(db: AsyncSession, actor_id: uuid.UUID,
                        files: list[tuple[str, bytes]], text: str,
                        assignments: dict[str, uuid.UUID | None]) -> dict:
    """Re-parse the same input the preview saw (parsing is deterministic) and
    apply it; the client never sends parsed rows."""
    parsed = parse_inputs(files, text)
    return await apply_messages(
        db, actor_id,
        [p for p in parsed if isinstance(p, ParsedMessage)],
        [p for p in parsed if isinstance(p, ParseError)],
        assignments)
```

- [ ] **Step 5: Add the route** (in `routes/trucks.py`, right after `macropoint_preview`; add `import json` and `MacroPointApplyOut` to the imports)

```python
def _assignments(raw: str | None) -> dict[str, uuid.UUID | None]:
    try:
        data = json.loads(raw) if raw else {}
        if not isinstance(data, dict):
            raise ValueError
        return {str(k): (uuid.UUID(v) if v else None) for k, v in data.items()}
    except (ValueError, TypeError, AttributeError):
        raise _err(422, "bad_assignments") from None


@router.post("/manual-update/macropoint/apply", response_model=MacroPointApplyOut)
async def macropoint_apply(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "change"),
) -> dict:
    """Apply MacroPoint emails: the same files/text as the preview plus
    `assignments` = {group_key: truck_id | null}. One transaction."""
    files, text, raw = await _macropoint_inputs(request)
    assignments = _assignments(raw)
    return await mp.apply_updates(db, actor.person.id, files, text, assignments)
```

- [ ] **Step 6: Run the tests**

Run: `… pytest tests/test_macropoint_api.py tests/test_macropoint_match.py tests/test_macropoint_parse.py tests/test_trucks_api.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/trucks/macropoint/apply.py api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/trucks.py api/tests/test_macropoint_api.py
git commit -m "feat(trucks): MacroPoint apply — dedup inserts, learned link, forward-only status

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Truck events endpoint, clear, and the Shipments feed

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (`TruckEventOut`; `TruckFeedEvent`), `api/src/serversherpa/api/routes/trucks.py`, `api/src/serversherpa/trucks/feed.py`
- Test: `api/tests/test_truck_events_api.py` (create), `api/tests/test_trucks_feed.py` (append)

**Interfaces:**
- Consumes: Task 1 `TruckEvent`.
- Produces: `GET /trucks/{truck_id}/events -> list[TruckEventOut]` (`id, truck_id, recorded_at, event, event_kind, stop, source`), newest first, `trucks:view`. `DELETE /trucks/{id}/updates` also deletes the truck's `truck_events`. Feed events: new `kind="trip"` with `event` (text) and `source`; id `trip:<uuid>`. Status events carry `via` = the audit's `changes.source.to` when present (e.g. `"MacroPoint"`). `TruckFeedEvent.kind` Literal gains `"trip"`; `via` Literal gains `"MacroPoint"`; new field `event: str | None = None`.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_truck_events_api.py`:

```python
"""GET /trucks/{id}/events and Clear updates clearing trip events."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select

from serversherpa.db.models import Truck, TruckEvent
from tests.test_sites_api import login

T0 = datetime(2026, 5, 1, 12, tzinfo=UTC)


async def test_list_newest_first_and_clear(client, db, seeded_user):
    hdrs = await login(client)
    t = Truck(name="Eventful")
    db.add(t)
    await db.flush()
    db.add_all([
        TruckEvent(truck_id=t.id, recorded_at=T0, event="Arrived at Pickup",
                   event_kind="arrived", stop="pickup", source="macropoint", source_ref="a"),
        TruckEvent(truck_id=t.id, recorded_at=T0 + timedelta(hours=1),
                   event="Departed at Pickup", event_kind="departed", stop="pickup",
                   source="macropoint", source_ref="b"),
    ])
    await db.commit()

    resp = await client.get(f"/trucks/{t.id}/events", headers=hdrs)
    assert resp.status_code == 200, resp.text
    assert [e["event"] for e in resp.json()] == ["Departed at Pickup", "Arrived at Pickup"]
    assert resp.json()[0]["stop"] == "pickup"

    assert (await client.delete(f"/trucks/{t.id}/updates", headers=hdrs)).status_code == 204
    assert await db.scalar(select(func.count()).select_from(TruckEvent)) == 0


async def test_events_404_for_unknown_truck(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.get("/trucks/00000000-0000-0000-0000-000000000000/events", headers=hdrs)
    assert resp.status_code == 404
```

Append to `api/tests/test_trucks_feed.py` (it already defines `at`, `_truck`, `_loc`, `_audit`, `login`; add `TruckEvent` to its models import):

```python
async def test_trip_events_and_macropoint_status_via(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Tripper")
    db.add(TruckEvent(truck_id=t.id, recorded_at=at(2), event="Departed at Pickup",
                      event_kind="departed", stop="pickup", source="macropoint"))
    _loc(db, t, 1)
    _audit(db, t.id, 3, "update", {"status": {"from": "active", "to": "in_transit"},
                                   "source": {"from": None, "to": "MacroPoint"}})
    await db.commit()
    events = (await client.get("/trucks/feed", headers=hdrs)).json()["events"]
    assert [e["kind"] for e in events] == ["status", "trip", "location"]
    assert events[0]["via"] == "MacroPoint"
    trip = events[1]
    assert trip["id"].startswith("trip:")
    assert (trip["event"], trip["source"]) == ("Departed at Pickup", "macropoint")


async def test_trip_events_page_with_the_cursor(client, db, seeded_user):
    hdrs = await login(client)
    t = await _truck(db, "Pager")
    for m in range(5):
        db.add(TruckEvent(truck_id=t.id, recorded_at=at(m), event=f"Arrived at Stop {m}",
                          source="macropoint"))
    await db.commit()
    first = (await client.get("/trucks/feed?limit=2", headers=hdrs)).json()
    assert [e["event"] for e in first["events"]] == ["Arrived at Stop 4", "Arrived at Stop 3"]
    nxt = first["next_before"]
    from urllib.parse import quote
    second = (await client.get(f"/trucks/feed?limit=2&before={quote(nxt)}", headers=hdrs)).json()
    assert [e["event"] for e in second["events"]] == ["Arrived at Stop 2", "Arrived at Stop 1"]
```

(If `test_trucks_feed.py` already imports `quote`, drop the local import.)

- [ ] **Step 2: Run to verify they fail**

Run: `… pytest tests/test_truck_events_api.py tests/test_trucks_feed.py -q`
Expected: FAIL (404 on `/events`, feed has no `trip` kind).

- [ ] **Step 3: Schemas**

```python
class TruckEventOut(BaseModel):
    id: uuid.UUID
    truck_id: uuid.UUID
    recorded_at: datetime
    event: str
    event_kind: str | None = None
    stop: str | None = None
    source: str = "manual"
```

In `TruckFeedEvent`: update the docstring to mention `trip (event/source)`, change `kind: Literal["location", "status", "load", "unload", "trip"]`, change `via: Literal["kiosk", "portal", "import", "MacroPoint"] | None = None`, and add under the location group:

```python
    # trip
    event: str | None = None
```

- [ ] **Step 4: Routes** (`routes/trucks.py`; add `TruckEvent` to the models import and `TruckEventOut` to the schemas import)

Add after `list_truck_updates`:

```python
@router.get("/{truck_id}/events", response_model=list[TruckEventOut])
async def list_truck_events(
    truck_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "view"),
) -> list[TruckEventOut]:
    """Trip events (e.g. MacroPoint Arrived/Departed), newest first."""
    await _get_truck(db, truck_id)
    rows = await db.scalars(
        select(TruckEvent).where(TruckEvent.truck_id == truck_id)
        .order_by(TruckEvent.recorded_at.desc()))
    return [TruckEventOut.model_validate(e, from_attributes=True) for e in rows]
```

In `clear_truck_updates`, after the `TruckUpdate` delete:

```python
    await db.execute(delete(TruckEvent).where(TruckEvent.truck_id == truck_id))
```

- [ ] **Step 5: Feed** (`trucks/feed.py`)

Add `TruckEvent` to the models import and to the module docstring's sources list:

```
  * `truck_events`             -> `trip` events (id `trip:<uuid>`)
```

Add next to `_location_rows`:

```python
async def _trip_rows(db: AsyncSession, limit: int, cursor, initiative_id):
    key = func.concat("trip:", cast(TruckEvent.id, String)).collate("C")
    query = (select(TruckEvent, Truck.name, Truck.load_number,
                    Truck.initiative_id, Initiative.name)
             .join(Truck, Truck.id == TruckEvent.truck_id)
             .outerjoin(Initiative, Initiative.id == Truck.initiative_id))
    if initiative_id is not None:
        query = query.where(Truck.initiative_id == initiative_id)
    if cursor is not None:
        query = query.where(_older_than(TruckEvent.recorded_at, key, cursor, audit=False))
    return (await db.execute(
        query.order_by(TruckEvent.recorded_at.desc(), key.desc()).limit(limit + 1)
    )).all()
```

In `_status_event`, add `via` to the returned dict:

```python
    source = row.changes.get("source")
    via = source.get("to") if isinstance(source, dict) else None
    return {**base, "id": f"audit:{row.id}:status", "kind": "status", "via": via,
            "from_status": old, ...}   # rest of the dict unchanged
```

In `build_feed`: read the third source and give it its own watermark, then emit events:

```python
    trip_rows = await _trip_rows(db, limit, cursor, initiative_id)
    ...
    if len(trip_rows) > limit:
        trip_rows = trip_rows[:limit]
        last = trip_rows[-1][0]
        watermarks.append((last.recorded_at, f"trip:{last.id}"))
    ...
    for e, name, load_number, init_id, init_name in trip_rows:
        events.append({
            **_truck_fields(e.truck_id, name, load_number, init_id, init_name),
            "id": f"trip:{e.id}", "at": e.recorded_at, "kind": "trip",
            "event": e.event, "source": e.source})
```

(Put the `trip_rows` read next to `loc_rows`/`audit_rows`, the watermark block next to the other two, and the event loop right after the location loop. Trip events have no actor; `actor_of` lookups default to `None`.)

- [ ] **Step 6: Run the tests**

Run: `… pytest tests/test_truck_events_api.py tests/test_trucks_feed.py tests/test_trucks_api.py tests/test_macropoint_api.py -q`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/trucks.py api/src/serversherpa/trucks/feed.py api/tests/test_truck_events_api.py api/tests/test_trucks_feed.py
git commit -m "feat(trucks): trip events endpoint, Clear clears them, trip events and MacroPoint via in the feed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Run the FULL API suite** (foreground, timeout 600000; ~20 min — if the tool times out, re-run the remaining files rather than backgrounding)

Run: `… pytest -q -x -p no:cacheprovider 2>&1 | tail -15`
Expected: all pass except the known WeasyPrint environment failures (if any appear, confirm they also fail on `main`). Fix any regression (e.g. tests pinning `TruckFeedEvent` kinds) before moving on.

---

### Task 6: Portal API client and pure helpers

**Files:**
- Modify: `portal/src/lib/api.ts`
- Create: `portal/src/lib/macropoint.ts`, `portal/src/lib/macropoint.test.ts`

**Interfaces:**
- Produces in `lib/api.ts`:
  ```ts
  export type MacroPointKind = 'location' | 'trip_event';
  export interface MacroPointRow { source: string; kind: MacroPointKind; recorded_at: string; location: string | null; address: string; event: string | null; status_to: string | null; status_to_label: string | null; duplicate: boolean }
  export interface MacroPointGroup { group_key: string; id_number: string; order_token: string | null; carrier: string; match: { truck_id: string | null; by: 'order' | 'tracker_id' | null; ambiguous_ids: string[] }; rows: MacroPointRow[]; new: number; duplicates: number }
  export interface MacroPointTruckOption { id: string; name: string; status: string; status_label: string; tracker_id: string | null; initiative_name: string | null }
  export interface MacroPointPreview { groups: MacroPointGroup[]; errors: { source: string; reason: string }[]; trucks: MacroPointTruckOption[] }
  export interface MacroPointResultRow { row: number; source: string; group_key: string | null; id_number: string | null; truck_id: string | null; truck_name: string | null; kind: MacroPointKind | null; recorded_at: string | null; detail: string; result: 'added' | 'duplicate' | 'skipped' | 'error'; status_change: string | null; reason: string | null; note: string | null }
  export interface MacroPointApplyResult { added: number; duplicates: number; skipped: number; errors: number; status_changes: number; rows: MacroPointResultRow[] }
  export interface TruckEvent { id: string; truck_id: string; recorded_at: string; event: string; event_kind: 'arrived' | 'departed' | null; stop: string | null; source: string }
  export async function previewMacroPoint(files: File[], text: string): Promise<MacroPointPreview>
  export async function applyMacroPoint(files: File[], text: string, assignments: Record<string, string | null>): Promise<MacroPointApplyResult>
  export async function listTruckEvents(id: string): Promise<TruckEvent[]>
  ```
  and `TruckFeedEvent`: `kind: 'location' | 'status' | 'load' | 'unload' | 'trip'`, `via: 'kiosk' | 'portal' | 'import' | 'MacroPoint' | null`, new `event: string | null`.
- Produces in `lib/macropoint.ts`: `reasonText(reason: string): string`, `noteText(note: string | null): string`, `initialAssignments(preview: MacroPointPreview): Record<string, string>`, `truckOptions(trucks: MacroPointTruckOption[], first?: string[]): ComboOption[]`, `isEml(file: File): boolean`, `mergeFiles(current: File[], added: File[]): File[]`, `assignmentsPayload(groups: MacroPointGroup[], chosen: Record<string, string>): Record<string, string | null>`, `MACROPOINT_ERRORS: Record<string, string>` (HTTP error codes → copy).

- [ ] **Step 1: Write the failing helper tests**

`portal/src/lib/macropoint.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import type { MacroPointGroup, MacroPointPreview, MacroPointTruckOption } from './api';
import {
  assignmentsPayload, initialAssignments, isEml, mergeFiles, noteText, reasonText, truckOptions,
} from './macropoint';

const truck = (id: string, name: string, extra: Partial<MacroPointTruckOption> = {}): MacroPointTruckOption => ({
  id, name, status: 'active', status_label: 'Active', tracker_id: null, initiative_name: null, ...extra,
});
const group = (key: string, truckId: string | null, ambiguous: string[] = []): MacroPointGroup => ({
  group_key: key, id_number: key, order_token: null, carrier: 'Landstar - ATL',
  match: { truck_id: truckId, by: truckId ? 'tracker_id' : null, ambiguous_ids: ambiguous },
  rows: [], new: 0, duplicates: 0,
});

describe('reasonText', () => {
  it('words parse and apply reasons', () => {
    expect(reasonText('not_macropoint')).toBe('Not a MacroPoint email');
    expect(reasonText('missing_field:date_time')).toBe('Missing Date/Time');
    expect(reasonText('truck_not_active')).toBe('Truck is no longer active');
    expect(reasonText('something_new')).toBe('something_new');
  });
  it('words notes', () => {
    expect(noteText('linked_to_other_order')).toMatch(/different MacroPoint order/);
    expect(noteText(null)).toBe('');
  });
});

describe('assignments', () => {
  it('pre-fills matched groups and leaves the rest blank', () => {
    const preview: MacroPointPreview = {
      groups: [group('a', 't1'), group('b', null)], errors: [], trucks: [],
    };
    expect(initialAssignments(preview)).toEqual({ a: 't1', b: '' });
  });
  it('sends null for blank picks', () => {
    expect(assignmentsPayload([group('a', null), group('b', null)], { a: 't9', b: '' }))
      .toEqual({ a: 't9', b: null });
  });
});

describe('truckOptions', () => {
  it('labels with status and move and lists ambiguous candidates first', () => {
    const opts = truckOptions(
      [truck('t1', 'Alpha'), truck('t2', 'Bravo', { initiative_name: 'NAP11' })], ['t2'],
    );
    expect(opts.map((o) => o.value)).toEqual(['t2', 't1']);
    expect(opts[0]).toEqual({ value: 't2', label: 'Bravo', sub: 'Active · NAP11' });
    expect(opts[1].sub).toBe('Active');
  });
});

describe('files', () => {
  const f = (name: string, size = 3, lastModified = 1) =>
    new File(['x'.repeat(size)], name, { lastModified });
  it('accepts .eml only', () => {
    expect(isEml(f('a.EML'))).toBe(true);
    expect(isEml(f('a.msg'))).toBe(false);
  });
  it('appends without duplicating the same file', () => {
    const a = f('a.eml');
    expect(mergeFiles([a], [f('a.eml'), f('b.eml')]).map((x) => x.name)).toEqual(['a.eml', 'b.eml']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/macropoint.test.ts`
Expected: FAIL — cannot resolve `./macropoint`.

- [ ] **Step 3: Add the API functions and types** in `lib/api.ts`

Put the types next to `TruckFeedEvent`, and the functions right after `clearTruckUpdates`:

```ts
function macroPointForm(files: File[], text: string): FormData {
  const fd = new FormData();
  for (const f of files) fd.append('files', f, f.name);
  if (text.trim()) fd.append('text', text);
  return fd;
}

export async function previewMacroPoint(files: File[], text: string): Promise<MacroPointPreview> {
  const resp = await apiFetch('/trucks/manual-update/macropoint/preview', {
    method: 'POST', body: macroPointForm(files, text),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function applyMacroPoint(
  files: File[], text: string, assignments: Record<string, string | null>,
): Promise<MacroPointApplyResult> {
  const fd = macroPointForm(files, text);
  fd.append('assignments', JSON.stringify(assignments));
  const resp = await apiFetch('/trucks/manual-update/macropoint/apply', { method: 'POST', body: fd });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function listTruckEvents(id: string): Promise<TruckEvent[]> {
  const resp = await apiFetch(`/trucks/${id}/events`);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

Update `TruckFeedEvent` (`kind`, `via`, new `event: string | null;` after `source`).

- [ ] **Step 4: Implement `lib/macropoint.ts`**

```ts
/** MacroPoint manual update: pure helpers for the Manual update modal
 *  (reason copy, truck picker options, assignments, .eml file list). */
import type { ComboOption } from '../components/ComboBox';
import type { MacroPointGroup, MacroPointPreview, MacroPointTruckOption } from './api';

const REASONS: Record<string, string> = {
  not_macropoint: 'Not a MacroPoint email',
  unreadable: 'Could not read this file',
  unknown_zone: 'Unknown time zone',
  bad_time: 'Date/Time is not a real date',
  bad_location: 'Location is out of range',
  no_truck: 'No truck picked',
  truck_not_active: 'Truck is no longer active',
};
const FIELDS: Record<string, string> = {
  id_number: 'ID Number', date_time: 'Date/Time', location: 'Location', event: 'Event',
};

export function reasonText(reason: string): string {
  if (reason.startsWith('missing_field:')) {
    const f = reason.slice('missing_field:'.length);
    return `Missing ${FIELDS[f] ?? f}`;
  }
  return REASONS[reason] ?? reason;
}

export function noteText(note: string | null): string {
  if (note === 'linked_to_other_order') {
    return 'Truck is linked to a different MacroPoint order; link not changed';
  }
  return note ?? '';
}

/** HTTP error codes from the preview/apply routes. */
export const MACROPOINT_ERRORS: Record<string, string> = {
  nothing_to_parse: 'Add .eml files or paste email text first.',
  too_many_files: 'Too many files — 500 at most per upload.',
  file_too_large: 'A file is larger than 2 MB.',
  upload_too_large: 'The upload is larger than 20 MB.',
  text_too_large: 'The pasted text is larger than 1 MB.',
  bad_assignments: 'Could not read the truck picks — try again.',
};

export function initialAssignments(preview: MacroPointPreview): Record<string, string> {
  return Object.fromEntries(preview.groups.map((g) => [g.group_key, g.match.truck_id ?? '']));
}

export function assignmentsPayload(
  groups: MacroPointGroup[], chosen: Record<string, string>,
): Record<string, string | null> {
  return Object.fromEntries(groups.map((g) => [g.group_key, chosen[g.group_key] || null]));
}

/** Picker options in the API's (natural) order, with `first` ids (an
 *  ambiguous match's candidates) moved to the top. */
export function truckOptions(trucks: MacroPointTruckOption[], first: string[] = []): ComboOption[] {
  const lead = trucks.filter((t) => first.includes(t.id));
  const rest = trucks.filter((t) => !first.includes(t.id));
  return [...lead, ...rest].map((t) => ({
    value: t.id,
    label: t.name,
    sub: t.initiative_name ? `${t.status_label} · ${t.initiative_name}` : t.status_label,
  }));
}

export function isEml(file: File): boolean {
  return file.name.toLowerCase().endsWith('.eml');
}

const fileKey = (f: File) => `${f.name}|${f.size}|${f.lastModified}`;

export function mergeFiles(current: File[], added: File[]): File[] {
  const seen = new Set(current.map(fileKey));
  const out = [...current];
  for (const f of added) {
    if (!seen.has(fileKey(f))) { seen.add(fileKey(f)); out.push(f); }
  }
  return out;
}
```

- [ ] **Step 5: Run the tests and type check**

Run: `npx vitest run src/lib/macropoint.test.ts && npx tsc -b`
Expected: PASS; tsc may flag `KIND_ICON` in `ShipmentsDashboard.tsx` (missing `trip`) — add a placeholder entry now so it compiles: `trip: svg(<path d="M5 21V4h11l-2 4 2 4H5" />),` (Task 9 keeps it and adds the text/CSS).

- [ ] **Step 6: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/macropoint.ts portal/src/lib/macropoint.test.ts portal/src/pages/ShipmentsDashboard.tsx
git commit -m "feat(portal): MacroPoint API client, truck events, feed types and pure helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Multi-file dropzone

**Files:**
- Create: `portal/src/components/MultiFileDropzone.tsx`, `portal/src/components/MultiFileDropzone.test.tsx`
- Modify: `portal/src/styles/initiatives.css` (where `.imp-dropzone` lives — append the list rules after the existing `.imp-dropzone*` block)

**Interfaces:**
- Consumes: `formatBytes` from `components/FileDropzone.tsx`; `isEml`, `mergeFiles` from `lib/macropoint.ts`.
- Produces: `export default function MultiFileDropzone(props: { files: File[]; onFiles: (files: File[]) => void; busy: boolean; accept?: string; hint?: string; filter?: (f: File) => boolean; onRejected?: (names: string[]) => void })`. Renders the `imp-dropzone` label (input `multiple`) and, below it (outside the label), a list `ul.imp-file-list` with one `li` per file (name, size, a `×` remove button `aria-label="Remove <name>"`) and a "Clear all" `mini-btn` when there are 2+ files.

- [ ] **Step 1: Write the failing test**

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { isEml } from '../lib/macropoint';
import MultiFileDropzone from './MultiFileDropzone';

afterEach(cleanup);

function Harness({ onRejected }: { onRejected?: (n: string[]) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  return <MultiFileDropzone files={files} onFiles={setFiles} busy={false} accept=".eml"
                            filter={isEml} onRejected={onRejected} />;
}

const eml = (name: string) => new File(['x'], name, { lastModified: 1 });

it('adds dropped files, rejects others, removes and clears', () => {
  const onRejected = vi.fn();
  const { container } = render(<Harness onRejected={onRejected} />);
  const zone = container.querySelector('.imp-dropzone')!;
  fireEvent.drop(zone, { dataTransfer: { files: [eml('a.eml'), eml('b.eml'), eml('c.pdf')] } });
  expect(screen.getByText('a.eml')).not.toBeNull();
  expect(screen.getByText('b.eml')).not.toBeNull();
  expect(screen.queryByText('c.pdf')).toBeNull();
  expect(onRejected).toHaveBeenCalledWith(['c.pdf']);

  fireEvent.click(screen.getByRole('button', { name: 'Remove a.eml' }));
  expect(screen.queryByText('a.eml')).toBeNull();

  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  expect(input.multiple).toBe(true);
  fireEvent.change(input, { target: { files: [eml('d.eml')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
  expect(container.querySelectorAll('.imp-file-list li')).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/MultiFileDropzone.test.tsx`
Expected: FAIL — cannot resolve `./MultiFileDropzone`.

- [ ] **Step 3: Implement**

```tsx
/** Drag-and-drop / click-to-browse for SEVERAL files (the MacroPoint
 *  Manual update). Same `imp-dropzone` look as FileDropzone; the chosen
 *  files are listed below the zone (outside the label, so a remove click
 *  never opens the file picker). Controlled: the caller owns `files`. */
import { useRef, useState, type DragEvent } from 'react';

import { mergeFiles } from '../lib/macropoint';
import { formatBytes } from './FileDropzone';

interface Props {
  files: File[];
  onFiles: (files: File[]) => void;
  busy: boolean;
  accept?: string;
  hint?: string;
  /** Files failing this are left out and reported through onRejected. */
  filter?: (f: File) => boolean;
  onRejected?: (names: string[]) => void;
}

export default function MultiFileDropzone({
  files, onFiles, busy, accept, hint = 'One or more files', filter, onRejected,
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const add = (list: FileList | File[] | null | undefined) => {
    const incoming = Array.from(list ?? []);
    const ok = filter ? incoming.filter(filter) : incoming;
    const bad = incoming.filter((f) => !ok.includes(f)).map((f) => f.name);
    if (bad.length) onRejected?.(bad);
    if (ok.length) onFiles(mergeFiles(files, ok));
    if (inputRef.current) inputRef.current.value = '';
  };
  const total = files.reduce((n, f) => n + f.size, 0);

  return (
    <div className="imp-multi">
      <label
        className={`imp-dropzone${dragOver ? ' drag' : ''}`}
        onDragOver={(e: DragEvent<HTMLLabelElement>) => { e.preventDefault(); if (!busy) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e: DragEvent<HTMLLabelElement>) => {
          e.preventDefault();
          setDragOver(false);
          if (!busy) add(e.dataTransfer.files);
        }}
      >
        <input ref={inputRef} type="file" accept={accept} multiple disabled={busy}
               className="imp-dropzone-input" onChange={(e) => add(e.target.files)} />
        <div className="imp-dropzone-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 18a4.5 4.5 0 0 1-1.2-8.84A5.5 5.5 0 0 1 16.5 8H17a4 4 0 0 1 1 7.87" />
            <path d="M12 12v7" />
            <path d="M9.5 14.5 12 12l2.5 2.5" />
          </svg>
          <p className="imp-dropzone-title">Drop your files here, or click to browse</p>
          <p className="imp-dropzone-hint">{hint}</p>
        </div>
      </label>
      {files.length > 0 && (
        <div className="imp-file-box">
          <div className="imp-file-summary">
            <span>{files.length} {files.length === 1 ? 'file' : 'files'} · {formatBytes(total)}</span>
            {files.length > 1 && (
              <button type="button" className="mini-btn" disabled={busy} onClick={() => onFiles([])}>
                Clear all
              </button>
            )}
          </div>
          <ul className="imp-file-list">
            {files.map((f) => (
              <li key={`${f.name}|${f.size}|${f.lastModified}`}>
                <span className="imp-dropzone-file-name">{f.name}</span>
                <span className="imp-dropzone-file-size">{formatBytes(f.size)}</span>
                <button type="button" className="imp-dropzone-remove" disabled={busy}
                        aria-label={`Remove ${f.name}`}
                        onClick={() => onFiles(files.filter((x) => x !== f))}>×</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
```

CSS (append after the `.imp-dropzone` rules in `styles/initiatives.css`; layout only — no radius+overflow combination):

```css
.imp-multi { display: flex; flex-direction: column; gap: 10px; }
.imp-file-box { border: 1px solid var(--paper-line); border-radius: 10px; padding: 8px 12px; }
.imp-file-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-bottom: 6px; }
.imp-file-list { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow-y: auto; }
.imp-file-list li { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
.imp-file-list .imp-dropzone-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
```

(`.imp-file-list` scrolls but has no border-radius; the radius sits on `.imp-file-box`, which does not scroll — this keeps the roundedScrollbars guardrail satisfied.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/components/MultiFileDropzone.test.tsx src/styles`
Expected: PASS (the `src/styles` guardrail tests included).

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/MultiFileDropzone.tsx portal/src/components/MultiFileDropzone.test.tsx portal/src/styles/initiatives.css
git commit -m "feat(portal): MultiFileDropzone — several files, per-file remove, filter

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Manual update modal, MacroPoint panel and summary

**Files:**
- Create: `portal/src/components/trucks/ManualUpdateModal.tsx`, `portal/src/components/trucks/MacroPointPanel.tsx`, `portal/src/components/trucks/MacroPointSummary.tsx`, `portal/src/styles/macropoint.css`, `portal/src/components/trucks/ManualUpdateModal.test.tsx`
- Modify: `portal/src/pages/Trucks.tsx`, `portal/src/pages/Trucks.test.tsx`

**Interfaces:**
- Consumes: Task 6 `previewMacroPoint`, `applyMacroPoint`, types, `lib/macropoint.ts` helpers, `MACROPOINT_ERRORS`; Task 7 `MultiFileDropzone`; `ComboBox`, `DataTable`, `exportCsv` (`lib/listTools`), `ApiError` (`lib/api`).
- Produces:
  - `export default function ManualUpdateModal(props: { onClose: () => void; onApplied: () => void })`
  - `export default function MacroPointPanel(props: { onClose: () => void; onApplied: () => void; onBusy: (busy: boolean) => void })` — renders its own `modal-body` and `modal-foot`.
  - `export default function MacroPointSummary(props: { result: MacroPointApplyResult })`

UI contract (tests rely on these names):
- Dialog `role="dialog"` `aria-label="Manual update"`; eyebrow "Trucks", `h3` "Manual update", hint "Turn tracking emails into truck locations and trip events. Nothing changes until you apply."
- Tabs: `div.segmented[role=tablist][aria-label="Update source"]` with `role="tab"` buttons **MacroPoint**, **Copeland**, **3rd-Party**; panels stay mounted (inactive ones `hidden`). Copeland / 3rd-Party panels: `dir-empty` "<b>Coming soon</b> Copeland updates are not built yet." (3rd-Party: "Third-party updates are not built yet.") + foot **Close**.
- MacroPoint steps (`rgm-steps`): Add emails → Review → Summary.
  - Input: MultiFileDropzone (accept `.eml`, filter `isEml`, hint "MacroPoint emails saved as .eml files"), rejected names shown as `pf-error` "Skipped (not .eml): a.pdf"; a `textarea` with label "Or paste email text" (`aria-label="Pasted email text"`, 8 rows). Foot: **Parse** (`btn-solid`, disabled unless files or text; busy text "Parsing…"), **Cancel**.
  - Review: a line "`N loads · X new · Y already recorded`" (+ " · Z problems" when errors). One `section.mp-group` per group: top row with `b` ID Number, carrier, counts; a `ComboBox` (ariaLabel `Truck for <id_number>`, placeholder "Pick a truck…", clearable) with options from `truckOptions(preview.trucks, g.match.ambiguous_ids)`; a hint `set-note`: "Matched by MacroPoint order" / "Matched by tracking name" / "Several trucks match — pick one" / "No match — pick a truck or leave blank to skip"; then `DataTable` (ariaLabel `Updates for <id_number>`) with columns When (mono, `new Date(r.recorded_at).toLocaleString()`), Update (`r.location ?? r.event`), Address, Status (`→ ${r.status_to_label}` or ''), and duplicate rows get `className: 'mp-dup'` plus the Update cell suffixed " · Already recorded". Parse problems: `DataTable` ariaLabel "Problems" (Source, Problem via `reasonText`). Foot: **Apply** (disabled while no group with a picked truck has `new > 0`; busy "Applying…"), **Back**.
  - Summary: `MacroPointSummary`; foot **Done** → `onApplied()` then `onClose()`.
- Errors from the API show in the foot as `span.pf-error` using `MACROPOINT_ERRORS[err.code] ?? 'Could not reach the server — try again.'`.
- Trucks page: the Actions item `Manual update` is enabled with `trucks:change` and opens the modal; `onApplied` reloads the list and the map.

- [ ] **Step 1: Write the failing modal test**

`portal/src/components/trucks/ManualUpdateModal.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { MacroPointApplyResult, MacroPointPreview } from '../../lib/api';

const api = vi.hoisted(() => ({ previewMacroPoint: vi.fn(), applyMacroPoint: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

import ManualUpdateModal from './ManualUpdateModal';

const preview: MacroPointPreview = {
  groups: [
    {
      group_key: 'order:tok', id_number: 'JAMIE & PATRICK', order_token: 'tok', carrier: 'Landstar - ATL',
      match: { truck_id: 't1', by: 'tracker_id', ambiguous_ids: [] },
      rows: [
        { source: 'a.eml', kind: 'trip_event', recorded_at: '2024-10-15T15:11:00Z', location: null,
          address: '', event: 'Departed at Pickup', status_to: 'in_transit', status_to_label: 'In Transit', duplicate: false },
        { source: 'b.eml', kind: 'location', recorded_at: '2024-10-15T20:32:00Z', location: '35.481693, -119.140353',
          address: 'CA-99 Bakersfield', event: null, status_to: null, status_to_label: null, duplicate: true },
      ],
      new: 1, duplicates: 1,
    },
    {
      group_key: 'id:other', id_number: 'Other Load', order_token: null, carrier: 'Longboard Transportation',
      match: { truck_id: null, by: null, ambiguous_ids: [] },
      rows: [{ source: 'c.eml', kind: 'location', recorded_at: '2026-03-13T18:22:00Z', location: '1.000000, 2.000000',
               address: '', event: null, status_to: null, status_to_label: null, duplicate: false }],
      new: 1, duplicates: 0,
    },
  ],
  errors: [{ source: 'x.eml', reason: 'not_macropoint' }],
  trucks: [
    { id: 't1', name: 'JP Truck', status: 'active', status_label: 'Active', tracker_id: null, initiative_name: null },
    { id: 't2', name: 'Spare Truck', status: 'created', status_label: 'Created', tracker_id: null, initiative_name: 'NAP11' },
  ],
};
const result: MacroPointApplyResult = {
  added: 2, duplicates: 1, skipped: 0, errors: 1, status_changes: 1,
  rows: [
    { row: 1, source: 'a.eml', group_key: 'order:tok', id_number: 'JAMIE & PATRICK', truck_id: 't1', truck_name: 'JP Truck',
      kind: 'trip_event', recorded_at: '2024-10-15T15:11:00Z', detail: 'Departed at Pickup', result: 'added',
      status_change: 'Active → In Transit', reason: null, note: null },
    { row: 2, source: 'x.eml', group_key: null, id_number: null, truck_id: null, truck_name: null, kind: null,
      recorded_at: null, detail: '', result: 'error', status_change: null, reason: 'not_macropoint', note: null },
  ],
};

beforeEach(() => { api.previewMacroPoint.mockReset(); api.applyMacroPoint.mockReset(); });
afterEach(cleanup);

it('has the three source tabs; Copeland is coming soon', () => {
  render(<ManualUpdateModal onClose={() => {}} onApplied={() => {}} />);
  const tabs = within(screen.getByRole('tablist', { name: 'Update source' })).getAllByRole('tab');
  expect(tabs.map((t) => t.textContent)).toEqual(['MacroPoint', 'Copeland', '3rd-Party']);
  fireEvent.click(screen.getByRole('tab', { name: 'Copeland' }));
  expect(screen.getByText(/Copeland updates are not built yet/)).not.toBeNull();
});

it('parses pasted text, picks a truck for the unmatched load, applies and shows the summary', async () => {
  api.previewMacroPoint.mockResolvedValue(preview);
  api.applyMacroPoint.mockResolvedValue(result);
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(<ManualUpdateModal onClose={onClose} onApplied={onApplied} />);

  const parse = screen.getByRole('button', { name: 'Parse' }) as HTMLButtonElement;
  expect(parse.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Pasted email text'), { target: { value: 'Location Update from …' } });
  fireEvent.click(parse);

  await screen.findByText('2 loads · 2 new · 1 already recorded · 1 problem');
  expect(api.previewMacroPoint).toHaveBeenCalledWith([], 'Location Update from …');
  expect(screen.getByText('Matched by tracking name')).not.toBeNull();
  expect(screen.getByText('No match — pick a truck or leave blank to skip')).not.toBeNull();
  expect(screen.getByText('→ In Transit')).not.toBeNull();
  expect(screen.getByText(/Already recorded/)).not.toBeNull();
  expect(screen.getByText('Not a MacroPoint email')).not.toBeNull();

  fireEvent.focus(screen.getByLabelText('Truck for Other Load'));
  fireEvent.mouseDown(screen.getByText('Spare Truck'));
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

  await screen.findByText(/Applied: 2 added/);
  expect(api.applyMacroPoint).toHaveBeenCalledWith([], 'Location Update from …',
    { 'order:tok': 't1', 'id:other': 't2' });
  expect(screen.getByText('Active → In Transit')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(onApplied).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

it('shows a coded API error and keeps the input', async () => {
  const { ApiError } = await import('../../lib/api');
  api.previewMacroPoint.mockRejectedValue(new ApiError(413, 'too_many_files'));
  render(<ManualUpdateModal onClose={() => {}} onApplied={() => {}} />);
  fireEvent.change(screen.getByLabelText('Pasted email text'), { target: { value: 'x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Parse' }));
  await waitFor(() => expect(screen.getByText('Too many files — 500 at most per upload.')).not.toBeNull());
  expect((screen.getByLabelText('Pasted email text') as HTMLTextAreaElement).value).toBe('x');
});
```

Update `portal/src/pages/Trucks.test.tsx`: rename the test `'Actions menu offers Bulk import (to /bulk/trucks) and a disabled Manual update'` to `'Actions menu offers Bulk import (to /bulk/trucks) and Manual update opens the modal'`, replace the `expect(manual.disabled).toBe(true);` line with:

```tsx
  expect(manual.disabled).toBe(false);
  await user.click(manual);
  expect(screen.getByRole('dialog', { name: 'Manual update' })).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: /^actions/i }));
```

(keep the following Bulk import assertions as they are).

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/trucks/ManualUpdateModal.test.tsx src/pages/Trucks.test.tsx`
Expected: FAIL — cannot resolve `./ManualUpdateModal`; Trucks test fails on `disabled`.

- [ ] **Step 3: Implement `MacroPointSummary.tsx`**

```tsx
/** What a MacroPoint apply did, one row per email (server truth: renders
 *  the apply response). Same layout as BulkApplySummary, whose fixed
 *  created/updated/skipped/unchanged results have no duplicate or error. */
import type { MacroPointApplyResult, MacroPointResultRow } from '../../lib/api';
import { exportCsv } from '../../lib/listTools';
import { noteText, reasonText } from '../../lib/macropoint';
import DataTable from '../DataTable';

const RESULT_LABEL = {
  added: 'Added', duplicate: 'Already recorded', skipped: 'Skipped', error: 'Error',
} as const;
const ROW_CLASS = {
  added: 'create', duplicate: 'unchanged', skipped: 'skipped', error: 'error',
} as const;

const when = (r: MacroPointResultRow) => (r.recorded_at ? new Date(r.recorded_at).toLocaleString() : '');
const notes = (r: MacroPointResultRow) =>
  [r.status_change ?? '', r.reason ? reasonText(r.reason) : '', noteText(r.note)]
    .filter(Boolean).join(' · ');

export default function MacroPointSummary({ result }: { result: MacroPointApplyResult }) {
  const download = () => exportCsv<MacroPointResultRow>('macropoint-update-summary', [
    ['Row', (r) => String(r.row)],
    ['Source', (r) => r.source],
    ['Load', (r) => r.id_number ?? ''],
    ['Truck', (r) => r.truck_name ?? ''],
    ['Time', when],
    ['Update', (r) => r.detail],
    ['Result', (r) => RESULT_LABEL[r.result]],
    ['Notes', notes],
  ], result.rows);

  const counts = [
    `${result.added} added`,
    `${result.duplicates} already recorded`,
    `${result.skipped} skipped`,
    `${result.errors} ${result.errors === 1 ? 'error' : 'errors'}`,
    `${result.status_changes} status ${result.status_changes === 1 ? 'change' : 'changes'}`,
  ].join(' · ');

  return (
    <div className="bulk-summary">
      <div className="bulk-actions">
        <b>Applied: {counts}</b>
        <button className="mini-btn" type="button" onClick={download}>Download summary (.csv)</button>
      </div>
      <DataTable
        ariaLabel="Apply summary"
        className="bulk-preview"
        columns={[
          { key: 'row', label: 'Row', width: '56px', mono: true },
          { key: 'source', label: 'Source' },
          { key: 'load', label: 'Load' },
          { key: 'truck', label: 'Truck' },
          { key: 'when', label: 'Time', mono: true },
          { key: 'update', label: 'Update' },
          { key: 'result', label: 'Result' },
          { key: 'notes', label: 'Notes' },
        ]}
        rows={result.rows.map((r) => ({
          key: String(r.row),
          className: `bulk-row-${ROW_CLASS[r.result]}`,
          cells: [r.row, r.source, r.id_number ?? '—', r.truck_name ?? '—', when(r) || '—',
                  r.detail || '—', RESULT_LABEL[r.result], notes(r) || '—'],
        }))}
      />
    </div>
  );
}
```

- [ ] **Step 4: Implement `MacroPointPanel.tsx`**

```tsx
/** MacroPoint tab of Manual update: add emails (.eml files and/or pasted
 *  text) → review each load and its truck → apply → summary. The server
 *  parses twice (preview, then apply) from the same input; the panel keeps
 *  the files and text so Back and a failed apply lose nothing. */
import { Fragment, useMemo, useState } from 'react';

import {
  ApiError, applyMacroPoint, previewMacroPoint,
  type MacroPointApplyResult, type MacroPointGroup, type MacroPointPreview,
} from '../../lib/api';
import {
  MACROPOINT_ERRORS, assignmentsPayload, initialAssignments, isEml, reasonText, truckOptions,
} from '../../lib/macropoint';
import ComboBox from '../ComboBox';
import DataTable from '../DataTable';
import MultiFileDropzone from '../MultiFileDropzone';
import MacroPointSummary from './MacroPointSummary';

type Step = 'input' | 'review' | 'summary';
const STEPS: { key: Step; label: string }[] = [
  { key: 'input', label: 'Add emails' }, { key: 'review', label: 'Review' }, { key: 'summary', label: 'Summary' },
];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function matchHint(g: MacroPointGroup): string {
  if (g.match.by === 'order') return 'Matched by MacroPoint order';
  if (g.match.by === 'tracker_id') return 'Matched by tracking name';
  if (g.match.ambiguous_ids.length) return 'Several trucks match — pick one';
  return 'No match — pick a truck or leave blank to skip';
}

function errorText(err: unknown): string {
  return err instanceof ApiError
    ? (MACROPOINT_ERRORS[err.code] ?? 'Could not reach the server — try again.')
    : 'Could not reach the server — try again.';
}

interface Props { onClose: () => void; onApplied: () => void; onBusy: (busy: boolean) => void }

export default function MacroPointPanel({ onClose, onApplied, onBusy }: Props) {
  const [step, setStep] = useState<Step>('input');
  const [files, setFiles] = useState<File[]>([]);
  const [text, setText] = useState('');
  const [rejected, setRejected] = useState<string[]>([]);
  const [preview, setPreview] = useState<MacroPointPreview | null>(null);
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [result, setResult] = useState<MacroPointApplyResult | null>(null);
  const [busy, setBusyState] = useState<'parse' | 'apply' | null>(null);
  const [error, setError] = useState('');

  const setBusy = (b: 'parse' | 'apply' | null) => { setBusyState(b); onBusy(b !== null); };
  const current = STEPS.findIndex((s) => s.key === step);

  const totals = useMemo(() => {
    const groups = preview?.groups ?? [];
    return {
      loads: groups.length,
      fresh: groups.reduce((n, g) => n + g.new, 0),
      dupes: groups.reduce((n, g) => n + g.duplicates, 0),
      problems: preview?.errors.length ?? 0,
    };
  }, [preview]);
  const canApply = (preview?.groups ?? []).some((g) => chosen[g.group_key] && g.new > 0);

  const parse = async () => {
    setBusy('parse');
    setError('');
    try {
      const p = await previewMacroPoint(files, text);
      setPreview(p);
      setChosen(initialAssignments(p));
      setStep('review');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!preview) return;
    setBusy('apply');
    setError('');
    try {
      setResult(await applyMacroPoint(files, text, assignmentsPayload(preview.groups, chosen)));
      setStep('summary');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="modal-body">
        <div className="rgm-steps">
          {STEPS.map((s, i) => (
            <Fragment key={s.key}>
              {i > 0 && <span className="rgm-step-sep" />}
              <span className={`rgm-step ${i === current ? 'on' : ''} ${i < current ? 'done' : ''}`}
                    aria-current={i === current ? 'step' : undefined}>
                <span className="rgm-step-num">{i + 1}</span>
                <span className="rgm-step-label">{s.label}</span>
              </span>
            </Fragment>
          ))}
        </div>

        {step === 'input' && (
          <div className="mp-input">
            <MultiFileDropzone files={files} onFiles={(f) => { setFiles(f); setRejected([]); }}
                               busy={busy !== null} accept=".eml" filter={isEml}
                               onRejected={setRejected}
                               hint="MacroPoint emails saved as .eml files" />
            {rejected.length > 0 && (
              <p className="pf-error">Skipped (not .eml): {rejected.join(', ')}</p>
            )}
            <div className="pf-form">
              <div className="full">
                <label htmlFor="mp-paste">Or paste email text</label>
                <textarea id="mp-paste" aria-label="Pasted email text" rows={8} value={text}
                          disabled={busy !== null} onChange={(e) => setText(e.target.value)}
                          placeholder="Paste one or more MacroPoint emails here" />
              </div>
            </div>
          </div>
        )}

        {step === 'review' && preview && (
          <div className="mp-review">
            <p className="set-note">
              {plural(totals.loads, 'load', 'loads')} · {totals.fresh} new · {totals.dupes} already recorded
              {totals.problems > 0 && ` · ${plural(totals.problems, 'problem', 'problems')}`}
            </p>
            {preview.groups.map((g) => (
              <section key={g.group_key} className="mp-group">
                <div className="mp-group-top">
                  <div className="mp-group-id">
                    <b>{g.id_number}</b>
                    <span className="set-note">{g.carrier} · {g.new} new · {g.duplicates} already recorded</span>
                  </div>
                  <div className="mp-group-truck">
                    <ComboBox
                      ariaLabel={`Truck for ${g.id_number}`}
                      placeholder="Pick a truck…"
                      clearable
                      disabled={busy !== null}
                      value={chosen[g.group_key] ?? ''}
                      onChange={(v) => setChosen((c) => ({ ...c, [g.group_key]: v }))}
                      options={truckOptions(preview.trucks, g.match.ambiguous_ids)}
                    />
                    <span className="set-note">{matchHint(g)}</span>
                  </div>
                </div>
                <DataTable
                  ariaLabel={`Updates for ${g.id_number}`}
                  className="bulk-preview"
                  columns={[
                    { key: 'when', label: 'When', mono: true },
                    { key: 'update', label: 'Update' },
                    { key: 'address', label: 'Address' },
                    { key: 'status', label: 'Status' },
                  ]}
                  rows={g.rows.map((r, i) => ({
                    key: `${i}`,
                    className: r.duplicate ? 'mp-dup' : undefined,
                    cells: [
                      new Date(r.recorded_at).toLocaleString(),
                      `${r.location ?? r.event ?? ''}${r.duplicate ? ' · Already recorded' : ''}`,
                      r.address || '—',
                      r.status_to_label ? `→ ${r.status_to_label}` : '',
                    ],
                  }))}
                />
              </section>
            ))}
            {preview.errors.length > 0 && (
              <section className="mp-group">
                <div className="modal-section">Problems</div>
                <DataTable
                  ariaLabel="Problems"
                  columns={[{ key: 'source', label: 'Source' }, { key: 'reason', label: 'Problem' }]}
                  rows={preview.errors.map((e, i) => ({
                    key: `${i}`, cells: [e.source, reasonText(e.reason)],
                  }))}
                />
              </section>
            )}
          </div>
        )}

        {step === 'summary' && result && <MacroPointSummary result={result} />}
      </div>

      <div className="modal-foot">
        {step === 'input' && (
          <>
            <button className="btn-solid" disabled={busy !== null || (!files.length && !text.trim())}
                    onClick={() => void parse()}>
              {busy === 'parse' ? 'Parsing…' : 'Parse'}
            </button>
            <button className="mini-btn" disabled={busy !== null} onClick={onClose}>Cancel</button>
          </>
        )}
        {step === 'review' && (
          <>
            <button className="btn-solid" disabled={busy !== null || !canApply}
                    onClick={() => void apply()}>
              {busy === 'apply' ? 'Applying…' : 'Apply'}
            </button>
            <button className="mini-btn" disabled={busy !== null} onClick={() => setStep('input')}>Back</button>
          </>
        )}
        {step === 'summary' && (
          <button className="btn-solid" onClick={() => { onApplied(); onClose(); }}>Done</button>
        )}
        {error && <span className="pf-error">{error}</span>}
      </div>
    </>
  );
}
```

- [ ] **Step 5: Implement `ManualUpdateModal.tsx` and `styles/macropoint.css`**

```tsx
/** Trucks › Actions › Manual update: tracking updates entered by hand from
 *  a carrier's emails. MacroPoint is built; Copeland and 3rd-Party are
 *  placeholders. Panels stay mounted so switching tabs keeps their state. */
import { useState } from 'react';

import '../../styles/reports.css';      // rgm-card / rgm-steps
import '../../styles/macropoint.css';
import MacroPointPanel from './MacroPointPanel';

type Tab = 'macropoint' | 'copeland' | 'third_party';
const TABS: { key: Tab; label: string }[] = [
  { key: 'macropoint', label: 'MacroPoint' },
  { key: 'copeland', label: 'Copeland' },
  { key: 'third_party', label: '3rd-Party' },
];

function ComingSoon({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <>
      <div className="modal-body">
        <div className="dir-empty"><b>Coming soon</b>{text}</div>
      </div>
      <div className="modal-foot">
        <button className="mini-btn" onClick={onClose}>Close</button>
      </div>
    </>
  );
}

export default function ManualUpdateModal({ onClose, onApplied }: {
  onClose: () => void; onApplied: () => void;
}) {
  const [tab, setTab] = useState<Tab>('macropoint');
  const [busy, setBusy] = useState(false);

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card manual-update-card" role="dialog" aria-label="Manual update">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Trucks</div>
            <h3>Manual update</h3>
            <p className="page-hint">Turn tracking emails into truck locations and trip events. Nothing changes until you apply.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="mu-tabs">
          <div className="segmented" role="tablist" aria-label="Update source">
            {TABS.map((t) => (
              <button key={t.key} type="button" role="tab" aria-selected={tab === t.key}
                      className={tab === t.key ? 'on' : ''} disabled={busy}
                      onClick={() => setTab(t.key)}>{t.label}</button>
            ))}
          </div>
        </div>
        <div hidden={tab !== 'macropoint'} className="mu-panel">
          <MacroPointPanel onClose={onClose} onApplied={onApplied} onBusy={setBusy} />
        </div>
        <div hidden={tab !== 'copeland'} className="mu-panel">
          <ComingSoon text="Copeland updates are not built yet." onClose={onClose} />
        </div>
        <div hidden={tab !== 'third_party'} className="mu-panel">
          <ComingSoon text="Third-party updates are not built yet." onClose={onClose} />
        </div>
      </div>
    </div>
  );
}
```

`portal/src/styles/macropoint.css`:

```css
/* Trucks › Manual update (ManualUpdateModal / MacroPointPanel). */
.manual-update-card { width: min(1100px, 96vw); }
.mu-tabs { padding: 0 24px 4px; }
.mu-panel[hidden] { display: none; }
.mp-input { display: flex; flex-direction: column; gap: 14px; margin-top: 14px; }
.mp-input textarea { width: 100%; resize: vertical; font-family: var(--mono, ui-monospace, monospace); }
.mp-review { display: flex; flex-direction: column; gap: 16px; margin-top: 14px; }
.mp-group { display: flex; flex-direction: column; gap: 10px; padding-top: 12px; border-top: 1px solid var(--paper-line); }
.mp-group-top { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(300px, 380px); gap: 16px; align-items: start; }
.mp-group-id, .mp-group-truck { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.mp-dup { opacity: 0.6; }
@media (max-width: 760px) { .mp-group-top { grid-template-columns: 1fr; } }
```

(Match the `.mu-tabs` horizontal padding to `.modal-body`'s in `styles/chrome.css`.)

- [ ] **Step 6: Wire it into the Trucks page** (`pages/Trucks.tsx`)

Add `import ManualUpdateModal from '../components/trucks/ManualUpdateModal';`, state `const [manualOpen, setManualOpen] = useState(false);` next to `creating`, replace the placeholder item and its comment with:

```tsx
              ...(canChange ? [{ key: 'manual', label: 'Manual update', onSelect: () => setManualOpen(true) }] : []),
```

and render after the `creating` modal:

```tsx
      {manualOpen && (
        <ManualUpdateModal
          onClose={() => setManualOpen(false)}
          onApplied={() => { loadTrucks(false); loadMap(trails); }}
        />
      )}
```

- [ ] **Step 7: Run tests, type check, full portal suite**

Run: `npx vitest run src/components/trucks src/pages/Trucks.test.tsx && npx tsc -b && npx vitest run`
Expected: all PASS, including the guardrail tests under `src/styles` (modalDropdowns, roundedScrollbars, list typography, natural sort). Fix any guardrail failure in the new files rather than allowlisting.

- [ ] **Step 8: Commit**

```bash
git add portal/src/components/trucks/ManualUpdateModal.tsx portal/src/components/trucks/MacroPointPanel.tsx portal/src/components/trucks/MacroPointSummary.tsx portal/src/components/trucks/ManualUpdateModal.test.tsx portal/src/styles/macropoint.css portal/src/pages/Trucks.tsx portal/src/pages/Trucks.test.tsx
git commit -m "feat(portal): Manual update modal — MacroPoint parse, review, apply and summary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Truck detail trip events, relabel, and feed rendering

**Files:**
- Modify: `portal/src/pages/TruckDetail.tsx`, `portal/src/pages/TruckDetail.test.tsx`, `portal/src/components/trucks/TruckEditModal.tsx`, `portal/src/lib/shipments.ts`, `portal/src/lib/shipments.test.ts`, `portal/src/pages/ShipmentsDashboard.tsx`, `portal/src/styles/dashboard.css`

**Interfaces:**
- Consumes: Task 6 `listTruckEvents`, `TruckEvent`, `TruckFeedEvent` (`trip`, `event`, `via`).
- Produces: truck detail "Trip events" panel (DataTable ariaLabel "Trip events", columns When / Event / Source, empty text "No trip events yet."); tracking panel label "Tracking name / ID" and, when `tracking_type.macropoint_order` is set, a row "MacroPoint order" (mono); edit modal label "Tracking name / ID"; `feedEventText` for `trip` = `event` + (` · source` when present); status text gains ` · <via>` when `via` is set.

- [ ] **Step 1: Write the failing tests**

Append to `portal/src/lib/shipments.test.ts` (it already has the `ev(over)` factory; add `event: null` to that factory's defaults so it still satisfies `TruckFeedEvent`):

```ts
it('words trip events and the MacroPoint via on status changes', () => {
  expect(feedEventText(ev({ kind: 'trip', event: 'Departed at Pickup', source: 'macropoint' })))
    .toBe('Departed at Pickup · macropoint');
  expect(feedEventText(ev({ kind: 'trip', event: 'Arrived at Drop-Off', source: null })))
    .toBe('Arrived at Drop-Off');
  expect(feedEventText(ev({
    kind: 'status', from_label: 'Active', to_label: 'In Transit', actor_name: 'Ada', via: 'MacroPoint',
  }))).toBe('Active → In Transit by Ada · MacroPoint');
});
```

In `portal/src/pages/TruckDetail.test.tsx`, add `listTruckEvents: vi.fn()` to its hoisted `api` mock, add `api.listTruckEvents.mockResolvedValue([]);` in its `beforeEach` (next to `api.listTruckUpdates.mockResolvedValue(UPDATES);`), and add:

```tsx
it('shows trip events and the relabeled tracking fields', async () => {
  api.getTruck.mockResolvedValue({
    ...TRUCK,
    tracking_type: { tracker_id: 'JAMIE & PATRICK', macropoint_order: 'VM0s7D8Q' },
  });
  api.listTruckEvents.mockResolvedValue([
    { id: 'e1', truck_id: 't1', recorded_at: '2024-10-15T15:11:00Z', event: 'Departed at Pickup',
      event_kind: 'departed', stop: 'pickup', source: 'macropoint' },
  ]);
  renderPage();
  expect(await screen.findByText('Departed at Pickup')).not.toBeNull();
  expect(screen.getByText('Tracking name / ID')).not.toBeNull();
  expect(screen.getByText('MacroPoint order')).not.toBeNull();
  expect(screen.getByText('VM0s7D8Q')).not.toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/shipments.test.ts src/pages/TruckDetail.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`lib/shipments.ts` — in `feedEventText`:

```ts
    case 'status': {
      const from = e.from_label ?? e.from_status ?? '—';
      const to = e.to_label ?? e.to_status ?? '—';
      const text = e.actor_name ? `${from} → ${to} by ${e.actor_name}` : `${from} → ${to}`;
      return withVia(text, e.via);
    }
    ...
    case 'trip':
      return e.source ? `${e.event ?? ''} · ${e.source}` : (e.event ?? '');
```

`pages/ShipmentsDashboard.tsx` — keep the `trip` icon from Task 6 in `KIND_ICON`; in `FeedText`'s status branch, after the actor span add `{e.via && <span className="shipdash-by">· {e.via}</span>}`.

`styles/dashboard.css` — next to `.shipdash-feed-icon.k-status`:

```css
.shipdash-feed-icon.k-trip { color: var(--c-green); }
```

`components/trucks/TruckEditModal.tsx` — change `<label>Tracker id</label>` to `<label>Tracking name / ID</label>`.

`pages/TruckDetail.tsx`:
- import `listTruckEvents` and `type TruckEvent`;
- state `const [events, setEvents] = useState<TruckEvent[] | null>(null);` and a loader next to `loadUpdates`:

```tsx
  const loadEvents = useCallback(async () => {
    if (!id) return;
    try {
      setEvents(await listTruckEvents(id));
    } catch {
      setEvents([]);
    }
  }, [id]);
```

  (match the guard/shape `loadUpdates` uses), call it in the mount effect alongside `loadUpdates`, and after a successful clear (`void loadUpdates(); void loadEvents();`);
- tracking panel:

```tsx
              <dt>Tracking name / ID</dt><dd className="mono">{trackingStr('tracker_id') || '—'}</dd>
              {trackingStr('macropoint_order') && (
                <><dt>MacroPoint order</dt><dd className="mono">{trackingStr('macropoint_order')}</dd></>
              )}
```

- a panel right after "Location updates":

```tsx
        <div className="panel">
          <div className="panel-head"><h3>Trip events</h3></div>
          <div className="panel-body">
            <DataTable
              ariaLabel="Trip events"
              columns={[
                { key: 'when', label: 'When', mono: true },
                { key: 'event', label: 'Event' },
                { key: 'source', label: 'Source' },
              ]}
              rows={(events ?? []).map((e) => ({
                key: e.id,
                cells: [new Date(e.recorded_at).toLocaleString(), e.event, e.source || '—'],
              }))}
              emptyText="No trip events yet."
            />
          </div>
        </div>
```

- [ ] **Step 4: Run tests, type check, full portal suite, build**

Run: `npx vitest run src/lib/shipments.test.ts src/pages/TruckDetail.test.tsx src/pages/ShipmentsDashboard.test.tsx src/components/trucks && npx tsc -b && npx vitest run && npm run build`
Expected: all PASS; build succeeds.

- [ ] **Step 5: Commit**

```bash
git add portal/src/pages/TruckDetail.tsx portal/src/pages/TruckDetail.test.tsx portal/src/components/trucks/TruckEditModal.tsx portal/src/lib/shipments.ts portal/src/lib/shipments.test.ts portal/src/pages/ShipmentsDashboard.tsx portal/src/styles/dashboard.css
git commit -m "feat(portal): truck Trip events panel, Tracking name / ID label, trip events in the shipment feed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10 (controller): Final verification and closeout

Not a subagent task; the controller runs it after the final whole-branch review.

- [ ] **Step 1:** Full API suite (foreground, `SS_TEST_DB=serversherpa_test_macropoint`, timeout 600000, chunked if needed) and full portal suite + `npm run build`. Record counts.
- [ ] **Step 2:** Live verify on the dev stack from this worktree (ports 8001/5175 recipe in memory `bulk-workers-import` / `user-detail-feature`; the dev DB must be at 0097 — run `alembic upgrade head` against the dev DB only after checking no other worktree holds a different 0097). Sign in as claude-dev, open `/logistics/trucks` → Actions → Manual update. Create a test truck "MP Test" (status created). Drop the 11 fixtures + paste `pasted_outlook_two.txt`; pick "MP Test" for the JAMIE load; Apply; confirm the summary, the truck detail (5 updates/events, status At Destination, Tracking name / ID filled, MacroPoint order shown), the Shipments dashboard feed (trip events, "· MacroPoint" on the status rows). Re-apply → all "Already recorded". Then drop the whole `Sample Data/macropoint` folder (455 files) to check size/performance. Revert: Clear updates on MP Test, archive it.
- [ ] **Step 3:** Merge per the user's standing workflow (finishing-a-development-branch), update the wiki Features page row + change log and the parity tracker per `.claude/parity-sheet.md`, and save a project memory for the feature.
