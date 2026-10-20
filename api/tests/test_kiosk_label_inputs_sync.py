"""/kiosk/sync/assets (and its station twin) carry what an edge needs to
rebuild each asset's label values: raw RUs, the legacy id, and a
`label_context` for the move. Rebuilding with labels/label_values.py must
give back exactly the `label` map the portal computed."""

from datetime import UTC, date, datetime
from decimal import Decimal

from serversherpa.db.models import Asset, AssetModel, Initiative, InitiativeAsset, Site
from serversherpa.labels.label_values import LabelAsset, LabelMove, asset_label_values
from serversherpa.services import station_keys
from serversherpa.db.models import Device
from tests.test_kiosk_station_key import SERIAL, _device
from tests.test_sites_api import login


async def _seed(db):
    src = Site(name="Input Origin")
    dst = Site(name="Input Destination")
    db.add_all([src, dst])
    await db.flush()
    move = Initiative(name="Inputs Move", initiative_type="move", status="planned",
                      origin_site_id=src.id, destination_site_id=dst.id,
                      scheduled_start=datetime(2026, 9, 1, tzinfo=UTC))
    model = AssetModel(make="Dell", model="R740")
    db.add_all([move, model])
    await db.flush()
    assets = [Asset(name=f"srv-{i}", serial_number=f"SN{i}", model_id=model.id)
              for i in range(3)]
    db.add_all(assets)
    await db.flush()
    rus = [(Decimal("14"), Decimal("22.50")), (Decimal("14.50"), None), (None, None)]
    for a, (s_ru, d_ru) in zip(assets, rus, strict=True):
        db.add(InitiativeAsset(
            initiative_id=move.id, asset_id=a.id, source_rack="A1", source_ru=s_ru,
            source_position="A1.R2.U3", destination_rack="B2", destination_ru=d_ru,
            destination_position="B2.R4.U5"))
    await db.commit()
    return move


def _rebuild_all(body):
    ctx = body["label_context"]
    assert ctx is not None and ctx["catalog_keys"]
    move = LabelMove(ctx["move_name"],
                     date.fromisoformat(ctx["move_day"]) if ctx["move_day"] else None,
                     ctx["source_site"], ctx["destination_site"])
    assert ctx["move_day"] == "2026-09-01"
    for item in body["assets"]:
        assert isinstance(item["legacy_id"], int)
        asset = LabelAsset(
            item["legacy_id"], item["name"], item["serial_number"], item["make"],
            item["model"], item["source_rack"],
            Decimal(item["source_ru_raw"]) if item["source_ru_raw"] else None,
            item["source_position"], item["destination_rack"],
            Decimal(item["destination_ru_raw"]) if item["destination_ru_raw"] else None,
            item["destination_position"])
        assert asset_label_values(asset, move, ctx["catalog_keys"]) == item["label"]
    return {i["name"]: i for i in body["assets"]}


async def test_label_inputs_rebuild_the_portal_values(client, db, seeded_user):
    hdrs = await login(client)
    move = await _seed(db)
    r = await client.get("/kiosk/sync/assets", headers=hdrs,
                         params={"initiative_id": str(move.id)})
    assert r.status_code == 200, r.text
    rows = _rebuild_all(r.json())
    assert rows["srv-0"]["source_ru_raw"] == "14"
    assert rows["srv-0"]["destination_ru_raw"] == "22.50"
    assert rows["srv-2"]["source_ru_raw"] is None


async def test_station_twin_has_label_context(client, db, seeded_user):
    move = await _seed(db)
    move_id = move.id
    device, _init = await _device(db, current_initiative_id=move_id)
    live = await db.get(Device, device.id)
    key = await station_keys.issue(db, live, actor_id=None, via="password")
    await db.commit()
    r = await client.get("/kiosk/station/sync/assets",
                         headers={"Authorization": f"Station {key}"},
                         params={"serial": SERIAL, "initiative_id": str(move_id)})
    assert r.status_code == 200, r.text
    _rebuild_all(r.json())


# ── the label builder's fields (labels/fields.py) ────────────────────

CABLE_JSON = '{"data_1": "sw01/01", "data_4": "sw01/04", "mgmt_1": "sw03/01"}'


async def _seed_builder(db):
    """A coded move between coded sites, with three roster rows that cover
    a JSON cable_info, a free-text one, raw From-To rows and blanks."""
    src = Site(name="NAP9 - Vegas Origin", code="NAP9")
    dst = Site(name="NAP14 - Vegas Destination", code="NAP14")
    db.add_all([src, dst])
    await db.flush()
    move = Initiative(name="Builder Move", code="LV3", initiative_type="move",
                      status="planned", origin_site_id=src.id, destination_site_id=dst.id,
                      scheduled_start=datetime(2026, 10, 7, 13, tzinfo=UTC))
    model = AssetModel(make="Dell", model="R660")
    db.add_all([move, model])
    await db.flush()
    assets = [
        Asset(name="bld-0", serial_number="BLD0", model_id=model.id, rfid_tag="0" * 21 + "700",
              pod_number="P39", status="racked", has_rails=True, location_detail="F01 U18"),
        Asset(name="bld-1", serial_number="BLD1", status="pre_stage", has_rails=False),
        Asset(name="bld-2", serial_number="BLD2"),
    ]
    db.add_all(assets)
    await db.flush()
    db.add_all([
        InitiativeAsset(
            initiative_id=move.id, asset_id=assets[0].id, owner="Data Services",
            cable_info=CABLE_JSON, vendor_involved=True, status="labeled",
            source_rack="09.01.05D.02.10", source_ru=Decimal("33.20"),
            destination_rack="14.01.07C.02.03", destination_ru=Decimal("14.0"),
            destination_pod="D4", priority_wave="Wave 1", disposition="Relocate",
            raw_ft={"Notes": "Fragile", "Source Rack": "09.01.05D.02.10"}),
        InitiativeAsset(
            initiative_id=move.id, asset_id=assets[1].id, cable_info="2x 16G FC, 2x 10G",
            vendor_involved=False, status="rfid_1_cage_exit", source_ru=Decimal("3.50"),
            raw_ft={"Notes": "Heavy", "Data 1": "sw02/01"}),
        InitiativeAsset(initiative_id=move.id, asset_id=assets[2].id),
    ])
    await db.commit()
    return move


async def _builder_body(client, move):
    hdrs = await login(client)
    r = await client.get("/kiosk/sync/assets", headers=hdrs,
                         params={"initiative_id": str(move.id)})
    assert r.status_code == 200, r.text
    return r.json()


async def test_sync_item_carries_the_builder_fields(client, db, seeded_user):
    move = await _seed_builder(db)
    body = await _builder_body(client, move)
    ctx = body["label_context"]
    assert (ctx["move_code"], ctx["source_site_code"], ctx["destination_site_code"]) == (
        "LV3", "NAP9", "NAP14")
    assert (ctx["source_site"], ctx["destination_site"]) == (
        "NAP9 - Vegas Origin", "NAP14 - Vegas Destination")
    rows = {i["name"]: i for i in body["assets"]}

    one = rows["bld-0"]
    assert one["pod_number"] == "P39"
    assert (one["asset_status"], one["asset_status_label"]) == ("racked", "Racked")
    assert one["has_rails"] is True and one["location_detail"] == "F01 U18"
    assert one["owner"] == "Data Services"
    assert one["cable_info"] == {"data_1": "sw01/01", "data_4": "sw01/04", "mgmt_1": "sw03/01"}
    assert one["vendor_involved"] is True
    assert (one["roster_status"], one["roster_status_label"]) == ("labeled", "Labeled")
    assert one["raw_ft"] == {"Notes": "Fragile", "Source Rack": "09.01.05D.02.10"}
    # every field the sync already sent is still there
    assert one["source_ru"] == "33.2" and one["source_ru_raw"] == "33.20"
    assert one["destination_pod"] == "D4" and one["label"]["asset_name"] == "bld-0"

    two = rows["bld-1"]
    assert two["cable_info"] == {"text": "2x 16G FC, 2x 10G"}
    assert two["has_rails"] is False and two["vendor_involved"] is False
    assert two["roster_status_label"] == "RFID 1 - Cage Exit"
    assert two["asset_status_label"] == "Pre-Stage"

    three = rows["bld-2"]
    assert three["cable_info"] is None and three["raw_ft"] is None
    assert three["owner"] is None and three["has_rails"] is None
    assert three["vendor_involved"] is None and three["pod_number"] is None
    assert (three["roster_status"], three["roster_status_label"]) == (
        "loaded_in_system", "Loaded In System")
    assert (three["asset_status"], three["asset_status_label"]) == ("unknown", "Unknown")


async def test_field_values_match_portal_payload(client, db, seeded_user):
    """The edge computes field values from the sync JSON; the portal from
    asset_payload over ORM rows. Both must give the same dict."""
    from fastapi.encoders import jsonable_encoder
    from sqlalchemy import select

    from serversherpa.labels.fields import field_values
    from serversherpa.labels.generate.payloads import asset_payload, load_status_labels

    move = await _seed_builder(db)
    body = await _builder_body(client, move)
    ctx = body["label_context"]
    labels = await load_status_labels(db, "asset")
    items = {i["name"]: i for i in body["assets"]}
    rows = (await db.execute(
        select(Asset, InitiativeAsset, AssetModel)
        .join(InitiativeAsset, InitiativeAsset.asset_id == Asset.id)
        .outerjoin(AssetModel, AssetModel.id == Asset.model_id)
        .where(InitiativeAsset.initiative_id == move.id))).all()
    assert len(rows) == 3
    for asset, ia, model in rows:
        item = items[asset.name]
        payload = asset_payload(asset, ia, model, labels)
        # exactly the sync item's shape: the sync adds only the code-template
        # `label` map, which field_values never reads
        assert jsonable_encoder(payload) == {k: v for k, v in item.items() if k != "label"}
        assert field_values(item, ctx) == field_values(payload, ctx)

    zero = field_values(items["bld-0"], ctx)
    assert zero["ft:Notes"] == "Fragile" and zero["cable_data_4"] == "sw01/04"
    assert zero["source_ru"] == "33.2" and zero["destination_ru"] == "14"
    assert zero["move_code"] == "LV3" and zero["destination_site_code"] == "NAP14"
    assert zero["move_date"] == "10/07/2026" and zero["move_date_long"] == "07-OCT-2026"
    assert zero["has_rails"] == "Yes" and zero["roster_status"] == "Labeled"
    one = field_values(items["bld-1"], ctx)
    assert one["ft:Data 1"] == "sw02/01" and one["cable_data_1"] == ""
    assert one["source_ru"] == "3.5" and one["has_rails"] == "No"


async def test_container_field_values_match_portal_payload(client, db, seeded_user):
    from fastapi.encoders import jsonable_encoder
    from sqlalchemy import select

    from serversherpa.db.models import Container, ContainerAsset
    from serversherpa.labels.fields import field_values
    from serversherpa.labels.generate.payloads import container_payload, load_status_labels

    move = await _seed_builder(db)
    crate = Container(name="LV3-DC-01", initiative_id=move.id, legacy_id=4417,
                      rfid_tag="0" * 20 + "CR01", label_tag="ewaste",
                      container_type="d_container", status="in_transit",
                      site_id=move.origin_site_id)
    db.add(crate)
    await db.flush()
    asset_id = await db.scalar(select(Asset.id).where(Asset.name == "bld-0"))
    db.add(ContainerAsset(container_id=crate.id, asset_id=asset_id))
    await db.commit()
    hdrs = await login(client)
    r = await client.get("/kiosk/sync/containers", headers=hdrs,
                         params={"initiative_id": str(move.id)})
    assert r.status_code == 200, r.text
    (item,) = r.json()["containers"]
    ctx = (await _builder_body(client, move))["label_context"]
    site = await db.get(Site, move.origin_site_id)
    payload = container_payload(
        crate, status_labels=await load_status_labels(db, "container"),
        type_labels=await load_status_labels(db, "container_type"),
        site_name=site.name, asset_count=1)
    assert jsonable_encoder(payload) == item
    out = field_values(item, ctx)
    assert out == field_values(payload, ctx)
    assert (out["container_id"], out["label_tag"], out["container_type"],
            out["container_status"]) == ("4417", "E-WASTE", "D-container", "In transit")
