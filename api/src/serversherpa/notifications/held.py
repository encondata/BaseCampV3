"""The held-email writer. When a person's schedule is closed (quiet hours or a
day off), maybe_email() does not render or queue the notification email: it
calls `hold_email()`, which leaves one notification_held row pointing at the
inbox row, and an `email_held` entry in the delivery log saying when the
summary is due. The summary sweep sends what is held, or drops it with a
logged reason. Adds to the caller's session — never flushes or commits —
the same contract as notify(), enqueue() and record().

Spec: docs/superpowers/specs/2026-11-01-notifications-phase1-design.md (section 4)"""

from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Notification, NotificationHeld
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.kinds import KindInfo


def hold_email(db: AsyncSession, notification: Notification, *, info: KindInfo,
               reason: str, summary_at: datetime,
               held_at: datetime | None = None) -> NotificationHeld:
    """Hold this notification's email for the recipient's summary and return
    the row. `reason` is the schedule state that closed it (quiet_hours or
    inactive_day); `summary_at` (aware) is when the summary is due, and is all
    the log entry's detail holds: no address, no body. `held_at` defaults to
    now; maybe_email() passes the instant it decided at, so the summary sweep
    works from the same time the decision did."""
    row = NotificationHeld(
        person_id=notification.person_id, notification_id=notification.id,
        kind=notification.kind, category=info.category, reason=reason,
        held_at=held_at or datetime.now(UTC))
    db.add(row)
    record(db, "email_held", channel="email", person_id=notification.person_id,
           notification_id=notification.id, kind=notification.kind,
           category=info.category, reason=reason,
           detail={"summary_at": summary_at.isoformat()})
    return row
