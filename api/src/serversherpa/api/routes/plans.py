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
from serversherpa.plans import ops, plan_writes, service
from serversherpa.plans.calendar import CalendarError, WorkCalendar
from serversherpa.plans.floating import format_floating, parse_floating
from serversherpa.plans.models import PlanTask
from serversherpa.plans.ops_progress import UpdateProjectOp
from serversherpa.plans.schemas import (
    BaselineIn,
    OpsIn,
    OpsOut,
    PlanCreateIn,
    PlanOut,
    PlanPatchIn,
    PlanVersionOut,
    UpdateProjectIn,
)
from serversherpa.plans.service import PlanState, err
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
    """One atomic batch of edits (plans/ops.py). Every restore op must carry
    the server's signature for this plan; anything but a progress-only
    batch needs an unlocked plan and `base_version` equal to its version."""
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    ops.check_restores(plan.id, body.ops)
    if not ops.is_progress_only(body.ops):
        if plan.locked_at is not None:
            raise err(409, "plan_locked")
        if body.base_version != plan.version:
            raise err(409, "plan_changed", version=plan.version)
    out = await ops.run_batch(db, plan, body.ops, actor)
    await db.commit()
    return out


@router.post("/plans/{plan_id}/update-project", response_model=OpsOut)
async def update_project(
    plan_id: uuid.UUID,
    body: UpdateProjectIn,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> OpsOut:
    """MS Project's Update Project: stores the status date (null = now)
    and, with `complete_through`, completes every incomplete leaf finishing
    by then and marks every one spanning it on track through it (never
    lowering a %), under the completion rules (plans/ops_progress.py). A
    progress edit: no version to match, and accepted on a locked plan. Its
    `inverse` puts the tasks back; the status date stays. Statuses that
    change only with the status date are not in `tasks` (UpdateProjectIn)."""
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    try:
        end_of_day = service.calendar_of(plan).default_end
    except CalendarError as exc:
        raise err(422, exc.code) from None
    moments = {}
    for name in ("status_date", "complete_through"):
        text = getattr(body, name)
        try:
            moments[name] = None if text is None else parse_floating(
                text, date_only_time=end_of_day)
        except ValueError:
            raise err(422, "bad_field", field=name) from None
    plan.status_date = moments["status_date"]
    out = await ops.run_batch(
        db, plan, [UpdateProjectOp(through=moments["complete_through"], confirm=body.confirm)],
        actor, changes={name: format_floating(value) for name, value in moments.items()})
    await db.commit()
    return out


async def _answer(db: DbSession, state: PlanState, actor: AuthContext) -> PlanOut:
    """The plan after a plan-level write, serialized inside the write's
    transaction, then committed."""
    out = await service.plan_out(db, state, actor)
    await db.commit()
    return out


@router.patch("/plans/{plan_id}", response_model=PlanOut)
async def patch_plan(
    plan_id: uuid.UUID,
    body: PlanPatchIn,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> PlanOut:
    """Plan settings: the overrides, calendar, project start, timezone,
    status date and owner (PlanPatchIn has the rules)."""
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    state = await plan_writes.patch_plan(db, plan, body, actor)
    return await _answer(db, state, actor)


@router.post("/plans/{plan_id}/lock", response_model=PlanOut)
async def lock_plan(
    plan_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> PlanOut:
    """Lock the schedule: then only progress edits (ops.is_progress_only,
    Update project) and a PATCH of the status date or owner are accepted."""
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    plan_writes.set_lock(db, plan, actor, locked=True)
    return await _answer(db, await service.load_state(db, plan), actor)


@router.delete("/plans/{plan_id}/lock", response_model=PlanOut)
async def unlock_plan(
    plan_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> PlanOut:
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    plan_writes.set_lock(db, plan, actor, locked=False)
    return await _answer(db, await service.load_state(db, plan), actor)


@router.post("/plans/{plan_id}/baseline", response_model=PlanOut)
async def set_baseline(
    plan_id: uuid.UUID,
    db: DbSession,
    body: BaselineIn | None = None,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> PlanOut:
    """Set the baseline (the one there is): every task's start, finish and
    duration. 409 `baseline_exists` {set_at} unless `replace`."""
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    state = await service.load_state(db, plan)
    plan_writes.set_baseline(db, state, actor, replace=body is not None and body.replace)
    return await _answer(db, state, actor)


@router.delete("/plans/{plan_id}/baseline", response_model=PlanOut)
async def clear_baseline(
    plan_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> PlanOut:
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    state = await service.load_state(db, plan)
    plan_writes.clear_baseline(db, state, actor)
    return await _answer(db, state, actor)


@router.get("/plans/{plan_id}/version", response_model=PlanVersionOut)
async def plan_version(
    plan_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "view"),
) -> PlanVersionOut:
    """The plan's version, polled by an open tab to notice another admin's
    change; every write bumps it."""
    plan = await service.plan_for_actor(db, plan_id, actor)
    return await plan_writes.version_out(db, plan)
