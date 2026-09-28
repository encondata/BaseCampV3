"""Password-expiry reminders (To-Do #32): 7, 3 and 1 day before a
password expires, one inbox row per stage. Runs from the notification
worker; email fans out from notify() when it exists."""

import logging
import math
from datetime import UTC, datetime, timedelta

from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Notification, Person, UserAccount
from serversherpa.notifications.inbox import notify
from serversherpa.services.password_policy import expires_at, load_policy

logger = logging.getLogger("serversherpa.notifications.password_reminders")

KIND = "password_expiring"
REMINDER_STAGES = (7, 3, 1)

def _days_left(due: datetime, now: datetime) -> int:
    return math.ceil((due - now) / timedelta(days=1))


async def _already_sent(db: AsyncSession, person_id, due_iso: str, stage: int) -> bool:
    return bool(await db.scalar(select(exists().where(
        Notification.person_id == person_id,
        Notification.kind == KIND,
        Notification.payload["expires_at"].astext == due_iso,
        Notification.payload["stage"].astext == str(stage)))))


async def run_password_reminders(db: AsyncSession, now: datetime) -> int:
    """One sweep. Returns how many reminders were written. Commits."""
    policy = await load_policy(db)
    if not policy.enabled:
        return 0
    accounts = await db.scalars(
        select(UserAccount).join(Person, Person.id == UserAccount.person_id)
        .where(UserAccount.password_hash.is_not(None),
               UserAccount.disabled_at.is_(None),
               # a temporary password is already forced to change at the
               # next sign-in; a countdown on top of that is noise
               UserAccount.must_change_password.is_(False),
               Person.archived_at.is_(None)))
    sent = 0
    for account in accounts:
        due = expires_at(policy, account)
        if due is None:
            continue
        days_left = _days_left(due, now)
        if days_left < 1:
            continue                      # expired: the sign-in gate takes over
        stages_due = [s for s in REMINDER_STAGES if days_left <= s]
        if not stages_due:
            continue
        stage = min(stages_due)           # the most urgent window only
        due_iso = due.isoformat()
        if await _already_sent(db, account.person_id, due_iso, stage):
            continue
        unit = "day" if days_left == 1 else "days"
        await notify(
            db, account.person_id, KIND, f"Your password expires in {days_left} {unit}",
            body=(f"Change it under My Profile › Security before "
                  f"{due.astimezone(UTC):%B %-d, %Y} to avoid being asked at sign-in."),
            link="/me",
            payload={"expires_at": due_iso, "stage": stage, "days_left": days_left})
        sent += 1
    if sent:
        await db.commit()
    return sent


async def run_reminders_once(maker) -> int:
    """The worker's entry point: own session, never raises."""
    try:
        async with maker() as db:
            return await run_password_reminders(db, datetime.now(UTC))
    except Exception:
        logger.exception("password expiry reminder sweep failed")
        return 0
