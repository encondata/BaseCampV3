"""The in-app inbox writer. `notify()` is the ONLY code path that creates
Notification rows; when email/SMS delivery arrives it fans out from here
and the table shape stays. Adds to the caller's session — never commits —
so a notification can't outlive a rolled-back mutation."""

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Notification


async def notify(db: AsyncSession, person_id: uuid.UUID, kind: str, title: str, *,
                 body: str = "", link: str | None = None,
                 payload: dict | None = None) -> Notification:
    # created_at is set here rather than left to the column's `now()`
    # server_default: several notify() calls commonly land in the same
    # caller transaction, where Postgres's now() is frozen at transaction
    # start — every row in that batch would get an identical timestamp
    # and the inbox's "newest first" ordering would be undefined.
    # datetime.now() advances per call, so ordering stays stable.
    row = Notification(person_id=person_id, kind=kind, title=title, body=body,
                       link=link, payload=payload or {}, created_at=datetime.now(UTC))
    db.add(row)
    await db.flush()
    return row
