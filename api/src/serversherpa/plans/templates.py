"""Plan templates (spec Templates): a plan's structure saved under a name,
and new plans made from it.

A template's `data` (plan_templates.data, jsonb) is version 1:

    {"version": 1, "calendar": {...}, "settings": {...overrides...},
     "tasks": [{"key", "parent_key", "name", "duration_minutes",
                "duration_unit", "elapsed", "mode", "is_milestone",
                "constraint_type", "constraint_offset", "deadline_offset",
                "start_offset", "finish_offset", "notes",
                "show_on_timeline", "color"}, ...],     # outline order
     "links": [{"from", "to", "link_type", "lag_minutes", "lag_unit",
                "lag_elapsed"}, ...]}

Every time is an offset: whole wall-clock minutes from the plan's project
start (a floating time, plans/floating.py), so a template applied to a
project starting a week later has every deadline and constraint date a week
later. `start_offset` / `finish_offset` are kept for manual tasks only (an
auto task's dates are the engine's). A task's `key` is its display ID in
the saved plan, as text. Never assignees, progress, actuals, completion
stamps or the baseline. The settings overrides are copied as they are; of
the calendar, the working week, the hours and units and the default times,
never its dated exceptions (holidays are dates, not structure): a plan made
from a template takes the system calendar's exceptions (`plan_calendar`).

`check` and `instantiate` refuse data they can't apply (TemplateError,
`bad_template`) before anything is added: a parent must be a task listed
before it (so no parent loop can be written), link types and units are the
ones the tables take, a pair is linked once, and there are at most
MAX_RESTORE_ROWS tasks and links. The caller recalculates
(plans/service.py, create_plan)."""

from __future__ import annotations

import copy
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.plans.calendar import WorkCalendar
from serversherpa.plans.durations import UNITS, Units, max_minutes
from serversherpa.plans.engine import CONSTRAINT_TYPES, LINK_TYPES, MODES
from serversherpa.plans.limits import MAX_RESTORE_ROWS
from serversherpa.plans.models import PlanLink, PlanTask, ProjectPlan

if TYPE_CHECKING:
    from serversherpa.plans.service import PlanState

VERSION = 1
# the house rule for a saved item's name and description (report
# definitions: ReportDefinitionUpdateIn)
MAX_NAME = 120
MAX_DESCRIPTION = 1000
_MINUTE = timedelta(minutes=1)
# plan_tasks.color's CHECK (migration 0110)
_COLOR = re.compile(r"#[0-9a-f]{6}")


class TemplateError(ValueError):
    """Stored template data this code cannot apply (`bad_template`)."""

    code = "bad_template"


def _offset(moment: datetime | None, start: datetime) -> int | None:
    """Whole wall-clock minutes from `start` to `moment` (signed)."""
    if moment is None:
        return None
    return (moment - start) // _MINUTE


def _whole(value, what: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TemplateError(f"{what} is not a whole number")
    return value


def _at(offset, start: datetime) -> datetime | None:
    if offset is None:
        return None
    return start + timedelta(minutes=_whole(offset, "an offset"))


def _one_of(value, allowed: tuple[str, ...], what: str) -> str:
    if value not in allowed:
        raise TemplateError(f"unknown {what}")
    return value


def _text(value, what: str, *, optional: bool = False) -> str | None:
    if value is None and optional:
        return None
    if not isinstance(value, str):
        raise TemplateError(f"{what} is not text")
    return value


def _structure(calendar: dict) -> dict:
    """The calendar a template keeps: everything but the dated exceptions."""
    return {key: copy.deepcopy(value) for key, value in calendar.items() if key != "exceptions"}


def plan_calendar(data: dict, system: dict) -> dict:
    """A new plan's calendar from a template: the template's working week,
    hours, units and default times with the system calendar's exceptions
    (`system`: the system calendar as stored)."""
    return {**_structure(data["calendar"]),
            "exceptions": copy.deepcopy(system.get("exceptions") or [])}


def snapshot(state: PlanState) -> dict:
    """The plan in `state` as template data (the module docstring's shape),
    tasks in outline order and links in successor, then predecessor, order."""
    plan = state.plan
    start = plan.project_start
    order = [tid for tid in state.order if tid in state.tasks]
    keys = {tid: str(i + 1) for i, tid in enumerate(order)}
    tasks = []
    for tid in order:
        task = state.tasks[tid]
        manual = task.mode == "manual"
        tasks.append({
            "key": keys[tid],
            "parent_key": keys.get(task.parent_id) if task.parent_id is not None else None,
            "name": task.name,
            "duration_minutes": task.duration_minutes,
            "duration_unit": task.duration_unit,
            "elapsed": task.elapsed,
            "mode": task.mode,
            "is_milestone": task.is_milestone,
            "constraint_type": task.constraint_type,
            "constraint_offset": _offset(task.constraint_date, start),
            "deadline_offset": _offset(task.deadline, start),
            "start_offset": _offset(task.start, start) if manual else None,
            "finish_offset": _offset(task.finish, start) if manual else None,
            "notes": task.notes,
            "show_on_timeline": task.show_on_timeline,
            "color": task.color,
        })
    rank = {tid: i for i, tid in enumerate(order)}
    links = sorted((lk for lk in state.links.values()
                    if lk.predecessor_id in keys and lk.successor_id in keys),
                   key=lambda lk: (rank[lk.successor_id], rank[lk.predecessor_id]))
    return {
        "version": VERSION,
        "calendar": _structure(plan.calendar),
        "settings": copy.deepcopy(plan.settings or {}),
        "tasks": tasks,
        "links": [{"from": keys[lk.predecessor_id], "to": keys[lk.successor_id],
                   "link_type": lk.link_type, "lag_minutes": lk.lag_minutes,
                   "lag_unit": lk.lag_unit, "lag_elapsed": lk.lag_elapsed}
                  for lk in links],
    }


def check(data) -> None:
    """Raise TemplateError unless `data` is a version-1 template this code
    can apply."""
    if not isinstance(data, dict) or data.get("version") != VERSION:
        raise TemplateError("not a version 1 template")
    if not isinstance(data.get("calendar"), dict):
        raise TemplateError("no calendar")
    if not isinstance(data.get("settings", {}), dict):
        raise TemplateError("bad settings")
    if not isinstance(data.get("tasks"), list) or not isinstance(data.get("links"), list):
        raise TemplateError("no tasks or links")
    # the restore op's cap: no single write adds more rows of a kind
    for kind in ("tasks", "links"):
        if len(data[kind]) > MAX_RESTORE_ROWS:
            raise TemplateError(f"more than {MAX_RESTORE_ROWS} {kind}")


async def instantiate(db: AsyncSession, plan: ProjectPlan, data: dict) -> None:
    """Add `data`'s tasks and links to the new, empty `plan` (flushed: it has
    an id), every offset counted from `plan.project_start`, the rows made
    by the plan's creator. Positions follow the template's outline order.
    The caller loads and recalculates the plan; a schedule the engine
    refuses fails there. Raises TemplateError, adding nothing, on data it
    cannot apply (a missing field, a parent or link naming no task).

    Async (the brief had a plain function) for one reason: the tasks are
    flushed before the links are added, since the unit of work does not
    order two mappers with no relationship between them and the links'
    foreign keys are checked at once."""
    check(data)
    units = WorkCalendar.from_json(plan.calendar).units     # CalendarError: the caller's
    try:
        tasks, links = _rows(plan, data, units)
    except (KeyError, TypeError, AttributeError, OverflowError):
        raise TemplateError("a task or link is missing a field") from None
    db.add_all(tasks)
    await db.flush()
    db.add_all(links)


def _rows(plan: ProjectPlan, data: dict, units: Units
          ) -> tuple[list[PlanTask], list[PlanLink]]:
    """The new rows, every value checked against what the tables take
    (migration 0110's CHECKs, and the 10-year cap every duration and lag
    has), so a bad template is a TemplateError here and never a database
    error later."""
    start = plan.project_start
    now = datetime.now(UTC)
    by = plan.created_by
    ids: dict[str, uuid.UUID] = {}
    tasks: list[PlanTask] = []
    for position, item in enumerate(data["tasks"]):
        key = str(item["key"])
        if key in ids:
            raise TemplateError("a task key is used twice")
        parent = item["parent_key"]
        # a parent is listed before its subtasks (outline order): no loops
        if parent is not None and str(parent) not in ids:
            raise TemplateError("a parent is not a task listed before it")
        duration = _whole(item["duration_minutes"], "a duration")
        if not 0 <= duration <= max_minutes(units, bool(item["elapsed"])):
            raise TemplateError("a duration is negative or over the cap")
        color = _text(item.get("color"), "a color", optional=True)
        if color is not None and not _COLOR.fullmatch(color):
            raise TemplateError("a color is not #rrggbb")
        task = PlanTask(
            id=uuid.uuid4(), plan_id=plan.id,
            parent_id=None if parent is None else ids[str(parent)], position=position,
            name=_text(item["name"], "a name"), is_milestone=bool(item["is_milestone"]),
            mode=_one_of(item["mode"], MODES, "mode"),
            duration_minutes=duration,
            duration_unit=_one_of(item["duration_unit"], UNITS, "duration unit"),
            elapsed=bool(item["elapsed"]),
            constraint_type=_one_of(item["constraint_type"], CONSTRAINT_TYPES, "constraint type"),
            constraint_date=_at(item.get("constraint_offset"), start),
            deadline=_at(item.get("deadline_offset"), start),
            start=_at(item.get("start_offset"), start),
            finish=_at(item.get("finish_offset"), start),
            percent_complete=0, notes=_text(item.get("notes"), "notes", optional=True),
            show_on_timeline=bool(item.get("show_on_timeline")), color=color,
            is_critical=False,
            created_by=by, updated_by=by, created_at=now, updated_at=now,
        )
        ids[key] = task.id
        tasks.append(task)
    links: list[PlanLink] = []
    pairs: set[tuple[uuid.UUID, uuid.UUID]] = set()
    for item in data["links"]:
        pred, succ = ids.get(str(item["from"])), ids.get(str(item["to"]))
        if pred is None or succ is None or pred == succ:
            raise TemplateError("a link names no task")
        if (pred, succ) in pairs:
            raise TemplateError("a pair of tasks is linked twice")
        pairs.add((pred, succ))
        lag = _whole(item["lag_minutes"], "a lag")
        if abs(lag) > max_minutes(units, bool(item["lag_elapsed"])):
            raise TemplateError("a lag is over the cap")
        links.append(PlanLink(
            id=uuid.uuid4(), plan_id=plan.id, predecessor_id=pred, successor_id=succ,
            link_type=_one_of(item["link_type"], LINK_TYPES, "link type"),
            lag_minutes=lag,
            lag_unit=_one_of(item["lag_unit"], UNITS, "lag unit"),
            lag_elapsed=bool(item["lag_elapsed"])))
    return tasks, links
