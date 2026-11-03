"""Plan imports, shared by MS Project XML (plans/mspdi.py) and Excel: a
file is parsed into a `ParsedPlan`, then `preview` (the dry run) or `apply`
answers one `ImportRow` per task of the file. The house rule for bulk
actions holds: dry run, then a per-row summary, then apply; an import
never creates people or partners.

The parsed shape (what a parser hands over):
- `ParsedTask.key` is the file's own id for the task (MSPDI's UID, the
  sheet's ID column): links and assignments name tasks by it.
  `ParsedPlan.key_label` says what it is called in messages ("UID", "ID").
- Durations and lags are minutes in `ParsedPlan.units`, the file's own
  minutes per day / week / month (None: the plan's). A working day, week
  or month count is kept when the plan's units differ, so a 2-day task
  from a file of 8-hour days is 2 days in a plan of 10-hour days; minutes,
  hours and elapsed time are kept as they are.
- `ParsedTask.start` / `finish` are the file's scheduled dates: a manual
  task keeps them, an auto task is scheduled by the plan's engine and they
  only measure how far it moved (`ImportRow.moved_days`).
- Times are floating wall-clock values (plans/floating.py), never zoned.

`apply` (`mode`: `fill` an empty plan, or `append` after its last task):
- Outline from `outline_level`: a jump of more than one level makes the
  task a subtask of the task above, with a problem.
- A link naming a task the file doesn't have, a task twice, the task
  itself, its own summary or subtask, or a finish (FF/SF) link into a
  summary is skipped with a problem; so is a lag past the 10-year cap.
- As Late As Possible becomes As Soon As Possible, a constraint without a
  date or one a summary can't have is dropped, a duration past the cap
  takes the plan's default duration: each with a problem.
- Resources are matched against the plan's resources list
  (service.resources_of) by email (person or login address), else by name,
  both ignoring case; one that matches nobody, or more than one, is a
  problem on each task it was assigned to. Nobody is ever created.
- `fill` also takes the file's calendar, when it maps cleanly onto the
  week + dated exceptions model (else the file-level problem "Kept this
  plan's calendar"), and the file's project start and status date.
- Progress is kept: % complete and actuals (above 0% an empty actual
  start is the file's start, at 100% an empty actual finish its finish;
  100% stamps the importer as who completed it). The completion rules
  are not applied: a file records what happened.

Writing: the file's rows become one `restore` op (plans/ops_inverse.py),
signed here exactly as the server signs every inverse, and run through
`ops.run_batch`: the write every ops batch makes (the restore's row
checks, the outline written and renumbered, the whole plan recalculated,
the version bumped, the deferred parent check), audited `plan_import` with
the counts. So an import is one transaction: anything the engine refuses
(a link cycle) is a 422 and nothing is written. A restore adds no one as
"newly assigned", so an import sends no assignment notices. Each list is
held to MAX_RESTORE_ROWS, the restore op's own cap.

`preview` runs the same apply inside a SAVEPOINT and rolls it back, so the
rows carry what the recalc did (`moved_days`) and nothing is written."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from fractions import Fraction

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext
from serversherpa.db.models import Initiative, Person, UserAccount
from serversherpa.plans import ops
from serversherpa.plans.calendar import CalendarError, WorkCalendar, clean_calendar
from serversherpa.plans.durations import (
    Duration,
    DurationError,
    Units,
    max_minutes,
    parse_duration,
)
from serversherpa.plans.engine import (
    CONSTRAINT_TYPES,
    LINK_TYPES,
    MODES,
    SUMMARY_CONSTRAINT_TYPES,
    SUMMARY_LINK_TYPES,
)
from serversherpa.plans.floating import format_floating
from serversherpa.plans.limits import MAX_RESTORE_ROWS
from serversherpa.plans.ops_inverse import sign_restore
from serversherpa.plans.schemas import ResourceOut, RestoreOp
from serversherpa.plans.service import (
    PlanState,
    calendar_error,
    calendar_of,
    err,
    resources_of,
    settings_of,
)

IMPORT_MODES = ("fill", "append")
# the most an uploaded plan file may hold (413 `file_too_large`)
MAX_FILE_BYTES = 20 * 1024 * 1024
_COLOR = re.compile(r"#[0-9a-f]{6}")
CONSTRAINT_LABELS = {
    "asap": "As Soon As Possible", "alap": "As Late As Possible",
    "snet": "Start No Earlier Than", "snlt": "Start No Later Than",
    "fnet": "Finish No Earlier Than", "fnlt": "Finish No Later Than",
    "mso": "Must Start On", "mfo": "Must Finish On",
}
KEPT_CALENDAR = "Kept this plan's calendar"


class ImportFileError(ValueError):
    """A file the import cannot read at all: answered as HTTP `status`
    {"code": code, **extra} (`bad_file` carries a `message`)."""

    def __init__(self, status: int, code: str, **extra):
        super().__init__(code)
        self.status, self.code, self.extra = status, code, extra


@dataclass
class ParsedTask:
    key: str
    name: str
    outline_level: int = 1
    duration: Duration | None = None       # None: the plan's default duration
    mode: str | None = None                # auto | manual; None: the plan's default
    is_milestone: bool = False
    start: datetime | None = None          # the file's scheduled start
    finish: datetime | None = None
    constraint_type: str = "asap"          # CONSTRAINT_TYPES, or "alap"
    constraint_date: datetime | None = None
    deadline: datetime | None = None
    percent_complete: int = 0              # 0-100
    actual_start: datetime | None = None
    actual_finish: datetime | None = None
    notes: str | None = None
    color: str | None = None               # "#rrggbb" (Excel's Color column; never MSPDI)
    resources: list[str] = field(default_factory=list)      # ParsedResource keys
    problems: list[str] = field(default_factory=list)


@dataclass
class ParsedLink:
    predecessor: str                       # task keys
    successor: str
    link_type: str = "FS"
    lag: Duration = field(default_factory=lambda: Duration(0, "d", False))


@dataclass
class ParsedResource:
    key: str
    name: str
    email: str | None = None


@dataclass
class ParsedPlan:
    calendar: dict | None = None           # a plan calendar (plans/calendar.py), unchecked
    tasks: list[ParsedTask] = field(default_factory=list)          # outline order
    links: list[ParsedLink] = field(default_factory=list)
    resources: list[ParsedResource] = field(default_factory=list)
    problems: list[str] = field(default_factory=list)              # about the whole file
    name: str | None = None
    project_start: datetime | None = None
    status_date: datetime | None = None    # what lateness is measured against
    units: Units | None = None             # what the durations and lags count in
    calendar_note: str | None = None       # why the file's calendar didn't map
    key_label: str = "ID"


@dataclass
class ImportRow:
    index: int                             # 1-based, the file's task order
    name: str
    action: str                            # "create"
    problems: list[str]
    moved_days: float | None


# --- the dry run and the apply ------------------------------------------------------


async def preview(db: AsyncSession, state: PlanState, parsed: ParsedPlan, mode: str,
                  actor: AuthContext) -> list[ImportRow]:
    """`apply` inside a SAVEPOINT that is rolled back: the rows as applying
    would answer them, the recalc measured, nothing written. The plan's
    rows touched inside the savepoint are expired by the rollback, so the
    caller reads nothing more from `state`."""
    async with db.begin_nested() as savepoint:
        rows = await apply(db, state, parsed, mode, actor)
        await savepoint.rollback()
    return rows


async def apply(db: AsyncSession, state: PlanState, parsed: ParsedPlan, mode: str,
                actor: AuthContext) -> list[ImportRow]:
    """Add the file's tasks, links and assignees to the plan in `state`
    (loaded under the plan row lock) as one ops batch; the caller commits.
    409 `plan_locked`; 409 `plan_not_empty` for `fill` on a plan with
    tasks; the engine's 422s (a link cycle) as on any batch."""
    plan = state.plan
    if mode not in IMPORT_MODES:
        raise err(422, "bad_field", field="mode")
    if plan.locked_at is not None:
        raise err(409, "plan_locked")
    if mode == "fill" and state.tasks:
        raise err(409, "plan_not_empty")
    _check_size(parsed)
    rows = [ImportRow(index=i + 1, name=task.name, action="create",
                      problems=list(task.problems), moved_days=None)
            for i, task in enumerate(parsed.tasks)]

    changes: dict = {}
    if mode == "fill":
        calendar, _problem = file_calendar(parsed)
        if calendar is not None and calendar != plan.calendar:
            plan.calendar = calendar
            changes["calendar"] = "from the file"
        for name in ("project_start", "status_date"):
            value = getattr(parsed, name)
            if value is not None and value != getattr(plan, name):
                changes[name] = {"from": format_floating(getattr(plan, name)),
                                 "to": format_floating(value)}
                setattr(plan, name, value)
    try:
        calendar = calendar_of(plan)
    except CalendarError as exc:
        raise calendar_error(exc) from None
    settings = await settings_of(db, plan)
    build = _Build(parsed=parsed, rows=rows, units=calendar.units, actor=actor,
                   default=_default_duration(settings.default_duration, calendar.units),
                   default_mode=(settings.default_task_mode
                                 if settings.default_task_mode in MODES else "auto"))
    build.outline()
    base = max((task.position for task in state.tasks.values()), default=-1) + 1
    tasks = [build.task_row(i, base + i) for i in range(len(parsed.tasks))]
    links = build.link_rows()
    assignments, assigned = await build.assignment_rows(db, plan.initiative_id)

    op = {"op": "restore", "tasks": tasks, "links": links, "assignments": assignments,
          "remove_tasks": [], "remove_links": []}
    restore = RestoreOp.model_validate({**op, "sig": sign_restore(plan.id, op)})
    problems = sum(len(row.problems) for row in rows) + len(file_problems(parsed, mode))
    run = await ops.run_batch(db, plan, [restore], actor, action="plan_import", changes={
        "mode": mode, "tasks": len(tasks), "links": len(links), "assignments": assigned,
        "problems": problems, **changes})
    build.measure(run.state, calendar)
    return rows


def file_problems(parsed: ParsedPlan, mode: str) -> list[str]:
    """The problems about the whole file: the parser's, and in `fill` mode
    why the file's calendar was not taken."""
    out = list(parsed.problems)
    if mode == "fill":
        _calendar, problem = file_calendar(parsed)
        if problem is not None:
            out.append(problem)
    return out


def summary(rows: list[ImportRow], problems: list[str]) -> dict:
    """{created, problems}: the tasks the import creates, and every problem
    (each row's and the file's)."""
    return {"created": sum(1 for row in rows if row.action == "create"),
            "problems": sum(len(row.problems) for row in rows) + len(problems)}


def file_calendar(parsed: ParsedPlan) -> tuple[dict | None, str | None]:
    """The file's calendar as the plan would store it (clean_calendar), or
    None with why it was not taken (None too when the file has none)."""
    if parsed.calendar is None:
        if parsed.calendar_note:
            return None, f"{KEPT_CALENDAR}: {parsed.calendar_note}."
        return None, None
    try:
        return clean_calendar(parsed.calendar), None
    except CalendarError as exc:
        return None, f"{KEPT_CALENDAR}: {exc}."


def _check_size(parsed: ParsedPlan) -> None:
    """The restore op's own cap on each list (MAX_RESTORE_ROWS)."""
    assigned = sum(len(task.resources) for task in parsed.tasks)
    if max(len(parsed.tasks), len(parsed.links), assigned) > MAX_RESTORE_ROWS:
        raise err(422, "too_many_rows", limit=MAX_RESTORE_ROWS)


def _default_duration(text: str, units: Units) -> Duration:
    """The settings' default duration for a task the file gives none; one
    day when the stored text does not parse (ops_tasks.default_duration)."""
    try:
        d = parse_duration(text, units)
    except DurationError:
        return Duration(units.minutes_per_day, "d", False)
    if d.minutes > max_minutes(units, d.elapsed):
        return Duration(units.minutes_per_day, "d", False)
    return d


def _half_up(value: Fraction) -> int:
    return int((value * 2 + 1) // 2)


def rescale(d: Duration, source: Units | None, target: Units) -> Duration:
    """`d`, counted in the file's units, in the plan's: the same number of
    working days, weeks or months; minutes, hours and elapsed time as they
    are."""
    if source is None or d.elapsed or d.unit in ("m", "h"):
        return d
    have, want = source.unit_minutes(d.unit), target.unit_minutes(d.unit)
    if have == want:
        return d
    minutes = _half_up(Fraction(abs(d.minutes) * want, have))
    return Duration(-minutes if d.minutes < 0 else minutes, d.unit, d.elapsed)


def _when(moment: datetime | None) -> str | None:
    return format_floating(moment)


def _clean(text: str | None) -> str | None:
    """Text as the database takes it: no NUL (a spreadsheet cell can hold
    one; Postgres text cannot)."""
    return text.replace("\x00", "") if text else text


def _shown(text: str) -> str:
    """A value from the file as a problem names it: one line, at most 60
    characters, so a problem repeated on many rows never multiplies a huge
    value."""
    text = " ".join(text.split())
    return text if len(text) <= 60 else text[:60] + "..."


@dataclass
class _Build:
    """The restore op's rows for one import, and the problems found on the
    way (written onto `rows`)."""

    parsed: ParsedPlan
    rows: list[ImportRow]
    units: Units
    actor: AuthContext
    default: Duration
    default_mode: str
    parents: list[int | None] = field(default_factory=list)
    # each task's last subtask (itself when it has none): a subtree is a
    # run of rows in outline order, so "is an ancestor" is a range check
    last: list[int] = field(default_factory=list)
    summaries: set[int] = field(default_factory=set)
    ids: list[uuid.UUID] = field(default_factory=list)

    # --- the outline ---

    def outline(self) -> None:
        """Each task's parent (an index into the file's tasks) from its
        outline level: the nearest task above one level up. A level more
        than one below the task above is placed right under that task."""
        tasks = self.parsed.tasks
        self.ids = [uuid.uuid4() for _ in tasks]
        stack: list[tuple[int, int]] = []       # (level, index) of the open ancestors
        previous = 0
        for i, task in enumerate(tasks):
            level = max(task.outline_level, 1)
            if level > previous + 1:
                if previous == 0:
                    self.rows[i].problems.append(
                        f"Outline level {task.outline_level} has no task above it; "
                        "placed at the top level.")
                else:
                    self.rows[i].problems.append(
                        f"Outline level jumps from {previous} to {task.outline_level}; "
                        "made a subtask of the task above.")
                level = previous + 1
            while stack and stack[-1][0] >= level:
                stack.pop()
            parent = stack[-1][1] if stack else None
            self.parents.append(parent)
            if parent is not None:
                self.summaries.add(parent)
            stack.append((level, i))
            previous = level
        self.last = list(range(len(tasks)))
        for i in reversed(range(len(tasks))):
            parent = self.parents[i]
            if parent is not None:
                self.last[parent] = max(self.last[parent], self.last[i])

    def _within(self, index: int, root: int) -> bool:
        """True when task `index` is a subtask (at any depth) of `root`."""
        return root < index <= self.last[root]

    # --- tasks ---

    def task_row(self, i: int, position: int) -> dict:
        task, problems = self.parsed.tasks[i], self.rows[i].problems
        summary = i in self.summaries
        mode = task.mode if task.mode in MODES else self.default_mode
        duration = self._duration(task, problems)
        row = {
            "id": str(self.ids[i]),
            "parent_id": str(self.ids[self.parents[i]]) if self.parents[i] is not None else None,
            "position": position,
            "name": _clean(task.name),
            "is_milestone": task.is_milestone,
            "mode": mode,
            "duration_unit": duration.unit,
            "elapsed": duration.elapsed,
            "notes": _clean(task.notes) or None,
            # a new task's default (ops_tasks.edit_task): milestones show
            "show_on_timeline": task.is_milestone,
            "color": self._color(task, problems),
            **self._constraint(task, summary, problems),
        }
        if task.deadline is not None:
            row["deadline"] = _when(task.deadline)
        if summary:
            return row              # its duration, dates and progress are its subtasks'
        row["duration_minutes"] = duration.minutes
        if mode == "manual":
            start, finish = task.start, task.finish
            if start is not None and finish is not None and finish < start:
                problems.append("Finish is before Start; Finish ignored.")
                finish = None
            row["start"], row["finish"] = _when(start), _when(finish)
        row.update(self._progress(task, problems))
        return row

    def _duration(self, task: ParsedTask, problems: list[str]) -> Duration:
        if task.duration is None:
            return self.default
        d = rescale(task.duration, self.parsed.units, self.units)
        if not 0 <= d.minutes <= max_minutes(self.units, d.elapsed):
            problems.append("Duration is over 10 years; used the default duration.")
            return self.default
        return d

    @staticmethod
    def _color(task: ParsedTask, problems: list[str]) -> str | None:
        if task.color is None:
            return None
        color = task.color.strip().lower()
        if not _COLOR.fullmatch(color):
            problems.append("Color isn't #rrggbb; no color.")
            return None
        return color

    @staticmethod
    def _constraint(task: ParsedTask, summary: bool, problems: list[str]) -> dict:
        kind, moment = task.constraint_type, task.constraint_date
        label = CONSTRAINT_LABELS.get(kind, kind)
        if kind == "alap":
            problems.append("As Late As Possible isn't supported; "
                            "scheduled As Soon As Possible.")
            kind = "asap"
        elif kind not in CONSTRAINT_TYPES:
            problems.append("The constraint isn't known; scheduled As Soon As Possible.")
            kind = "asap"
        elif kind != "asap" and moment is None:
            problems.append(f"{label} has no date; scheduled As Soon As Possible.")
            kind = "asap"
        elif summary and kind not in SUMMARY_CONSTRAINT_TYPES:
            problems.append(f"A summary task can't be {label}; "
                            "scheduled As Soon As Possible.")
            kind = "asap"
        return {"constraint_type": kind,
                "constraint_date": None if kind == "asap" else _when(moment)}

    def _progress(self, task: ParsedTask, problems: list[str]) -> dict:
        percent = min(max(task.percent_complete, 0), 100)
        first, last = task.actual_start, task.actual_finish
        if percent > 0 and first is None:
            first = task.start
        if percent == 100 and last is None:
            last = task.finish
        if first is not None and last is not None and last < first:
            problems.append("Actual Finish is before Actual Start; Actual Finish ignored.")
            last = None
        out = {"percent_complete": percent, "actual_start": _when(first),
               "actual_finish": _when(last)}
        if percent == 100:
            out["completed_at"] = datetime.now(UTC).isoformat()
            out["completed_by"] = str(self.actor.person.id)
        return out

    # --- links ---

    def link_rows(self) -> list[dict]:
        index: dict[str, int] = {}
        for i, task in enumerate(self.parsed.tasks):
            index.setdefault(task.key, i)
        label = self.parsed.key_label
        pairs: set[tuple[int, int]] = set()
        out = []
        for link in self.parsed.links:
            succ = index.get(link.successor)
            if succ is None:
                continue                    # its task isn't imported (never in a parsed file)
            problems = self.rows[succ].problems
            pred = index.get(link.predecessor)
            name = f"{label} {_shown(link.predecessor)}"
            if pred is None:
                problems.append(f"Predecessor {name} isn't in the file; link skipped.")
                continue
            if pred == succ:
                problems.append("A task can't be its own predecessor; link skipped.")
                continue
            if (pred, succ) in pairs:
                problems.append(f"Predecessor {name} is listed twice; kept the first link.")
                continue
            if self._within(succ, pred) or self._within(pred, succ):
                problems.append(f"Predecessor {name} is this task's own summary task or "
                                "subtask; link skipped.")
                continue
            link_type = link.link_type if link.link_type in LINK_TYPES else "FS"
            if succ in self.summaries and link_type not in SUMMARY_LINK_TYPES:
                problems.append(f"A summary task can't take a {link_type} link; "
                                f"link from {name} skipped.")
                continue
            lag = rescale(link.lag, self.parsed.units, self.units)
            if abs(lag.minutes) > max_minutes(self.units, lag.elapsed):
                problems.append(f"The lag from {name} is over 10 years; used no lag.")
                lag = Duration(0, lag.unit, lag.elapsed)
            pairs.add((pred, succ))
            out.append({"id": str(uuid.uuid4()), "predecessor_id": str(self.ids[pred]),
                        "successor_id": str(self.ids[succ]), "link_type": link_type,
                        "lag_minutes": lag.minutes, "lag_unit": lag.unit,
                        "lag_elapsed": lag.elapsed})
        return out

    # --- assignees ---

    async def assignment_rows(self, db: AsyncSession, initiative_id: uuid.UUID
                              ) -> tuple[list[dict], int]:
        """The restore's assignment entries, and how many assignees they
        add. Matched against the plan's resources; never creates anyone."""
        if not any(task.resources for task in self.parsed.tasks):
            return [], 0
        initiative = await db.get(Initiative, initiative_id)
        match = await _Matcher.of(db, await resources_of(db, initiative))
        by_key = {res.key: res for res in self.parsed.resources}
        entries, count = [], 0
        for i, task in enumerate(self.parsed.tasks):
            keys: dict[tuple[str, uuid.UUID], None] = {}
            for res_key in dict.fromkeys(task.resources):
                resource = by_key.get(res_key)
                if resource is None:
                    continue
                found, problem = match(resource)
                if problem is not None:
                    self.rows[i].problems.append(problem)
                else:
                    keys[found] = None
            if keys:
                entries.append({"task_id": str(self.ids[i]), "resources": [
                    {"kind": kind, "id": str(rid)} for kind, rid in keys]})
                count += len(keys)
        return entries, count

    # --- after the recalc ---

    def measure(self, state: PlanState, calendar: WorkCalendar) -> None:
        """`moved_days` on each auto task the plan schedules more than one
        working day from the file's start (signed working days)."""
        per_day = calendar.units.minutes_per_day
        for i, task in enumerate(self.parsed.tasks):
            row = state.tasks.get(self.ids[i])
            if (i in self.summaries or task.start is None or row is None
                    or row.mode != "auto" or row.start is None):
                continue
            try:
                minutes = calendar.work_between(task.start, row.start)
            except CalendarError:
                continue
            if abs(minutes) > per_day:
                self.rows[i].moved_days = round(minutes / per_day, 2)


class _Matcher:
    """Finds a file's resource on the plan's resources list: by email (a
    person's contact or login address), else by name, ignoring case."""

    def __init__(self, by_name: dict, by_email: dict):
        self.by_name, self.by_email = by_name, by_email

    @classmethod
    async def of(cls, db: AsyncSession, resources: list[ResourceOut]) -> _Matcher:
        by_name: dict[str, list[ResourceOut]] = {}
        for res in resources:
            by_name.setdefault(res.name.strip().casefold(), []).append(res)
        people = {res.id: res for res in resources if res.kind == "person"}
        by_email: dict[str, list[ResourceOut]] = {}
        if people:
            rows = (await db.execute(
                select(Person.id, Person.email, UserAccount.email)
                .outerjoin(UserAccount, UserAccount.person_id == Person.id)
                .where(Person.id.in_(list(people))))).all()
            for person_id, *emails in rows:
                for email in {e.strip().casefold() for e in emails if e}:
                    by_email.setdefault(email, []).append(people[person_id])
        return cls(by_name, by_email)

    def __call__(self, resource: ParsedResource
                 ) -> tuple[tuple[str, uuid.UUID] | None, str | None]:
        found = self.by_email.get(resource.email.strip().casefold(), []) \
            if resource.email else []
        if not found:
            found = self.by_name.get(resource.name.strip().casefold(), [])
        if len(found) == 1:
            return (found[0].kind, found[0].id), None
        if found:
            return None, (f"{_shown(resource.name)} matches more than one of this plan's "
                          "resources; not assigned.")
        return None, f"{_shown(resource.name)} isn't one of this plan's resources; not assigned."
