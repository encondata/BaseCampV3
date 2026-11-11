"""Sign-in address blocks (SS-487): the blocking service core in
`serversherpa.security.address_blocks` — trip, ladder, reset, clear,
make permanent, exemptions, IPv6 /64 keying, concurrency and listing."""
import asyncio
import ipaddress
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import HTTPException
from sqlalchemy import func, select
from starlette.requests import Request

from serversherpa.db.models import AddressBlock, SignInFailure
from serversherpa.security import address_blocks as ab

T0 = datetime(2026, 11, 10, 12, 0, tzinfo=UTC)


def req(xff: str | None = "203.0.113.7", client=("127.0.0.1", 1)) -> Request:
    headers = [(b"x-forwarded-for", xff.encode())] if xff else []
    return Request({"type": "http", "client": client, "headers": headers})


async def fail(db, n: int, now: datetime, *, xff="203.0.113.7", route=ab.LOGIN):
    """Record n failures at `now`; return the last call's result."""
    result = None
    for _ in range(n):
        result = await ab.record_failure(db, req(xff), route, now=now)
    return result


async def failure_rows(db) -> int:
    return await db.scalar(select(func.count()).select_from(SignInFailure))


async def test_nine_failures_do_not_block(db):
    assert await fail(db, 9, T0) is None
    assert await ab.active_block(db, "203.0.113.7", now=T0) is None
    assert await failure_rows(db) == 9


async def test_tenth_failure_blocks_for_one_hour(db):
    await fail(db, 9, T0)
    block = await fail(db, 1, T0)
    assert block is not None
    assert block.address == "203.0.113.7"
    assert block.level == 1
    assert block.permanent is False
    assert block.blocked_at == T0
    assert block.ends_at == T0 + timedelta(hours=1)
    assert block.first_blocked_at == T0
    assert block.times_blocked == 1
    assert block.failure_count == 10
    assert block.last_route == "login"
    assert ab.block_state(block, T0) == "blocked"
    assert (await ab.active_block(db, "203.0.113.7", now=T0)).address == "203.0.113.7"
    # the trip's failures are gone
    assert await failure_rows(db) == 0


async def test_failures_older_than_an_hour_do_not_count(db):
    await fail(db, 9, T0)
    assert await fail(db, 1, T0 + timedelta(minutes=61)) is None
    assert await ab.active_block(db, "203.0.113.7", now=T0 + timedelta(minutes=61)) is None
    # the global prune removed the nine stale rows
    assert await failure_rows(db) == 1


async def test_ladder(db):
    now = T0
    expected = [(1, timedelta(hours=1)), (2, timedelta(hours=6)),
                (3, timedelta(hours=12)), (4, timedelta(hours=24))]
    for level, duration in expected:
        block = await fail(db, 10, now)
        assert block is not None
        assert block.level == level
        assert block.permanent is False
        assert block.ends_at == now + duration
        assert block.first_blocked_at == T0
        now = block.ends_at + timedelta(minutes=1)
        assert ab.block_state(block, now) == "ended"
        assert ab.ended_at(block, now) == block.ends_at
    block = await fail(db, 10, now)
    assert block.level == 5
    assert block.permanent is True
    assert block.ends_at is None
    assert block.times_blocked == 5
    assert ab.block_state(block, now + timedelta(days=365)) == "permanent"
    assert ab.ended_at(block, now + timedelta(days=365)) is None


async def test_seven_days_without_a_block_resets_to_level_one(db):
    await fail(db, 10, T0, xff="203.0.113.7")
    await fail(db, 10, T0, xff="203.0.113.8")
    later = await fail(db, 10, T0 + timedelta(days=7), xff="203.0.113.7")
    assert later.level == 1
    assert later.times_blocked == 2
    sooner = await fail(db, 10, T0 + timedelta(days=6, hours=23), xff="203.0.113.8")
    assert sooner.level == 2


async def test_clear_resets_level_and_failures(db, seeded_user):
    await fail(db, 10, T0)
    cleared = await ab.clear(db, "203.0.113.7", actor_id=seeded_user.id,
                             now=T0 + timedelta(minutes=5))
    await db.commit()
    assert cleared.level == 0
    assert cleared.cleared_at == T0 + timedelta(minutes=5)
    assert cleared.cleared_by == seeded_user.id
    assert ab.block_state(cleared, T0 + timedelta(minutes=5)) == "ended"
    assert ab.ended_at(cleared, T0 + timedelta(minutes=10)) == T0 + timedelta(minutes=5)

    t1 = T0 + timedelta(minutes=10)
    assert await fail(db, 1, t1) is None
    assert await ab.active_block(db, "203.0.113.7", now=t1) is None
    block = await fail(db, 9, t1)
    assert block is not None
    assert block.level == 1
    assert block.cleared_at is None
    assert block.cleared_by is None
    assert block.times_blocked == 2


async def test_make_permanent(db, seeded_user):
    await fail(db, 10, T0)
    block = await ab.make_permanent(db, "203.0.113.7", actor_id=seeded_user.id,
                                    now=T0 + timedelta(minutes=1))
    await db.commit()
    assert block.permanent is True
    assert block.ends_at is None
    assert block.made_permanent_at == T0 + timedelta(minutes=1)
    assert block.made_permanent_by == seeded_user.id
    assert ab.block_state(block, T0 + timedelta(days=30)) == "permanent"
    # already permanent: not a timed active block
    with pytest.raises(ab.BlockNotActive):
        await ab.make_permanent(db, "203.0.113.7", actor_id=seeded_user.id,
                                now=T0 + timedelta(minutes=2))

    # an ended (expired) block cannot be made permanent
    await fail(db, 10, T0, xff="203.0.113.9")
    with pytest.raises(ab.BlockNotActive):
        await ab.make_permanent(db, "203.0.113.9", actor_id=seeded_user.id,
                                now=T0 + timedelta(hours=2))
    with pytest.raises(ab.BlockNotFound):
        await ab.clear(db, "198.51.100.1", actor_id=seeded_user.id, now=T0)
    with pytest.raises(ab.BlockNotFound):
        await ab.make_permanent(db, "198.51.100.1", actor_id=seeded_user.id, now=T0)
    # clearing an ended block is refused too
    with pytest.raises(ab.BlockNotActive):
        await ab.clear(db, "203.0.113.9", actor_id=seeded_user.id,
                       now=T0 + timedelta(hours=2))


async def test_exempt_addresses_never_count(db):
    for request in (req(None, ("127.0.0.1", 1)), req(None, ("::1", 1)),
                    req(None, None)):
        assert ab.address_for(request) is None
        for _ in range(12):
            assert await ab.record_failure(db, request, ab.LOGIN, now=T0) is None
        await ab.raise_if_blocked(db, request)
    assert await failure_rows(db) == 0
    assert ab.is_exempt("unknown")
    assert ab.is_exempt("not-an-address")
    assert ab.is_exempt("127.5.5.5")
    assert ab.is_exempt("::1")
    assert not ab.is_exempt("10.0.0.5")
    assert not ab.is_exempt("203.0.113.7")
    assert not ab.is_exempt("2001:db8::/64")


# ── who may set X-Forwarded-For (I1) and the proxy exemption (I2) ──

@pytest.fixture
def proxies(monkeypatch):
    """Set FORWARDED_ALLOW_IPS for one test (None unsets it)."""
    def set_(value):
        if value is None:
            monkeypatch.delenv("FORWARDED_ALLOW_IPS", raising=False)
        else:
            monkeypatch.setenv("FORWARDED_ALLOW_IPS", value)
    return set_


def test_untrusted_private_peer_is_keyed_on_itself(proxies):
    proxies(None)
    assert ab.address_for(req("203.0.113.7", ("10.0.0.9", 1))) == "10.0.0.9"
    proxies("10.0.0.2")
    assert ab.address_for(req("203.0.113.7", ("10.0.0.9", 1))) == "10.0.0.9"
    assert ab.address_for(req("203.0.113.7", ("8.8.8.8", 1))) == "8.8.8.8"


def test_trusted_proxy_peer_honors_rightmost_xff(proxies):
    proxies("10.0.0.2")
    assert ab.address_for(req("203.0.113.7", ("10.0.0.2", 1))) == "203.0.113.7"
    assert ab.address_for(req("1.2.3.4, 203.0.113.7", ("10.0.0.2", 1))) == "203.0.113.7"
    # an unparseable rightmost entry falls back to the peer (exempt here)
    assert ab.address_for(req("garbage", ("10.0.0.2", 1))) is None
    proxies("bogus, 10.0.0.0/24")
    assert ab.address_for(req("203.0.113.7", ("10.0.0.5", 1))) == "203.0.113.7"
    assert ab.trusted_proxies() == (False, (ipaddress.ip_network("10.0.0.0/24"),))


def test_loopback_peer_always_honors_xff(proxies):
    for value in (None, "10.0.0.2"):
        proxies(value)
        assert ab.address_for(req("203.0.113.7", ("127.0.0.1", 1))) == "203.0.113.7"
        assert ab.address_for(req("203.0.113.7", ("::1", 1))) == "203.0.113.7"


def test_wildcard_keeps_private_peer_rule(proxies):
    proxies("*")
    assert ab.address_for(req("203.0.113.7", ("10.0.0.9", 1))) == "203.0.113.7"
    assert ab.address_for(req("203.0.113.7", ("8.8.8.8", 1))) == "8.8.8.8"
    # `*` exempts nothing beyond loopback
    assert not ab.is_exempt("10.0.0.9")


async def test_trusted_proxy_address_is_exempt(db, proxies):
    proxies("10.0.0.2")
    request = req(None, ("10.0.0.2", 1))
    assert ab.address_for(request) is None
    for _ in range(12):
        assert await ab.record_failure(db, request, ab.LOGIN, now=T0) is None
    assert await failure_rows(db) == 0
    assert ab.is_exempt("10.0.0.2")
    assert ab.is_exempt("::ffff:10.0.0.2")
    assert not ab.is_exempt("10.0.0.3")
    proxies("10.0.0.0/24")
    assert ab.is_exempt("10.0.0.5")
    assert ab.address_for(req(None, ("10.0.0.5", 1))) is None
    for _ in range(12):
        assert await ab.record_failure(db, req(None, ("10.0.0.5", 1)), ab.LOGIN,
                                       now=T0) is None
    assert await failure_rows(db) == 0
    assert not ab.is_exempt("10.0.1.5")


async def test_announce_error_keeps_the_block(db, monkeypatch, caplog):
    import serversherpa.notifications.address_blocks as notif

    async def boom(db, block):
        raise RuntimeError("inbox down")
    monkeypatch.setattr(notif, "announce_block", boom)
    await fail(db, 9, T0)
    with caplog.at_level("ERROR", logger=ab.__name__):
        block = await fail(db, 1, T0)
    assert block is not None and block.address == "203.0.113.7"
    db.expire_all()
    row = await db.scalar(select(AddressBlock).where(AddressBlock.address == "203.0.113.7"))
    assert row is not None and row.level == 1
    assert (await ab.active_block(db, "203.0.113.7", now=T0)) is not None
    assert any("RuntimeError" in r.getMessage() and "203.0.113.7" in r.getMessage()
               for r in caplog.records)


async def test_ipv6_counts_by_64(db):
    block = None
    for i in range(1, 11):
        block = await ab.record_failure(db, req(f"2001:db8::{i:x}"), ab.LOGIN, now=T0)
    assert block is not None
    assert block.address == "2001:db8::/64"
    assert ab.address_for(req("2001:db8::ffff")) == "2001:db8::/64"
    assert ab.address_for(req("::ffff:203.0.113.7")) == "203.0.113.7"


async def test_concurrent_failures_block_once(db):
    from serversherpa.db.engine import get_sessionmaker

    await fail(db, 9, T0)
    sessions = [get_sessionmaker()() for _ in range(3)]
    try:
        results = await asyncio.gather(*(
            ab.record_failure(s, req(), ab.LOGIN, now=T0) for s in sessions))
    finally:
        for s in sessions:
            await s.close()
    assert sum(r is not None for r in results) == 1
    block = await ab.active_block(db, "203.0.113.7", now=T0)
    assert block.times_blocked == 1
    assert block.level == 1


async def test_raise_if_blocked(db, seeded_user):
    await ab.raise_if_blocked(db, req())  # no block: no-op
    await fail(db, 10, T0)
    block = await ab.active_block(db, "203.0.113.7", now=T0)
    err = ab.blocked_error(block, T0)
    assert err.status_code == 429
    assert err.detail == {"code": "address_blocked", "retry_after": 3600}
    assert err.headers == {"Retry-After": "3600"}
    # just before the end it still rounds up to at least 1
    err = ab.blocked_error(block, T0 + timedelta(hours=1) - timedelta(milliseconds=10))
    assert err.detail["retry_after"] == 1

    # raise_if_blocked against the real clock: a fresh block right now
    await fail(db, 10, datetime.now(UTC), xff="203.0.113.20")
    with pytest.raises(HTTPException) as caught:
        await ab.raise_if_blocked(db, req("203.0.113.20"))
    assert caught.value.status_code == 429
    assert caught.value.detail["code"] == "address_blocked"
    assert 3590 <= caught.value.detail["retry_after"] <= 3600
    assert caught.value.headers["Retry-After"] == str(caught.value.detail["retry_after"])

    await ab.make_permanent(db, "203.0.113.20", actor_id=seeded_user.id)
    await db.commit()
    with pytest.raises(HTTPException) as caught:
        await ab.raise_if_blocked(db, req("203.0.113.20"))
    assert caught.value.detail == {"code": "address_blocked", "retry_after": None}
    assert not caught.value.headers


async def test_blocked_attempts_are_counted_and_reset_by_the_next_block(db, seeded_user):
    now = datetime.now(UTC)
    await fail(db, 10, now, xff="203.0.113.21")
    block = await ab.active_block(db, "203.0.113.21")
    assert block.attempts_while_blocked == 0 and block.last_attempt_at is None

    for _ in range(3):
        with pytest.raises(HTTPException):
            await ab.raise_if_blocked(db, req("203.0.113.21"))
    # committed by raise_if_blocked: a fresh read sees it
    block = await ab.active_block(db, "203.0.113.21")
    assert block.attempts_while_blocked == 3
    assert now <= block.last_attempt_at <= datetime.now(UTC)

    # a permanent block keeps counting
    await ab.make_permanent(db, "203.0.113.21", actor_id=seeded_user.id)
    await db.commit()
    with pytest.raises(HTTPException):
        await ab.raise_if_blocked(db, req("203.0.113.21"))
    assert (await ab.active_block(db, "203.0.113.21")).attempts_while_blocked == 4

    # cleared: the count stays on the ended row, and the next block starts at zero
    await ab.clear(db, "203.0.113.21", actor_id=seeded_user.id)
    await db.commit()
    await ab.raise_if_blocked(db, req("203.0.113.21"))  # not blocked: no-op, not counted
    row = await db.get(AddressBlock, "203.0.113.21", populate_existing=True)
    assert row.attempts_while_blocked == 4
    block = await fail(db, 10, datetime.now(UTC), xff="203.0.113.21")
    assert block.attempts_while_blocked == 0 and block.last_attempt_at is None


async def tries(db, n: int, now: datetime, xff="203.0.113.7") -> HTTPException:
    """n attempts from a blocked address at `now`; returns the last 429."""
    errors = []
    for _ in range(n):
        with pytest.raises(HTTPException) as caught:
            await ab.raise_if_blocked(db, req(xff), now=now)
        errors.append(caught.value)
    return errors[-1]


async def test_ten_tries_while_blocked_move_up_a_rung_from_now(db):
    await fail(db, 10, T0)
    later = T0 + timedelta(minutes=20)
    err = await tries(db, 9, later)
    block = await ab.active_block(db, "203.0.113.7", now=later)
    assert block.level == 1 and block.ends_at == T0 + timedelta(hours=1)
    assert err.detail["retry_after"] == 40 * 60

    err = await tries(db, 1, later)  # the 10th try
    block = await ab.active_block(db, "203.0.113.7", now=later)
    assert block.level == 2
    assert block.ends_at == later + timedelta(hours=6)  # the clock restarts now
    assert block.permanent is False
    assert block.blocked_at == T0 and block.times_blocked == 1  # still the same block
    assert block.attempts_while_blocked == 10
    assert err.detail["retry_after"] == 6 * 3600  # the 10th try already sees the new end


async def test_tries_climb_the_ladder_to_permanent_and_keep_counting(db):
    await fail(db, 10, T0)
    for level, hours in [(2, 6), (3, 12), (4, 24)]:
        await tries(db, 10, T0)
        block = await ab.active_block(db, "203.0.113.7", now=T0)
        assert (block.level, block.ends_at) == (level, T0 + timedelta(hours=hours))
    err = await tries(db, 10, T0)
    block = await ab.active_block(db, "203.0.113.7", now=T0)
    assert block.level == 5 and block.permanent is True and block.ends_at is None
    assert block.made_permanent_by is None  # the ladder, not an admin
    assert err.detail == {"code": "address_blocked", "retry_after": None}
    await tries(db, 15, T0)
    block = await ab.active_block(db, "203.0.113.7", now=T0)
    assert block.level == 5 and block.attempts_while_blocked == 55


async def test_a_new_block_after_escalation_continues_up_the_ladder(db):
    await fail(db, 10, T0)
    await tries(db, 10, T0)  # level 2, ends T0 + 6 h
    after = T0 + timedelta(hours=7)
    block = await fail(db, 10, after)
    assert block.level == 3 and block.attempts_while_blocked == 0


async def test_list_blocks(db, seeded_user):
    now = T0 + timedelta(days=40)
    # active timed
    await fail(db, 10, now - timedelta(minutes=10), xff="198.51.100.1")
    # active permanent
    await fail(db, 10, now - timedelta(minutes=20), xff="198.51.100.2")
    await ab.make_permanent(db, "198.51.100.2", actor_id=seeded_user.id,
                            now=now - timedelta(minutes=19))
    # ended by expiry 5 days ago
    await fail(db, 10, now - timedelta(days=5, hours=1), xff="198.51.100.3")
    # ended by a clear 2 days ago
    await fail(db, 10, now - timedelta(days=2), xff="198.51.100.4")
    await ab.clear(db, "198.51.100.4", actor_id=seeded_user.id,
                   now=now - timedelta(days=2) + timedelta(minutes=1))
    # ended 31 days ago: left out
    await fail(db, 10, now - timedelta(days=31, hours=1), xff="198.51.100.5")
    await db.commit()

    active = await ab.list_blocks(db, "active", now=now)
    assert [b.address for b in active] == ["198.51.100.1", "198.51.100.2"]
    ended = await ab.list_blocks(db, "ended", now=now)
    assert [b.address for b in ended] == ["198.51.100.4", "198.51.100.3"]
    total = await db.scalar(select(func.count()).select_from(AddressBlock))
    assert total == 5
