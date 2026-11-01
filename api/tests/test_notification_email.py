"""notify() email: SMTP gate, group rules, personal choices, owner notices,
templates, and the delivery-log rows each decision writes. Assertions read
EmailOutbox and NotificationLog rows; nothing is ever sent."""

from datetime import UTC, datetime, time, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import (
    EmailOutbox,
    Notification,
    NotificationGroup,
    NotificationGroupMember,
    NotificationLog,
    Person,
    UserAccount,
)
from serversherpa.mail import outbox as outbox_mod
from serversherpa.notifications import email as email_mod
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.kinds import kind_info

# A fixed Wednesday, 15:00 UTC, so quiet-hour tests don't depend on the clock.
NOW = datetime(2026, 10, 7, 15, 0, tzinfo=UTC)


@pytest.fixture
def fixed_now(monkeypatch):
    monkeypatch.setattr(email_mod, "_now", lambda: NOW)
    return NOW


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


async def _group(db, person, *, categories=("reports",), member=None, **over):
    g = NotificationGroup(name=f"g-{uuid4()}",
                          categories=list(categories), **over)
    db.add(g)
    await db.flush()
    db.add(NotificationGroupMember(group_id=g.id, person_id=person.id, **(member or {})))
    await db.flush()
    return g


async def _outbox(db, person=None):
    q = select(EmailOutbox).order_by(EmailOutbox.created_at)
    if person is not None:
        q = q.where(EmailOutbox.person_id == person.id)
    return list(await db.scalars(q))


def _prefs(**cats):
    return {"notif": {"categories": cats}}


async def _log(db, event=None):
    q = select(NotificationLog).order_by(NotificationLog.id)
    if event is not None:
        q = q.where(NotificationLog.event == event)
    return list(await db.scalars(q))


# ── gates ───────────────────────────────────────────────────────────

async def test_smtp_off_writes_inbox_only(db):
    p = await _person(db)
    await _group(db, p)
    row = await notify(db, p.id, "report_ready", "Ready", body="b")
    assert row is not None
    assert await _outbox(db) == []


async def test_no_subscribed_group_is_inbox_only(db, email_on):
    p = await _person(db)
    assert await notify(db, p.id, "report_ready", "Ready") is not None
    assert await _outbox(db) == []


async def test_subscribed_group_emails_now(db, email_on):
    p = await _person(db)
    await _group(db, p)
    before = datetime.now(UTC)
    row = await notify(db, p.id, "report_ready", "Move Report is ready",
                       body="NAP11 finished", link="/reports?run=abc")
    [mail] = await _outbox(db, p)
    assert mail.template == "notification"
    assert mail.kind == "report_ready"
    assert mail.notification_id == row.id
    assert mail.to_address == "pat@test.example.com"
    assert mail.subject == "Move Report is ready"
    assert before - timedelta(seconds=5) <= mail.next_attempt_at <= datetime.now(UTC) + timedelta(seconds=5)
    origin = get_settings().portal_origin.rstrip("/")
    assert "NAP11 finished" in mail.html_body and "NAP11 finished" in mail.text_body
    assert f"{origin}/reports?run=abc" in mail.html_body
    assert f"{origin}/reports?run=abc" in mail.text_body
    assert "Hi Pat," in mail.text_body


@pytest.mark.parametrize("over", [
    {"categories": ("wiki",)},
    {"categories": ()},
    {"channels": ["web"]},
    {"enabled": False},
])
async def test_group_not_matching_does_not_email(db, email_on, over):
    p = await _person(db)
    await _group(db, p, **over)
    await notify(db, p.id, "report_ready", "Ready")
    assert await _outbox(db) == []


async def test_member_channel_override_removes_email(db, email_on):
    p = await _person(db)
    await _group(db, p, member={"channels": ["web"]})
    await notify(db, p.id, "report_ready", "Ready")
    assert await _outbox(db) == []


# ── personal choices ────────────────────────────────────────────────

async def test_personal_inbox_choice_skips_email(db, email_on):
    p = await _person(db, prefs=_prefs(reports="inbox"))
    await _group(db, p)
    row = await notify(db, p.id, "report_ready", "Ready")
    assert row is not None
    assert await _outbox(db) == []


async def test_personal_off_writes_nothing_and_returns_none(db, email_on):
    p = await _person(db, prefs=_prefs(reports="off"))
    await _group(db, p)
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


# ── timing ──────────────────────────────────────────────────────────

async def test_quiet_hours_defer(db, email_on, fixed_now):
    p = await _person(db)
    await _group(db, p, timezone="UTC", quiet_start=time(14, 0), quiet_end=time(16, 0),
                 dnd_behavior="defer")
    await notify(db, p.id, "report_ready", "Ready")
    [mail] = await _outbox(db, p)
    assert mail.next_attempt_at == datetime(2026, 10, 7, 16, 0, tzinfo=UTC)


async def test_quiet_hours_skip(db, email_on, fixed_now):
    p = await _person(db)
    await _group(db, p, timezone="UTC", quiet_start=time(14, 0), quiet_end=time(16, 0),
                 dnd_behavior="skip")
    assert await notify(db, p.id, "report_ready", "Ready") is not None
    assert await _outbox(db) == []


async def test_member_override_beats_the_group(db, email_on, fixed_now):
    p = await _person(db)
    await _group(db, p, timezone="UTC", quiet_start=time(14, 0), quiet_end=time(16, 0),
                 dnd_behavior="skip", member={"quiet_mode": "none"})
    await notify(db, p.id, "report_ready", "Ready")
    [mail] = await _outbox(db, p)
    assert mail.next_attempt_at == NOW


async def test_earliest_group_wins(db, email_on, fixed_now):
    p = await _person(db)
    await _group(db, p, timezone="UTC", quiet_start=time(14, 0), quiet_end=time(16, 0))
    await _group(db, p, categories=("reports", "wiki"), timezone="UTC")
    await notify(db, p.id, "report_ready", "Ready")
    [mail] = await _outbox(db, p)
    assert mail.next_attempt_at == NOW


async def test_bad_group_timezone_does_not_crash(db, email_on):
    p = await _person(db)
    await _group(db, p, timezone="Mars/Olympus_Mons")
    assert await notify(db, p.id, "report_ready", "Ready") is not None
    assert len(await _outbox(db, p)) == 1


# ── address ─────────────────────────────────────────────────────────

async def test_falls_back_to_the_account_email(db, email_on):
    p = await _person(db, email=None, account_email="acct@test.example.com")
    await _group(db, p)
    await notify(db, p.id, "report_ready", "Ready")
    [mail] = await _outbox(db, p)
    assert mail.to_address == "acct@test.example.com"


async def test_no_address_no_email(db, email_on):
    p = await _person(db, email=None)
    await _group(db, p)
    assert await notify(db, p.id, "report_ready", "Ready") is not None
    assert await _outbox(db) == []


# ── owner notices ───────────────────────────────────────────────────

async def test_owner_notice_emails_without_a_group(db, email_on):
    p = await _person(db)
    await notify(db, p.id, "password_expiring", "Expiring", owner_notice=True)
    [mail] = await _outbox(db, p)
    assert mail.kind == "password_expiring"


async def test_owner_notice_ignores_quiet_hours(db, email_on, fixed_now):
    p = await _person(db)
    await _group(db, p, categories=("security",), timezone="UTC",
                 quiet_start=time(14, 0), quiet_end=time(16, 0), dnd_behavior="skip",
                 urgent_bypass=False)
    await notify(db, p.id, "password_expiring", "Expiring", owner_notice=True)
    [mail] = await _outbox(db, p)
    assert mail.next_attempt_at == NOW


async def test_admin_copy_follows_groups_not_owner_rule(db, email_on, fixed_now):
    p = await _person(db)
    # no group: the admin copy is inbox only
    await notify(db, p.id, "totp_enrolled", "Someone enrolled")
    assert await _outbox(db) == []
    # in quiet hours with urgent bypass: urgent kinds go now
    await _group(db, p, categories=("security",), timezone="UTC",
                 quiet_start=time(14, 0), quiet_end=time(16, 0), dnd_behavior="skip",
                 urgent_bypass=True)
    await notify(db, p.id, "totp_enrolled", "Someone enrolled")
    [mail] = await _outbox(db, p)
    assert mail.next_attempt_at == NOW


async def test_admin_copy_respects_quiet_hours_without_bypass(db, email_on, fixed_now):
    p = await _person(db)
    await _group(db, p, categories=("security",), timezone="UTC",
                 quiet_start=time(14, 0), quiet_end=time(16, 0), dnd_behavior="skip",
                 urgent_bypass=False)
    await notify(db, p.id, "totp_enrolled", "Someone enrolled")
    assert await _outbox(db) == []


# ── kinds and content ───────────────────────────────────────────────

async def test_brief_kind_omits_the_body(db, email_on):
    p = await _person(db)
    await _group(db, p, categories=("approvals",))
    await notify(db, p.id, "router_approval", "Router waiting for approval",
                 body="MAC AA:BB:CC secret-detail-xyz", link="/hardware/routers?focus=1")
    [mail] = await _outbox(db, p)
    assert "secret-detail-xyz" not in mail.html_body
    assert "secret-detail-xyz" not in mail.text_body
    assert "/hardware/routers?focus=1" in mail.html_body


async def test_reset_request_card_is_never_emailed(db, email_on):
    p = await _person(db)
    await _group(db, p, categories=("approvals",))
    assert await notify(db, p.id, "password_reset_request", "Reset requested") is not None
    assert await _outbox(db) == []


async def test_unregistered_kind_is_inbox_only(db, email_on):
    p = await _person(db)
    await _group(db, p, categories=("reports",))
    assert await notify(db, p.id, "mystery_kind", "Hm") is not None
    assert await _outbox(db) == []


async def test_absolute_link_kept_and_missing_link_goes_to_the_inbox(db, email_on):
    p = await _person(db)
    await _group(db, p, categories=("wiki",))
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
    await _group(db, p, categories=("reports", "security"))
    await notify(db, p.id, "report_ready", "Ready")
    await notify(db, p.id, "password_expiring", "Expiring", owner_notice=True)
    plain, sec = await _outbox(db, p)
    assert "Change what you receive" in plain.html_body
    assert "Change what you receive" in plain.text_body
    assert "security notice" not in plain.html_body
    assert "This is a security notice about your account." in sec.html_body
    assert "This is a security notice about your account." in sec.text_body
    assert "Change what you receive" not in sec.html_body


async def test_html_escapes_title_and_body(db, email_on):
    p = await _person(db)
    await _group(db, p)
    await notify(db, p.id, "report_ready", "<b>x</b>", body="<script>1</script>")
    [mail] = await _outbox(db, p)
    assert "<script>" not in mail.html_body
    assert "&lt;b&gt;x&lt;/b&gt;" in mail.html_body
    assert "&lt;script&gt;" in mail.html_body


async def test_admin_copy_gets_the_group_footer_owner_copy_the_security_one(db, email_on):
    owner = await _person(db, "owner@test.example.com", first="Olive")
    admin = await _person(db, "admin@test.example.com", first="Adam")
    await _group(db, admin, categories=("security",))
    await notify(db, owner.id, "totp_enrolled", "Two-factor is on", owner_notice=True)
    await notify(db, admin.id, "totp_enrolled", "Olive enrolled two-factor")
    [own] = await _outbox(db, owner)
    [adm] = await _outbox(db, admin)
    assert "This is a security notice about your account." in own.html_body
    assert "Change what you receive" not in own.html_body
    assert "Change what you receive" in adm.html_body
    assert "Change what you receive" in adm.text_body
    assert "security notice" not in adm.html_body


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
    await _group(db, p, categories=("security",))
    await notify(db, p.id, "totp_enrolled", "Olive enrolled two-factor")
    await notify(db, p.id, "password_expiring", "Expiring")   # not an owner notice
    assert {m.to_address for m in await _outbox(db, p)} == {"contact@test.example.com"}


async def test_disabled_account_gets_inbox_row_but_no_email(db, email_on):
    p = await _person(db, account_email="off@test.example.com")
    await _group(db, p)
    account = await db.get(UserAccount, p.id)
    account.disabled_at = NOW
    await db.flush()
    assert await notify(db, p.id, "report_ready", "Ready") is not None
    assert await notify(db, p.id, "password_expiring", "Expiring", owner_notice=True) is not None
    assert await _outbox(db) == []


async def test_archived_person_gets_inbox_row_but_no_email(db, email_on):
    p = await _person(db)
    await _group(db, p)
    p.archived_at = NOW
    await db.flush()
    assert await notify(db, p.id, "report_ready", "Ready") is not None
    assert await notify(db, p.id, "password_expiring", "Expiring", owner_notice=True) is not None
    assert await _outbox(db) == []


# ── delivery log ────────────────────────────────────────────────────

QUIET_DEFER = {"timezone": "UTC", "quiet_start": time(14, 0), "quiet_end": time(16, 0),
               "dnd_behavior": "defer"}
QUIET_SKIP = {**QUIET_DEFER, "dnd_behavior": "skip"}


@pytest.fixture
def queue_clock(monkeypatch):
    """enqueue() decides `deferred` against its own clock: pin it to NOW too."""
    monkeypatch.setattr(outbox_mod, "_now", lambda: NOW)
    return NOW


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


async def test_off_logs_inbox_suppressed(db, email_on):
    p = await _person(db, prefs=_prefs(reports="off"))
    await _group(db, p)
    assert await notify(db, p.id, "report_ready", "Ready") is None
    [entry] = await _log(db)            # and no email decision: nothing was written
    assert (entry.event, entry.channel) == ("inbox_suppressed", "inbox")
    assert entry.reason == "category_off"
    assert entry.notification_id is None
    assert (entry.person_id, entry.kind, entry.category) == (p.id, "report_ready", "reports")


@pytest.mark.parametrize("reason,smtp,person_kw,group_kw", [
    pytest.param("email_not_set_up", False, {}, {}, id="smtp-off"),
    pytest.param("no_email_group", True, {}, None, id="no-group"),
    pytest.param("category_inbox_only", True, {"prefs": _prefs(reports="inbox")}, {},
                 id="inbox-only"),
    pytest.param("no_address", True, {"email": None}, {}, id="no-address"),
    pytest.param("blocked_by_schedule", True, {}, QUIET_SKIP, id="skip-in-quiet-hours"),
])
async def test_not_emailed_reasons_are_logged(db, request, fixed_now, reason, smtp,
                                              person_kw, group_kw):
    if smtp:
        request.getfixturevalue("email_on")
    p = await _person(db, **person_kw)
    if group_kw is not None:
        await _group(db, p, **group_kw)
    row = await notify(db, p.id, "report_ready", "Ready")
    assert row is not None
    [entry] = await _log(db, "email_not_queued")
    assert (entry.channel, entry.reason) == ("email", reason)
    assert (entry.person_id, entry.notification_id) == (p.id, row.id)
    assert (entry.kind, entry.category) == ("report_ready", "reports")
    assert entry.outbox_id is None and entry.detail == {}
    assert await _log(db, "email_queued") == []
    assert await _outbox(db) == []


async def test_queued_now_logs_email_queued(db, email_on):
    p = await _person(db)
    g = await _group(db, p)
    row = await notify(db, p.id, "report_ready", "Ready", body="NAP11 finished")
    [mail] = await _outbox(db, p)
    [entry] = await _log(db, "email_queued")
    assert entry.channel == "email" and entry.outbox_id == mail.id
    assert (entry.person_id, entry.notification_id) == (p.id, row.id)
    assert (entry.kind, entry.category) == ("report_ready", "reports")
    assert entry.detail["template"] == "notification"
    assert entry.detail["deferred"] is False
    assert "reason" not in entry.detail
    assert entry.detail["groups"] == [g.name]
    assert entry.detail["via"] == "contact"
    assert entry.detail["send_at"] == mail.next_attempt_at.isoformat()
    # codes, times and names only: never the address, never the body
    for value in entry.detail.values():
        assert "pat@test.example.com" not in str(value)
        assert "NAP11" not in str(value)
    assert await _log(db, "email_not_queued") == []


async def test_deferred_logs_the_reason_and_group(db, email_on, fixed_now, queue_clock):
    p = await _person(db)
    g = await _group(db, p, **QUIET_DEFER)
    await notify(db, p.id, "report_ready", "Ready")
    [mail] = await _outbox(db, p)
    assert mail.next_attempt_at == datetime(2026, 10, 7, 16, 0, tzinfo=UTC)
    [entry] = await _log(db, "email_queued")
    assert entry.outbox_id == mail.id
    assert entry.detail["deferred"] is True
    assert entry.detail["reason"] == "quiet_hours"
    assert g.name in entry.detail["groups"]
    assert entry.detail["send_at"] == mail.next_attempt_at.isoformat()


async def test_logged_groups_are_the_ones_that_set_the_time(db, email_on, fixed_now):
    # One group lets the email go now, the other would hold it until 16:00:
    # it goes now, so only the first one is named.
    p = await _person(db)
    open_now = await _group(db, p, timezone="UTC")
    await _group(db, p, **QUIET_DEFER)
    await notify(db, p.id, "report_ready", "Ready")
    [entry] = await _log(db, "email_queued")
    assert entry.detail["groups"] == [open_now.name]
    assert "reason" not in entry.detail


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
    await _group(db, p)
    await notify(db, p.id, kind, "Hello", owner_notice=owner_notice)
    [entry] = await _log(db, "email_queued")
    assert entry.detail["via"] == via


@pytest.mark.parametrize("over,verdict,reason", [
    pytest.param({}, "open", None, id="now"),
    pytest.param(QUIET_DEFER, "quiet_hours", "quiet_hours", id="deferred"),
])
async def test_decide_email_matches_maybe_email(db, email_on, fixed_now, over, verdict,
                                                reason):
    p = await _person(db)
    g = await _group(db, p, **over)
    await notify(db, p.id, "report_ready", "Ready")
    [mail] = await _outbox(db, p)
    before = await _log(db)
    decision = await email_mod.decide_email(
        db, p.id, kind_info("report_ready"), owner_notice=False, choice="email",
        contact=None, now=NOW)
    assert decision.queue is True
    assert decision.send_at == mail.next_attempt_at
    assert decision.address == mail.to_address
    assert (decision.reason, decision.address_source, decision.owner_copy) == (
        reason, "contact", False)
    assert [(v.group_id, v.name, v.verdict, v.allowed_at) for v in decision.groups] == [
        (g.id, g.name, verdict, mail.next_attempt_at)]
    # a decision on its own writes nothing (Check delivery reuses it)
    assert not db.new
    assert await _log(db) == before
