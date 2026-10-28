"""Progress edits inside an ops batch (plans/ops.py runs the batch): %
complete with its actuals and completion stamps (`set_percent`, `complete`,
`update_task.fields.percent_complete`), Mark on Track, Update project, and
the completion rules (plans/completion.py) once every op has run.

A leaf's % (spec "Progress and completion checks"): above 0 an empty actual
start becomes the scheduled start; 100 fills an empty actual finish with
the scheduled finish and stamps `completed_at` / `completed_by` with the
batch's moment and actor (never a client's value); below 100 clears the
actual finish and the stamps, and 0 the actual start too. An actual on the
scheduled date moves nothing (the engine's rule), so a % edit never moves a
task, and its undo is a progress edit too. A summary's % is derived: 100
completes it, anything else is 422 `summary_field`.

Fills wait for the batch's own schedule. A % edit applies at once (the %,
the clears, the stamps) and queues its fills (`Batch.fills`: the latest
progress op on a task decides them, and a later actual edit on the task
cancels the fill of that actual). `finish` schedules the batch's final
state once and fills from it; since a fill never moves a date, the batch's
closing recalc gives the same dates. So a paste of N rows of Duration + %
schedules twice, not N times, and a state the batch passes through but
does not end in (a task that is a summary for a moment) is never
scheduled. Mark on Track and Update project read dates for their targets:
each takes one schedule when it starts (recalculating first only when an
earlier op in the batch may have moved dates: `Batch.stale`).

The completion rules run over every task the batch took to 100% (a summary:
asked to complete), whatever op did it but `restore`, which replays what
the server recorded. Each such task carries its op's `confirm`; a task
taken below 100 again later in the batch is dropped, and so is a summary
once a later op takes a leaf below it under 100 (the later op wins). Any
blocker answers 409 `completion_blocked`; else a `needs_confirm` from an op
that did not confirm answers 409 `completion_confirm`; else the summaries'
open leaves are completed too."""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime, timedelta

from serversherpa.plans.completion import SUBTASK, check_completion
from serversherpa.plans.models import PlanTask
from serversherpa.plans.ops_tasks import Batch, bad_field, write_outline
from serversherpa.plans.schemas import CompleteOp, MarkOnTrackOp, SetPercentOp, UpdateTaskOp
from serversherpa.plans.service import err, recalc, renumber, status_now

_MINUTE = timedelta(minutes=1)
# what an update_task may change without moving any dates
_DATELESS_FIELDS = frozenset({"percent_complete", "notes"})
_ACTUALS = frozenset({"actual_start", "actual_finish"})


@dataclass
class UpdateProjectOp:
    """Update project's task edits, as one op of an internal batch (the
    route sets the status date itself): every incomplete leaf finishing by
    `through` to 100%, every incomplete leaf spanning it on track through
    it, never lowering its %. Not a client op: never in `schemas.Op`."""

    through: datetime | None
    confirm: bool = False
    op: str = "update_project"


# --- the schedule ------------------------------------------------------------------


def _schedule(b: Batch) -> None:
    write_outline(b)
    renumber(b.state)
    recalc(b.state, b.settings)
    b.stale = False


def fresh(b: Batch) -> None:
    """The stored dates, recalculated first when an op since the last
    recalc may have moved them (Mark on Track and Update project only)."""
    if b.stale:
        _schedule(b)


def on_track(b: Batch, task: PlanTask, moment: datetime) -> int:
    """The % of the task scheduled by `moment`: the share of its duration
    between its start and `moment`, rounded half up; a zero-duration task
    is 100 once reached, else 0. A milestone flag on a task with a duration
    changes nothing here (MS Project schedules it as a task)."""
    start, finish = task.start, task.finish
    if task.duration_minutes == 0:
        return 100 if start <= moment else 0
    if moment >= finish:
        return 100
    if moment <= start:
        return 0
    if task.elapsed:
        worked = (moment - start) // _MINUTE
    else:
        worked = max(b.calendar.work_between(start, moment), 0)
    duration = task.duration_minutes
    return max(0, min(100, (200 * worked + duration) // (2 * duration)))


# --- one task -----------------------------------------------------------------------


def _leaf(b: Batch, task: PlanTask, percent: int, explicit: frozenset[str]) -> None:
    """A leaf's %, clears and stamps now, its fills queued. An actual named
    in `explicit` (sent by the same update_task) is left as that op set it."""
    was = task.percent_complete
    if was != percent:
        task.percent_complete = percent
    if percent == 100:
        if was < 100 or task.completed_at is None:
            task.completed_at, task.completed_by = b.now, b.actor_id
    else:
        if task.actual_finish is not None and "actual_finish" not in explicit:
            task.actual_finish = None
            b.stale = True
        if percent == 0 and task.actual_start is not None and "actual_start" not in explicit:
            task.actual_start = None
            b.stale = True
        if task.completed_at is not None or task.completed_by is not None:
            task.completed_at = task.completed_by = None
    fill = (percent > 0 and task.actual_start is None and "actual_start" not in explicit,
            percent == 100 and task.actual_finish is None and "actual_finish" not in explicit)
    if any(fill):
        b.fills[task.id] = fill
    else:
        b.fills.pop(task.id, None)


def set_task_percent(b: Batch, task_id: uuid.UUID, percent: int, confirm: bool, *,
                     explicit: frozenset[str] = frozenset()) -> None:
    """One task's % (0-100, checked by the caller): a leaf's own, or 100 on
    a summary to complete it. A task reaching 100 is noted for the
    completion rules with its op's `confirm`; a leaf set below 100 voids
    an earlier request in the batch to complete a summary above it."""
    if b.outline.is_summary(task_id):
        if percent != 100:
            raise err(422, "summary_field", field="percent_complete", task_id=str(task_id))
        _note(b, task_id, confirm)
        return
    task = b.state.tasks[task_id]
    was = task.percent_complete
    _leaf(b, task, percent, explicit)
    if percent == 100:
        if was < 100:
            _note(b, task_id, confirm)
    else:
        for up in b.outline.ancestors(task_id):
            b.completing.pop(up, None)


def _note(b: Batch, task_id: uuid.UUID, confirm: bool) -> None:
    b.completing[task_id] = b.completing.get(task_id, False) or confirm


def actuals_typed(b: Batch, task_id: uuid.UUID, names: Iterable[str]) -> None:
    """An update_task without % set these actuals: an earlier % edit's fill
    of them is cancelled (the later edit wins)."""
    fill = b.fills.get(task_id)
    if fill is None:
        return
    names = set(names)
    fill = (fill[0] and "actual_start" not in names, fill[1] and "actual_finish" not in names)
    if any(fill):
        b.fills[task_id] = fill
    else:
        del b.fills[task_id]


def forget(b: Batch, task_ids: Iterable[uuid.UUID]) -> None:
    """A restore rewrote these tasks as the server recorded them: what
    earlier ops in the batch queued for them (fills, completions) is void."""
    for tid in task_ids:
        b.fills.pop(tid, None)
        b.completing.pop(tid, None)


def _ids(b: Batch, ids: list[uuid.UUID]) -> list[uuid.UUID]:
    """Each id once, all of them the plan's (422 `unknown_task`)."""
    wanted = list(dict.fromkeys(ids))
    for tid in wanted:
        b.task(tid)
    return wanted


# --- the ops ------------------------------------------------------------------------


async def set_percent(b: Batch, op: SetPercentOp) -> None:
    if not 0 <= op.percent <= 100:
        raise bad_field("percent")
    for tid in _ids(b, op.ids):
        set_task_percent(b, tid, op.percent, op.confirm)


async def complete(b: Batch, op: CompleteOp) -> None:
    for tid in _ids(b, op.ids):
        set_task_percent(b, tid, 100, op.confirm)


def typed_percent(b: Batch, op: UpdateTaskOp) -> None:
    """`update_task.fields.percent_complete`, once the op's other fields
    and its Predecessors are in. A 100% leaf has an actual finish, so 100
    with `actual_finish: null` is 422 `bad_field`."""
    sent = op.fields.model_fields_set
    if sent - _DATELESS_FIELDS:
        b.stale = True
    percent = op.fields.percent_complete
    if percent is None or not 0 <= percent <= 100:
        raise bad_field("percent_complete")
    if percent == 100 and "actual_finish" in sent and op.fields.actual_finish is None:
        raise bad_field("actual_finish")
    set_task_percent(b, op.id, percent, op.confirm, explicit=frozenset(sent & _ACTUALS))


async def mark_on_track(b: Batch, op: MarkOnTrackOp) -> None:
    """Each task (a summary: each leaf below it, once) to its % scheduled
    by the plan's status date, else now, all read from one schedule."""
    roots = _ids(b, op.ids)
    fresh(b)
    moment = status_now(b.state.plan)
    leaves = dict.fromkeys(tid for root in roots for tid in b.outline.walk([root])
                           if not b.outline.is_summary(tid))
    targets = [(tid, on_track(b, b.state.tasks[tid], moment)) for tid in leaves]
    for tid, percent in targets:
        set_task_percent(b, tid, percent, op.confirm)


async def update_project(b: Batch, op: UpdateProjectOp) -> None:
    """Every incomplete leaf finishing by `through` to 100%; every
    incomplete leaf spanning it to its on-track % through it, unless it
    already has more. The targets are read from one schedule."""
    if op.through is None:
        return
    fresh(b)
    targets = []
    for tid in b.outline.order():
        task = b.state.tasks[tid]
        if b.outline.is_summary(tid) or task.percent_complete >= 100:
            continue
        if task.finish <= op.through:
            targets.append((tid, 100))
        elif task.start < op.through:
            percent = on_track(b, task, op.through)
            if percent > task.percent_complete:
                targets.append((tid, percent))
    for tid, percent in targets:
        set_task_percent(b, tid, percent, op.confirm)


# --- the end of the batch -----------------------------------------------------------


def finish(b: Batch) -> None:
    """Once every op has run: schedule the batch's final state, apply the
    completion rules (module docstring), complete the leaves the summaries
    take with them, and fill the queued actuals from that schedule."""
    state = b.state

    def reaches(tid: uuid.UUID) -> bool:
        """A leaf still at 100, or a summary with a leaf to complete (one
        complete already reaches nothing, as a leaf at 100 is never noted)."""
        if not b.outline.is_summary(tid):
            return state.tasks[tid].percent_complete == 100
        return any(state.tasks[leaf].percent_complete < 100 for leaf in b.outline.walk([tid])
                   if not b.outline.is_summary(leaf))

    asked = {tid: confirm for tid, confirm in b.completing.items()
             if tid in state.tasks and reaches(tid)}
    if not asked and not b.fills:
        return
    _schedule(b)                # also the outline (display IDs) as the batch left it
    if asked:
        _apply_rules(b, asked)
    _fill(b)


def _apply_rules(b: Batch, asked: dict[uuid.UUID, bool]) -> None:
    state, rules = b.state, b.settings.completion
    blocked, needs, cascade = check_completion(state, list(asked), rules)
    if blocked:
        raise err(409, "completion_blocked", blockers=[x.out() for x in blocked])
    if needs:
        unconfirmed = [tid for tid, confirm in asked.items() if not confirm]
        confirmed = [tid for tid, confirm in asked.items() if confirm]
        if unconfirmed and confirmed:
            # only what the unconfirmed ops bring needs confirming: the rest
            # of the batch (the confirmed tasks and their leaves) is done
            _, _, theirs = check_completion(state, confirmed, rules, done=unconfirmed)
            _, needs, _ = check_completion(state, unconfirmed, rules,
                                           done=[*confirmed, *theirs])
        if unconfirmed and needs:
            raise err(409, "completion_confirm",
                      will_complete=[x.out() for x in needs if x.reason == SUBTASK],
                      open_predecessors=[x.out() for x in needs if x.reason != SUBTASK])
    for tid in cascade:
        _leaf(b, state.tasks[tid], 100, frozenset())


def _fill(b: Batch) -> None:
    """The queued actuals from the schedule just taken, where the task's
    final % still calls for them (and it is still a leaf of the plan)."""
    for tid, (start, finish_) in b.fills.items():
        task = b.state.tasks.get(tid)
        if task is None or b.outline.is_summary(tid):
            continue
        if start and task.percent_complete > 0 and task.actual_start is None:
            task.actual_start = task.start
        if finish_ and task.percent_complete == 100 and task.actual_finish is None:
            task.actual_finish = task.finish
        if (task.actual_start is not None and task.actual_finish is not None
                and task.actual_finish < task.actual_start):
            raise bad_field("actual_finish")
    b.fills.clear()
