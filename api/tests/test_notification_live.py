"""Live inbox signals (SS-500): notify() and the inbox mutation routes send
pg_notify('ss_inbox', person_id) on commit only, and the per-process
InboxHub fans each one out to that person's queues, reconnecting (and
poking everyone) when its listen connection is lost."""

import asyncio
import uuid

import pytest
from sqlalchemy import text

from serversherpa.db.models import UserAccount
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.live import (
    INBOX_CHANNEL,
    connect_raw,
    get_hub,
    signal_inbox,
    stop_hub,
)
from tests.test_sites_api import login


@pytest.fixture
async def listener():
    """A raw LISTEN on the inbox channel; yields the queue of payloads."""
    payloads: asyncio.Queue[str] = asyncio.Queue()
    conn = await connect_raw("-test-listen")
    await conn.add_listener(INBOX_CHANNEL, lambda _c, _p, _ch, payload: payloads.put_nowait(payload))
    try:
        yield payloads
    finally:
        await conn.close()


@pytest.fixture
async def hub():
    h = await get_hub()
    try:
        yield h
    finally:
        await stop_hub()


async def _next(q: asyncio.Queue, timeout: float):
    return await asyncio.wait_for(q.get(), timeout)


async def _nothing(q: asyncio.Queue, timeout: float) -> bool:
    try:
        await asyncio.wait_for(q.get(), timeout)
    except TimeoutError:
        return True
    return False


async def _drain(q: asyncio.Queue) -> None:
    """Let anything in flight land, then empty the queue."""
    await asyncio.sleep(0.3)
    while not q.empty():
        q.get_nowait()


async def test_notify_signals_on_commit(db, seeded_user, listener):
    assert await notify(db, seeded_user.id, "report_ready", "Ready") is not None
    await db.commit()
    assert await _next(listener, 2) == str(seeded_user.id)
    assert await _nothing(listener, 0.3)


async def test_notify_does_not_signal_on_rollback(db, seeded_user, listener):
    assert await notify(db, seeded_user.id, "report_ready", "Ready") is not None
    await db.rollback()
    assert await _nothing(listener, 0.5)


async def test_notify_suppressed_row_does_not_signal(db, seeded_user, listener):
    account = await db.get(UserAccount, seeded_user.id)
    account.ui_prefs = {"notif": {"switches": {"reports": {"inbox": False}}}}
    await db.commit()

    assert await notify(db, seeded_user.id, "report_ready", "Hidden") is None
    await db.commit()
    assert await _nothing(listener, 0.5)


async def test_hub_fans_out_to_that_person_only(db, hub):
    p, q = uuid.uuid4(), uuid.uuid4()
    p1, p2, q1 = hub.subscribe(p), hub.subscribe(p), hub.subscribe(q)
    await signal_inbox(db, p)
    await db.commit()
    assert await _next(p1, 2) is None
    assert await _next(p2, 2) is None
    assert await _nothing(q1, 0.3)

    # A burst collapses into one pending poke per queue.
    for _ in range(3):
        await signal_inbox(db, p)
        await db.commit()
    await asyncio.sleep(0.3)
    assert p1.qsize() == 1

    hub.unsubscribe(p, p1)
    p1.get_nowait()
    await signal_inbox(db, p)
    await db.commit()
    await _drain(p2)
    assert p1.empty()


async def test_hub_ignores_payloads_that_are_not_a_uuid(db, hub):
    p = uuid.uuid4()
    q = hub.subscribe(p)
    await db.execute(text("SELECT pg_notify(:ch, 'not-a-uuid')"), {"ch": INBOX_CHANNEL})
    await db.commit()
    assert await _nothing(q, 0.5)


async def test_hub_reconnects_and_pokes_everyone(db, hub):
    p = uuid.uuid4()
    q = hub.subscribe(p)
    killed = await db.scalar(text(
        "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity "
        "WHERE datname = current_database() AND application_name LIKE '%-inbox'"))
    await db.commit()
    assert killed == 1
    assert await _next(q, 5) is None

    # The new connection is listening: a later signal still arrives.
    await signal_inbox(db, p)
    await db.commit()
    assert await _next(q, 2) is None


async def test_stop_hub_resets_the_singleton(hub):
    first = hub
    await stop_hub()
    second = await get_hub()
    assert second is not first


async def test_mutation_routes_signal_only_on_change(client, db, seeded_user, listener):
    hdrs = await login(client)
    row = await notify(db, seeded_user.id, "report_ready", "Ready")
    await db.commit()
    await _drain(listener)
    me = str(seeded_user.id)

    resp = await client.post(f"/notifications/inbox/{row.id}/read", headers=hdrs)
    assert resp.status_code == 204
    assert await _next(listener, 2) == me
    resp = await client.post(f"/notifications/inbox/{row.id}/read", headers=hdrs)
    assert resp.status_code == 204
    assert await _nothing(listener, 0.5)

    resp = await client.post("/notifications/inbox/read-all", headers=hdrs)
    assert resp.status_code == 204
    assert await _nothing(listener, 0.5)

    resp = await client.post(f"/notifications/inbox/{row.id}/unread", headers=hdrs)
    assert resp.status_code == 204
    assert await _next(listener, 2) == me
    resp = await client.post(f"/notifications/inbox/{row.id}/unread", headers=hdrs)
    assert await _nothing(listener, 0.5)

    resp = await client.post("/notifications/inbox/read-all", headers=hdrs)
    assert resp.status_code == 204
    assert await _next(listener, 2) == me

    resp = await client.post("/notifications/inbox/clear-read", headers=hdrs)
    assert resp.status_code == 204
    assert await _next(listener, 2) == me
    resp = await client.post("/notifications/inbox/clear-read", headers=hdrs)
    assert resp.status_code == 204
    assert await _nothing(listener, 0.5)


async def test_hide_route_signals_only_on_change(client, db, seeded_user, listener):
    hdrs = await login(client)
    row = await notify(db, seeded_user.id, "report_ready", "Ready")
    await db.commit()
    await _drain(listener)

    resp = await client.delete(f"/notifications/inbox/{row.id}", headers=hdrs)
    assert resp.status_code == 204
    assert await _next(listener, 2) == str(seeded_user.id)
    resp = await client.delete(f"/notifications/inbox/{row.id}", headers=hdrs)
    assert resp.status_code == 204
    assert await _nothing(listener, 0.5)
