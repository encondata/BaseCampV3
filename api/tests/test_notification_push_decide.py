"""decide_push(): whether a notification also goes to the person's phone, and
the push_outbox rows notify() queues. Reasons are checked in a fixed order and
the first failure wins. Nothing is ever sent.

Spec: docs/superpowers/specs/2026-11-17-android-push-notifications-design.md"""

from datetime import timedelta

import pytest
from sqlalchemy import func, select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    NotificationLog,
    PushOutbox,
    SystemConfig,
)
from serversherpa.notifications import push as push_mod
from serversherpa.notifications.check import check_delivery
from serversherpa.notifications.company import load_company_settings
from serversherpa.notifications.delivery_log import LOG_CHANNELS, record
from serversherpa.notifications.email import load_contact
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.kinds import kind_info
from serversherpa.notifications.push import decide_push, push_enabled
from tests.push_helpers import (
    KIND,
    NOW,
    PUSH_ON,
    QUIET,
    _admin,
    _company,
    _phone,
)


async def _decide(db, person, kind=KIND, *, now=NOW):
    contact = await load_contact(db, person.id)
    company = await load_company_settings(db)
    return await decide_push(db, person.id, kind_info(kind), contact=contact,
                             company=company, now=now)


def _quiet_prefs():
    return {"notif": {"schedule": {"timezone": "America/Chicago",
                                   "quiet_start": "21:00", "quiet_end": "06:00"}}}


async def _outbox(db):
    return list(await db.scalars(select(PushOutbox).order_by(PushOutbox.created_at)))


async def _log(db, event):
    return list(await db.scalars(select(NotificationLog)
                                 .where(NotificationLog.event == event)))


# Each case breaks exactly one rule on an otherwise valid setup, in the
# documented order: the first failing rule names the reason.
CASES = [
    ("push_not_set_up", {"fcm": False}),
    ("unregistered_kind", {"kind": "no_such_kind"}),
    ("security_category", {"kind": "totp_enrolled"}),
    ("category_off", {"prefs": {"notif": {"switches": {"assets": {"inbox": False}}}}}),
    ("category_no_push", {"defaults": {"assets": {"inbox": True, "email": True,
                                                  "push": False}}}),
    ("recipient_inactive", {"archived": True}),
    ("not_admin", {"role": "staff"}),
    ("no_phone", {"phone": False}),
    ("quiet_hours", {"prefs": _quiet_prefs(), "now": QUIET}),
]


@pytest.mark.parametrize("reason,change", CASES, ids=[c[0] for c in CASES])
async def test_reasons_in_order(db, monkeypatch, reason, change):
    if change.get("fcm", True):
        monkeypatch.setenv("SS_FCM_SERVICE_ACCOUNT_FILE", "/nonexistent/fcm.json")
    else:
        monkeypatch.setenv("SS_FCM_SERVICE_ACCOUNT_FILE", "")
    get_settings.cache_clear()
    try:
        await _company(db, defaults=change.get("defaults", PUSH_ON))
        p = await _admin(db, role=change.get("role", "admin"), prefs=change.get("prefs"),
                         archived=change.get("archived", False))
        if change.get("phone", True):
            await _phone(db, p)
        decision = await _decide(db, p, change.get("kind", KIND),
                                 now=change.get("now", NOW))
        assert (decision.queue, decision.reason) == (False, reason)
    finally:
        get_settings.cache_clear()


async def test_everything_in_place_queues(db, fcm_on):
    await _company(db)
    p = await _admin(db)
    await _phone(db, p)
    d = await _decide(db, p)
    assert (d.queue, d.reason, d.phones, d.critical) == (True, None, 1, False)


async def test_not_set_up_queues_nothing(db, monkeypatch):
    monkeypatch.setenv("SS_FCM_SERVICE_ACCOUNT_FILE", "")
    get_settings.cache_clear()
    assert push_enabled() is False
    await _company(db)
    p = await _admin(db)
    await _phone(db, p)
    row = await notify(db, p.id, KIND, "Hello")
    assert row is not None
    assert await _outbox(db) == []
    [entry] = await _log(db, "push_not_queued")
    assert entry.channel == "push" and entry.reason == "push_not_set_up"
    assert entry.notification_id == row.id
    get_settings.cache_clear()


async def test_queues_and_logs_on_notify(db, fcm_on, clock):
    clock(NOW)
    await _company(db)
    p = await _admin(db)
    await _phone(db, p)
    row = await notify(db, p.id, KIND, "Hello")
    [out] = await _outbox(db)
    assert (out.notification_id, out.person_id, out.reason, out.state,
            out.message_type, out.send_at) == (row.id, p.id, "new", "queued",
                                               "notification", NOW)
    [entry] = await _log(db, "push_queued")
    assert entry.channel == "push" and entry.outbox_id is None
    assert entry.detail == {"phones": 1, "push_outbox_id": str(out.id)}


async def test_quiet_hours_only_critical(db, fcm_on, clock):
    clock(QUIET)
    await _company(db)
    p = await _admin(db, prefs=_quiet_prefs())
    await _phone(db, p)
    d = await _decide(db, p, now=QUIET)
    assert (d.queue, d.reason) == (False, "quiet_hours")
    await notify(db, p.id, KIND, "Hello")
    assert await _outbox(db) == []
    await db.execute(SystemConfig.__table__.delete())
    await _company(db, critical_kinds=[KIND])
    d = await _decide(db, p, now=QUIET)
    assert (d.queue, d.critical) == (True, True)
    await notify(db, p.id, KIND, "Again")
    assert len(await _outbox(db)) == 1


@pytest.mark.parametrize("change", [{"sub_type": "zebra"}, {"station_type": "label"}],
                         ids=["zebra", "station"])
async def test_zebra_and_station_not_a_phone(db, fcm_on, change):
    await _company(db)
    p = await _admin(db)
    await _phone(db, p, **change)
    d = await _decide(db, p)
    assert (d.queue, d.reason, d.phones) == (False, "no_phone", 0)


async def test_registration_expired_not_a_phone(db, fcm_on):
    await _company(db)
    p = await _admin(db)
    await _phone(db, p, expires=NOW - timedelta(minutes=1))
    d = await _decide(db, p)
    assert (d.queue, d.reason) == (False, "no_phone")


async def test_stale_owner_not_a_phone(db, fcm_on):
    await _company(db)
    p = await _admin(db)
    other = await _admin(db)
    await _phone(db, p, owner=other)      # registration says `other`, device says `p`
    d = await _decide(db, p)
    assert (d.queue, d.reason) == (False, "no_phone")
    d = await _decide(db, other)
    assert (d.queue, d.reason) == (False, "no_phone")


async def test_never_emailed_kind_can_push(db, fcm_on):
    await _company(db, defaults={"approvals": {"inbox": True, "email": False, "push": True}})
    p = await _admin(db)
    await _phone(db, p)
    assert kind_info("password_reset_request").email is False
    row = await notify(db, p.id, "password_reset_request", "Reset asked")
    [out] = await _outbox(db)
    assert out.notification_id == row.id


async def test_burst_two_notifications_two_rows(db, fcm_on):
    await _company(db)
    p = await _admin(db)
    await _phone(db, p)
    a = await notify(db, p.id, KIND, "One")
    b = await notify(db, p.id, KIND, "Two")
    rows = await _outbox(db)
    assert sorted(r.notification_id for r in rows) == sorted([a.id, b.id])


async def test_queue_push_upserts_the_queued_row(db, fcm_on):
    await _company(db)
    p = await _admin(db)
    await _phone(db, p)
    row = await notify(db, p.id, KIND, "One")
    later = NOW + timedelta(minutes=5)
    out = await push_mod.queue_push(db, row, reason="snooze", send_at=later)
    await db.flush()
    rows = await _outbox(db)
    assert len(rows) == 1 and rows[0].id == out.id
    assert (rows[0].reason, rows[0].send_at) == ("snooze", later)


async def test_check_delivery_push_line(db, fcm_on):
    await _company(db, defaults={"assets": {"inbox": True, "email": True, "push": False}})
    p = await _admin(db)
    await _phone(db, p)
    out = await check_delivery(db, p.id, KIND, now=NOW)
    assert out["push_enabled"] is True
    assert out["push"] == {"outcome": "not_sent", "reason": "category_no_push", "phones": 1}
    await db.execute(SystemConfig.__table__.delete())
    await _company(db)
    out = await check_delivery(db, p.id, KIND, now=NOW)
    assert out["push"] == {"outcome": "now", "reason": None, "phones": 1}


async def test_delivery_log_push_channel(db):
    assert "push" in LOG_CHANNELS
    for event in ("push_queued", "push_not_queued", "push_sent", "push_dropped",
                  "push_failed", "push_retry", "push_token_removed", "push_snoozed",
                  "push_cleared"):
        record(db, event, channel="push")
    await db.flush()
    assert await db.scalar(select(func.count()).select_from(NotificationLog)) == 9
