"""The outbox writer. `enqueue()` renders an email and adds it to the
caller's session — never commits — so mail goes out only if the request
that caused it commits (same contract as notify() and audit()). Rows are
written even when SMTP isn't configured; notification-worker records
those as `skipped`. Every queued email, template mail included, gets an
`email_queued` row in the delivery log (notifications/delivery_log.py)."""

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import EmailOutbox
from serversherpa.mail.render import render
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.kinds import kind_info


def email_enabled() -> bool:
    s = get_settings()
    return bool(s.smtp_host.strip() and s.smtp_from.strip())


def _now() -> datetime:
    """The queue's clock (a seam for tests)."""
    return datetime.now(UTC)


async def enqueue(db: AsyncSession, template: str, to: str, *,
                  person_id: uuid.UUID | None = None, kind: str | None = None,
                  notification_id: uuid.UUID | None = None,
                  send_at: datetime | None = None,
                  attachments: list[dict] | None = None,
                  log_detail: dict | None = None, **ctx) -> EmailOutbox:
    """`send_at` (aware) is the earliest delivery time; default now.
    `attachments` are inline parts for the HTML body: [{cid, filename,
    content_type, b64}] (see transport.build_message). `log_detail` adds to
    the delivery-log row's detail (notification mail: deferral reason,
    groups, address source) and, like that whole detail, must never carry
    an email address or a message body."""
    rendered = render(template, **ctx)
    now = _now()
    due = send_at or now
    row = EmailOutbox(
        template=template, to_address=to, person_id=person_id,
        kind=kind, notification_id=notification_id,
        subject=rendered.subject, html_body=rendered.html, text_body=rendered.text,
        status="queued", attempts=0, next_attempt_at=due, created_at=now,
        attachments=attachments or None)
    db.add(row)
    await db.flush()
    # The category is a notification kind's; template mail (kind None) has
    # none, even when a template shares a kind's name.
    info = kind_info(kind) if kind else None
    record(db, "email_queued", channel="email", person_id=person_id,
           notification_id=notification_id, outbox_id=row.id, kind=kind or template,
           category=info.category if info else None,
           detail={"template": template, "send_at": due.isoformat(),
                   "deferred": due > now, **(log_detail or {})})
    return row
