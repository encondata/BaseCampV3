"""Email delivery for in-app notifications: decides whether a notification
that `notify()` just wrote also goes out by email, and when, then queues it
in the mail outbox. Adds to the caller's session — never commits.

The rule lives in docs/superpowers/specs/2026-10-08-notification-email-design.md
("Sending rule"); the pure timing part is notifications/email_rule.py."""

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
from serversherpa.notifications.email_rule import email_send_time
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
    rows = (await db.execute(
        select(NotificationGroup, NotificationGroupMember)
        .join(NotificationGroupMember,
              NotificationGroupMember.group_id == NotificationGroup.id)
        .where(NotificationGroupMember.person_id == person_id,
               NotificationGroup.enabled.is_(True),
               NotificationGroup.categories.contains([category])))).all()
    return [_safe_timezone(effective_settings(g, m)) for g, m in rows]


async def maybe_email(db: AsyncSession, notification: Notification, *,
                      info: KindInfo | None, owner_notice: bool, choice: str,
                      contact: Contact | None = None) -> None:
    """Queue the notification email when the rule allows it; else do nothing."""
    if (not email_enabled() or info is None or not info.email
            or choice != "email"):
        return
    if contact is None:
        contact = await load_contact(db, notification.person_id)
    if contact is None or not contact.address or not contact.active:
        return

    now = _now()
    owner_copy = owner_notice and info.owner_always
    if owner_copy:
        send_at = now
    else:
        settings = await _group_settings(db, notification.person_id, info.category)
        if not settings:
            return
        send_at = email_send_time(settings, now, urgent=info.urgent)
        if send_at is None:
            return

    await enqueue(
        db, "notification", contact.address, person_id=notification.person_id,
        kind=notification.kind, notification_id=notification.id, send_at=send_at,
        name=contact.first_name, title=notification.title,
        body="" if info.brief else notification.body,
        link=_absolute(notification.link),
        security=owner_copy,
        prefs_url=portal_link(INBOX_PATH))
