"""mail/delivery.py + transport.py: claim, send, retry with backoff, give
up, skip when SMTP is off, stale-row sweep, the send-time re-check of
notification mail, and the delivery-log row each outcome writes. Never
touches a real server — `send` is a fake."""

import asyncio
import json
import logging
import smtplib
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select, update

from serversherpa.config import get_settings
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    EmailOutbox,
    Notification,
    NotificationGroup,
    NotificationGroupMember,
    NotificationLog,
    Person,
    UserAccount,
)
from serversherpa.mail import enqueue
from serversherpa.mail.delivery import (
    BACKOFF_MINUTES, MAX_ATTEMPTS, deliver_once, requeue_stale,
)
from serversherpa.mail.transport import build_message
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.kinds import kind_info
from tests.test_notification_email import _group, _person, _prefs

ADDRESS = "pat@test.example.com"


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


async def _run(stmt):
    """One statement in its own session: a change made after the email was
    queued (the person read the item, left the group, ...)."""
    async with get_sessionmaker()() as s:
        await s.execute(stmt)
        await s.commit()


async def _logs(outbox_id, *events):
    """The delivery-log rows of one outbox row (only `events`, when given)."""
    q = (select(NotificationLog).where(NotificationLog.outbox_id == outbox_id)
         .order_by(NotificationLog.id))
    if events:
        q = q.where(NotificationLog.event.in_(events))
    async with get_sessionmaker()() as s:
        return list((await s.scalars(q)).all())


async def _notification_mail(db, kind="report_ready", *, person=None,
                             title="Move Report is ready", owner_notice=False,
                             payload=None, **person_kw):
    """Real notification mail: notify() writes the inbox row and queues the
    email for a person whose group subscribes to the kind's category (an owner
    notice needs no group). Returns the person, the inbox row, the outbox row.
    Pass `person` to reuse one whose group already exists."""
    if person is None:
        person = await _person(db, **person_kw)
        await _group(db, person, categories=(kind_info(kind).category,))
    note = await notify(db, person.id, kind, title, body="NAP11 finished",
                        payload=payload, owner_notice=owner_notice)
    await db.commit()
    mail = await db.scalar(select(EmailOutbox).where(EmailOutbox.notification_id == note.id))
    assert mail is not None and mail.status == "queued"
    return person, note, mail


async def _deferred_notification_mail(db):
    """Notification mail held for quiet hours: the group is quiet from an hour
    ago until three hours from now (UTC, defer), so the email waits."""
    now = datetime.now(UTC)
    person = await _person(db)
    await _group(db, person, timezone="UTC", dnd_behavior="defer",
                 quiet_start=(now - timedelta(hours=1)).time(),
                 quiet_end=(now + timedelta(hours=3)).time())
    person, note, mail = await _notification_mail(db, person=person)
    assert mail.next_attempt_at > now + timedelta(hours=2)
    return person, note, mail


async def _assert_dropped(row_id, reason):
    """The row was skipped for `reason` without a send attempt, and the
    delivery log holds exactly one email_skipped row saying so."""
    row = await _get(row_id)
    assert (row.status, row.skip_reason, row.attempts) == ("skipped", reason, 0)
    assert row.sent_at is None and row.last_error is None
    [log] = await _logs(row_id, "email_skipped")
    assert (log.channel, log.reason) == ("email", reason)
    return log


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


async def test_deferred_notification_email_waits_then_sends(db, email_on):
    """A notification email queued with a future send_at (quiet hours) is
    not claimed until that time passes, then goes out once."""
    _, _, row = await _deferred_notification_mail(db)
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 0
    assert send.calls == []
    assert (await _get(row.id)).status == "queued"
    # time passes: the scheduled moment is now in the past
    async with get_sessionmaker()() as s:
        later = await s.get(EmailOutbox, row.id)
        later.next_attempt_at = datetime.now(UTC) - timedelta(seconds=1)
        await s.commit()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert [c["to"] for c in send.calls] == ["pat@test.example.com"]
    assert (await _get(row.id)).status == "sent"
    assert await deliver_once(get_sessionmaker(), send=send) == 0


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

    async def flaky(session, row, send):
        order.append(row.id)
        if len(order) == 1:
            raise RuntimeError("bad row for alice@test.example.com")
        await real(session, row, send)

    monkeypatch.setattr(delivery, "_deliver", flaky)
    await asyncio.sleep(1.1)
    assert await deliver_once(get_sessionmaker(), send=FakeSend()) == 2
    assert (await _get(order[1])).status == "sent"
    assert {first, second} == set(order)
    assert "alice@test.example.com" not in caplog.text


# ── send-time re-check of notification mail ─────────────────────────

async def test_read_before_send_is_dropped(db, email_on):
    person, note, mail = await _notification_mail(db)
    await _run(update(Notification).where(Notification.id == note.id)
               .values(read_at=datetime.now(UTC)))
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    log = await _assert_dropped(mail.id, "read")
    # the row carries the whole context a troubleshooter needs
    assert (log.person_id, log.notification_id, log.outbox_id) == (person.id, note.id, mail.id)
    assert (log.kind, log.category) == ("report_ready", "reports")


async def test_deferred_email_read_while_waiting_is_dropped(db, email_on):
    """The bell's Mark all read clears a deferred item before its quiet hours
    end: when the window opens the email is dropped, not sent."""
    _, note, mail = await _deferred_notification_mail(db)
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 0       # still waiting
    await _run(update(Notification).where(Notification.id == note.id)
               .values(read_at=datetime.now(UTC)))
    await _run(update(EmailOutbox).where(EmailOutbox.id == mail.id)     # the window opens
               .values(next_attempt_at=datetime.now(UTC) - timedelta(seconds=1)))
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    await _assert_dropped(mail.id, "read")


@pytest.mark.parametrize("also_read", [False, True], ids=["hidden", "read-then-cleared"])
async def test_hidden_before_send_is_dropped(db, email_on, also_read):
    """Hiding an item drops its email; so does Clear read, which hides items
    that were read first (the reason is `hidden`, the stronger of the two)."""
    _, note, mail = await _notification_mail(db)
    now = datetime.now(UTC)
    await _run(update(Notification).where(Notification.id == note.id)
               .values(dismissed_at=now, **({"read_at": now} if also_read else {})))
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    await _assert_dropped(mail.id, "hidden")


async def test_unread_visible_item_still_sends(db, email_on):
    """The re-check drops nothing it should not: an unread, visible item
    whose person and group are unchanged goes out and is not marked skipped."""
    _, _, mail = await _notification_mail(db)
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert [c["to"] for c in send.calls] == [ADDRESS]
    row = await _get(mail.id)
    assert (row.status, row.skip_reason, row.attempts) == ("sent", None, 1)


async def test_decided_approval_is_dropped(db, email_on):
    person = await _person(db)
    await _group(db, person, categories=("approvals",))
    _, decided, decided_mail = await _notification_mail(
        db, "membership_request", person=person, title="Decided",
        payload={"state": "pending"})
    _, _, waiting_mail = await _notification_mail(
        db, "membership_request", person=person, title="Waiting",
        payload={"state": "pending"})
    # an admin decides the first request after its email was queued
    await _run(update(Notification).where(Notification.id == decided.id)
               .values(payload={"state": "approved", "decided_by": "Alice"}))
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 2
    assert [c["subject"] for c in send.calls] == ["Waiting"]
    await _assert_dropped(decided_mail.id, "resolved")
    assert (await _get(waiting_mail.id)).status == "sent"


@pytest.mark.parametrize("state,reason", [("rejected", "resolved"), ("open", None)])
async def test_resolved_is_any_state_but_pending_or_open(db, email_on, state, reason):
    """`resolved` is any payload state but pending or open (a reset card is
    open until decided)."""
    _, note, mail = await _notification_mail(db, "membership_request",
                                             payload={"state": "pending"})
    await _run(update(Notification).where(Notification.id == note.id)
               .values(payload={"state": state}))
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    if reason is None:
        assert len(send.calls) == 1 and (await _get(mail.id)).status == "sent"
    else:
        assert send.calls == []
        await _assert_dropped(mail.id, reason)


@pytest.mark.parametrize("choice", ["inbox", "off"])
async def test_category_turned_down_since_is_dropped(db, email_on, choice):
    person, _, mail = await _notification_mail(db, prefs=_prefs(reports="email"))
    await _run(update(UserAccount).where(UserAccount.person_id == person.id)
               .values(ui_prefs=_prefs(reports=choice)))
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    await _assert_dropped(mail.id, "category_turned_down")


async def test_left_the_group_since_is_dropped(db, email_on):
    person, _, mail = await _notification_mail(db)
    await _run(delete(NotificationGroupMember)
               .where(NotificationGroupMember.person_id == person.id))
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    await _assert_dropped(mail.id, "no_email_group")


def _group_update(group, **values):
    return update(NotificationGroup).where(NotificationGroup.id == group.id).values(**values)


def _member_update(person, **values):
    return (update(NotificationGroupMember)
            .where(NotificationGroupMember.person_id == person.id).values(**values))


@pytest.mark.parametrize("change", [
    lambda g, p: _group_update(g, enabled=False),
    lambda g, p: _group_update(g, channels=["web"]),
    lambda g, p: _group_update(g, categories=[]),
    lambda g, p: _member_update(p, channels=["web"]),
], ids=["group-disabled", "group-lost-email", "group-unsubscribed", "member-override-lost-email"])
async def test_group_that_no_longer_emails_drops_the_email(db, email_on, change):
    person = await _person(db)
    group = await _group(db, person)
    _, _, mail = await _notification_mail(db, person=person)
    await _run(change(group, person))
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    await _assert_dropped(mail.id, "no_email_group")


async def test_another_emailing_group_keeps_the_email(db, email_on):
    """One group stopped emailing but the person is in a second subscribed
    group that still does: the email goes."""
    person = await _person(db)
    first = await _group(db, person)
    await _group(db, person)
    _, _, mail = await _notification_mail(db, person=person)
    await _run(_group_update(first, channels=["web"]))
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert len(send.calls) == 1 and (await _get(mail.id)).status == "sent"


async def test_disabled_recipient_is_dropped(db, email_on):
    person, _, mail = await _notification_mail(db, account_email="pat-login@test.example.com")
    await _run(update(UserAccount).where(UserAccount.person_id == person.id)
               .values(disabled_at=datetime.now(UTC)))
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    await _assert_dropped(mail.id, "recipient_inactive")


async def test_archived_recipient_is_dropped(db, email_on):
    person, _, mail = await _notification_mail(db)
    await _run(update(Person).where(Person.id == person.id)
               .values(archived_at=datetime.now(UTC)))
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    await _assert_dropped(mail.id, "recipient_inactive")


async def test_deleted_notification_is_dropped(db, email_on):
    """The inbox row is gone (the mail's link to it is cleared with it)."""
    _, note, mail = await _notification_mail(db)
    await _run(delete(Notification).where(Notification.id == note.id))
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    log = await _assert_dropped(mail.id, "notification_gone")
    assert log.notification_id is None and log.kind == "report_ready"


async def test_notification_mail_without_a_notification_is_dropped(db, email_on):
    """Registered-kind mail that never pointed at an inbox row can't be
    checked, so it is not sent."""
    row = await enqueue(db, "notification", ADDRESS, kind="report_ready", name="Pat",
                        title="Move Report is ready", body="", link="https://p/reports",
                        security=False, prefs_url="https://p/me/notifications")
    await db.commit()
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    await _assert_dropped(row.id, "notification_gone")


@pytest.mark.parametrize("kind,owner_notice", [("password_expiring", True),
                                               ("totp_enrolled", False)],
                         ids=["owner-copy", "admin-copy"])
async def test_security_mail_sends_even_when_read_or_hidden(db, email_on, kind, owner_notice):
    """An account-security email goes out even when the person read or hid
    the inbox item the instant it arrived: whoever can read or hide the item
    must not be able to suppress the email."""
    _, note, mail = await _notification_mail(db, kind, owner_notice=owner_notice)
    now = datetime.now(UTC)
    await _run(update(Notification).where(Notification.id == note.id)
               .values(read_at=now, dismissed_at=now))
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert len(send.calls) == 1
    row = await _get(mail.id)
    assert (row.status, row.skip_reason) == ("sent", None)
    [sent] = await _logs(mail.id, "email_sent")
    assert (sent.kind, sent.category) == (kind, "security")


async def test_template_mail_is_not_rechecked(db, email_on):
    """Password resets, invites and learning mail do not mirror an inbox row,
    so nothing about an inbox row (or even a person) can drop them."""
    row = await enqueue(db, "password_reset", ADDRESS, name="Pat",
                        link="https://p/reset-password#token=t", ttl_minutes=60)
    await db.commit()
    assert row.kind is None
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert len(send.calls) == 1
    assert (await _get(row.id)).status == "sent"


async def test_unregistered_kind_is_not_rechecked(db, email_on):
    """A kind the registry does not list has no category to turn down or
    group to subscribe to; it is sent as queued."""
    row = await enqueue(db, "notification", ADDRESS, kind="not_a_registered_kind", name="Pat",
                        title="Hello", body="", link="https://p/x", security=False,
                        prefs_url="https://p/me/notifications")
    await db.commit()
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert len(send.calls) == 1
    assert (await _get(row.id)).status == "sent"
    [sent] = await _logs(row.id, "email_sent")
    assert (sent.kind, sent.category) == ("not_a_registered_kind", None)


# ── delivery log ────────────────────────────────────────────────────

async def test_smtp_off_records_email_not_set_up(db):
    row_id = await _queue(db)
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    log = await _assert_dropped(row_id, "email_not_set_up")
    # template mail is logged under its template, with no category
    assert (log.kind, log.category, log.notification_id) == ("password_changed", None, None)


async def test_smtp_off_comes_before_the_recheck(db, email_on, monkeypatch):
    """With email off nothing can send, so that is the reason on record even
    for an item the re-check would also have dropped."""
    _, note, mail = await _notification_mail(db)
    await _run(update(Notification).where(Notification.id == note.id)
               .values(read_at=datetime.now(UTC)))
    monkeypatch.setenv("SS_SMTP_HOST", "")
    get_settings.cache_clear()
    send = FakeSend()
    assert await deliver_once(get_sessionmaker(), send=send) == 1
    assert send.calls == []
    log = await _assert_dropped(mail.id, "email_not_set_up")
    assert (log.kind, log.category) == ("report_ready", "reports")


async def test_delivery_outcomes_are_logged(db, email_on, caplog):
    """Sent, retry and gave-up each leave one delivery-log row. A failure logs
    only the exception class and the SMTP code: the error text can embed the
    address, so it stays in last_error."""
    caplog.set_level(logging.DEBUG, logger="serversherpa")
    person = await _person(db)
    await _group(db, person)

    person, note, ok = await _notification_mail(db, person=person)
    assert await deliver_once(get_sessionmaker(), send=FakeSend()) == 1
    [sent] = await _logs(ok.id, "email_sent")
    assert sent.detail == {"attempt": 1}
    assert (sent.channel, sent.reason) == ("email", None)
    assert (sent.person_id, sent.notification_id, sent.outbox_id) == (person.id, note.id, ok.id)
    assert (sent.kind, sent.category) == ("report_ready", "reports")

    _, _, retrying = await _notification_mail(db, person=person)
    refused = smtplib.SMTPResponseException(452, f"{ADDRESS} mailbox full")
    assert await deliver_once(get_sessionmaker(), send=FakeSend(refused)) == 1
    [retry] = await _logs(retrying.id, "email_retry")
    retrying = await _get(retrying.id)
    assert retrying.status == "queued" and ADDRESS in retrying.last_error   # last_error keeps it
    assert set(retry.detail) == {"attempt", "error", "smtp_code", "next_attempt_at"}
    assert (retry.detail["attempt"], retry.detail["error"], retry.detail["smtp_code"]) == (
        1, "SMTPResponseException", 452)
    assert datetime.fromisoformat(retry.detail["next_attempt_at"]) == retrying.next_attempt_at
    assert (retry.person_id, retry.outbox_id) == (person.id, retrying.id)

    _, _, last = await _notification_mail(db, person=person)
    await _run(update(EmailOutbox).where(EmailOutbox.id == last.id)
               .values(attempts=MAX_ATTEMPTS - 1))
    assert await deliver_once(get_sessionmaker(), send=FakeSend(OSError("x"))) == 1
    [failed] = await _logs(last.id, "email_failed")
    assert failed.detail == {"attempts": MAX_ATTEMPTS, "error": "OSError", "smtp_code": None}
    assert (failed.kind, failed.category) == ("report_ready", "reports")
    assert (await _get(last.id)).status == "failed"
    assert await _logs(last.id, "email_retry") == []

    async with get_sessionmaker()() as s:
        every_row = (await s.scalars(select(NotificationLog))).all()
    assert {"email_sent", "email_retry", "email_failed"} <= {r.event for r in every_row}
    for r in every_row:     # no row, and no process-log line, carries the address
        assert ADDRESS not in json.dumps([r.detail, r.reason, r.kind, r.category])
    assert "email_sent" in caplog.text and ADDRESS not in caplog.text


async def test_template_mail_outcome_is_logged_under_its_template(db, email_on):
    row_id = await _queue(db)
    assert await deliver_once(get_sessionmaker(), send=FakeSend()) == 1
    [sent] = await _logs(row_id, "email_sent")
    assert sent.detail == {"attempt": 1}
    assert (sent.kind, sent.category, sent.notification_id) == ("password_changed", None, None)
