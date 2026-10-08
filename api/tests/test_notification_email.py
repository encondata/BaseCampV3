"""notify() email: SMTP gate, group rules, personal choices, owner notices,
templates. Assertions read EmailOutbox rows; nothing is ever sent."""

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
    Person,
    UserAccount,
)
from serversherpa.notifications import email as email_mod
from serversherpa.notifications.inbox import notify

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
    assert "&lt;script&gt;" in mail.html_body
