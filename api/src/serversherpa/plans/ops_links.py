"""Link and assignee edits inside an ops batch (plans/ops.py runs the
batch): add_link, update_link, delete_link, the Predecessors cell
(`update_task.fields.predecessors`) and set_assignees.

Links:
- A link from a task to itself is 422 `bad_link`, a second link for one
  (predecessor, successor) pair 422 `duplicate_link`, a link naming a task
  or link of another plan 422 `unknown_task` / `unknown_link`. Every new or
  changed lag is capped like a duration (ops_tasks.check_bound). The engine
  refuses the rest when the batch recalculates (`link_cycle`,
  `link_to_outline`, `bad_summary_link`; plans/ops.py maps them).
- Rows are changed in place. A deleted row is flushed out at once, because
  the unit of work inserts before it deletes and a link for the same pair
  (or the same assignee) may come back later in the batch; a row the batch
  itself added and has not flushed is just dropped from the session.

The Predecessors cell (`set_predecessors`) replaces every link into the
task. Its numbers are display IDs in the outline order the batch began
with (`Batch.start_order`), before any of the batch's outline ops: that is
the outline the client showed when the text was typed. So a task added in
the batch (its id only reaches the client in the response) or deleted
earlier in it cannot be named. A link to a predecessor that is listed again
stays the same row, changed in place.

The text is display text: a lag shows rounded to two decimals of its own
unit (predecessors.format_predecessors). An entry keeps its link's stored
lag (minutes, unit, elapsed) when the entry is that link's own text in the
cell, when its lag reads the same, or when both lags are zero (compared by
minutes, whatever the units), so re-saving unchanged text never shifts a
lag.

Assignees (`set_assignees`) replace a task's resources, a summary's
included. A new one must be in the plan's resources list
(service.resources_of: team, staff, partners), else 422 `bad_resource`; one
the task already has is always accepted, so re-saving a task's assignees
never fails because one of them was archived or left the team. The people
an op adds are recorded on the batch; plans/ops.py reports who was newly
assigned."""

import uuid
from collections.abc import Iterable

from fastapi import HTTPException
from sqlalchemy import inspect

from serversherpa.db.models import Initiative
from serversherpa.plans.durations import Duration, DurationError, Units, format_lag, parse_lag
from serversherpa.plans.engine import LINK_TYPES
from serversherpa.plans.models import PlanAssignment, PlanLink
from serversherpa.plans.ops_tasks import Batch, bad_field, check_bound
from serversherpa.plans.predecessors import (
    PredecessorError,
    PredSpec,
    format_predecessors,
    parse_predecessors,
    split_entries,
)
from serversherpa.plans.schemas import AddLinkOp, DeleteLinkOp, SetAssigneesOp, UpdateLinkOp
from serversherpa.plans.service import err, resources_of

KINDS = ("person", "partner")
ResourceKey = tuple[str, uuid.UUID]


async def _remove(b: Batch, rows: Iterable) -> None:
    """Take rows out of the session (the caller takes them out of the
    state): a stored row is deleted and flushed, so one for the same pair
    or assignee can be added later in the batch; one the batch added and
    has not flushed is dropped."""
    deleted = False
    for row in rows:
        if inspect(row).pending:
            b.db.expunge(row)
        else:
            await b.db.delete(row)
            deleted = True
    if deleted:
        await b.db.flush()


# --- links --------------------------------------------------------------------------


def unknown_link(link_id) -> HTTPException:
    return err(422, "unknown_link", link_id=str(link_id))


def _link(b: Batch, link_id: uuid.UUID) -> PlanLink:
    """The plan's link, or 422 `unknown_link` (also for another plan's)."""
    link = b.state.links.get(link_id)
    if link is None:
        raise unknown_link(link_id)
    return link


def _link_type(value: str | None) -> str:
    if value not in LINK_TYPES:
        raise bad_field("link_type")
    return value


def _lag(b: Batch, text: str | None) -> Duration:
    if text is None:
        raise bad_field("lag")
    try:
        lag = parse_lag(text, b.units)
    except DurationError:
        raise err(422, "bad_duration", field="lag") from None
    return check_bound(lag, b.units, "lag")


def _stored_lag(link: PlanLink) -> Duration:
    return Duration(link.lag_minutes, link.lag_unit, link.lag_elapsed)


def _set(link: PlanLink, link_type: str, lag: Duration) -> None:
    """Write the type and lag, touching only the columns that change."""
    values = {"link_type": link_type, "lag_minutes": lag.minutes, "lag_unit": lag.unit,
              "lag_elapsed": lag.elapsed}
    for name, value in values.items():
        if getattr(link, name) != value:
            setattr(link, name, value)


def _new_link(b: Batch, pred: uuid.UUID, succ: uuid.UUID, link_type: str,
              lag: Duration) -> PlanLink:
    link = PlanLink(id=uuid.uuid4(), plan_id=b.state.plan.id, predecessor_id=pred,
                    successor_id=succ, link_type=link_type, lag_minutes=lag.minutes,
                    lag_unit=lag.unit, lag_elapsed=lag.elapsed)
    b.db.add(link)
    b.state.links[link.id] = link
    return link


async def _drop_links(b: Batch, links: list[PlanLink]) -> None:
    for link in links:
        del b.state.links[link.id]
    await _remove(b, links)


async def add_link(b: Batch, op: AddLinkOp) -> None:
    pred, succ = op.predecessor_id, op.successor_id
    if pred == succ:
        raise err(422, "bad_link", task_id=str(pred))
    b.task(pred)
    b.task(succ)
    link_type = _link_type(op.link_type)
    lag = _lag(b, op.lag)
    if any(lk.predecessor_id == pred and lk.successor_id == succ
           for lk in b.state.links.values()):
        raise err(422, "duplicate_link", predecessor_id=str(pred), successor_id=str(succ))
    _new_link(b, pred, succ, link_type, lag)


async def update_link(b: Batch, op: UpdateLinkOp) -> None:
    link = _link(b, op.id)
    sent = op.model_fields_set
    link_type = _link_type(op.link_type) if "link_type" in sent else link.link_type
    lag = _lag(b, op.lag) if "lag" in sent else _stored_lag(link)
    _set(link, link_type, lag)


async def delete_link(b: Batch, op: DeleteLinkOp) -> None:
    await _drop_links(b, [_link(b, op.id)])


# --- the Predecessors cell ----------------------------------------------------------


def _reads(lag: Duration, units: Units) -> tuple[int, str]:
    """How a non-zero lag reads in the cell: its sign and its text (one too
    small to show reads "0 days" and keeps only its sign)."""
    return (lag.minutes > 0) - (lag.minutes < 0), format_lag(lag, units)


def _keeps_lag(link: PlanLink, spec: PredSpec, entry: str, units: Units) -> bool:
    """True when the entry leaves the link's stored lag as it is."""
    stored = _stored_lag(link)
    if entry == format_predecessors([PredSpec(spec.display_id, link.link_type, stored)],
                                    units):
        return True                 # the link's own text, sent back
    if stored.minutes == 0 or spec.lag.minutes == 0:
        return stored.minutes == spec.lag.minutes
    return _reads(stored, units) == _reads(spec.lag, units)


async def set_predecessors(b: Batch, task_id: uuid.UUID, text: str) -> None:
    """Replace every link into the task with the ones the text lists."""
    state, units = b.state, b.units
    display = {n: tid for n, tid in enumerate(b.start_order, 1) if tid in state.tasks}
    number = {tid: n for n, tid in display.items()}
    try:
        specs = parse_predecessors(text, units, valid_ids=display, self_id=number.get(task_id))
    except PredecessorError as exc:
        raise err(422, exc.code, field="predecessors", task_id=str(task_id),
                  message=exc.detail) from None

    wanted = {display[spec.display_id]: (spec, entry)
              for spec, entry in zip(specs, split_entries(text), strict=True)}
    incoming = {lk.predecessor_id: lk for lk in state.links.values()
                if lk.successor_id == task_id}
    await _drop_links(b, [lk for pred, lk in incoming.items() if pred not in wanted])
    for pred, (spec, entry) in wanted.items():
        link = incoming.get(pred)
        if link is None:
            _new_link(b, pred, task_id, spec.link_type,
                      check_bound(spec.lag, units, "predecessors"))
        elif _keeps_lag(link, spec, entry, units):
            _set(link, spec.link_type, _stored_lag(link))
        else:
            _set(link, spec.link_type, check_bound(spec.lag, units, "predecessors"))


# --- assignees ----------------------------------------------------------------------


def resource_key(row: PlanAssignment) -> ResourceKey:
    if row.person_id is not None:
        return "person", row.person_id
    return "partner", row.partner_id


async def plan_resources(b: Batch) -> set[ResourceKey]:
    """The plan's resources list as (kind, id), read once per batch."""
    if b.resources is None:
        initiative = await b.db.get(Initiative, b.state.plan.initiative_id)
        b.resources = {(r.kind, r.id) for r in await resources_of(b.db, initiative)}
    return b.resources


async def write_assignees(b: Batch, task_id: uuid.UUID,
                          keys: Iterable[ResourceKey]) -> set[ResourceKey]:
    """Make `keys` the task's assignees: the rows it keeps stay, the others
    go and new rows are added. Answers the keys added. No checks (the
    callers make them)."""
    state = b.state
    added = set(keys)
    keep: list[PlanAssignment] = []
    gone: list[PlanAssignment] = []
    for row in state.assignments.get(task_id, []):
        key = resource_key(row)
        if key in added:
            keep.append(row)
            added.discard(key)
        else:
            gone.append(row)
    await _remove(b, gone)
    for kind, rid in sorted(added, key=lambda k: (k[0], str(k[1]))):
        row = PlanAssignment(id=uuid.uuid4(), task_id=task_id,
                             person_id=rid if kind == "person" else None,
                             partner_id=rid if kind == "partner" else None)
        b.db.add(row)
        keep.append(row)
    if keep:
        state.assignments[task_id] = keep
    else:
        state.assignments.pop(task_id, None)
    return added


async def set_assignees(b: Batch, op: SetAssigneesOp) -> None:
    task = b.task(op.task_id)
    keys: set[ResourceKey] = set()
    for ref in op.resources:
        if ref.kind not in KINDS:
            raise bad_field("resources")
        keys.add((ref.kind, ref.id))
    new = keys - {resource_key(row) for row in b.state.assignments.get(task.id, [])}
    if new:
        unknown = new - await plan_resources(b)
        if unknown:
            kind, rid = min(unknown, key=lambda k: (k[0], str(k[1])))
            raise err(422, "bad_resource", kind=kind, id=str(rid), task_id=str(task.id))
    added = await write_assignees(b, task.id, keys)
    people = {rid for kind, rid in added if kind == "person"}
    if people:
        b.added_people.setdefault(task.id, set()).update(people)
