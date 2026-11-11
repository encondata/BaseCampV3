"""System › Blocked addresses routes (SS-487, Task 4): the admin gate, the
list, and Clear / Block permanently."""
from datetime import UTC, datetime, timedelta

from sqlalchemy import select, text

from serversherpa.db.models import AddressBlock, AuditLog, Client, Notification, Person
from serversherpa.notifications import address_blocks as notif
from serversherpa.security import address_blocks as ab
from tests.test_address_block_notifications import person, trip
from tests.test_sites_api import login
from tests.test_status_values_write import _make

URL = "/system/blocked-addresses"
ADDR = "203.0.113.7"


async def _login_person(db, client, first, role, **kw):
    pid = await person(db, first, role, **kw)
    acct_email = f"{first.lower()}@test.example.com"
    from serversherpa.config import get_settings
    from serversherpa.db.models import UserAccount
    from serversherpa.security.passwords import hash_password
    acct = await db.scalar(select(UserAccount).where(UserAccount.person_id == pid))
    acct.password_hash = hash_password(
        "CorrectHorse9!", pepper=get_settings().password_pepper.get_secret_value())
    acct.email_verified_at = None
    await db.commit()
    return pid, await login(client, email=acct_email)


async def _admin(db, client):
    return await _login_person(db, client, "Ada", "admin")


async def _block(db, addr=ADDR, now=None):
    return await trip(db, addr, now or datetime.now(UTC))


async def test_list_requires_admin(client, db, seeded_user):
    try:
        staff = await login(client)
        r = await client.get(URL, headers=staff)
        assert r.status_code == 403 and r.json()["detail"]["code"] == "forbidden"
        await db.execute(text("UPDATE roles SET rank = 60 WHERE name = 'client_admin'"))
        c = Client(name="Acme")
        db.add(c)
        await db.flush()
        _, anchored = await _login_person(db, client, "Cal", "client_admin", client_id=c.id)
        r = await client.get(URL, headers=anchored)
        assert r.status_code == 403
        _, admin = await _admin(db, client)
        assert (await client.get(URL, headers=admin)).status_code == 200
    finally:
        await db.rollback()
        await db.execute(text("UPDATE roles SET rank = 20 WHERE name = 'client_admin'"))
        await db.commit()


async def test_actions_require_admin(client, db, seeded_user):
    staff = await login(client)
    for path in ("clear", "permanent"):
        r = await client.post(f"{URL}/{path}", headers=staff, json={"address": ADDR})
        assert r.status_code == 403


async def test_list_active_and_ended(client, db, seeded_user):
    _, admin = await _admin(db, client)
    await _block(db)
    old = datetime.now(UTC) - timedelta(days=2)
    await _block(db, "203.0.113.9", old)       # 1 h block, ended a day ago
    r = await client.get(URL, headers=admin)
    rows = r.json()
    assert [x["address"] for x in rows] == [ADDR]
    row = rows[0]
    assert row["status"] == "blocked" and row["level"] == 1
    assert row["ends_at"] and row["ended_at"] is None
    assert row["failure_count"] == 10 and row["last_route"] == "login"
    assert row["attempts_while_blocked"] == 0 and row["last_attempt_at"] is None
    ended = (await client.get(URL, headers=admin, params={"show": "ended"})).json()
    assert [x["address"] for x in ended] == ["203.0.113.9"]
    assert ended[0]["status"] == "ended" and ended[0]["ended_at"]


async def test_clear(client, db, seeded_user):
    pid, admin = await _admin(db, client)
    await _block(db)
    r = await client.post(f"{URL}/clear", headers=admin, json={"address": ADDR})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "ended" and body["cleared_by_name"] == "Ada Tester"
    db.expire_all()
    log = await db.scalar(select(AuditLog).where(AuditLog.action == "address_block_cleared"))
    assert log.entity_type == "address_block" and log.entity_id == ADDR
    assert log.changes == {"address": ADDR, "level": 1} and log.actor_person_id == pid
    again = await client.post(f"{URL}/clear", headers=admin, json={"address": ADDR})
    assert again.status_code == 409 and again.json()["detail"]["code"] == "block_not_active"
    unknown = await client.post(f"{URL}/clear", headers=admin, json={"address": "198.51.100.1"})
    assert unknown.status_code == 404 and unknown.json()["detail"]["code"] == "block_not_found"


async def test_make_permanent(client, db, seeded_user):
    pid, admin = await _admin(db, client)
    await _block(db)
    r = await client.post(f"{URL}/permanent", headers=admin, json={"address": ADDR})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "permanent" and body["ends_at"] is None
    assert body["made_permanent_by_name"] == "Ada Tester"
    db.expire_all()
    note = await db.scalar(select(Notification).where(
        Notification.kind == notif.KIND, Notification.person_id == pid))
    assert "permanent" in str(note.payload).lower()
    log = await db.scalar(select(AuditLog).where(
        AuditLog.action == "address_block_made_permanent"))
    assert log.entity_id == ADDR


async def test_ipv6_key_in_body(client, db, seeded_user):
    _, admin = await _admin(db, client)
    await _block(db, "2001:db8::5")
    r = await client.post(f"{URL}/clear", headers=admin, json={"address": "2001:db8::/64"})
    assert r.status_code == 200, r.text
    assert r.json()["address"] == "2001:db8::/64"
