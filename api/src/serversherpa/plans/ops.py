"""POST /plans/{plan_id}/ops: one batch of plan edits, applied in a single
transaction under the plan row lock (the route takes it). Any error raises
before anything is committed, so the plan, its version and every row stay
as they were.

A batch (`apply_ops`):
1. records every row's stored values (to report what changed) and, once
   the positions are normalized, every row's input fields (for the undo)
   and the outline order (what Predecessors text numbers);
2. applies the ops in order: the task edits in plans/ops_tasks.py, the
   link, Predecessors and assignee edits in plans/ops_links.py, the
   progress edits in plans/ops_progress.py (an `update_task` writes the
   task's own fields first, then its Predecessors, then its % complete),
   the `restore` op in plans/ops_inverse.py;
3. when progress edits queued anything, schedules the batch's final state
   once, applies the completion rules to the tasks the batch completed
   (409 `completion_blocked` / `completion_confirm`) and fills the queued
   actuals from that schedule (plans/ops_progress.py); no op recalculates
   mid-batch except Mark on Track / Update project after a date-moving op;
4. writes the outline, renumbers, and recalculates the whole plan (the
   engine's ScheduleError and CalendarError propagate);
5. stamps every row whose stored values changed and answers the changed
   and deleted rows, the outline order when it moved, the client's temp
   ids, notices, the inverse (one `restore` op) and who was newly assigned
   (people a `set_assignees` op put on a task they were not on when the
   batch began and are still on at its end; a restore adds nobody).

`run_batch` adds the rest of a write: loading the plan, mapping engine
errors to 422s, bumping the version, the audit row, the deferred parent
check, the response.

Concurrency (spec API): a batch made only of progress edits
(`is_progress_only`: `set_percent`, `complete`, `mark_on_track`, an
`update_task` of PROGRESS_FIELDS only, and the restores that undo them)
applies against the current state without a version match and on a locked
plan; every other batch needs `base_version` to be the plan's version and
an unlocked plan. The route checks both, after `check_restores` has
verified every restore op's signature (so a forged restore never reaches
the progress-only check). Update project (`run_batch` with an
`UpdateProjectOp`) is a progress edit as well."""

import uuid
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext
from serversherpa.plans import ops_links, ops_progress, ops_tasks
from serversherpa.plans.calendar import CalendarError
from serversherpa.plans.engine import ScheduleError
from serversherpa.plans.models import ProjectPlan
from serversherpa.plans.ops_inverse import Snapshot, Stored, check_signature, restore
from serversherpa.plans.ops_tasks import Batch, Outline, bad_field, write_outline
from serversherpa.plans.schemas import (
    CompleteOp,
    MarkOnTrackOp,
    OpsOut,
    RestoreOp,
    SetPercentOp,
    UpdateTaskOp,
)
from serversherpa.plans.service import (
    PlanState,
    calendar_error,
    calendar_of,
    err,
    links_out,
    load_state,
    recalc,
    renumber,
    schedule_error,
    settings_of,
    tasks_out,
)
from serversherpa.plans.settings import PlanSettings
from serversherpa.services.audit import audit

# The task fields a progress edit may touch (spec Lock: % complete,
# actuals, notes, and the cosmetic bar color); a batch of only these needs
# no version match.
PROGRESS_FIELDS = frozenset({"percent_complete", "actual_start", "actual_finish", "notes",
                             "color"})
# What the undo of a progress edit carries (completion stamps included).
_PROGRESS_RESTORE_KEYS = PROGRESS_FIELDS | {"id", "completed_at", "completed_by"}
# the ops that are progress edits whatever they carry
PROGRESS_OPS = (SetPercentOp, CompleteOp, MarkOnTrackOp)
# ops that leave the batch's dates as they found them, or mark the batch
# stale themselves (plans/ops_progress.py); any other marks it stale
_KEEP_DATES = frozenset({"set_percent", "complete", "mark_on_track", "update_task",
                         "update_project"})
_ACTUALS = frozenset({"actual_start", "actual_finish"})
# deferred so a batch can write rows in any order; checked before it ends
PARENT_FK = "plan_tasks_parent_id_fkey"


async def _update_task(b: Batch, op: UpdateTaskOp) -> None:
    """The task's own fields, then its Predecessors text (links), then its
    % complete (a progress edit, on the dates the rest left)."""
    sent = op.fields.model_fields_set
    await ops_tasks.update_task(b, op)
    if "predecessors" in sent:
        await ops_links.set_predecessors(b, op.id, op.fields.predecessors)
    if "percent_complete" in sent:
        ops_progress.typed_percent(b, op)
        return
    # a 100% leaf has an actual finish: typed_percent's rule, for a task
    # already at 100% (a summary's own check has refused this op by now)
    if ("actual_finish" in sent and op.fields.actual_finish is None
            and b.task(op.id).percent_complete == 100):
        raise bad_field("actual_finish")
    if sent & _ACTUALS:
        ops_progress.actuals_typed(b, op.id, sent & _ACTUALS)
    if sent - ops_tasks.COSMETIC_FIELDS:
        b.stale = True


_HANDLERS = {
    "add_task": ops_tasks.add_task,
    "update_task": _update_task,
    "delete_tasks": ops_tasks.delete_tasks,
    "move_tasks": ops_tasks.move_tasks,
    "indent": ops_tasks.indent,
    "outdent": ops_tasks.outdent,
    "add_link": ops_links.add_link,
    "update_link": ops_links.update_link,
    "delete_link": ops_links.delete_link,
    "set_assignees": ops_links.set_assignees,
    "set_percent": ops_progress.set_percent,
    "complete": ops_progress.complete,
    "mark_on_track": ops_progress.mark_on_track,
    "update_project": ops_progress.update_project,
    "restore": restore,
}


@dataclass
class OpResult:
    changed_tasks: set[uuid.UUID]
    changed_links: set[uuid.UUID]
    deleted_tasks: set[uuid.UUID]
    deleted_links: set[uuid.UUID]
    outline_changed: bool
    temp_ids: dict[str, uuid.UUID]
    inverse: list[dict]
    notices: list[dict]
    # person id -> the task ids they were newly assigned to, in outline
    # order (set_assignees fills it; reminders use it; nobody is left out,
    # the actor included: who to tell is the reader's call)
    newly_assigned: dict[uuid.UUID, list[uuid.UUID]] = field(default_factory=dict)
    # the deleted tasks in their outline order before the batch
    deleted_order: list[uuid.UUID] = field(default_factory=list)
    # the batch's moment: every row it changed is stamped with it
    now: datetime = field(default_factory=lambda: datetime.now(UTC))


def check_restores(plan_id: uuid.UUID, ops: Sequence) -> None:
    """422 `bad_restore` unless every restore op in the batch carries the
    server's signature for this plan. The route runs this before anything
    reads a restore's payload (is_progress_only does) and before any op
    runs; `restore` checks again."""
    for op in ops:
        if isinstance(op, RestoreOp):
            check_signature(plan_id, op)


def _progress_restore(op: RestoreOp) -> bool:
    """The undo of a progress edit: progress fields of existing tasks only
    (none at all for the undo of a batch that changed nothing)."""
    if op.links or op.assignments or op.remove_tasks or op.remove_links:
        return False
    return all("id" in row and len(row) > 1 and row.keys() <= _PROGRESS_RESTORE_KEYS
               for row in op.tasks)


def is_progress_only(ops: Sequence) -> bool:
    """True for a batch of progress edits only: `set_percent`, `complete`,
    `mark_on_track`, `update_task` touching nothing but PROGRESS_FIELDS, or
    the restore that undoes one."""
    if not ops:
        return False
    for op in ops:
        if isinstance(op, PROGRESS_OPS):
            continue
        if isinstance(op, UpdateTaskOp):
            sent = op.fields.model_fields_set
            if not sent or not sent <= PROGRESS_FIELDS:
                return False
        elif isinstance(op, RestoreOp):
            if not _progress_restore(op):
                return False
        else:
            return False
    return True


async def apply_ops(db: AsyncSession, state: PlanState, ops: Sequence, actor: AuthContext,
                    settings: PlanSettings) -> OpResult:
    """Apply the ops to the loaded plan, recalculate it and work out what
    changed. Nothing is committed; an error leaves the transaction to be
    rolled back."""
    now = datetime.now(UTC)
    before = Stored.take(state)
    people_before = _people(state)
    renumber(state)
    snapshot = Snapshot.take(state)
    batch = Batch(
        db=db, state=state, actor_id=actor.person.id, settings=settings,
        calendar=calendar_of(state.plan), now=now, outline=Outline.of(state),
        start_order=list(state.order))

    for op in ops:
        await _HANDLERS[op.op](batch, op)
        if isinstance(op, RestoreOp):
            ops_progress.forget(batch, [uuid.UUID(row["id"]) for row in op.tasks])
        if op.op not in _KEEP_DATES:
            batch.stale = True
    ops_progress.finish(batch)
    write_outline(batch)
    renumber(state)
    recalc(state, settings)

    after = Stored.take(state)
    changed_tasks = {tid for tid, fp in after.tasks.items() if before.tasks.get(tid) != fp}
    for tid in changed_tasks:
        task = state.tasks[tid]
        task.updated_at, task.updated_by = now, actor.person.id
    deleted_tasks = set(before.tasks) - set(after.tasks)
    return OpResult(
        changed_tasks=changed_tasks,
        changed_links={lid for lid, fp in after.links.items() if before.links.get(lid) != fp},
        deleted_tasks=deleted_tasks,
        deleted_links=set(before.links) - set(after.links),
        outline_changed=before.outline_moved(after),
        temp_ids=dict(batch.temp_ids),
        inverse=[snapshot.inverse(state)],
        notices=batch.notices,
        newly_assigned=_newly_assigned(batch, people_before),
        deleted_order=[tid for tid in snapshot.tasks if tid in deleted_tasks],
        now=now,
    )


def _people(state: PlanState) -> dict[uuid.UUID, set[uuid.UUID]]:
    """Each task's assigned people (partners aside)."""
    return {tid: {row.person_id for row in rows if row.person_id is not None}
            for tid, rows in state.assignments.items()}


def _newly_assigned(b: Batch, before: dict[uuid.UUID, set[uuid.UUID]]
                    ) -> dict[uuid.UUID, list[uuid.UUID]]:
    """Person -> the tasks (in outline order) a set_assignees op put them on
    that they were not on when the batch began and are still on now."""
    after = _people(b.state)
    out: dict[uuid.UUID, list[uuid.UUID]] = {}
    for tid in b.state.order:
        added = b.added_people.get(tid)
        if added:
            for pid in sorted((added & after.get(tid, set())) - before.get(tid, set()), key=str):
                out.setdefault(pid, []).append(tid)
    return out


async def run_batch(db: AsyncSession, plan: ProjectPlan, ops: Sequence,
                    actor: AuthContext, *, changes: dict | None = None) -> OpsOut:
    """Apply a batch to a plan the caller has locked and checked, bump its
    version, audit it (with `changes` the caller made to the plan itself)
    and answer what changed. The caller commits."""
    state = await load_state(db, plan)
    try:
        settings = await settings_of(db, plan)
        result = await apply_ops(db, state, ops, actor, settings)
    except ScheduleError as exc:
        raise schedule_error(state, exc) from None
    except CalendarError as exc:
        raise calendar_error(exc) from None

    plan.version += 1
    plan.updated_by, plan.updated_at = actor.person.id, result.now
    audit(db, actor_id=actor.person.id, entity_type="project_plan", entity_id=str(plan.id),
          action="plan_update",
          changes={"ops": dict(Counter(op.op for op in ops)), **(changes or {})})
    await db.flush()
    try:
        # the FK catches a dangling parent (one no row has) here, inside the
        # batch, not at commit; it cannot see a parent loop, which the
        # outline ops and restore refuse before this
        await db.execute(text(f"SET CONSTRAINTS {PARENT_FK} IMMEDIATE"))
    except IntegrityError:
        raise err(422, "bad_field", field="parent_id") from None
    return OpsOut(
        version=plan.version,
        tasks=await tasks_out(db, state, result.changed_tasks),
        links=links_out(state, sorted(result.changed_links, key=str)),
        deleted_tasks=result.deleted_order,
        deleted_links=sorted(result.deleted_links, key=str),
        order=list(state.order) if result.outline_changed else None,
        temp_ids=result.temp_ids,
        inverse=result.inverse,
        notices=result.notices,
    )
