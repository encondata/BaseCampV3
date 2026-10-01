"""GET /kiosk/edge/move-passwords — the laptop edge caches the hashed
password of the move it is set up for, so a move sign-in works offline.
Only that one move, only while active, never to a move session, and the
plaintext/fingerprint key never leave the server."""

from argon2 import PasswordHasher
from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device, Initiative
from serversherpa.services import move_password as svc
from tests.test_status_values_write import _make

PW = "Crew-2026!"
SERIAL = "kiosk-laptop-edge-mp-1"


async def _setup(db, client, seeded_user, *, status="in_progress", password=True, set_up=True):
    hdrs = await _make(db, client, "admin", "edge-mp-admin@test.example.com")
    init = Initiative(name="Edge MP Move", initiative_type="move", status=status)
    db.add(init)
    await db.flush()
    if password:
        await svc.set_password(db, init, PW, actor_id=seeded_user.id)
    device = Device(device_type="kiosk", name="Laptop", serial=SERIAL,
                    current_initiative_id=init.id if set_up else None)
    db.add(device)
    await db.commit()
    return hdrs, init


async def test_returns_hash_and_session_template_for_the_set_up_move(client, db, seeded_user):
    hdrs, init = await _setup(db, client, seeded_user)
    r = await client.get(f"/kiosk/edge/move-passwords?serial={SERIAL}", headers=hdrs)
    assert r.status_code == 200, r.text
    [move] = r.json()["moves"]
    assert move["initiative_id"] == str(init.id)
    assert PasswordHasher().verify(move["argon2_hash"], PW)
    assert PW not in r.text
    assert move["session"]["kiosk_move"]["initiative_id"] == str(init.id)
    assert move["session"]["perms"]["kiosk"]["view"] is True
    assert "access_token" not in move["session"]
    logged = await db.scalar(select(AuditLog).where(AuditLog.action == "kiosk_edge_move_password"))
    assert logged is not None


async def test_inactive_unset_or_passwordless_moves_return_nothing(client, db, seeded_user):
    hdrs, init = await _setup(db, client, seeded_user, status="completed")
    r = await client.get(f"/kiosk/edge/move-passwords?serial={SERIAL}", headers=hdrs)
    assert r.json() == {"moves": []}


async def test_device_not_set_up_returns_nothing(client, db, seeded_user):
    hdrs, _ = await _setup(db, client, seeded_user, set_up=False)
    r = await client.get(f"/kiosk/edge/move-passwords?serial={SERIAL}", headers=hdrs)
    assert r.json() == {"moves": []}


async def test_unknown_device_404(client, db, seeded_user):
    hdrs, _ = await _setup(db, client, seeded_user)
    r = await client.get("/kiosk/edge/move-passwords?serial=nope", headers=hdrs)
    assert r.status_code == 404 and r.json()["detail"]["code"] == "device_not_found"


async def test_move_session_refused(client, db, seeded_user):
    await _setup(db, client, seeded_user)
    login = await client.post("/kiosk/move-login", json={"password": PW})
    hdrs = {"Authorization": f"Bearer {login.json()['access_token']}"}
    r = await client.get(f"/kiosk/edge/move-passwords?serial={SERIAL}", headers=hdrs)
    assert r.status_code == 403 and r.json()["detail"]["code"] == "move_locked"


async def test_needs_kiosk_view(client, db, seeded_user):
    await _setup(db, client, seeded_user)
    r = await client.get(f"/kiosk/edge/move-passwords?serial={SERIAL}")
    assert r.status_code == 401
