"""GET /kiosk/sync/containers and POST /kiosk/containers/{id}/assets —
the kiosk's Containers screen. The sync feeds the kiosk's local copy of
the move's crates; the pack/unpack endpoint writes membership, one audit
row, and one `raw_scans` row in ONE transaction. `container_assets.
asset_id` is UNIQUE, so packing an asset held elsewhere MOVES it. Gated
on kiosk:view; blocked under read-only mode (it writes)."""

import uuid

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, AuditLog, Container, ContainerAsset, Device, Initiative, ProcessedScan,
    RawScan, Site, StatusValue,
)
from serversherpa.scans import worker
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_sites_api import login
from tests.test_status_values_write import _make
from tests.test_system_admin_api import _admin

SERIAL = "kiosk-web-containers-1"


async def _seed(db):
    """A kiosk device set up for a move, two containers on that move, an
    asset to pack, and the checkpoint the pack/unpack scan records."""
    site = Site(name="NAP11 Pack Hall")
    initiative = Initiative(name="NAP11 Pack Move", initiative_type="move",
                            status="in_progress")
    checkpoint = StatusValue(record_type="asset", key="pack_test_in_container",
                             label="Pack Test In Container", color="#123456",
                             sort_order=1, is_active=True)
    db.add_all([site, initiative, checkpoint])
    await db.flush()
    if await db.scalar(select(StatusValue).where(
            StatusValue.record_type == "container",
            StatusValue.key == "available")) is None:
        db.add(StatusValue(record_type="container", key="available",
                           label="Available", color="#2e7d32", sort_order=0,
                           is_active=True))
    device = Device(device_type="kiosk", name="Kiosk Pack Target", serial=SERIAL,
                    site_id=site.id, current_initiative_id=initiative.id,
                    scan_status=checkpoint.key)
    crate = Container(name="PACK-CRATE-1", rfid_tag="0" * 20 + "CR01",
                      container_type="shipping_container", status="available",
                      site_id=site.id, initiative_id=initiative.id,
                      label_tag="priority")
    other = Container(name="PACK-CRATE-2", container_type="pelican_case",
                      status="available", initiative_id=initiative.id)
    asset = Asset(name="Pack Me", serial_number="SN-PACK-1", legacy_id=77001)
    db.add_all([device, crate, other, asset])
    await db.flush()
    return site, initiative, checkpoint, device, crate, other, asset


def _body(asset_id, action="pack", **kw):
    return {"serial": kw.pop("serial", SERIAL),
            "asset_id": str(asset_id),
            "action": action,
            "scanned_value": kw.pop("scanned_value", "SN-PACK-1"),
            "scan_type": kw.pop("scan_type", "barcode"),
            "scan_status": kw.pop("scan_status", "pack_test_in_container"),
            "client_scan_id": kw.pop("client_scan_id", str(uuid.uuid4())),
            **kw}


async def _post(client, hdrs, container_id, asset_id, **kw):
    return await client.post(f"/kiosk/containers/{container_id}/assets",
                             headers=hdrs, json=_body(asset_id, **kw))


# ── sync ─────────────────────────────────────────────────────────────

async def test_sync_returns_the_moves_containers_with_asset_counts(
        client, db, seeded_user):
    hdrs = await login(client)
    site, initiative, _cp, _device, crate, other, asset = await _seed(db)
    db.add(ContainerAsset(container_id=crate.id, asset_id=asset.id))
    await db.commit()
    crate_id, site_id = crate.id, site.id

    resp = await client.get("/kiosk/sync/containers", headers=hdrs,
                            params={"initiative_id": str(initiative.id)})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["initiative_id"] == str(initiative.id)
    rows = {c["name"]: c for c in body["containers"]}
    assert set(rows) == {"PACK-CRATE-1", "PACK-CRATE-2"}
    one = rows["PACK-CRATE-1"]
    assert one["id"] == str(crate_id)
    assert one["rfid_tag"] == "0" * 20 + "CR01"
    assert one["label_tag"] == "priority"
    assert one["container_type"] == "shipping_container"
    assert one["status"] == "available"
    assert one["status_label"] == "Available"
    assert one["site_id"] == str(site_id)
    assert one["site_name"] == "NAP11 Pack Hall"
    assert one["asset_count"] == 1
    assert rows["PACK-CRATE-2"]["asset_count"] == 0
    assert rows["PACK-CRATE-2"]["site_id"] is None


async def test_sync_excludes_archived_containers_and_other_moves(
        client, db, seeded_user):
    hdrs = await login(client)
    _site, initiative, _cp, _device, crate, _other, _asset = await _seed(db)
    from datetime import UTC, datetime
    crate.archived_at = datetime.now(UTC)
    elsewhere = Initiative(name="Another Move", initiative_type="move",
                           status="planned")
    db.add(elsewhere)
    await db.flush()
    db.add(Container(name="NOT-OURS", status="available",
                     initiative_id=elsewhere.id))
    await db.commit()

    resp = await client.get("/kiosk/sync/containers", headers=hdrs,
                            params={"initiative_id": str(initiative.id)})
    assert resp.status_code == 200, resp.text
    names = [c["name"] for c in resp.json()["containers"]]
    assert names == ["PACK-CRATE-2"]


async def test_sync_unknown_move_is_404_and_a_non_move_is_422(
        client, db, seeded_user):
    hdrs = await login(client)
    await _seed(db)
    project = Initiative(name="A Project", initiative_type="project",
                         status="planned")
    db.add(project)
    await db.commit()

    resp = await client.get("/kiosk/sync/containers", headers=hdrs,
                            params={"initiative_id": str(uuid.uuid4())})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "initiative_not_found"

    resp = await client.get("/kiosk/sync/containers", headers=hdrs,
                            params={"initiative_id": str(project.id)})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_initiative"


async def test_sync_permission(client, db, seeded_user):
    _site, initiative, *_ = await _seed(db)
    await db.commit()
    initiative_id = initiative.id
    cv = await _client_viewer(db, client, "cv-sync-containers@test.example.com")
    resp = await client.get("/kiosk/sync/containers", headers=cv,
                            params={"initiative_id": str(initiative_id)})
    assert resp.status_code == 403
    anon = await client.get("/kiosk/sync/containers",
                            params={"initiative_id": str(initiative_id)})
    assert anon.status_code == 401


# ── pack ─────────────────────────────────────────────────────────────

async def test_pack_writes_membership_one_audit_row_and_one_scan(
        client, db, seeded_user):
    hdrs = await login(client)
    actor_id = seeded_user.id
    site, initiative, checkpoint, device, crate, _other, asset = await _seed(db)
    await db.commit()
    (crate_id, asset_id, device_id, device_name, site_id, initiative_id, key) = (
        crate.id, asset.id, device.id, device.name, site.id, initiative.id,
        checkpoint.key)

    client_scan_id = str(uuid.uuid4())
    resp = await _post(client, hdrs, crate_id, asset_id,
                       client_scan_id=client_scan_id,
                       site_id=str(site_id), initiative_id=str(initiative_id))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "pack"
    assert body["already_there"] is False
    assert body["moved_from"] is None
    assert body["container"] == {"id": str(crate_id), "name": "PACK-CRATE-1",
                                 "asset_count": 1}
    assert body["asset"]["id"] == str(asset_id)
    assert body["asset"]["name"] == "Pack Me"
    assert body["asset"]["asset_tag"] == "77001"
    assert body["asset"]["serial_number"] == "SN-PACK-1"

    db.expire_all()
    rows = (await db.scalars(select(ContainerAsset).where(
        ContainerAsset.asset_id == asset_id))).all()
    assert len(rows) == 1
    assert rows[0].container_id == crate_id
    assert rows[0].added_by == actor_id

    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_container_pack"))).all()
    assert len(audit) == 1
    assert audit[0].entity_type == "container"
    assert audit[0].entity_id == str(crate_id)
    assert audit[0].actor_person_id == actor_id
    assert audit[0].changes == {"asset_id": str(asset_id), "asset_name": "Pack Me",
                                "from_container": None, "device": device_name}

    scan = (await db.scalars(select(RawScan))).one()
    assert scan.scanned_value == "SN-PACK-1"
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
    site, initiative, _cp, _device, crate, _other, asset = await _seed(db)
    await db.commit()
    site_id, initiative_id = site.id, initiative.id

    assert (await _post(client, hdrs, crate.id, asset.id)).status_code == 200

    db.expire_all()
    scan = (await db.scalars(select(RawScan))).one()
    assert scan.site_id == site_id
    assert scan.initiative_id == initiative_id


async def test_packing_an_asset_held_elsewhere_moves_it_and_reports_moved_from(
        client, db, seeded_user):
    """`container_assets.asset_id` is UNIQUE — an asset is in at most one
    container, so a pack of something already crated is a move."""
    hdrs = await login(client)
    *_, crate, other, asset = await _seed(db)
    db.add(ContainerAsset(container_id=other.id, asset_id=asset.id))
    await db.commit()
    crate_id, other_id, asset_id = crate.id, other.id, asset.id

    resp = await _post(client, hdrs, crate_id, asset_id)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["moved_from"] == {"id": str(other_id), "name": "PACK-CRATE-2"}
    assert body["already_there"] is False
    assert body["container"]["asset_count"] == 1

    db.expire_all()
    rows = (await db.scalars(select(ContainerAsset).where(
        ContainerAsset.asset_id == asset_id))).all()
    assert len(rows) == 1
    assert rows[0].container_id == crate_id
    assert (await db.scalars(select(ContainerAsset).where(
        ContainerAsset.container_id == other_id))).all() == []

    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_container_pack"))).one()
    assert audit.changes["from_container"] == "PACK-CRATE-2"


async def test_packing_into_the_same_container_twice_is_a_no_op_with_two_scans(
        client, db, seeded_user):
    """Nothing changed the second time, so there is no second audit row —
    but each physical scan is real, so both scans are recorded."""
    hdrs = await login(client)
    *_, crate, _other, asset = await _seed(db)
    await db.commit()
    crate_id, asset_id = crate.id, asset.id

    first = await _post(client, hdrs, crate_id, asset_id)
    assert first.status_code == 200, first.text
    assert first.json()["already_there"] is False

    second = await _post(client, hdrs, crate_id, asset_id)
    assert second.status_code == 200, second.text
    body = second.json()
    assert body["already_there"] is True
    assert body["moved_from"] is None
    assert body["container"]["asset_count"] == 1

    db.expire_all()
    assert len((await db.scalars(select(ContainerAsset).where(
        ContainerAsset.asset_id == asset_id))).all()) == 1
    assert len((await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_container_pack"))).all()) == 1
    assert len((await db.scalars(select(RawScan))).all()) == 2


# ── unpack ───────────────────────────────────────────────────────────

async def test_unpack_removes_the_membership_and_audits_it(client, db, seeded_user):
    hdrs = await login(client)
    actor_id = seeded_user.id
    *_, device, crate, _other, asset = await _seed(db)
    db.add(ContainerAsset(container_id=crate.id, asset_id=asset.id))
    await db.commit()
    crate_id, asset_id, device_name = crate.id, asset.id, device.name

    resp = await _post(client, hdrs, crate_id, asset_id, action="unpack")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["action"] == "unpack"
    assert body["container"]["asset_count"] == 0
    assert body["moved_from"] is None
    assert body["already_there"] is False

    db.expire_all()
    assert (await db.scalars(select(ContainerAsset).where(
        ContainerAsset.asset_id == asset_id))).all() == []
    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_container_unpack"))).one()
    assert audit.entity_id == str(crate_id)
    assert audit.actor_person_id == actor_id
    assert audit.changes == {"asset_id": str(asset_id), "asset_name": "Pack Me",
                             "from_container": "PACK-CRATE-1", "device": device_name}
    assert len((await db.scalars(select(RawScan))).all()) == 1


async def test_unpacking_an_asset_that_is_elsewhere_is_409_naming_that_container(
        client, db, seeded_user):
    hdrs = await login(client)
    *_, crate, other, asset = await _seed(db)
    db.add(ContainerAsset(container_id=other.id, asset_id=asset.id))
    await db.commit()
    crate_id, other_id, asset_id = crate.id, other.id, asset.id

    resp = await _post(client, hdrs, crate_id, asset_id, action="unpack")
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "not_in_container"
    assert detail["container_id"] == str(other_id)
    assert detail["container_name"] == "PACK-CRATE-2"

    db.expire_all()
    # Nothing was touched — not the membership, not the scan.
    row = (await db.scalars(select(ContainerAsset).where(
        ContainerAsset.asset_id == asset_id))).one()
    assert row.container_id == other_id
    assert (await db.scalars(select(RawScan))).all() == []


async def test_unpacking_an_asset_in_no_container_is_409_naming_none(
        client, db, seeded_user):
    hdrs = await login(client)
    *_, crate, _other, asset = await _seed(db)
    await db.commit()

    resp = await _post(client, hdrs, crate.id, asset.id, action="unpack")
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "not_in_container"
    assert "container_id" not in detail


# ── unknown references, bad checkpoint, idempotency ──────────────────

async def test_unknown_container_and_archived_container_are_404(
        client, db, seeded_user):
    hdrs = await login(client)
    *_, crate, _other, asset = await _seed(db)
    from datetime import UTC, datetime
    crate.archived_at = datetime.now(UTC)
    await db.commit()

    resp = await _post(client, hdrs, uuid.uuid4(), asset.id)
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "container_not_found"

    resp = await _post(client, hdrs, crate.id, asset.id)
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "container_not_found"


async def test_unknown_asset_and_unknown_serial_are_404(client, db, seeded_user):
    hdrs = await login(client)
    *_, crate, _other, asset = await _seed(db)
    await db.commit()

    resp = await _post(client, hdrs, crate.id, uuid.uuid4())
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "asset_not_found"

    resp = await _post(client, hdrs, crate.id, asset.id, serial="no-such-kiosk")
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "device_not_found"


async def test_unknown_or_inactive_checkpoint_is_422(client, db, seeded_user):
    hdrs = await login(client)
    *_, crate, _other, asset = await _seed(db)
    db.add(StatusValue(record_type="asset", key="pack_test_retired",
                       label="Retired", color="#654321", sort_order=9,
                       is_active=False))
    await db.commit()
    crate_id, asset_id = crate.id, asset.id

    resp = await _post(client, hdrs, crate_id, asset_id,
                       scan_status="no_such_checkpoint")
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_status"

    resp = await _post(client, hdrs, crate_id, asset_id,
                       scan_status="pack_test_retired")
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_status"

    db.expire_all()
    assert (await db.scalars(select(RawScan))).all() == []
    assert (await db.scalars(select(ContainerAsset))).all() == []


async def test_a_bad_scan_type_is_422(client, db, seeded_user):
    hdrs = await login(client)
    *_, crate, _other, asset = await _seed(db)
    await db.commit()

    resp = await _post(client, hdrs, crate.id, asset.id, scan_type="manual")
    assert resp.status_code == 422, resp.text


async def test_replaying_the_client_scan_id_adds_no_second_scan(
        client, db, seeded_user):
    hdrs = await login(client)
    *_, crate, _other, asset = await _seed(db)
    await db.commit()
    crate_id, asset_id = crate.id, asset.id

    client_scan_id = str(uuid.uuid4())
    for _ in range(2):
        resp = await _post(client, hdrs, crate_id, asset_id,
                           client_scan_id=client_scan_id)
        assert resp.status_code == 200, resp.text

    db.expire_all()
    assert len((await db.scalars(select(RawScan))).all()) == 1


# ── access ───────────────────────────────────────────────────────────

async def test_a_worker_can_pack(client, db, seeded_user):
    """The persona kiosks are actually signed into holds kiosk:view."""
    hdrs = await _make(db, client, "worker", "w-pack@test.example.com")
    *_, crate, _other, asset = await _seed(db)
    await db.commit()

    resp = await _post(client, hdrs, crate.id, asset.id)
    assert resp.status_code == 200, resp.text


async def test_pack_permission(client, db, seeded_user):
    *_, crate, _other, asset = await _seed(db)
    await db.commit()
    crate_id, asset_id = crate.id, asset.id
    cv = await _client_viewer(db, client, "cv-pack@test.example.com")
    assert (await _post(client, cv, crate_id, asset_id)).status_code == 403
    anon = await client.post(f"/kiosk/containers/{crate_id}/assets",
                             json=_body(asset_id))
    assert anon.status_code == 401


async def test_pack_blocked_in_read_only_mode(client, db, seeded_user):
    hdrs = await login(client)
    *_, crate, _other, asset = await _seed(db)
    await db.commit()
    crate_id, asset_id = crate.id, asset.id
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200

    resp = await _post(client, hdrs, crate_id, asset_id)
    assert resp.status_code == 423, resp.text


async def test_the_matcher_picks_up_the_pack_scan(client, db, seeded_user, monkeypatch):
    """End to end: the pack's raw scan is a fresh row the scan-matching
    worker drains, and it matches the asset that was just packed."""
    monkeypatch.setattr(worker, "_last_sweep", None)
    hdrs = await login(client)
    _site, _initiative, checkpoint, _device, crate, _other, asset = await _seed(db)
    await db.commit()
    asset_id, key = asset.id, checkpoint.key

    resp = await _post(client, hdrs, crate.id, asset_id,
                       scanned_value="SN-PACK-1", scan_type="barcode")
    assert resp.status_code == 200, resp.text

    assert await worker.run_once(get_sessionmaker()) is True

    db.expire_all()
    assert (await db.scalars(select(RawScan))).all() == []
    processed = (await db.scalars(select(ProcessedScan))).one()
    assert processed.asset_id == asset_id
    assert processed.match_type == "asset"
    assert processed.source == "kiosk"
    assert processed.status == key
