"""Warehouse API — sites with counts, per-site inventory, stock CRUD."""

import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from serversherpa.db.models import (
    Asset, AssetModel, AuditLog, Container, ContainerAsset, Person,
    PersonRole, Site, StockLine,
)

from .test_assets_api import login, make_login


async def _wh(db, name="ACC4 Storage"):
    site = Site(name=name, site_type="warehouse")
    db.add(site)
    await db.flush()
    return site


async def test_sites_lists_only_warehouses_with_counts(client, db, seeded_user):
    hdrs = await login(client)
    wh = await _wh(db)
    db.add(Site(name="Not a warehouse", site_type="datacenter"))
    box = Container(name="Pallet A-01", site_id=wh.id, container_type="pallet")
    db.add(box)
    await db.flush()
    asset = Asset(name="srv-1", site_id=wh.id, status="in_storage")
    db.add(asset)
    await db.flush()
    db.add(ContainerAsset(container_id=box.id, asset_id=asset.id))
    db.add(StockLine(site_id=wh.id, container_id=box.id, description="PDU", quantity=24))
    db.add(StockLine(site_id=wh.id, description="cage nuts", quantity=40, unit="bag"))
    db.add(StockLine(site_id=wh.id, description="archived", quantity=5,
                     archived_at=datetime.now(UTC)))
    await db.commit()

    resp = await client.get("/warehouse/sites", headers=hdrs)
    assert resp.status_code == 200, resp.text
    rows = resp.json()
    assert [r["name"] for r in rows] == ["ACC4 Storage"]
    r = rows[0]
    assert (r["container_count"], r["asset_count"], r["stock_line_count"],
            r["stock_units"]) == (1, 1, 2, 64)


async def test_inventory_shape(client, db, seeded_user):
    hdrs = await login(client)
    wh = await _wh(db)
    box = Container(name="Crate C-07", site_id=wh.id, container_type="crate")
    other = Container(name="Elsewhere")
    db.add_all([box, other])
    await db.flush()
    inside = Asset(name="srv-in", serial_number="SN-IN", site_id=wh.id)
    loose = Asset(name="srv-loose", site_id=wh.id)
    away = Asset(name="srv-away")
    db.add_all([inside, loose, away])
    await db.flush()
    db.add(ContainerAsset(container_id=box.id, asset_id=inside.id))
    model = AssetModel(make="APC", model="AP8941")
    db.add(model)
    await db.flush()
    db.add(StockLine(site_id=wh.id, container_id=box.id, model_id=model.id,
                     description="PDU", quantity=24))
    db.add(StockLine(site_id=wh.id, description="Cage nuts", quantity=40,
                     unit="bag", location_detail="Shelf B"))
    await db.commit()

    resp = await client.get(f"/warehouse/{wh.id}/inventory", headers=hdrs)
    assert resp.status_code == 200, resp.text
    inv = resp.json()
    assert inv["site"]["name"] == "ACC4 Storage"
    assert len(inv["containers"]) == 1
    c = inv["containers"][0]
    assert c["type_label"] == "Crate"
    assert [a["serial_number"] for a in c["assets"]] == ["SN-IN"]
    assert c["stock"][0]["model_make"] == "APC"
    assert c["stock"][0]["container_name"] == "Crate C-07"
    assert [a["name"] for a in inv["loose_assets"]] == ["srv-loose"]
    assert [s["description"] for s in inv["loose_stock"]] == ["Cage nuts"]
    assert inv["loose_stock"][0]["location_detail"] == "Shelf B"

    dc = Site(name="DC", site_type="datacenter")
    db.add(dc)
    await db.commit()
    resp = await client.get(f"/warehouse/{dc.id}/inventory", headers=hdrs)
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "site_not_warehouse"
    resp = await client.get(f"/warehouse/{uuid.uuid4()}/inventory", headers=hdrs)
    assert resp.status_code == 404


async def test_stock_crud_placement_and_audit(client, db, seeded_user):
    hdrs = await login(client)
    wh = await _wh(db)
    other_wh = await _wh(db, "DA11 Storage")
    box = Container(name="Pallet A-01", site_id=wh.id)
    far = Container(name="Far", site_id=other_wh.id)
    db.add_all([box, far])
    await db.commit()

    resp = await client.post("/warehouse/stock", headers=hdrs, json={
        "site_id": str(wh.id), "container_id": str(far.id),
        "description": "PDU", "quantity": 24})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "container_not_at_site"

    resp = await client.post("/warehouse/stock", headers=hdrs, json={
        "site_id": str(wh.id), "container_id": str(box.id),
        "description": "PDU", "quantity": 24})
    assert resp.status_code == 201, resp.text
    line = resp.json()
    assert line["unit"] == "each" and line["container_name"] == "Pallet A-01"
    lid = line["id"]

    resp = await client.post("/warehouse/stock", headers=hdrs, json={
        "site_id": str(wh.id), "description": "  ", "quantity": 1})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "description_required"

    resp = await client.post("/warehouse/stock", headers=hdrs, json={
        "site_id": str(wh.id), "description": "neg", "quantity": -1})
    assert resp.status_code == 422

    resp = await client.patch(f"/warehouse/stock/{lid}", headers=hdrs,
                              json={"quantity": 20, "container_id": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["quantity"] == 20
    assert resp.json()["container_id"] is None

    resp = await client.patch(f"/warehouse/stock/{lid}", headers=hdrs,
                              json={"description": None})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "description_required"

    resp = await client.patch(f"/warehouse/stock/{lid}", headers=hdrs,
                              json={"container_id": str(far.id)})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "container_not_at_site"

    resp = await client.patch(f"/warehouse/stock/{lid}", headers=hdrs,
                              json={"site_id": str(other_wh.id), "container_id": str(far.id)})
    assert resp.status_code == 200, resp.text
    assert resp.json()["site_name"] == "DA11 Storage"

    resp = await client.patch(f"/warehouse/stock/{lid}", headers=hdrs,
                              json={"bogus": 1})
    assert resp.status_code == 422

    resp = await client.post(f"/warehouse/stock/{lid}/archive", headers=hdrs)
    assert resp.status_code == 204
    inv = (await client.get(f"/warehouse/{other_wh.id}/inventory", headers=hdrs)).json()
    assert inv["containers"][0]["stock"] == []
    resp = await client.post(f"/warehouse/stock/{lid}/unarchive", headers=hdrs)
    assert resp.status_code == 204

    actions = list(await db.scalars(
        select(AuditLog.action).where(AuditLog.entity_type == "stock_line",
                                      AuditLog.entity_id == lid)))
    assert {"create", "update", "archive", "unarchive"} <= set(actions)
    upd = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "stock_line", AuditLog.entity_id == lid,
        AuditLog.action == "update").order_by(AuditLog.at))
    assert upd.changes["quantity"] == {"from": 24, "to": 20}


async def test_worker_is_forbidden(client, db, seeded_user):
    worker = Person(first_name="Wanda", last_name="Worker")
    db.add(worker)
    await db.flush()
    db.add(PersonRole(person_id=worker.id, role="worker"))
    await db.commit()
    hdrs = await make_login(db, client, worker, "wh-worker@test.example.com")
    resp = await client.get("/warehouse/sites", headers=hdrs)
    assert resp.status_code == 403
