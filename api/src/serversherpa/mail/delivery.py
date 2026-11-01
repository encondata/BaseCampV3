"""Worker-side outbox delivery, called from notification-worker's loop.
The table is the queue: due `queued` rows are claimed with FOR UPDATE
SKIP LOCKED (→ `sending`), then each is sent in its own session. Outcomes:
sent; a send error → back to `queued` with backoff, `failed` after
MAX_ATTEMPTS; SMTP not configured → `skipped`; notification mail no longer
wanted when its time comes (read, hidden, decided, turned down:
notifications/email.py recheck_before_send) → `skipped` with a reason. Each
outcome is also a row in the delivery log (notifications/delivery_log.py).
Nothing raises out of a row. Logs carry the row id, template, attempt count,
exception class and SMTP code — never the address (smtplib error text embeds
addresses; the full text lives only in the last_error column, and a log row's
`detail` holds the class and code alone)."""

import logging
import os
import socket
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import EmailOutbox
from serversherpa.mail.outbox import email_enabled
from serversherpa.mail.transport import send_email
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.email import recheck_before_send
from serversherpa.notifications.kinds import kind_info

logger = logging.getLogger("serversherpa.mail.delivery")

BATCH_SIZE = 20
MAX_ATTEMPTS = 5
BACKOFF_MINUTES = (1, 5, 15, 60)
STALE_MINUTES = 15
ERROR_MAX = 2000


def _worker_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}"


async def requeue_stale(db: AsyncSession) -> int:
    """Rows a dead worker left `sending` go back to the queue. Commits."""
    cutoff = datetime.now(UTC) - timedelta(minutes=STALE_MINUTES)
    rows = (await db.scalars(
        select(EmailOutbox).where(EmailOutbox.status == "sending",
                                  EmailOutbox.heartbeat_at < cutoff)
        .with_for_update(skip_locked=True))).all()
    for row in rows:
        row.status = "queued"
        row.worker_id = None
        row.heartbeat_at = None
    await db.commit()
    return len(rows)


async def _claim(db: AsyncSession) -> list[uuid.UUID]:
    now = datetime.now(UTC)
    rows = (await db.scalars(
        select(EmailOutbox)
        .where(EmailOutbox.status == "queued", EmailOutbox.next_attempt_at <= now)
        .order_by(EmailOutbox.next_attempt_at, EmailOutbox.created_at)
        .limit(BATCH_SIZE).with_for_update(skip_locked=True))).all()
    for row in rows:
        row.status = "sending"
        row.heartbeat_at = now
        row.worker_id = _worker_id()
    await db.commit()
    return [row.id for row in rows]


def _record(db: AsyncSession, row: EmailOutbox, event: str, *,
            reason: str | None = None, detail: dict | None = None) -> None:
    """One delivery-log row for this outbox row. `kind` is the notification
    kind, or the template for mail that mirrors no notification; only a
    registered notification kind has a category. `detail` never carries the
    address or any error text."""
    info = kind_info(row.kind) if row.kind else None
    record(db, event, channel="email", person_id=row.person_id,
           notification_id=row.notification_id, outbox_id=row.id,
           kind=row.kind or row.template, category=info.category if info else None,
           reason=reason, detail=detail)


def _skip(db: AsyncSession, row: EmailOutbox, reason: str) -> None:
    row.status = "skipped"
    row.skip_reason = reason
    _record(db, row, "email_skipped", reason=reason)


async def _deliver(db: AsyncSession, row: EmailOutbox, send) -> None:
    now = datetime.now(UTC)
    if not email_enabled():
        _skip(db, row, "email_not_set_up")
        logger.info("email %s (%s) skipped — SMTP not configured", row.id, row.template)
        return
    reason = await recheck_before_send(db, row)
    if reason is not None:
        _skip(db, row, reason)
        logger.info("email %s (%s) skipped before sending — %s",
                    row.id, row.template, reason)
        return
    row.attempts += 1
    try:
        await send(to=row.to_address, subject=row.subject,
                   html=row.html_body, text=row.text_body, attachments=row.attachments)
    except Exception as exc:
        row.last_error = f"{type(exc).__name__}: {exc}"[:ERROR_MAX]
        code = getattr(exc, "smtp_code", None)
        code = code if isinstance(code, int) else None
        error = type(exc).__name__
        safe = error + (f" (smtp {code})" if code else "")
        if row.attempts >= MAX_ATTEMPTS:
            row.status = "failed"
            _record(db, row, "email_failed",
                    detail={"attempts": row.attempts, "error": error, "smtp_code": code})
            logger.error("email %s (%s) failed after %d attempts: %s",
                         row.id, row.template, row.attempts, safe)
        else:
            row.status = "queued"
            row.next_attempt_at = now + timedelta(minutes=BACKOFF_MINUTES[row.attempts - 1])
            _record(db, row, "email_retry",
                    detail={"attempt": row.attempts, "error": error, "smtp_code": code,
                            "next_attempt_at": row.next_attempt_at.isoformat()})
            logger.warning("email %s (%s) attempt %d failed, retrying: %s",
                           row.id, row.template, row.attempts, safe)
        return
    row.status = "sent"
    row.sent_at = now
    row.last_error = None
    _record(db, row, "email_sent", detail={"attempt": row.attempts})
    logger.info("sent email %s (%s)", row.id, row.template)


async def deliver_once(maker, *, send=send_email) -> int:
    """One pass: sweep stale rows, claim a batch, deliver each. Returns
    the number of rows processed."""
    async with maker() as db:
        await requeue_stale(db)
        ids = await _claim(db)
    for row_id in ids:
        try:
            async with maker() as db:
                row = await db.get(EmailOutbox, row_id)
                if row is None:
                    continue
                await _deliver(db, row, send)
                await db.commit()
        except Exception as exc:
            logger.error("could not deliver email %s: %s", row_id, type(exc).__name__)
    return len(ids)
