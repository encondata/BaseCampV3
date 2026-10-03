"""The outbox writer. `enqueue()` renders an email and adds it to the
caller's session — never commits — so mail goes out only if the request
that caused it commits (same contract as notify() and audit()). Rows are
written even when SMTP isn't configured; notification-worker records
those as `skipped`."""

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.config import get_settings
from serversherpa.db.models import EmailOutbox
from serversherpa.mail.render import render


def email_enabled() -> bool:
    s = get_settings()
    return bool(s.smtp_host.strip() and s.smtp_from.strip())


async def enqueue(db: AsyncSession, template: str, to: str, *,
                  person_id: uuid.UUID | None = None, **ctx) -> EmailOutbox:
    rendered = render(template, **ctx)
    now = datetime.now(UTC)
    row = EmailOutbox(
        template=template, to_address=to, person_id=person_id,
        subject=rendered.subject, html_body=rendered.html, text_body=rendered.text,
        status="queued", attempts=0, next_attempt_at=now, created_at=now)
    db.add(row)
    await db.flush()
    return row
