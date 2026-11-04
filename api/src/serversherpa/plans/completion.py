"""The completion rules (spec "Progress and completion checks"): what stands
in the way of tasks reaching 100%. Pure: it reads a plan's rows and never
writes them; plans/ops_progress.py applies the answer inside a batch.

Two rules, each a plan setting (`PlanSettings.completion`):
- **subtasks**, when a summary is completed: its open leaf descendants are
  `needs_confirm` and then completed with it (`cascade`), `blocked`
  (`block`), or completed with it unasked (`none`: nothing is checked, but
  a summary's % is its leaves', so they are what completing it means).
- **predecessors**, when any task is completed: every task linked into it
  or into one of its ancestors (any link type) that is still open is
  `blocked` (`block`) or `needs_confirm` (`warn`); `none` checks nothing.
  The leaves a summary's completion takes with it are checked the same way.

A task is open when it is a leaf below 100%, or a summary with an open leaf
below it, and the batch does not complete it: the tasks asked for, the
leaves their summaries take with them (unless the subtask rule blocks
them) and the `done` ones all count as complete."""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from serversherpa.plans.settings import Completion

SUBTASK = "subtask"
PREDECESSOR = "predecessor"


@dataclass
class Blocker:
    """A task in the way of a completion, as the 409s name it."""

    task_id: uuid.UUID
    display_id: int
    name: str
    reason: str                 # "subtask" | "predecessor"

    def out(self) -> dict:
        return {"task_id": str(self.task_id), "display_id": self.display_id,
                "name": self.name, "reason": self.reason}


def check_completion(state, task_ids: Iterable[uuid.UUID], rules: Completion, *,
                     done: Iterable[uuid.UUID] = ()
                     ) -> tuple[list[Blocker], list[Blocker], list[uuid.UUID]]:
    """(blocked, needs_confirm, cascade_ids) for completing `task_ids`.

    `state` is a PlanState (only `tasks`, `links` and `order` are read; a
    row's `parent_id` is its place in the outline). `done` are other tasks
    the same batch completes. Blockers come in outline order, each task
    once per reason; `cascade_ids` (outline order) are the open leaves the
    summaries among `task_ids` complete with them when nothing blocks."""
    tasks = state.tasks
    order = [tid for tid in state.order if tid in tasks]
    display = {tid: i + 1 for i, tid in enumerate(order)}
    kids: dict[uuid.UUID, list[uuid.UUID]] = {}
    for tid in order:
        parent = tasks[tid].parent_id
        if parent in tasks:
            kids.setdefault(parent, []).append(tid)

    def leaves(root: uuid.UUID) -> list[uuid.UUID]:
        out, stack, seen = [], [root], set()
        while stack:
            tid = stack.pop()
            if tid in seen:
                continue
            seen.add(tid)
            below = kids.get(tid)
            if below:
                stack.extend(reversed(below))
            else:
                out.append(tid)
        return out

    def ancestors(tid: uuid.UUID) -> list[uuid.UUID]:
        out, seen = [], {tid}
        up = tasks[tid].parent_id
        while up in tasks and up not in seen:
            out.append(up)
            seen.add(up)
            up = tasks[up].parent_id
        return out

    requested = [tid for tid in dict.fromkeys(task_ids) if tid in tasks]
    complete = set(requested) | set(done)
    # the open leaves below the summaries asked for
    taken: dict[uuid.UUID, None] = {}
    for tid in requested:
        if tid in kids:
            for leaf in leaves(tid):
                if leaf not in complete and tasks[leaf].percent_complete < 100:
                    taken[leaf] = None
    cascade = sorted(taken, key=display.__getitem__)

    blocked: list[Blocker] = []
    needs: list[Blocker] = []

    def blocker(tid: uuid.UUID, reason: str) -> Blocker:
        return Blocker(task_id=tid, display_id=display[tid], name=tasks[tid].name,
                       reason=reason)

    if rules.subtasks == "block":
        blocked += [blocker(tid, SUBTASK) for tid in cascade]
        cascade = []
    elif rules.subtasks == "cascade":
        needs += [blocker(tid, SUBTASK) for tid in cascade]
    complete |= set(cascade)

    if rules.predecessors in ("block", "warn"):
        into: dict[uuid.UUID, list[uuid.UUID]] = {}
        for link in state.links.values():
            into.setdefault(link.successor_id, []).append(link.predecessor_id)

        def is_open(tid: uuid.UUID) -> bool:
            if tid in complete:
                return False
            return any(leaf not in complete and tasks[leaf].percent_complete < 100
                       for leaf in leaves(tid))

        found: dict[uuid.UUID, None] = {}
        for tid in [*requested, *cascade]:
            for node in (tid, *ancestors(tid)):
                for pred in into.get(node, ()):
                    if pred in tasks and pred not in found and is_open(pred):
                        found[pred] = None
        preds = [blocker(tid, PREDECESSOR) for tid in found]
        (blocked if rules.predecessors == "block" else needs).extend(preds)

    def ordered(items: list[Blocker]) -> list[Blocker]:
        return sorted(items, key=lambda b: (b.display_id, b.reason))

    return ordered(blocked), ordered(needs), cascade
