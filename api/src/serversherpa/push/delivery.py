"""Worker-side push delivery, called from notification-worker's loop. The table
is the queue: due `queued` rows are claimed with FOR UPDATE SKIP LOCKED and
handled in the caller's transaction, which is committed once per batch.

A `notification` row is re-checked when its time comes (the notification still
exists, is unread and not hidden, decide_push() still queues it, and the person
still has a live phone); a failed check marks it `dropped` and it is never
retried. A `clear` row goes out unchecked at normal priority. Per phone the
outcomes are sent, token_dead (the registration is deleted), retry or fatal.
Any sent phone makes the row `sent`; otherwise a retry backs the row off
(30 s * 2**attempts, `failed` at MAX_ATTEMPTS) and a fatal answer fails it.

Nothing raises out of a row. Logs and the delivery log carry ids and codes
only: never a registration token, the push key or exception text.

Spec: docs/superpowers/specs/2026-11-17-android-push-notifications-design.md"""

import logging
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Notification, PushOutbox, PushRegistration
from serversherpa.notifications.company import load_company_settings
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.email import load_contact
from serversherpa.notifications.kinds import kind_info
from serversherpa.notifications.push import decide_push, live_registrations
from serversherpa.push.fcm import FcmClient

logger = logging.getLogger("serversherpa.push.delivery")

BATCH_SIZE = 50
MAX_ATTEMPTS = 5
BACKOFF_SECONDS = 30
TITLE_MAX = 120
BODY_MAX = 400


def _log(db: AsyncSession, row: PushOutbox, event: str, *, kind: str | None = None,
         category: str | None = None, reason: str | None = None,
         detail: dict | None = None) -> None:
    """One delivery-log row for this outbox row. The row's id goes in the
    detail: the log's outbox_id column points at the email outbox."""
    merged = {"push_outbox_id": str(row.id), **(detail or {})}
    record(db, event, channel="push", person_id=row.person_id,
           notification_id=row.notification_id, kind=kind, category=category,
           reason=reason, detail=merged)


def _drop(db: AsyncSession, row: PushOutbox, reason: str, now: datetime, *,
          kind: str | None = None, category: str | None = None) -> None:
    row.state = "dropped"
    row.last_error = reason
    row.handled_at = now
    _log(db, row, "push_dropped", kind=kind, category=category, reason=reason)


def _payload(notification: Notification, critical: bool) -> dict[str, str]:
    return {
        "type": "notification",
        "notification_id": str(notification.id),
        "person_id": str(notification.person_id),
        "kind": notification.kind,
        "title": notification.title[:TITLE_MAX],
        "body": (notification.body or "")[:BODY_MAX],
        "critical": "true" if critical else "false",
        "created_at": notification.created_at.isoformat(),
    }


async def _handle(db: AsyncSession, client: FcmClient, row: PushOutbox,
                  now: datetime) -> None:
    kind: str | None = None
    category: str | None = None
    notification: Notification | None = None
    if row.message_type == "clear":
        data = {"type": "clear", "notification_id": str(row.notification_id)}
        high = False
        phones = await live_registrations(db, row.person_id, now)
        if not phones:
            _drop(db, row, "no_phone", now)
            return
    else:
        notification = await db.get(Notification, row.notification_id)
        if notification is None:
            _drop(db, row, "deleted", now)
            return
        info = kind_info(notification.kind)
        kind = notification.kind
        category = info.category if info else None
        if notification.read_at is not None:
            _drop(db, row, "read", now, kind=kind, category=category)
            return
        if notification.dismissed_at is not None:
            _drop(db, row, "hidden", now, kind=kind, category=category)
            return
        contact = await load_contact(db, notification.person_id)
        company = await load_company_settings(db)
        decision = await decide_push(db, notification.person_id, info, contact=contact,
                                     company=company, now=now)
        if not decision.queue:
            _drop(db, row, decision.reason or "not_queued", now, kind=kind,
                  category=category)
            return
        phones = await live_registrations(db, notification.person_id, now)
        if not phones:
            _drop(db, row, "no_phone", now, kind=kind, category=category)
            return
        data = _payload(notification, decision.critical)
        high = True

    sent: list[PushRegistration] = []
    retry_error: str | None = None
    fatal_error: str | None = None
    for registration in phones:
        try:
            result = await client.send(registration.token, data, high_priority=high)
            outcome, error = result.outcome, result.error
        except Exception as exc:  # noqa: BLE001 - one row must not stop the batch
            # the class only: the text could echo a token
            outcome, error = "retry", f"send error {type(exc).__name__}"
        if outcome == "sent":
            sent.append(registration)
        elif outcome == "token_dead":
            _log(db, row, "push_token_removed", kind=kind, category=category,
                 reason=error)
            await db.delete(registration)
        elif outcome == "retry":
            retry_error = error or "retry"
            registration.last_error = retry_error
        else:
            fatal_error = error or "fatal"
            registration.last_error = fatal_error

    if sent:
        for registration in sent:
            registration.last_sent_at = now
            registration.last_error = None
        row.state = "sent"
        row.handled_at = now
        if notification is not None:
            if row.reason == "snooze":
                notification.push_snoozed_until = None
            _log(db, row, "push_sent", kind=kind, category=category,
                 detail={"phones": len(sent)})
        else:
            _log(db, row, "push_cleared", kind=kind, category=category,
                 detail={"phones": len(sent)})
        return
    if retry_error is not None:
        row.attempts += 1
        row.last_error = retry_error
        if row.attempts >= MAX_ATTEMPTS:
            row.state = "failed"
            row.handled_at = now
            _log(db, row, "push_failed", kind=kind, category=category,
                 reason=retry_error, detail={"attempts": row.attempts})
            logger.error("push %s failed after %d attempts", row.id, row.attempts)
        else:
            row.send_at = now + timedelta(seconds=BACKOFF_SECONDS * 2 ** row.attempts)
            _log(db, row, "push_retry", kind=kind, category=category,
                 reason=retry_error, detail={"attempts": row.attempts})
        return
    if fatal_error is not None:
        row.attempts += 1
        row.state = "failed"
        row.last_error = fatal_error
        row.handled_at = now
        _log(db, row, "push_failed", kind=kind, category=category, reason=fatal_error,
             detail={"attempts": row.attempts})
        logger.error("push %s failed: %s", row.id, fatal_error)
        return
    # every phone's token was dead and removed
    _drop(db, row, "no_phone", now, kind=kind, category=category)


async def drain_push(db: AsyncSession, client: FcmClient, *, now: datetime,
                     batch: int = BATCH_SIZE) -> int:
    """Handle the due queued rows (oldest first, up to `batch`) and commit.
    Returns how many rows were handled."""
    rows = (await db.scalars(
        select(PushOutbox)
        .where(PushOutbox.state == "queued", PushOutbox.send_at <= now)
        .order_by(PushOutbox.send_at, PushOutbox.created_at)
        .limit(batch).with_for_update(skip_locked=True))).all()
    for row in rows:
        await _handle(db, client, row, now)
    await db.commit()
    return len(rows)
