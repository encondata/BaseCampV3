"""The plan service: load a plan's rows, run the engine over them, persist
what it computed, and serialize the plan for the API. Every plan write path
(api/routes/plans.py, plans/ops.py) is built on it:

    plan = await plan_for_actor(db, plan_id, actor, lock=True)
    state = await load_state(db, plan)
    ... change rows in `state` ...
    renumber(state)                      # after any outline change
    changed = recalc(state, await settings_of(db, plan))
    await db.commit()

Visibility: a plan is reachable only through its initiative, so every
lookup applies the initiatives scope (`scope_conditions`) and answers 404
for anything the actor cannot see, never 403. The `project_plans` resource
is global-only (`visible_to={"global"}`), so today that scope is always
open; the check keeps a plan from ever being wider than its initiative.

The plan-level writes (PATCH /plans/{id}, the schedule lock, the
baseline) are in plans/plan_writes.py.

Nothing here commits; `create_plan` flushes (for the new id) and adds its
audit row to the caller's transaction."""

import copy
import dataclasses
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import exists, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resources import ACTIONS
from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext
from serversherpa.db.models import (
    Initiative,
    InitiativePerson,
    Partner,
    Person,
    PersonRole,
    Role,
    UserAccount,
)
from serversherpa.learning.codes import initiative_site_id
from serversherpa.learning.emails import ADDRESS_COLUMNS, listed_address
from serversherpa.plans.calendar import STANDARD_CALENDAR, CalendarError, WorkCalendar
from serversherpa.plans.durations import Duration, Units, format_duration, format_lag
from serversherpa.plans.engine import (
    SUMMARY_LINK_TYPES,
    EngineSettings,
    LinkIn,
    OutlineLinkError,
    ScheduleError,
    SummaryLinkError,
    TaskIn,
    schedule,
)
from serversherpa.plans.floating import format_floating, plan_now
from serversherpa.plans.models import PlanAssignment, PlanLink, PlanTask, ProjectPlan
from serversherpa.plans.predecessors import PredSpec, format_predecessors
from serversherpa.plans.schemas import (
    AssigneeOut,
    InitiativeWindow,
    PlanLinkOut,
    PlanOut,
    PlanPermissions,
    PlanTaskOut,
    ResourceOut,
)
from serversherpa.plans.settings import PlanSettings, effective, load_system
from serversherpa.services.audit import audit
from serversherpa.services.timeclock import site_zone
from serversherpa.services.timezone import DEFAULT_TIMEZONE, stored_day

# The initiative fields whose partners are plan resources (display-only:
# partners never get reminders).
PARTNER_FIELDS = (
    "shipping_partner_id",
    "origin_tech_partner_id", "origin_cable_partner_id", "origin_logistics_partner_id",
    "destination_tech_partner_id", "destination_cable_partner_id",
    "destination_logistics_partner_id",
)
GLOBAL_ANCHOR = "global"
_GROUPS = ("team", "staff", "partner")
_UNKNOWN = "(unknown)"


def err(status: int, code: str, **extra) -> HTTPException:
    """An API error: `{"code": code, **extra}` as the detail. The one helper
    every plan route and service uses."""
    return HTTPException(status_code=status, detail={"code": code, **extra})


# --- finding the plan ---------------------------------------------------------------


async def visible_initiative(db: AsyncSession, initiative_id: uuid.UUID,
                             actor: AuthContext) -> Initiative:
    """The initiative, when the actor's initiatives scope reaches it; else
    404 `initiative_not_found` (an out-of-scope id reads as nonexistent)."""
    initiative = await db.get(Initiative, initiative_id)
    if initiative is None:
        raise err(404, "initiative_not_found")
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        visible = await db.scalar(
            select(Initiative.id).where(Initiative.id == initiative_id, cond))
        if visible is None:
            raise err(404, "initiative_not_found")
    return initiative


async def plan_for_actor(db: AsyncSession, plan_id: uuid.UUID, actor: AuthContext, *,
                         lock: bool = False) -> ProjectPlan:
    """The plan, when its initiative is visible to the actor; else 404
    `plan_not_found`. `lock=True` takes the plan row `FOR UPDATE` (every
    write path does, so writes to one plan run one at a time) and re-reads
    it, so `version` is the committed one."""
    stmt = (select(ProjectPlan)
            .join(Initiative, Initiative.id == ProjectPlan.initiative_id)
            .where(ProjectPlan.id == plan_id))
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        stmt = stmt.where(cond)
    if lock:
        stmt = (stmt.with_for_update(of=ProjectPlan)
                .execution_options(populate_existing=True))
    plan = await db.scalar(stmt)
    if plan is None:
        raise err(404, "plan_not_found")
    return plan


async def plan_of_initiative(db: AsyncSession, initiative_id: uuid.UUID, *,
                             lock: bool = False) -> ProjectPlan | None:
    """The initiative's plan or None. The caller has already checked that
    the initiative is visible (`visible_initiative`)."""
    stmt = select(ProjectPlan).where(ProjectPlan.initiative_id == initiative_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    return await db.scalar(stmt)


# --- the loaded plan ----------------------------------------------------------------


@dataclass
class PlanState:
    """A plan and all of its rows, loaded for one request. Writers change
    the ORM rows in place (and add or remove them here as well as in the
    session); `recalc` and the serializers read only this.

    `order` lists every task id in outline order (by `position`; keep it
    current with `renumber` after an outline change). `assignments` has an
    entry only for tasks that have any: read it with `.get(task_id, [])`."""

    plan: ProjectPlan
    tasks: dict[uuid.UUID, PlanTask]
    links: dict[uuid.UUID, PlanLink]
    assignments: dict[uuid.UUID, list[PlanAssignment]]
    order: list[uuid.UUID]


async def load_state(db: AsyncSession, plan: ProjectPlan) -> PlanState:
    tasks = (await db.scalars(
        select(PlanTask).where(PlanTask.plan_id == plan.id)
        .order_by(PlanTask.position, PlanTask.id))).all()
    links = (await db.scalars(
        select(PlanLink).where(PlanLink.plan_id == plan.id).order_by(PlanLink.id))).all()
    rows = (await db.scalars(
        select(PlanAssignment)
        .join(PlanTask, PlanTask.id == PlanAssignment.task_id)
        .where(PlanTask.plan_id == plan.id)
        .order_by(PlanAssignment.id))).all()
    assignments: dict[uuid.UUID, list[PlanAssignment]] = {}
    for row in rows:
        assignments.setdefault(row.task_id, []).append(row)
    return PlanState(
        plan=plan,
        tasks={t.id: t for t in tasks},
        links={lk.id: lk for lk in links},
        assignments=assignments,
        order=[t.id for t in tasks],
    )


def calendar_of(plan: ProjectPlan) -> WorkCalendar:
    """The plan's own calendar. Raises CalendarError (`bad_calendar`) when
    the stored calendar is malformed."""
    return WorkCalendar.from_json(plan.calendar)


async def settings_of(db: AsyncSession, plan: ProjectPlan) -> PlanSettings:
    """The system section overlaid with the plan's own overrides."""
    return effective(await load_system(db), plan.settings)


async def system_calendar(db: AsyncSession) -> dict:
    """A private copy of the system calendar, for a new plan to own. (The
    system section shares its nested dicts with config_store.DEFAULTS, so
    storing it without a deep copy would let a plan edit change them.)"""
    stored = (await load_system(db)).get("calendar")
    return copy.deepcopy(stored if stored is not None else STANDARD_CALENDAR)


# --- outline ------------------------------------------------------------------------


def _ordered_ids(state: PlanState) -> list[uuid.UUID]:
    """`state.order`, plus (defensively) any task it is missing, last."""
    listed = [tid for tid in state.order if tid in state.tasks]
    seen = set(listed)
    rest = sorted((tid for tid in state.tasks if tid not in seen),
                  key=lambda tid: (state.tasks[tid].position, str(tid)))
    return listed + rest


def _children(state: PlanState, ordered: list[uuid.UUID]
              ) -> dict[uuid.UUID | None, list[uuid.UUID]]:
    """Each parent's direct subtasks in `ordered` order; None holds the top
    level. A parent id that is not in the plan reads as top level."""
    children: dict[uuid.UUID | None, list[uuid.UUID]] = {}
    for tid in ordered:
        parent = state.tasks[tid].parent_id
        children.setdefault(parent if parent in state.tasks else None, []).append(tid)
    return children


def _walk(children: dict[uuid.UUID | None, list[uuid.UUID]]):
    """Depth-first over the outline: (task id, WBS, outline level), each
    parent before its subtasks. A task inside a parent loop (never valid)
    is not reached."""
    stack = [(tid, str(i + 1), 1) for i, tid in enumerate(children.get(None, []))]
    stack.reverse()
    seen: set[uuid.UUID] = set()
    while stack:
        tid, wbs, level = stack.pop()
        if tid in seen:
            continue
        seen.add(tid)
        yield tid, wbs, level
        kids = children.get(tid, [])
        stack.extend((kid, f"{wbs}.{i + 1}", level + 1)
                     for i, kid in reversed(list(enumerate(kids))))


def renumber(state: PlanState) -> None:
    """Rewrite `position` 0..n-1 in outline order (each parent before its
    subtasks, siblings by their current position) and set `state.order` to
    match. Only rows whose position moves are touched."""
    rank = {tid: i for i, tid in enumerate(_ordered_ids(state))}
    by_position = sorted(state.tasks,
                         key=lambda tid: (state.tasks[tid].position, rank[tid]))
    order = [tid for tid, _wbs, _level in _walk(_children(state, by_position))]
    reached = set(order)
    order += [tid for tid in by_position if tid not in reached]
    for position, tid in enumerate(order):
        task = state.tasks[tid]
        if task.position != position:
            task.position = position
    state.order = order


@dataclass
class _Outline:
    display: dict[uuid.UUID, int]       # display ID: index + 1 in outline order
    wbs: dict[uuid.UUID, str]
    level: dict[uuid.UUID, int]
    summaries: set[uuid.UUID]


def _outline(state: PlanState) -> _Outline:
    ordered = _ordered_ids(state)
    children = _children(state, ordered)
    wbs: dict[uuid.UUID, str] = {}
    level: dict[uuid.UUID, int] = {}
    for tid, number, depth in _walk(children):
        wbs[tid], level[tid] = number, depth
    display = {tid: i + 1 for i, tid in enumerate(ordered)}
    for tid in ordered:                 # unreachable (a parent loop): numbered flat
        if tid not in wbs:
            wbs[tid], level[tid] = str(display[tid]), 1
    return _Outline(display=display, wbs=wbs, level=level,
                    summaries={tid for tid in children if tid is not None})


# --- recalc -------------------------------------------------------------------------


def recalc(state: PlanState, settings: PlanSettings) -> set[uuid.UUID]:
    """Schedule the whole plan and write the result onto the task rows:
    `start`, `finish`, `total_slack_minutes`, `is_critical` and `conflict`
    for every task, plus `duration_minutes` and `percent_complete` for a
    summary (both derived) and `duration_minutes` for a manual task (with
    both dates stored the engine returns their span, so the stored duration
    never disagrees with the dates). Returns the ids of the tasks whose
    stored values changed.

    Raises the engine's ScheduleError (`code`, `task_ids`) and CalendarError
    unchanged; the caller maps them to its response and rolls back."""
    plan = state.plan
    calendar = calendar_of(plan)
    engine_settings = EngineSettings(
        honor_constraints=settings.honor_constraints,
        critical_slack_minutes=round(
            settings.critical_slack_days * calendar.units.minutes_per_day))
    ordered = _ordered_ids(state)
    tasks_in = []
    for tid in ordered:
        task = state.tasks[tid]
        manual = task.mode == "manual"
        tasks_in.append(TaskIn(
            id=str(task.id),
            parent_id=str(task.parent_id) if task.parent_id is not None else None,
            position=task.position,
            mode=task.mode,
            duration=task.duration_minutes,
            elapsed=task.elapsed,
            is_milestone=task.is_milestone,
            constraint_type=task.constraint_type,
            constraint_date=task.constraint_date,
            deadline=task.deadline,
            # the engine reads stored dates for manual tasks only
            start=task.start if manual else None,
            finish=task.finish if manual else None,
            actual_start=task.actual_start,
            actual_finish=task.actual_finish,
            percent_complete=task.percent_complete,
        ))
    links_in = [LinkIn(predecessor_id=str(lk.predecessor_id),
                       successor_id=str(lk.successor_id),
                       link_type=lk.link_type, lag=lk.lag_minutes,
                       lag_elapsed=lk.lag_elapsed)
                for lk in state.links.values()]
    out = schedule(tasks_in, links_in, calendar, plan.project_start, engine_settings)

    changed: set[uuid.UUID] = set()
    for tid in ordered:
        task, result = state.tasks[tid], out[str(tid)]
        values = {
            "start": result.start,
            "finish": result.finish,
            "total_slack_minutes": result.total_slack,
            "is_critical": result.is_critical,
            "conflict": result.conflict,
        }
        if result.is_summary or task.mode == "manual":
            values["duration_minutes"] = result.duration
        if result.is_summary:
            values["percent_complete"] = result.percent_complete
        for key, value in values.items():
            if getattr(task, key) != value:
                setattr(task, key, value)
                changed.add(tid)
    return changed


def calendar_error(exc: CalendarError) -> HTTPException:
    """422 with the calendar's code (`bad_calendar`, `no_working_time`)
    and its message, which names the setting or the moment at fault."""
    return err(422, exc.code, message=str(exc))


def _ancestors(state: PlanState, task_id: uuid.UUID) -> set[uuid.UUID]:
    """The task's summaries, up to the top level."""
    out: set[uuid.UUID] = set()
    current = state.tasks[task_id].parent_id
    while current is not None and current not in out:
        out.add(current)
        current = state.tasks[current].parent_id
    return out


def schedule_error(state: PlanState, exc: ScheduleError) -> HTTPException:
    """422 with the engine's code, the tasks at fault and their display IDs
    in the outline the write built (sorted). A link the outline cannot keep
    is named as well (`link_ids`): one a summary cannot take (a task that
    becomes a summary keeps its finish links, and the batch fails rather
    than drop one), or one joining a task to its own summary or subtask
    (link 1 -> 2, then indent 2 under 1)."""
    display = {str(tid): i + 1 for i, tid in enumerate(state.order)}
    extra = {}
    if isinstance(exc, SummaryLinkError):
        parents = {t.parent_id for t in state.tasks.values() if t.parent_id is not None}
        extra["link_ids"] = sorted(
            str(lk.id) for lk in state.links.values()
            if lk.successor_id in parents and lk.link_type not in SUMMARY_LINK_TYPES)
    elif isinstance(exc, OutlineLinkError):
        extra["link_ids"] = sorted(
            str(lk.id) for lk in state.links.values()
            if lk.predecessor_id in _ancestors(state, lk.successor_id)
            or lk.successor_id in _ancestors(state, lk.predecessor_id))
    return err(422, exc.code, task_ids=list(exc.task_ids),
               display_ids=sorted(display[t] for t in exc.task_ids if t in display), **extra)


# --- create -------------------------------------------------------------------------


async def plan_zone(db: AsyncSession, initiative: Initiative) -> str:
    """A new plan's timezone: its initiative's site zone (own site, else
    destination, else origin), else the house default."""
    zone = await site_zone(db, initiative_site_id(initiative), fallback=DEFAULT_TIMEZONE)
    return zone.key


async def create_plan(db: AsyncSession, initiative: Initiative, actor: AuthContext, *,
                      project_start: datetime, owner_id: uuid.UUID | None) -> ProjectPlan:
    """A new, empty plan for the initiative: the site's zone, its own copy
    of the system calendar, no overrides, version 1. Flushed (so it has an
    id) and audited (`plan_create`); the caller commits. A second plan for
    the same initiative fails the flush on `project_plans_initiative_id_key`."""
    plan = ProjectPlan(
        initiative_id=initiative.id,
        timezone=await plan_zone(db, initiative),
        project_start=project_start,
        calendar=await system_calendar(db),
        settings={},
        owner_id=owner_id,
        version=1,
        created_by=actor.person.id,
        updated_by=actor.person.id,
    )
    db.add(plan)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="project_plan", entity_id=str(plan.id),
          action="plan_create",
          changes={"initiative_id": str(initiative.id),
                   "project_start": format_floating(project_start),
                   "timezone": plan.timezone,
                   "owner_id": str(owner_id) if owner_id is not None else None})
    return plan


# --- resources ----------------------------------------------------------------------


def _name(preferred: str | None, first: str, last: str) -> str:
    """Person.display_name from loaded columns."""
    return f"{preferred or first} {last}"


def _is_staff():
    """People holding an active role anchored `global` (staff and up)."""
    return exists().where(PersonRole.person_id == Person.id,
                          PersonRole.revoked_at.is_(None),
                          PersonRole.role == Role.name,
                          Role.scope_anchor == GLOBAL_ANCHOR)


async def is_staff(db: AsyncSession, person_id: uuid.UUID) -> bool:
    """True for a staff resource: a person (not archived) with an enabled
    portal account and an active global-anchored role. A plan owner must be
    one."""
    found = await db.scalar(
        select(Person.id).join(UserAccount, UserAccount.person_id == Person.id)
        .where(Person.id == person_id, Person.archived_at.is_(None),
               UserAccount.disabled_at.is_(None), _is_staff()))
    return found is not None


# ADDRESS_COLUMNS is (person email, login email, archived_at, disabled_at)
_PERSON_COLUMNS = (Person.id, Person.preferred_name, Person.first_name, Person.last_name,
                   UserAccount.person_id, *ADDRESS_COLUMNS)


def _person_resource(row, group: str) -> ResourceOut:
    person_id, preferred, first, last, account_id, *address = row
    disabled_at = address[3]
    return ResourceOut(
        kind="person", id=person_id, name=_name(preferred, first, last), group=group,
        has_email=listed_address(*address) is not None,
        has_account=account_id is not None and disabled_at is None,
    )


async def resources_of(db: AsyncSession, initiative: Initiative) -> list[ResourceOut]:
    """Who a task can be assigned to: the initiative's team, then staff
    (people with an enabled portal account and an active global-anchored
    role), then the partners linked on the initiative. A person in both
    the team and staff is listed once, as team; archived people are left
    out. `has_email` uses the address a reminder would go to (contact
    email, else login email; none for a disabled account), the same rule
    as learning/emails.address_for."""
    team_rows = (await db.execute(
        select(*_PERSON_COLUMNS)
        .join(InitiativePerson, InitiativePerson.person_id == Person.id)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(InitiativePerson.initiative_id == initiative.id,
               Person.archived_at.is_(None)))).all()
    staff_rows = (await db.execute(
        select(*_PERSON_COLUMNS)
        .join(UserAccount, UserAccount.person_id == Person.id)
        .where(Person.archived_at.is_(None), UserAccount.disabled_at.is_(None),
               _is_staff()))).all()

    people: dict[uuid.UUID, ResourceOut] = {}
    for rows, group in ((team_rows, "team"), (staff_rows, "staff")):
        for row in rows:
            if row[0] not in people:
                people[row[0]] = _person_resource(row, group)

    partner_ids = list(dict.fromkeys(
        pid for pid in (getattr(initiative, f) for f in PARTNER_FIELDS) if pid is not None))
    partners = []
    if partner_ids:
        for pid, name in (await db.execute(
                select(Partner.id, Partner.name).where(Partner.id.in_(partner_ids)))).all():
            partners.append(ResourceOut(kind="partner", id=pid, name=name, group="partner",
                                        has_email=False, has_account=False))

    found = [*people.values(), *partners]
    found.sort(key=lambda r: (_GROUPS.index(r.group), r.name.casefold(), str(r.id)))
    return found


# --- serialize ----------------------------------------------------------------------


async def person_names(db: AsyncSession, ids: Iterable[uuid.UUID | None]
                        ) -> dict[uuid.UUID, str]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    rows = (await db.execute(
        select(Person.id, Person.preferred_name, Person.first_name, Person.last_name)
        .where(Person.id.in_(wanted)))).all()
    return {pid: _name(preferred, first, last) for pid, preferred, first, last in rows}


async def _partner_names(db: AsyncSession, ids: Iterable[uuid.UUID | None]
                         ) -> dict[uuid.UUID, str]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    return dict((await db.execute(
        select(Partner.id, Partner.name).where(Partner.id.in_(wanted)))).all())


def status_now(plan: ProjectPlan) -> datetime:
    """The plan's "now": its status date when set, else the current time in
    the plan's zone. Lateness, Mark on Track and Update project read it."""
    return plan.status_date if plan.status_date is not None else plan_now(plan.timezone)


def task_status(task: PlanTask, now: datetime) -> str:
    """`complete` at 100%; else `late` when its finish (or its deadline,
    when set and earlier) is before `now`; else `in_progress` once started;
    else `not_started`."""
    if task.percent_complete >= 100:
        return "complete"
    due = task.finish
    if task.deadline is not None and (due is None or task.deadline < due):
        due = task.deadline
    if due is not None and due < now:
        return "late"
    if task.percent_complete > 0 or task.actual_start is not None:
        return "in_progress"
    return "not_started"


def _lag(link: PlanLink) -> Duration:
    return Duration(link.lag_minutes, link.lag_unit, link.lag_elapsed)


def links_out(state: PlanState, link_ids: Iterable[uuid.UUID] | None = None
              ) -> list[PlanLinkOut]:
    """The plan's links (or just `link_ids`) for the API."""
    units = calendar_of(state.plan).units
    ids = state.links if link_ids is None else [i for i in link_ids if i in state.links]
    return [_link_out(state.links[lid], units) for lid in ids]


def _link_out(link: PlanLink, units: Units) -> PlanLinkOut:
    return PlanLinkOut(
        id=link.id, predecessor_id=link.predecessor_id, successor_id=link.successor_id,
        link_type=link.link_type, lag_minutes=link.lag_minutes, lag_unit=link.lag_unit,
        lag_elapsed=link.lag_elapsed, lag_text=format_lag(_lag(link), units))


async def tasks_out(db: AsyncSession, state: PlanState,
                    task_ids: Iterable[uuid.UUID] | None = None) -> list[PlanTaskOut]:
    """The plan's tasks in outline order (or just `task_ids`, still in
    outline order) for the API. Display IDs, WBS and predecessor text are
    always computed over the whole plan."""
    plan = state.plan
    outline = _outline(state)
    ordered = _ordered_ids(state)
    if task_ids is not None:
        wanted = set(task_ids)
        ordered = [tid for tid in ordered if tid in wanted]
    units = calendar_of(plan).units
    now = status_now(plan)

    into: dict[uuid.UUID, list[PlanLink]] = {}
    out_of: dict[uuid.UUID, list[PlanLink]] = {}
    for link in state.links.values():
        into.setdefault(link.successor_id, []).append(link)
        out_of.setdefault(link.predecessor_id, []).append(link)

    assigned = [a for tid in ordered for a in state.assignments.get(tid, [])]
    people = await person_names(
        db, [a.person_id for a in assigned]
        + [state.tasks[tid].completed_by for tid in ordered])
    partners = await _partner_names(db, [a.partner_id for a in assigned])

    def link_text(links: list[PlanLink], other_end) -> str:
        specs = [PredSpec(outline.display[other_end(lk)], lk.link_type, _lag(lk))
                 for lk in links if other_end(lk) in outline.display]
        return format_predecessors(sorted(specs, key=lambda s: s.display_id), units)

    def assignee(a: PlanAssignment) -> AssigneeOut:
        if a.person_id is not None:
            return AssigneeOut(kind="person", id=a.person_id,
                               name=people.get(a.person_id, _UNKNOWN))
        return AssigneeOut(kind="partner", id=a.partner_id,
                           name=partners.get(a.partner_id, _UNKNOWN))

    result = []
    for tid in ordered:
        task = state.tasks[tid]
        assignees = sorted((assignee(a) for a in state.assignments.get(tid, [])),
                           key=lambda x: (x.kind != "person", x.name.casefold(), str(x.id)))
        result.append(PlanTaskOut(
            id=task.id,
            display_id=outline.display[tid],
            wbs=outline.wbs[tid],
            outline_level=outline.level[tid],
            parent_id=task.parent_id,
            position=task.position,
            is_summary=tid in outline.summaries,
            name=task.name,
            is_milestone=task.is_milestone,
            mode=task.mode,
            duration_minutes=task.duration_minutes,
            duration_unit=task.duration_unit,
            elapsed=task.elapsed,
            duration_text=format_duration(
                Duration(task.duration_minutes, task.duration_unit, task.elapsed), units),
            start=format_floating(task.start),
            finish=format_floating(task.finish),
            constraint_type=task.constraint_type,
            constraint_date=format_floating(task.constraint_date),
            deadline=format_floating(task.deadline),
            percent_complete=task.percent_complete,
            actual_start=format_floating(task.actual_start),
            actual_finish=format_floating(task.actual_finish),
            notes=task.notes,
            show_on_timeline=task.show_on_timeline,
            total_slack_minutes=task.total_slack_minutes,
            is_critical=task.is_critical,
            conflict=task.conflict,
            baseline_start=format_floating(task.baseline_start),
            baseline_finish=format_floating(task.baseline_finish),
            baseline_duration_minutes=task.baseline_duration_minutes,
            completed_at=task.completed_at,
            completed_by_name=people.get(task.completed_by) if task.completed_by else None,
            predecessors=link_text(into.get(tid, []), lambda lk: lk.predecessor_id),
            successors=link_text(out_of.get(tid, []), lambda lk: lk.successor_id),
            assignees=assignees,
            status=task_status(task, now),
            missed_deadline=(task.deadline is not None and task.finish is not None
                             and task.finish > task.deadline),
            updated_at=task.updated_at,
        ))
    return result


def _day(value: datetime | None) -> str | None:
    return stored_day(value).isoformat() if value is not None else None


async def plan_out(db: AsyncSession, state: PlanState, actor: AuthContext) -> PlanOut:
    """The whole plan as GET /initiatives/{id}/plan serves it: stored
    values (no recalc), plus the effective settings, the actor's
    permissions and the resource list."""
    plan = state.plan
    initiative = await db.get(Initiative, plan.initiative_id)
    settings = await settings_of(db, plan)
    names = await person_names(db, [plan.owner_id, plan.locked_by])
    finishes = [t.finish for t in state.tasks.values() if t.finish is not None]
    return PlanOut(
        id=plan.id,
        initiative_id=plan.initiative_id,
        initiative_name=initiative.name,
        initiative_window=InitiativeWindow(start=_day(initiative.scheduled_start),
                                           end=_day(initiative.scheduled_end)),
        timezone=plan.timezone,
        project_start=format_floating(plan.project_start),
        project_finish=format_floating(max(finishes)) if finishes else None,
        status_date=format_floating(plan.status_date),
        now=format_floating(plan_now(plan.timezone)),
        calendar=plan.calendar,
        settings_overrides=plan.settings or {},
        settings=dataclasses.asdict(settings),
        owner_id=plan.owner_id,
        owner_name=names.get(plan.owner_id) if plan.owner_id else None,
        locked_at=plan.locked_at,
        locked_by_name=names.get(plan.locked_by) if plan.locked_by else None,
        baseline_set_at=plan.baseline_set_at,
        version=plan.version,
        permissions=PlanPermissions(
            **{action: actor.access.can("project_plans", action) for action in ACTIONS}),
        tasks=await tasks_out(db, state),
        links=links_out(state),
        resources=await resources_of(db, initiative),
    )
