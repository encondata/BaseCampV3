"""Worker-side push delivery, called from notification-worker's loop. The table
is the queue: due `queued` rows are claimed one at a time with FOR UPDATE SKIP
LOCKED, and each is handled and committed on its own, so no row stays locked
while another row's sends run. A `notification` row also locks its
notification (SKIP LOCKED, before any send): when someone is changing that
notification right now (Mark read, Snooze) the row is left queued for the next
drain instead of waiting, so the worker and that request never wait on each
other's locks.

A `notification` row is re-checked when its time comes (the notification still
exists, is unread and not hidden, decide_push() still queues it, and the person
still has a live phone); a failed check marks it `dropped` and it is never
retried. A `clear` row goes out unchecked at normal priority. Per phone the
outcomes are sent, token_dead (the registration is deleted), retry or fatal.
Any sent phone makes the row `sent`; otherwise a retry backs the row off
(30 s * 2**attempts, `failed` at MAX_ATTEMPTS) and a fatal answer fails it.

Nothing raises out of a row: each row runs in its own savepoint, and one that
fails outside the send is rolled back alone and backed off as a retry. Logs and
the delivery log carry ids and codes only: never a registration token, the push key or exception text.

Spec: docs/superpowers/specs/2026-11-17-android-push-notifications-design.md"""

import logging
import uuid
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


async def _end_snooze(db: AsyncSession, row: PushOutbox) -> None:
    """A snooze row that will never send must not leave a past "Snoozed until"."""
    if row.reason == "snooze":
        notification = await db.get(Notification, row.notification_id)
        if notification is not None:
            notification.push_snoozed_until = None


async def _drop(db: AsyncSession, row: PushOutbox, reason: str, now: datetime, *,
                kind: str | None = None, category: str | None = None) -> None:
    await _end_snooze(db, row)
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


async def _retry(db: AsyncSession, row: PushOutbox, now: datetime, error: str, *,
                 kind: str | None = None, category: str | None = None) -> None:
    """Back the row off, or fail it once it is out of attempts."""
    row.attempts += 1
    row.last_error = error
    if row.attempts >= MAX_ATTEMPTS:
        await _end_snooze(db, row)
        row.state = "failed"
        row.handled_at = now
        _log(db, row, "push_failed", kind=kind, category=category,
             reason=error, detail={"attempts": row.attempts})
        logger.error("push %s failed after %d attempts", row.id, row.attempts)
    else:
        row.send_at = now + timedelta(seconds=BACKOFF_SECONDS * 2 ** row.attempts)
        _log(db, row, "push_retry", kind=kind, category=category,
             reason=error, detail={"attempts": row.attempts})


async def _handle(db: AsyncSession, client: FcmClient, row: PushOutbox,
                  now: datetime) -> bool:
    """Send or settle one claimed row. False when its notification is locked by
    another transaction: the row is left as it is, still queued."""
    kind: str | None = None
    category: str | None = None
    notification: Notification | None = None
    if row.message_type == "clear":
        data = {"type": "clear", "notification_id": str(row.notification_id)}
        high = False
        phones = await live_registrations(db, row.person_id, now)
        if not phones:
            await _drop(db, row, "no_phone", now)
            return True
    else:
        notification = await db.scalar(
            select(Notification).where(Notification.id == row.notification_id)
            .with_for_update(skip_locked=True)
            .execution_options(populate_existing=True))
        if notification is None:
            exists = await db.scalar(select(Notification.id).where(
                Notification.id == row.notification_id))
            if exists is not None:
                return False      # being changed right now: the next drain
            await _drop(db, row, "deleted", now)
            return True
        info = kind_info(notification.kind)
        kind = notification.kind
        category = info.category if info else None
        if notification.read_at is not None:
            await _drop(db, row, "read", now, kind=kind, category=category)
            return True
        if notification.dismissed_at is not None:
            await _drop(db, row, "hidden", now, kind=kind, category=category)
            return True
        contact = await load_contact(db, notification.person_id)
        company = await load_company_settings(db)
        decision = await decide_push(db, notification.person_id, info, contact=contact,
                                     company=company, now=now)
        if not decision.queue:
            await _drop(db, row, decision.reason or "not_queued", now, kind=kind,
                        category=category)
            return True
        phones = await live_registrations(db, notification.person_id, now)
        if not phones:
            await _drop(db, row, "no_phone", now, kind=kind, category=category)
            return True
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
        return True
    if retry_error is not None:
        await _retry(db, row, now, retry_error, kind=kind, category=category)
        return True
    if fatal_error is not None:
        await _end_snooze(db, row)
        row.attempts += 1
        row.state = "failed"
        row.last_error = fatal_error
        row.handled_at = now
        _log(db, row, "push_failed", kind=kind, category=category, reason=fatal_error,
             detail={"attempts": row.attempts})
        logger.error("push %s failed: %s", row.id, fatal_error)
        return True
    # every phone's token was dead and removed
    await _drop(db, row, "no_phone", now, kind=kind, category=category)
    return True


async def _claim(db: AsyncSession, now: datetime,
                 tried: list[uuid.UUID]) -> PushOutbox | None:
    """The oldest due queued row nobody else holds and this drain has not
    tried yet, locked (FOR UPDATE SKIP LOCKED) and read fresh."""
    query = select(PushOutbox).where(PushOutbox.state == "queued",
                                     PushOutbox.send_at <= now)
    if tried:
        query = query.where(PushOutbox.id.not_in(tried))
    return await db.scalar(
        query.order_by(PushOutbox.send_at, PushOutbox.created_at, PushOutbox.id)
        .limit(1).with_for_update(skip_locked=True)
        .execution_options(populate_existing=True))


async def drain_push(db: AsyncSession, client: FcmClient, *, now: datetime,
                     batch: int = BATCH_SIZE) -> int:
    """Handle the due queued rows, oldest first, one at a time: claim a row,
    handle it, commit, then claim the next, so each row's lock lasts only for
    its own sends. At most `batch` rows are claimed per drain. Returns how
    many rows were handled (a row left for the next drain is not counted)."""
    handled = 0
    tried: list[uuid.UUID] = []
    while len(tried) < batch:
        row = await _claim(db, now, tried)
        if row is None:
            break
        row_id = row.id
        tried.append(row_id)
        done = True
        try:
            # a savepoint per row: a bad row rolls back only its own work
            async with db.begin_nested():
                done = await _handle(db, client, row, now)
        except Exception as exc:  # noqa: BLE001 - one row must not stop the drain
            # the class only: the text could echo a token or SQL parameters
            error = f"row error {type(exc).__name__}"
            logger.warning("push %s could not be handled (%s)", row_id,
                           type(exc).__name__)
            try:
                async with db.begin_nested():
                    fresh = await db.get(PushOutbox, row_id, populate_existing=True)
                    if fresh is not None and fresh.state == "queued":
                        await _retry(db, fresh, now, error)
            except Exception:  # noqa: BLE001
                logger.error("push %s could not be backed off", row_id)
        try:
            await db.commit()
        except Exception as exc:  # noqa: BLE001 - the next row still gets its turn
            await db.rollback()
            logger.error("push %s could not be saved (%s)", row_id, type(exc).__name__)
            continue
        if done:
            handled += 1
    # end the read transaction the last (empty) claim opened
    await db.commit()
    return handled
