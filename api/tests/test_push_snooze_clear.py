"""Snooze, clear on read or hide, and the bump re-push: the queue side of push
(the sender is push/delivery.py). Nothing is ever sent here.

Spec: docs/superpowers/specs/2026-11-17-android-push-notifications-design.md"""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from serversherpa.db.models import Notification, NotificationLog, PushOutbox, UserAccount
from serversherpa.notifications import address_blocks, reset_requests
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.push import SNOOZE, on_read_or_hidden, snooze
from serversherpa.notifications.requests import resolve_copies
from serversherpa.security.passwords import hash_password
from serversherpa.services.router_agent import resolve_router_copies
from tests.push_helpers import KIND, NOW, _admin, _company, _phone
from tests.test_sites_api import login

PW = "CorrectHorse9!"


async def _login(client, db, person):
    """Sign `person` in (they already have an account row from _admin)."""
    from serversherpa.config import get_settings

    acct = await db.scalar(select(UserAccount).where(UserAccount.person_id == person.id))
    acct.email = f"login-{person.id}@test.example.com"
    acct.password_hash = hash_password(
        PW, pepper=get_settings().password_pepper.get_secret_value())
    acct.password_updated_at = datetime.now(UTC)
    await db.commit()
    return await login(client, email=acct.email, pw=PW)


async def _pushed(db, clock, *, phone=True, company=True):
    """An admin with a phone and one notification queued for push."""
    clock(NOW)
    if company:
        await _company(db)
    person = await _admin(db)
    if phone:
        await _phone(db, person)
    n = await notify(db, person.id, KIND, "Hello", body="World")
    await db.commit()
    return person, n


async def _rows(db, message_type=None):
    await db.flush()
    q = (select(PushOutbox).order_by(PushOutbox.created_at)
         .execution_options(populate_existing=True))
    if message_type:
        q = q.where(PushOutbox.message_type == message_type)
    return list(await db.scalars(q))


async def _queued(db, message_type):
    return [r for r in await _rows(db, message_type) if r.state == "queued"]


async def test_snooze_requeues_five_minutes(db, fcm_on, clock):
    _, n = await _pushed(db, clock)
    until = await snooze(db, n, now=NOW)
    assert until == NOW + timedelta(minutes=5) == NOW + SNOOZE
    assert n.push_snoozed_until == until
    (row,) = await _queued(db, "notification")
    assert row.reason == "snooze" and row.send_at == until
    log = list(await db.scalars(select(NotificationLog).where(
        NotificationLog.event == "push_snoozed")))
    assert len(log) == 1 and log[0].channel == "push"
    assert log[0].detail["push_outbox_id"] == str(row.id) and log[0].outbox_id is None


async def test_snooze_after_the_push_was_sent_queues_a_row(db, fcm_on, clock):
    _, n = await _pushed(db, clock)
    (first,) = await _queued(db, "notification")
    first.state = "sent"
    await db.flush()
    await snooze(db, n, now=NOW)
    assert len(await _rows(db, "notification")) == 2
    (row,) = await _queued(db, "notification")
    assert row.reason == "snooze"


async def test_resnooze_restarts(db, fcm_on, clock):
    _, n = await _pushed(db, clock)
    await snooze(db, n, now=NOW)
    later = NOW + timedelta(minutes=3)
    until = await snooze(db, n, now=later)
    (row,) = await _queued(db, "notification")
    assert len(await _rows(db, "notification")) == 1
    assert row.send_at == later + SNOOZE == until
    assert n.push_snoozed_until == until


@pytest.mark.parametrize("how", ["read", "hidden"])
async def test_snooze_read_rejected(db, fcm_on, clock, how):
    _, n = await _pushed(db, clock)
    if how == "read":
        n.read_at = NOW
    else:
        n.dismissed_at = NOW
    with pytest.raises(ValueError, match="not_live"):
        await snooze(db, n, now=NOW)
    assert n.push_snoozed_until is None


async def test_read_cancels_snooze_and_queues_clear(client, db, fcm_on, clock):
    person, n = await _pushed(db, clock)
    await snooze(db, n, now=NOW)
    await db.commit()
    hdrs = await _login(client, db, person)

    assert (await client.post(f"/notifications/inbox/{n.id}/read", headers=hdrs)
            ).status_code == 204

    (notification_row,) = await _rows(db, "notification")
    assert notification_row.state == "dropped" and notification_row.last_error == "read"
    assert notification_row.handled_at is not None
    (clear,) = await _queued(db, "clear")
    assert clear.notification_id == n.id and clear.reason == "clear"
    await db.refresh(n)
    assert n.push_snoozed_until is None
    dropped = list(await db.scalars(select(NotificationLog).where(
        NotificationLog.event == "push_dropped")))
    assert [d.reason for d in dropped] == ["read"]


async def test_unread_queues_nothing(client, db, fcm_on, clock):
    person, n = await _pushed(db, clock)
    hdrs = await _login(client, db, person)
    await client.post(f"/notifications/inbox/{n.id}/read", headers=hdrs)
    before = len(await _rows(db))
    assert (await client.post(f"/notifications/inbox/{n.id}/unread", headers=hdrs)
            ).status_code == 204
    assert len(await _rows(db)) == before


async def test_hide_cancels_and_clears(client, db, fcm_on, clock):
    person, n = await _pushed(db, clock)
    hdrs = await _login(client, db, person)

    assert (await client.delete(f"/notifications/inbox/{n.id}", headers=hdrs)
            ).status_code == 204

    (notification_row,) = await _rows(db, "notification")
    assert notification_row.state == "dropped" and notification_row.last_error == "read"
    (clear,) = await _queued(db, "clear")
    assert clear.notification_id == n.id


async def test_read_all_clears_each(client, db, fcm_on, clock):
    person, first = await _pushed(db, clock)
    second = await notify(db, person.id, KIND, "Second")
    await db.commit()
    hdrs = await _login(client, db, person)

    assert (await client.post("/notifications/inbox/read-all", headers=hdrs)
            ).status_code == 204

    assert {r.state for r in await _rows(db, "notification")} == {"dropped"}
    assert {r.notification_id for r in await _queued(db, "clear")} == {first.id, second.id}


async def test_clear_read_clears_each(client, db, fcm_on, clock):
    person, n = await _pushed(db, clock)
    n.read_at = NOW
    await db.commit()
    hdrs = await _login(client, db, person)

    assert (await client.post("/notifications/inbox/clear-read", headers=hdrs)
            ).status_code == 204

    assert [r.notification_id for r in await _queued(db, "clear")] == [n.id]


async def test_one_queued_clear_per_notification(db, fcm_on, clock):
    person, n = await _pushed(db, clock)
    await on_read_or_hidden(db, [n.id], person.id)
    await on_read_or_hidden(db, [n.id, n.id], person.id)
    assert len(await _queued(db, "clear")) == 1


async def test_no_clear_without_a_phone_or_push_setup(db, fcm_on, clock, monkeypatch):
    person, n = await _pushed(db, clock, phone=False)
    await on_read_or_hidden(db, [n.id], person.id)
    assert await _rows(db) == []
    # a queued row is still cancelled when push is no longer set up
    person2, n2 = await _pushed(db, clock, company=False)
    monkeypatch.setenv("SS_FCM_SERVICE_ACCOUNT_FILE", "")
    from serversherpa.config import get_settings
    get_settings.cache_clear()
    await on_read_or_hidden(db, [n2.id], person2.id)
    rows = await _rows(db)
    assert [(r.message_type, r.state) for r in rows] == [("notification", "dropped")]


async def _card(db, person, kind, payload, *, read=False):
    row = Notification(person_id=person.id, kind=kind, title="Card", payload=payload,
                       created_at=datetime.now(UTC), read_at=NOW if read else None)
    db.add(row)
    await db.flush()
    return row


async def _resolve_requests(db, person):
    request_id = "00000000-0000-0000-0000-0000000000a1"
    card = await _card(db, person, "membership_request",
                       {"request_id": request_id, "state": "pending"})
    await resolve_copies(db, uuid.UUID(request_id), "approved", "Boss")
    return card


async def _resolve_reset(db, person):
    target = await _admin(db)
    card = await _card(db, person, reset_requests.KIND,
                       {"target_person_id": str(target.id), "state": "open", "count": 1})
    await reset_requests.resolve(db, target.id, "Boss")
    return card


async def _resolve_block(db, person):
    blocked_at = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
    card = await _card(db, person, address_blocks.KIND, {
        "address": "203.0.113.9", "blocked_at": address_blocks.block_key(blocked_at),
        "state": "open"})
    await address_blocks.resolve_block(db, "203.0.113.9", blocked_at, "cleared", "Boss")
    return card


async def _resolve_router(db, person):
    device_id = "00000000-0000-0000-0000-0000000000b2"
    card = await _card(db, person, "router_approval",
                       {"device_id": device_id, "state": "pending"})
    await resolve_router_copies(db, uuid.UUID(device_id), "approved", "Boss")
    return card


RESOLVERS = [_resolve_requests, _resolve_reset, _resolve_block, _resolve_router]


@pytest.mark.parametrize("resolver", RESOLVERS, ids=lambda f: f.__name__[len("_resolve_"):])
async def test_raw_resolve_paths_queue_clear(db, fcm_on, clock, resolver):
    clock(NOW)
    person = await _admin(db)
    await _phone(db, person)
    card = await resolver(db, person)
    (clear,) = await _queued(db, "clear")
    assert clear.notification_id == card.id and clear.person_id == person.id


async def test_a_copy_already_read_queues_no_clear(db, fcm_on, clock):
    clock(NOW)
    person = await _admin(db)
    await _phone(db, person)
    request_id = "00000000-0000-0000-0000-0000000000a1"
    await _card(db, person, "membership_request",
                {"request_id": request_id, "state": "pending"}, read=True)
    await resolve_copies(db, uuid.UUID(request_id), "approved", "Boss")
    assert await _rows(db) == []


async def test_a_pending_state_queues_no_clear(db, fcm_on, clock):
    clock(NOW)
    person = await _admin(db)
    await _phone(db, person)
    device_id = "00000000-0000-0000-0000-0000000000b2"
    await _card(db, person, "router_approval", {"device_id": device_id, "state": "approved"})
    await resolve_router_copies(db, uuid.UUID(device_id), "pending", None)
    assert await _rows(db) == []


async def test_bumped_reset_request_pushes_again(db, fcm_on, clock):
    clock(NOW)
    await _company(db, defaults={"approvals": {"inbox": True, "email": True, "push": True}})
    approver = await _admin(db)
    await _phone(db, approver)
    target = await _admin(db, role="staff")
    card = await _card(db, approver, reset_requests.KIND,
                       {"target_person_id": str(target.id), "state": "open", "count": 1},
                       read=True)
    await db.commit()

    assert await reset_requests.open_or_bump(db, target) == 1

    (row,) = await _queued(db, "notification")
    assert row.notification_id == card.id and row.reason == "new" and row.send_at == NOW
    assert card.read_at is None
    # a second bump moves the one queued row instead of adding another
    await reset_requests.open_or_bump(db, target)
    assert len(await _queued(db, "notification")) == 1
