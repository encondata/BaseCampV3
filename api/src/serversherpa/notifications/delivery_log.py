"""The notification delivery log writer. `record()` adds one `notification_log`
row to the caller's session — never flushes or commits — the same contract as
notify(), enqueue() and audit(), so a log row can't outlive a rolled-back
mutation. Each row is also written as one INFO line on the
`serversherpa.notifications.log` logger for developers.

Neither a row's `detail` nor that line may carry an email address or a message
body: they hold ids, codes and counts. The address lives only on the outbox
row, and smtplib's error text (which embeds addresses) only in
email_outbox.last_error.

Spec: docs/superpowers/specs/2026-10-31-notifications-phase0-design.md (section 9)"""

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import NotificationLog
from serversherpa.system.db_logging import installed_process

logger = logging.getLogger("serversherpa.notifications.log")

EVENTS: tuple[str, ...] = (
    "inbox_written", "inbox_suppressed",
    "email_queued", "email_not_queued",
    "email_sent", "email_skipped", "email_retry", "email_failed",
)

# The table's CHECK also allows text and push, for the channels that may
# arrive later; the writer only accepts the ones in use.
LOG_CHANNELS: tuple[str, ...] = ("inbox", "email")


def record(db: AsyncSession, event: str, *, channel: str,
           person_id: uuid.UUID | None = None,
           notification_id: uuid.UUID | None = None,
           outbox_id: uuid.UUID | None = None,
           kind: str | None = None, category: str | None = None,
           reason: str | None = None,
           detail: dict | None = None) -> NotificationLog:
    """Add one log row and return it. `kind` is the notification kind or the
    email template, `reason` a reason code. `at` is set here, not left to the
    column's `now()`: several decisions commonly land in one caller
    transaction, where Postgres's now() is frozen at transaction start, so
    every row in the batch would show the same time (see notify())."""
    if event not in EVENTS:
        raise ValueError(f"unknown notification log event {event!r}")
    if channel not in LOG_CHANNELS:
        raise ValueError(f"unknown notification log channel {channel!r}")
    row = NotificationLog(
        at=datetime.now(UTC), event=event, channel=channel, person_id=person_id,
        notification_id=notification_id, outbox_id=outbox_id, kind=kind,
        category=category, reason=reason, detail=dict(detail or {}),
        process=installed_process())
    db.add(row)
    # ids and codes only, and only those that are set; never `detail`
    fields = {"channel": channel, "kind": kind, "person": person_id,
              "notification": notification_id, "outbox": outbox_id, "reason": reason}
    logger.info("%s %s", event,
                " ".join(f"{key}={value}" for key, value in fields.items()
                         if value is not None))
    return row
