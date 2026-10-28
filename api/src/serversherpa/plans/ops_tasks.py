"""Task edits inside an ops batch (plans/ops.py runs the batch): the batch
context, the outline tree the batch edits, MS Project's rules for typed
task fields, and the add / update / delete / move / indent / outdent ops.

Rows are edited in place, and added to or removed from both the session and
the `PlanState`. While a batch runs the outline lives in `Outline`: each op
writes `parent_id` straight onto the row, and `write_outline` writes every
`position` once, before the batch recalculates.

Editing rules (spec "Editing rules that touch the engine"):
- A start typed on an auto task sets an SNET constraint at it, a finish an
  FNET one, both an SNET plus the duration between them; each answers a
  `constraint_added` notice. A date alone means the calendar's default
  start (start, start-type constraint dates, actual start) or default end
  (finish, finish-type constraint dates, deadline, actual finish).
- On a manual task the typed dates are stored: a start moves the task
  (the finish follows, the duration stays, as in MS Project), a finish
  changes the duration, both store the span; a finish before the start
  is refused. A duration moves the finish.
- A zero duration makes a milestone; a non-zero one clears the flag again
  when the milestone came from a zero duration.
- A summary's duration, dates, % complete and actuals are derived and
  cannot be typed (422 `summary_field`); a % of 100 completes it instead
  (plans/ops_progress.py).
- A task that gains its first subtask (add, move, indent, outdent) keeps
  only an ASAP or SNET constraint: any other is reset to ASAP with a
  `constraint_cleared` notice. A finish link (FF/SF) into it is left for
  the engine to refuse, never dropped."""

import uuid
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.plans.calendar import CalendarError, WorkCalendar
from serversherpa.plans.durations import Duration, DurationError, Units, parse_duration
from serversherpa.plans.engine import CONSTRAINT_TYPES, MODES, SUMMARY_CONSTRAINT_TYPES
from serversherpa.plans.floating import parse_floating
from serversherpa.plans.models import PlanTask
from serversherpa.plans.schemas import (
    AddTaskOp,
    DeleteTasksOp,
    IndentOp,
    MoveTasksOp,
    OutdentOp,
    UpdateTaskOp,
)
from serversherpa.plans.service import PlanState, err
from serversherpa.plans.settings import PlanSettings

# Durations and lags are capped at 10 years: 260 working days a year of
# the plan's own day, or 365 wall-clock days for elapsed time. The parser
# has no magnitude cap, and an absurd value only overflows later.
MAX_YEARS = 10
FINISH_CONSTRAINTS = frozenset({"fnet", "fnlt", "mfo"})
# derived on a summary task, so never typed on one
SUMMARY_FIELDS = ("duration", "start", "finish", "percent_complete",
                  "actual_start", "actual_finish")
# fields that cannot be cleared: a null is a bad value
NOT_NULL = frozenset({"name", "duration", "start", "finish", "mode", "is_milestone",
                      "constraint_type", "percent_complete", "show_on_timeline",
                      "predecessors"})
_CONSTRAINT_KEYS = frozenset({"start", "finish", "constraint_type", "constraint_date"})
_MINUTE = timedelta(minutes=1)


def bad_field(name: str) -> HTTPException:
    return err(422, "bad_field", field=name)


def unknown_task(task_id) -> HTTPException:
    return err(422, "unknown_task", task_id=str(task_id))


# --- the outline --------------------------------------------------------------------


class Outline:
    """The task tree while a batch runs: each task's parent, and each
    parent's subtasks in order (None holds the top level)."""

    def __init__(self, parent: dict[uuid.UUID, uuid.UUID | None],
                 kids: dict[uuid.UUID | None, list[uuid.UUID]]):
        self.parent = parent
        self.kids = kids

    @classmethod
    def of(cls, state: PlanState) -> "Outline":
        """From the rows: siblings by `position`, ties in `state.order`
        order. A parent that is not in the plan reads as the top level."""
        rank = {tid: i for i, tid in enumerate(state.order)}
        ordered = sorted(state.tasks, key=lambda tid: (
            state.tasks[tid].position, rank.get(tid, len(rank)), str(tid)))
        parent: dict[uuid.UUID, uuid.UUID | None] = {}
        kids: dict[uuid.UUID | None, list[uuid.UUID]] = {None: []}
        for tid in ordered:
            up = state.tasks[tid].parent_id
            up = up if up in state.tasks else None
            parent[tid] = up
            kids.setdefault(up, []).append(tid)
        return cls(parent, kids)

    def is_summary(self, task_id: uuid.UUID) -> bool:
        return bool(self.kids.get(task_id))

    def siblings(self, task_id: uuid.UUID) -> list[uuid.UUID]:
        return self.kids[self.parent[task_id]]

    def ancestors(self, task_id: uuid.UUID) -> Iterator[uuid.UUID]:
        up = self.parent.get(task_id)
        while up is not None:
            yield up
            up = self.parent.get(up)

    def is_within(self, task_id: uuid.UUID, root: uuid.UUID) -> bool:
        """True when the task is `root` or one of its subtasks."""
        return task_id == root or root in self.ancestors(task_id)

    def walk(self, roots: Iterable[uuid.UUID]) -> list[uuid.UUID]:
        """Depth first from `roots`, each parent before its subtasks."""
        out: list[uuid.UUID] = []
        stack = list(roots)
        stack.reverse()
        seen: set[uuid.UUID] = set()
        while stack:
            tid = stack.pop()
            if tid in seen:
                continue
            seen.add(tid)
            out.append(tid)
            stack.extend(reversed(self.kids.get(tid, [])))
        return out

    def order(self) -> list[uuid.UUID]:
        return self.walk(self.kids.get(None, []))

    def detach(self, task_id: uuid.UUID) -> None:
        self.kids[self.parent[task_id]].remove(task_id)

    def attach(self, task_id: uuid.UUID, parent: uuid.UUID | None,
               index: int | None = None) -> bool:
        """Puts the task under `parent` (at `index`, else last). True when
        that makes `parent` a summary."""
        siblings = self.kids.setdefault(parent, [])
        first = parent is not None and not siblings
        if index is None:
            siblings.append(task_id)
        else:
            siblings.insert(index, task_id)
        self.parent[task_id] = parent
        return first

    def forget(self, task_id: uuid.UUID) -> None:
        del self.parent[task_id]
        self.kids.pop(task_id, None)


# --- the batch ----------------------------------------------------------------------


@dataclass
class Batch:
    """One ops batch in progress."""

    db: AsyncSession
    state: PlanState
    actor_id: uuid.UUID
    settings: PlanSettings
    calendar: WorkCalendar
    now: datetime
    outline: Outline
    notices: list[dict] = field(default_factory=list)
    temp_ids: dict[str, uuid.UUID] = field(default_factory=dict)
    # the outline order when the batch began: what Predecessors text numbers
    start_order: list[uuid.UUID] = field(default_factory=list)
    # task id -> people a set_assignees op put on it (plans/ops.py works out
    # who is newly assigned once the batch is done)
    added_people: dict[uuid.UUID, set[uuid.UUID]] = field(default_factory=dict)
    # the plan's resources as (kind, id), read once on first use
    resources: set[tuple[str, uuid.UUID]] | None = None
    # progress (plans/ops_progress.py): True when an op since the last
    # recalc may have moved the stored dates (Mark on Track and Update
    # project read them)
    stale: bool = False
    # the tasks progress ops took to 100% (or asked to complete, for a
    # summary) -> whether an op that did so confirmed; the completion rules
    # run over them once every op has run
    completing: dict[uuid.UUID, bool] = field(default_factory=dict)
    # task -> (fill actual start, fill actual finish): queued by % edits,
    # filled from the batch's final schedule
    fills: dict[uuid.UUID, tuple[bool, bool]] = field(default_factory=dict)

    @property
    def units(self) -> Units:
        return self.calendar.units

    def task(self, task_id: uuid.UUID) -> PlanTask:
        """The plan's task, or 422 `unknown_task` (also for another plan's)."""
        task = self.state.tasks.get(task_id)
        if task is None:
            raise unknown_task(task_id)
        return task

    def new_task(self, task_id: uuid.UUID, **fields) -> PlanTask:
        """A new row, added to the session and the state. Every column with
        a server default is given here, so nothing is left expired (to be
        loaded) after the insert."""
        values = {
            "parent_id": None, "position": len(self.state.tasks), "name": "",
            "is_milestone": False, "mode": "auto", "duration_minutes": 0,
            "duration_unit": "d", "elapsed": False, "constraint_type": "asap",
            "percent_complete": 0, "show_on_timeline": False, "is_critical": False,
            "created_by": self.actor_id, "updated_by": self.actor_id,
            "created_at": self.now, "updated_at": self.now,
            **fields,
        }
        task = PlanTask(id=task_id, plan_id=self.state.plan.id, **values)
        self.db.add(task)
        self.state.tasks[task_id] = task
        return task


def place(b: Batch, task_id: uuid.UUID, parent: uuid.UUID | None,
          index: int | None = None) -> None:
    """Attach a (detached) task under `parent` and write its parent_id."""
    first = b.outline.attach(task_id, parent, index)
    task = b.state.tasks[task_id]
    if task.parent_id != parent:
        task.parent_id = parent
    if first:
        _became_summary(b, parent)


def _became_summary(b: Batch, task_id: uuid.UUID) -> None:
    task = b.state.tasks[task_id]
    if task.constraint_type not in SUMMARY_CONSTRAINT_TYPES:
        task.constraint_type, task.constraint_date = "asap", None
        b.notices.append({"code": "constraint_cleared", "task_id": str(task_id)})


def write_outline(b: Batch) -> None:
    """Every task's position = its index in outline order; `state.order`
    to match."""
    order = b.outline.order()
    for position, tid in enumerate(order):
        task = b.state.tasks[tid]
        if task.position != position:
            task.position = position
    b.state.order = order


def selected(b: Batch, ids: Iterable[uuid.UUID]) -> list[uuid.UUID]:
    """The tasks an outline op acts on: each once, in outline order, and
    without those inside another selected task (they go with it)."""
    wanted = dict.fromkeys(ids)
    for tid in wanted:
        b.task(tid)
    tops = [tid for tid in wanted
            if not any(up in wanted for up in b.outline.ancestors(tid))]
    rank = {tid: i for i, tid in enumerate(b.outline.order())}
    return sorted(tops, key=rank.__getitem__)


async def remove_subtrees(b: Batch, roots: list[uuid.UUID]) -> None:
    """Delete the tasks with all their subtasks, and their links and
    assignments (the database cascades; the session and the state are
    cleared here)."""
    doomed = [tid for root in roots for tid in b.outline.walk([root])]
    if not doomed:
        return
    for root in roots:
        b.outline.detach(root)
    for tid in doomed:
        b.outline.forget(tid)
    gone = set(doomed)
    state = b.state
    links = [lk for lk in state.links.values()
             if lk.predecessor_id in gone or lk.successor_id in gone]
    rows = [row for tid in doomed for row in state.assignments.get(tid, [])]
    await b.db.flush()
    await b.db.execute(delete(PlanTask).where(PlanTask.id.in_(gone))
                       .execution_options(synchronize_session=False))
    for obj in (*links, *rows, *(state.tasks[tid] for tid in doomed)):
        b.db.expunge(obj)
    for link in links:
        del state.links[link.id]
    for tid in doomed:
        del state.tasks[tid]
        state.assignments.pop(tid, None)


# --- values -------------------------------------------------------------------------


def when(b: Batch, text: str, name: str, *, end: bool) -> datetime:
    """A typed plan time; a date alone takes the calendar's default end
    (`end`) or start time."""
    clock = b.calendar.default_end if end else b.calendar.default_start
    try:
        return parse_floating(text, date_only_time=clock)
    except ValueError:
        raise bad_field(name) from None


def max_minutes(units: Units, elapsed: bool) -> int:
    if elapsed:
        return 1440 * 365 * MAX_YEARS
    return units.minutes_per_day * 260 * MAX_YEARS


def check_bound(d: Duration, units: Units, name: str) -> Duration:
    """422 `bad_duration` past the 10-year cap (a lag's either way)."""
    if abs(d.minutes) > max_minutes(units, d.elapsed):
        raise err(422, "bad_duration", field=name)
    return d


def duration_of(b: Batch, text: str, name: str = "duration") -> Duration:
    try:
        d = parse_duration(text, b.units)
    except DurationError:
        raise err(422, "bad_duration", field=name) from None
    return check_bound(d, b.units, name)


def default_duration(b: Batch) -> Duration:
    """The settings' default duration for a new task; one day when the
    stored text does not parse."""
    try:
        return check_bound(parse_duration(b.settings.default_duration, b.units),
                           b.units, "default_duration")
    except (DurationError, HTTPException):
        return Duration(b.units.minutes_per_day, "d", False)


def _after(b: Batch, task: PlanTask, start: datetime, minutes: int) -> datetime:
    """`minutes` of the task's own time after `start` (the engine's rule)."""
    if task.elapsed:
        try:
            return start + timedelta(minutes=minutes)
        except OverflowError:
            raise CalendarError("a date runs past the range the calendar can reach") from None
    return b.calendar.add_work(start, minutes)


def _span(b: Batch, task: PlanTask, start: datetime, finish: datetime) -> int:
    if task.elapsed:
        return max((finish - start) // _MINUTE, 0)
    return max(b.calendar.work_between(start, finish), 0)


def set_duration(task: PlanTask, minutes: int, unit: str | None = None,
                 elapsed: bool | None = None) -> None:
    """A new duration, with the milestone rule: zero makes a milestone, and
    non-zero clears a milestone that a zero duration made."""
    zero_milestone = task.is_milestone and task.duration_minutes == 0
    task.duration_minutes = minutes
    if unit is not None:
        task.duration_unit = unit
    if elapsed is not None:
        task.elapsed = elapsed
    if minutes == 0:
        task.is_milestone = True
    elif zero_milestone:
        task.is_milestone = False


# --- typed fields -------------------------------------------------------------------


def edit_task(b: Batch, task: PlanTask, sent: dict, *, new: bool = False) -> None:
    """Apply the fields the client sent (a None clears) to one task. The
    Predecessors text is only checked for null here: it edits links, which
    plans/ops_links.py does once the task's own fields are in. % complete
    is not one of them: it is a progress edit (plans/ops_progress.py)."""
    for name in NOT_NULL & sent.keys():
        if sent[name] is None:
            raise bad_field(name)
    if b.outline.is_summary(task.id):
        for name in SUMMARY_FIELDS:
            if name in sent:
                raise err(422, "summary_field", field=name, task_id=str(task.id))

    if "name" in sent:
        task.name = sent["name"]
    if "mode" in sent:
        if sent["mode"] not in MODES:
            raise bad_field("mode")
        task.mode = sent["mode"]
    if "duration" in sent:
        d = duration_of(b, sent["duration"])
        set_duration(task, d.minutes, d.unit, d.elapsed)
        if task.mode == "manual" and task.start is not None:
            task.finish = _after(b, task, task.start, d.minutes)
    if "start" in sent or "finish" in sent:
        _typed_dates(b, task, sent.get("start"), sent.get("finish"))
    _constraint(b, task, sent)
    if "is_milestone" in sent:
        task.is_milestone = sent["is_milestone"]
    if "deadline" in sent:
        text = sent["deadline"]
        task.deadline = None if text is None else when(b, text, "deadline", end=True)
    for name, end in (("actual_start", False), ("actual_finish", True)):
        if name in sent:
            text = sent[name]
            setattr(task, name, None if text is None else when(b, text, name, end=end))
    if ({"actual_start", "actual_finish"} & sent.keys() and task.actual_start is not None
            and task.actual_finish is not None and task.actual_finish < task.actual_start):
        raise bad_field("actual_finish")
    if "notes" in sent:
        task.notes = sent["notes"]
    if "show_on_timeline" in sent:
        task.show_on_timeline = sent["show_on_timeline"]
    if new:
        task.show_on_timeline = task.is_milestone


def _typed_dates(b: Batch, task: PlanTask, start_text: str | None,
                 finish_text: str | None) -> None:
    start = None if start_text is None else when(b, start_text, "start", end=False)
    finish = None if finish_text is None else when(b, finish_text, "finish", end=True)
    if start is not None and finish is not None and finish < start:
        raise bad_field("finish")

    if task.mode == "manual":
        if start is not None and finish is not None:
            task.start, task.finish = start, finish
            set_duration(task, _span(b, task, start, finish))
        elif start is not None:
            task.start = start
            task.finish = _after(b, task, start, task.duration_minutes)
        else:
            if task.start is not None:
                if finish < task.start:
                    raise bad_field("finish")
                set_duration(task, _span(b, task, task.start, finish))
            task.finish = finish
        return

    if start is not None:
        kind, task.constraint_date = "snet", start
        if finish is not None:
            set_duration(task, _span(b, task, start, finish))
    else:
        kind, task.constraint_date = "fnet", finish
    task.constraint_type = kind
    b.notices.append({"code": "constraint_added", "task_id": str(task.id),
                      "constraint_type": kind})


def _constraint(b: Batch, task: PlanTask, sent: dict) -> None:
    if "constraint_type" in sent:
        if sent["constraint_type"] not in CONSTRAINT_TYPES:
            raise bad_field("constraint_type")
        task.constraint_type = sent["constraint_type"]
    if "constraint_date" in sent:
        text = sent["constraint_date"]
        task.constraint_date = None if text is None else when(
            b, text, "constraint_date", end=task.constraint_type in FINISH_CONSTRAINTS)
    if _CONSTRAINT_KEYS & sent.keys():
        check_constraint(task)


def check_constraint(task: PlanTask) -> None:
    """ASAP carries no date; every other constraint needs one (the engine
    would silently ignore a dateless one)."""
    if task.constraint_type == "asap":
        task.constraint_date = None
    elif task.constraint_date is None:
        raise bad_field("constraint_date")


# --- the ops ------------------------------------------------------------------------

_ADD_FIELDS = ("duration", "start", "finish", "mode", "is_milestone", "deadline", "notes")


async def add_task(b: Batch, op: AddTaskOp) -> None:
    sent_keys = op.model_fields_set
    if op.before_id is not None:
        b.task(op.before_id)
        parent = b.outline.parent[op.before_id]
        if "parent_id" in sent_keys and op.parent_id != parent:
            raise bad_field("parent_id")
        index = b.outline.siblings(op.before_id).index(op.before_id)
    else:
        parent, index = op.parent_id, None
        if parent is not None:
            b.task(parent)
    if op.temp_id is not None and op.temp_id in b.temp_ids:
        raise bad_field("temp_id")

    mode = b.settings.default_task_mode
    task = b.new_task(uuid.uuid4(), parent_id=parent, name=op.name,
                      mode=mode if mode in MODES else "auto")
    d = default_duration(b)
    set_duration(task, d.minutes, d.unit, d.elapsed)
    place(b, task.id, parent, index)
    edit_task(b, task, {k: getattr(op, k) for k in _ADD_FIELDS if k in sent_keys}, new=True)
    if op.temp_id is not None:
        b.temp_ids[op.temp_id] = task.id


async def update_task(b: Batch, op: UpdateTaskOp) -> None:
    """The task's own fields but % complete (plans/ops.py hands that to
    plans/ops_progress.py)."""
    task = b.task(op.id)
    edit_task(b, task, {k: getattr(op.fields, k) for k in op.fields.model_fields_set
                        if k != "percent_complete"})


async def delete_tasks(b: Batch, op: DeleteTasksOp) -> None:
    await remove_subtrees(b, selected(b, op.ids))


async def move_tasks(b: Batch, op: MoveTasksOp) -> None:
    moving = selected(b, op.ids)
    if op.before_id is not None:
        b.task(op.before_id)
        target = op.before_id
        parent = b.outline.parent[op.before_id]
        if "parent_id" in op.model_fields_set and op.parent_id != parent:
            raise bad_field("parent_id")
    else:
        target = parent = op.parent_id
        if parent is not None:
            b.task(parent)
    if target is not None and any(b.outline.is_within(target, m) for m in moving):
        raise err(422, "cannot_move", task_id=str(target))
    for tid in moving:
        b.outline.detach(tid)
    index = None
    if op.before_id is not None:
        index = b.outline.kids[parent].index(op.before_id)
    for i, tid in enumerate(moving):
        place(b, tid, parent, None if index is None else index + i)


async def indent(b: Batch, op: IndentOp) -> None:
    """Each task becomes the last subtask of the sibling above it."""
    for tid in selected(b, op.ids):
        siblings = b.outline.siblings(tid)
        i = siblings.index(tid)
        if i == 0:
            raise err(422, "cannot_indent", task_id=str(tid))
        above = siblings[i - 1]
        b.outline.detach(tid)
        place(b, tid, above)


async def outdent(b: Batch, op: OutdentOp) -> None:
    """Each task moves up a level to sit right after its old parent, and
    the siblings that followed it become its subtasks (MS Project)."""
    for tid in selected(b, op.ids):
        parent = b.outline.parent[tid]
        if parent is None:
            raise err(422, "cannot_outdent", task_id=str(tid))
        siblings = b.outline.kids[parent]
        following = siblings[siblings.index(tid) + 1:]
        for sibling in following:
            b.outline.detach(sibling)
            place(b, sibling, tid)
        b.outline.detach(tid)
        above = b.outline.parent[parent]
        place(b, tid, above, b.outline.kids[above].index(parent) + 1)
