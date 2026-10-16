"""Kiosk station keys (migration 0098): POST /kiosk/station-key issues a
per-device secret (only its sha256 is stored), re-issue replaces it and keeps
the move history, verify() is constant-time, and de-register / Clear Setup
request / Label setup revoke it. Spec §3."""

import hashlib

from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, Device, Initiative
from serversherpa.services import move_password as mp_svc
from serversherpa.services import station_keys
from tests.test_access_roles_api import login_admin
from tests.test_kiosk_setup_api import (
    SERIAL,
    _seed_initiatives,
    _seed_scan_types,
    _seed_sites,
)
from tests.test_sites_api import login

PW = "Crew-2026!"


def _code(r):
    return r.json()["detail"]["code"]


async def _device(db, *, move_name="Key Move A", session_login_method=None):
    init = Initiative(name=move_name, initiative_type="move", status="in_progress")
    db.add(init)
    await db.flush()
    device = Device(device_type="kiosk", name="Station 1", serial=SERIAL,
                    sub_type="laptop", current_initiative_id=init.id,
                    session_login_method=session_login_method)
    db.add(device)
    await db.commit()
    await db.refresh(device)
    await db.refresh(init)
    db.expunge(device)   # keep id readable after the tests' expire_all()
    db.expunge(init)
    return device, init


async def _moves(db, device_id):
    return {r[0] for r in (await db.execute(text(
        "SELECT initiative_id FROM device_station_moves WHERE device_id=:d"),
        {"d": device_id})).all()}


async def _audits(db, device, action):
    db.expire_all()
    return (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.entity_id == str(device.id),
        AuditLog.action == action))).all()


async def test_issue_by_password_session_returns_key_and_stores_hash(client, db, seeded_user):
    hdrs = await login(client)
    user_id = seeded_user.id
    device, init = await _device(db)
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert r.status_code == 200, r.text
    key = r.json()["key"]
    assert key
    db.expire_all()
    d = await db.get(Device, device.id)
    assert len(d.station_key_hash) == 64
    assert d.station_key_hash == hashlib.sha256(key.encode()).hexdigest()
    assert d.station_key_issued_via == "password"
    assert d.station_key_issued_by == user_id
    assert d.station_key_issued_at is not None
    # the raw key is nowhere in the database
    row = await db.scalar(text(
        "SELECT count(*) FROM devices WHERE devices::text LIKE :k"), {"k": f"%{key}%"})
    assert row == 0
    assert await _moves(db, device.id) == {init.id}


async def test_issue_records_link_login_method(client, db, seeded_user):
    hdrs = await login(client)
    device, _ = await _device(db, session_login_method="link")
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert (await db.get(Device, device.id)).station_key_issued_via == "link"


async def test_unknown_device_404(client, db, seeded_user):
    hdrs = await login(client)
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": "nope"})
    assert r.status_code == 404 and _code(r) == "device_not_found"


async def test_issue_by_move_password_session_scoped_to_its_move(client, db, seeded_user):
    device, init = await _device(db)
    live = await db.get(Initiative, init.id)   # _device hands back detached rows
    await mp_svc.set_password(db, live, PW, actor_id=seeded_user.id)
    other = Initiative(name="Key Move B", initiative_type="move", status="in_progress")
    db.add(other)
    await db.commit()
    await db.refresh(other)
    other_id = other.id
    login_r = await client.post("/kiosk/move-login", json={"password": PW})
    assert login_r.status_code == 200, login_r.text
    hdrs = {"Authorization": f"Bearer {login_r.json()['access_token']}"}
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert r.status_code == 200, r.text
    db.expire_all()
    d = await db.get(Device, device.id)
    assert d.station_key_issued_via == "move_password"
    # now the device is set up for another move: the locked session is refused
    d.current_initiative_id = other_id
    await db.commit()
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert r.status_code == 403 and _code(r) == "move_locked"


async def test_reissue_replaces_hash_and_keeps_moves(client, db, seeded_user):
    hdrs = await login(client)
    device, init_a = await _device(db)
    first = (await client.post("/kiosk/station-key", headers=hdrs,
                               json={"serial": SERIAL})).json()["key"]
    init_b = Initiative(name="Key Move B", initiative_type="move", status="in_progress")
    db.add(init_b)
    await db.flush()
    await db.refresh(init_b)
    init_b_id = init_b.id
    (await db.get(Device, device.id)).current_initiative_id = init_b_id
    await db.commit()
    second = (await client.post("/kiosk/station-key", headers=hdrs,
                                json={"serial": SERIAL})).json()["key"]
    assert first != second
    db.expire_all()
    d = await db.get(Device, device.id)
    assert d.station_key_hash == hashlib.sha256(second.encode()).hexdigest()
    assert await _moves(db, device.id) == {init_a.id, init_b_id}
    # re-issuing for the same move does not duplicate
    await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert await _moves(db, device.id) == {init_a.id, init_b_id}


async def test_verify_constant_time_and_unknowns(client, db, seeded_user):
    hdrs = await login(client)
    device, _ = await _device(db)
    key = (await client.post("/kiosk/station-key", headers=hdrs,
                             json={"serial": SERIAL})).json()["key"]
    got = await station_keys.verify(db, SERIAL, key)
    assert got is not None and got.id == device.id
    assert await station_keys.verify(db, SERIAL, key + "x") is None
    assert await station_keys.verify(db, "unknown-serial", key) is None
    d = await db.get(Device, device.id)
    assert await station_keys.revoke(db, d, actor_id=None, reason="test") is True
    await db.commit()
    assert await station_keys.verify(db, SERIAL, key) is None
    assert await station_keys.revoke(db, d, actor_id=None, reason="test") is False


async def test_verify_non_kiosk_device_is_none(db):
    d = Device(device_type="router", name="R", serial="router-key-1",
               station_key_hash=hashlib.sha256(b"k").hexdigest())
    db.add(d)
    await db.commit()
    assert await station_keys.verify(db, "router-key-1", "k") is None


async def test_deregister_revokes_key(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    device, _ = await _device(db)
    key = (await client.post("/kiosk/station-key", headers=hdrs,
                             json={"serial": SERIAL})).json()["key"]
    r = await client.post(f"/devices/{device.id}/deregister", headers=hdrs)
    assert r.status_code == 200, r.text
    db.expire_all()
    d = await db.get(Device, device.id)
    assert d.station_key_hash is None and d.station_key_issued_at is None
    assert await station_keys.verify(db, SERIAL, key) is None
    [row] = await _audits(db, device, "station_key_revoke")
    assert row.changes == {"reason": "deregistered"}


async def test_deregister_without_key_writes_no_revoke_row(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    device, _ = await _device(db)
    r = await client.post(f"/devices/{device.id}/deregister", headers=hdrs)
    assert r.status_code == 200, r.text
    assert await _audits(db, device, "station_key_revoke") == []


async def test_clear_setup_request_revokes_key(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    device, _ = await _device(db)
    await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    r = await client.post(f"/devices/{device.id}/clear-setup", headers=hdrs)
    assert r.status_code == 200, r.text
    db.expire_all()
    assert (await db.get(Device, device.id)).station_key_hash is None
    [row] = await _audits(db, device, "station_key_revoke")
    assert row.changes == {"reason": "clear_setup"}


async def test_label_setup_revokes_key(client, db, seeded_user):
    hdrs = await login(client)
    device = Device(device_type="kiosk", name="Station 1", serial=SERIAL, sub_type="laptop")
    db.add(device)
    origin, dest = await _seed_sites(db)
    planned, *_ = await _seed_initiatives(db, origin_site=origin, dest_site=dest)
    active, *_ = await _seed_scan_types(db)
    device.current_initiative_id = planned.id
    await db.commit()
    await db.refresh(device)
    db.expunge(device)
    planned_id, dest_id, status_key = planned.id, dest.id, active.key
    await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    body = {"serial": SERIAL, "initiative_id": str(planned_id), "site_id": str(dest_id),
            "scan_status": status_key, "station_type": "label"}
    r = await client.post("/kiosk/setup", headers=hdrs, json=body)
    assert r.status_code == 200, r.text
    db.expire_all()
    assert (await db.get(Device, device.id)).station_key_hash is None
    [row] = await _audits(db, device, "station_key_revoke")
    assert row.changes == {"reason": "label_station"}


async def test_audit_rows_never_contain_the_key(client, db, seeded_user):
    hdrs = await login_admin(client, db, seeded_user)
    device, init = await _device(db)
    key = (await client.post("/kiosk/station-key", headers=hdrs,
                             json={"serial": SERIAL})).json()["key"]
    await client.post(f"/devices/{device.id}/deregister", headers=hdrs)
    db.expire_all()
    [issue] = await _audits(db, device, "station_key_issue")
    assert issue.changes == {"initiative_id": str(init.id), "via": "password"}
    rows = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_id == str(device.id)))).all()
    assert rows
    for row in rows:
        assert key not in str(row.changes)
        assert hashlib.sha256(key.encode()).hexdigest() not in str(row.changes)
