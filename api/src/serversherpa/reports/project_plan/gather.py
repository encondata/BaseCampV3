"""Read an initiative's plan for the project plan PDF, the way the GET plan
route does (plans/service.py): the stored rows (`load_state`), the tasks
as the API serves them in outline order (`tasks_out`: display IDs, WBS,
outline level, predecessor text, status, assignees, baseline and
variances), the links (`links_out`), the calendar, the effective settings,
and the people's names. Nothing is recalculated; times stay floating.

The result is plain, picklable data (no ORM rows): the HTML and the PDF
are made from it in a child process (pdf.render_pdf_in_child).

The printed range is bounded here (`printed_range`): custom days are cut
to the plan's own span, and no span over MAX_PRINT_YEARS is printed."""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Client, Initiative
from serversherpa.plans import service
from serversherpa.plans.calendar import CalendarError
from serversherpa.plans.durations import Units
from serversherpa.plans.floating import format_floating, plan_now
from serversherpa.plans.models import ProjectPlan
from serversherpa.plans.schemas import PlanLinkOut, PlanTaskOut
from serversherpa.plans.service import PlanState
from serversherpa.reports.move_report.gather import InitiativeUnavailable
from serversherpa.reports.project_plan import gantt
from serversherpa.reports.project_plan.gantt import MAX_PRINT_YEARS, PrintRange


class ProjectPlanUnavailable(Exception):
    """The initiative has no plan (it was deleted after the run was queued):
    the run fails with this code."""

    code = "plan_not_found"


class PlanCalendarUnreadable(Exception):
    """The plan's stored calendar doesn't parse (plans/calendar.py)."""

    code = "bad_calendar"


TOO_LONG = f"The date range can be at most {MAX_PRINT_YEARS} years."
OUTSIDE = "The dates are outside this plan's tasks."


class PrintRangeError(Exception):
    """The range the run asks for can't be printed: `message` is the
    create_run problem (422 invalid_options), `code` the worker's failure."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def printed_range(span: PrintRange, first: str | None, last: str | None) -> PrintRange:
    """What the PDF prints: the plan's span, or the days `first` through
    `last` cut to it. PrintRangeError `range_outside_plan` when those days
    lie wholly outside the span, `range_too_long` when what's left is over
    MAX_PRINT_YEARS (a whole-project run on a plan that long, too)."""
    printed = gantt.print_range(span, first, last)
    if printed is None:
        raise PrintRangeError("range_outside_plan", OUTSIDE)
    if gantt.span_too_long(printed.start, printed.finish):
        raise PrintRangeError("range_too_long", TOO_LONG)
    return printed


def span_of(plan: ProjectPlan, state: PlanState) -> PrintRange:
    """The plan's own span: its start (or an earlier task's) to its last finish."""
    return gantt.plan_span(
        format_floating(plan.project_start), None,
        [(format_floating(t.start), format_floating(t.finish)) for t in state.tasks.values()])


@dataclass(frozen=True)
class TaskTimes:
    """A task's stored plan times (naive, the plan's wall clock), the ones
    the sheet's date columns show (plans/excel.py `cell_value`)."""
    start: datetime | None
    finish: datetime | None
    deadline: datetime | None
    constraint_date: datetime | None
    actual_start: datetime | None
    actual_finish: datetime | None
    baseline_start: datetime | None
    baseline_finish: datetime | None


@dataclass
class PlanData:
    initiative_name: str
    initiative_code: str | None
    client_name: str | None
    times: dict[uuid.UUID, TaskTimes]   # by task id
    tasks: list[PlanTaskOut]            # outline order, every task
    links: list[PlanLinkOut]
    calendar: dict                      # the plan's stored calendar JSON
    units: Units
    timezone: str                       # the plan's zone (its "now")
    show_times: bool
    project_start: str                  # floating plan times, as the API sends them
    project_finish: str | None
    span: PrintRange                    # the plan's own span (span_of)
    status_date: str | None
    now: str
    owner_name: str | None
    locked_at: datetime | None
    locked_by_name: str | None
    baseline_set_at: datetime | None
    requested_by_name: str | None


async def gather(db: AsyncSession, initiative_id: uuid.UUID,
                 requested_by: uuid.UUID | None) -> PlanData:
    """The plan of `initiative_id`. InitiativeUnavailable when the
    initiative is gone or archived, ProjectPlanUnavailable when it has no
    plan. The run was gated when it was queued (routes/reports.py)."""
    initiative = await db.get(Initiative, initiative_id)
    if initiative is None or initiative.archived_at is not None:
        raise InitiativeUnavailable(str(initiative_id))
    plan = await service.plan_of_initiative(db, initiative_id)
    if plan is None:
        raise ProjectPlanUnavailable(str(initiative_id))
    state = await service.load_state(db, plan)
    try:
        units = service.calendar_of(plan).units
    except CalendarError as exc:
        raise PlanCalendarUnreadable(str(exc)) from None
    settings = await service.settings_of(db, plan)
    tasks = await service.tasks_out(db, state)
    names = await service.person_names(db, [plan.owner_id, plan.locked_by, requested_by])
    client = await db.get(Client, initiative.client_id) if initiative.client_id else None
    finishes = [t.finish for t in state.tasks.values() if t.finish is not None]
    return PlanData(
        initiative_name=initiative.name,
        initiative_code=initiative.code,
        client_name=client.name if client else None,
        times={tid: TaskTimes(t.start, t.finish, t.deadline, t.constraint_date, t.actual_start,
                              t.actual_finish, t.baseline_start, t.baseline_finish)
               for tid, t in state.tasks.items()},
        tasks=tasks,
        links=service.links_out(state),
        calendar=plan.calendar,
        units=units,
        timezone=plan.timezone,
        show_times=settings.show_times,
        project_start=format_floating(plan.project_start),
        project_finish=format_floating(max(finishes)) if finishes else None,
        span=span_of(plan, state),
        status_date=format_floating(plan.status_date),
        now=format_floating(plan_now(plan.timezone)),
        owner_name=names.get(plan.owner_id) if plan.owner_id else None,
        locked_at=plan.locked_at,
        locked_by_name=names.get(plan.locked_by) if plan.locked_by else None,
        baseline_set_at=plan.baseline_set_at,
        requested_by_name=names.get(requested_by) if requested_by else None,
    )
