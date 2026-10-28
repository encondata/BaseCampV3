"""Plan-level writes: PATCH /plans/{id} (settings overrides, calendar,
project start, timezone, status date, owner), the schedule lock, the
baseline, the version probe, and the plans a system settings change
reschedules. Split from plans/service.py the way the ops are split into
plans/ops_*.py; built on the service's load, recalc and serialize helpers.

Each write runs on a plan the route took with `plan_for_actor(lock=True)`.
One that has nothing to change writes nothing; otherwise it bumps the
version, stamps the plan (and every task row whose stored values moved)
and adds its audit row. The caller commits, or rolls back on an error."""

import functools
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime, time
from zoneinfo import available_timezones

from fastapi import HTTPException
from pydantic import ValidationError
from pydantic_core import to_jsonable_python
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext
from serversherpa.plans.calendar import CalendarError, WorkCalendar, clean_calendar
from serversherpa.plans.durations import DurationError, max_minutes, parse_duration
from serversherpa.plans.engine import ScheduleError
from serversherpa.plans.floating import format_floating, parse_floating
from serversherpa.plans.models import ProjectPlan
from serversherpa.plans.schemas import PlanPatchIn, PlanSettingsOverrides, PlanVersionOut
from serversherpa.plans.service import (
    PlanState,
    err,
    is_staff,
    load_state,
    person_names,
    recalc,
    schedule_error,
    settings_of,
)
from serversherpa.plans.settings import effective, merge_overrides
from serversherpa.services.audit import audit


async def version_out(db: AsyncSession, plan: ProjectPlan) -> PlanVersionOut:
    """GET /plans/{id}/version: the version and who last changed the plan."""
    names = await person_names(db, [plan.updated_by])
    return PlanVersionOut(
        version=plan.version, updated_at=plan.updated_at,
        updated_by_name=names.get(plan.updated_by) if plan.updated_by else None)


# what a PATCH may still change on a locked plan (spec Lock)
LOCKED_PATCH_FIELDS = frozenset({"status_date", "owner_id"})
# the system settings the engine reads: changing one reschedules every
# plan that inherits it
SCHEDULING_KEYS = ("honor_constraints", "critical_slack_days")
# baseline column <- the task column it copies
_BASELINE = (("baseline_start", "start"), ("baseline_finish", "finish"),
             ("baseline_duration_minutes", "duration_minutes"))


def _touch(plan: ProjectPlan, actor: AuthContext, now: datetime) -> None:
    plan.version += 1
    plan.updated_at, plan.updated_by = now, actor.person.id


def _stamp(state: PlanState, task_ids: Iterable[uuid.UUID], actor: AuthContext,
           now: datetime) -> None:
    for tid in task_ids:
        task = state.tasks[tid]
        task.updated_at, task.updated_by = now, actor.person.id


def _instant(value: datetime | None) -> str | None:
    """A real instant (`locked_at`, `baseline_set_at`) as the API writes it."""
    return to_jsonable_python(value) if value is not None else None


def _logged(value):
    """A plan column as an audit row records it."""
    if isinstance(value, datetime):
        return format_floating(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    return value


@functools.cache
def _zones() -> frozenset[str]:
    return frozenset(available_timezones())


def check_zone(name: str | None) -> str:
    """A zone name exactly as the tz database lists it, else 422
    `bad_timezone`. (ZoneInfo alone is not enough: on a case-insensitive
    file system it loads `utc`, which a Linux server then cannot.)"""
    if name not in _zones():
        raise err(422, "bad_timezone")
    return name


def check_overrides(raw) -> dict:
    """A PATCH's `settings` checked as PlanSettingsOverrides: the keys sent,
    a null meaning "inherit". 422 `bad_field`, `field` naming the first bad
    key ("settings.reminders.offsets_days")."""
    if not isinstance(raw, dict):
        raise err(422, "bad_field", field="settings")
    try:
        return PlanSettingsOverrides.model_validate(raw).model_dump(exclude_unset=True)
    except ValidationError as exc:
        path = [str(part) for part in exc.errors()[0]["loc"] if isinstance(part, str)]
        raise err(422, "bad_field", field=".".join(["settings", *path])) from None


def _calendar_error(exc: CalendarError) -> HTTPException:
    return err(422, exc.code, message=str(exc))


def check_default_duration(text: str | None, calendar: dict, field: str) -> None:
    """A default duration within the 10-year cap every plan duration has,
    in the units of `calendar` (a calendar as stored): else 422 `bad_field`
    naming `field`. The schemas only parse it, since the cap depends on
    the calendar's hours a day; None (inherit) passes."""
    if text is None:
        return
    try:
        units = WorkCalendar.from_json(calendar).units
    except CalendarError as exc:
        raise _calendar_error(exc) from None
    try:
        duration = parse_duration(text, units)
    except DurationError:
        raise err(422, "bad_field", field=field) from None
    if duration.minutes > max_minutes(units, duration.elapsed):
        raise err(422, "bad_field", field=field)


def _moment(text: str | None, at: time, name: str) -> datetime:
    try:
        return parse_floating(text, date_only_time=at)
    except ValueError:
        raise err(422, "bad_field", field=name) from None


async def patch_plan(db: AsyncSession, plan: ProjectPlan, body: PlanPatchIn,
                     actor: AuthContext) -> PlanState:
    """PATCH /plans/{id} (PlanPatchIn): the lock (409 `plan_locked`), the
    version (409 `plan_changed`), every field sent checked, then the ones
    that change written, the plan recalculated (the calendar, the project
    start and the scheduling settings all move dates) and audited as
    `plan_settings` with each field's from/to. Answers the loaded plan;
    one that nothing changed is neither recalculated nor bumped."""
    sent = body.model_fields_set - {"base_version"}
    if plan.locked_at is not None and sent - LOCKED_PATCH_FIELDS:
        raise err(409, "plan_locked")
    if body.base_version != plan.version:
        raise err(409, "plan_changed", version=plan.version)

    new: dict = {}
    if "calendar" in sent:
        try:
            new["calendar"] = clean_calendar(body.calendar)
        except CalendarError as exc:
            raise _calendar_error(exc) from None
    if sent & {"project_start", "status_date"}:
        # a date alone takes its time from the calendar the plan will have
        try:
            calendar = WorkCalendar.from_json(new.get("calendar", plan.calendar))
        except CalendarError as exc:
            raise _calendar_error(exc) from None
        if "project_start" in sent:
            new["project_start"] = _moment(body.project_start, calendar.default_start,
                                           "project_start")
        if "status_date" in sent:
            new["status_date"] = None if body.status_date is None else _moment(
                body.status_date, calendar.default_end, "status_date")
    if "timezone" in sent and body.timezone != plan.timezone:
        new["timezone"] = check_zone(body.timezone)
    if "owner_id" in sent and body.owner_id != plan.owner_id:
        # an owner kept as it is stays allowed after they stop being staff
        if body.owner_id is not None and not await is_staff(db, body.owner_id):
            raise err(422, "bad_owner")
        new["owner_id"] = body.owner_id
    if "settings" in sent:
        overrides = check_overrides(body.settings)
        check_default_duration(overrides.get("default_duration"),
                               new.get("calendar", plan.calendar), "settings.default_duration")
        new["settings"] = merge_overrides(plan.settings, overrides)

    changes = {key: {"from": _logged(getattr(plan, key)), "to": _logged(value)}
               for key, value in new.items() if getattr(plan, key) != value}
    for key in changes:
        setattr(plan, key, new[key])
    state = await load_state(db, plan)
    if not changes:
        return state
    try:
        moved = recalc(state, await settings_of(db, plan))
    except ScheduleError as exc:
        raise schedule_error(state, exc) from None
    except CalendarError as exc:
        raise err(422, exc.code) from None
    now = datetime.now(UTC)
    _stamp(state, moved, actor, now)
    _touch(plan, actor, now)
    audit(db, actor_id=actor.person.id, entity_type="project_plan", entity_id=str(plan.id),
          action="plan_settings", changes=changes)
    return state


def set_lock(db: AsyncSession, plan: ProjectPlan, actor: AuthContext, *,
             locked: bool) -> None:
    """Lock the schedule (spec Lock: then only progress edits, the status
    date and the owner change) or unlock it; audit `plan_lock` /
    `plan_unlock`. Locking a locked plan, or unlocking an unlocked one,
    changes nothing."""
    if (plan.locked_at is not None) == locked:
        return
    now = datetime.now(UTC)
    at, by = (now, actor.person.id) if locked else (None, None)
    changes = {"locked_at": {"from": _instant(plan.locked_at), "to": _instant(at)},
               "locked_by": {"from": _logged(plan.locked_by), "to": _logged(by)}}
    plan.locked_at, plan.locked_by = at, by
    _touch(plan, actor, now)
    audit(db, actor_id=actor.person.id, entity_type="project_plan", entity_id=str(plan.id),
          action="plan_lock" if locked else "plan_unlock", changes=changes)


def _write_baseline(state: PlanState, value) -> set[uuid.UUID]:
    """Set each task's baseline columns to `value(task, source column)`;
    answers the tasks whose stored values changed."""
    moved = set()
    for tid, task in state.tasks.items():
        for column, source in _BASELINE:
            new = value(task, source)
            if getattr(task, column) != new:
                setattr(task, column, new)
                moved.add(tid)
    return moved


async def set_baseline(db: AsyncSession, plan: ProjectPlan, actor: AuthContext, *,
                       replace: bool) -> PlanState:
    """Copy every task's start, finish and duration into its baseline and
    record who set it when; audit `plan_baseline_set`. Answers the loaded
    plan. 409 `plan_locked` on a locked plan (the baseline is part of what
    the lock freezes); 409 `baseline_exists` {set_at} when the plan has one
    and `replace` is false. Both are refused before any task is loaded."""
    if plan.locked_at is not None:
        raise err(409, "plan_locked")
    if plan.baseline_set_at is not None and not replace:
        raise err(409, "baseline_exists", set_at=_instant(plan.baseline_set_at))
    state = await load_state(db, plan)
    now = datetime.now(UTC)
    replaced = _instant(plan.baseline_set_at)
    moved = _write_baseline(state, lambda task, source: getattr(task, source))
    plan.baseline_set_at, plan.baseline_set_by = now, actor.person.id
    _stamp(state, moved, actor, now)
    _touch(plan, actor, now)
    audit(db, actor_id=actor.person.id, entity_type="project_plan", entity_id=str(plan.id),
          action="plan_baseline_set", changes={"tasks": len(state.tasks), "replaced": replaced})
    return state


async def clear_baseline(db: AsyncSession, plan: ProjectPlan,
                         actor: AuthContext) -> PlanState:
    """Empty every task's baseline; audit `plan_baseline_clear`. Answers the
    loaded plan. 409 `plan_locked` on a locked plan, before any task is
    loaded; a plan with no baseline changes nothing."""
    if plan.locked_at is not None:
        raise err(409, "plan_locked")
    state = await load_state(db, plan)
    moved = _write_baseline(state, lambda task, source: None)
    if plan.baseline_set_at is None and not moved:
        return state
    now = datetime.now(UTC)
    cleared = _instant(plan.baseline_set_at)
    plan.baseline_set_at, plan.baseline_set_by = None, None
    _stamp(state, moved, actor, now)
    _touch(plan, actor, now)
    audit(db, actor_id=actor.person.id, entity_type="project_plan", entity_id=str(plan.id),
          action="plan_baseline_clear", changes={"set_at": cleared, "tasks": len(moved)})
    return state


async def recalc_inheriting(db: AsyncSession, before: dict, after: dict,
                            actor: AuthContext) -> int:
    """After a PUT /system/project-plans (`before` / `after`: the whole
    section): when it changed `honor_constraints` or `critical_slack_days`,
    reschedule every plan that inherits a changed key (it has no override
    of its own; locked plans too), bump its version and stamp it and the
    task rows that moved, so an open tab refreshes. Nothing when neither
    changed.

    The plan rows are locked FOR UPDATE in id order: every other writer
    locks a single plan row, so no two transactions wait on each other in
    a loop. A plan the engine refuses (ScheduleError, CalendarError) keeps
    its dates and is still bumped, since the new setting applies to it;
    its next write reports the error. Answers how many plans were bumped.
    The caller commits."""
    changed = [key for key in SCHEDULING_KEYS if before.get(key) != after.get(key)]
    if not changed:
        return 0
    inherits = or_(*(ProjectPlan.settings[key].astext.is_(None) for key in changed))
    plans = (await db.scalars(
        select(ProjectPlan).where(inherits).order_by(ProjectPlan.id)
        .with_for_update().execution_options(populate_existing=True))).all()
    now = datetime.now(UTC)
    for plan in plans:
        state = await load_state(db, plan)
        try:
            moved = recalc(state, effective(after, plan.settings))
        except (ScheduleError, CalendarError):
            moved = set()               # recalc writes nothing when the engine refuses
        _stamp(state, moved, actor, now)
        _touch(plan, actor, now)
    return len(plans)
