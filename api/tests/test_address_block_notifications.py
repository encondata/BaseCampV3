"""The address_blocked admin notification (SS-487): who hears about a trip,
the exact titles, and how Clear / Block permanently resolve every copy."""
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import select, text, update
from starlette.requests import Request

from serversherpa.db.models import (
    AddressBlock,
    Client,
    Notification,
    Person,
    PersonRole,
    UserAccount,
)
from serversherpa.notifications import address_blocks as notif
from serversherpa.security import address_blocks as ab

T0 = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)
ADDR = "203.0.113.7"


def req(xff: str = ADDR) -> Request:
    return Request({"type": "http", "client": ("127.0.0.1", 1),
                    "headers": [(b"x-forwarded-for", xff.encode())]})


async def person(db, first, role, *, client_id=None, ui_prefs=None) -> uuid.UUID:
    """Seed a person with a sign-in account and one role; returns the id
    (a committed ORM object would expire)."""
    p = Person(first_name=first, last_name="Tester")
    db.add(p)
    await db.flush()
    pid = p.id
    db.add(UserAccount(person_id=p.id, email=f"{first.lower()}@test.example.com",
                       ui_prefs=ui_prefs or {}))
    db.add(PersonRole(person_id=p.id, role=role, client_id=client_id))
    await db.commit()
    return pid


async def trip(db, xff: str = ADDR, now: datetime = T0):
    block = None
    for _ in range(ab.TRIP_FAILURES):
        block = await ab.record_failure(db, req(xff), ab.LOGIN, now=now)
    assert block is not None
    return block


async def rows(db) -> list[Notification]:
    db.expire_all()
    return list(await db.scalars(
        select(Notification).where(Notification.kind == notif.KIND)))


async def test_trip_notifies_every_admin_and_nobody_else(db):
    try:
        await _trip_notifies_every_admin_and_nobody_else(db)
    finally:  # the seeded role's rank is committed: put it back
        await db.rollback()
        await db.execute(text("UPDATE roles SET rank = 20 WHERE name = 'client_admin'"))
        await db.commit()


async def _trip_notifies_every_admin_and_nobody_else(db):
    admin = await person(db, "Ada", "admin")
    sup = await person(db, "Sue", "super_admin")
    staff = await person(db, "Stan", "staff")
    # a client-anchored role of rank 60 (the check constraint only allows the
    # client_* role names to carry a client)
    await db.execute(text("UPDATE roles SET rank = 60 WHERE name = 'client_admin'"))
    c = Client(name="Acme")
    db.add(c)
    await db.flush()
    anchored = await person(db, "Cal", "client_admin", client_id=c.id)
    await trip(db)
    got = await rows(db)
    assert sorted(r.person_id for r in got) == sorted([admin, sup])
    assert staff not in {r.person_id for r in got}
    assert anchored not in {r.person_id for r in got}
    for r in got:
        assert r.title == "Sign-ins blocked from 203.0.113.7 for 1 hour (10 failed attempts)"
        assert r.link == "/system/blocked-addresses"
        assert r.payload["state"] == "open"
        assert r.payload["address"] == ADDR and r.payload["level"] == 1
        assert r.payload["failure_count"] == 10
        assert r.payload["ends_at"] is not None


async def test_notification_survives_security_category_off(db):
    prefs = {"notif": {"switches": {"security": {"inbox": False, "email": False}}}}
    admin = await person(db, "Ada", "admin", ui_prefs=prefs)
    await trip(db)
    assert [r.person_id for r in await rows(db)] == [admin]


async def test_disabled_admin_is_skipped(db):
    admin = await person(db, "Ada", "admin")
    off = await person(db, "Dee", "admin")
    await db.execute(update(UserAccount).where(UserAccount.person_id == off)
                     .values(disabled_at=T0))
    await db.commit()
    await trip(db)
    assert [r.person_id for r in await rows(db)] == [admin]


async def test_permanent_title(db):
    await person(db, "Ada", "admin")
    block = await trip(db)
    block.level = 5
    block.permanent = True
    block.ends_at = None
    assert notif.block_title(block) == (
        "Sign-ins blocked from 203.0.113.7 permanently (10 failed attempts)")
    for level, word in [(2, "6 hours"), (3, "12 hours"), (4, "24 hours")]:
        block.level, block.permanent = level, False
        assert notif.block_title(block) == (
            f"Sign-ins blocked from 203.0.113.7 for {word} (10 failed attempts)")


async def _tries(db, now: datetime) -> None:
    """ESCALATE_TRIES turned-away attempts: one rung up."""
    for _ in range(ab.ESCALATE_TRIES):
        with pytest.raises(HTTPException):
            await ab.raise_if_blocked(db, req(), now=now)


async def test_tries_in_the_title(db):
    await person(db, "Ada", "admin")
    block = await trip(db)
    block.attempts_while_blocked = 20
    assert notif.block_title(block) == (
        "Sign-ins blocked from 203.0.113.7 for 1 hour "
        "(10 failed attempts, 20 tries while blocked)")


async def test_escalation_replaces_each_admins_card_with_a_fresh_unread_one(db):
    a = await person(db, "Ada", "admin")
    s = await person(db, "Sue", "super_admin")
    await trip(db)
    # Ada dismissed hers (Leave as is); Sue never looked
    await db.execute(update(Notification).where(Notification.person_id == a)
                     .values(read_at=T0))
    await db.commit()
    old = {r.id for r in await rows(db)}
    later = T0 + timedelta(minutes=5)
    await _tries(db, later)
    got = await rows(db)
    assert sorted(r.person_id for r in got) == sorted([a, s])
    for r in got:
        assert r.id not in old
        assert r.read_at is None
        assert r.title == ("Sign-ins blocked from 203.0.113.7 for 6 hours "
                           "(10 failed attempts, 10 tries while blocked)")
        assert r.payload["state"] == "open" and r.payload["level"] == 2
        assert r.payload["blocked_at"] == notif.block_key(T0)
        assert r.payload["ends_at"] == (later + timedelta(hours=6)).isoformat()
    # a decision still resolves the fresh cards
    await ab.clear(db, ADDR, actor_id=a, now=later)
    await db.commit()
    assert {r.payload["state"] for r in await rows(db)} == {"cleared"}


async def test_escalation_leaves_an_earlier_blocks_card_alone(db):
    await person(db, "Ada", "admin")
    await trip(db)                                   # block 1, ends T0 + 1 h
    later = T0 + timedelta(hours=2)
    await trip(db, now=later)                        # block 2
    await _tries(db, later)
    keys = sorted(r.payload["blocked_at"] for r in await rows(db))
    assert keys == [notif.block_key(T0), notif.block_key(later)]


async def test_clear_resolves_every_admins_copy(db):
    a = await person(db, "Ada", "admin")
    await person(db, "Sue", "super_admin")
    await trip(db)
    await ab.clear(db, ADDR, actor_id=a, now=T0)
    await db.commit()
    got = await rows(db)
    assert len(got) == 2
    for r in got:
        assert r.payload["state"] == "cleared"
        assert r.payload["decided_by"] == "Ada Tester"
        assert r.read_at is not None


async def test_make_permanent_resolves(db):
    a = await person(db, "Ada", "admin")
    await trip(db)
    await ab.make_permanent(db, ADDR, actor_id=a, now=T0)
    await db.commit()
    (r,) = await rows(db)
    assert r.payload["state"] == "permanent" and r.payload["decided_by"] == "Ada Tester"
    assert r.read_at is not None


async def test_cli_clear_is_server_command_line(db):
    await person(db, "Ada", "admin")
    await trip(db)
    await ab.clear(db, ADDR, actor_id=None, now=T0)
    await db.commit()
    (r,) = await rows(db)
    assert r.payload["decided_by"] == "Server command line"


async def test_clear_does_not_touch_other_addresses(db):
    a = await person(db, "Ada", "admin")
    await trip(db)
    await trip(db, xff="203.0.113.8")
    await ab.clear(db, ADDR, actor_id=a, now=T0)
    await db.commit()
    states = {r.payload["address"]: r.payload["state"] for r in await rows(db)}
    assert states == {ADDR: "cleared", "203.0.113.8": "open"}
    assert await db.scalar(select(AddressBlock).where(AddressBlock.address == ADDR))



async def test_clear_leaves_an_earlier_ended_blocks_card_alone(db):
    """A decision resolves only the current block's cards: a card from an
    earlier block of the same address that ended on its own stays open."""
    a = await person(db, "Ada", "admin")
    old = await trip(db, now=T0)
    old_key = notif.block_key(old.blocked_at)
    later = T0 + timedelta(hours=2)  # the 1-hour block has ended
    new = await trip(db, now=later)
    assert new.level == 2
    await ab.clear(db, ADDR, actor_id=a, now=later)
    await db.commit()
    by_key = {r.payload["blocked_at"]: r.payload for r in await rows(db)}
    assert set(by_key) == {old_key, notif.block_key(later)}
    assert by_key[old_key]["state"] == "open"
    assert "decided_by" not in by_key[old_key]
    assert by_key[notif.block_key(later)]["state"] == "cleared"
