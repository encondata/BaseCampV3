"""The in-app inbox writer. `notify()` is the ONLY code path that creates
Notification rows; email fans out from here (notifications/email.py) and
the table shape stays. Adds to the caller's session — never commits — so a
notification (and its queued email) can't outlive a rolled-back mutation."""

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Notification
from serversherpa.notifications.email import load_contact, maybe_email, personal_choice
from serversherpa.notifications.kinds import kind_info


async def notify(db: AsyncSession, person_id: uuid.UUID, kind: str, title: str, *,
                 body: str = "", link: str | None = None,
                 payload: dict | None = None,
                 owner_notice: bool = False) -> Notification | None:
    """Write the inbox row and queue the email when the rules allow it.
    Returns None (nothing written) when the person turned this category
    off. `owner_notice` marks the copy sent to the account owner about
    their own account (it can email regardless of group membership)."""
    info = kind_info(kind)
    contact = None
    choice = "email"
    if info is not None and info.category != "security":
        contact = await load_contact(db, person_id)
        choice = personal_choice(info, contact)
        if choice == "off":
            return None
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
    await maybe_email(db, row, info=info, owner_notice=owner_notice,
                      choice=choice, contact=contact)
    return row
