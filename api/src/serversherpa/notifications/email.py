"""Email delivery for in-app notifications: decides whether a notification
that `notify()` just wrote also goes out by email, and when, then queues it
in the mail outbox and records the decision in the delivery log. Adds to
the caller's session — never commits.

The rule lives in docs/superpowers/specs/2026-10-08-notification-email-design.md
("Sending rule"); the pure timing part is notifications/email_rule.py. The
decision itself is one function, `decide_email()`, shared by `maybe_email()`
and the read-only Check delivery tool so the two cannot drift
(docs/superpowers/specs/2026-10-31-notifications-phase0-design.md, section 9)."""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.schemas import UiPreferences
from serversherpa.config import get_settings
from serversherpa.db.models import (
    Notification,
    NotificationGroup,
    NotificationGroupMember,
    Person,
    UserAccount,
)
from serversherpa.mail.outbox import email_enabled, enqueue
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.email_rule import group_verdict
from serversherpa.notifications.kinds import KindInfo
from serversherpa.notifications.settings import effective_settings
from serversherpa.services.timezone import DEFAULT_TIMEZONE

logger = logging.getLogger("serversherpa.notifications.email")

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
class GroupVerdict:
    """One enabled, subscribed group's answer for one email
    (email_rule.group_verdict)."""
    group_id: uuid.UUID
    name: str
    verdict: str        # no_email_channel | urgent_bypass | open | inactive_day | quiet_hours
    allowed_at: datetime | None     # earliest UTC instant it allows the email; None: never


@dataclass(frozen=True)
class EmailDecision:
    """Whether, when and where one notification goes out by email, and why.
    `reason` is the not-queued code when `queue` is False; when queued, the
    deferral reason (quiet_hours / inactive_day) if the email waits, else
    None. `address_source` is where the address came from: "contact" (the
    person's email) or "login" (the account's). `groups` holds the verdicts
    of the enabled groups subscribed to the category, when they were
    consulted (never for an owner copy)."""
    queue: bool
    send_at: datetime | None
    reason: str | None
    address: str | None
    address_source: str | None
    owner_copy: bool
    groups: tuple[GroupVerdict, ...]


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


def personal_choice(info: KindInfo | None, contact: Contact | None) -> str:
    """'email' | 'inbox' | 'off' for this recipient and kind. Security is
    always 'email'; an unregistered kind, or a recipient with no account
    prefs, is 'email' (unregistered kinds are never emailed anyway)."""
    if info is None or info.category == "security" or contact is None:
        return "email"
    return contact.choice_prefs.notif.categories.get(info.category, "email")


def _safe_timezone(s: dict) -> dict:
    """A group with a stored timezone that no longer resolves must not crash
    notify(): fall back to the house default for that group."""
    try:
        ZoneInfo(s.get("timezone") or "UTC")
    except (ZoneInfoNotFoundError, ValueError, OSError):
        logger.warning("unknown notification timezone %r; using %s",
                       s.get("timezone"), DEFAULT_TIMEZONE)
        return {**s, "timezone": DEFAULT_TIMEZONE}
    return s


async def _group_settings(db: AsyncSession, person_id: uuid.UUID,
                          category: str) -> list[dict]:
    """Effective settings of each enabled group the person is in that is
    subscribed to `category`, by group name; each also carries `group_id`
    and `group_name`."""
    rows = (await db.execute(
        select(NotificationGroup, NotificationGroupMember)
        .join(NotificationGroupMember,
              NotificationGroupMember.group_id == NotificationGroup.id)
        .where(NotificationGroupMember.person_id == person_id,
               NotificationGroup.enabled.is_(True),
               NotificationGroup.categories.contains([category]))
        .order_by(NotificationGroup.name, NotificationGroup.id))).all()
    return [_safe_timezone({**effective_settings(g, m),
                            "group_id": g.id, "group_name": g.name})
            for g, m in rows]


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


def _not_queued(reason: str, owner_copy: bool, *, address: str | None = None,
                address_source: str | None = None,
                groups: tuple[GroupVerdict, ...] = ()) -> EmailDecision:
    return EmailDecision(queue=False, send_at=None, reason=reason, address=address,
                         address_source=address_source, owner_copy=owner_copy,
                         groups=groups)


async def decide_email(db: AsyncSession, person_id: uuid.UUID, info: KindInfo | None, *,
                       owner_notice: bool, choice: str, contact: Contact | None,
                       now: datetime) -> EmailDecision:
    """Whether, when and where a notification of kind `info` for this person
    goes out by email, and why. `choice` is the person's choice for the
    category (personal_choice); the contact is loaded when None is passed.
    Writes nothing, so the Check delivery tool can ask it too."""
    decision, _ = await _decide(db, person_id, info, owner_notice=owner_notice,
                                choice=choice, contact=contact, now=now)
    return decision


async def _decide(db: AsyncSession, person_id: uuid.UUID, info: KindInfo | None, *,
                  owner_notice: bool, choice: str, contact: Contact | None,
                  now: datetime) -> tuple[EmailDecision, Contact | None]:
    """decide_email(), plus the contact it used, so maybe_email() never loads
    it twice. The checks run in order and the first that fails decides."""
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    owner_copy = bool(owner_notice and info is not None and info.owner_always)
    if not email_enabled():
        return _not_queued("email_not_set_up", owner_copy), contact
    if info is None:
        return _not_queued("unregistered_kind", owner_copy), contact
    if not info.email:
        return _not_queued("kind_not_emailed", owner_copy), contact
    if choice == "off":
        return _not_queued("category_off", owner_copy), contact
    if choice != "email":
        return _not_queued("category_inbox_only", owner_copy), contact
    if contact is None:
        contact = await load_contact(db, person_id)
    if contact is None or not contact.active:
        return _not_queued("recipient_inactive", owner_copy), contact
    address, source = _address(contact, owner_copy)
    if address is None:
        return _not_queued("no_address", owner_copy), contact

    now_utc = now.astimezone(UTC)
    if owner_copy:      # the owner's own security notice: now, whatever the groups say
        return EmailDecision(queue=True, send_at=now_utc, reason=None, address=address,
                             address_source=source, owner_copy=True, groups=()), contact

    settings = await _group_settings(db, person_id, info.category)
    groups = tuple(GroupVerdict(s["group_id"], s["group_name"],
                                *group_verdict(s, now, urgent=info.urgent))
                   for s in settings)
    found = {"address": address, "address_source": source, "groups": groups}
    if all(g.verdict == "no_email_channel" for g in groups):
        return _not_queued("no_email_group", owner_copy, **found), contact
    times = [g.allowed_at for g in groups if g.allowed_at is not None]
    if not times:
        return _not_queued("blocked_by_schedule", owner_copy, **found), contact
    send_at = min(times)
    # An email that waits says why: the verdict of the group that sets the time.
    reason = (next(g.verdict for g in groups if g.allowed_at == send_at)
              if send_at > now_utc else None)
    return EmailDecision(queue=True, send_at=send_at, reason=reason, address=address,
                         address_source=source, owner_copy=False, groups=groups), contact


async def maybe_email(db: AsyncSession, notification: Notification, *,
                      info: KindInfo | None, owner_notice: bool, choice: str,
                      contact: Contact | None = None) -> None:
    """Queue the notification email when the rule allows it. Either way the
    decision lands in the delivery log: `email_queued` (written by enqueue())
    or `email_not_queued` with the reason."""
    decision, contact = await _decide(
        db, notification.person_id, info, owner_notice=owner_notice, choice=choice,
        contact=contact, now=_now())
    if not decision.queue:
        record(db, "email_not_queued", channel="email", person_id=notification.person_id,
               notification_id=notification.id, kind=notification.kind,
               category=info.category if info else None, reason=decision.reason)
        return
    # Named: the groups that let it go at send_at (one that would allow it
    # only later had no say). Never the address: only where it came from.
    groups = [g.name for g in decision.groups if g.allowed_at == decision.send_at]
    log_detail = {key: value for key, value in (
        ("reason", decision.reason), ("groups", groups), ("via", decision.address_source))
        if value}
    await enqueue(
        db, "notification", decision.address, person_id=notification.person_id,
        kind=notification.kind, notification_id=notification.id,
        send_at=decision.send_at, log_detail=log_detail,
        name=contact.first_name, title=notification.title,
        body="" if info.brief else notification.body,
        link=_absolute(notification.link),
        security=decision.owner_copy,
        prefs_url=portal_link(INBOX_PATH))
