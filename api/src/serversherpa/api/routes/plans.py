"""Project plans: an MS Project-style schedule per initiative (spec
2026-10-27-project-plans-design). The logic lives in serversherpa.plans;
these routes check access, parse bodies and map errors.

Every route requires its `project_plans` action first, then resolves the
initiative (or the plan) through the actor's initiatives scope, so an id
the actor cannot see reads as 404, never 403."""

import uuid

from fastapi import APIRouter
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.plans import ops, service
from serversherpa.plans.calendar import WorkCalendar
from serversherpa.plans.floating import parse_floating
from serversherpa.plans.models import PlanTask
from serversherpa.plans.schemas import OpsIn, OpsOut, PlanCreateIn, PlanOut
from serversherpa.plans.service import err
from serversherpa.services.audit import audit

router = APIRouter(tags=["plans"])

PLAN_UNIQUE = "project_plans_initiative_id_key"


@router.get("/initiatives/{initiative_id}/plan", response_model=PlanOut)
async def get_plan(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "view"),
) -> PlanOut:
    await service.visible_initiative(db, initiative_id, actor)
    plan = await service.plan_of_initiative(db, initiative_id)
    if plan is None:
        raise err(404, "no_plan")
    return await service.plan_out(db, await service.load_state(db, plan), actor)


@router.post("/initiatives/{initiative_id}/plan", response_model=PlanOut, status_code=201)
async def create_plan(
    initiative_id: uuid.UUID,
    body: PlanCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "add"),
) -> PlanOut:
    initiative = await service.visible_initiative(db, initiative_id, actor)
    if await service.plan_of_initiative(db, initiative_id) is not None:
        raise err(409, "plan_exists")
    # a date-only start begins at the calendar's default start, and the new
    # plan's calendar is the system one
    calendar = WorkCalendar.from_json(await service.system_calendar(db))
    try:
        project_start = parse_floating(body.project_start,
                                       date_only_time=calendar.default_start)
    except ValueError:
        raise err(422, "bad_field", field="project_start") from None
    if body.owner_id is not None and not await service.is_staff(db, body.owner_id):
        raise err(422, "bad_owner")
    # body.template_id is accepted and unused until templates land (Plan C)
    try:
        plan = await service.create_plan(db, initiative, actor, project_start=project_start,
                                         owner_id=body.owner_id)
        await db.commit()
    except IntegrityError as exc:
        # another create for this initiative won the race
        if PLAN_UNIQUE not in str(getattr(exc, "orig", "")) and PLAN_UNIQUE not in str(exc):
            raise
        await db.rollback()
        raise err(409, "plan_exists") from None
    return await service.plan_out(db, await service.load_state(db, plan), actor)


@router.delete("/initiatives/{initiative_id}/plan", status_code=204)
async def delete_plan(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "delete"),
) -> None:
    await service.visible_initiative(db, initiative_id, actor)
    plan = await service.plan_of_initiative(db, initiative_id, lock=True)
    if plan is None:
        raise err(404, "no_plan")
    tasks = await db.scalar(
        select(func.count()).select_from(PlanTask).where(PlanTask.plan_id == plan.id))
    audit(db, actor_id=actor.person.id, entity_type="project_plan", entity_id=str(plan.id),
          action="plan_delete",
          changes={"initiative_id": str(initiative_id), "tasks": tasks})
    # tasks, links, assignments and reminder rows go with it (FK cascade)
    await db.delete(plan)
    await db.commit()


@router.post("/plans/{plan_id}/ops", response_model=OpsOut)
async def post_ops(
    plan_id: uuid.UUID,
    body: OpsIn,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> OpsOut:
    """One atomic batch of edits (plans/ops.py). Anything but a progress-only
    batch needs an unlocked plan and `base_version` equal to its version."""
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    if not ops.is_progress_only(body.ops):
        if plan.locked_at is not None:
            raise err(409, "plan_locked")
        if body.base_version != plan.version:
            raise err(409, "plan_changed", version=plan.version)
    out = await ops.run_batch(db, plan, body.ops, actor)
    await db.commit()
    return out
