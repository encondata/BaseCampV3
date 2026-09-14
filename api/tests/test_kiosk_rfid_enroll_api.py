"""POST /kiosk/assets/{asset_id}/rfid — the kiosk's RFID Enroll screen
writing a tag back to an asset. One transaction: the asset's `rfid_tag`
(normalized to 24 zero-padded characters server-side, never trusting the
kiosk), one audit row, and one `raw_scans` row carrying the configured
checkpoint — the same inbox the scan-matching worker drains. Gated on
kiosk:view; blocked under read-only mode (it writes)."""

import uuid

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

SERIAL = "kiosk-web-enroll-1"
PADDED = "0" * 18 + "100348"


async def _seed(db, *, rfid=None):
    """A kiosk device set up for a move, an asset to tag, and the
    Pre-Stage checkpoint the enrollment scan records."""
    site = Site(name="NAP11 Enroll Hall")
    initiative = Initiative(name="NAP11 Enroll Move", initiative_type="move",
                            status="in_progress")
    checkpoint = StatusValue(record_type="asset", key="enroll_test_pre_stage",
                             label="Enroll Test Pre-Stage", color="#123456",
                             sort_order=1, is_active=True)
    db.add_all([site, initiative, checkpoint])
    await db.flush()
    device = Device(device_type="kiosk", name="Kiosk Enroll Target", serial=SERIAL,
                    site_id=site.id, current_initiative_id=initiative.id,
                    scan_status=checkpoint.key)
    asset = Asset(name="Enroll Me", serial_number="SN-ENROLL-1", rfid_tag=rfid)
    db.add_all([device, asset])
    await db.flush()
    return site, initiative, checkpoint, device, asset


def _body(tag="100348", **kw):
    return {"serial": kw.pop("serial", SERIAL),
            "rfid_tag": tag,
            "scan_status": kw.pop("scan_status", "enroll_test_pre_stage"),
            "client_scan_id": kw.pop("client_scan_id", str(uuid.uuid4())),
            **kw}


async def _post(client, hdrs, asset_id, **kw):
    return await client.post(f"/kiosk/assets/{asset_id}/rfid", headers=hdrs,
                             json=_body(**kw))


async def test_a_short_tag_is_padded_to_24_and_recorded(client, db, seeded_user):
    hdrs = await login(client)
    actor_id = seeded_user.id
    site, initiative, checkpoint, device, asset = await _seed(db)
    await db.commit()
    asset_id, device_id, device_name = asset.id, device.id, device.name
    site_id, initiative_id, key = site.id, initiative.id, checkpoint.key

    client_scan_id = str(uuid.uuid4())
    resp = await _post(client, hdrs, asset_id, tag="100348",
                       client_scan_id=client_scan_id,
                       site_id=str(site_id), initiative_id=str(initiative_id))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rfid_tag"] == PADDED
    assert len(body["rfid_tag"]) == 24
    assert body["asset_id"] == str(asset_id)
    assert body["asset_name"] == "Enroll Me"
    assert body["serial_number"] == "SN-ENROLL-1"
    assert body["already_had_tag"] is False

    db.expire_all()
    got = await db.get(Asset, asset_id)
    assert got.rfid_tag == PADDED

    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_rfid_enroll"))).all()
    assert len(audit) == 1
    assert audit[0].entity_type == "asset"
    assert audit[0].entity_id == str(asset_id)
    assert audit[0].actor_person_id == actor_id
    assert audit[0].changes == {"rfid_tag": {"from": None, "to": PADDED},
                                "device": device_name}

    scan = (await db.scalars(select(RawScan))).one()
    assert scan.scanned_value == PADDED
    assert scan.scan_type == "rfid"
    assert scan.status == key
    assert scan.scan_status == key
    assert scan.device_id == device_name
    assert scan.operator_id == actor_id
    assert scan.site_id == site_id
    assert scan.initiative_id == initiative_id
    assert scan.source == "kiosk"
    assert str(scan.client_scan_id) == client_scan_id
    assert scan.match_attempted_at is None      # the worker's "fresh row" marker
    assert scan.scanned_at is not None

    kiosk = await db.get(Device, device_id)
    assert kiosk.last_seen_at is not None


async def test_the_scan_falls_back_to_the_devices_site_and_move(client, db, seeded_user):
    hdrs = await login(client)
    site, initiative, _checkpoint, _device, asset = await _seed(db)
    await db.commit()
    asset_id, site_id, initiative_id = asset.id, site.id, initiative.id

    resp = await _post(client, hdrs, asset_id)
    assert resp.status_code == 200, resp.text

    db.expire_all()
    scan = (await db.scalars(select(RawScan))).one()
    assert scan.site_id == site_id
    assert scan.initiative_id == initiative_id


async def test_an_already_24_character_tag_is_stored_unchanged(client, db, seeded_user):
    hdrs = await login(client)
    *_, asset = await _seed(db)
    await db.commit()
    asset_id = asset.id

    tag = "E2004321" + "0" * 16
    resp = await _post(client, hdrs, asset_id, tag=tag)
    assert resp.status_code == 200, resp.text
    assert resp.json()["rfid_tag"] == tag

    db.expire_all()
    got = await db.get(Asset, asset_id)
    assert got.rfid_tag == tag


async def test_whitespace_and_case_are_normalized(client, db, seeded_user):
    hdrs = await login(client)
    *_, asset = await _seed(db)
    await db.commit()
    asset_id = asset.id

    resp = await _post(client, hdrs, asset_id, tag="  e200 4321  ")
    assert resp.status_code == 200, resp.text
    assert resp.json()["rfid_tag"] == "0" * 16 + "E2004321"


async def test_a_non_alphanumeric_tag_is_422(client, db, seeded_user):
    hdrs = await login(client)
    *_, asset = await _seed(db)
    await db.commit()
    asset_id = asset.id

    resp = await _post(client, hdrs, asset_id, tag="E200-4321")
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_rfid"

    db.expire_all()
    assert (await db.get(Asset, asset_id)).rfid_tag is None
    assert (await db.scalars(select(RawScan))).all() == []


async def test_an_over_length_tag_is_422(client, db, seeded_user):
    hdrs = await login(client)
    *_, asset = await _seed(db)
    await db.commit()
    asset_id = asset.id

    resp = await _post(client, hdrs, asset_id, tag="1" * 25)
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "rfid_too_long"

    db.expire_all()
    assert (await db.get(Asset, asset_id)).rfid_tag is None


async def test_a_blank_tag_is_422(client, db, seeded_user):
    hdrs = await login(client)
    *_, asset = await _seed(db)
    await db.commit()

    resp = await _post(client, hdrs, asset.id, tag="   ")
    assert resp.status_code == 422, resp.text


async def test_replaying_the_client_scan_id_writes_one_scan(client, db, seeded_user):
    """The kiosk retrying a save it never saw the answer to must not add
    a second scan — same `client_scan_id` idempotency as /kiosk/scans."""
    hdrs = await login(client)
    *_, asset = await _seed(db)
    await db.commit()
    asset_id = asset.id

    client_scan_id = str(uuid.uuid4())
    for _ in range(2):
        resp = await _post(client, hdrs, asset_id, client_scan_id=client_scan_id)
        assert resp.status_code == 200, resp.text

    db.expire_all()
    assert len((await db.scalars(select(RawScan))).all()) == 1


async def test_a_tag_on_another_asset_is_409_naming_it(client, db, seeded_user):
    hdrs = await login(client)
    *_, asset = await _seed(db)
    other = Asset(name="Already Tagged", rfid_tag=PADDED)
    db.add(other)
    await db.commit()
    asset_id, other_id = asset.id, other.id

    resp = await _post(client, hdrs, asset_id, tag="100348")
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["code"] == "rfid_in_use"
    assert detail["asset_id"] == str(other_id)
    assert detail["asset_name"] == "Already Tagged"

    db.expire_all()
    assert (await db.get(Asset, asset_id)).rfid_tag is None
    assert (await db.scalars(select(RawScan))).all() == []
    assert (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_rfid_enroll"))).all() == []


async def test_re_enrolling_the_same_tag_on_the_same_asset_is_a_no_op_write(
        client, db, seeded_user):
    """The physical scan happened, so the scan is still recorded — but
    nothing changed on the asset, so there is no second audit row."""
    hdrs = await login(client)
    *_, asset = await _seed(db, rfid=PADDED)
    await db.commit()
    asset_id = asset.id

    resp = await _post(client, hdrs, asset_id, tag="100348")
    assert resp.status_code == 200, resp.text
    assert resp.json()["already_had_tag"] is True
    assert resp.json()["rfid_tag"] == PADDED

    db.expire_all()
    assert (await db.get(Asset, asset_id)).rfid_tag == PADDED
    assert (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_rfid_enroll"))).all() == []
    assert len((await db.scalars(select(RawScan))).all()) == 1


async def test_replacing_an_existing_tag_audits_both_values(client, db, seeded_user):
    hdrs = await login(client)
    *_, asset = await _seed(db, rfid="0" * 20 + "ABCD")
    await db.commit()
    asset_id = asset.id

    resp = await _post(client, hdrs, asset_id, tag="100348")
    assert resp.status_code == 200, resp.text
    assert resp.json()["already_had_tag"] is False

    db.expire_all()
    audit = (await db.scalars(select(AuditLog).where(
        AuditLog.action == "kiosk_rfid_enroll"))).one()
    assert audit.changes["rfid_tag"] == {"from": "0" * 20 + "ABCD", "to": PADDED}


async def test_unknown_asset_is_404(client, db, seeded_user):
    hdrs = await login(client)
    await _seed(db)
    await db.commit()

    resp = await _post(client, hdrs, uuid.uuid4())
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "asset_not_found"


async def test_unknown_serial_is_404(client, db, seeded_user):
    hdrs = await login(client)
    *_, asset = await _seed(db)
    await db.commit()

    resp = await _post(client, hdrs, asset.id, serial="no-such-kiosk")
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "device_not_found"


async def test_non_kiosk_serial_is_404(client, db, seeded_user):
    hdrs = await login(client)
    *_, asset = await _seed(db)
    db.add(Device(device_type="fixed_reader", name="Reader 1", serial="reader-enroll-1"))
    await db.commit()

    resp = await _post(client, hdrs, asset.id, serial="reader-enroll-1")
    assert resp.status_code == 404, resp.text
    assert resp.json()["detail"]["code"] == "device_not_found"


async def test_unknown_checkpoint_is_422(client, db, seeded_user):
    hdrs = await login(client)
    *_, asset = await _seed(db)
    await db.commit()

    resp = await _post(client, hdrs, asset.id, scan_status="no_such_checkpoint")
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_status"


async def test_inactive_checkpoint_is_422(client, db, seeded_user):
    """Unlike /kiosk/scans (which accepts a checkpoint someone
    deactivated mid-move rather than dropping a scan), enrollment is
    configured up front on the Admin tab — a checkpoint that is no
    longer offered must be corrected there, not silently used."""
    hdrs = await login(client)
    *_, asset = await _seed(db)
    db.add(StatusValue(record_type="asset", key="enroll_test_retired",
                       label="Retired", color="#654321", sort_order=9,
                       is_active=False))
    await db.commit()

    resp = await _post(client, hdrs, asset.id, scan_status="enroll_test_retired")
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["code"] == "bad_status"

    db.expire_all()
    assert (await db.scalars(select(RawScan))).all() == []


async def test_a_worker_can_enroll(client, db, seeded_user):
    """The persona kiosks are actually signed into holds kiosk:view."""
    hdrs = await _make(db, client, "worker", "w-enroll@test.example.com")
    *_, asset = await _seed(db)
    await db.commit()

    resp = await _post(client, hdrs, asset.id)
    assert resp.status_code == 200, resp.text


async def test_enroll_permission(client, db, seeded_user):
    *_, asset = await _seed(db)
    await db.commit()
    asset_id = asset.id
    cv = await _client_viewer(db, client, "cv-enroll@test.example.com")
    assert (await _post(client, cv, asset_id)).status_code == 403
    anon = await client.post(f"/kiosk/assets/{asset_id}/rfid", json=_body())
    assert anon.status_code == 401


async def test_enroll_blocked_in_read_only_mode(client, db, seeded_user):
    hdrs = await login(client)
    *_, asset = await _seed(db)
    await db.commit()
    asset_id = asset.id
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200

    resp = await _post(client, hdrs, asset_id)
    assert resp.status_code == 423, resp.text


async def test_the_matcher_picks_up_the_enrollment_scan(
        client, db, seeded_user, monkeypatch):
    """End to end: the enrollment's raw scan is a fresh row the
    scan-matching worker drains, and it matches the asset it just
    tagged."""
    monkeypatch.setattr(worker, "_last_sweep", None)
    hdrs = await login(client)
    _site, _initiative, checkpoint, _device, asset = await _seed(db)
    await db.commit()
    asset_id, key = asset.id, checkpoint.key

    resp = await _post(client, hdrs, asset_id, tag="100348")
    assert resp.status_code == 200, resp.text

    assert await worker.run_once(get_sessionmaker()) is True

    db.expire_all()
    assert (await db.scalars(select(RawScan))).all() == []
    processed = (await db.scalars(select(ProcessedScan))).one()
    assert processed.asset_id == asset_id
    assert processed.match_type == "asset"
    assert processed.source == "kiosk"
    assert processed.status == key
