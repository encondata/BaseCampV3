"""Kiosk station keys (migration 0098): POST /kiosk/station-key issues a
per-device secret (only its sha256 is stored), re-issue replaces it and keeps
the move history, verify() is constant-time, and de-register / Clear Setup
request / Label setup revoke it. Spec §3."""

import hashlib
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, AuthSession, Device, Initiative
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


async def _device(db, *, move_name="Key Move A", session_login_method=None,
                  person_id=None, **overrides):
    init = Initiative(name=move_name, initiative_type="move", status="in_progress")
    db.add(init)
    await db.flush()
    fields = dict(device_type="kiosk", name="Station 1", serial=SERIAL,
                  sub_type="laptop", station_type="rfid", current_initiative_id=init.id,
                  token_expires_at=datetime.now(UTC) + timedelta(days=30),
                  session_login_method=session_login_method,
                  session_person_id=person_id)
    fields.update(overrides)
    device = Device(**fields)
    db.add(device)
    await db.commit()
    await db.refresh(device)
    await db.refresh(init)
    db.expunge(device)   # keep id readable after the tests' expire_all()
    db.expunge(init)
    return device, init


async def _audits(db, device, action):
    db.expire_all()
    return (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "device", AuditLog.entity_id == str(device.id),
        AuditLog.action == action))).all()


async def test_issue_by_password_session_returns_key_and_stores_hash(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    device, init = await _device(db, person_id=uid)
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert r.status_code == 200, r.text
    key = r.json()["key"]
    assert key
    db.expire_all()
    d = await db.get(Device, device.id)
    assert len(d.station_key_hash) == 64
    assert d.station_key_hash == hashlib.sha256(key.encode()).hexdigest()
    assert d.station_key_issued_via == "password"
    assert d.station_key_issued_by == uid
    assert d.station_key_issued_at is not None
    # the raw key is nowhere in the database
    row = await db.scalar(text(
        "SELECT count(*) FROM devices WHERE devices::text LIKE :k"), {"k": f"%{key}%"})
    assert row == 0
    assert d.station_key_initiative_id == init.id


async def test_issue_records_link_login_method(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    device, _ = await _device(db, session_login_method="link", person_id=uid)
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert (await db.get(Device, device.id)).station_key_issued_via == "link"


async def test_unknown_device_404(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": "nope"})
    assert r.status_code == 404 and _code(r) == "device_not_found"


async def test_issue_by_move_password_session_scoped_to_its_move(client, db, seeded_user):
    uid = seeded_user.id
    device, init = await _device(db, person_id=uid)
    init_id = init.id
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
    identity = await db.scalar(select(AuthSession.person_id).where(
        AuthSession.initiative_id == init_id))
    (await db.get(Device, device.id)).session_person_id = identity
    await db.commit()
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


async def test_reissue_replaces_hash_and_move(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    device, init_a = await _device(db, person_id=uid)
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
    assert d.station_key_initiative_id == init_b_id
    assert await station_keys.verify(db, SERIAL, first) is None
    assert (await station_keys.verify(db, SERIAL, second)).id == device.id


async def test_issue_guards(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)

    async def attempt():
        return await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})

    async def reset(device, **fields):
        d = await db.get(Device, device.id)
        for k, v in fields.items():
            setattr(d, k, v)
        await db.commit()

    device, init = await _device(db, person_id=uid)
    init_id = init.id
    for fields in ({"station_type": None},
                   {"sub_type": "web"}, {"current_initiative_id": None}):
        await reset(device, **fields)
        r = await attempt()
        assert r.status_code == 409 and _code(r) == "not_rfid_station", fields
        await reset(device, station_type="rfid", sub_type="laptop",
                    current_initiative_id=init_id)
    for expires in (None, datetime.now(UTC) - timedelta(days=1)):
        await reset(device, token_expires_at=expires)
        r = await attempt()
        assert r.status_code == 409 and _code(r) == "kiosk_not_registered"
    await reset(device, token_expires_at=datetime.now(UTC) + timedelta(days=30),
                setup_clear_id=uuid.uuid4())
    r = await attempt()
    assert r.status_code == 409 and _code(r) == "setup_clear_pending"
    await reset(device, setup_clear_id=None, session_person_id=None)
    r = await attempt()
    assert r.status_code == 403 and _code(r) == "not_signed_in_here"
    await reset(device, session_person_id=uid)
    assert (await attempt()).status_code == 200


async def test_verify_constant_time_and_unknowns(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    device, _ = await _device(db, person_id=uid)
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
    uid = seeded_user.id
    hdrs = await login_admin(client, db, seeded_user)
    device, _ = await _device(db, person_id=uid)
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
    uid = seeded_user.id
    hdrs = await login_admin(client, db, seeded_user)
    device, _ = await _device(db, person_id=uid)
    r = await client.post(f"/devices/{device.id}/deregister", headers=hdrs)
    assert r.status_code == 200, r.text
    assert await _audits(db, device, "station_key_revoke") == []


async def test_clear_setup_request_revokes_key(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login_admin(client, db, seeded_user)
    device, _ = await _device(db, person_id=uid)
    await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    r = await client.post(f"/devices/{device.id}/clear-setup", headers=hdrs)
    assert r.status_code == 200, r.text
    db.expire_all()
    assert (await db.get(Device, device.id)).station_key_hash is None
    [row] = await _audits(db, device, "station_key_revoke")
    assert row.changes == {"reason": "clear_setup"}


async def test_label_station_can_get_a_station_key(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    device, _ = await _device(db, person_id=uid, station_type="label")
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert r.status_code == 200, r.text
    db.expire_all()
    assert (await db.get(Device, device.id)).station_key_hash is not None


async def test_non_station_laptop_still_refused(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    await _device(db, person_id=uid, station_type=None)
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert r.status_code == 409 and _code(r) == "not_rfid_station"


async def test_verify_accepts_label_station(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    device, _ = await _device(db, person_id=uid, station_type="label")
    key = (await client.post("/kiosk/station-key", headers=hdrs,
                             json={"serial": SERIAL})).json()["key"]
    got = await station_keys.verify(db, SERIAL, key)
    assert got is not None and got.id == device.id


async def test_label_station_setup_keeps_its_key(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login(client)
    device = Device(device_type="kiosk", name="Station 1", serial=SERIAL, sub_type="laptop",
                    station_type="rfid", session_person_id=uid,
                    token_expires_at=datetime.now(UTC) + timedelta(days=30))
    db.add(device)
    origin, dest = await _seed_sites(db)
    planned, *_ = await _seed_initiatives(db, origin_site=origin, dest_site=dest)
    active, *_ = await _seed_scan_types(db)
    device.current_initiative_id = planned.id
    await db.commit()
    await db.refresh(device)
    db.expunge(device)
    planned_id, dest_id, status_key = planned.id, dest.id, active.key
    body = {"serial": SERIAL, "initiative_id": str(planned_id), "site_id": str(dest_id),
            "scan_status": status_key, "station_type": "label"}
    issued = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert issued.status_code == 200, issued.text
    r = await client.post("/kiosk/setup", headers=hdrs, json=body)
    assert r.status_code == 200, r.text
    db.expire_all()
    assert (await db.get(Device, device.id)).station_key_hash is not None
    assert await _audits(db, device, "station_key_revoke") == []


async def test_audit_rows_never_contain_the_key(client, db, seeded_user):
    uid = seeded_user.id
    hdrs = await login_admin(client, db, seeded_user)
    device, init = await _device(db, person_id=uid)
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
