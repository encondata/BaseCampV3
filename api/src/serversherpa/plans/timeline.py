"""The plan overlay on the all-initiatives Timeline page (GET /plans/timeline,
spec "All-initiatives Timeline page").

- Milestones: every task flagged Show on timeline whose finish day (the date
  of its floating finish) falls in the asked range, both ends included, with
  its status as the plan tab shows it (`service.task_status` against the
  plan's status date, else its now): complete, or late.
- Summaries, one per plan (keyed by its initiative): the plan's top-level %
  complete — the engine's rollup rule (`engine.rollup_percent`) over all of
  its leaves, as an implicit project summary would read — and the next
  incomplete flagged task finishing on or after the plan's own now
  (`plan_now` in the plan's zone; the status date doesn't move it), the
  earliest first, ties in outline order.

The plans are those of the initiatives the actor's initiatives scope reaches
(`scope_conditions`, the filter GET /initiatives applies). Stored values
only, nothing rescheduled, and a fixed number of queries whatever the number
of plans: the plans, their leaf sums, their flagged tasks."""

import uuid
from datetime import date

from sqlalchemy import BigInteger, cast, exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased, load_only

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext
from serversherpa.db.models import Initiative
from serversherpa.plans.engine import rollup_percent
from serversherpa.plans.floating import format_floating, plan_now
from serversherpa.plans.models import PlanTask, ProjectPlan
from serversherpa.plans.schemas import (
    PlanTimelineOut,
    TimelineMilestoneOut,
    TimelineNextOut,
    TimelineSummaryOut,
)
from serversherpa.plans.service import status_now, task_status


def _visible_plan_ids(actor: AuthContext):
    """The ids of the plans whose initiative the actor can see, as a subquery."""
    stmt = (select(ProjectPlan.id)
            .join(Initiative, Initiative.id == ProjectPlan.initiative_id))
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        stmt = stmt.where(cond)
    return stmt


async def _leaf_percents(db: AsyncSession, plan_ids) -> dict[uuid.UUID, int]:
    """Each plan's top-level % complete, from its leaves' stored values (a
    leaf is a task no other task names as its parent)."""
    child = aliased(PlanTask)
    rows = (await db.execute(
        select(PlanTask.plan_id,
               func.sum(cast(PlanTask.percent_complete, BigInteger)
                        * PlanTask.duration_minutes),
               func.sum(PlanTask.duration_minutes),
               func.sum(PlanTask.percent_complete),
               func.count())
        .where(PlanTask.plan_id.in_(plan_ids),
               ~exists().where(child.parent_id == PlanTask.id))
        .group_by(PlanTask.plan_id))).all()
    return {plan_id: rollup_percent(weighted=int(weighted or 0), duration=int(duration or 0),
                                    percent=int(percent or 0), leaves=leaves)
            for plan_id, weighted, duration, percent, leaves in rows}


async def timeline_out(db: AsyncSession, actor: AuthContext, first: date,
                       last: date) -> PlanTimelineOut:
    """Milestones finishing `first`..`last` (days, both included) and every
    visible plan's summary."""
    plan_ids = _visible_plan_ids(actor)
    plans = (await db.scalars(
        select(ProjectPlan)
        .options(load_only(ProjectPlan.id, ProjectPlan.initiative_id, ProjectPlan.timezone,
                           ProjectPlan.status_date))
        .where(ProjectPlan.id.in_(plan_ids)))).all()
    if not plans:
        return PlanTimelineOut(milestones=[], summaries={})
    percents = await _leaf_percents(db, plan_ids)
    flagged = (await db.scalars(
        select(PlanTask)
        .options(load_only(PlanTask.id, PlanTask.plan_id, PlanTask.name, PlanTask.position,
                           PlanTask.finish, PlanTask.deadline, PlanTask.percent_complete,
                           PlanTask.actual_start))
        .where(PlanTask.plan_id.in_(plan_ids), PlanTask.show_on_timeline.is_(True),
               PlanTask.finish.is_not(None))
        .order_by(PlanTask.plan_id, PlanTask.position, PlanTask.id))).all()

    by_plan: dict[uuid.UUID, list[PlanTask]] = {}
    for task in flagged:
        by_plan.setdefault(task.plan_id, []).append(task)

    milestones: list[TimelineMilestoneOut] = []
    summaries: dict[uuid.UUID, TimelineSummaryOut] = {}
    for plan in plans:
        tasks = by_plan.get(plan.id, [])        # outline order
        status_at = status_now(plan)
        for task in tasks:
            if first <= task.finish.date() <= last:
                milestones.append(TimelineMilestoneOut(
                    initiative_id=plan.initiative_id, plan_id=plan.id, task_id=task.id,
                    name=task.name, at=format_floating(task.finish),
                    complete=task.percent_complete >= 100,
                    late=task_status(task, status_at) == "late"))
        now = plan_now(plan.timezone)
        upcoming = [t for t in tasks if t.percent_complete < 100 and t.finish >= now]
        nearest = min(upcoming, key=lambda t: t.finish, default=None)   # first wins a tie
        summaries[plan.initiative_id] = TimelineSummaryOut(
            percent_complete=percents.get(plan.id, 0),
            next=None if nearest is None else TimelineNextOut(
                name=nearest.name, at=format_floating(nearest.finish)))

    milestones.sort(key=lambda m: (m.at, str(m.initiative_id)))   # stable: outline order kept
    return PlanTimelineOut(milestones=milestones, summaries=summaries)
