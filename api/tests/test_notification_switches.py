"""notifications/email.py effective_switches(): what a person's own Inbox and
Email switches and the company defaults make of one notification kind, the
three-state personal_choice() derived from it, and how notify(), the delivery
check and the send-time re-check use the answer.

Spec: docs/superpowers/specs/2026-11-01-notifications-phase1-design.md (section 1)"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select

from serversherpa.api.schemas import UiPreferences
from serversherpa.db.models import (
    EmailOutbox,
    Notification,
    NotificationLog,
    Person,
    SystemConfig,
    UserAccount,
)
from serversherpa.notifications import company, kinds
from serversherpa.notifications.check import check_delivery
from serversherpa.notifications.company import (
    CONFIGURABLE_CATEGORIES,
    CompanySettings,
    Switches,
    load_company_settings,
)
from serversherpa.notifications.email import (
    Contact,
    EffectiveSwitches,
    effective_switches,
    load_contact,
    personal_choice,
    recheck_before_send,
)
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.kinds import kind_info

NOW = datetime(2026, 10, 7, 15, 0, tzinfo=UTC)

REPORT = kind_info("report_ready")          # reports
WIKI = kind_info("wiki_comment")            # wiki
SECURITY = kind_info("totp_enrolled")       # account security


def _company(**over: Switches) -> CompanySettings:
    """Every configurable category on and on, except the ones given."""
    defaults = {category: Switches(True, True) for category in CONFIGURABLE_CATEGORIES}
    return CompanySettings(defaults={**defaults, **over}, critical_kinds=frozenset())


def _contact(**own: dict) -> Contact:
    """A recipient whose own switches are `own` (category=override)."""
    prefs = UiPreferences.model_validate({"notif": {"switches": own}})
    return Contact("Pat", "pat@test.example.com", prefs)


async def _person(db, prefs=None) -> Person:
    """A person; with `prefs` they also have an account holding them."""
    person = Person(first_name="Pat", last_name="Tester", email="pat@test.example.com")
    db.add(person)
    await db.flush()
    if prefs is not None:
        db.add(UserAccount(person_id=person.id, email=f"acct-{person.id.hex[:8]}@test.example.com",
                           password_hash="x", ui_prefs=prefs))
        await db.flush()
    return person


async def _set_company_defaults(db, **defaults: dict) -> None:
    db.add(SystemConfig(section="notifications", data={"defaults": defaults}))
    await db.flush()


# ── effective_switches ──────────────────────────────────────────────

async def test_defaults_apply_without_prefs(db):
    person = await _person(db)                      # no account, so no prefs at all
    contact = await load_contact(db, person.id)
    company_settings = await load_company_settings(db)
    assert effective_switches(REPORT, contact, company_settings) == EffectiveSwitches(
        True, True, "default", "default")


def test_own_inbox_off_turns_email_off():
    sw = effective_switches(REPORT, _contact(reports={"inbox": False}), _company())
    assert (sw.inbox, sw.email) == (False, False)
    assert (sw.inbox_source, sw.email_source) == ("own", "default")


def test_company_default_email_off():
    company_settings = _company(wiki=Switches(True, False))

    follows = effective_switches(WIKI, _contact(), company_settings)
    assert follows == EffectiveSwitches(True, False, "default", "default")

    chose = effective_switches(WIKI, _contact(wiki={"email": True}), company_settings)
    assert chose == EffectiveSwitches(True, True, "default", "own")

    # a missing contact counts as no own values
    assert effective_switches(WIKI, None, company_settings) == follows


def test_company_default_inbox_off_turns_its_email_off_too():
    company_settings = _company(reports=Switches(False, True))

    assert effective_switches(REPORT, _contact(), company_settings) == EffectiveSwitches(
        False, False, "default", "default")
    # the person's own Inbox on beats the default, and Email follows the default (on)
    assert effective_switches(REPORT, _contact(reports={"inbox": True}),
                              company_settings) == EffectiveSwitches(True, True, "own", "default")


def test_security_is_fixed():
    fixed = EffectiveSwitches(True, True, "fixed", "fixed")
    # the company defaults hold no security entry (and a stored one is dropped on read),
    # so the answer comes before the defaults are consulted
    assert "security" not in _company().defaults
    assert effective_switches(SECURITY, _contact(), _company()) == fixed
    assert effective_switches(SECURITY, None, _company()) == fixed
    # a kind the registry does not list is inbox-only and never switched off
    assert effective_switches(None, _contact(wiki={"inbox": False}), _company()) == fixed


def test_own_value_equal_to_default_stays_own():
    """A person's value is theirs even when it equals the default; only
    a later change of the default shows the difference."""
    company_settings = _company(wiki=Switches(True, False))
    sw = effective_switches(WIKI, _contact(wiki={"email": False}), company_settings)
    assert (sw.email, sw.email_source) == (False, "own")
    # the admin turns Wiki Email back on: this person's own "off" still holds
    later = effective_switches(WIKI, _contact(wiki={"email": False}), _company())
    assert (later.email, later.email_source) == (False, "own")


def test_each_category_uses_its_own_values():
    contact = _contact(reports={"email": False}, wiki={"inbox": False})
    company_settings = _company()
    assert effective_switches(REPORT, contact, company_settings) == EffectiveSwitches(
        True, False, "default", "own")
    assert effective_switches(WIKI, contact, company_settings) == EffectiveSwitches(
        False, False, "own", "default")
    assert effective_switches(kind_info("learning_complete"), contact,
                              company_settings) == EffectiveSwitches(
        True, True, "default", "default")


def test_every_category_but_security_has_a_company_default():
    """effective_switches indexes the defaults by category, so a category added to
    the registry but not to the company defaults must fail here, not as a KeyError
    inside notify()."""
    assert set(kinds.CATEGORY_KEYS) - {"security"} == set(company.CONFIGURABLE_CATEGORIES)


# ── personal_choice (the three states the email decision still works in) ──

@pytest.mark.parametrize("own,expected", [
    ({}, "email"),
    ({"email": False}, "inbox"),
    ({"inbox": False}, "off"),
    ({"inbox": False, "email": True}, "off"),
    ({"inbox": True, "email": False}, "inbox"),
    ({"inbox": True, "email": True}, "email"),
])
def test_personal_choice_mapping(own, expected):
    assert personal_choice(REPORT, _contact(reports=own), _company()) == expected


@pytest.mark.parametrize("default,expected", [
    (Switches(True, True), "email"),
    (Switches(True, False), "inbox"),
    (Switches(False, False), "off"),
    (Switches(False, True), "off"),
])
def test_personal_choice_follows_the_company_default(default, expected):
    assert personal_choice(REPORT, _contact(), _company(reports=default)) == expected
    assert personal_choice(REPORT, None, _company(reports=default)) == expected


def test_personal_choice_is_email_for_security_and_unregistered_kinds():
    off = _company(**{c: Switches(False, False) for c in CONFIGURABLE_CATEGORIES})
    assert personal_choice(SECURITY, _contact(), off) == "email"
    assert personal_choice(None, _contact(), off) == "email"


# ── the places that use it ──────────────────────────────────────────

async def test_notify_suppresses_inbox_when_inbox_off(db, seeded_user):
    account = await db.get(UserAccount, seeded_user.id)
    account.ui_prefs = {"notif": {"switches": {"reports": {"inbox": False}}}}
    await db.commit()

    assert await notify(db, seeded_user.id, "report_ready", "Hidden") is None
    await db.commit()

    [row] = (await db.scalars(select(NotificationLog))).all()
    assert (row.event, row.channel, row.reason) == ("inbox_suppressed", "inbox", "category_off")
    assert (row.person_id, row.kind, row.category) == (seeded_user.id, "report_ready", "reports")
    assert await db.scalar(select(Notification.id)) is None


async def test_notify_keeps_inbox_when_only_email_is_off(db, seeded_user):
    account = await db.get(UserAccount, seeded_user.id)
    account.ui_prefs = {"notif": {"switches": {"reports": {"email": False}}}}
    await db.commit()
    assert await notify(db, seeded_user.id, "report_ready", "Shown") is not None


async def test_notify_follows_the_company_default(db, seeded_user):
    await _set_company_defaults(db, wiki={"inbox": False, "email": False})
    await db.commit()

    assert await notify(db, seeded_user.id, "wiki_comment", "Hidden") is None
    assert await notify(db, seeded_user.id, "report_ready", "Shown") is not None

    # the person's own Inbox on beats the default
    account = await db.get(UserAccount, seeded_user.id)
    account.ui_prefs = {"notif": {"switches": {"wiki": {"inbox": True}}}}
    await db.commit()
    assert await notify(db, seeded_user.id, "wiki_comment", "Shown too") is not None


async def test_check_delivery_reports_the_choice_the_switches_make(db, seeded_user):
    await _set_company_defaults(db, wiki={"inbox": True, "email": False},
                                reports={"inbox": False, "email": False})
    await db.commit()

    reports = await check_delivery(db, seeded_user.id, "report_ready", now=NOW)
    assert (reports["choice"], reports["inbox"]) == ("off", "suppressed")
    wiki = await check_delivery(db, seeded_user.id, "wiki_comment", now=NOW)
    assert (wiki["choice"], wiki["inbox"]) == ("inbox", "written")
    learning = await check_delivery(db, seeded_user.id, "learning_complete", now=NOW)
    assert (learning["choice"], learning["inbox"]) == ("email", "written")


async def _queued_report_mail(db, person) -> EmailOutbox:
    note = Notification(person_id=person.id, kind="report_ready", title="Ready")
    db.add(note)
    await db.flush()
    mail = EmailOutbox(template="notification", to_address="pat@test.example.com",
                       person_id=person.id, kind="report_ready", notification_id=note.id,
                       subject="Ready", html_body="h", text_body="t")
    db.add(mail)
    await db.flush()
    return mail


async def test_recheck_before_send_follows_the_company_default(db, seeded_user):
    mail = await _queued_report_mail(db, seeded_user)
    await _set_company_defaults(db, reports={"inbox": True, "email": False})

    assert await recheck_before_send(db, mail) == "category_turned_down"

    # the person's own Email on wins over the default: the choice no longer turns it down
    account = await db.get(UserAccount, seeded_user.id)
    account.ui_prefs = {"notif": {"switches": {"reports": {"email": True}}}}
    await db.flush()
    assert await recheck_before_send(db, mail) != "category_turned_down"


async def test_an_unloadable_stored_zone_does_not_hide_the_persons_switches(db):
    """A zone that stops loading only touches the schedule (which falls back to
    the reference zone when used): the person's own switches still apply."""
    person = await _person(db, prefs={"notif": {"switches": {"reports": {"inbox": False}},
                                                "schedule": {"timezone": "Not/AZone"}}})
    contact = await load_contact(db, person.id)
    assert effective_switches(REPORT, contact, _company()) == EffectiveSwitches(
        False, False, "own", "default")


async def test_unreadable_stored_prefs_behave_as_defaults(db):
    """A stored blob that no longer parses (here an empty days list) must not
    stop notify(): the recipient follows the defaults."""
    person = await _person(db, prefs={"notif": {"switches": {"reports": {"inbox": False}},
                                                "schedule": {"days": []}}})
    contact = await load_contact(db, person.id)
    assert contact is not None
    assert effective_switches(REPORT, contact, _company()) == EffectiveSwitches(
        True, True, "default", "default")
