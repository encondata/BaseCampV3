"""The in-app inbox writer. `notify()` is the ONLY code path that creates
Notification rows; email fans out from here (notifications/email.py) and
the table shape stays. Every call leaves its decisions in the delivery log
(notifications/delivery_log.py). Adds to the caller's session — never
commits — so a notification (and its queued or held email, and their log
rows) can't outlive a rolled-back mutation."""

import uuid
from datetime import UTC, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Notification
from serversherpa.notifications.company import load_company_settings
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.email import effective_switches, load_contact, maybe_email
from serversherpa.notifications.kinds import kind_info


async def notify(db: AsyncSession, person_id: uuid.UUID, kind: str, title: str, *,
                 body: str = "", link: str | None = None,
                 payload: dict | None = None,
                 owner_notice: bool = False) -> Notification | None:
    """Write the inbox row and email it (now, or held for the person's
    summary) when the rules allow it. Returns None (no inbox row) when the
    person's Inbox switch for this category is off, their own or the company
    default they follow (except for kinds that are never emailed).
    `owner_notice` marks the copy sent to the account owner about their own
    account: it is emailed at once, whatever their schedule, while anyone
    else's copy of an account-security notice stays in their inbox. Logs
    `inbox_written` or `inbox_suppressed`; the email decision logs its own."""
    info = kind_info(kind)
    # Loaded once for both decisions, the inbox row's and the email's.
    contact = await load_contact(db, person_id)
    company = await load_company_settings(db)
    switches = effective_switches(info, contact, company)
    # A kind that is never emailed keeps its inbox row even when the
    # category is off: password_reset_request is the only way a
    # locked-out user reaches an admin when SMTP is off.
    if not switches.inbox and info is not None and info.email:
        record(db, "inbox_suppressed", channel="inbox", person_id=person_id,
               kind=kind, category=info.category, reason="category_off",
               detail={"source": switches.inbox_source})
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
    record(db, "inbox_written", channel="inbox", person_id=person_id,
           notification_id=row.id, kind=kind,
           category=info.category if info else None)
    await maybe_email(db, row, info=info, owner_notice=owner_notice,
                      contact=contact, company=company)
    return row
