"""drain_push(): the notification worker sends the queued push rows. A fake
client records every send and returns scripted results; nothing touches FCM.

Spec: docs/superpowers/specs/2026-11-17-android-push-notifications-design.md"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from serversherpa.db.models import (
    NotificationLog,
    PushOutbox,
    PushRegistration,
)
from serversherpa.notifications import worker as worker_mod
from serversherpa.notifications.inbox import notify
from serversherpa.push.delivery import drain_push
from serversherpa.push.fcm import FcmClient, SendResult
from tests.test_notification_push_decide import (  # noqa: F401 - fixtures
    KIND,
    NOW,
    _admin,
    _company,
    _phone,
    clock,
    fcm_on,
)


class FakeClient:
    def __init__(self, *results):
        self.results = list(results)
        self.calls = []

    async def send(self, token, data, *, high_priority):
        self.calls.append((token, dict(data), high_priority))
        if self.results:
            result = self.results.pop(0) if len(self.results) > 1 else self.results[0]
        else:
            result = SendResult("sent")
        if isinstance(result, Exception):
            raise result
        return result


async def _queued(db, clock, *, phones=1, title="Hello", body="World"):
    clock(NOW)
    await _company(db)
    person = await _admin(db)
    devices = [await _phone(db, person) for _ in range(phones)]
    n = await notify(db, person.id, KIND, title, body=body)
    rows = list((await db.scalars(select(PushOutbox))).all())
    assert len(rows) == 1
    return person, devices, n, rows[0]


async def _events(db):
    return [(r.event, r.reason, r.detail) for r in await db.scalars(
        select(NotificationLog).where(NotificationLog.channel == "push")
        .order_by(NotificationLog.at))]


async def test_sends_and_marks_sent(db, fcm_on, clock):
    person, _, n, row = await _queued(db, clock, title="T" * 200, body="B" * 900)
    client = FakeClient()
    assert await drain_push(db, client, now=NOW) == 1
    (token, data, high), = client.calls
    assert high is True
    assert token.startswith("tok-")
    assert data == {
        "type": "notification", "notification_id": str(n.id),
        "person_id": str(person.id), "kind": KIND, "title": "T" * 120,
        "body": "B" * 400, "critical": "false", "created_at": n.created_at.isoformat()}
    await db.refresh(row)
    assert row.state == "sent" and row.handled_at is not None
    reg = await db.scalar(select(PushRegistration))
    assert reg.last_sent_at == NOW
    events = await _events(db)
    assert events[-1][0] == "push_sent"
    assert events[-1][2]["push_outbox_id"] == str(row.id)


async def test_snooze_sent_clears_snoozed_until(db, fcm_on, clock):
    _, _, n, row = await _queued(db, clock)
    n.push_snoozed_until = NOW
    row.reason = "snooze"
    await db.flush()
    await drain_push(db, FakeClient(), now=NOW)
    await db.refresh(n)
    assert n.push_snoozed_until is None


async def test_not_due_is_left_alone(db, fcm_on, clock):
    _, _, _, row = await _queued(db, clock)
    row.send_at = NOW + timedelta(minutes=5)
    await db.flush()
    client = FakeClient()
    assert await drain_push(db, client, now=NOW) == 0
    assert client.calls == []
    await db.refresh(row)
    assert row.state == "queued"


async def test_owner_changed_after_queue_drops(db, fcm_on, clock):
    person, devices, _, row = await _queued(db, clock)
    other = await _admin(db)
    devices[0].personal_person_id = other.id
    await db.flush()
    client = FakeClient()
    await drain_push(db, client, now=NOW)
    assert client.calls == []
    await db.refresh(row)
    assert row.state == "dropped"
    assert (await _events(db))[-1][:2] == ("push_dropped", "no_phone")


async def test_read_before_send_drops(db, fcm_on, clock):
    _, _, n, row = await _queued(db, clock)
    n.read_at = NOW
    await db.flush()
    client = FakeClient()
    await drain_push(db, client, now=NOW)
    assert client.calls == []
    await db.refresh(row)
    assert row.state == "dropped"
    assert (await _events(db))[-1][:2] == ("push_dropped", "read")


async def test_hidden_before_send_drops(db, fcm_on, clock):
    _, _, n, row = await _queued(db, clock)
    n.dismissed_at = NOW
    await db.flush()
    await drain_push(db, FakeClient(), now=NOW)
    await db.refresh(row)
    assert row.state == "dropped"
    assert (await _events(db))[-1][:2] == ("push_dropped", "hidden")


async def test_quiet_hours_at_send_time_drops(db, fcm_on, clock):
    _, _, _, row = await _queued(db, clock)
    quiet = datetime(2026, 10, 7, 8, 0, tzinfo=UTC)   # 03:00 in Chicago
    from tests.test_notification_push_decide import _quiet_prefs
    from serversherpa.db.models import UserAccount
    acct = await db.scalar(select(UserAccount).where(UserAccount.person_id == row.person_id))
    acct.ui_prefs = _quiet_prefs()
    await db.flush()
    row.send_at = quiet
    await db.flush()
    client = FakeClient()
    await drain_push(db, client, now=quiet)
    assert client.calls == []
    await db.refresh(row)
    assert row.state == "dropped"
    assert (await _events(db))[-1][:2] == ("push_dropped", "quiet_hours")


async def test_token_dead_deletes_registration(db, fcm_on, clock):
    _, _, _, row = await _queued(db, clock)
    client = FakeClient(SendResult("token_dead", "UNREGISTERED"))
    await drain_push(db, client, now=NOW)
    assert await db.scalar(select(PushRegistration)) is None
    await db.refresh(row)
    assert row.state == "dropped"
    events = [e[0] for e in await _events(db)]
    assert "push_token_removed" in events


async def test_retry_backoff_then_failed(db, fcm_on, clock):
    _, _, _, row = await _queued(db, clock)
    client = FakeClient(SendResult("retry", "HTTP 503"))
    now = NOW
    for attempt in range(1, 5):
        assert await drain_push(db, client, now=now) == 1
        await db.refresh(row)
        assert row.state == "queued" and row.attempts == attempt
        assert row.send_at == now + timedelta(seconds=30 * 2 ** attempt)
        # not due again before the backoff ends
        assert await drain_push(db, client, now=now + timedelta(seconds=1)) == 0
        now = row.send_at
    assert await drain_push(db, client, now=now) == 1
    await db.refresh(row)
    assert row.state == "failed" and row.attempts == 5
    events = [e[0] for e in await _events(db)]
    assert events.count("push_retry") == 4 and events[-1] == "push_failed"


async def test_fatal_marks_failed(db, fcm_on, clock):
    _, _, _, row = await _queued(db, clock)
    await drain_push(db, FakeClient(SendResult("fatal", "HTTP 403")), now=NOW)
    await db.refresh(row)
    assert row.state == "failed"
    assert (await _events(db))[-1][0] == "push_failed"


async def test_unexpected_exception_is_a_retry(db, fcm_on, clock):
    _, _, _, row = await _queued(db, clock)
    secret = "tok-super-secret"
    await drain_push(db, FakeClient(RuntimeError(secret)), now=NOW)
    await db.refresh(row)
    assert row.state == "queued" and row.attempts == 1
    assert secret not in (row.last_error or "")
    assert "RuntimeError" in row.last_error


async def test_two_phones_both_sent(db, fcm_on, clock):
    _, _, _, row = await _queued(db, clock, phones=2)
    client = FakeClient()
    await drain_push(db, client, now=NOW)
    assert len(client.calls) == 2
    assert len({c[0] for c in client.calls}) == 2
    await db.refresh(row)
    assert row.state == "sent"
    regs = (await db.scalars(select(PushRegistration))).all()
    assert all(r.last_sent_at == NOW for r in regs)


async def test_one_phone_sent_one_dead(db, fcm_on, clock):
    _, _, _, row = await _queued(db, clock, phones=2)
    client = FakeClient(SendResult("sent"), SendResult("token_dead", "UNREGISTERED"))
    await drain_push(db, client, now=NOW)
    await db.refresh(row)
    assert row.state == "sent"
    assert len((await db.scalars(select(PushRegistration))).all()) == 1


async def test_clear_message_normal_priority(db, fcm_on, clock):
    person, _, n, row = await _queued(db, clock)
    row.state = "sent"
    await db.flush()
    n.read_at = NOW   # a clear row is not re-checked
    clear = PushOutbox(notification_id=n.id, person_id=person.id, send_at=NOW,
                       reason="clear", state="queued", message_type="clear",
                       created_at=NOW)
    db.add(clear)
    await db.flush()
    client = FakeClient()
    await drain_push(db, client, now=NOW)
    (_, data, high), = client.calls
    assert data == {"type": "clear", "notification_id": str(n.id)}
    assert high is False
    await db.refresh(clear)
    assert clear.state == "sent"
    assert (await _events(db))[-1][0] == "push_cleared"


async def test_worker_idle_when_not_set_up(db, monkeypatch):
    monkeypatch.setattr(FcmClient, "from_settings", classmethod(lambda cls: None))
    called = []

    async def spy(*a, **k):
        called.append(1)
        return 0

    monkeypatch.setattr(worker_mod, "drain_push", spy)
    state = {"failed": False}
    assert await worker_mod.run_push(lambda: None, state) == 0
    assert called == []
    assert state == {"failed": False}


async def test_worker_logs_failure_once(monkeypatch, caplog):
    def boom(cls):
        raise RuntimeError("unreadable")

    monkeypatch.setattr(FcmClient, "from_settings", classmethod(boom))
    state = {"failed": False}
    with caplog.at_level("WARNING", logger="serversherpa.notifications.worker"):
        await worker_mod.run_push(lambda: None, state)
        await worker_mod.run_push(lambda: None, state)
    assert state["failed"] is True
    assert len([r for r in caplog.records if "push outbox" in r.getMessage()]) == 1


async def test_bad_row_is_retried_and_does_not_sink_the_batch(db, fcm_on, clock,
                                                              monkeypatch):
    from serversherpa.push import delivery as delivery_mod

    _, _, _, good = await _queued(db, clock)
    bad_person = await _admin(db)
    await _phone(db, bad_person)
    await notify(db, bad_person.id, KIND, "Bad")
    bad = await db.scalar(select(PushOutbox).where(PushOutbox.person_id == bad_person.id))
    real = delivery_mod.load_contact

    async def flaky(session, person_id):
        if person_id == bad_person.id:
            raise RuntimeError("tok-secret-text")
        return await real(session, person_id)

    monkeypatch.setattr(delivery_mod, "load_contact", flaky)
    client = FakeClient()
    assert await drain_push(db, client, now=NOW) == 2
    assert len(client.calls) == 1
    await db.refresh(good)
    await db.refresh(bad)
    assert good.state == "sent"
    assert bad.state == "queued" and bad.attempts == 1
    assert bad.send_at == NOW + timedelta(seconds=60)
    assert "RuntimeError" in bad.last_error and "secret" not in bad.last_error
    # not due again until the backoff ends
    assert await drain_push(db, client, now=NOW + timedelta(seconds=1)) == 0


async def test_dropped_snooze_clears_snoozed_until(db, fcm_on, clock):
    _, _, n, row = await _queued(db, clock)
    n.push_snoozed_until = NOW
    n.read_at = NOW
    row.reason = "snooze"
    await db.flush()
    await drain_push(db, FakeClient(), now=NOW)
    await db.refresh(n)
    await db.refresh(row)
    assert row.state == "dropped" and n.push_snoozed_until is None


async def test_worker_reuses_one_client(fcm_on, monkeypatch):
    built = []
    client = FakeClient()

    def build(cls):
        built.append(1)
        return client

    seen = []

    async def spy(db, c, **kw):
        seen.append(c)
        return 0

    class Maker:
        def __call__(self):
            return self

        async def __aenter__(self):
            return object()

        async def __aexit__(self, *a):
            return False

    monkeypatch.setattr(FcmClient, "from_settings", classmethod(build))
    monkeypatch.setattr(worker_mod, "drain_push", spy)
    state = {"failed": False}
    await worker_mod.run_push(Maker(), state)
    await worker_mod.run_push(Maker(), state)
    assert built == [1]
    assert seen == [client, client]
