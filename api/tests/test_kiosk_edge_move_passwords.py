"""GET /kiosk/edge/move-passwords — the laptop edge caches the hashed
password of the move it is set up for, so a move sign-in works offline.
Only that one move, only while active, never to a move session, and the
plaintext/fingerprint key never leave the server. Only a registered
laptop kiosk that the caller is signed in on gets it, and an unchanged
password (`have=<version>`) costs no argon2 work and no audit row."""

import hashlib
from datetime import UTC, datetime, timedelta

from argon2 import PasswordHasher
from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, Device, Initiative, Person
from serversherpa.services import move_password as svc
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_status_values_write import _make

PW = "Crew-2026!"
SERIAL = "kiosk-laptop-edge-mp-1"
ADMIN = "edge-mp-admin@test.example.com"
URL = f"/kiosk/edge/move-passwords?serial={SERIAL}"


async def _setup(db, client, seeded_user, *, status="in_progress", password=True, set_up=True,
                 sub_type="laptop", registered=True, signed_in=True):
    hdrs = await _make(db, client, "admin", ADMIN)
    me = await db.scalar(select(Person).where(Person.email == ADMIN))
    init = Initiative(name="Edge MP Move", initiative_type="move", status=status)
    db.add(init)
    await db.flush()
    if password:
        await svc.set_password(db, init, PW, actor_id=seeded_user.id)
    now = datetime.now(UTC)
    device = Device(device_type="kiosk", name="Laptop", serial=SERIAL, sub_type=sub_type,
                    current_initiative_id=init.id if set_up else None,
                    registered_at=now if registered else None,
                    token_expires_at=now + timedelta(days=30) if registered else None,
                    session_person_id=me.id if signed_in else None)
    db.add(device)
    await db.commit()
    return hdrs, init


def _version(init) -> str:
    return hashlib.sha256((str(init.id) + (init.kiosk_password_enc or "")).encode()).hexdigest()[:16]


async def _audits(db) -> int:
    return await db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.action == "kiosk_edge_move_password"))


async def test_returns_hash_and_session_template_for_the_set_up_move(client, db, seeded_user):
    hdrs, init = await _setup(db, client, seeded_user)
    r = await client.get(URL, headers=hdrs)
    assert r.status_code == 200, r.text
    assert r.json()["unchanged"] is False
    [move] = r.json()["moves"]
    assert move["initiative_id"] == str(init.id)
    assert move["version"] == _version(init)
    assert PasswordHasher().verify(move["argon2_hash"], PW)
    assert PW not in r.text
    assert move["session"]["kiosk_move"]["initiative_id"] == str(init.id)
    assert move["session"]["perms"]["kiosk"]["view"] is True
    assert "access_token" not in move["session"]
    logged = await db.scalar(select(AuditLog).where(AuditLog.action == "kiosk_edge_move_password"))
    assert logged is not None


async def test_inactive_moves_return_nothing(client, db, seeded_user):
    hdrs, _ = await _setup(db, client, seeded_user, status="completed")
    r = await client.get(URL, headers=hdrs)
    assert r.json() == {"moves": [], "unchanged": False}


async def test_archived_moves_return_nothing(client, db, seeded_user):
    hdrs, init = await _setup(db, client, seeded_user)
    init.archived_at = datetime.now(UTC)
    await db.commit()
    r = await client.get(URL, headers=hdrs)
    assert r.json() == {"moves": [], "unchanged": False}


async def test_passwordless_moves_return_nothing(client, db, seeded_user):
    hdrs, _ = await _setup(db, client, seeded_user, password=False)
    r = await client.get(URL, headers=hdrs)
    assert r.json() == {"moves": [], "unchanged": False}


async def test_device_not_set_up_returns_nothing(client, db, seeded_user):
    hdrs, _ = await _setup(db, client, seeded_user, set_up=False)
    r = await client.get(URL, headers=hdrs)
    assert r.json() == {"moves": [], "unchanged": False}


async def test_unchanged_version_skips_hashing_and_audit(client, db, seeded_user):
    hdrs, init = await _setup(db, client, seeded_user)
    r = await client.get(f"{URL}&have={_version(init)}", headers=hdrs)
    assert r.status_code == 200 and r.json() == {"moves": [], "unchanged": True}
    assert await _audits(db) == 0
    r = await client.get(f"{URL}&have=0000000000000000", headers=hdrs)
    assert [m["version"] for m in r.json()["moves"]] == [_version(init)]
    assert r.json()["unchanged"] is False
    assert await _audits(db) == 1


async def test_non_laptop_kiosk_refused(client, db, seeded_user):
    hdrs, _ = await _setup(db, client, seeded_user, sub_type="web")
    r = await client.get(URL, headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "not_a_laptop"


async def test_unregistered_laptop_refused(client, db, seeded_user):
    hdrs, _ = await _setup(db, client, seeded_user, registered=False)
    r = await client.get(URL, headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "device_not_registered"


async def test_expired_registration_refused(client, db, seeded_user):
    hdrs, _ = await _setup(db, client, seeded_user)
    device = await db.scalar(select(Device).where(Device.serial == SERIAL))
    device.token_expires_at = datetime.now(UTC) - timedelta(minutes=1)
    await db.commit()
    r = await client.get(URL, headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "device_not_registered"


async def test_someone_not_signed_in_on_the_laptop_refused(client, db, seeded_user):
    hdrs, _ = await _setup(db, client, seeded_user, signed_in=False)
    r = await client.get(URL, headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "not_signed_in_here"
    other = await _make(db, client, "admin", "edge-mp-other@test.example.com")
    device = await db.scalar(select(Device).where(Device.serial == SERIAL))
    device.session_person_id = (await db.scalar(
        select(Person).where(Person.email == ADMIN))).id
    await db.commit()
    r = await client.get(URL, headers=other)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "not_signed_in_here"


async def test_signed_in_without_kiosk_view_refused(client, db, seeded_user):
    await _setup(db, client, seeded_user)
    cv = await _client_viewer(db, client, "edge-mp-cv@test.example.com")
    r = await client.get(URL, headers=cv)
    assert r.status_code == 403


async def test_unknown_device_404(client, db, seeded_user):
    hdrs, _ = await _setup(db, client, seeded_user)
    r = await client.get("/kiosk/edge/move-passwords?serial=nope", headers=hdrs)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "device_not_found"


async def test_move_session_refused(client, db, seeded_user):
    await _setup(db, client, seeded_user)
    login = await client.post("/kiosk/move-login", json={"password": PW})
    hdrs = {"Authorization": f"Bearer {login.json()['access_token']}"}
    r = await client.get(URL, headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "move_locked"


async def test_needs_kiosk_view(client, db, seeded_user):
    await _setup(db, client, seeded_user)
    r = await client.get(URL)
    assert r.status_code == 401
