"""The summary sweep, run by notification-worker every 60 s
(`run_summaries_once`). Email held during a person's quiet hours or on a day
off (notifications/held.py) goes out as ONE summary email an hour before they
are back online. Each person with held rows gets their own session and
transaction:

1. **Due?** Their rows are claimed (FOR UPDATE SKIP LOCKED, oldest first) and
   the summary time after the oldest is computed from their schedule as it is
   now, so a schedule change applies to email already waiting, and a schedule
   that is now always open makes it due at once. Not due yet: nothing changes.
2. **The server can't send email:** every row is dropped (email_not_set_up).
3. **Re-check each row,** oldest first: the re-check the delivery worker runs
   before sending (email.recheck_notification: notification_gone, resolved,
   hidden, read, recipient_inactive, no_access, not_watching,
   category_turned_down), then the address (no_address). A row no longer
   wanted is dropped: logged `email_skipped` with the reason.
4. **Send the rest as one email:** `notification_summary`, template mail that
   is never re-checked again, to the person's usual notification address. It
   has one line per item (category, title and link, never the body), and each
   item is logged `email_summarized` with the summary's outbox id.

Every row a pass handles is deleted (the history lives in notification_log),
so nothing waits twice and nothing is lost silently: a held row is
summarized, dropped with a logged reason, or still waiting for its time. A
person whose pass fails keeps their rows for the next sweep.

Spec: docs/superpowers/specs/2026-11-01-notifications-phase1-design.md (section 4)"""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from serversherpa.db.models import Notification, NotificationHeld
from serversherpa.mail.outbox import email_enabled, enqueue
from serversherpa.notifications.company import load_company_settings
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.email import (
    INBOX_PATH,
    _absolute,
    _address,
    contact_schedule,
    load_contact,
    portal_link,
    recheck_notification,
)
from serversherpa.notifications.kinds import CATEGORIES, kind_info
from serversherpa.notifications.schedule import summary_at

logger = logging.getLogger("serversherpa.notifications.summary")

TEMPLATE = "notification_summary"

# People whose last pass failed: logged once per outage. Only the exception's
# class is logged: its text can carry SQL parameters (the address and the
# rendered summary being written).
_failing: set[uuid.UUID] = set()


def _drop(db: AsyncSession, row: NotificationHeld, reason: str) -> None:
    """Log why this held email no longer goes out. The caller deletes the row."""
    record(db, "email_skipped", channel="email", person_id=row.person_id,
           notification_id=row.notification_id, kind=row.kind,
           category=row.category, reason=reason)


async def _summarize(db: AsyncSession, person_id: uuid.UUID, now: datetime) -> bool:
    """One person's pass; True when it queued their summary. Commits what it
    handled, or rolls back when nothing is due."""
    rows = list(await db.scalars(
        select(NotificationHeld).where(NotificationHeld.person_id == person_id)
        .order_by(NotificationHeld.held_at, NotificationHeld.id)
        .with_for_update(skip_locked=True)))
    if not rows:        # handled meanwhile, or another sweep holds them
        await db.rollback()
        return False
    contact = await load_contact(db, person_id)
    due = summary_at(contact_schedule(contact), rows[0].held_at)
    if due is not None and due > now:   # None: nothing opens within the horizon
        await db.rollback()
        return False

    kept: list[tuple[NotificationHeld, Notification]] = []
    address = _address(contact, owner_copy=False)[0] if contact is not None else None
    if not email_enabled():
        for row in rows:
            _drop(db, row, "email_not_set_up")
    else:
        company = await load_company_settings(db)
        # A deleted notification left its row's link NULL: not found, so gone.
        notifications = {n.id: n for n in await db.scalars(select(Notification).where(
            Notification.id.in_([r.notification_id for r in rows if r.notification_id])))}
        for row in rows:
            notification = notifications.get(row.notification_id)
            # A held kind is registered and emailed: maybe_email() holds nothing
            # else. Were a release to drop it from the registry, kind_info() is
            # None and the switches read as fixed on, as recheck_before_send()
            # treats a queued email of an unlisted kind.
            reason = await recheck_notification(
                db, notification, kind_info(row.kind), contact, company)
            if reason is None and address is None:
                reason = "no_address"
            if reason is None:
                kept.append((row, notification))
            else:
                _drop(db, row, reason)

    if kept:
        summary = await enqueue(
            db, TEMPLATE, address, person_id=person_id,
            log_detail={"summary": True, "count": len(kept)},
            name=contact.first_name, count=len(kept),
            items=[{"category": CATEGORIES.get(row.category, row.category),
                    "title": notification.title, "link": _absolute(notification.link)}
                   for row, notification in kept],
            prefs_url=portal_link(INBOX_PATH))
        for row, _ in kept:
            record(db, "email_summarized", channel="email", person_id=person_id,
                   notification_id=row.notification_id, outbox_id=summary.id,
                   kind=row.kind, category=row.category)
    for row in rows:
        await db.delete(row)
    await db.commit()
    return bool(kept)


async def run_summaries_once(maker: async_sessionmaker, *, now: datetime | None = None) -> int:
    """One sweep: everyone whose summary time has come gets their summary.
    Returns how many summary emails were queued. A person's failure is logged
    (once per outage) and leaves their rows held for the next sweep; it never
    stops the rest. `now` (aware) defaults to the current time."""
    now = datetime.now(UTC) if now is None else now
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    async with maker() as db:
        # whoever has waited longest goes first
        people = list(await db.scalars(
            select(NotificationHeld.person_id).group_by(NotificationHeld.person_id)
            .order_by(func.min(NotificationHeld.held_at))))
    queued = 0
    for person_id in people:
        try:
            async with maker() as db:
                if await _summarize(db, person_id, now):
                    queued += 1
        except Exception as exc:  # noqa: BLE001 — one person's failure must not stop the rest
            if person_id not in _failing:
                logger.warning("could not send the notification summary for person %s — "
                               "retrying (%s)", person_id, type(exc).__name__)
            _failing.add(person_id)
        else:
            _failing.discard(person_id)
    return queued
