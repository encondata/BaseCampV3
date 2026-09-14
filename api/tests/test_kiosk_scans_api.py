"""POST /kiosk/scans — the kiosk's batch scan ingest. Writes one
`raw_scans` row per scan (the same inbox the scan-matching worker
drains), idempotent on the kiosk-generated `client_scan_id`, with the
device's move / site / checkpoint filling in whatever the batch leaves
out. Gated on kiosk:view; blocked under read-only mode (it writes)."""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, AuditLog, Device, Initiative, ProcessedScan, RawScan, Site, StatusValue,
)
from serversherpa.scans import worker
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_sites_api import login
from tests.test_status_values_write import _make
from tests.test_system_admin_api import _admin

SERIAL = "kiosk-web-scans-1"
T0 = datetime(2026, 9, 14, 8, 0, tzinfo=UTC)


async def _seed_device(db, *, site=None, initiative=None, scan_status=None):
    device = Device(device_type="kiosk", name="Kiosk Scan Target", serial=SERIAL,
                    site_id=site.id if site else None,
                    current_initiative_id=initiative.id if initiative else None,
                    scan_status=scan_status)
    db.add(device)
    await db.flush()
    return device


async def _seed_context(db):
    """A site, a move, and an asset-status checkpoint the kiosk can send."""
    site = Site(name="NAP11 Scan Hall")
    initiative = Initiative(name="NAP11 Scan Move", initiative_type="move",
                            status="in_progress")
    checkpoint = StatusValue(record_type="asset", key="scan_test_loading_dock",
                             label="Scan Test Loading Dock", color="#123456",
                             sort_order=1, is_active=True)
    db.add_all([site, initiative, checkpoint])
    await db.flush()
    return site, initiative, checkpoint


def _scan(value, minutes=0, **kw):
    return {"client_scan_id": kw.pop("client_scan_id", str(uuid.uuid4())),
            "scanned_value": value,
            "scan_type": kw.pop("scan_type", "rfid"),
            "scanned_at": (T0 + timedelta(minutes=minutes)).isoformat(),
            **kw}


async def test_batch_writes_raw_scans(client, db, seeded_user):
    hdrs = await login(client)
    seeded_user_id = seeded_user.id
    site, initiative, checkpoint = await _seed_context(db)
    device = await _seed_device(db)
    await db.commit()
    device_id, device_name = device.id, device.name
    site_id, initiative_id, checkpoint_key = site.id, initiative.id, checkpoint.key

    scans = [_scan(f"EPC-{i:03d}", minutes=i, site_id=str(site.id),
                   initiative_id=str(initiative.id), scan_status=checkpoint.key,
                   asset_id=str(uuid.uuid4()))
             for i in range(3)]
    resp = await client.post("/kiosk/scans", headers=hdrs,
                             json={"serial": SERIAL, "scans": scans})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rejected"] == []
    assert set(body["accepted"]) == {s["client_scan_id"] for s in scans}

    db.expire_all()
    rows = (await db.scalars(select(RawScan).order_by(RawScan.scanned_at))).all()
    assert [r.scanned_value for r in rows] == ["EPC-000", "EPC-001", "EPC-002"]
    for row in rows:
        assert row.scan_type == "rfid"
        assert row.device_id == device_name
        assert row.operator_id == seeded_user_id
        assert row.source == "kiosk"
        assert row.site_id == site_id
        assert row.initiative_id == initiative_id
        assert row.scan_status == checkpoint_key
        assert row.status == checkpoint_key       # the FK'd column the matcher copies
        assert row.match_attempted_at is None     # the worker's "fresh row" marker
        assert str(row.client_scan_id) in body["accepted"]

    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.action == "kiosk_scans"))).all()
    assert len(audit) == 1
    assert audit[0].entity_id == str(device_id)
    assert audit[0].changes == {"accepted": 3, "rejected": 0}
    assert audit[0].actor_person_id == seeded_user_id

    got = await db.get(Device, device_id)
    assert got.last_seen_at is not None


async def test_scan_inherits_the_device_defaults(client, db, seeded_user):
    hdrs = await login(client)
    site, initiative, checkpoint = await _seed_context(db)
    await _seed_device(db, site=site, initiative=initiative,
                       scan_status=checkpoint.key)
    await db.commit()
    site_id, initiative_id, key = site.id, initiative.id, checkpoint.key

    resp = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [_scan("EPC-BARE")]})
    assert resp.status_code == 200, resp.text

    db.expire_all()
    row = (await db.scalars(select(RawScan))).one()
    assert row.site_id == site_id
    assert row.initiative_id == initiative_id
    assert row.scan_status == key
    assert row.status == key


async def test_reposting_the_same_batch_is_idempotent(client, db, seeded_user):
    hdrs = await login(client)
    site, initiative, checkpoint = await _seed_context(db)
    await _seed_device(db, site=site, initiative=initiative,
                       scan_status=checkpoint.key)
    await db.commit()

    scans = [_scan(f"EPC-{i:03d}", minutes=i) for i in range(3)]
    payload = {"serial": SERIAL, "scans": scans}
    first = await client.post("/kiosk/scans", headers=hdrs, json=payload)
    assert first.status_code == 200, first.text
    second = await client.post("/kiosk/scans", headers=hdrs, json=payload)
    assert second.status_code == 200, second.text

    # an already-stored scan still counts as accepted — the kiosk clears it
    assert second.json()["rejected"] == []
    assert set(second.json()["accepted"]) == {s["client_scan_id"] for s in scans}

    db.expire_all()
    rows = (await db.scalars(select(RawScan))).all()
    assert len(rows) == 3


async def test_one_bad_site_rejects_only_that_scan(client, db, seeded_user):
    hdrs = await login(client)
    site, initiative, checkpoint = await _seed_context(db)
    await _seed_device(db, site=site, initiative=initiative,
                       scan_status=checkpoint.key)
    await db.commit()

    bad = _scan("EPC-BAD", site_id=str(uuid.uuid4()))
    good = [_scan("EPC-OK-1"), _scan("EPC-OK-2")]
    resp = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [good[0], bad, good[1]]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rejected"] == [{"client_scan_id": bad["client_scan_id"],
                                 "code": "bad_site"}]
    assert set(body["accepted"]) == {s["client_scan_id"] for s in good}

    db.expire_all()
    rows = (await db.scalars(select(RawScan))).all()
    assert {r.scanned_value for r in rows} == {"EPC-OK-1", "EPC-OK-2"}

    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_scans"))).one()
    assert audit.changes == {"accepted": 2, "rejected": 1}


async def test_unknown_initiative_or_checkpoint_rejects_that_scan(client, db, seeded_user):
    hdrs = await login(client)
    site, initiative, checkpoint = await _seed_context(db)
    await _seed_device(db, site=site, initiative=initiative,
                       scan_status=checkpoint.key)
    await db.commit()

    bad_move = _scan("EPC-MOVE", initiative_id=str(uuid.uuid4()))
    bad_status = _scan("EPC-STATUS", scan_status="no_such_checkpoint")
    resp = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [bad_move, bad_status, _scan("EPC-FINE")]})
    assert resp.status_code == 200, resp.text
    rejected = {r["client_scan_id"]: r["code"] for r in resp.json()["rejected"]}
    assert rejected == {bad_move["client_scan_id"]: "bad_initiative",
                        bad_status["client_scan_id"]: "bad_status"}

    db.expire_all()
    rows = (await db.scalars(select(RawScan))).all()
    assert [r.scanned_value for r in rows] == ["EPC-FINE"]


async def test_empty_and_oversized_batches_are_422(client, db, seeded_user):
    hdrs = await login(client)
    site, initiative, checkpoint = await _seed_context(db)
    await _seed_device(db, site=site, initiative=initiative,
                       scan_status=checkpoint.key)
    await db.commit()

    empty = await client.post("/kiosk/scans", headers=hdrs,
                              json={"serial": SERIAL, "scans": []})
    assert empty.status_code == 422, empty.text
    too_many = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [_scan(f"EPC-{i:04d}") for i in range(101)]})
    assert too_many.status_code == 422, too_many.text

    db.expire_all()
    assert (await db.scalars(select(RawScan))).all() == []


async def test_bad_scan_type_is_422(client, db, seeded_user):
    hdrs = await login(client)
    await _seed_device(db)
    await db.commit()
    resp = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [_scan("EPC-X", scan_type="manual")]})
    assert resp.status_code == 422, resp.text


async def test_scan_type_missing_from_vocabulary_rejects_only_that_scan(
        client, db, seeded_user):
    """`scan_type` is a Literal the schema always accepts ("rfid" /
    "barcode"), but the row it names in the `scan` vocabulary can still
    go missing (renamed or deleted) — that must reject the one scan, not
    500 the whole batch."""
    hdrs = await login(client)
    site, initiative, checkpoint = await _seed_context(db)
    await _seed_device(db, site=site, initiative=initiative,
                       scan_status=checkpoint.key)
    await db.execute(
        StatusValue.__table__.delete().where(
            StatusValue.record_type == "scan", StatusValue.key == "barcode"))
    await db.commit()

    bad = _scan("EPC-BARCODE", scan_type="barcode")
    good = _scan("EPC-RFID", scan_type="rfid")
    resp = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [good, bad]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rejected"] == [{"client_scan_id": bad["client_scan_id"],
                                 "code": "bad_scan_type"}]
    assert body["accepted"] == [good["client_scan_id"]]

    db.expire_all()
    rows = (await db.scalars(select(RawScan))).all()
    assert [r.scanned_value for r in rows] == ["EPC-RFID"]


async def test_unknown_serial_is_404(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": "no-such-kiosk", "scans": [_scan("EPC-X")]})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "device_not_found"


async def test_non_kiosk_serial_is_404(client, db, seeded_user):
    hdrs = await login(client)
    db.add(Device(device_type="fixed_reader", name="Reader 1", serial=SERIAL))
    await db.commit()
    resp = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [_scan("EPC-X")]})
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "device_not_found"


async def test_worker_can_post_scans(client, db, seeded_user):
    """A worker — the persona kiosks are actually signed into — holds
    kiosk:view and can ingest, not just an admin."""
    hdrs = await _make(db, client, "worker", "w-scans@test.example.com")
    site, initiative, checkpoint = await _seed_context(db)
    await _seed_device(db, site=site, initiative=initiative,
                       scan_status=checkpoint.key)
    await db.commit()
    resp = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [_scan("EPC-WORKER")]})
    assert resp.status_code == 200, resp.text


async def test_scans_permission(client, db, seeded_user):
    await _seed_device(db)
    await db.commit()
    body = {"serial": SERIAL, "scans": [_scan("EPC-X")]}
    cv = await _client_viewer(db, client, "cv-scans@test.example.com")
    assert (await client.post("/kiosk/scans", headers=cv, json=body)).status_code == 403
    assert (await client.post("/kiosk/scans", json=body)).status_code == 401


async def test_scans_blocked_in_read_only_mode(client, db, seeded_user):
    hdrs = await login(client)
    await _seed_device(db)
    await db.commit()
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200
    resp = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [_scan("EPC-RO")]})
    assert resp.status_code == 423, resp.text


async def test_the_matcher_picks_up_an_ingested_scan(client, db, seeded_user, monkeypatch):
    """End to end: a kiosk scan lands in raw_scans as a fresh row
    (match_attempted_at NULL) and the scan-matching worker's own
    run_once() moves it into processed_scans."""
    monkeypatch.setattr(worker, "_last_sweep", None)
    hdrs = await login(client)
    site, initiative, checkpoint = await _seed_context(db)
    await _seed_device(db, site=site, initiative=initiative,
                       scan_status=checkpoint.key)
    asset = Asset(name="Matched Asset", rfid_tag="EPC-MATCH-ME")
    db.add(asset)
    await db.commit()
    asset_id, checkpoint_key = asset.id, checkpoint.key

    resp = await client.post("/kiosk/scans", headers=hdrs, json={
        "serial": SERIAL, "scans": [_scan("EPC-MATCH-ME")]})
    assert resp.status_code == 200, resp.text

    assert await worker.run_once(get_sessionmaker()) is True

    db.expire_all()
    assert (await db.scalars(select(RawScan))).all() == []
    processed = (await db.scalars(select(ProcessedScan))).one()
    assert processed.asset_id == asset_id
    assert processed.match_type == "asset"
    assert processed.source == "kiosk"
    assert processed.status == checkpoint_key
