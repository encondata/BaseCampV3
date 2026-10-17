"""The portal's kiosk details routes: GET /devices/{id} (detail + config +
sync state + setup + scan type options), PUT /devices/{id}/config,
POST /devices/{id}/config/reset, PATCH /devices/{id}/scan-type,
GET /devices/{id}/config/history, and the /kiosk-sounds list / upload /
file / delete. Viewing needs scanning_hardware:view; every write needs
scanning_hardware:change AND rank 80+ (super admin), else 403
forbidden_rank — admins (rank 60) included."""

import copy
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import event, select

from serversherpa.db.engine import get_engine
from serversherpa.db.models import AuditLog, Device, Initiative, KioskSound, Site, StatusValue
from serversherpa.services import kiosk_config
from serversherpa.services.kiosk_config import DEFAULT_CONFIG
from tests.test_access_roles_api import login_admin
from tests.test_notification_groups_api import login_staff
from tests.test_system_api import _super_admin_headers


@pytest.fixture
def store(monkeypatch):
    blobs: dict[str, tuple[bytes, str]] = {}

    async def put_object(key, data, content_type):
        blobs[key] = (data, content_type)

    async def get_object(key):
        if key not in blobs:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "gone"}},
                              "GetObject")
        return blobs[key][0]

    async def delete_object(key):
        blobs.pop(key, None)

    monkeypatch.setattr("serversherpa.api.routes.kiosk.put_object", put_object)
    monkeypatch.setattr("serversherpa.api.routes.kiosk.get_object", get_object)
    monkeypatch.setattr("serversherpa.api.routes.kiosk.delete_object", delete_object)
    return blobs


async def _kiosk(db, *, name="Dock 1", serial=None, sub_type="web", **kw):
    device = Device(device_type="kiosk", name=name,
                    serial=serial or f"kiosk-{uuid.uuid4().hex[:8]}",
                    sub_type=sub_type, **kw)
    db.add(device)
    await db.commit()
    return device


async def _move(db):
    origin, dest = Site(name="NAP11 Hall"), Site(name="NAP22 Hall")
    db.add_all([origin, dest])
    await db.flush()
    move = Initiative(name="NAP7 Rack Move", initiative_type="move", status="in_progress",
                      origin_site_id=origin.id, destination_site_id=dest.id)
    db.add(move)
    await db.flush()
    return move, origin, dest


def _doc(**appearance):
    doc = copy.deepcopy(DEFAULT_CONFIG)
    doc["appearance"].update(appearance)
    return doc


def _file(data=b"ID3fake-mp3", name="ding.mp3", ctype="audio/mpeg"):
    return {"file": (name, data, ctype)}


async def _fresh(db, device_id):
    return await db.scalar(select(Device).where(Device.id == device_id)
                           .execution_options(populate_existing=True))


# ── detail ───────────────────────────────────────────────────────────

async def test_staff_can_view_detail_waiting_first_report(client, db, seeded_user):
    device = await _kiosk(db)
    hdrs = await login_staff(client, seeded_user)
    r = await client.get(f"/devices/{device.id}", headers=hdrs)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == str(device.id) and body["name"] == "Dock 1"
    assert body["config"] is None and body["config_version"] == 0
    assert body["config_changed_at"] is None and body["config_source"] is None
    assert body["config_changed_by_name"] is None
    assert body["config_reported_at"] is None and body["config_applied_version"] is None
    assert body["sync_state"] == "waiting_first_report"
    assert body["setup"] == {
        "initiative_id": None, "initiative_name": None, "site_id": None,
        "site_name": None, "site_role": None, "station_type": None,
        "scan_status": None, "scan_status_label": None}
    assert body["scan_type_options"] == []


async def test_unknown_device_is_404(client, db, seeded_user):
    hdrs = await login_staff(client, seeded_user)
    r = await client.get(f"/devices/{uuid.uuid4()}", headers=hdrs)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "device_not_found"


@pytest.mark.parametrize(("reported", "version", "applied", "state"), [
    (False, 3, 3, "waiting_first_report"),
    (True, 3, 3, "in_sync"),
    (True, 3, 2, "pending"),
    (True, 3, None, "pending"),
    (True, 3, 4, "pending"),     # equality only, never >=
])
async def test_sync_state(client, db, seeded_user, reported, version, applied, state):
    device = await _kiosk(db, config=_doc(), config_version=version,
                          config_applied_version=applied,
                          config_reported_at=datetime.now(UTC) if reported else None)
    hdrs = await login_staff(client, seeded_user)
    body = (await client.get(f"/devices/{device.id}", headers=hdrs)).json()
    assert body["sync_state"] == state


async def test_detail_setup_and_scan_type_options(client, db, seeded_user):
    move, _origin, dest = await _move(db)
    db.add(StatusValue(record_type="asset", key="old_gone", label="Old Gone",
                       color="#000000", sort_order=99, is_active=False))
    await db.flush()
    device = await _kiosk(db, current_initiative_id=move.id, site_id=dest.id,
                          scan_status="pre_stage", station_type="label")
    hdrs = await login_staff(client, seeded_user)
    body = (await client.get(f"/devices/{device.id}", headers=hdrs)).json()
    assert body["setup"] == {
        "initiative_id": str(move.id), "initiative_name": "NAP7 Rack Move",
        "site_id": str(dest.id), "site_name": "NAP22 Hall", "site_role": "destination",
        "station_type": "label", "scan_status": "pre_stage",
        "scan_status_label": "Pre-Stage"}
    keys = [o["key"] for o in body["scan_type_options"]]
    assert "pre_stage" in keys and "active" in keys and "old_gone" not in keys
    assert set(body["scan_type_options"][0]) == {"key", "label", "color"}


async def test_rfid_station_options_are_rfid_labels_only(client, db, seeded_user):
    move, origin, _ = await _move(db)
    db.add(StatusValue(record_type="asset", key="rfid_seen", label="Seen by rfid",
                       color="#111111", sort_order=50, is_active=True))
    await db.flush()
    device = await _kiosk(db, sub_type="laptop", station_type="rfid",
                          current_initiative_id=move.id, site_id=origin.id)
    hdrs = await login_staff(client, seeded_user)
    body = (await client.get(f"/devices/{device.id}", headers=hdrs)).json()
    options = body["scan_type_options"]
    assert "rfid_seen" in [o["key"] for o in options]     # any case
    assert all("rfid" in o["label"].lower() for o in options)
    assert "pre_stage" not in [o["key"] for o in options]


# ── permission gate ──────────────────────────────────────────────────

async def _writes(client, hdrs, device_id, sound_id):
    return [
        await client.put(f"/devices/{device_id}/config", headers=hdrs, json=_doc(flash_ms=500)),
        await client.post(f"/devices/{device_id}/config/reset", headers=hdrs),
        await client.patch(f"/devices/{device_id}/scan-type", headers=hdrs,
                           json={"scan_status": "active"}),
        await client.post("/kiosk-sounds", headers=hdrs, files=_file()),
        await client.delete(f"/kiosk-sounds/{sound_id}", headers=hdrs),
    ]


async def test_admin_rank_60_gets_forbidden_rank_on_every_write(client, db, seeded_user, store):
    move, origin, _ = await _move(db)
    device = await _kiosk(db, current_initiative_id=move.id, site_id=origin.id,
                          scan_status="pre_stage", config=_doc(), config_version=1)
    sound = KioskSound(name="x.mp3", content_type="audio/mpeg", size=3,
                       storage_key="kiosk-sounds/keep")
    db.add(sound)
    await db.commit()
    hdrs = await login_admin(client, db, seeded_user)
    for r in await _writes(client, hdrs, device.id, sound.id):
        assert r.status_code == 403, (r.request.url, r.text)
        assert r.json()["detail"]["code"] == "forbidden_rank"
    fresh = await _fresh(db, device.id)
    assert fresh.config_version == 1 and fresh.scan_status == "pre_stage"
    assert len((await db.scalars(select(KioskSound))).all()) == 1
    # an admin can still view
    assert (await client.get(f"/devices/{device.id}", headers=hdrs)).status_code == 200


async def test_staff_without_change_is_forbidden(client, db, seeded_user, store):
    device = await _kiosk(db)
    hdrs = await login_staff(client, seeded_user)
    for r in await _writes(client, hdrs, device.id, uuid.uuid4()):
        assert r.status_code == 403
        assert r.json()["detail"]["code"] == "forbidden"


# ── config edit / reset ──────────────────────────────────────────────

async def test_super_admin_edits_config(client, db, seeded_user):
    device = await _kiosk(db)
    hdrs = await _super_admin_headers(db, client)
    r = await client.put(f"/devices/{device.id}/config", headers=hdrs,
                         json=_doc(flash_ms=500))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["config"]["appearance"]["flash_ms"] == 500
    assert body["config_version"] == 1 and body["config_source"] == "portal"
    assert body["config_changed_by_name"] == "Sue Prime"
    assert body["config_changed_at"] is not None
    assert body["sync_state"] == "waiting_first_report"
    (a,) = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(device.id), AuditLog.action == "config_change"))).all()
    assert a.changes["source"] == "portal" and a.changes["version"] == 1


async def test_bad_config_is_422_with_field(client, db, seeded_user):
    device = await _kiosk(db)
    hdrs = await _super_admin_headers(db, client)
    r = await client.put(f"/devices/{device.id}/config", headers=hdrs,
                         json=_doc(flash_ms=50))
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert detail["code"] == "bad_config"
    assert detail["field"] == "appearance.flash_ms" and detail["message"]
    assert (await _fresh(db, device.id)).config_version == 0
    # a non-object body is a bad_config too
    r = await client.put(f"/devices/{device.id}/config", headers=hdrs, json=[1, 2])
    assert r.status_code == 422 and r.json()["detail"]["field"] == "config"


async def test_unknown_sound_id_is_422(client, db, seeded_user):
    device = await _kiosk(db)
    hdrs = await _super_admin_headers(db, client)
    doc = _doc()
    doc["sound"]["good"] = {"kind": "upload", "id": str(uuid.uuid4())}
    r = await client.put(f"/devices/{device.id}/config", headers=hdrs, json=doc)
    assert r.status_code == 422
    assert r.json()["detail"]["field"] == "sound.good"


async def test_config_on_a_non_kiosk_is_409(client, db, seeded_user):
    router = Device(device_type="router", name="gl-1")
    db.add(router)
    await db.commit()
    hdrs = await _super_admin_headers(db, client)
    r = await client.put(f"/devices/{router.id}/config", headers=hdrs, json=_doc())
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_a_kiosk"
    r = await client.post(f"/devices/{router.id}/config/reset", headers=hdrs)
    assert r.status_code == 409


async def test_reset_stores_defaults_and_keeps_platform_sections(client, db, seeded_user):
    stored = _doc(flash_ms=900)
    stored["android_rfid"] = {"power": 27}
    device = await _kiosk(db, config=stored, config_version=4, config_source="kiosk",
                          config_reported_at=datetime.now(UTC), config_applied_version=4)
    hdrs = await _super_admin_headers(db, client)
    r = await client.post(f"/devices/{device.id}/config/reset", headers=hdrs)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["config"]["appearance"] == DEFAULT_CONFIG["appearance"]
    assert body["config"]["android_rfid"] == {"power": 27}
    assert body["config_version"] == 5 and body["config_source"] == "portal"
    assert body["sync_state"] == "pending"


async def test_config_write_locks_the_device_row(client, db, seeded_user):
    device = await _kiosk(db)
    hdrs = await _super_admin_headers(db, client)
    engine = get_engine().sync_engine
    statements: list[str] = []

    def listener(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)
    event.listen(engine, "before_cursor_execute", listener)
    try:
        r = await client.put(f"/devices/{device.id}/config", headers=hdrs, json=_doc())
    finally:
        event.remove(engine, "before_cursor_execute", listener)
    assert r.status_code == 200
    assert [s for s in statements if "FROM devices" in s and "FOR UPDATE" in s]


# ── scan type ────────────────────────────────────────────────────────

async def test_super_admin_changes_scan_type(client, db, seeded_user):
    move, origin, _ = await _move(db)
    device = await _kiosk(db, current_initiative_id=move.id, site_id=origin.id,
                          scan_status="pre_stage")
    hdrs = await _super_admin_headers(db, client)
    r = await client.patch(f"/devices/{device.id}/scan-type", headers=hdrs,
                           json={"scan_status": "active"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scan_status"] == "active" and body["setup"]["scan_status"] == "active"
    assert body["setup"]["scan_status_label"] == "Active"
    (a,) = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(device.id), AuditLog.action == "scan_type_change"))).all()
    assert a.changes == {"source": "portal",
                         "scan_status": {"from": "pre_stage", "to": "active"}}


async def test_scan_type_outside_options_is_422(client, db, seeded_user):
    move, origin, _ = await _move(db)
    db.add(StatusValue(record_type="asset", key="old_gone", label="Old Gone",
                       color="#000000", sort_order=99, is_active=False))
    await db.flush()
    device = await _kiosk(db, current_initiative_id=move.id, site_id=origin.id,
                          scan_status="pre_stage")
    rfid = await _kiosk(db, name="Station", sub_type="laptop", station_type="rfid",
                        current_initiative_id=move.id, site_id=origin.id)
    hdrs = await _super_admin_headers(db, client)
    for dev, key in ((device, "old_gone"), (device, "nope"), (rfid, "active")):
        r = await client.patch(f"/devices/{dev.id}/scan-type", headers=hdrs,
                               json={"scan_status": key})
        assert r.status_code == 422, key
        assert r.json()["detail"]["code"] == "bad_scan_status"
    assert (await _fresh(db, device.id)).scan_status == "pre_stage"


async def test_scan_type_without_a_move_is_422_no_move(client, db, seeded_user):
    device = await _kiosk(db)
    hdrs = await _super_admin_headers(db, client)
    r = await client.patch(f"/devices/{device.id}/scan-type", headers=hdrs,
                           json={"scan_status": "active"})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "no_move"


# ── history ──────────────────────────────────────────────────────────

async def test_history_shows_portal_and_kiosk_changes_newest_first(client, db, seeded_user):
    device = await _kiosk(db)
    now = datetime.now(UTC)
    await kiosk_config.accept_kiosk_report(db, device, _doc(flash_ms=400), None, now=now)
    await db.commit()
    await kiosk_config.accept_kiosk_report(db, device, _doc(flash_ms=450),
                                           now + timedelta(seconds=1), now=now + timedelta(seconds=2),
                                           actor_id=seeded_user.id)
    await db.commit()
    hdrs = await _super_admin_headers(db, client)
    r = await client.put(f"/devices/{device.id}/config", headers=hdrs, json=_doc(flash_ms=600))
    assert r.status_code == 200

    staff = await login_staff(client, seeded_user)
    r = await client.get(f"/devices/{device.id}/config/history", headers=staff)
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [(h["source"], h["version"]) for h in rows] == [
        ("portal", 3), ("kiosk", 2), ("kiosk", 1)]
    assert [h["by_name"] for h in rows] == ["Sue Prime", "Alice Anderson", None]
    assert rows[0]["changes"] == {"appearance.flash_ms": {"from": 450, "to": 600}}
    assert set(rows[0]) == {"at", "source", "version", "by_name", "changes"}


async def test_history_unknown_device_404(client, db, seeded_user):
    staff = await login_staff(client, seeded_user)
    r = await client.get(f"/devices/{uuid.uuid4()}/config/history", headers=staff)
    assert r.status_code == 404


# ── sounds ───────────────────────────────────────────────────────────

async def test_sound_upload_list_file_and_delete(client, db, seeded_user, store):
    hdrs = await _super_admin_headers(db, client)
    r = await client.post("/kiosk-sounds", headers=hdrs, files=_file())
    assert r.status_code == 201, r.text
    sound = r.json()
    row = await db.get(KioskSound, uuid.UUID(sound["id"]))
    assert row.storage_key.startswith("kiosk-sounds/") and row.storage_key in store
    key = row.storage_key

    staff = await login_staff(client, seeded_user)
    listed = (await client.get("/kiosk-sounds", headers=staff)).json()
    assert [s["id"] for s in listed] == [sound["id"]]
    assert listed[0]["name"] == "ding.mp3" and listed[0]["in_use"] is False
    assert listed[0]["uploaded_by_name"] == "Sue Prime" and listed[0]["created_at"]
    f = await client.get(f"/kiosk-sounds/{sound['id']}/file", headers=staff)
    assert f.status_code == 200 and f.content == b"ID3fake-mp3"
    assert f.headers["content-type"] == "audio/mpeg"
    assert f.headers["x-content-type-options"] == "nosniff"

    r = await client.delete(f"/kiosk-sounds/{sound['id']}", headers=hdrs)
    assert r.status_code == 204
    assert key not in store
    assert (await db.scalars(select(KioskSound).execution_options(
        populate_existing=True))).all() == []
    assert (await client.delete(f"/kiosk-sounds/{sound['id']}", headers=hdrs)).status_code == 404


async def test_portal_upload_shares_kiosk_validation(client, db, seeded_user, store):
    hdrs = await _super_admin_headers(db, client)
    r = await client.post("/kiosk-sounds", headers=hdrs,
                          files=_file(b"<svg/>", "x.svg", "image/svg+xml"))
    assert r.status_code == 422 and r.json()["detail"]["code"] == "not_audio"
    r = await client.post("/kiosk-sounds", headers=hdrs, files=_file(b"x" * (2 * 1024 * 1024 + 1)))
    assert r.status_code == 413 and r.json()["detail"]["code"] == "file_too_large"
    assert not store


async def test_sound_in_use_cannot_be_deleted(client, db, seeded_user, store):
    hdrs = await _super_admin_headers(db, client)
    sid = (await client.post("/kiosk-sounds", headers=hdrs, files=_file())).json()["id"]
    device = await _kiosk(db)
    doc = _doc()
    doc["sound"]["alarm"] = {"kind": "upload", "id": sid}
    assert (await client.put(f"/devices/{device.id}/config", headers=hdrs,
                             json=doc)).status_code == 200
    staff = await login_staff(client, seeded_user)
    assert (await client.get("/kiosk-sounds", headers=staff)).json()[0]["in_use"] is True
    r = await client.delete(f"/kiosk-sounds/{sid}", headers=hdrs)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "in_use"
    assert len(store) == 1
    assert await db.get(KioskSound, uuid.UUID(sid)) is not None
