"""notify() email: the server's email gate, the person's switches (their own
or the company default), critical kinds, the person's schedule (send now or
hold for the summary), owner and admin copies of account-security notices,
the address, the templates, and the delivery-log rows each decision writes.
Notification groups play no part. Assertions read EmailOutbox,
NotificationHeld and NotificationLog rows; nothing is ever sent.

Spec: docs/superpowers/specs/2026-11-01-notifications-phase1-design.md (sections 4, 5 and 7)"""

from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import func, select

from serversherpa.config import get_settings
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    EmailOutbox,
    Notification,
    NotificationGroup,
    NotificationGroupMember,
    NotificationHeld,
    NotificationLog,
    Person,
    SystemConfig,
    UserAccount,
)
from serversherpa.mail import outbox as outbox_mod
from serversherpa.notifications import email as email_mod
from serversherpa.notifications.company import load_company_settings
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.kinds import kind_info

# A fixed Wednesday, 15:00 UTC (10:00 in Chicago), so nothing depends on the clock.
NOW = datetime(2026, 10, 7, 15, 0, tzinfo=UTC)
CHICAGO = ZoneInfo("America/Chicago")
WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"]


def _chicago(day: int, hour: int, minute: int = 0) -> datetime:
    """A wall-clock time in Chicago in October 2026 (the 5th is a Monday)."""
    return datetime(2026, 10, day, hour, minute, tzinfo=CHICAGO)


@pytest.fixture
def clock(monkeypatch):
    """Set the instant the email is decided (email._now) and queued (outbox._now)."""
    def set_to(instant: datetime) -> datetime:
        monkeypatch.setattr(email_mod, "_now", lambda: instant)
        monkeypatch.setattr(outbox_mod, "_now", lambda: instant)
        return instant
    return set_to


async def _person(db, email="pat@test.example.com", *, account_email=None, prefs=None,
                  first="Pat"):
    p = Person(first_name=first, last_name="Tester", email=email)
    db.add(p)
    await db.flush()
    if account_email or prefs is not None:
        db.add(UserAccount(person_id=p.id, email=account_email or "acct-" + str(p.id)[:8] + "@x.test",
                           password_hash="x", ui_prefs=prefs or {}))
        await db.flush()
    return p


def _prefs(**cats):
    """ui_prefs of a person who chose, per category, "email" (follow the company
    default: no entry), "inbox" (Email off) or "off" (Inbox and Email off)."""
    own = {"inbox": {"email": False}, "off": {"inbox": False, "email": False}}
    return {"notif": {"switches": {category: own[choice] for category, choice in cats.items()
                                   if choice != "email"}}}


def _schedule(*, days=None, switches=None):
    """ui_prefs with a Chicago schedule: quiet hours 9:00 PM to 6:00 AM, on
    `days` (default every day), plus the person's own `switches`."""
    schedule = {"timezone": "America/Chicago", "quiet_start": "21:00", "quiet_end": "06:00"}
    if days is not None:
        schedule["days"] = days
    return {"notif": {"schedule": schedule, "switches": switches or {}}}


async def _company(db, *, defaults=None, critical_kinds=None):
    """Save the company notification settings (System › Notifications › Defaults)."""
    data = {}
    if defaults is not None:
        data["defaults"] = defaults
    if critical_kinds is not None:
        data["critical_kinds"] = critical_kinds
    db.add(SystemConfig(section="notifications", data=data))
    await db.flush()


async def _outbox(db, person=None):
    q = select(EmailOutbox).order_by(EmailOutbox.created_at)
    if person is not None:
        q = q.where(EmailOutbox.person_id == person.id)
    return list(await db.scalars(q))


async def _held(db, person):
    return list(await db.scalars(select(NotificationHeld)
                                 .where(NotificationHeld.person_id == person.id)
                                 .order_by(NotificationHeld.held_at)))


async def _log(db, event=None):
    q = select(NotificationLog).order_by(NotificationLog.id)
    if event is not None:
        q = q.where(NotificationLog.event == event)
    return list(await db.scalars(q))


# ── gates ───────────────────────────────────────────────────────────

async def test_smtp_off_writes_inbox_only(db):
    p = await _person(db)
    row = await notify(db, p.id, "report_ready", "Ready", body="b")
    assert row is not None
    assert await _outbox(db) == []


async def test_emails_without_any_group(db, email_on, clock):
    sent = clock(NOW)
    p = await _person(db, prefs={})                 # an account, and no group anywhere
    row = await notify(db, p.id, "report_ready", "Ready")
    [mail] = await _outbox(db, p)
    assert (mail.notification_id, mail.to_address) == (row.id, "pat@test.example.com")
    assert mail.next_attempt_at == sent
    [entry] = await _log(db, "email_queued")
    assert entry.detail == {"template": "notification", "send_at": sent.isoformat(),
                            "deferred": False, "via": "contact"}
    assert await db.scalar(select(func.count()).select_from(NotificationGroupMember)) == 0


async def test_groups_play_no_part(db, email_on):
    """Being in a group changes nothing: a paused group neither blocks the email
    nor adds one."""
    p = await _person(db)
    group = NotificationGroup(name="Group A", enabled=False)
    db.add(group)
    await db.flush()
    db.add(NotificationGroupMember(group_id=group.id, person_id=p.id))
    await db.flush()
    await notify(db, p.id, "report_ready", "Ready")
    assert len(await _outbox(db, p)) == 1


async def test_queued_email_carries_the_notification(db, email_on):
    p = await _person(db)
    row = await notify(db, p.id, "report_ready", "Move Report is ready",
                       body="NAP11 finished", link="/reports?run=abc")
    [mail] = await _outbox(db, p)
    assert mail.template == "notification"
    assert mail.kind == "report_ready"
    assert mail.notification_id == row.id
    assert mail.to_address == "pat@test.example.com"
    assert mail.subject == "Move Report is ready"
    origin = get_settings().portal_origin.rstrip("/")
    assert "NAP11 finished" in mail.html_body and "NAP11 finished" in mail.text_body
    assert f"{origin}/reports?run=abc" in mail.html_body
    assert f"{origin}/reports?run=abc" in mail.text_body
    assert "Hi Pat," in mail.text_body


# ── switches ────────────────────────────────────────────────────────

async def test_personal_inbox_choice_skips_email(db, email_on):
    p = await _person(db, prefs=_prefs(reports="inbox"))
    row = await notify(db, p.id, "report_ready", "Ready")
    assert row is not None
    assert await _outbox(db) == []


async def test_personal_off_writes_nothing_and_returns_none(db, email_on):
    p = await _person(db, prefs=_prefs(reports="off"))
    assert await notify(db, p.id, "report_ready", "Ready") is None
    assert await _outbox(db) == []
    assert list(await db.scalars(select(Notification).where(
        Notification.person_id == p.id))) == []


async def test_personal_off_applies_with_smtp_off_too(db):
    p = await _person(db, prefs=_prefs(reports="off"))
    assert await notify(db, p.id, "report_ready", "Ready") is None


async def test_security_ignores_a_stored_off(db, email_on):
    p = await _person(db, prefs=_prefs(security="off"))
    row = await notify(db, p.id, "password_expiring", "Expiring", owner_notice=True)
    assert row is not None
    assert len(await _outbox(db, p)) == 1


async def test_off_never_hides_the_password_reset_card(db):
    # SMTP off: this card is the only way a locked-out user reaches an admin,
    # so a category "off" must not swallow it (other approvals kinds still obey).
    p = await _person(db, prefs=_prefs(approvals="off"))
    assert await notify(db, p.id, "password_reset_request", "Pat asked for a reset") is not None
    assert await notify(db, p.id, "membership_request", "Join?") is None
    [row] = list(await db.scalars(select(Notification).where(
        Notification.person_id == p.id)))
    assert row.kind == "password_reset_request"


async def test_company_default_email_off_blocks(db, email_on):
    await _company(db, defaults={"wiki": {"inbox": True, "email": False}})
    follows = await _person(db, "follows@test.example.com", prefs={})
    chose = await _person(db, "chose@test.example.com",
                          prefs={"notif": {"switches": {"wiki": {"email": True}}}})

    note = await notify(db, follows.id, "wiki_comment", "New comment")
    assert note is not None
    assert await _outbox(db, follows) == []
    [entry] = await _log(db, "email_not_queued")
    assert (entry.reason, entry.notification_id) == ("category_inbox_only", note.id)
    assert entry.detail == {"source": "default"}

    # the person's own Email on beats the default
    await notify(db, chose.id, "wiki_comment", "New comment")
    [mail] = await _outbox(db, chose)
    assert mail.kind == "wiki_comment"


# ── schedule ────────────────────────────────────────────────────────

async def test_held_during_quiet_hours(db, email_on, clock):
    p = await _person(db, prefs=_schedule())
    clock(_chicago(7, 22))                          # Wednesday 10:00 PM in Chicago
    note = await notify(db, p.id, "report_ready", "Ready", body="NAP11 finished")

    # added to the caller's session: not flushed, and not committed
    assert len([o for o in db.new if isinstance(o, NotificationHeld)]) == 1
    async with get_sessionmaker()() as other:
        assert await other.scalar(select(func.count()).select_from(NotificationHeld)) == 0

    assert await _outbox(db) == []
    [held] = await _held(db, p)
    assert (held.notification_id, held.kind, held.category, held.reason) == (
        note.id, "report_ready", "reports", "quiet_hours")
    assert held.held_at == _chicago(7, 22)
    [entry] = await _log(db, "email_held")
    assert (entry.channel, entry.reason, entry.outbox_id) == ("email", "quiet_hours", None)
    assert (entry.person_id, entry.notification_id) == (p.id, note.id)
    assert (entry.kind, entry.category) == ("report_ready", "reports")
    # an hour before quiet hours end: 5:00 AM Thursday in Chicago. Only the
    # time: never the address, never the body.
    assert entry.detail == {"summary_at": _chicago(8, 5).astimezone(UTC).isoformat()}
    assert datetime.fromisoformat(entry.detail["summary_at"]) == _chicago(8, 5)
    assert await _log(db, "email_queued") == []
    assert await _log(db, "email_not_queued") == []


async def test_held_on_day_off(db, email_on, clock):
    p = await _person(db, prefs=_schedule(days=WEEKDAYS))
    clock(_chicago(10, 12))                         # Saturday noon in Chicago
    await notify(db, p.id, "report_ready", "Ready")
    assert await _outbox(db) == []
    [held] = await _held(db, p)
    assert held.reason == "inactive_day"
    [entry] = await _log(db, "email_held")
    assert entry.reason == "inactive_day"
    # back online when Monday's quiet hours end: the summary is at 5:00 AM Monday
    assert datetime.fromisoformat(entry.detail["summary_at"]) == _chicago(12, 5)


async def test_last_hour_sends_now(db, email_on, clock):
    p = await _person(db, prefs=_schedule())
    sent = clock(_chicago(8, 5, 30))                # Thursday 5:30 AM: that morning's summary went at 5
    await notify(db, p.id, "report_ready", "Ready")
    assert await _held(db, p) == []
    [mail] = await _outbox(db, p)
    assert mail.next_attempt_at == sent
    [entry] = await _log(db, "email_queued")
    assert entry.detail["after_summary"] is True
    assert entry.detail["deferred"] is False
    assert "critical" not in entry.detail and "owner_copy" not in entry.detail


async def test_open_schedule_sends_now(db, email_on, clock):
    p = await _person(db, prefs=_schedule(days=WEEKDAYS))
    sent = clock(_chicago(7, 10))                   # Wednesday 10:00 AM in Chicago
    await notify(db, p.id, "report_ready", "Ready")
    assert await _held(db, p) == []
    [mail] = await _outbox(db, p)
    assert mail.next_attempt_at == sent
    [entry] = await _log(db, "email_queued")
    assert set(entry.detail) == {"template", "send_at", "deferred", "via"}


async def test_an_unloadable_schedule_zone_falls_back_to_the_reference_zone(db, email_on, clock):
    """A stored zone that no longer loads must not break notify(): the
    schedule is read in America/New_York instead."""
    new_york = ZoneInfo("America/New_York")
    p = await _person(db, prefs={"notif": {"schedule": {
        "timezone": "Mars/Olympus_Mons", "quiet_start": "21:00", "quiet_end": "06:00"}}})
    clock(datetime(2026, 10, 7, 21, 30, tzinfo=new_york))
    assert await notify(db, p.id, "report_ready", "Ready") is not None
    [held] = await _held(db, p)
    assert held.reason == "quiet_hours"
    [entry] = await _log(db, "email_held")
    assert datetime.fromisoformat(entry.detail["summary_at"]) == datetime(
        2026, 10, 8, 5, 0, tzinfo=new_york)


# ── critical ────────────────────────────────────────────────────────

async def test_critical_skips_holding(db, email_on, clock):
    await _company(db, critical_kinds=["report_failed"])
    p = await _person(db, prefs=_schedule())
    sent = clock(_chicago(7, 22))                   # quiet hours
    await notify(db, p.id, "report_failed", "Report failed")
    assert await _held(db, p) == []
    [mail] = await _outbox(db, p)
    assert (mail.kind, mail.next_attempt_at) == ("report_failed", sent)
    [entry] = await _log(db, "email_queued")
    assert entry.detail["critical"] is True
    assert "owner_copy" not in entry.detail and "after_summary" not in entry.detail
    # a kind nobody marked critical still waits
    await notify(db, p.id, "report_ready", "Ready")
    [held] = await _held(db, p)
    assert held.kind == "report_ready"


async def test_critical_still_obeys_switches(db, email_on, clock):
    await _company(db, critical_kinds=["report_failed"])
    p = await _person(db, prefs=_schedule(switches={"reports": {"email": False}}))
    clock(_chicago(7, 22))
    assert await notify(db, p.id, "report_failed", "Report failed") is not None
    assert await _outbox(db) == []
    assert await _held(db, p) == []
    [entry] = await _log(db, "email_not_queued")
    assert entry.reason == "category_inbox_only"
    assert entry.detail == {"source": "own"}


# ── address ─────────────────────────────────────────────────────────

async def test_falls_back_to_the_account_email(db, email_on):
    p = await _person(db, email=None, account_email="acct@test.example.com")
    await notify(db, p.id, "report_ready", "Ready")
    [mail] = await _outbox(db, p)
    assert mail.to_address == "acct@test.example.com"


async def test_no_address_no_email(db, email_on):
    p = await _person(db, email=None)
    assert await notify(db, p.id, "report_ready", "Ready") is not None
    assert await _outbox(db) == []


# ── owner and admin copies of account-security notices ──────────────

async def test_owner_notice_emails(db, email_on):
    p = await _person(db)
    await notify(db, p.id, "password_expiring", "Expiring", owner_notice=True)
    [mail] = await _outbox(db, p)
    assert mail.kind == "password_expiring"


async def test_owner_security_copy_ignores_schedule(db, email_on, clock):
    p = await _person(db, "contact@test.example.com", account_email="login@test.example.com",
                      prefs=_schedule())
    sent = clock(_chicago(7, 22))                   # quiet hours
    await notify(db, p.id, "password_expiring", "Expiring", owner_notice=True)
    assert await _held(db, p) == []
    [mail] = await _outbox(db, p)
    assert (mail.to_address, mail.next_attempt_at) == ("login@test.example.com", sent)
    [entry] = await _log(db, "email_queued")
    assert (entry.detail["owner_copy"], entry.detail["via"]) == (True, "login")
    assert "critical" not in entry.detail and "after_summary" not in entry.detail


async def test_admin_security_copy_inbox_only(db, email_on):
    admin = await _person(db, "admin@test.example.com", first="Admin")
    row = await notify(db, admin.id, "totp_enrolled", "Person A enrolled two-factor")
    assert row is not None
    assert await _outbox(db) == []
    assert await _held(db, admin) == []
    [entry] = await _log(db, "email_not_queued")
    assert (entry.reason, entry.notification_id) == ("admin_copy", row.id)
    assert (entry.kind, entry.category, entry.detail) == ("totp_enrolled", "security", {})


async def test_owner_security_notice_goes_to_the_login_email_first(db, email_on):
    # Someone who can edit a person's contact email must not receive that
    # person's security notices: owner copies use the login email first.
    p = await _person(db, "contact@test.example.com", account_email="login@test.example.com")
    await notify(db, p.id, "totp_enrolled", "Two-factor is on", owner_notice=True)
    [own] = await _outbox(db, p)
    assert own.to_address == "login@test.example.com"


async def test_owner_notice_falls_back_to_the_contact_email_without_a_login_email(db, email_on):
    p = await _person(db, "contact@test.example.com")
    await notify(db, p.id, "totp_enrolled", "Two-factor is on", owner_notice=True)
    [own] = await _outbox(db, p)
    assert own.to_address == "contact@test.example.com"


async def test_other_mail_keeps_the_contact_email_first(db, email_on):
    p = await _person(db, "contact@test.example.com", account_email="login@test.example.com")
    await notify(db, p.id, "report_ready", "Ready")
    await notify(db, p.id, "wiki_comment", "New comment")
    assert {m.to_address for m in await _outbox(db, p)} == {"contact@test.example.com"}


async def test_disabled_account_gets_inbox_row_but_no_email(db, email_on):
    p = await _person(db, account_email="off@test.example.com")
    account = await db.get(UserAccount, p.id)
    account.disabled_at = NOW
    await db.flush()
    assert await notify(db, p.id, "report_ready", "Ready") is not None
    assert await notify(db, p.id, "password_expiring", "Expiring", owner_notice=True) is not None
    assert await _outbox(db) == []


async def test_archived_person_gets_inbox_row_but_no_email(db, email_on):
    p = await _person(db)
    p.archived_at = NOW
    await db.flush()
    assert await notify(db, p.id, "report_ready", "Ready") is not None
    assert await notify(db, p.id, "password_expiring", "Expiring", owner_notice=True) is not None
    assert await _outbox(db) == []


# ── kinds and content ───────────────────────────────────────────────

async def test_brief_kind_omits_the_body(db, email_on):
    p = await _person(db)
    await notify(db, p.id, "router_approval", "Router waiting for approval",
                 body="MAC AA:BB:CC secret-detail-xyz", link="/hardware/routers?focus=1")
    [mail] = await _outbox(db, p)
    assert "secret-detail-xyz" not in mail.html_body
    assert "secret-detail-xyz" not in mail.text_body
    assert "/hardware/routers?focus=1" in mail.html_body


async def test_reset_request_card_is_never_emailed(db, email_on):
    p = await _person(db)
    assert await notify(db, p.id, "password_reset_request", "Reset requested") is not None
    assert await _outbox(db) == []


async def test_unregistered_kind_is_inbox_only(db, email_on):
    p = await _person(db)
    assert await notify(db, p.id, "mystery_kind", "Hm") is not None
    assert await _outbox(db) == []


async def test_absolute_link_kept_and_missing_link_goes_to_the_inbox(db, email_on):
    p = await _person(db)
    await notify(db, p.id, "wiki_comment", "New comment",
                 link="https://wiki.example.test/page/1")
    await notify(db, p.id, "wiki_comment", "Another")
    first, second = await _outbox(db, p)
    assert "https://wiki.example.test/page/1" in first.html_body
    assert 'href="https://wiki.example.test/page/1"' in first.html_body
    assert "Open in ServerSherpa: https://wiki.example.test/page/1" in first.text_body
    origin = get_settings().portal_origin.rstrip("/")
    assert f"{origin}/me/notifications" in second.html_body
    assert f"Open in ServerSherpa: {origin}/me/notifications" in second.text_body


async def test_footers(db, email_on):
    p = await _person(db)
    await notify(db, p.id, "report_ready", "Ready")
    await notify(db, p.id, "password_expiring", "Expiring", owner_notice=True)
    plain, sec = await _outbox(db, p)
    prefs_url = f"{get_settings().portal_origin.rstrip('/')}/me/notifications"
    settings_line = "You get these emails from your notification settings."
    assert (f"{settings_line} Change what you receive: {prefs_url}") in plain.text_body
    assert settings_line in plain.html_body
    assert f'Change what you receive: <a href="{prefs_url}"' in plain.html_body
    assert f">{prefs_url}</a>" in plain.html_body
    for body in (plain.text_body, plain.html_body):
        assert "notification groups" not in body
        assert "security notice" not in body
    # the owner's security notice keeps its own footer
    for body in (sec.text_body, sec.html_body):
        assert "This is a security notice about your account." in body
        assert "Change what you receive" not in body
        assert settings_line not in body


async def test_html_escapes_title_and_body(db, email_on):
    p = await _person(db)
    await notify(db, p.id, "report_ready", "<b>x</b>", body="<script>1</script>")
    [mail] = await _outbox(db, p)
    assert "<script>" not in mail.html_body
    assert "&lt;b&gt;x&lt;/b&gt;" in mail.html_body
    assert "&lt;script&gt;" in mail.html_body


# ── delivery log ────────────────────────────────────────────────────

async def test_notify_logs_inbox_written(db):
    p = await _person(db)
    row = await notify(db, p.id, "report_ready", "Ready")
    [entry] = await _log(db, "inbox_written")
    assert entry.channel == "inbox"
    assert (entry.person_id, entry.notification_id) == (p.id, row.id)
    assert (entry.kind, entry.category) == ("report_ready", "reports")
    assert entry.reason is None and entry.outbox_id is None
    # an unregistered kind has no category
    other = await notify(db, p.id, "mystery_kind", "Hm")
    entry = (await _log(db, "inbox_written"))[-1]
    assert (entry.notification_id, entry.kind, entry.category) == (other.id, "mystery_kind", None)


@pytest.mark.parametrize("defaults,prefs,source", [
    pytest.param(None, _prefs(reports="off"), "own", id="own"),
    pytest.param({"reports": {"inbox": False, "email": False}}, {}, "default",
                 id="company-default"),
])
async def test_off_logs_inbox_suppressed(db, email_on, defaults, prefs, source):
    if defaults is not None:
        await _company(db, defaults=defaults)
    p = await _person(db, prefs=prefs)
    assert await notify(db, p.id, "report_ready", "Ready") is None
    [entry] = await _log(db)            # and no email decision: nothing was written
    assert (entry.event, entry.channel) == ("inbox_suppressed", "inbox")
    assert entry.reason == "category_off"
    assert entry.detail == {"source": source}
    assert entry.notification_id is None
    assert (entry.person_id, entry.kind, entry.category) == (p.id, "report_ready", "reports")


@pytest.mark.parametrize("reason,smtp,person_kw,kind,detail", [
    pytest.param("email_not_set_up", False, {}, "report_ready", {}, id="smtp-off"),
    pytest.param("unregistered_kind", True, {}, "mystery_kind", {}, id="unregistered"),
    pytest.param("kind_not_emailed", True, {}, "password_reset_request", {}, id="never-emailed"),
    pytest.param("admin_copy", True, {}, "totp_enrolled", {}, id="admin-copy"),
    pytest.param("category_inbox_only", True, {"prefs": _prefs(reports="inbox")}, "report_ready",
                 {"source": "own"}, id="inbox-only"),
    pytest.param("no_address", True, {"email": None}, "report_ready", {}, id="no-address"),
])
async def test_not_emailed_reasons_are_logged(db, request, reason, smtp, person_kw, kind, detail):
    if smtp:
        request.getfixturevalue("email_on")
    p = await _person(db, **person_kw)
    row = await notify(db, p.id, kind, "Ready")
    assert row is not None
    [entry] = await _log(db, "email_not_queued")
    assert (entry.channel, entry.reason) == ("email", reason)
    assert (entry.person_id, entry.notification_id) == (p.id, row.id)
    info = kind_info(kind)
    assert (entry.kind, entry.category) == (kind, info.category if info else None)
    assert entry.outbox_id is None and entry.detail == detail
    assert await _log(db, "email_queued") == []
    assert await _log(db, "email_held") == []
    assert await _outbox(db) == []


async def test_queued_now_logs_email_queued(db, email_on):
    p = await _person(db)
    row = await notify(db, p.id, "report_ready", "Ready", body="NAP11 finished")
    [mail] = await _outbox(db, p)
    [entry] = await _log(db, "email_queued")
    assert entry.channel == "email" and entry.outbox_id == mail.id
    assert (entry.person_id, entry.notification_id) == (p.id, row.id)
    assert (entry.kind, entry.category) == ("report_ready", "reports")
    assert entry.detail["template"] == "notification"
    assert entry.detail["deferred"] is False
    assert entry.detail["via"] == "contact"
    assert entry.detail["send_at"] == mail.next_attempt_at.isoformat()
    assert set(entry.detail) == {"template", "send_at", "deferred", "via"}   # no `groups`
    # codes and times only: never the address, never the body
    for value in entry.detail.values():
        assert "pat@test.example.com" not in str(value)
        assert "NAP11" not in str(value)
    assert await _log(db, "email_not_queued") == []


@pytest.mark.parametrize("person_kw,kind,owner_notice,via", [
    pytest.param({"account_email": "login@test.example.com"}, "report_ready", False,
                 "contact", id="contact-first"),
    pytest.param({"email": None, "account_email": "acct@test.example.com"}, "report_ready",
                 False, "login", id="no-contact-email-falls-back-to-login"),
    pytest.param({"account_email": "login@test.example.com"}, "password_expiring", True,
                 "login", id="owner-notice-login-first"),
    pytest.param({}, "password_expiring", True, "contact", id="owner-notice-without-login"),
])
async def test_email_queued_names_the_address_source(db, email_on, person_kw, kind,
                                                     owner_notice, via):
    p = await _person(db, **person_kw)
    await notify(db, p.id, kind, "Hello", owner_notice=owner_notice)
    [entry] = await _log(db, "email_queued")
    assert entry.detail["via"] == via


@pytest.mark.parametrize("instant,held,state", [
    pytest.param(_chicago(7, 10), False, "open", id="open-now"),
    pytest.param(_chicago(7, 22), True, "quiet_hours", id="quiet-hours-held"),
    pytest.param(_chicago(8, 5, 30), False, "quiet_hours", id="last-hour-now"),
])
async def test_decide_email_matches_maybe_email(db, email_on, clock, instant, held, state):
    p = await _person(db, prefs=_schedule(days=WEEKDAYS))
    clock(instant)
    await notify(db, p.id, "report_ready", "Ready")
    before = await _log(db)
    # contact=None: decide_email loads the same contact notify() passed along
    decision = await email_mod.decide_email(
        db, p.id, kind_info("report_ready"), owner_notice=False, contact=None,
        company=await load_company_settings(db), now=instant)
    assert (decision.address, decision.address_source) == ("pat@test.example.com", "contact")
    assert (decision.owner_copy, decision.critical) == (False, False)
    assert decision.schedule_state == state
    if held:
        [row] = await _held(db, p)
        [entry] = await _log(db, "email_held")
        assert (decision.queue, decision.hold, decision.send_at) == (False, True, None)
        assert decision.reason == row.reason == entry.reason == state
        assert decision.summary_at.isoformat() == entry.detail["summary_at"]
        assert await _outbox(db) == []
    else:
        [mail] = await _outbox(db, p)
        [entry] = await _log(db, "email_queued")
        assert (decision.queue, decision.hold, decision.summary_at) == (True, False, None)
        assert decision.send_at == mail.next_attempt_at
        assert decision.address == mail.to_address
        assert entry.detail.get("after_summary", False) is decision.after_summary
        assert decision.reason is None
        assert await _held(db, p) == []
    # a decision on its own writes nothing (Check delivery reuses it)
    assert not db.new
    assert await _log(db) == before
