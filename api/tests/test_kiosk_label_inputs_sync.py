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
