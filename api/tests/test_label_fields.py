"""The label builder's field catalog (labels/fields.py): the groups and keys,
one mock per key, and `field_values` on the kiosk sync item shape — plus
GET /labels/fields, which serves the catalog to the builder."""

import subprocess
import sys
from pathlib import Path

from serversherpa.db.models import Asset, Initiative, InitiativeAsset
from serversherpa.labels import fields
from serversherpa.labels.fields import (
    FIELD_GROUPS,
    MOCK_VALUES,
    PLACEHOLDER_MOCK_VALUES,
    field_values,
    ru_text,
)
from tests.test_sites_api import login
from tests.test_status_values_write import _make

ASSET_KEYS = [
    "asset_id", "asset_name", "serial_number", "rfid_tag", "pod_number",
    "asset_status", "has_rails", "location_detail",
]
MOVE_ROW_KEYS = [
    "source_rack", "source_ru", "source_position", "source_pod",
    "destination_rack", "destination_ru", "destination_position", "destination_pod",
    "priority_wave", "disposition", "owner",
    "cable_data_1", "cable_data_2", "cable_data_3", "cable_data_4", "cable_data_5",
    "cable_data_6", "cable_mgmt_1", "cable_mgmt_2", "vendor_involved", "roster_status",
]
MOVE_KEYS = ["move_name", "move_code", "move_date", "move_date_long"]
SITE_KEYS = ["origin_site_name", "origin_site_code",
             "destination_site_name", "destination_site_code"]
CONTAINER_KEYS = ["container_name", "container_id", "label_tag", "container_rfid_tag",
                  "container_type", "container_status"]
ASSET_TYPES = ["top", "front", "rail"]
ALL_TYPES = ["top", "front", "rail", "container", "container_info"]

ITEM = {
    "id": "6f1c2b0e-0000-4000-8000-000000000001",
    "asset_id": "100190", "legacy_id": 100190, "name": "lvn-hm1w2-vc1-c1n7",
    "rfid": "000000000000000000700022", "serial_number": "36b7144",
    "make": "Dell", "model": "R660", "make_model": "Dell R660",
    "container_id": None,
    "source_rack": "09.01.05D.02.10", "source_ru": "33.2", "source_ru_raw": "33.20",
    "source_position": "Front", "source_pod": "P4",
    "destination_rack": "14.01.07C.02.03", "destination_ru": "14",
    "destination_ru_raw": "14.0", "destination_position": None, "destination_pod": "D4",
    "priority_wave": "Wave 1", "disposition": "Relocate",
    "pod_number": "P39", "asset_status": "racked", "asset_status_label": "Racked",
    "has_rails": True, "location_detail": "F01 U18", "owner": "Data Services",
    "cable_info": {"data_1": "sw01/01", "data_3": "sw01/03", "mgmt_2": "sw03/02"},
    "vendor_involved": False, "roster_status": "labeled", "roster_status_label": "Labeled",
    "raw_ft": {"Notes": "Fragile", "Source Rack": "09.01.05D.02.10"},
    "label": {"asset_id": "100190", "source_ru": "U33.2"},
}
CTX = {
    "move_name": "Las Vegas Move", "move_code": "LV3", "move_day": "2026-10-07",
    "source_site": "INITECH-ORD1 - Initech Chicago DC", "source_site_code": "INITECH-ORD1",
    "destination_site": "DA11 - Equinix", "destination_site_code": None,
    "catalog_keys": ["asset_id", "source_ru"],
}
CONTAINER_ITEM = {
    "id": "6f1c2b0e-0000-4000-8000-000000000002", "name": "ORD1-DC-25",
    "legacy_id": 4417, "rfid_tag": "000000000000000875310678", "label_tag": "ewaste",
    "container_type": "d_container", "container_type_label": "D-container",
    "status": "in_transit", "status_label": "In Transit",
    "site_id": None, "site_name": None, "asset_count": 12,
}


def _keys(group_key):
    return [f["key"] for f in next(g for g in FIELD_GROUPS if g["key"] == group_key)["fields"]]


def test_catalog_keys_are_unique_and_grouped():
    assert [(g["key"], g["label"]) for g in FIELD_GROUPS] == [
        ("asset", "Asset"), ("model", "Make & model"), ("move_row", "On this move"),
        ("move", "Move"), ("sites", "Sites"), ("container", "Container")]
    assert _keys("asset") == ASSET_KEYS
    assert _keys("model") == ["make_model"]
    assert _keys("move_row") == MOVE_ROW_KEYS
    assert _keys("move") == MOVE_KEYS
    assert _keys("sites") == SITE_KEYS
    assert _keys("container") == CONTAINER_KEYS
    types = {g["key"]: g["label_types"] for g in FIELD_GROUPS}
    assert types == {"asset": ASSET_TYPES, "model": ASSET_TYPES, "move_row": ASSET_TYPES,
                     "move": ALL_TYPES, "sites": ALL_TYPES,
                     "container": ["container", "container_info"]}
    every = [f["key"] for g in FIELD_GROUPS for f in g["fields"]]
    assert len(every) == len(set(every))
    assert not [k for k in every if k.startswith("ft:")]
    for group in FIELD_GROUPS:
        for f in group["fields"]:
            assert set(f) == {"key", "label", "kind", "mock"}
            assert f["label"] and f["kind"] in ("text", "number", "date")
    kinds = {f["key"]: f["kind"] for g in FIELD_GROUPS for f in g["fields"]}
    assert kinds["source_ru"] == kinds["destination_ru"] == "number"
    assert kinds["move_date"] == kinds["move_date_long"] == "date"
    assert kinds["source_rack"] == "text"


def test_groups_for_a_label_type():
    def keys(label_type):
        return [g["key"] for g in fields.groups_for(label_type)]

    for t in ASSET_TYPES:
        assert keys(t) == ["asset", "model", "move_row", "move", "sites"]
    for t in ("container", "container_info"):
        assert keys(t) == ["move", "sites", "container"]
    # a type outside the five is an asset label, as labels.generate has it
    assert keys("shelf") == keys("top")
    assert keys(None) == [g["key"] for g in FIELD_GROUPS]
    from serversherpa.labels.generate import ENTITY_FOR_TYPE
    assert set(fields.CONTAINER_LABEL_TYPES) == {
        t for t, entity in ENTITY_FOR_TYPE.items() if entity == "container"}


def test_mock_values_cover_every_key():
    every = [f for g in FIELD_GROUPS for f in g["fields"]]
    assert set(MOCK_VALUES) == {f["key"] for f in every}
    for f in every:
        assert f["mock"] == MOCK_VALUES[f["key"]], f["key"]
        assert MOCK_VALUES[f["key"]], f["key"]
    assert MOCK_VALUES["destination_rack"] == "14.01.07C.02.03"
    assert MOCK_VALUES["source_rack"] == "09.01.05D.02.10"
    # the builder's RU fields are bare numbers; the code-template catalog
    # keeps its U12 form
    assert MOCK_VALUES["source_ru"] == MOCK_VALUES["destination_ru"] == "12"
    assert PLACEHOLDER_MOCK_VALUES["source_ru"] == "U12"
    shared = (set(MOCK_VALUES) & set(PLACEHOLDER_MOCK_VALUES)) - {"source_ru", "destination_ru"}
    assert shared == {"asset_id", "asset_name", "serial_number", "make_model", "move_name",
                      "move_date", "move_date_long", "container_name", "container_id",
                      "label_tag"}
    for key in shared:
        assert MOCK_VALUES[key] == PLACEHOLDER_MOCK_VALUES[key], key


def test_the_kiosk_test_label_reads_the_placeholder_mocks_from_fields():
    from serversherpa.api.routes import kiosk as kiosk_routes

    assert kiosk_routes.MOCK_VALUES is PLACEHOLDER_MOCK_VALUES


def test_field_values_from_a_sync_item():
    assert field_values(ITEM, CTX) == {
        "asset_id": "100190", "asset_name": "lvn-hm1w2-vc1-c1n7",
        "serial_number": "36b7144", "rfid_tag": "000000000000000000700022",
        "pod_number": "P39", "asset_status": "Racked", "has_rails": "Yes",
        "location_detail": "F01 U18",
        "make_model": "Dell R660",
        "source_rack": "09.01.05D.02.10", "source_ru": "33.2", "source_position": "Front",
        "source_pod": "P4",
        "destination_rack": "14.01.07C.02.03", "destination_ru": "14",
        "destination_position": "", "destination_pod": "D4",
        "priority_wave": "Wave 1", "disposition": "Relocate", "owner": "Data Services",
        "cable_data_1": "sw01/01", "cable_data_2": "", "cable_data_3": "sw01/03",
        "cable_data_4": "", "cable_data_5": "", "cable_data_6": "",
        "cable_mgmt_1": "", "cable_mgmt_2": "sw03/02",
        "vendor_involved": "No", "roster_status": "Labeled",
        "move_name": "Las Vegas Move", "move_code": "LV3",
        "move_date": "10/07/2026", "move_date_long": "07-OCT-2026",
        "origin_site_name": "INITECH-ORD1 - Initech Chicago DC",
        "origin_site_code": "INITECH-ORD1",
        "destination_site_name": "DA11 - Equinix", "destination_site_code": "",
        "ft:Notes": "Fragile", "ft:Source Rack": "09.01.05D.02.10",
    }


def test_field_values_blanks_and_free_text_cable_info():
    item = {**ITEM, "has_rails": None, "vendor_involved": True, "raw_ft": None,
            "cable_info": {"text": "2x 16G FC, 2x 10G"}, "asset_status": None,
            "asset_status_label": None, "pod_number": None}
    out = field_values(item, {**CTX, "move_day": None, "move_code": None})
    assert out["has_rails"] == "" and out["vendor_involved"] == "Yes"
    assert [out[f"cable_data_{i}"] for i in range(1, 7)] == [""] * 6
    assert out["cable_mgmt_1"] == out["cable_mgmt_2"] == ""
    assert out["asset_status"] == out["pod_number"] == ""
    assert out["move_date"] == out["move_date_long"] == out["move_code"] == ""
    assert not [k for k in out if k.startswith("ft:")]
    # a status label falls back to the key when the label is missing
    assert field_values({**ITEM, "roster_status_label": None}, CTX)["roster_status"] == "labeled"
    # the context may carry a date instead of its ISO text
    from datetime import date
    assert field_values(ITEM, {**CTX, "move_day": date(2026, 10, 7)}) == field_values(ITEM, CTX)


def test_field_values_from_a_container_item():
    assert field_values(CONTAINER_ITEM, CTX) == {
        "container_name": "ORD1-DC-25", "container_id": "4417", "label_tag": "E-WASTE",
        "container_rfid_tag": "000000000000000875310678",
        "container_type": "D-container", "container_status": "In Transit",
        "move_name": "Las Vegas Move", "move_code": "LV3",
        "move_date": "10/07/2026", "move_date_long": "07-OCT-2026",
        "origin_site_name": "INITECH-ORD1 - Initech Chicago DC",
        "origin_site_code": "INITECH-ORD1",
        "destination_site_name": "DA11 - Equinix", "destination_site_code": "",
    }
    untagged = field_values({**CONTAINER_ITEM, "label_tag": None, "legacy_id": None}, CTX)
    assert untagged["label_tag"] == "CONTAINER" and untagged["container_id"] == ""


def test_ru_text_is_bare():
    assert ru_text("14.0") == "14"
    assert ru_text("3.50") == "3.5"
    assert ru_text("100") == "100"
    assert ru_text("33.2") == "33.2"
    assert ru_text(None) == "" and ru_text("") == ""
    out = field_values({**ITEM, "source_ru_raw": "14.0", "destination_ru_raw": "3.50"}, CTX)
    assert (out["source_ru"], out["destination_ru"]) == ("14", "3.5")
    # without the raw text the bare `*_ru` the sync also sends is used
    out = field_values({**ITEM, "source_ru_raw": None, "source_ru": "22.5"}, CTX)
    assert out["source_ru"] == "22.5"


def test_fields_module_stays_pure():
    """The laptop edge imports serversherpa.labels from api/src without
    sqlalchemy or the API, so fields.py may not pull either in."""
    src = Path(fields.__file__).resolve().parents[2]
    code = ("import sys; import serversherpa.labels.fields; "
            "bad = sorted(m for m in sys.modules if m.split('.')[0] in "
            "('sqlalchemy', 'fastapi', 'pydantic') or m.startswith(("
            "'serversherpa.db', 'serversherpa.api', 'serversherpa.services', "
            "'serversherpa.labels.generate'))); print(bad); sys.exit(1 if bad else 0)")
    run = subprocess.run([sys.executable, "-c", code], env={"PYTHONPATH": str(src)}, check=False,
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stdout + run.stderr


# ── GET /labels/fields ───────────────────────────────────────────────


async def _seed_raw_ft(db):
    move = Initiative(name="Headers Move", initiative_type="move", status="planned")
    db.add(move)
    await db.flush()
    assets = [Asset(name=f"hdr-{i}", serial_number=f"HDR{i}") for i in range(3)]
    db.add_all(assets)
    await db.flush()
    for asset, raw in zip(assets, (
            {"Notes": "Fragile", "Data 10": "x", "Asset Name": "hdr-0"},
            {"Data 2": "y", "Notes": "Heavy"},
            None), strict=True):
        db.add(InitiativeAsset(initiative_id=move.id, asset_id=asset.id, raw_ft=raw))
    await db.commit()


async def test_fields_route_filters_groups_by_label_type(client, db, seeded_user):
    await _seed_raw_ft(db)
    hdrs = await login(client)

    r = await client.get("/labels/fields", headers=hdrs, params={"label_type": "top"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [g["key"] for g in body["groups"]] == ["asset", "model", "move_row", "move", "sites"]
    assert body["groups"][0]["fields"][0] == {
        "key": "asset_id", "label": "Asset ID", "kind": "number", "mock": "100000"}
    assert body["ft_headers"] == ["Asset Name", "Data 2", "Data 10", "Notes"]

    r = await client.get("/labels/fields", headers=hdrs, params={"label_type": "container"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [g["key"] for g in body["groups"]] == ["move", "sites", "container"]
    # container rows carry no From-To row
    assert body["ft_headers"] == []

    r = await client.get("/labels/fields", headers=hdrs)
    assert [g["key"] for g in r.json()["groups"]] == [g["key"] for g in FIELD_GROUPS]


async def test_ft_headers_leave_out_archived_moves(client, db, seeded_user):
    """ledger B11: the From-To headers come from the rosters of moves still
    in play; an archived move's columns are not offered."""
    from datetime import UTC, datetime

    await _seed_raw_ft(db)
    old = Initiative(name="Old Move", initiative_type="move", status="completed",
                     archived_at=datetime.now(UTC))
    asset = Asset(name="hdr-old", serial_number="HDROLD")
    db.add_all([old, asset])
    await db.flush()
    db.add(InitiativeAsset(initiative_id=old.id, asset_id=asset.id,
                           raw_ft={"Retired Column": "x", "Notes": "y"}))
    await db.commit()
    r = await client.get("/labels/fields", headers=await login(client),
                         params={"label_type": "top"})
    assert r.status_code == 200, r.text
    assert r.json()["ft_headers"] == ["Asset Name", "Data 2", "Data 10", "Notes"]


async def test_fields_route_needs_labels_view(client, db, seeded_user):
    hdrs = await _make(db, client, "worker", "worker@test.example.com")
    r = await client.get("/labels/fields", headers=hdrs, params={"label_type": "top"})
    assert r.status_code == 403, r.text
    assert (await client.get("/labels/fields")).status_code == 401


def test_design_field_keys_reads_schema_2_only_and_tolerates_odd_schemas():
    from serversherpa.labels.fields import design_field_keys
    from serversherpa.labels.template_fonts import design_fonts

    els = [{"id": "a", "type": "field", "field": "ft:Notes"}, {"id": "b", "type": "line"},
           {"id": "c", "type": "qr", "field": "asset_id"}, "junk"]
    assert design_field_keys({"schema": 2, "elements": els}) == {"ft:Notes", "asset_id"}
    for odd in ("2", None, True, 2.0, [2]):
        assert design_field_keys({"schema": odd, "elements": els}) == set()
        assert design_fonts({"schema": odd, "elements": els}) == set()
    assert design_field_keys({"elements": els}) == set()
    assert design_field_keys(None) == set()


# ── GET /labels/sample-values ────────────────────────────────────────


async def test_sample_values_are_one_assets_field_values(client, db, seeded_user):
    """Load from asset…: one roster asset's values exactly as the kiosk
    sync item gives them to field_values, but with the whole From-To row
    (the builder samples columns no template places yet)."""
    from sqlalchemy import select

    from tests.test_kiosk_label_inputs_sync import _builder_body, _seed_builder

    move = await _seed_builder(db)
    zero = await db.scalar(select(Asset).where(Asset.name == "bld-0"))
    one = await db.scalar(select(Asset).where(Asset.name == "bld-1"))
    # the builder's rank (a super admin)
    hdrs = await _make(db, client, "super_admin", "sa@test.example.com")

    r = await client.get("/labels/sample-values", headers=hdrs,
                         params={"initiative_id": str(move.id), "asset_id": str(zero.id)})
    assert r.status_code == 200, r.text
    values = r.json()
    body = await _builder_body(client, move)
    item = next(i for i in body["assets"] if i["name"] == "bld-0")
    ctx = {k: v for k, v in body["label_context"].items() if k != "catalog_keys"}
    assert values == field_values(item, ctx)
    assert values["destination_rack"] == "14.01.07C.02.03"
    assert values["destination_ru"] == "14" and values["source_ru"] == "33.2"
    assert values["make_model"] == "Dell R660" and values["move_code"] == "LV3"
    assert values["ft:Notes"] == "Fragile"

    r = await client.get("/labels/sample-values", headers=hdrs,
                         params={"initiative_id": str(move.id), "asset_id": str(one.id)})
    assert r.status_code == 200, r.text
    values = r.json()
    # every From-To column of the row, placed by a template or not
    assert values["ft:Notes"] == "Heavy" and values["ft:Data 1"] == "sw02/01"
    assert values["source_ru"] == "3.5" and values["cable_data_1"] == ""


async def test_sample_values_404s(client, db, seeded_user):
    import uuid

    from sqlalchemy import select

    from tests.test_kiosk_label_inputs_sync import _seed_builder

    move = await _seed_builder(db)
    zero = await db.scalar(select(Asset).where(Asset.name == "bld-0"))
    other = Initiative(name="Other Move", initiative_type="move", status="planned")
    stray = Asset(name="stray", serial_number="STRAY")
    db.add_all([other, stray])
    await db.commit()
    hdrs = await _make(db, client, "super_admin", "sa@test.example.com")

    async def get(initiative_id, asset_id):
        return await client.get("/labels/sample-values", headers=hdrs, params={
            "initiative_id": str(initiative_id), "asset_id": str(asset_id)})

    r = await get(uuid.uuid4(), zero.id)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "initiative_not_found"
    # on a roster, but not this move's
    r = await get(other.id, zero.id)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "asset_not_on_move"
    r = await get(move.id, stray.id)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "asset_not_on_move"
    r = await get(move.id, "not-a-uuid")
    assert r.status_code == 422


async def test_sample_values_need_labels_view_and_rank_80(client, db, seeded_user):
    import uuid

    from sqlalchemy import select

    from tests.test_kiosk_label_inputs_sync import _seed_builder

    move = await _seed_builder(db)
    zero = await db.scalar(select(Asset).where(Asset.name == "bld-0"))
    params = {"initiative_id": str(move.id), "asset_id": str(zero.id)}
    hdrs = await _make(db, client, "worker", "worker@test.example.com")
    r = await client.get("/labels/sample-values", headers=hdrs, params=params)
    assert r.status_code == 403, r.text
    # labels:view at rank 60 still reads the field catalog, not an asset's
    # whole From-To row: that is the builder's (rank 80)
    admin = await _make(db, client, "admin", "adm@test.example.com")
    assert (await client.get("/labels/fields", headers=admin)).status_code == 200
    r = await client.get("/labels/sample-values", headers=admin, params=params)
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == {"code": "forbidden", "min_rank": 80}
    assert (await client.get("/labels/sample-values", params=params)).status_code == 401
