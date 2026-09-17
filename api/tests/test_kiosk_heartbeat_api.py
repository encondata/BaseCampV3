"""Kiosk heartbeat: upserts the kiosk's Device row by serial (create on
first beat, audited once as self_register; update afterwards), reports
the registration state derived from token_expires_at, and is gated on
kiosk:view. Blocked under read-only mode (it writes)."""

from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_sites_api import login
from tests.test_status_values_write import _make
from tests.test_system_admin_api import _admin

BODY = {"serial": "kiosk-web-aaaa", "name": "Dock 3", "mode": "web", "version": "0.1.0"}


async def test_first_heartbeat_creates_a_kiosk_device(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json=BODY)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["registration"] == "none"
    assert body["token_expires_at"] is None
    assert body["name"] == "Dock 3"
    d = await db.scalar(select(Device).where(Device.serial == "kiosk-web-aaaa"))
    assert d.device_type == "kiosk" and d.sub_type == "web" and d.version == "0.1.0"
    assert d.last_seen_at is not None
    assert str(d.id) == body["device_id"]
    a = await db.scalar(select(AuditLog).where(AuditLog.action == "self_register"))
    assert a.entity_type == "device" and a.entity_id == str(d.id)
    assert a.actor_person_id == seeded_user.id


async def test_second_heartbeat_updates_in_place(client, db, seeded_user):
    hdrs = await login(client)
    await client.post("/kiosk/heartbeat", headers=hdrs, json=BODY)
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json={
        **BODY, "name": "Dock 4", "version": "0.2.0", "raw_info": {"ua": "x"}})
    assert resp.status_code == 200, resp.text
    rows = (await db.scalars(select(Device).where(Device.serial == "kiosk-web-aaaa"))).all()
    assert len(rows) == 1
    assert rows[0].name == "Dock 4" and rows[0].version == "0.2.0"
    assert rows[0].raw_info["ua"] == "x"
    audits = (await db.scalars(select(AuditLog).where(AuditLog.action == "self_register"))).all()
    assert len(audits) == 1


async def test_serial_owned_by_another_family_conflicts(client, db, seeded_user):
    db.add(Device(device_type="router", name="r", serial="kiosk-web-aaaa"))
    await db.commit()
    hdrs = await login(client)
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json=BODY)
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "serial_conflict"


async def test_registration_state_thresholds(client, db, seeded_user):
    hdrs = await login(client)
    await client.post("/kiosk/heartbeat", headers=hdrs, json=BODY)
    d = await db.scalar(select(Device).where(Device.serial == "kiosk-web-aaaa"))
    for delta, expected in ((timedelta(days=30), "ok"), (timedelta(days=3), "soon"),
                            (timedelta(days=-1), "expired")):
        d.token_expires_at = datetime.now(UTC) + delta
        await db.commit()
        got = (await client.post("/kiosk/heartbeat", headers=hdrs, json=BODY)).json()
        assert got["registration"] == expected, delta
        assert got["token_expires_at"] is not None


async def test_heartbeat_permission(client, db, seeded_user):
    w = await _make(db, client, "worker", "w@test.example.com")
    assert (await client.post("/kiosk/heartbeat", headers=w, json=BODY)).status_code == 200
    cv = await _client_viewer(db, client, "cv@test.example.com")
    assert (await client.post("/kiosk/heartbeat", headers=cv, json=BODY)).status_code == 403
    assert (await client.post("/kiosk/heartbeat", json=BODY)).status_code == 401


async def test_bad_mode_is_422(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json={**BODY, "mode": "toaster"})
    assert resp.status_code == 422


async def test_raw_info_size_cap(client, db, seeded_user):
    hdrs = await login(client)
    too_many_keys = {**BODY, "raw_info": {f"k{i}": i for i in range(33)}}
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json=too_many_keys)
    assert resp.status_code == 422

    too_big = {**BODY, "raw_info": {"blob": "x" * 4096}}
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json=too_big)
    assert resp.status_code == 422

    within_bounds = {**BODY, "raw_info": {f"k{i}": i for i in range(32)}}
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json=within_bounds)
    assert resp.status_code == 200, resp.text


async def test_heartbeat_blocked_in_read_only_mode(client, db, seeded_user):
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200
    staff = await _make(db, client, "staff", "st@test.example.com")
    assert (await client.post("/kiosk/heartbeat", headers=staff, json=BODY)).status_code == 423


async def test_sign_in_registers_a_fresh_kiosk(client, db, seeded_user):
    hdrs = await login(client)
    before = datetime.now(UTC)
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json={**BODY, "sign_in": True})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["registration"] == "ok"
    expires_at = datetime.fromisoformat(body["token_expires_at"])
    assert abs((expires_at - (before + timedelta(days=30))).total_seconds()) < 60
    d = await db.scalar(select(Device).where(Device.serial == "kiosk-web-aaaa"))
    assert d.registered_at is not None
    audits = (await db.scalars(select(AuditLog).where(AuditLog.action == "register"))).all()
    assert len(audits) == 1
    a = audits[0]
    assert a.entity_type == "device" and a.entity_id == str(d.id)
    assert a.changes["source"] == "kiosk_sign_in"
    assert a.changes["days"] == 30
    assert a.actor_person_id == seeded_user.id


async def test_heartbeat_without_sign_in_does_not_register(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json=BODY)
    assert resp.status_code == 200, resp.text
    assert resp.json()["registration"] == "none"
    audits = (await db.scalars(select(AuditLog).where(AuditLog.action == "register"))).all()
    assert len(audits) == 0


async def test_sign_in_on_an_ok_registration_changes_nothing(client, db, seeded_user):
    hdrs = await login(client)
    await client.post("/kiosk/heartbeat", headers=hdrs, json=BODY)
    d = await db.scalar(select(Device).where(Device.serial == "kiosk-web-aaaa"))
    d.token_expires_at = datetime.now(UTC) + timedelta(days=20)
    await db.commit()
    original_expires_at = d.token_expires_at

    resp = await client.post("/kiosk/heartbeat", headers=hdrs,
                             json={**BODY, "sign_in": True, "login_method": "password"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["registration"] == "ok"
    await db.refresh(d)
    assert d.token_expires_at == original_expires_at
    assert d.session_person_id == seeded_user.id
    assert d.session_login_method == "password"
    audits = (await db.scalars(select(AuditLog).where(AuditLog.action == "register"))).all()
    assert len(audits) == 0


async def test_sign_in_renews_a_soon_to_expire_registration(client, db, seeded_user):
    hdrs = await login(client)
    await client.post("/kiosk/heartbeat", headers=hdrs, json=BODY)
    d = await db.scalar(select(Device).where(Device.serial == "kiosk-web-aaaa"))
    d.token_expires_at = datetime.now(UTC) + timedelta(days=3)
    await db.commit()

    before = datetime.now(UTC)
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json={**BODY, "sign_in": True})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["registration"] == "ok"
    expires_at = datetime.fromisoformat(body["token_expires_at"])
    assert abs((expires_at - (before + timedelta(days=30))).total_seconds()) < 60
    audits = (await db.scalars(select(AuditLog).where(AuditLog.action == "register"))).all()
    assert len(audits) == 1
    assert audits[0].changes["source"] == "kiosk_sign_in"
    assert audits[0].changes["days"] == 30


async def test_sign_in_beat_stores_session_person_and_login_method(client, db, seeded_user):
    hdrs = await login(client)
    before = datetime.now(UTC)
    resp = await client.post("/kiosk/heartbeat", headers=hdrs,
                             json={**BODY, "sign_in": True, "login_method": "link"})
    assert resp.status_code == 200, resp.text
    d = await db.scalar(select(Device).where(Device.serial == "kiosk-web-aaaa"))
    assert d.session_person_id == seeded_user.id
    assert d.session_login_method == "link"
    assert abs((d.session_started_at - before).total_seconds()) < 10

    # a later plain beat leaves the session fields untouched
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json=BODY)
    assert resp.status_code == 200, resp.text
    await db.refresh(d)
    assert d.session_person_id == seeded_user.id
    assert d.session_login_method == "link"


async def test_devices_list_returns_session_person_name(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/kiosk/heartbeat", headers=hdrs,
                             json={**BODY, "sign_in": True, "login_method": "link"})
    assert resp.status_code == 200, resp.text

    admin = await _admin(db, client)
    resp = await client.get("/devices", headers=admin, params={"device_type": "kiosk"})
    assert resp.status_code == 200, resp.text
    items = resp.json()
    assert len(items) == 1
    assert items[0]["session_person_name"] == "Alice Anderson"
    assert items[0]["session_login_method"] == "link"
    assert items[0]["session_person_id"] == str(seeded_user.id)
    assert items[0]["session_started_at"] is not None


async def test_sign_out_clears_session_fields(client, db, seeded_user):
    hdrs = await login(client)
    await client.post("/kiosk/heartbeat", headers=hdrs,
                      json={**BODY, "sign_in": True, "login_method": "password"})
    resp = await client.post("/kiosk/sign-out", headers=hdrs,
                             json={"serial": BODY["serial"]})
    assert resp.status_code == 204
    d = await db.scalar(select(Device).where(Device.serial == "kiosk-web-aaaa"))
    assert d.session_person_id is None
    assert d.session_login_method is None
    assert d.session_started_at is None


async def test_sign_out_by_a_different_person_leaves_session_and_still_204(client, db, seeded_user):
    hdrs = await login(client)
    await client.post("/kiosk/heartbeat", headers=hdrs,
                      json={**BODY, "sign_in": True, "login_method": "password"})
    other = await _make(db, client, "staff", "other-signout@test.example.com")
    resp = await client.post("/kiosk/sign-out", headers=other,
                             json={"serial": BODY["serial"]})
    assert resp.status_code == 204
    d = await db.scalar(select(Device).where(Device.serial == "kiosk-web-aaaa"))
    assert d.session_person_id == seeded_user.id
    assert d.session_login_method == "password"
    assert d.session_started_at is not None


async def test_sign_out_unknown_serial_is_204(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/kiosk/sign-out", headers=hdrs,
                             json={"serial": "no-such-kiosk"})
    assert resp.status_code == 204


async def test_heartbeat_stores_zebra_for_a_zebra_handheld(client, db, seeded_user):
    hdrs = await login(client)
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json={
        **BODY, "serial": "kiosk-android-zzzz", "mode": "android",
        "raw_info": {"manufacturer": "Zebra Technologies", "datawedge": "true"}})
    assert resp.status_code == 200, resp.text
    d = await db.scalar(select(Device).where(Device.serial == "kiosk-android-zzzz"))
    assert d.sub_type == "zebra"
    a = await db.scalar(select(AuditLog).where(AuditLog.action == "self_register",
                                               AuditLog.entity_id == str(d.id)))
    assert a.changes["sub_type"] == "zebra"


async def test_second_heartbeat_re_derives_rather_than_reverting(client, db, seeded_user):
    """The update branch must derive too — otherwise a Zebra device
    classified on first pair silently drops back to 'android'."""
    hdrs = await login(client)
    zebra_body = {**BODY, "serial": "kiosk-android-zzzz", "mode": "android",
                  "raw_info": {"manufacturer": "Zebra Technologies"}}
    await client.post("/kiosk/heartbeat", headers=hdrs, json=zebra_body)
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json=zebra_body)
    assert resp.status_code == 200, resp.text
    d = await db.scalar(select(Device).where(Device.serial == "kiosk-android-zzzz"))
    assert d.sub_type == "zebra"


async def test_sparse_beat_keeps_a_stored_zebra(client, db, seeded_user):
    """The update branch derives from the MERGED raw_info, not the incoming
    payload alone: a beat that omits `manufacturer`/`datawedge` leaves the
    stored evidence in place, so the device stays 'zebra'."""
    hdrs = await login(client)
    serial = "kiosk-android-sparse"
    await client.post("/kiosk/heartbeat", headers=hdrs, json={
        **BODY, "serial": serial, "mode": "android",
        "raw_info": {"manufacturer": "Zebra Technologies", "datawedge": "true"}})
    d = await db.scalar(select(Device).where(Device.serial == serial))
    assert d.sub_type == "zebra"

    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json={
        **BODY, "serial": serial, "mode": "android", "raw_info": {"ua": "x"}})
    assert resp.status_code == 200, resp.text
    await db.refresh(d)
    assert d.sub_type == "zebra"
    assert d.raw_info["manufacturer"] == "Zebra Technologies"
    assert d.raw_info["ua"] == "x"


async def test_sign_in_renews_an_expired_registration(client, db, seeded_user):
    hdrs = await login(client)
    await client.post("/kiosk/heartbeat", headers=hdrs, json=BODY)
    d = await db.scalar(select(Device).where(Device.serial == "kiosk-web-aaaa"))
    d.token_expires_at = datetime.now(UTC) - timedelta(days=1)
    await db.commit()

    before = datetime.now(UTC)
    resp = await client.post("/kiosk/heartbeat", headers=hdrs, json={**BODY, "sign_in": True})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["registration"] == "ok"
    expires_at = datetime.fromisoformat(body["token_expires_at"])
    assert abs((expires_at - (before + timedelta(days=30))).total_seconds()) < 60
    audits = (await db.scalars(select(AuditLog).where(AuditLog.action == "register"))).all()
    assert len(audits) == 1
    assert audits[0].changes["source"] == "kiosk_sign_in"
    assert audits[0].changes["days"] == 30
