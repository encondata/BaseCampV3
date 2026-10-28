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

The scheduled dates a % fills actuals from must be the batch's own: an op
that may move dates (anything but these progress ops, or a % that clears
an actual) marks the batch `stale`, and the next fill recalculates first.

The completion rules run over every task the batch took to 100% (a summary:
asked to complete), whatever op did it but `restore`, which replays what
the server recorded. Each such task carries its op's `confirm`; a task
taken below 100 again later in the batch is dropped. Any blocker answers
409 `completion_blocked`; else a `needs_confirm` from an op that did not
confirm answers 409 `completion_confirm`; else the summaries' open leaves
are completed too."""

import uuid
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


@dataclass
class UpdateProjectOp:
    """Update project's task edits, as one op of an internal batch (the
    route sets the status date itself): every incomplete leaf finishing by
    `through` to 100%, every incomplete leaf spanning it on track through
    it. Not a client op: never in `schemas.Op`."""

    through: datetime | None
    confirm: bool = False
    op: str = "update_project"


# --- the schedule a % reads ---------------------------------------------------------


def fresh(b: Batch) -> None:
    """Recalculate when an op since the last recalc may have moved dates.
    Every op that changes the outline marks the batch stale, so after this
    `state.order` and the rows' positions are the batch's outline too."""
    if b.stale:
        write_outline(b)
        renumber(b.state)
        recalc(b.state, b.settings)
        b.stale = False


def on_track(b: Batch, task: PlanTask, moment: datetime) -> int:
    """The % of the task scheduled by `moment`: the share of its duration
    between its start and `moment`, rounded half up; a milestone (or a
    zero-duration task) is 100 once reached, else 0."""
    start, finish = task.start, task.finish
    if task.is_milestone or task.duration_minutes == 0:
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
    """A leaf's %, actuals and stamps. An actual named in `explicit` (sent
    by the same update_task) is left as that op set it."""
    fills_start = percent > 0 and task.actual_start is None and "actual_start" not in explicit
    fills_finish = (percent == 100 and task.actual_finish is None
                    and "actual_finish" not in explicit)
    if fills_start or fills_finish:
        fresh(b)
    was = task.percent_complete
    if was != percent:
        task.percent_complete = percent
    if fills_start:
        task.actual_start = task.start
    if percent == 100:
        if fills_finish:
            task.actual_finish = task.finish
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
    if (task.actual_start is not None and task.actual_finish is not None
            and task.actual_finish < task.actual_start):
        raise bad_field("actual_finish")


def set_task_percent(b: Batch, task_id: uuid.UUID, percent: int, confirm: bool, *,
                     explicit: frozenset[str] = frozenset()) -> None:
    """One task's % (0-100, checked by the caller): a leaf's own, or 100 on
    a summary to complete it. A task reaching 100 is noted for the
    completion rules with its op's `confirm`."""
    if b.outline.is_summary(task_id):
        if percent != 100:
            raise err(422, "summary_field", field="percent_complete", task_id=str(task_id))
        _note(b, task_id, confirm)
        return
    task = b.state.tasks[task_id]
    was = task.percent_complete
    _leaf(b, task, percent, explicit)
    if percent == 100 and was < 100:
        _note(b, task_id, confirm)


def _note(b: Batch, task_id: uuid.UUID, confirm: bool) -> None:
    b.completing[task_id] = b.completing.get(task_id, False) or confirm


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
    and its Predecessors are in."""
    sent = op.fields.model_fields_set
    if sent - _DATELESS_FIELDS:
        b.stale = True
    percent = op.fields.percent_complete
    if percent is None or not 0 <= percent <= 100:
        raise bad_field("percent_complete")
    set_task_percent(b, op.id, percent, op.confirm,
                     explicit=frozenset(sent & {"actual_start", "actual_finish"}))


async def mark_on_track(b: Batch, op: MarkOnTrackOp) -> None:
    """Each task (a summary: each leaf below it, once) to its % scheduled
    by the plan's status date, else now."""
    moment = status_now(b.state.plan)
    leaves = dict.fromkeys(tid for root in _ids(b, op.ids) for tid in b.outline.walk([root])
                           if not b.outline.is_summary(tid))
    for tid in leaves:
        fresh(b)
        set_task_percent(b, tid, on_track(b, b.state.tasks[tid], moment), op.confirm)


async def update_project(b: Batch, op: UpdateProjectOp) -> None:
    if op.through is None:
        return
    fresh(b)
    for tid in list(b.outline.order()):
        if b.outline.is_summary(tid):
            continue
        fresh(b)
        task = b.state.tasks[tid]
        if task.percent_complete >= 100:
            continue
        if task.finish <= op.through:
            set_task_percent(b, tid, 100, op.confirm)
        elif task.start < op.through:
            set_task_percent(b, tid, on_track(b, task, op.through), op.confirm)


# --- the completion rules -----------------------------------------------------------


def finish(b: Batch) -> None:
    """Apply the completion rules to what the batch completed (module
    docstring), then complete the leaves the summaries take with them."""
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
    if not asked:
        return
    fresh(b)                    # the outline (display IDs) as the batch left it
    rules = b.settings.completion
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
