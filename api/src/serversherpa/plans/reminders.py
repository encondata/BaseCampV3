"""The plan reminder sweep, run by notification-worker every 60 s
(`run_plan_reminders_once`), and the stages it works from.

A task's *due moment* is its deadline, or its finish when the plan's
`use_finish_without_deadline` is on and it has no deadline, except for a
summary task: its finish is its last subtask's, and the subtasks are
reminded on their own finishes, so a summary is due only at its own
deadline (no stages, and not in the owner's digest). Its *due day*
(`due_day`) is a deadline's own day (a moment: 00:00 Friday is Friday), or
the day a finish's work ends (`floating.last_day`, the one finish-day rule
the Calendar, Board and Timeline use: a finish at 00:00 Friday is
Thursday's end). Its stages, at the plan-local send time (`stages_for`):
`d<N>` N days before the due day for each offset, `due` on the due day
(when `on_due_day`), then the overdue stages while the task is incomplete:
`overdue:<YYYY-MM-DD>` each day from the day after (`daily`), only
`overdue` that day (`once`), or none (`off`).

Each pass, for every plan whose initiative is live (not archived, not
completed or cancelled) and whose reminders are enabled, locked or not:

- every incomplete task with a due moment sends its assignees the latest
  stage whose time has passed and nothing older, so a sweep that was down
  or a late edit never sends a burst. A stage is sent only on its own local
  day: at the end of that day the next one supersedes it (a task reopened
  at 01:00 waits for today's 08:00 stage instead of getting yesterday's at
  01:00 and today's at 08:00). The `once` overdue stage is the exception:
  it stays owed until it goes. Each goes once per (task, person, stage, due
  day): the `plan_reminder_log` row is inserted first (ON CONFLICT DO
  NOTHING RETURNING), so two sweeps can't both send it. Its `due_at` holds
  the due day's start (plan-local 00:00, `due_key`), so moving a due date
  to another day re-arms its reminders while a new time the same day (or a
  recalc nudging a finish) sends nothing again. Only people get reminders
  (never partners), and only those still among the plan's resources: an
  undo can put back an assignee who has since left the initiative;
- with `overdue_to_owner`, the plan's owner (its creator when it has none)
  gets one `plan_overdue_digest` a day, never before the send time, listing
  the tasks that entered an overdue stage, logged per task as
  `owner:<the stage's day>`. A task that turns overdue after the day's
  digest went out waits for the next day's, at the send time.

Delivery (inbox row, direct email, the person's own choice) is
plans/notices.py's `send`. The message reads from the real due day, never
the stage name: "Due Thursday, November 5", "Due today", "has been overdue
since Thursday, November 5".

Every plan is handled in its own session and transaction, so one failure
is counted (`errors`) and logged once per outage without stopping the
rest (learning/scheduler.py's `_each`)."""

import logging
import uuid
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import exists, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from serversherpa.db.models import Initiative, Partner
from serversherpa.learning.stats import INACTIVE_STATUSES
from serversherpa.plans import notices
from serversherpa.plans.floating import format_floating, last_day
from serversherpa.plans.models import PlanAssignment, PlanReminderLog, PlanTask, ProjectPlan
from serversherpa.plans.service import person_names, resources_of
from serversherpa.plans.settings import Reminders, effective, load_system

logger = logging.getLogger("serversherpa.plans.reminders")

# the notification kinds (notifications/kinds.py)
KIND_DUE = "plan_task_due"
KIND_OVERDUE = "plan_task_overdue"
KIND_DIGEST = "plan_overdue_digest"
OVERDUE = "overdue"
OWNER = "owner:"


def _now() -> datetime:
    """The sweep's clock, UTC (a seam for tests)."""
    return datetime.now(UTC)


# ── stages ───────────────────────────────────────────────────────────


def _send_time(r: Reminders) -> time:
    hour, minute = r.send_time.split(":")
    return time(int(hour), int(minute))


def due_day(task: PlanTask) -> date:
    """The day a task is due: its deadline's own day (a deadline is a
    moment, so 00:00 Friday is Friday), else the day its work ends
    (`floating.last_day`: a finish at 00:00 Friday ends Thursday)."""
    if task.deadline is not None:
        return task.deadline.date()
    return last_day(task.start if task.start is not None else task.finish, task.finish)


def stages_for(due: date, r: Reminders, now_local: datetime
               ) -> list[tuple[str, datetime]]:
    """A task's stages in time order, as (stage, plan-local send moment),
    for the due day `due`: `d<N>` at (due − N) for each offset, `due` on
    the due day when `on_due_day`, then (`daily`) `overdue:<day>` for the
    days after it up to `now_local`'s, only `overdue` the day after
    (`once`), or none (`off`). Of the daily ones only yesterday's and
    today's are built: a stage is sent only on its own day, so an older one
    is never the latest passed (`latest_due_stage` answers as it would from
    every day's), and a task long overdue costs two stages a sweep, not one
    per day. Pure: `now_local` is a plan-local wall-clock time."""
    send = _send_time(r)

    def at(day: date) -> datetime:
        return datetime.combine(day, send)

    stages = [(f"d{n}", at(due - timedelta(days=n)))
              for n in sorted(set(r.offsets_days), reverse=True)]
    if r.on_due_day:
        stages.append(("due", at(due)))
    if r.overdue == "once":
        stages.append((OVERDUE, at(due + timedelta(days=1))))
    elif r.overdue == "daily":
        today = now_local.date()
        day = max(due + timedelta(days=1), today - timedelta(days=1))
        while day <= today:
            stages.append((f"{OVERDUE}:{day.isoformat()}", at(day)))
            day += timedelta(days=1)
    return stages


def latest_due_stage(stages: list[tuple[str, datetime]], now_local: datetime
                     ) -> tuple[str, datetime] | None:
    """The latest stage whose moment is at or before `now_local`, or None."""
    latest = None
    for stage in stages:
        if stage[1] <= now_local:
            latest = stage
    return latest


def _is_overdue(stage: str) -> bool:
    return stage == OVERDUE or stage.startswith(f"{OVERDUE}:")


def message(stage: str, due_day: date, today: date) -> tuple[str, str]:
    """(the template's stage, due_label) from the real due day: overdue
    "since Thursday, November 5"; due "today" on the due day; else upcoming
    "Thursday, November 5"."""
    if _is_overdue(stage):
        return "overdue", f"since {notices.long_day(due_day, today)}"
    if due_day == today:
        return "due", "today"
    return "upcoming", notices.long_day(due_day, today)


def reminder_text(stage: str, task: str, initiative: str, due_label: str) -> tuple[str, str]:
    """The inbox title (the email's subject) and body for a template stage."""
    if stage == "overdue":
        return (f"Overdue: {task} — {initiative}",
                f"{task} in {initiative} has been overdue {due_label}.")
    if stage == "due":
        return f"Due today: {task} — {initiative}", f"{task} in {initiative} is due today."
    return (f"Due {due_label}: {task} — {initiative}",
            f"{task} in {initiative} is due {due_label}.")


# ── one plan ─────────────────────────────────────────────────────────


def _live(initiative: Initiative | None) -> bool:
    return (initiative is not None and initiative.archived_at is None
            and initiative.status not in INACTIVE_STATUSES)


def _is_parent(task_id):
    """Whether the task is a summary: another task names it as its parent
    (derived from the outline, never stored; plans/engine.py)."""
    child = aliased(PlanTask)
    return exists().where(child.parent_id == task_id)


# a log row as the sweep compares it: (task, person, stage, due day key)
_Row = tuple[uuid.UUID, uuid.UUID, str, datetime]


def due_key(due: date) -> datetime:
    """What `plan_reminder_log.due_at` holds: the due day's start (plan-local
    00:00), so reminders are deduplicated per due day (`due_day`), not per
    due moment."""
    return datetime.combine(due, time())


async def _log_once(db: AsyncSession, task_id: uuid.UUID, person_id: uuid.UUID, stage: str,
                    key: datetime, now: datetime) -> bool:
    """Insert the dedupe row (`key` from `due_key`); False when it was
    already there (sent, or being sent by another sweep, whose commit this
    waits for)."""
    inserted = await db.execute(
        pg_insert(PlanReminderLog)
        .values(task_id=task_id, person_id=person_id, stage=stage, due_at=key,
                sent_at=now)
        .on_conflict_do_nothing()
        .returning(PlanReminderLog.id))
    return inserted.scalar_one_or_none() is not None


async def _logged(db: AsyncSession, task_ids: list[uuid.UUID], stages: set[str]) -> set[tuple]:
    """The (task, person, stage, due day key) rows already logged among
    these."""
    rows = await db.execute(
        select(PlanReminderLog.task_id, PlanReminderLog.person_id, PlanReminderLog.stage,
               PlanReminderLog.due_at)
        .where(PlanReminderLog.task_id.in_(task_ids), PlanReminderLog.stage.in_(stages)))
    return {tuple(row) for row in rows}


async def _digested_today(db: AsyncSession, plan_id: uuid.UUID, owner_id: uuid.UUID,
                          since: datetime) -> bool:
    """Whether today's digest for this plan already went to the owner."""
    found = await db.scalar(
        select(PlanReminderLog.id)
        .join(PlanTask, PlanTask.id == PlanReminderLog.task_id)
        .where(PlanTask.plan_id == plan_id, PlanReminderLog.person_id == owner_id,
               PlanReminderLog.stage.startswith(OWNER), PlanReminderLog.sent_at >= since)
        .limit(1))
    return found is not None


async def _resource_names(db: AsyncSession, task_ids: list[uuid.UUID]
                          ) -> dict[uuid.UUID, list[str]]:
    """Each task's Resource Names (people and partners), sorted."""
    rows = (await db.execute(
        select(PlanAssignment.task_id, PlanAssignment.person_id, PlanAssignment.partner_id)
        .where(PlanAssignment.task_id.in_(task_ids)))).all()
    people = await person_names(db, (row.person_id for row in rows))
    partner_ids = {row.partner_id for row in rows if row.partner_id is not None}
    partners = dict((await db.execute(
        select(Partner.id, Partner.name).where(Partner.id.in_(partner_ids))
    )).all()) if partner_ids else {}
    names: dict[uuid.UUID, list[str]] = {}
    for row in rows:
        name = people.get(row.person_id) or partners.get(row.partner_id)
        if name:
            names.setdefault(row.task_id, []).append(name)
    return {tid: sorted(found, key=str.casefold) for tid, found in names.items()}


async def _digest(db: AsyncSession, plan: ProjectPlan, initiative: Initiative,
                  owner_id: uuid.UUID, tasks: list[tuple[PlanTask, date]],
                  r: Reminders, today: date) -> bool:
    """The owner's digest of `tasks`, each with its due day."""
    names = await _resource_names(db, [task.id for task, _ in tasks])
    rows = [{"name": task.name, "due_label": notices.long_day(due, today),
             "assignees": names.get(task.id, [])} for task, due in tasks]
    count = len(rows)
    return await notices.send(
        db, owner_id, KIND_DIGEST, email=r.email_assignees,
        title=f"{count} overdue task{'' if count == 1 else 's'} in {initiative.name}",
        body=notices.name_list([task.name for task, _ in tasks]),
        link=notices.task_link(initiative.id),
        payload={"plan_id": str(plan.id), "initiative_id": str(initiative.id),
                 "task_ids": [str(task.id) for task, _ in tasks], "day": today.isoformat()},
        template="plan_overdue_digest", initiative_name=initiative.name, tasks=rows)


async def _plan_one(db: AsyncSession, plan_id: uuid.UUID, now: datetime,
                    system: dict) -> tuple[int, int]:
    """One plan's reminders and owner digest: (reminders sent, digests sent)."""
    plan = await db.get(ProjectPlan, plan_id)
    if plan is None:
        return 0, 0
    initiative = await db.get(Initiative, plan.initiative_id)
    if not _live(initiative):
        return 0, 0
    r = effective(system, plan.settings).reminders
    if not r.enabled:
        return 0, 0
    zone = ZoneInfo(plan.timezone)
    now_local = now.astimezone(zone).replace(tzinfo=None)
    today = now_local.date()

    # narrowed to the tasks some stage could be owed for: the earliest
    # stage is the largest offset before the due day; with no overdue
    # stages, nothing is owed once the due day is over. A finish at the
    # horizon's 00:00 ends the day before (`due_day`), so it is kept: the
    # filter may keep more than is owed, never less
    due_col = (func.coalesce(PlanTask.deadline, PlanTask.finish)
               if r.use_finish_without_deadline else PlanTask.deadline)
    horizon = datetime.combine(today + timedelta(days=max(r.offsets_days, default=0) + 1),
                               time())
    where = [PlanTask.plan_id == plan.id, PlanTask.percent_complete < 100,
             due_col.is_not(None), due_col <= horizon]
    if r.use_finish_without_deadline:
        # a summary is due at its finish only through its subtasks (the
        # finish is the last one's), and they are reminded on their own:
        # only a summary's own deadline makes it due
        where.append(or_(PlanTask.deadline.is_not(None), ~_is_parent(PlanTask.id)))
    if r.overdue == "off":
        where.append(due_col >= datetime.combine(today, time()))
    tasks = list(await db.scalars(
        select(PlanTask).where(*where).order_by(PlanTask.position, PlanTask.id)))

    # task id -> (task, the real due moment, its due day, stage, the
    # stage's moment)
    owed: dict[uuid.UUID, tuple[PlanTask, datetime, date, str, datetime]] = {}
    for task in tasks:
        due_at = task.deadline if task.deadline is not None else task.finish
        due = due_day(task)
        latest = latest_due_stage(stages_for(due, r, now_local), now_local)
        if latest is None:
            continue
        stage, at = latest
        if stage != OVERDUE and at.date() < today:
            continue            # superseded at the end of its own day
        owed[task.id] = (task, due_at, due, stage, at)
    if not owed:
        return 0, 0

    owner_id = plan.owner_id or plan.created_by
    owner_owed: list[_Row] = []
    if r.overdue_to_owner and owner_id is not None:
        owner_owed = [(tid, owner_id, f"{OWNER}{at.date().isoformat()}", due_key(due))
                      for tid, (_, _, due, stage, at) in owed.items() if _is_overdue(stage)]
    done = await _logged(db, list(owed), {stage for _, _, _, stage, _ in owed.values()}
                         | {row[2] for row in owner_owed})

    # owed to assignees and not logged yet, in outline order; the plan's
    # resources are read only when something is
    assigned: dict[uuid.UUID, list[uuid.UUID]] = {}
    for tid, pid in (await db.execute(
            select(PlanAssignment.task_id, PlanAssignment.person_id)
            .where(PlanAssignment.task_id.in_(list(owed)),
                   PlanAssignment.person_id.is_not(None))
            .order_by(PlanAssignment.person_id))).all():
        assigned.setdefault(tid, []).append(pid)
    pending: list[_Row] = [row for row in (
        (tid, pid, stage, due_key(due)) for tid, (_, _, due, stage, _) in owed.items()
        for pid in assigned.get(tid, [])) if row not in done]
    if pending:
        current = {res.id for res in await resources_of(db, initiative) if res.kind == "person"}
        pending = [row for row in pending if row[1] in current]

    sent = 0
    for task_id, person_id, stage, key in pending:
        if not await _log_once(db, task_id, person_id, stage, key, now):
            continue
        task, due_at, due = owed[task_id][:3]
        template_stage, due_label = message(stage, due, today)
        title, body = reminder_text(template_stage, task.name, initiative.name, due_label)
        if await notices.send(
                db, person_id, KIND_OVERDUE if template_stage == "overdue" else KIND_DUE,
                email=r.email_assignees, title=title, body=body,
                link=notices.task_link(initiative.id, task_id),
                payload={"plan_id": str(plan.id), "initiative_id": str(initiative.id),
                         "task_id": str(task_id), "stage": stage,
                         "due_at": format_floating(due_at)},
                template="plan_reminder", task_name=task.name,
                initiative_name=initiative.name, due_label=due_label, stage=template_stage):
            sent += 1

    owner_owed = [row for row in owner_owed if row not in done]
    if not owner_owed:
        return sent, 0
    if now_local < datetime.combine(today, _send_time(r)):
        return sent, 0          # never before the send time: these wait for it
    midnight = datetime.combine(today, time(), tzinfo=zone)
    if await _digested_today(db, plan.id, owner_id, midnight):
        return sent, 0          # one digest a day: these wait for tomorrow's
    newly: list[tuple[PlanTask, date]] = []
    for task_id, person_id, stage, key in owner_owed:
        if await _log_once(db, task_id, person_id, stage, key, now):
            task, _, due = owed[task_id][:3]
            newly.append((task, due))
    if not newly:
        return sent, 0
    return sent, int(await _digest(db, plan, initiative, owner_id, newly, r, today))


# ── the sweep ────────────────────────────────────────────────────────

# plans whose last run failed: logged once per outage. Only the exception's
# class is logged — its text can carry SQL parameters (rendered emails).
_failing: set[uuid.UUID] = set()


async def run_plan_reminders_once(maker) -> dict:
    """One sweep: {"reminders": sent, "digests": sent, "errors": plans that
    failed}."""
    now = _now()
    out = {"reminders": 0, "digests": 0, "errors": 0}
    async with maker() as db:
        system = await load_system(db)
        has_due = (select(PlanTask.id)
                   .where(PlanTask.plan_id == ProjectPlan.id, PlanTask.percent_complete < 100,
                          or_(PlanTask.deadline.is_not(None), PlanTask.finish.is_not(None)))
                   .exists())
        plan_ids = list(await db.scalars(
            select(ProjectPlan.id)
            .join(Initiative, Initiative.id == ProjectPlan.initiative_id)
            .where(Initiative.archived_at.is_(None),
                   Initiative.status.not_in(INACTIVE_STATUSES), has_due)
            .order_by(ProjectPlan.id)))
    for plan_id in plan_ids:
        try:
            async with maker() as db:
                sent, digests = await _plan_one(db, plan_id, now, system)
                await db.commit()
        except Exception as exc:  # noqa: BLE001 — one plan's failure must not stop the rest
            out["errors"] += 1
            if plan_id not in _failing:
                logger.warning("plan reminders failed for plan %s: %s", plan_id,
                               type(exc).__name__)
            _failing.add(plan_id)
        else:
            _failing.discard(plan_id)
            out["reminders"] += sent
            out["digests"] += digests
    return out
