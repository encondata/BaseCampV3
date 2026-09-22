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
    """A minimal initiative row. The model's NOT-NULL-without-default
    columns are `name` and `initiative_type` (see
    tests/test_initiative_assets_api.py::_move, which posts
    initiative_type="move"); the brief's `kind=` guess doesn't match the
    real column name, so this uses `initiative_type=` instead."""
    init = Initiative(name=name, initiative_type="move")
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
