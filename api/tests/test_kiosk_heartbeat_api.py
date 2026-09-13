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


async def test_heartbeat_blocked_in_read_only_mode(client, db, seeded_user):
    admin = await _admin(db, client)
    assert (await client.put("/system/admin", headers=admin,
                             json={"read_only": True})).status_code == 200
    staff = await _make(db, client, "staff", "st@test.example.com")
    assert (await client.post("/kiosk/heartbeat", headers=staff, json=BODY)).status_code == 423
