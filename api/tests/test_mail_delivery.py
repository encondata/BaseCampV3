"""mail/delivery.py + transport.py: claim, send, retry with backoff, give
up, skip when SMTP is off, stale-row sweep. Never touches a real server —
`send` is a fake."""

import asyncio
from datetime import UTC, datetime, timedelta

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import EmailOutbox
from serversherpa.mail import enqueue
from serversherpa.mail.delivery import (
    BACKOFF_MINUTES, MAX_ATTEMPTS, deliver_once, requeue_stale,
)
from serversherpa.mail.transport import build_message


class FakeSend:
    def __init__(self, fail_with: Exception | None = None):
        self.calls: list[dict] = []
        self.fail_with = fail_with

    async def __call__(self, **kw):
        self.calls.append(kw)
        if self.fail_with:
            raise self.fail_with


async def _queue(db, **over):
    row = await enqueue(db, "password_changed", "alice@test.example.com",
                        name="Alice", login_url="https://p/login")
    for k, v in over.items():
        setattr(row, k, v)
    await db.commit()
    return row.id


async def _get(row_id):
    async with get_sessionmaker()() as s:
        return await s.get(EmailOutbox, row_id)


def test_build_message_is_multipart_alternative():
    msg = build_message(sender="noreply@x.test", to="a@x.test", subject="Hi",
                        html="<p>Hello</p>", text="Hello\n")
    assert msg["From"] == "noreply@x.test" and msg["To"] == "a@x.test"
    assert msg["Subject"] == "Hi" and msg["Message-ID"]
    assert msg.get_content_type() == "multipart/alternative"
    parts = [p.get_content_type() for p in msg.iter_parts()]
    assert parts == ["text/plain", "text/html"]


def test_message_id_domain_with_display_name_sender():
    msg = build_message(sender="ServerSherpa <noreply@x.test>", to="a@x.test",
                        subject="Hi", html="<p>Hello</p>", text="Hello\n")
    assert msg["Message-ID"].endswith("@x.test>") and ">>" not in msg["Message-ID"]


async def test_sends_and_marks_sent(db, email_on):
    row_id = await _queue(db)
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls[0]["to"] == "alice@test.example.com"
    assert send.calls[0]["subject"] == "Your ServerSherpa password was changed"
    row = await _get(row_id)
    assert row.status == "sent" and row.sent_at is not None and row.attempts == 1
    # nothing left to do
    assert await deliver_once(get_sessionmaker(), send=send) == 0


async def test_skips_when_smtp_not_configured(db):
    row_id = await _queue(db)
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    assert (await _get(row_id)).status == "skipped"


async def test_failure_requeues_with_backoff(db, email_on):
    row_id = await _queue(db)
    before = datetime.now(UTC)
    await deliver_once(get_sessionmaker(), send=FakeSend(OSError("connection refused")))
    row = await _get(row_id)
    assert row.status == "queued" and row.attempts == 1
    assert "connection refused" in row.last_error
    assert row.next_attempt_at >= before + timedelta(minutes=BACKOFF_MINUTES[0]) - timedelta(seconds=5)
    # not due yet → not claimed again
    assert await deliver_once(get_sessionmaker(), send=FakeSend()) == 0


async def test_gives_up_after_max_attempts(db, email_on):
    row_id = await _queue(db, attempts=MAX_ATTEMPTS - 1)
    await deliver_once(get_sessionmaker(), send=FakeSend(OSError("nope")))
    row = await _get(row_id)
    assert row.status == "failed" and row.attempts == MAX_ATTEMPTS


async def test_future_rows_wait(db, email_on):
    await _queue(db, next_attempt_at=datetime.now(UTC) + timedelta(minutes=10))
    assert await deliver_once(get_sessionmaker(), send=FakeSend()) == 0


async def test_requeue_stale_sending_rows(db):
    old = datetime.now(UTC) - timedelta(minutes=30)
    stale_id = await _queue(db, status="sending", heartbeat_at=old)
    fresh_id = await _queue(db, status="sending", heartbeat_at=datetime.now(UTC))
    async with get_sessionmaker()() as s:
        assert await requeue_stale(s) == 1
    assert (await _get(stale_id)).status == "queued"
    assert (await _get(fresh_id)).status == "sending"


async def test_never_logs_the_address(db, email_on, caplog):
    import logging
    import smtplib
    caplog.set_level(logging.DEBUG, logger="serversherpa.mail")
    exc = smtplib.SMTPRecipientsRefused(
        {"alice@test.example.com": (550, b"no such user")})
    retry_id = await _queue(db)
    giveup_id = await _queue(db, attempts=MAX_ATTEMPTS - 1)
    await deliver_once(get_sessionmaker(), send=FakeSend(exc))
    assert "alice@test.example.com" not in caplog.text
    for rid in (retry_id, giveup_id):
        row = await _get(rid)
        assert "SMTPRecipientsRefused" in row.last_error
    assert (await _get(retry_id)).status == "queued"
    assert (await _get(giveup_id)).status == "failed"


async def test_one_bad_row_does_not_abort_batch(db, email_on, monkeypatch, caplog):
    import serversherpa.mail.delivery as delivery
    first = await _queue(db)
    second = await _queue(db, next_attempt_at=datetime.now(UTC) + timedelta(seconds=1))
    real = delivery._deliver
    order: list = []

    async def flaky(row, send):
        order.append(row.id)
        if len(order) == 1:
            raise RuntimeError("bad row for alice@test.example.com")
        await real(row, send)

    monkeypatch.setattr(delivery, "_deliver", flaky)
    await asyncio.sleep(1.1)
    assert await deliver_once(get_sessionmaker(), send=FakeSend()) == 2
    assert (await _get(order[1])).status == "sent"
    assert {first, second} == set(order)
    assert "alice@test.example.com" not in caplog.text
