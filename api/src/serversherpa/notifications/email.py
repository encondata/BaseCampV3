"""Email delivery for in-app notifications: decides whether a notification
that `notify()` just wrote also goes out by email, and when, then queues it
in the mail outbox (or holds it for the person's summary) and records the
decision in the delivery log. Adds to the caller's session — never commits.

What reaches a person is decided by their own switches, which start from the
company defaults (notifications/company.py); when, by their own schedule
(notifications/schedule.py). A critical kind skips the schedule but still
obeys the switches. Notification groups play no part
(docs/superpowers/specs/2026-11-01-notifications-phase1-design.md, sections 1,
4, 5 and 7). The decision itself is one function, `decide_email()`, shared by
`maybe_email()` and the read-only Check delivery tool so the two cannot drift
(docs/superpowers/specs/2026-10-31-notifications-phase0-design.md, section 9).
`recheck_before_send()` is the other half: the delivery worker asks it, just
before sending, whether a queued email is still wanted (same spec, section 4);
`recheck_notification()` is the part of it the summary sweep shares. For a
notification the event sweep wrote it also asks whether the person can still
open what it is about and is still reached by a watch or a group
(event_sweep.watch_recheck; phase 2 spec, section 4)."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.schemas import UiPreferences
from serversherpa.config import get_settings
from serversherpa.db.models import EmailOutbox, Notification, Person, UserAccount
from serversherpa.mail.outbox import email_enabled, enqueue
from serversherpa.notifications.company import (
    CompanySettings,
    is_critical,
    load_company_settings,
)
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.held import hold_email
from serversherpa.notifications.kinds import KINDS, KindInfo, kind_info
from serversherpa.notifications.schedule import (
    Schedule,
    hold_decision,
    schedule_from_prefs,
    state_at,
)

INBOX_PATH = "/me/notifications"


@dataclass(frozen=True)
class Contact:
    """What notify() needs to know about the recipient, loaded in one query."""
    first_name: str
    address: str | None     # Person.email, else the account's email
    choice_prefs: UiPreferences
    active: bool = True     # False: archived person or disabled account
    login_email: str | None = None   # the account's email (owner notices go here first)
    contact_email: str | None = None  # Person.email alone (None: `address` is the login email)


@dataclass(frozen=True)
class EffectiveSwitches:
    """The Inbox and Email switches a person actually has for one kind, and
    where each value comes from: "default" (the company default, which the
    person follows until they change it), "own" (the person set it, even to
    the same value as the default) or "fixed" (account security, which nobody
    switches off)."""
    inbox: bool
    email: bool
    inbox_source: str
    email_source: str


@dataclass(frozen=True)
class EmailDecision:
    """Whether, when and where one notification goes out by email, and why.

    One of three outcomes: `queue` (sent now; `send_at` is that instant),
    `hold` (held for the person's summary; `summary_at` is when it is due), or
    neither (not sent). `reason` is the not-sent code, or for a held email the
    schedule state that holds it (quiet_hours / inactive_day); None when sent
    now. `address_source` is where the address came from: "contact" (the
    person's email) or "login" (the account's).

    `owner_copy` marks the account owner's own security notice. `critical`
    marks an email sent now because its kind is critical, and `after_summary`
    one sent now in the last hour before the person is back online (that
    morning's summary has already gone). `switches` are the recipient's
    effective switches and `schedule_state` their schedule's state at the
    decision time, each set once the decision got as far as reading it."""
    queue: bool
    hold: bool
    send_at: datetime | None
    summary_at: datetime | None
    reason: str | None
    address: str | None
    address_source: str | None
    owner_copy: bool
    critical: bool
    after_summary: bool
    switches: EffectiveSwitches | None
    schedule_state: str | None


def _now() -> datetime:
    """The clock for send-time decisions (a seam for tests)."""
    return datetime.now(UTC)


def portal_link(path: str) -> str:
    """Absolute portal URL. (Same join as services/password_reset.portal_url,
    which can't be imported here: it reaches totp, which reaches notify().)"""
    return f"{get_settings().portal_origin.rstrip('/')}{path}"


def _absolute(link: str | None) -> str:
    if not link:
        return portal_link(INBOX_PATH)
    if link.lower().startswith(("http://", "https://")):
        return link
    return portal_link(link if link.startswith("/") else f"/{link}")


async def load_contact(db: AsyncSession, person_id: uuid.UUID) -> Contact | None:
    row = (await db.execute(
        select(Person.first_name, Person.email, UserAccount.email, UserAccount.ui_prefs,
               Person.archived_at, UserAccount.disabled_at)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(Person.id == person_id))).first()
    if row is None:
        return None
    first_name, person_email, account_email, raw_prefs, archived_at, disabled_at = row
    try:
        prefs = UiPreferences.model_validate(raw_prefs or {})
    except ValueError:      # malformed stored prefs: behave as defaults
        prefs = UiPreferences()
    return Contact(first_name, person_email or account_email or None, prefs,
                   login_email=account_email or None,
                   contact_email=person_email or None,
                   active=archived_at is None and disabled_at is None)


def effective_switches(info: KindInfo | None, contact: Contact | None,
                       company: CompanySettings) -> EffectiveSwitches:
    """The recipient's switches for this kind: their own value where they set
    one, else the company default. Email needs Inbox: it is on only when the
    person's Email value (own, else default) is on and Inbox is on too. Account
    security and a kind the registry does not list (inbox-only, never emailed)
    are fixed on and on, answered before the defaults are consulted: they hold
    no entry for either. A recipient with no contact has no values of their own."""
    if info is None or info.category == "security":
        return EffectiveSwitches(True, True, "fixed", "fixed")
    default = company.defaults[info.category]
    own = (contact.choice_prefs.notif.switches.get(info.category)
           if contact is not None else None)
    own_inbox = own.inbox if own is not None else None
    own_email = own.email if own is not None else None
    inbox = default.inbox if own_inbox is None else own_inbox
    email = default.email if own_email is None else own_email
    return EffectiveSwitches(
        inbox=inbox, email=email and inbox,
        inbox_source="default" if own_inbox is None else "own",
        email_source="default" if own_email is None else "own")


def contact_schedule(contact: Contact | None) -> Schedule:
    """The recipient's schedule. A person without an account has the default
    preferences, and so the open schedule; so does a recipient with no
    contact. A stored zone that no longer loads reads as the reference zone."""
    return schedule_from_prefs(
        contact.choice_prefs.notif.schedule.model_dump() if contact is not None else None)


def _kind_name(info: KindInfo) -> str | None:
    """The registry key of a registered KindInfo, which does not carry its own
    name (is_critical() and the company's critical list go by name). Matched
    by identity: every caller passes the registry's own object."""
    return next((kind for kind, entry in KINDS.items() if entry is info), None)


def _address(contact: Contact, owner_copy: bool) -> tuple[str | None, str | None]:
    """The address an email goes to, and where it came from."""
    # An owner security notice goes to the login email first: whoever can
    # edit a person's contact email must not receive that person's security
    # notices. Everything else keeps the contact email first.
    if owner_copy and contact.login_email:
        return contact.login_email, "login"
    if not contact.address:
        return None, None
    return contact.address, ("contact" if contact.contact_email else "login")


def _not_sent(reason: str, owner_copy: bool, *,
              switches: EffectiveSwitches | None = None) -> EmailDecision:
    return EmailDecision(queue=False, hold=False, send_at=None, summary_at=None,
                         reason=reason, address=None, address_source=None,
                         owner_copy=owner_copy, critical=False, after_summary=False,
                         switches=switches, schedule_state=None)


async def decide_email(db: AsyncSession, person_id: uuid.UUID, info: KindInfo | None, *,
                       owner_notice: bool, contact: Contact | None,
                       company: CompanySettings, now: datetime) -> EmailDecision:
    """Whether a notification of kind `info` for this person goes out by email
    now, is held for their summary, or is not sent, where to, and why. The
    caller passes the company settings and, normally, the contact (it is
    loaded when None is passed). Writes nothing, so the Check delivery tool
    can ask it too."""
    decision, _ = await _decide(db, person_id, info, owner_notice=owner_notice,
                                contact=contact, company=company, now=now)
    return decision


async def _decide(db: AsyncSession, person_id: uuid.UUID, info: KindInfo | None, *,
                  owner_notice: bool, contact: Contact | None, company: CompanySettings,
                  now: datetime) -> tuple[EmailDecision, Contact | None]:
    """decide_email(), plus the contact it used, so maybe_email() never loads
    it twice. The checks run in order and the first that fails decides."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    owner_copy = bool(owner_notice and info is not None and info.owner_always)
    if not email_enabled():
        return _not_sent("email_not_set_up", owner_copy), contact
    if info is None:
        return _not_sent("unregistered_kind", owner_copy), contact
    if not info.email:
        return _not_sent("kind_not_emailed", owner_copy), contact
    if info.category == "security" and not owner_copy:
        # Someone else's copy of an account-security notice stays in their
        # inbox: totp_enrolled reaches everyone who can manage users, and an
        # email to each of them on every enrollment could not be switched off.
        return _not_sent("admin_copy", owner_copy), contact
    if contact is None:
        contact = await load_contact(db, person_id)
    switches = effective_switches(info, contact, company)
    if not switches.inbox:
        return _not_sent("category_off", owner_copy, switches=switches), contact
    if not switches.email:
        return _not_sent("category_inbox_only", owner_copy, switches=switches), contact
    if contact is None or not contact.active:
        return _not_sent("recipient_inactive", owner_copy, switches=switches), contact
    address, source = _address(contact, owner_copy)
    if address is None:
        return _not_sent("no_address", owner_copy, switches=switches), contact

    def send_now(*, critical: bool = False, after_summary: bool = False,
                 schedule_state: str | None = None) -> EmailDecision:
        return EmailDecision(queue=True, hold=False, send_at=now.astimezone(UTC),
                             summary_at=None, reason=None, address=address,
                             address_source=source, owner_copy=owner_copy,
                             critical=critical, after_summary=after_summary,
                             switches=switches, schedule_state=schedule_state)

    if owner_copy:      # the owner's own security notice: now, whatever the schedule
        return send_now(), contact
    kind = _kind_name(info)
    if kind is not None and is_critical(kind, company):     # skips the schedule only
        return send_now(critical=True), contact
    schedule = contact_schedule(contact)
    state = state_at(schedule, now)
    held = hold_decision(schedule, now)
    if not held.hold:
        return send_now(after_summary=held.after_summary, schedule_state=state), contact
    return EmailDecision(queue=False, hold=True, send_at=None, summary_at=held.summary_at,
                         reason=held.reason, address=address, address_source=source,
                         owner_copy=owner_copy, critical=False, after_summary=False,
                         switches=switches, schedule_state=state), contact


def _not_queued_detail(decision: EmailDecision) -> dict | None:
    """For a switch that turned the email down, where its value came from: the
    person's own or the company default (Inbox for category_off, Email for
    category_inbox_only). Nothing for the other reasons."""
    if decision.reason == "category_off":
        return {"source": decision.switches.inbox_source}
    if decision.reason == "category_inbox_only":
        return {"source": decision.switches.email_source}
    return None


async def maybe_email(db: AsyncSession, notification: Notification, *,
                      info: KindInfo | None, owner_notice: bool, contact: Contact | None,
                      company: CompanySettings) -> None:
    """Queue the notification email now, hold it for the person's summary, or
    neither, as decide_email() says. Either way the decision lands in the
    delivery log: `email_queued` (written by enqueue()), `email_held`
    (hold_email()) or `email_not_queued` with the reason."""
    now = _now()
    decision, contact = await _decide(
        db, notification.person_id, info, owner_notice=owner_notice, contact=contact,
        company=company, now=now)
    if decision.hold:
        hold_email(db, notification, info=info, reason=decision.reason,
                   summary_at=decision.summary_at, held_at=now.astimezone(UTC))
        return
    if not decision.queue:
        record(db, "email_not_queued", channel="email", person_id=notification.person_id,
               notification_id=notification.id, kind=notification.kind,
               category=info.category if info else None, reason=decision.reason,
               detail=_not_queued_detail(decision))
        return
    # Codes only, and only those that are set: never the address, only where
    # it came from.
    log_detail = {key: value for key, value in (
        ("via", decision.address_source), ("critical", decision.critical),
        ("owner_copy", decision.owner_copy), ("after_summary", decision.after_summary))
        if value}
    await enqueue(
        db, "notification", decision.address, person_id=notification.person_id,
        kind=notification.kind, notification_id=notification.id,
        send_at=None, log_detail=log_detail,
        name=contact.first_name, title=notification.title,
        body="" if info.brief else notification.body,
        link=_absolute(notification.link),
        security=decision.owner_copy,
        prefs_url=portal_link(INBOX_PATH))


async def recheck_notification(db: AsyncSession, notification: Notification | None,
                               info: KindInfo | None, contact: Contact | None,
                               company: CompanySettings) -> str | None:
    """Why the email of a notification decided earlier should no longer go
    out, as a reason code, or None when it still should. Asked of a queued
    email by the delivery worker (recheck_before_send) and of a held one by
    the summary sweep: meanwhile the person may have read or hidden the inbox
    row, an admin may have decided the approval, the person may have lost
    access to what an event was about or stopped being reached by it, or the
    person's switches or the company defaults may have changed. The checks run
    in order and the first that fails decides: notification_gone, resolved,
    hidden, read, recipient_inactive, no_access and not_watching (only a
    notification the event sweep wrote can fail those two), then
    category_turned_down (the effective Email switch is now off). `contact` is
    the recipient, loaded when None is passed. Timing is not re-computed.
    Writes nothing.

    `resolved` comes before `hidden` and `read` because deciding an approval
    marks every copy of it read: the log must name the decision, not a read
    nobody did."""
    if notification is None:
        return "notification_gone"
    state = notification.payload.get("state")
    if state is not None and state not in ("pending", "open"):
        return "resolved"      # an approval someone already decided
    if notification.dismissed_at is not None:
        return "hidden"
    if notification.read_at is not None:
        return "read"
    if contact is None:
        contact = await load_contact(db, notification.person_id)
    if contact is None or not contact.active:
        return "recipient_inactive"
    # Imported here: the event sweep reaches notify(), which reaches this module.
    from serversherpa.notifications.event_sweep import watch_recheck
    reason = await watch_recheck(db, notification)
    if reason is not None:
        return reason
    if not effective_switches(info, contact, company).email:
        return "category_turned_down"
    return None


async def recheck_before_send(db: AsyncSession, row: EmailOutbox) -> str | None:
    """Why this queued notification email should no longer go out, as a reason
    code, or None when it still should: recheck_notification() for the inbox
    row it mirrors. The delivery worker asks just before sending. Reads only.

    Never re-checked (None at once): mail that mirrors no notification
    (`row.kind` is None: password resets, invites, learning), a kind the
    registry does not list, and account-security kinds, owner and admin copies
    alike: whoever can read or hide the inbox item must not be able to
    suppress that email."""
    if row.kind is None:
        return None
    info = kind_info(row.kind)
    if info is None or info.category == "security":
        return None
    notification = (await db.get(Notification, row.notification_id)
                    if row.notification_id else None)
    return await recheck_notification(db, notification, info, None,
                                      await load_company_settings(db))
