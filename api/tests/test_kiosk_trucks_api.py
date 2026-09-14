"""GET /kiosk/sync/trucks and POST /kiosk/trucks/{id}/containers — the
kiosk's Trucks screen. The sync feeds the kiosk's local copy of the
move's trucks (a card picker: trucks carry no RFID tag); the load/unload
endpoint writes membership, one audit row, and one `raw_scans` row in ONE
transaction. `truck_containers` is keyed on (truck_id, container_id), so
loading a container that is riding another truck MOVES it. Gated on
kiosk:view; blocked under read-only mode (it writes)."""

import uuid

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, AuditLog, Container, ContainerAsset, Device, Initiative, ProcessedScan,
    RawScan, Site, StatusValue, Truck, TruckContainer,
)
from serversherpa.scans import worker
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_sites_api import login
from tests.test_status_values_write import _make
from tests.test_system_admin_api import _admin

SERIAL = "kiosk-web-trucks-1"


async def _seed(db):
    """A kiosk device set up for a move, two trucks on that move, two
    containers to load, an asset inside one of them, and the checkpoint
    the load/unload scan records."""
    site = Site(name="NAP11 Dock")
    dest = Site(name="ACC4 Receiving")
    initiative = Initiative(name="NAP11 Truck Move", initiative_type="move",
                            status="in_progress")
    checkpoint = StatusValue(record_type="asset", key="truck_test_on_truck",
                             label="Truck Test On Truck", color="#123456",
                             sort_order=1, is_active=True)
    db.add_all([site, dest, initiative, checkpoint])
    await db.flush()
    for record_type, key, label in (("container", "available", "Available"),
                                    ("truck", "in_transit", "In Transit")):
        if await db.scalar(select(StatusValue).where(
                StatusValue.record_type == record_type,
                StatusValue.key == key)) is None:
            db.add(StatusValue(record_type=record_type, key=key, label=label,
                               color="#2e7d32", sort_order=0, is_active=True))
    device = Device(device_type="kiosk", name="Kiosk Truck Target", serial=SERIAL,
                    site_id=site.id, current_initiative_id=initiative.id,
                    scan_status=checkpoint.key)
    truck = Truck(name="TRUCK-1", load_number="L-9001", status="in_transit",
                  driver_name="Dana Driver", initiative_id=initiative.id,
                  start_site_id=site.id, end_site_id=dest.id)
    other = Truck(name="TRUCK-2", load_number="L-9002", status="in_transit",
                  initiative_id=initiative.id)
    crate = Container(name="LOAD-CRATE-1", container_type="shipping_container",
                      status="available", site_id=site.id,
                      initiative_id=initiative.id)
    crate2 = Container(name="LOAD-CRATE-2", status="available",
                       initiative_id=initiative.id)
    asset = Asset(name="Load Me", serial_number="SN-LOAD-1", legacy_id=88001)
    db.add_all([device, truck, other, crate, crate2, asset])
    await db.flush()
    db.add(ContainerAsset(container_id=crate.id, asset_id=asset.id))
    await db.flush()
    return site, dest, initiative, checkpoint, device, truck, other, crate, crate2, asset


def _body(container_id, action="load", **kw):
    return {"serial": kw.pop("serial", SERIAL),
            "container_id": str(container_id),
            "action": action,
            "scanned_value": kw.pop("scanned_value", "LOAD-CRATE-1"),
            "scan_type": kw.pop("scan_type", "barcode"),
            "scan_status": kw.pop("scan_status", "truck_test_on_truck"),
            "client_scan_id": kw.pop("client_scan_id", str(uuid.uuid4())),
            **kw}


async def _post(client, hdrs, truck_id, container_id, **kw):
    return await client.post(f"/kiosk/trucks/{truck_id}/containers",
                             headers=hdrs, json=_body(container_id, **kw))


# ── sync ─────────────────────────────────────────────────────────────

async def test_sync_returns_the_moves_trucks_with_container_counts(
        client, db, seeded_user):
    hdrs = await login(client)
    site, dest, initiative, _cp, _device, truck, _other, crate, _crate2, _asset = (
        await _seed(db))
    db.add(TruckContainer(truck_id=truck.id, container_id=crate.id))
    await db.commit()
    truck_id, site_id, dest_id = truck.id, site.id, dest.id

    resp = await client.get("/kiosk/sync/trucks", headers=hdrs,
                            params={"initiative_id": str(initiative.id)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["initiative_id"] == str(initiative.id)
    rows = {t["name"]: t for t in body["trucks"]}
    assert set(rows) == {"TRUCK-1", "TRUCK-2"}
    one = rows["TRUCK-1"]
    assert one["id"] == str(truck_id)
    assert one["load_number"] == "L-9001"
    assert one["status"] == "in_transit"
    assert one["status_label"] == "In Transit"
    assert one["driver_name"] == "Dana Driver"
    assert one["start_site_id"] == str(site_id)
    assert one["start_site_name"] == "NAP11 Dock"
    assert one["end_site_id"] == str(dest_id)
    assert one["end_site_name"] == "ACC4 Receiving"
    assert one["container_count"] == 1
    assert rows["TRUCK-2"]["container_count"] == 0
    assert rows["TRUCK-2"]["start_site_id"] is None
    assert rows["TRUCK-2"]["driver_name"] is None


async def test_sync_excludes_archived_trucks_and_other_moves(
        client, db, seeded_user):
    hdrs = await login(client)
    _site, _dest, initiative, _cp, _device, truck, _other, *_ = await _seed(db)
    from datetime import UTC, datetime
    truck.archived_at = datetime.now(UTC)
    elsewhere = Initiative(name="Another Truck Move", initiative_type="move",
                           status="planned")
    db.add(elsewhere)
    await db.flush()
    db.add(Truck(name="NOT-OURS", status="in_transit", initiative_id=elsewhere.id))
    await db.commit()

    resp = await client.get("/kiosk/sync/trucks", headers=hdrs,
                            params={"initiative_id": str(initiative.id)})
    assert resp.status_code == 200, resp.text
    assert [t["name"] for t in resp.json()["trucks"]] == ["TRUCK-2"]


async def test_sync_unknown_move_is_404_and_a_non_move_is_422(
        client, db, seeded_user):
    hdrs = await login(client)
    await _seed(db)
    project = Initiative(name="A Truck Project", initiative_type="project",
                         status="planned")
    db.add(project)
    await db.commit()

    resp = await client.get("/kiosk/sync/trucks", headers=hdrs,
                            params={"initiative_id": str(uuid.uuid4())})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "initiative_not_found"

    resp = await client.get("/kiosk/sync/trucks", headers=hdrs,
                            params={"initiative_id": str(project.id)})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_initiative"


async def test_sync_permission(client, db, seeded_user):
    _site, _dest, initiative, *_ = await _seed(db)
    await db.commit()
    initiative_id = initiative.id
    cv = await _client_viewer(db, client, "cv-sync-trucks@test.example.com")
    resp = await client.get("/kiosk/sync/trucks", headers=cv,
                            params={"initiative_id": str(initiative_id)})
    assert resp.status_code == 403
    anon = await client.get("/kiosk/sync/trucks",
                            params={"initiative_id": str(initiative_id)})
    assert anon.status_code == 401


# ── load ─────────────────────────────────────────────────────────────

async def test_load_writes_the_link_one_audit_row_and_one_scan(
        client, db, seeded_user):
    hdrs = await login(client)
    actor_id = seeded_user.id
    site, _dest, initiative, checkpoint, device, truck, _other, crate, *_ = (
        await _seed(db))
    await db.commit()
    (truck_id, crate_id, device_id, device_name, site_id, initiative_id, key) = (
        truck.id, crate.id, device.id, device.name, site.id, initiative.id,
        checkpoint.key)

    client_scan_id = str(uuid.uuid4())
    resp = await _post(client, hdrs, truck_id, crate_id,
                       client_scan_id=client_scan_id,
                       site_id=str(site_id), initiative_id=str(initiative_id))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "load"
    assert body["already_there"] is False
    assert body["moved_from"] is None
    assert body["truck"] == {"id": str(truck_id), "name": "TRUCK-1",
                             "container_count": 1}
    assert body["container"] == {"id": str(crate_id), "name": "LOAD-CRATE-1",
                                 "asset_count": 1}

    db.expire_all()
    rows = (await db.scalars(select(TruckContainer).where(
        TruckContainer.container_id == crate_id))).all()
    assert len(rows) == 1
    assert rows[0].truck_id == truck_id

    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_truck_load"))).all()
    assert len(audit) == 1
    assert audit[0].entity_type == "truck"
    assert audit[0].entity_id == str(truck_id)
    assert audit[0].actor_person_id == actor_id
    assert audit[0].changes == {"container_id": str(crate_id),
                                "container_name": "LOAD-CRATE-1",
                                "asset_count": 1, "from_truck": None,
                                "device": device_name}

    scan = (await db.scalars(select(RawScan))).one()
    assert scan.scanned_value == "LOAD-CRATE-1"
    assert scan.scan_type == "barcode"
    assert scan.status == key
    assert scan.scan_status == key
    assert scan.device_id == device_name
    assert scan.operator_id == actor_id
    assert scan.site_id == site_id
    assert scan.initiative_id == initiative_id
    assert scan.source == "kiosk"
    assert str(scan.client_scan_id) == client_scan_id
    assert scan.match_attempted_at is None      # the worker's "fresh row" marker

    kiosk = await db.get(Device, device_id)
    assert kiosk.last_seen_at is not None


async def test_the_scan_falls_back_to_the_devices_site_and_move(
        client, db, seeded_user):
    hdrs = await login(client)
    site, _dest, initiative, _cp, _device, truck, _other, crate, *_ = await _seed(db)
    await db.commit()
    site_id, initiative_id = site.id, initiative.id

    assert (await _post(client, hdrs, truck.id, crate.id)).status_code == 200

    db.expire_all()
    scan = (await db.scalars(select(RawScan))).one()
    assert scan.site_id == site_id
    assert scan.initiative_id == initiative_id


async def test_loading_a_container_held_by_another_truck_moves_it(
        client, db, seeded_user):
    """`truck_containers` is keyed on (truck_id, container_id), and a
    crate rides one truck at a time — so loading one that is already on
    another truck is a move, and the answer says where from."""
    hdrs = await login(client)
    *_, truck, other, crate, _crate2, _asset = await _seed(db)
    db.add(TruckContainer(truck_id=other.id, container_id=crate.id))
    await db.commit()
    truck_id, other_id, crate_id = truck.id, other.id, crate.id

    resp = await _post(client, hdrs, truck_id, crate_id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["moved_from"] == {"id": str(other_id), "name": "TRUCK-2"}
    assert body["already_there"] is False
    assert body["truck"]["container_count"] == 1

    db.expire_all()
    rows = (await db.scalars(select(TruckContainer).where(
        TruckContainer.container_id == crate_id))).all()
    assert len(rows) == 1
    assert rows[0].truck_id == truck_id
    assert (await db.scalars(select(TruckContainer).where(
        TruckContainer.truck_id == other_id))).all() == []

    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_truck_load"))).one()
    assert audit.changes["from_truck"] == "TRUCK-2"


async def test_loading_onto_the_same_truck_twice_is_a_no_op_with_two_scans(
        client, db, seeded_user):
    """Nothing changed the second time, so there is no second audit row —
    but each physical scan is real, so both scans are recorded.

    The answer's shape is the kiosk's contract for the repeat: the screen
    reads `already_there` to flash its duplicate color, play its own
    sound, and mark the row it already has instead of adding a second
    one, so every field it reads is pinned here."""
    hdrs = await login(client)
    *_, truck, _other, crate, _crate2, _asset = await _seed(db)
    await db.commit()
    truck_id, crate_id = truck.id, crate.id

    first = await _post(client, hdrs, truck_id, crate_id)
    assert first.status_code == 200, first.text
    assert first.json()["already_there"] is False

    second = await _post(client, hdrs, truck_id, crate_id)
    assert second.status_code == 200, second.text
    body = second.json()
    assert body["already_there"] is True
    assert body["moved_from"] is None
    assert body["action"] == "load"
    assert body["truck"]["id"] == str(truck_id)
    assert body["truck"]["container_count"] == 1
    # The container block still comes back in full: the kiosk names the
    # crate in "{name} is already on this truck." and matches the repeat
    # against the row it already has by this id.
    assert body["container"]["id"] == str(crate_id)
    assert body["container"]["name"]
    assert set(body["container"]) == {"id", "name", "asset_count"}

    db.expire_all()
    assert len((await db.scalars(select(TruckContainer).where(
        TruckContainer.container_id == crate_id))).all()) == 1
    assert len((await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_truck_load"))).all()) == 1
    assert len((await db.scalars(select(RawScan))).all()) == 2


# ── unload ───────────────────────────────────────────────────────────

async def test_unload_removes_the_link_and_audits_it(client, db, seeded_user):
    hdrs = await login(client)
    actor_id = seeded_user.id
    *_, device, truck, _other, crate, _crate2, _asset = await _seed(db)
    db.add(TruckContainer(truck_id=truck.id, container_id=crate.id))
    await db.commit()
    truck_id, crate_id, device_name = truck.id, crate.id, device.name

    resp = await _post(client, hdrs, truck_id, crate_id, action="unload")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "unload"
    assert body["truck"]["container_count"] == 0
    assert body["moved_from"] is None
    assert body["already_there"] is False

    db.expire_all()
    assert (await db.scalars(select(TruckContainer).where(
        TruckContainer.container_id == crate_id))).all() == []
    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_truck_unload"))).one()
    assert audit.entity_type == "truck"
    assert audit.entity_id == str(truck_id)
    assert audit.actor_person_id == actor_id
    assert audit.changes == {"container_id": str(crate_id),
                             "container_name": "LOAD-CRATE-1",
                             "asset_count": 1, "from_truck": "TRUCK-1",
                             "device": device_name}
    assert len((await db.scalars(select(RawScan))).all()) == 1


async def test_unloading_a_container_on_a_different_truck_is_409_naming_it(
        client, db, seeded_user):
    hdrs = await login(client)
    *_, truck, other, crate, _crate2, _asset = await _seed(db)
    db.add(TruckContainer(truck_id=other.id, container_id=crate.id))
    await db.commit()
    truck_id, other_id, crate_id = truck.id, other.id, crate.id

    resp = await _post(client, hdrs, truck_id, crate_id, action="unload")
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "not_on_truck"
    assert detail["truck_id"] == str(other_id)
    assert detail["truck_name"] == "TRUCK-2"

    db.expire_all()
    # Nothing was touched — not the link, not the scan.
    row = (await db.scalars(select(TruckContainer).where(
        TruckContainer.container_id == crate_id))).one()
    assert row.truck_id == other_id
    assert (await db.scalars(select(RawScan))).all() == []


async def test_unloading_a_container_on_no_truck_is_409_naming_none(
        client, db, seeded_user):
    hdrs = await login(client)
    *_, truck, _other, crate, _crate2, _asset = await _seed(db)
    await db.commit()

    resp = await _post(client, hdrs, truck.id, crate.id, action="unload")
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "not_on_truck"
    assert "truck_id" not in detail


# ── unknown references, bad checkpoint, idempotency ──────────────────

async def test_unknown_truck_and_archived_truck_are_404(client, db, seeded_user):
    hdrs = await login(client)
    *_, truck, _other, crate, _crate2, _asset = await _seed(db)
    from datetime import UTC, datetime
    truck.archived_at = datetime.now(UTC)
    await db.commit()

    resp = await _post(client, hdrs, uuid.uuid4(), crate.id)
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "truck_not_found"

    resp = await _post(client, hdrs, truck.id, crate.id)
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "truck_not_found"


async def test_unknown_container_archived_container_and_serial_are_404(
        client, db, seeded_user):
    hdrs = await login(client)
    *_, truck, _other, crate, crate2, _asset = await _seed(db)
    from datetime import UTC, datetime
    crate2.archived_at = datetime.now(UTC)
    await db.commit()
    truck_id, crate_id, crate2_id = truck.id, crate.id, crate2.id

    resp = await _post(client, hdrs, truck_id, uuid.uuid4())
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "container_not_found"

    resp = await _post(client, hdrs, truck_id, crate2_id)
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "container_not_found"

    resp = await _post(client, hdrs, truck_id, crate_id, serial="no-such-kiosk")
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "device_not_found"


async def test_unknown_or_inactive_checkpoint_is_422(client, db, seeded_user):
    hdrs = await login(client)
    *_, truck, _other, crate, _crate2, _asset = await _seed(db)
    db.add(StatusValue(record_type="asset", key="truck_test_retired",
                       label="Retired", color="#654321", sort_order=9,
                       is_active=False))
    await db.commit()
    truck_id, crate_id = truck.id, crate.id

    resp = await _post(client, hdrs, truck_id, crate_id,
                       scan_status="no_such_checkpoint")
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_status"

    resp = await _post(client, hdrs, truck_id, crate_id,
                       scan_status="truck_test_retired")
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_status"

    db.expire_all()
    assert (await db.scalars(select(RawScan))).all() == []
    assert (await db.scalars(select(TruckContainer))).all() == []


async def test_a_bad_scan_type_is_422(client, db, seeded_user):
    hdrs = await login(client)
    *_, truck, _other, crate, _crate2, _asset = await _seed(db)
    await db.commit()
    truck_id, crate_id = truck.id, crate.id

    resp = await _post(client, hdrs, truck_id, crate_id, scan_type="telepathy")
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_scan_type"

    db.expire_all()
    assert (await db.scalars(select(RawScan))).all() == []
    assert (await db.scalars(select(TruckContainer))).all() == []


async def test_replaying_the_client_scan_id_adds_no_second_scan(
        client, db, seeded_user):
    hdrs = await login(client)
    *_, truck, _other, crate, _crate2, _asset = await _seed(db)
    await db.commit()
    truck_id, crate_id = truck.id, crate.id

    client_scan_id = str(uuid.uuid4())
    for _ in range(2):
        resp = await _post(client, hdrs, truck_id, crate_id,
                           client_scan_id=client_scan_id)
        assert resp.status_code == 200, resp.text

    db.expire_all()
    assert len((await db.scalars(select(RawScan))).all()) == 1


# ── access ───────────────────────────────────────────────────────────

async def test_a_worker_can_load(client, db, seeded_user):
    """The persona kiosks are actually signed into holds kiosk:view."""
    hdrs = await _make(db, client, "worker", "w-load@test.example.com")
    *_, truck, _other, crate, _crate2, _asset = await _seed(db)
    await db.commit()

    resp = await _post(client, hdrs, truck.id, crate.id)
    assert resp.status_code == 200, resp.text


async def test_load_permission(client, db, seeded_user):
    *_, truck, _other, crate, _crate2, _asset = await _seed(db)
    await db.commit()
    truck_id, crate_id = truck.id, crate.id
    cv = await _client_viewer(db, client, "cv-load@test.example.com")
    assert (await _post(client, cv, truck_id, crate_id)).status_code == 403
    anon = await client.post(f"/kiosk/trucks/{truck_id}/containers",
                             json=_body(crate_id))
    assert anon.status_code == 401


async def test_load_blocked_in_read_only_mode(client, db, seeded_user):
    hdrs = await login(client)
    *_, truck, _other, crate, _crate2, _asset = await _seed(db)
    await db.commit()
    truck_id, crate_id = truck.id, crate.id
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200

    resp = await _post(client, hdrs, truck_id, crate_id)
    assert resp.status_code == 423, resp.text


async def test_the_matcher_picks_up_the_load_scan(client, db, seeded_user, monkeypatch):
    """End to end: the load's raw scan is a fresh row the scan-matching
    worker drains. The operator scanned an asset inside the crate, so the
    matcher resolves that asset — the crate is what got loaded, the asset
    is what was read."""
    monkeypatch.setattr(worker, "_last_sweep", None)
    hdrs = await login(client)
    *_, checkpoint, _device, truck, _other, crate, _crate2, asset = await _seed(db)
    await db.commit()
    asset_id, key = asset.id, checkpoint.key

    resp = await _post(client, hdrs, truck.id, crate.id,
                       scanned_value="SN-LOAD-1", scan_type="barcode")
    assert resp.status_code == 200, resp.text

    assert await worker.run_once(get_sessionmaker()) is True

    db.expire_all()
    assert (await db.scalars(select(RawScan))).all() == []
    processed = (await db.scalars(select(ProcessedScan))).one()
    assert processed.asset_id == asset_id
    assert processed.match_type == "asset"
    assert processed.source == "kiosk"
    assert processed.status == key
