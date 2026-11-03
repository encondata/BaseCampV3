"""The summary sweep (notifications/summary.py): email held during a person's
quiet hours or on a day off goes out as one summary email once their summary
time has come, and a held item that is no longer wanted is dropped with a
logged reason. Held rows are built through notify() with a Chicago schedule
(Monday to Friday, quiet hours 9:00 PM to 6:00 AM); the clock is patched
(email._now, outbox._now) and the sweep is given the same `now`. Nothing is
ever sent.

Spec: docs/superpowers/specs/2026-11-01-notifications-phase1-design.md (sections 4 and 7)"""

import asyncio
import json
import logging
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import delete, select, update

from serversherpa.config import get_settings
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    EmailOutbox,
    Notification,
    NotificationHeld,
    NotificationLog,
    Person,
    UserAccount,
)
from serversherpa.mail import outbox as outbox_mod
from serversherpa.notifications import email as email_mod
from serversherpa.notifications import summary as summary_mod
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.summary import run_summaries_once

CHICAGO = ZoneInfo("America/Chicago")
ADDRESS = "pat@test.example.com"
ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
SCHEDULE = {"timezone": "America/Chicago", "days": ALL_DAYS[:5],
            "quiet_start": "21:00", "quiet_end": "06:00"}
BODIES = ("Report body text", "Comment body text")


def _chicago(day: int, hour: int, minute: int = 0) -> datetime:
    """A wall-clock time in Chicago in October 2026 (the 9th is a Friday, the
    12th a Monday)."""
    return datetime(2026, 10, day, hour, minute, tzinfo=CHICAGO)


FRIDAY_10PM = _chicago(9, 22)
FRIDAY_11PM = _chicago(9, 23)
# An hour before Monday's quiet hours end: the summary time of both
MONDAY_5AM = _chicago(12, 5)


@pytest.fixture
def clock(monkeypatch):
    """Set the instant an email is decided (email._now) and queued (outbox._now)."""
    def set_to(instant: datetime) -> datetime:
        monkeypatch.setattr(email_mod, "_now", lambda: instant)
        monkeypatch.setattr(outbox_mod, "_now", lambda: instant)
        return instant
    return set_to


def _prefs(schedule=None, switches=None) -> dict:
    return {"notif": {"schedule": schedule or SCHEDULE, "switches": switches or {}}}


async def _person(db, email=ADDRESS, *, first="Pat", schedule=None):
    p = Person(first_name=first, last_name="Tester", email=email)
    db.add(p)
    await db.flush()
    db.add(UserAccount(person_id=p.id, email=f"acct-{str(p.id)[:8]}@x.test",
                       password_hash="x", ui_prefs=_prefs(schedule)))
    await db.flush()
    return p


async def _hold_two(db, clock, person):
    """Two notifications held on Friday night: a report at 10:00 PM (Reports &
    labels), then a wiki comment at 11:00 PM (Wiki)."""
    clock(FRIDAY_10PM)
    report = await notify(db, person.id, "report_ready", "Report ready",
                          body=BODIES[0], link="/reports?run=1")
    clock(FRIDAY_11PM)
    comment = await notify(db, person.id, "wiki_comment", "New comment",
                           body=BODIES[1], link="/wiki/page/2")
    await db.commit()
    assert [h.notification_id for h in await _held(person)] == [report.id, comment.id]
    return report, comment


async def _run(stmt) -> None:
    """One statement in its own session: a change made while the email waits."""
    async with get_sessionmaker()() as s:
        await s.execute(stmt)
        await s.commit()


async def _set_prefs(person, **prefs) -> None:
    await _run(update(UserAccount).where(UserAccount.person_id == person.id)
               .values(ui_prefs=_prefs(**prefs)))


async def _sweep(clock, now: datetime) -> int:
    """One sweep at `now`, with the outbox's clock at the same instant."""
    clock(now)
    return await run_summaries_once(get_sessionmaker(), now=now)


async def _held(person=None) -> list[NotificationHeld]:
    q = select(NotificationHeld).order_by(NotificationHeld.held_at)
    if person is not None:
        q = q.where(NotificationHeld.person_id == person.id)
    async with get_sessionmaker()() as s:
        return list(await s.scalars(q))


async def _outbox() -> list[EmailOutbox]:
    async with get_sessionmaker()() as s:
        return list(await s.scalars(select(EmailOutbox).order_by(EmailOutbox.created_at)))


async def _log(*events) -> list[NotificationLog]:
    q = select(NotificationLog).order_by(NotificationLog.id)
    if events:
        q = q.where(NotificationLog.event.in_(events))
    async with get_sessionmaker()() as s:
        return list(await s.scalars(q))


async def _skipped() -> set[tuple]:
    return {(e.notification_id, e.reason) for e in await _log("email_skipped")}


# ── the summary ─────────────────────────────────────────────────────

async def test_summary_sends_one_email(db, email_on, clock):
    p = await _person(db)
    report, comment = await _hold_two(db, clock, p)

    assert await _sweep(clock, MONDAY_5AM) == 1

    [mail] = await _outbox()
    assert (mail.template, mail.to_address, mail.person_id) == (
        "notification_summary", ADDRESS, p.id)
    assert mail.subject == "Your notification summary (2)"
    # template mail, sent now: it mirrors no one notification and is never re-checked
    assert (mail.kind, mail.notification_id) == (None, None)
    assert mail.next_attempt_at == MONDAY_5AM
    origin = get_settings().portal_origin.rstrip("/")
    text = mail.text_body
    assert text.startswith("Hi Pat,\n\nHere's what arrived during your quiet hours or day off:\n")
    report_item = f"Reports & labels · Report ready\n{origin}/reports?run=1\n"
    comment_item = f"Wiki · New comment\n{origin}/wiki/page/2\n"
    assert report_item in text and comment_item in text
    assert text.index(report_item) < text.index(comment_item)      # oldest first
    assert text.endswith(f"Change what you receive and when: {origin}/me/notifications\n")
    # the HTML holds the same content as a list, each title linked
    html = mail.html_body
    assert html.count("<li") == 2
    assert f'<a href="{origin}/reports?run=1"' in html
    assert f'<a href="{origin}/wiki/page/2"' in html
    assert html.index(">Report ready</a>") < html.index(">New comment</a>")
    assert "Reports &amp; labels · " in html and "Wiki · " in html
    assert "Here's what arrived during your quiet hours or day off:" in html
    assert "Change what you receive and when: " in html
    assert f'href="{origin}/me/notifications"' in html
    # one line per item: the bodies are left out
    for body in BODIES:
        assert body not in text and body not in html

    assert await _held() == []
    summarized = await _log("email_summarized")
    assert {(e.notification_id, e.outbox_id) for e in summarized} == {
        (report.id, mail.id), (comment.id, mail.id)}
    assert {(e.kind, e.category) for e in summarized} == {
        ("report_ready", "reports"), ("wiki_comment", "wiki")}
    for entry in summarized:
        assert (entry.channel, entry.person_id) == ("email", p.id)
        assert (entry.reason, entry.detail) == (None, {})
    [queued] = await _log("email_queued")           # the summary's own row
    assert (queued.outbox_id, queued.person_id, queued.notification_id) == (mail.id, p.id, None)
    assert (queued.kind, queued.category) == ("notification_summary", None)
    assert queued.detail == {"template": "notification_summary",
                             "send_at": MONDAY_5AM.isoformat(), "deferred": False,
                             "summary": True, "count": 2}
    assert await _log("email_skipped") == []

    # a second sweep finds nothing left to send
    assert await _sweep(clock, MONDAY_5AM) == 0
    assert len(await _outbox()) == 1


async def test_summary_html_escapes_titles(db, email_on, clock):
    p = await _person(db)
    clock(FRIDAY_10PM)
    await notify(db, p.id, "wiki_comment", "<b>x</b>", link="/wiki/page/2?a=1&b=2")
    await db.commit()

    assert await _sweep(clock, MONDAY_5AM) == 1
    [mail] = await _outbox()
    assert "<b>x</b>" not in mail.html_body
    assert ">&lt;b&gt;x&lt;/b&gt;</a>" in mail.html_body
    assert "/wiki/page/2?a=1&amp;b=2" in mail.html_body
    assert "Wiki · <b>x</b>\n" in mail.text_body          # the text part is plain


async def test_summary_waits_until_due(db, email_on, clock):
    p = await _person(db)
    await _hold_two(db, clock, p)
    before = [e.id for e in await _log()]

    assert await _sweep(clock, _chicago(12, 4, 59)) == 0
    assert await _outbox() == []
    assert len(await _held(p)) == 2
    assert [e.id for e in await _log()] == before        # nothing logged either

    # at its time it goes
    assert await _sweep(clock, MONDAY_5AM) == 1


async def test_each_person_gets_their_own_summary_at_their_own_time(db, email_on, clock):
    pat = await _person(db)
    sam = await _person(db, "sam@test.example.com", first="Sam",
                        schedule={**SCHEDULE, "quiet_end": "08:00"})
    clock(FRIDAY_10PM)
    await notify(db, pat.id, "report_ready", "Report ready")
    sam_note = await notify(db, sam.id, "report_ready", "Report ready")
    await db.commit()

    assert await _sweep(clock, MONDAY_5AM) == 1         # Sam's summary is at 7:00 AM
    [mail] = await _outbox()
    assert (mail.to_address, mail.person_id) == (ADDRESS, pat.id)
    assert mail.subject == "Your notification summary (1)"
    assert await _held(pat) == []
    assert [h.notification_id for h in await _held(sam)] == [sam_note.id]

    assert await _sweep(clock, _chicago(12, 7)) == 1
    _, sam_mail = await _outbox()
    assert (sam_mail.to_address, sam_mail.person_id) == ("sam@test.example.com", sam.id)
    assert sam_mail.text_body.startswith("Hi Sam,")
    assert await _held() == []


# ── dropped items ───────────────────────────────────────────────────

async def test_summary_drops_read_items(db, email_on, clock):
    p = await _person(db)
    report, comment = await _hold_two(db, clock, p)
    await _run(update(Notification).where(Notification.id == report.id)
               .values(read_at=FRIDAY_11PM))

    assert await _sweep(clock, MONDAY_5AM) == 1
    [mail] = await _outbox()
    assert mail.subject == "Your notification summary (1)"
    assert "New comment" in mail.text_body and "Report ready" not in mail.text_body
    [skipped] = await _log("email_skipped")
    assert (skipped.channel, skipped.reason, skipped.outbox_id) == ("email", "read", None)
    assert (skipped.person_id, skipped.notification_id) == (p.id, report.id)
    assert (skipped.kind, skipped.category) == ("report_ready", "reports")
    [summarized] = await _log("email_summarized")
    assert (summarized.notification_id, summarized.outbox_id) == (comment.id, mail.id)
    assert await _held(p) == []


async def test_nothing_left_sends_nothing(db, email_on, clock):
    p = await _person(db)
    report, comment = await _hold_two(db, clock, p)
    await _run(update(Notification).where(Notification.person_id == p.id)
               .values(read_at=FRIDAY_11PM))

    assert await _sweep(clock, MONDAY_5AM) == 0
    assert await _outbox() == []
    assert await _held(p) == []
    assert await _skipped() == {(report.id, "read"), (comment.id, "read")}
    assert await _log("email_summarized", "email_queued") == []


async def test_schedule_change_releases_held_mail(db, email_on, clock):
    p = await _person(db)
    await _hold_two(db, clock, p)
    saturday = _chicago(10, 10)
    assert await _sweep(clock, saturday) == 0           # on the old schedule: Monday 5:00 AM

    await _set_prefs(p, schedule={"timezone": "America/Chicago", "days": ALL_DAYS,
                                  "quiet_start": None, "quiet_end": None})
    assert await _sweep(clock, saturday) == 1
    [mail] = await _outbox()
    assert mail.subject == "Your notification summary (2)"
    assert await _held(p) == []


async def test_email_turned_off_drops(db, email_on, clock):
    p = await _person(db)
    report, _ = await _hold_two(db, clock, p)
    await _set_prefs(p, switches={"reports": {"email": False}})

    assert await _sweep(clock, MONDAY_5AM) == 1
    assert await _skipped() == {(report.id, "category_turned_down")}
    [mail] = await _outbox()                        # the wiki comment still goes
    assert mail.subject == "Your notification summary (1)"
    assert "New comment" in mail.text_body and "Report ready" not in mail.text_body
    assert await _held(p) == []


async def test_archived_person_drops(db, email_on, clock):
    p = await _person(db)
    report, comment = await _hold_two(db, clock, p)
    await _run(update(Person).where(Person.id == p.id).values(archived_at=FRIDAY_11PM))

    assert await _sweep(clock, MONDAY_5AM) == 0
    assert await _outbox() == []
    assert await _skipped() == {(report.id, "recipient_inactive"),
                                (comment.id, "recipient_inactive")}
    assert await _held(p) == []


async def test_deleted_notification_drops(db, email_on, clock):
    p = await _person(db)
    report, comment = await _hold_two(db, clock, p)
    await _run(delete(Notification).where(Notification.id == report.id))
    # the held row stays, with its link cleared
    assert [h.notification_id for h in await _held(p)] == [None, comment.id]

    assert await _sweep(clock, MONDAY_5AM) == 1
    [skipped] = await _log("email_skipped")
    assert (skipped.reason, skipped.notification_id) == ("notification_gone", None)
    assert (skipped.person_id, skipped.kind, skipped.category) == (
        p.id, "report_ready", "reports")
    [mail] = await _outbox()
    assert mail.subject == "Your notification summary (1)"
    assert await _held(p) == []


async def test_every_notification_deleted_sends_nothing(db, email_on, clock):
    p = await _person(db)
    await _hold_two(db, clock, p)
    await _run(delete(Notification).where(Notification.person_id == p.id))

    assert await _sweep(clock, MONDAY_5AM) == 0
    assert await _outbox() == []
    assert await _skipped() == {(None, "notification_gone")}
    assert len(await _log("email_skipped")) == 2
    assert await _held(p) == []


async def test_no_address_drops(db, email_on, clock):
    p = await _person(db)
    report, comment = await _hold_two(db, clock, p)
    # the sign-in is removed and there is no contact email: nowhere to send it
    await _run(delete(UserAccount).where(UserAccount.person_id == p.id))
    await _run(update(Person).where(Person.id == p.id).values(email=None))

    # without an account the schedule is the default one, always open: due at once
    assert await _sweep(clock, _chicago(10, 10)) == 0
    assert await _outbox() == []
    assert await _skipped() == {(report.id, "no_address"), (comment.id, "no_address")}
    assert await _held(p) == []


async def test_server_email_off_drops(db, email_on, clock, monkeypatch):
    p = await _person(db)
    report, comment = await _hold_two(db, clock, p)
    monkeypatch.setenv("SS_SMTP_HOST", "")          # email is no longer set up
    get_settings.cache_clear()

    # not due yet: still waiting
    assert await _sweep(clock, _chicago(12, 4, 59)) == 0
    assert len(await _held(p)) == 2
    assert await _log("email_skipped") == []

    assert await _sweep(clock, MONDAY_5AM) == 0
    assert await _outbox() == []
    assert await _skipped() == {(report.id, "email_not_set_up"),
                                (comment.id, "email_not_set_up")}
    assert await _held(p) == []


# ── robustness ──────────────────────────────────────────────────────

async def test_rows_another_sweep_holds_are_skipped(db, email_on, clock):
    p = await _person(db)
    await _hold_two(db, clock, p)

    async with get_sessionmaker()() as other:       # another sweep is handling them
        await other.execute(select(NotificationHeld).with_for_update())
        # skipped, not waited for: the wait is bounded, so a claim that blocks
        # fails here instead of hanging the suite
        assert await asyncio.wait_for(_sweep(clock, MONDAY_5AM), timeout=10) == 0
        await other.rollback()
    assert len(await _held(p)) == 2
    assert await _log("email_skipped", "email_summarized", "email_queued") == []

    assert await _sweep(clock, MONDAY_5AM) == 1


async def test_a_failed_pass_keeps_that_persons_mail_held(db, email_on, clock, monkeypatch,
                                                         caplog):
    pat = await _person(db)
    sam = await _person(db, "sam@test.example.com", first="Sam")
    clock(FRIDAY_10PM)
    await notify(db, pat.id, "report_ready", "Report ready")
    await notify(db, sam.id, "report_ready", "Report ready")
    await db.commit()
    real = summary_mod.enqueue

    async def failing_for_sam(session, template, to, **kw):
        if to == "sam@test.example.com":
            raise RuntimeError("could not write sam@test.example.com")
        return await real(session, template, to, **kw)

    monkeypatch.setattr(summary_mod, "enqueue", failing_for_sam)
    caplog.set_level(logging.WARNING, logger="serversherpa.notifications.summary")
    assert await _sweep(clock, MONDAY_5AM) == 1     # Pat's still goes
    [mail] = await _outbox()
    assert mail.person_id == pat.id
    # Sam's pass rolled back whole: the row waits, and nothing was logged for it
    assert len(await _held(sam)) == 1
    assert [e.person_id for e in await _log("email_summarized", "email_skipped")] == [pat.id]
    assert "RuntimeError" in caplog.text
    assert "sam@test.example.com" not in caplog.text      # the class only, never the text
    assert await _sweep(clock, MONDAY_5AM) == 0           # still failing: logged once
    assert caplog.text.count("could not send the notification summary") == 1

    monkeypatch.setattr(summary_mod, "enqueue", real)
    assert await _sweep(clock, _chicago(12, 5, 1)) == 1   # the next sweep sends it
    assert await _held() == []


async def test_summary_logs_carry_no_address_or_body(db, email_on, clock, caplog):
    caplog.set_level(logging.DEBUG, logger="serversherpa")
    p = await _person(db)
    report, _ = await _hold_two(db, clock, p)
    await _run(update(Notification).where(Notification.id == report.id)
               .values(read_at=FRIDAY_11PM))

    assert await _sweep(clock, MONDAY_5AM) == 1
    rows = await _log()
    assert {"email_held", "email_skipped", "email_summarized", "email_queued"} <= {
        r.event for r in rows}
    for r in rows:
        logged = json.dumps([r.detail, r.reason, r.kind, r.category])
        assert ADDRESS not in logged
        for body in BODIES:
            assert body not in logged
    assert "email_summarized" in caplog.text        # the delivery log's own lines ran
    assert ADDRESS not in caplog.text
    for body in BODIES:
        assert body not in caplog.text
