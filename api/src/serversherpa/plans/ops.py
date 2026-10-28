"""POST /plans/{plan_id}/ops: one batch of plan edits, applied in a single
transaction under the plan row lock (the route takes it). Any error raises
before anything is committed, so the plan, its version and every row stay
as they were.

A batch (`apply_ops`):
1. records every row's stored values (to report what changed) and, once
   the positions are normalized, every row's input fields (for the undo);
2. applies the ops in order: the task edits in plans/ops_tasks.py, the
   `restore` op in plans/ops_inverse.py;
3. writes the outline, renumbers, and recalculates the whole plan (the
   engine's ScheduleError and CalendarError propagate);
4. stamps every row whose stored values changed and answers the changed
   and deleted rows, the outline order when it moved, the client's temp
   ids, notices and the inverse (one `restore` op).

`run_batch` adds the rest of a write: loading the plan, mapping engine
errors to 422s, bumping the version, the audit row, the response.

Concurrency (spec API): a batch made only of progress edits
(`is_progress_only`) applies against the current state without a version
match and on a locked plan; every other batch needs `base_version` to be
the plan's version and an unlocked plan. The route checks both."""

import uuid
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext
from serversherpa.plans import ops_tasks
from serversherpa.plans.calendar import CalendarError
from serversherpa.plans.engine import SUMMARY_LINK_TYPES, ScheduleError, SummaryLinkError
from serversherpa.plans.models import ProjectPlan
from serversherpa.plans.ops_inverse import Snapshot, Stored, restore
from serversherpa.plans.ops_tasks import Batch, Outline, write_outline
from serversherpa.plans.schemas import OpsOut, RestoreOp, UpdateTaskOp
from serversherpa.plans.service import (
    PlanState,
    calendar_of,
    err,
    links_out,
    load_state,
    recalc,
    renumber,
    settings_of,
    tasks_out,
)
from serversherpa.plans.settings import PlanSettings
from serversherpa.services.audit import audit

# The task fields a progress edit may touch (spec Lock: % complete,
# actuals, notes); a batch of only these needs no version match.
PROGRESS_FIELDS = frozenset({"percent_complete", "actual_start", "actual_finish", "notes"})
# What the undo of a progress edit carries (completion stamps included).
_PROGRESS_RESTORE_KEYS = PROGRESS_FIELDS | {"id", "completed_at", "completed_by"}

_HANDLERS = {
    "add_task": ops_tasks.add_task,
    "update_task": ops_tasks.update_task,
    "delete_tasks": ops_tasks.delete_tasks,
    "move_tasks": ops_tasks.move_tasks,
    "indent": ops_tasks.indent,
    "outdent": ops_tasks.outdent,
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
    # person id -> the task ids they were newly assigned to (link and
    # assignee ops fill it; reminders use it)
    newly_assigned: dict[uuid.UUID, list[uuid.UUID]] = field(default_factory=dict)
    # the deleted tasks in their outline order before the batch
    deleted_order: list[uuid.UUID] = field(default_factory=list)
    # the batch's moment: every row it changed is stamped with it
    now: datetime = field(default_factory=lambda: datetime.now(UTC))


def _progress_restore(op: RestoreOp) -> bool:
    """The undo of a progress edit: progress fields of existing tasks only."""
    if op.links or op.assignments or op.remove_tasks or op.remove_links or not op.tasks:
        return False
    return all("id" in row and len(row) > 1 and row.keys() <= _PROGRESS_RESTORE_KEYS
               for row in op.tasks)


def is_progress_only(ops: Sequence) -> bool:
    """True for a batch of progress edits only: `update_task` touching
    nothing but PROGRESS_FIELDS, or the restore that undoes one."""
    if not ops:
        return False
    for op in ops:
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
    renumber(state)
    snapshot = Snapshot.take(state)
    batch = Batch(
        db=db, state=state, actor_id=actor.person.id, settings=settings,
        calendar=calendar_of(state.plan), now=now, outline=Outline.of(state))

    for op in ops:
        await _HANDLERS[op.op](batch, op)
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
        deleted_order=[tid for tid in snapshot.tasks if tid in deleted_tasks],
        now=now,
    )


def schedule_error(state: PlanState, exc: ScheduleError) -> HTTPException:
    """422 with the engine's code, the tasks at fault and their display IDs
    in the outline the batch built (sorted). A link a summary cannot take
    is named as well (`link_ids`): a task that becomes a summary keeps its
    finish links, and the batch fails rather than drop one."""
    display = {str(tid): i + 1 for i, tid in enumerate(state.order)}
    extra = {}
    if isinstance(exc, SummaryLinkError):
        parents = {t.parent_id for t in state.tasks.values() if t.parent_id is not None}
        extra["link_ids"] = sorted(
            str(lk.id) for lk in state.links.values()
            if lk.successor_id in parents and lk.link_type not in SUMMARY_LINK_TYPES)
    return err(422, exc.code, task_ids=list(exc.task_ids),
               display_ids=sorted(display[t] for t in exc.task_ids if t in display), **extra)


async def run_batch(db: AsyncSession, plan: ProjectPlan, ops: Sequence,
                    actor: AuthContext) -> OpsOut:
    """Apply a batch to a plan the caller has locked and checked, bump its
    version, audit it and answer what changed. The caller commits."""
    state = await load_state(db, plan)
    try:
        settings = await settings_of(db, plan)
        result = await apply_ops(db, state, ops, actor, settings)
    except ScheduleError as exc:
        raise schedule_error(state, exc) from None
    except CalendarError as exc:
        raise err(422, exc.code) from None

    plan.version += 1
    plan.updated_by, plan.updated_at = actor.person.id, result.now
    audit(db, actor_id=actor.person.id, entity_type="project_plan", entity_id=str(plan.id),
          action="plan_update", changes={"ops": dict(Counter(op.op for op in ops))})
    await db.flush()
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
