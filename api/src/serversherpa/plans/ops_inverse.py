"""Undo for ops batches: what a batch is measured against, the inverse it
answers, and the `restore` op that applies one.

Before a batch runs, `Snapshot.take` records every row twice:
- the stored values of every task (and its assignees) and link, so the
  batch can report exactly the rows it changed, the engine's included;
- the *input* fields, the ones a user (or an op) sets, never the ones the
  engine computes. A summary's duration and % complete are derived, and an
  auto task's or a summary's start and finish are engine output, so they
  are left out; a manual leaf's start and finish are input.

`inverse` compares the input fields after the batch with the snapshot and
answers one `restore` op that re-creates the deleted rows (in full),
removes the created ones and puts back just the fields that changed on the
others. It is minimal, so the undo of a progress edit carries progress
fields only and is itself a progress edit (plans/ops.py, is_progress_only).

Row formats (JSON): a task is {"id", <input fields>} with plan times as
`YYYY-MM-DDTHH:MM`, `completed_at` as an ISO instant and ids as strings; a
link is {"id", "predecessor_id", "successor_id", "link_type",
"lag_minutes", "lag_unit", "lag_elapsed"}; an assignment entry is
{"task_id", "resources": [{"kind": "person"|"partner", "id"}]} and replaces
that task's assignees.

Applying a batch's inverse and then that restore's own inverse returns the
plan to the state after the batch.

Only the server writes restore ops. Every inverse is signed (`sig`):
HMAC-SHA256 over the plan id and the canonical JSON (sorted keys, no
whitespace) of every RestoreOp field but `sig`, keyed by a key derived from
`jwt_secret` for this one use. The fields come from the model, so a field
added later is signed too. A restore is verified over the values it will
apply, as the model holds them, never a normalized dump: a non-finite
number (NaN, Infinity), which no inverse holds, is refused outright. A
restore without a valid signature for its plan is refused (422
`bad_restore`) before anything is read: the route checks every restore op
of a batch before the batch runs (plans/ops.py, check_restores), and
`restore` checks again. So a client can neither forge rows nor carry one
plan's undo to another. The content checks below stay as a second line;
they accept what a snapshot holds (archived assignees, completion stamps)
and refuse what no snapshot could."""

import hashlib
import hmac
import json
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select

from serversherpa.config import get_settings
from serversherpa.db.models import Partner, Person
from serversherpa.plans.durations import UNITS, max_minutes
from serversherpa.plans.engine import CONSTRAINT_TYPES, LINK_TYPES, MODES
from serversherpa.plans.floating import format_floating, parse_floating
from serversherpa.plans.models import PlanAssignment, PlanLink, PlanTask
from serversherpa.plans.ops_links import resource_key, write_assignees
from serversherpa.plans.ops_tasks import (
    Batch,
    Outline,
    bad_field,
    check_constraint,
    remove_subtrees,
    selected,
    unknown_task,
    write_outline,
)
from serversherpa.plans.schemas import RestoreOp
from serversherpa.plans.service import PlanState, err

# Input fields of every task; a leaf adds LEAF_FIELDS, a manual leaf
# MANUAL_FIELDS too.
INPUT_FIELDS = (
    "parent_id", "position", "name", "is_milestone", "mode", "duration_unit", "elapsed",
    "constraint_type", "constraint_date", "deadline", "actual_start", "actual_finish",
    "notes", "show_on_timeline", "baseline_start", "baseline_finish",
    "baseline_duration_minutes", "completed_at", "completed_by",
)
LEAF_FIELDS = ("duration_minutes", "percent_complete")
MANUAL_FIELDS = ("start", "finish")
LINK_FIELDS = ("predecessor_id", "successor_id", "link_type", "lag_minutes", "lag_unit",
               "lag_elapsed")
# Every stored task column but the stamps, outline first (see `outline_moved`).
STORED_FIELDS = (
    "parent_id", "position", "name", "is_milestone", "mode", "duration_minutes",
    "duration_unit", "elapsed", "start", "finish", "constraint_type", "constraint_date",
    "deadline", "percent_complete", "actual_start", "actual_finish", "notes",
    "show_on_timeline", "total_slack_minutes", "is_critical", "conflict", "baseline_start",
    "baseline_finish", "baseline_duration_minutes", "completed_at", "completed_by",
)
_MISSING = object()
MAX_POSITION = 1_000_000            # a restored position is below this
RESTORE_CONTEXT = b"plan-restore-v1"
UNSIGNED = frozenset({"sig"})       # the one RestoreOp field the signature leaves out


# --- signatures ---------------------------------------------------------------------


def _restore_key() -> bytes:
    """The signing key: `jwt_secret` put through HMAC with a fixed context,
    so it is the key of nothing else signed with that secret."""
    secret = get_settings().jwt_secret.get_secret_value()
    return hmac.new(secret.encode(), RESTORE_CONTEXT, hashlib.sha256).digest()


def _signed_fields(op: Mapping[str, Any]) -> dict[str, Any]:
    """Every RestoreOp field but `sig`, read from `op`; one it leaves out
    reads as the field's default."""
    body = {}
    for name, info in RestoreOp.model_fields.items():
        if name not in UNSIGNED:
            body[name] = op[name] if name in op else info.get_default(call_default_factory=True)
    return body


def _id_text(value: Any) -> str:
    """JSON for the one non-JSON value a restore holds: an id, written
    lower-case as the snapshots write it."""
    if isinstance(value, uuid.UUID):
        return str(value)
    raise TypeError(f"a restore op cannot hold {type(value).__name__}")


def sign_restore(plan_id: uuid.UUID | str, op: Mapping[str, Any]) -> str:
    """The hex signature of a restore op for one plan. Raises ValueError for
    a non-finite number (NaN, Infinity) anywhere in the op, and TypeError
    for a value JSON cannot hold."""
    text = json.dumps(_signed_fields(op), sort_keys=True, separators=(",", ":"),
                      allow_nan=False, default=_id_text)
    message = str(plan_id).encode() + b"\0" + text.encode()
    return hmac.new(_restore_key(), message, hashlib.sha256).hexdigest()


def check_signature(plan_id: uuid.UUID, op: RestoreOp) -> None:
    """422 `bad_restore` unless the server signed this op for this plan,
    checked over the values the restore applies (a normalized dump would
    read NaN as null)."""
    try:
        expected = sign_restore(plan_id, {name: getattr(op, name)
                                          for name in type(op).model_fields})
    except (TypeError, ValueError):
        raise err(422, "bad_restore") from None
    if op.sig is None or not hmac.compare_digest(op.sig.encode(), expected.encode()):
        raise err(422, "bad_restore")


# --- snapshots ----------------------------------------------------------------------


def _enc(value: Any) -> Any:
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat() if value.tzinfo is not None else format_floating(value)
    return value


def summaries(state: PlanState) -> set[uuid.UUID]:
    return {t.parent_id for t in state.tasks.values() if t.parent_id is not None}


def task_inputs(task: PlanTask, summary: bool) -> dict[str, Any]:
    out = {name: _enc(getattr(task, name)) for name in INPUT_FIELDS}
    if not summary:
        for name in LEAF_FIELDS:
            out[name] = getattr(task, name)
        if task.mode == "manual":
            for name in MANUAL_FIELDS:
                out[name] = _enc(getattr(task, name))
    return out


def link_inputs(link: PlanLink) -> dict[str, Any]:
    return {name: _enc(getattr(link, name)) for name in LINK_FIELDS}


def _resource_keys(rows: list[PlanAssignment]) -> tuple[tuple[str, uuid.UUID], ...]:
    return tuple(sorted(resource_key(r) for r in rows))


def assignees(state: PlanState, task_id: uuid.UUID) -> list[dict[str, str]]:
    return [{"kind": kind, "id": str(rid)}
            for kind, rid in _resource_keys(state.assignments.get(task_id, []))]


@dataclass
class Stored:
    """Every row's stored values, to tell which rows a batch changed."""

    tasks: dict[uuid.UUID, tuple]
    links: dict[uuid.UUID, tuple]

    @classmethod
    def take(cls, state: PlanState) -> "Stored":
        return cls(
            tasks={tid: (tuple(getattr(t, f) for f in STORED_FIELDS),
                         _resource_keys(state.assignments.get(tid, [])))
                   for tid, t in state.tasks.items()},
            links={lid: tuple(getattr(lk, f) for f in LINK_FIELDS)
                   for lid, lk in state.links.items()})

    def outline_moved(self, after: "Stored") -> bool:
        """True when a task came, went, or changed parent or position."""
        if self.tasks.keys() != after.tasks.keys():
            return True
        return any(self.tasks[tid][0][:2] != fp[0][:2] for tid, fp in after.tasks.items())


@dataclass
class Snapshot:
    """The input fields of every row before a batch, in outline order."""

    tasks: dict[uuid.UUID, dict[str, Any]]
    links: dict[uuid.UUID, dict[str, Any]]
    assignees: dict[uuid.UUID, list[dict[str, str]]]

    @classmethod
    def take(cls, state: PlanState) -> "Snapshot":
        parents = summaries(state)
        ordered = [tid for tid in state.order if tid in state.tasks]
        return cls(
            tasks={tid: task_inputs(state.tasks[tid], tid in parents) for tid in ordered},
            links={lid: link_inputs(lk) for lid, lk in state.links.items()},
            assignees={tid: assignees(state, tid) for tid in ordered})

    def inverse(self, state: PlanState) -> dict[str, Any]:
        """The restore op that puts `state` back to this snapshot."""
        parents = summaries(state)
        tasks: list[dict[str, Any]] = []
        for tid, old in self.tasks.items():
            task = state.tasks.get(tid)
            if task is None:
                tasks.append({"id": str(tid), **old})
                continue
            new = task_inputs(task, tid in parents)
            changed = {k: v for k, v in old.items() if new.get(k, _MISSING) != v}
            if changed:
                tasks.append({"id": str(tid), **changed})
        links = [{"id": str(lid), **old} for lid, old in self.links.items()
                 if lid not in state.links or link_inputs(state.links[lid]) != old]
        entries = []
        for tid, old in self.assignees.items():
            gone = tid not in state.tasks
            if (gone and old) or (not gone and assignees(state, tid) != old):
                entries.append({"task_id": str(tid), "resources": old})
        op = {
            "op": "restore",
            "tasks": tasks,
            "links": links,
            "assignments": entries,
            "remove_tasks": [str(tid) for tid in state.order if tid not in self.tasks],
            "remove_links": sorted(str(lid) for lid in state.links if lid not in self.links),
        }
        return {**op, "sig": sign_restore(state.plan.id, op)}


# --- reading restore rows -----------------------------------------------------------
# Each reader returns the value or raises TypeError (wrong JSON type) or
# ValueError (right type, bad value); `_read` answers both as `bad_field`.

_BAD_VALUE = (TypeError, ValueError)


def _uuid(value) -> uuid.UUID:
    if not isinstance(value, str):
        raise TypeError
    return uuid.UUID(value)


def _opt(parse: Callable) -> Callable:
    return lambda value: None if value is None else parse(value)


def _int(value) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise TypeError
    return value


def _ranged(low: int, high: int) -> Callable:
    def parse(value) -> int:
        number = _int(value)
        if not low <= number <= high:
            raise ValueError
        return number
    return parse


def _of(kind: type) -> Callable:
    def parse(value):
        if not isinstance(value, kind):
            raise TypeError
        return value
    return parse


def _one_of(choices) -> Callable:
    def parse(value):
        if value not in choices:
            raise ValueError
        return value
    return parse


def _wall(value) -> datetime:
    """A snapshot's plan time: always a full `YYYY-MM-DDTHH:MM`."""
    if not isinstance(value, str):
        raise TypeError
    if "T" not in value:
        raise ValueError
    return parse_floating(value, date_only_time=datetime.min.time())


def _instant(value) -> datetime:
    if not isinstance(value, str):
        raise TypeError
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None:
        raise ValueError
    return moment


def _longest(b: Batch) -> int:
    """The longest duration or lag either kind of time allows."""
    return max(max_minutes(b.units, False), max_minutes(b.units, True))


def _task_parsers(b: Batch) -> dict[str, Callable]:
    longest = _longest(b)
    wall = _opt(_wall)
    return {
        "parent_id": _opt(_uuid), "position": _int, "name": _of(str),
        "is_milestone": _of(bool), "mode": _one_of(MODES),
        "duration_minutes": _ranged(0, longest), "duration_unit": _one_of(UNITS),
        "elapsed": _of(bool), "start": wall, "finish": wall,
        "constraint_type": _one_of(CONSTRAINT_TYPES), "constraint_date": wall,
        "deadline": wall, "percent_complete": _ranged(0, 100), "actual_start": wall,
        "actual_finish": wall, "notes": _opt(_of(str)), "show_on_timeline": _of(bool),
        "baseline_start": wall, "baseline_finish": wall,
        "baseline_duration_minutes": _opt(_ranged(0, longest)),
        "completed_at": _opt(_instant), "completed_by": _opt(_uuid),
    }


def _link_parsers(b: Batch) -> dict[str, Callable]:
    longest = _longest(b)
    return {
        "predecessor_id": _uuid, "successor_id": _uuid, "link_type": _one_of(LINK_TYPES),
        "lag_minutes": _ranged(-longest, longest), "lag_unit": _one_of(UNITS),
        "lag_elapsed": _of(bool),
    }


def _read(raw, parsers: dict[str, Callable], key: str = "id"
          ) -> tuple[uuid.UUID, dict[str, Any]]:
    """(row id, parsed fields); any bad key or value is 422 `bad_field`."""
    if not isinstance(raw, dict):
        raise bad_field(key)
    try:
        row_id = _uuid(raw.get(key))
    except _BAD_VALUE:
        raise bad_field(key) from None
    fields: dict[str, Any] = {}
    for name, value in raw.items():
        if name == key:
            continue
        parse = parsers.get(name)
        if parse is None:
            raise bad_field(name)
        try:
            fields[name] = parse(value)
        except _BAD_VALUE:
            raise bad_field(name) from None
    return row_id, fields


# --- restore ------------------------------------------------------------------------


async def restore(b: Batch, op: RestoreOp) -> None:
    state, db = b.state, b.db
    check_signature(state.plan.id, op)
    write_outline(b)        # the rows' positions are the outline's before rows move
    await db.flush()        # rows an earlier op added can now be deleted like any other
    for lid in op.remove_links:
        if lid not in state.links:
            raise err(422, "unknown_link", link_id=str(lid))
    for tid in op.remove_tasks:
        b.task(tid)

    await _restore_tasks(b, op.tasks)
    b.outline = Outline.of(state)
    links = [state.links[lid] for lid in dict.fromkeys(op.remove_links)
             if lid in state.links]
    for link in links:
        await db.delete(link)
        del state.links[link.id]
    await db.flush()        # before a link can come back with the same pair
    await remove_subtrees(b, selected(b, [t for t in op.remove_tasks if t in state.tasks]))
    await _restore_links(b, op.links)
    await _restore_assignments(b, op.assignments)


async def _restore_tasks(b: Batch, raw_rows: list) -> None:
    state, parsers = b.state, _task_parsers(b)
    rows: dict[uuid.UUID, dict[str, Any]] = {}
    for raw in raw_rows:
        tid, fields = _read(raw, parsers)
        if not 0 <= fields.get("position", 0) < MAX_POSITION:
            raise err(422, "bad_restore", field="position")
        rows.setdefault(tid, {}).update(fields)
    if not rows:
        return
    new = [tid for tid in rows if tid not in state.tasks]
    for tid in new:
        # re-creating needs a full row; anything else names an unknown task
        if not {"name", "position"} <= rows[tid].keys():
            raise unknown_task(tid)
    if new:
        taken = await b.db.scalar(select(PlanTask.id).where(PlanTask.id.in_(new)).limit(1))
        if taken is not None:
            raise unknown_task(taken)      # another plan's row
    people = {f["completed_by"] for f in rows.values() if f.get("completed_by")}
    if people:
        found = set(await b.db.scalars(select(Person.id).where(Person.id.in_(people))))
        if people - found:
            raise bad_field("completed_by")

    parent = {tid: task.parent_id for tid, task in state.tasks.items()}
    for tid, fields in rows.items():
        if "parent_id" in fields or tid in new:
            parent[tid] = fields.get("parent_id")
    for tid, up in parent.items():
        if up is not None and up not in parent:
            raise unknown_task(up)
    depth = _depths(parent)

    # new rows first, parents before their subtasks, so every insert's
    # parent exists; then the existing rows (an update may point at a new row)
    for tid in sorted(new, key=depth.__getitem__):
        task = b.new_task(tid)
        for name, value in rows[tid].items():
            setattr(task, name, value)
        task.parent_id = parent[tid]
        check_constraint(task)
    await b.db.flush()
    for tid, fields in rows.items():
        if tid in new:
            continue
        task = state.tasks[tid]
        for name, value in fields.items():
            if getattr(task, name) != value:
                setattr(task, name, value)
        check_constraint(task)
    for tid in rows:
        task = state.tasks[tid]
        if (task.actual_start is not None and task.actual_finish is not None
                and task.actual_finish < task.actual_start):
            raise bad_field("actual_finish")


def _depths(parent: dict[uuid.UUID, uuid.UUID | None]) -> dict[uuid.UUID, int]:
    """Each task's depth in the outline; a parent loop is 422 `bad_field`."""
    depth: dict[uuid.UUID, int] = {}
    for start in parent:
        chain: list[uuid.UUID] = []
        on_chain: set[uuid.UUID] = set()
        tid: uuid.UUID | None = start
        while tid is not None and tid not in depth:
            if tid in on_chain:
                raise bad_field("parent_id")
            chain.append(tid)
            on_chain.add(tid)
            tid = parent[tid]
        level = -1 if tid is None else depth[tid]
        for tid in reversed(chain):
            level += 1
            depth[tid] = level
    return depth


async def _restore_links(b: Batch, raw_rows: list) -> None:
    state, parsers = b.state, _link_parsers(b)
    new: list[PlanLink] = []
    for raw in raw_rows:
        lid, fields = _read(raw, parsers)
        missing = set(LINK_FIELDS) - fields.keys()
        if missing:
            raise bad_field(min(missing))
        pred, succ = fields["predecessor_id"], fields["successor_id"]
        if pred == succ:
            raise err(422, "bad_link", link_id=str(lid))
        b.task(pred)
        b.task(succ)
        link = state.links.get(lid) or next((lk for lk in new if lk.id == lid), None)
        if link is None:
            link = PlanLink(id=lid, plan_id=state.plan.id, **fields)
            new.append(link)
            continue
        if (link.predecessor_id, link.successor_id) != (pred, succ):
            raise err(422, "bad_link", link_id=str(lid))   # a link never changes ends
        for name, value in fields.items():
            if getattr(link, name) != value:
                setattr(link, name, value)
    if not new:
        return
    taken = await b.db.scalar(
        select(PlanLink.id).where(PlanLink.id.in_([lk.id for lk in new])).limit(1))
    if taken is not None:
        raise err(422, "unknown_link", link_id=str(taken))
    pairs = {(lk.predecessor_id, lk.successor_id) for lk in state.links.values()}
    for link in new:
        pair = (link.predecessor_id, link.successor_id)
        if pair in pairs:
            raise err(422, "duplicate_link", link_id=str(link.id))
        pairs.add(pair)
        b.db.add(link)
        state.links[link.id] = link


async def _restore_assignments(b: Batch, raw_rows: list) -> None:
    wanted: dict[uuid.UUID, set[tuple[str, uuid.UUID]]] = {}
    for raw in raw_rows:
        if not isinstance(raw, dict) or raw.keys() != {"task_id", "resources"}:
            raise bad_field("assignments")
        try:
            tid = _uuid(raw["task_id"])
        except _BAD_VALUE:
            raise bad_field("task_id") from None
        b.task(tid)
        resources = raw["resources"]
        if not isinstance(resources, list):
            raise bad_field("resources")
        wanted[tid] = {_resource(r) for r in resources}
    await _check_resources(b, {key for keys in wanted.values() for key in keys})
    for tid, keys in wanted.items():
        await write_assignees(b, tid, keys)


def _resource(raw) -> tuple[str, uuid.UUID]:
    if not isinstance(raw, dict) or raw.keys() != {"kind", "id"} \
            or raw["kind"] not in ("person", "partner"):
        raise bad_field("resources")
    try:
        return raw["kind"], _uuid(raw["id"])
    except _BAD_VALUE:
        raise bad_field("resources") from None


async def _check_resources(b: Batch, keys: set[tuple[str, uuid.UUID]]) -> None:
    """A restored assignee only has to exist still: the signature says the
    server snapshotted it, so one archived or taken off the initiative since
    comes back with its task. A person or partner deleted since is 422
    `bad_resource`."""
    people = {rid for kind, rid in keys if kind == "person"}
    partners = {rid for kind, rid in keys if kind == "partner"}
    if people:
        people -= set(await b.db.scalars(select(Person.id).where(Person.id.in_(people))))
    if partners:
        partners -= set(await b.db.scalars(select(Partner.id).where(Partner.id.in_(partners))))
    for kind, missing in (("person", people), ("partner", partners)):
        if missing:
            raise err(422, "bad_resource", kind=kind, id=str(min(missing, key=str)))
