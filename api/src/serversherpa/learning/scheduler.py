"""The learning sweep, run by notification-worker every 60 s
(`run_learning_once`). Each pass:

- sends scheduled invites whose send time (start − `send_offset_days` at
  `send_time`, in the initiative's zone) has passed and haven't gone out;
- sends reminders to people with open assignments. Of the offsets whose
  time (start − offset at `send_time`) has passed, only the latest counts,
  only up to the start day, and only to someone whose code is older than
  that time — so a sweep that was down, a late add or a regenerated code
  never gets a burst of stale reminders. Each goes once per code and stage
  `r<offset>` (learning_email_log);
- raises the overdue notice (inbox, and email through the notification
  rules) to every learning manager once per initiative per local day while
  an open assignment is past its due date, until the initiative ends (or
  starts, with no end date).

Every initiative is handled in its own session and transaction, so one
failure is logged and counted (`errors`) without stopping the rest."""
import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, Person
from serversherpa.learning import emails, invites
from serversherpa.learning.access import manager_ids
from serversherpa.learning.assign import OPEN_STATUSES, _end_day
from serversherpa.learning.codes import initiative_zone
from serversherpa.learning.models import LearningAssignment, LearningInviteSchedule
from serversherpa.notifications.inbox import notify
from serversherpa.services.timezone import stored_day

logger = logging.getLogger("serversherpa.learning.scheduler")

# the overdue notice's notification kind
KIND = "learning_overdue"


def _now() -> datetime:
    """The sweep's clock (a seam for tests)."""
    return datetime.now(UTC)


async def _open_initiatives(db: AsyncSession, since: datetime) -> list[uuid.UUID]:
    """Initiatives with open assignments that start on or after `since`
    (a day's slack either side of every zone is the caller's)."""
    return list(await db.scalars(
        select(Initiative.id)
        .where(Initiative.scheduled_start >= since,
               Initiative.id.in_(select(LearningAssignment.initiative_id).where(
                   LearningAssignment.status.in_(OPEN_STATUSES))))
        .order_by(Initiative.scheduled_start, Initiative.id)))


async def _scheduled_one(db: AsyncSession, initiative_id: uuid.UUID, now: datetime) -> int:
    schedule = await db.scalar(
        select(LearningInviteSchedule)
        .where(LearningInviteSchedule.initiative_id == initiative_id,
               LearningInviteSchedule.mode == "scheduled",
               LearningInviteSchedule.sent_at.is_(None))
        .with_for_update(skip_locked=True))
    if schedule is None:
        return 0
    initiative = await db.get(Initiative, initiative_id)
    at = await invites.send_at(db, initiative, schedule)
    if at is None or at > now:
        return 0
    return (await invites.send_initiative(db, initiative_id, None))["sent"]


async def _reminders_one(db: AsyncSession, initiative_id: uuid.UUID, now: datetime) -> int:
    initiative = await db.get(Initiative, initiative_id)
    if initiative is None or initiative.scheduled_start is None:
        return 0
    schedule = await invites.schedule_for(db, initiative_id)
    zone = await initiative_zone(db, initiative)
    start = stored_day(initiative.scheduled_start)
    if now.astimezone(zone).date() > start:
        return 0
    passed = [o for o in schedule.reminder_offsets or []
              if invites.local_at(start - timedelta(days=o), schedule.send_time, zone) <= now]
    if not passed:
        return 0
    offset = min(passed)
    reminder_at = invites.local_at(start - timedelta(days=offset), schedule.send_time, zone)
    sent = 0
    for person_id in await invites.open_people(db, initiative_id):
        code = await emails.active_code(db, person_id, initiative_id)
        if code is None or code.created_at >= reminder_at:
            continue
        person = await db.get(Person, person_id)
        due = await invites.due_on(db, person_id, initiative_id)
        if await emails.send_reminder(db, person, code, initiative, due, f"r{offset}"):
            sent += 1
    return sent


async def _overdue_one(db: AsyncSession, initiative_id: uuid.UUID, now: datetime) -> int:
    initiative = await db.get(Initiative, initiative_id)
    if initiative is None or initiative.scheduled_start is None:
        return 0
    today = now.astimezone(await initiative_zone(db, initiative)).date()
    last_day = _end_day(initiative) or stored_day(initiative.scheduled_start)
    if today > last_day:
        return 0
    overdue = await db.scalar(
        select(func.count(func.distinct(LearningAssignment.person_id)))
        .where(LearningAssignment.initiative_id == initiative_id,
               LearningAssignment.status.in_(OPEN_STATUSES),
               LearningAssignment.due_on < today)) or 0
    if not overdue:
        return 0
    noun = "person is" if overdue == 1 else "people are"
    title = f"{overdue} {noun} overdue on learning for {initiative.name}"
    raised = 0
    for manager_id in await manager_ids(db):
        # the stage carries the initiative too: the log's unique index has
        # no initiative column, and each initiative gets its own notice
        log = await emails.log_once(db, "reminder", manager_id, initiative_id=initiative_id,
                                stage=f"overdue:{today.isoformat()}:{initiative_id}")
        if log is None:
            continue
        await notify(db, manager_id, KIND, title,
                     body="Their training is past its due date. Open the Learning tab to "
                          "remind them or print codes.",
                     link=f"/initiatives/{initiative_id}?tab=learning",
                     payload={"initiative_id": str(initiative_id), "overdue": overdue,
                              "day": today.isoformat()})
        raised += 1
    return 1 if raised else 0


async def _each(maker, label: str, ids: list[uuid.UUID], step, now: datetime,
                out: dict, key: str) -> None:
    for initiative_id in ids:
        try:
            async with maker() as db:
                out[key] += await step(db, initiative_id, now)
                await db.commit()
        except Exception:
            out["errors"] += 1
            logger.warning("learning %s failed for initiative %s", label, initiative_id,
                           exc_info=True)


async def run_learning_once(maker) -> dict:
    """One sweep. Returns counts: invites and reminders sent, initiatives
    noticed overdue, and initiatives that failed."""
    now = _now()
    out = {"invites": 0, "reminders": 0, "overdue": 0, "errors": 0}
    async with maker() as db:
        scheduled = list(await db.scalars(
            select(LearningInviteSchedule.initiative_id)
            .where(LearningInviteSchedule.mode == "scheduled",
                   LearningInviteSchedule.sent_at.is_(None))))
        # a day either side covers every zone; the per-initiative checks
        # read the exact local day
        upcoming = await _open_initiatives(db, now - timedelta(days=1))
        with_due = list(await db.scalars(
            select(LearningAssignment.initiative_id).distinct()
            .where(LearningAssignment.status.in_(OPEN_STATUSES),
                   LearningAssignment.initiative_id.is_not(None),
                   LearningAssignment.due_on < (now + timedelta(days=1)).date())))
    await _each(maker, "scheduled send", scheduled, _scheduled_one, now, out, "invites")
    await _each(maker, "reminders", upcoming, _reminders_one, now, out, "reminders")
    await _each(maker, "overdue notice", with_due, _overdue_one, now, out, "overdue")
    return out
