"""The scheduling engine for project plans: MS Project's rules for turning
tasks, links, constraints and a work calendar into dates. Pure, no I/O; the
API runs it over the whole plan on every write and persists what changed.

Every datetime is a naive wall-clock time of the plan's own timezone; never
attach a tzinfo. Durations and lags are minutes: working minutes through the
calendar, or wall-clock minutes when `elapsed` / `lag_elapsed` is set.

Forward pass (`schedule`), one task at a time in link order:

- An auto task's earliest start is the latest of: the project start (snapped
  to a working moment), each predecessor link's bound, and its constraint
  floor. Links, for successor S and predecessor P with lag L (negative = a
  lead): FS  S.start >= P.finish + L;  SS  S.start >= P.start + L;
  FF  S.finish >= P.finish + L;  SF  S.finish >= P.start + L.
- Placing a task: a non-elapsed task with work snaps its start forward to a
  working moment and adds its duration, finishing exactly on an interval end
  when it fills one (Mon 17:00, not Tue 08:00). A zero-duration task (a
  milestone) does not snap: after a predecessor finishing Mon 17:00 it sits
  at Mon 17:00. An elapsed task starts where it lands and adds wall-clock time.
- Constraints: SNET and FNET are floors. SNLT and FNLT are ceilings and MSO
  and MFO pins; when a link wants the task later than one of those allows,
  `EngineSettings.honor_constraints` decides. On (MS Project's default): the
  constraint wins and the task gets `conflict = "link"`. Off: the links win
  and it gets `conflict = "constraint"`. "Later" is measured in the task's
  own time: working time, so a milestone pinned at Fri 17:00 does not
  conflict with a link bound of Mon 08:00 (no work lies between), or wall
  clock for an elapsed task. The project start is not a link: a ceiling or
  pin before it moves the task there without a conflict. But once a link
  does pass the ceiling with honor off, the task takes its natural date,
  which the project start floors: a link that alone would need only a date
  before the project start still lands the task on the project start,
  flagged "constraint". A non-ASAP constraint without a date is ignored.
- Manual tasks keep the start and finish the user gave, and when both are
  given their span (working time, or wall clock when elapsed) is the task's
  duration. Only a start: the finish follows from the duration; only a
  finish: the start does; neither: the project start. They still drive their
  successors; links and constraints never move them.
- Actuals are what happened, for auto and manual tasks alike. An
  `actual_start` replaces the start and the finish moves with it, keeping
  the duration (a manual task's typed span); one equal to the scheduled
  start (what recording progress sets) moves nothing. An `actual_finish`
  replaces the finish. A task with an actual has no conflict.
- Nothing moves a not-started task for being in the past.

Summary tasks: a task is a summary when another task's `parent_id` names it
(derived, never stored). Its own duration, mode, dates, actuals and %
complete are ignored; everything comes from its subtasks. In the graph a
summary is two nodes:

- An entry gate, the earliest its subtasks may start: the latest of its
  parent's gate, the FS/SS links into the summary and its SNET date. Every
  subtask (or a child summary's gate) waits for it, so a link into a summary
  reaches every task below it. Only FS and SS may link into a summary, and
  its only constraints are ASAP and SNET. The links count as links for the
  conflict rule above; the SNET date, like the project start, is a floor
  that never conflicts with a subtask's own constraint.
- A rollup: start = the earliest subtask start, finish = the latest subtask
  finish, duration = the working time between them, % complete = the
  duration-weighted average over its leaf descendants (each leaf counts
  once when they are all zero-duration), rounded half up. Links out of a
  summary, of any type, read the rollup.

A link between a task and its own ancestor or descendant is rejected
(`OutlineLinkError`), as are FF/SF links into a summary
(`SummaryLinkError`), other summary constraints (`SummaryConstraintError`)
and loops (`CycleError`, which can run through a summary's gate or rollup).
"""

import heapq
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from serversherpa.plans.calendar import CalendarError, WorkCalendar

_MINUTE = timedelta(minutes=1)

LINK_TYPES = ("FS", "SS", "FF", "SF")
CONSTRAINT_TYPES = ("asap", "snet", "snlt", "fnet", "fnlt", "mso", "mfo")
MODES = ("auto", "manual")
SUMMARY_CONSTRAINT_TYPES = ("asap", "snet")
SUMMARY_LINK_TYPES = ("FS", "SS")       # into a summary; out of one, any type


@dataclass(frozen=True)
class TaskIn:
    id: str
    parent_id: str | None
    position: int                       # whole-plan outline order
    mode: str = "auto"                  # "auto" | "manual"
    duration: int = 480                 # minutes
    elapsed: bool = False
    is_milestone: bool = False
    constraint_type: str = "asap"       # asap snet snlt fnet fnlt mso mfo
    constraint_date: datetime | None = None
    deadline: datetime | None = None
    start: datetime | None = None       # used for manual tasks only
    finish: datetime | None = None
    actual_start: datetime | None = None
    actual_finish: datetime | None = None
    percent_complete: int = 0


@dataclass(frozen=True)
class LinkIn:
    predecessor_id: str
    successor_id: str
    link_type: str = "FS"               # FS SS FF SF
    lag: int = 0                        # signed minutes
    lag_elapsed: bool = False


@dataclass(frozen=True)
class EngineSettings:
    honor_constraints: bool = True
    critical_slack_minutes: int = 0


DEFAULT_SETTINGS = EngineSettings()


@dataclass
class TaskOut:
    start: datetime
    finish: datetime
    duration: int                       # minutes (derived for summaries)
    is_summary: bool
    percent_complete: int               # derived for summaries
    late_start: datetime | None = None
    late_finish: datetime | None = None
    total_slack: int | None = None      # working minutes
    is_critical: bool = False
    conflict: str | None = None         # None | "link" | "constraint"


class ScheduleError(ValueError):
    """The plan cannot be scheduled as it stands. `code` is the API error
    code and `task_ids` the tasks at fault (in outline order)."""

    code: str = "schedule_error"
    task_ids: list[str]

    def __init__(self, message: str, task_ids: Iterable[str] = ()):
        super().__init__(message)
        self.task_ids = list(task_ids)


class CycleError(ScheduleError):
    """The links form a loop; `task_ids` are the tasks on it."""

    code = "link_cycle"


class OutlineLinkError(ScheduleError):
    """A link joins a task to its own ancestor or descendant."""

    code = "link_to_outline"


class SummaryLinkError(ScheduleError):
    """A link a summary task cannot take (FF or SF into a summary)."""

    code = "bad_summary_link"


class SummaryConstraintError(ScheduleError):
    """A summary task with a constraint other than ASAP or SNET."""

    code = "bad_summary_constraint"


# --- the graph ----------------------------------------------------------------------

LEAF = "leaf"          # a task with no subtasks
GATE = "gate"          # a summary's entry gate: the earliest its subtasks may start
ROLLUP = "rollup"      # a summary's rollup: its dates, from its subtasks'

# A graph node: (kind, task id). A leaf task is one node, a summary two.
Node = tuple[str, str]


@dataclass
class _Graph:
    rank: dict[Node, tuple[int, int]]   # Kahn's tie-break: (position, input index)
    successors: dict[Node, list[Node]] = field(default_factory=dict)
    links_into: dict[Node, list[LinkIn]] = field(default_factory=dict)

    def add_edge(self, before: Node, after: Node) -> None:
        self.successors.setdefault(before, []).append(after)


@dataclass
class _Outline:
    by_id: dict[str, TaskIn]
    rank: dict[str, tuple[int, int]]    # outline order: (position, input index)
    children: dict[str, list[str]]      # summary id -> its direct subtasks

    @classmethod
    def of(cls, tasks: list[TaskIn], by_id: dict[str, TaskIn]) -> "_Outline":
        children: dict[str, list[str]] = {}
        for task in tasks:
            if task.parent_id is not None:
                children.setdefault(task.parent_id, []).append(task.id)
        rank = {task.id: (task.position, index) for index, task in enumerate(tasks)}
        return cls(by_id=by_id, rank=rank, children=children)

    def is_summary(self, task_id: str) -> bool:
        return task_id in self.children

    def is_ancestor(self, ancestor_id: str, task_id: str) -> bool:
        parent_id = self.by_id[task_id].parent_id
        while parent_id is not None:
            if parent_id == ancestor_id:
                return True
            parent_id = self.by_id[parent_id].parent_id
        return False

    def entry(self, task_id: str) -> Node:
        """The node a link into the task (or its parent's gate) leads to."""
        return (GATE if self.is_summary(task_id) else LEAF, task_id)

    def exit(self, task_id: str) -> Node:
        """The node a link out of the task (or into its parent's rollup) leaves."""
        return (ROLLUP if self.is_summary(task_id) else LEAF, task_id)

    def in_order(self, task_ids: Iterable[str]) -> list[str]:
        return sorted(set(task_ids), key=self.rank.__getitem__)


def _check(tasks: list[TaskIn], links: list[LinkIn]) -> dict[str, TaskIn]:
    """Tasks by id. Values the schema never stores are a caller's bug: they
    raise a plain ValueError, not a ScheduleError."""
    by_id: dict[str, TaskIn] = {}
    for task in tasks:
        if task.id in by_id:
            raise ValueError(f"task {task.id} is listed twice")
        if task.mode not in MODES:
            raise ValueError(f"task {task.id}: unknown mode {task.mode!r}")
        if task.constraint_type not in CONSTRAINT_TYPES:
            raise ValueError(f"task {task.id}: unknown constraint {task.constraint_type!r}")
        if task.duration < 0:
            raise ValueError(f"task {task.id}: negative duration {task.duration}")
        by_id[task.id] = task
    _check_parents(by_id)
    for link in links:
        for end in (link.predecessor_id, link.successor_id):
            if end not in by_id:
                raise ValueError(f"a link names unknown task {end}")
        if link.link_type not in LINK_TYPES:
            raise ValueError(f"unknown link type {link.link_type!r}")
    return by_id


def _check_parents(by_id: dict[str, TaskIn]) -> None:
    """Every parent exists and the outline is a tree. Each task's chain of
    parents is walked once, up to the first task already known good."""
    good: set[str] = set()
    for task_id in by_id:
        chain: list[str] = []
        on_chain: set[str] = set()
        current: str | None = task_id
        while current is not None and current not in good:
            if current in on_chain:
                raise ValueError(f"task {current}: its parents loop")
            chain.append(current)
            on_chain.add(current)
            parent_id = by_id[current].parent_id
            if parent_id is not None and parent_id not in by_id:
                raise ValueError(f"task {current} has unknown parent {parent_id}")
            current = parent_id
        good.update(chain)


def _check_summaries(tasks: list[TaskIn], links: list[LinkIn], outline: _Outline) -> None:
    """The plan-level rules a summary imposes, checked before the graph is
    sorted. Each raises for every task at fault, in outline order."""
    at_fault = [task.id for task in tasks if outline.is_summary(task.id)
                and task.constraint_type not in SUMMARY_CONSTRAINT_TYPES]
    if at_fault:
        raise SummaryConstraintError(
            "a summary task can only start as soon as possible or no earlier than a date",
            outline.in_order(at_fault))

    ends: list[str] = []
    for link in links:
        pred, succ = link.predecessor_id, link.successor_id
        if outline.is_ancestor(pred, succ) or outline.is_ancestor(succ, pred):
            ends += (pred, succ)
    if ends:
        raise OutlineLinkError("a link joins a task to its own summary or subtask",
                               outline.in_order(ends))

    ends = []
    for link in links:
        if outline.is_summary(link.successor_id) and link.link_type not in SUMMARY_LINK_TYPES:
            ends += (link.predecessor_id, link.successor_id)
    if ends:
        raise SummaryLinkError("only finish-to-start and start-to-start links can lead "
                               "into a summary task", outline.in_order(ends))


def _build_graph(tasks: list[TaskIn], links: list[LinkIn], outline: _Outline) -> _Graph:
    """A leaf is one node; a summary S is a gate G:S and a rollup R:S, with
    G:parent -> each child's entry, each child's exit -> R:parent, and a
    link P -> S as P's exit -> S's entry (R:P and G:S for summaries)."""
    rank: dict[Node, tuple[int, int]] = {}
    for task in tasks:
        if outline.is_summary(task.id):
            rank[(GATE, task.id)] = rank[(ROLLUP, task.id)] = outline.rank[task.id]
        else:
            rank[(LEAF, task.id)] = outline.rank[task.id]
    graph = _Graph(rank=rank)
    for task in tasks:
        if task.parent_id is not None:
            graph.add_edge((GATE, task.parent_id), outline.entry(task.id))
            graph.add_edge(outline.exit(task.id), (ROLLUP, task.parent_id))
    for link in links:
        before = outline.exit(link.predecessor_id)
        after = outline.entry(link.successor_id)
        graph.add_edge(before, after)
        graph.links_into.setdefault(after, []).append(link)
    return graph


def _topological_order(graph: _Graph) -> list[Node]:
    """Kahn's algorithm; among nodes ready together the one highest in the
    outline goes first. A loop raises CycleError naming the tasks on it."""
    indegree = dict.fromkeys(graph.rank, 0)
    for after_nodes in graph.successors.values():
        for after in after_nodes:
            indegree[after] += 1
    ready = [(graph.rank[node], node) for node, count in indegree.items() if count == 0]
    heapq.heapify(ready)
    order: list[Node] = []
    while ready:
        _, node = heapq.heappop(ready)
        order.append(node)
        for after in graph.successors.get(node, ()):
            indegree[after] -= 1
            if indegree[after] == 0:
                heapq.heappush(ready, (graph.rank[after], after))
    if len(order) < len(graph.rank):
        first: dict[str, tuple[int, int]] = {}    # task id -> its highest node's rank
        for node in _on_cycles(graph, set(graph.rank).difference(order)):
            task_id = node[1]
            first[task_id] = min(first.get(task_id, graph.rank[node]), graph.rank[node])
        raise CycleError("the links form a loop", sorted(first, key=first.__getitem__))
    return order


def _on_cycles(graph: _Graph, stuck: set[Node]) -> set[Node]:
    """Kahn stops with every node on a loop *and* every node downstream of
    one. Peel off, from the far end, the nodes that lead to no loop: what is
    left is the loops themselves (and any path joining two of them)."""
    before: dict[Node, list[Node]] = {node: [] for node in stuck}
    outdegree = dict.fromkeys(stuck, 0)
    for node in stuck:
        for after in graph.successors.get(node, ()):
            if after in stuck:
                outdegree[node] += 1
                before[after].append(node)
    dead_ends = [node for node, count in outdegree.items() if count == 0]
    left = set(stuck)
    while dead_ends:
        node = dead_ends.pop()
        left.discard(node)
        for earlier in before[node]:
            outdegree[earlier] -= 1
            if outdegree[earlier] == 0:
                dead_ends.append(earlier)
    return left


# --- the forward pass ---------------------------------------------------------------


@dataclass(frozen=True)
class _Gate:
    """What a summary's entry gate holds for every task below it."""

    floor: datetime                     # the project start, raised by SNET dates
    linked: datetime | None             # the latest link bound into it or an ancestor


@dataclass(frozen=True)
class _Progress:
    """Sums over a summary's leaf descendants, for its % complete."""

    weighted: int = 0                   # sum of percent * duration
    duration: int = 0
    percent: int = 0
    leaves: int = 0

    def __add__(self, other: "_Progress") -> "_Progress":
        return _Progress(self.weighted + other.weighted, self.duration + other.duration,
                         self.percent + other.percent, self.leaves + other.leaves)

    @classmethod
    def of_leaf(cls, out: TaskOut) -> "_Progress":
        pct, minutes = out.percent_complete, out.duration
        return cls(weighted=pct * minutes, duration=minutes, percent=pct, leaves=1)

    def rounded(self) -> int:
        """Duration-weighted, or count-weighted when every leaf is zero
        length; rounded half up."""
        if self.duration:
            return (2 * self.weighted + self.duration) // (2 * self.duration)
        return (2 * self.percent + self.leaves) // (2 * self.leaves)


class _ForwardPass:
    def __init__(self, calendar: WorkCalendar, project_start: datetime,
                 settings: EngineSettings):
        self.cal = calendar
        self.settings = settings
        self.project_start = calendar.next_work_start(project_start)
        self.out: dict[str, TaskOut] = {}
        self.gates: dict[str, _Gate] = {}
        self.progress: dict[str, _Progress] = {}    # summaries only

    # --- time arithmetic ---

    def shift(self, moment: datetime, lag: int, elapsed: bool) -> datetime:
        """`moment` moved by a signed lag: wall-clock minutes when elapsed,
        else working minutes (a lead counts working time backward)."""
        if elapsed:
            return moment + timedelta(minutes=lag)
        if lag > 0:
            return self.cal.add_work(moment, lag)
        if lag < 0:
            return self.cal.sub_work(moment, -lag)
        return moment

    def after(self, task: TaskIn, start: datetime, minutes: int) -> datetime:
        """`minutes` of the task's own time (wall clock when it is elapsed,
        else working time) after `start`."""
        if task.elapsed:
            return start + timedelta(minutes=minutes)
        return self.cal.add_work(start, minutes)

    def before(self, task: TaskIn, finish: datetime, minutes: int) -> datetime:
        """`minutes` of the task's own time before `finish`."""
        if task.elapsed:
            return finish - timedelta(minutes=minutes)
        return self.cal.sub_work(finish, minutes)

    def span(self, task: TaskIn, start: datetime, finish: datetime) -> int:
        """Minutes of the task's own time from `start` to `finish`, never
        negative."""
        if task.elapsed:
            return max((finish - start) // _MINUTE, 0)
        return max(self.cal.work_between(start, finish), 0)

    def later(self, task: TaskIn, a: datetime, b: datetime) -> bool:
        """Whether `a` is after `b` in the task's own time. In working time
        two moments with no work between them are the same (Fri 17:00 and
        Mon 08:00), which matters for a milestone, as it never snaps."""
        if task.elapsed:
            return a > b
        return self.cal.work_between(b, a) > 0

    def finish_from(self, task: TaskIn, start: datetime) -> datetime:
        """The finish of `task` when it starts at `start`."""
        return self.after(task, start, task.duration)

    def start_from(self, task: TaskIn, finish: datetime) -> datetime:
        """The start `task` needs to finish at `finish`."""
        return self.before(task, finish, task.duration)

    def place(self, task: TaskIn, earliest: datetime) -> tuple[datetime, datetime]:
        """(start, finish) of an auto task starting as early as `earliest`
        allows. Work snaps to a working moment; a zero-duration or elapsed
        task starts exactly there."""
        if task.elapsed or task.duration == 0:
            return earliest, self.finish_from(task, earliest)
        start = self.cal.next_work_start(earliest)
        return start, self.cal.add_work(start, task.duration)

    # --- one task ---

    def link_bound(self, link: LinkIn, task: TaskIn) -> datetime:
        """The earliest start `link` allows its successor `task`."""
        pred = self.out[link.predecessor_id]
        anchor = pred.finish if link.link_type in ("FS", "FF") else pred.start
        moment = self.shift(anchor, link.lag, link.lag_elapsed)
        if link.link_type in ("FS", "SS"):
            return moment
        return self.start_from(task, moment)       # FF, SF bound the finish

    def linked(self, task: TaskIn, links: list[LinkIn], inherited: datetime | None
               ) -> datetime | None:
        """The latest bound from `links` and the gate's `inherited` one."""
        bounds = [self.link_bound(link, task) for link in links]
        if inherited is not None:
            bounds.append(inherited)
        return max(bounds, default=None)

    def gate(self, task: TaskIn, links: list[LinkIn]) -> _Gate:
        """A summary's entry gate: its parent's, raised by the FS/SS links
        into the summary and its SNET date."""
        parent = self.gates.get(task.parent_id) if task.parent_id is not None else None
        floor = self.project_start if parent is None else parent.floor
        if task.constraint_type == "snet" and task.constraint_date is not None:
            floor = max(floor, task.constraint_date)
        return _Gate(floor=floor,
                     linked=self.linked(task, links, None if parent is None else parent.linked))

    def auto(self, task: TaskIn, links: list[LinkIn], gate: _Gate | None
             ) -> tuple[tuple[datetime, datetime], str | None]:
        """((start, finish), conflict) of an auto task under `gate` (None at
        the top level)."""
        floor = self.project_start if gate is None else gate.floor
        linked = self.linked(task, links, None if gate is None else gate.linked)
        earliest = floor if linked is None else max(floor, linked)
        kind, date = task.constraint_type, task.constraint_date
        if kind == "asap" or date is None:
            return self.place(task, earliest), None
        if kind == "snet":
            return self.place(task, max(earliest, date)), None
        if kind == "fnet":
            return self.place(task, max(earliest, self.start_from(task, date))), None

        # SNLT/FNLT cap the start, MSO/MFO pin it
        held = self.place(task, date if kind in ("snlt", "mso") else self.start_from(task, date))
        natural = self.place(task, earliest)
        if kind in ("snlt", "fnlt") and not self.later(task, natural[0], held[0]):
            return natural, None
        if linked is not None and self.later(task, self.place(task, linked)[0], held[0]):
            # a link wants the task later than its constraint allows
            if self.settings.honor_constraints:
                return held, "link"
            return natural, "constraint"
        return held, None

    def manual(self, task: TaskIn) -> tuple[datetime, datetime]:
        """The dates the user gave a manual task, completed from its duration."""
        start, finish = task.start, task.finish
        if start is None and finish is None:
            start = self.project_start
        if start is None:
            start = self.start_from(task, finish)
        elif finish is None:
            finish = self.finish_from(task, start)
        return start, finish

    def leaf(self, task: TaskIn, links: list[LinkIn]) -> TaskOut:
        conflict = None
        duration = task.duration
        if task.mode == "manual":
            start, finish = self.manual(task)
            if task.start is not None and task.finish is not None:
                duration = self.span(task, start, finish)     # the typed dates rule
        else:
            gate = self.gates[task.parent_id] if task.parent_id is not None else None
            (start, finish), conflict = self.auto(task, links, gate)
        if task.actual_start is not None and task.actual_start != start:
            # an actual start on the scheduled one (what recording progress
            # sets) leaves the finish alone, even one typed off the calendar
            start = task.actual_start
            finish = self.after(task, start, duration)
        if task.actual_finish is not None:
            finish = task.actual_finish
            if task.actual_start is None and start > finish:
                start = self.before(task, finish, duration)
        if task.actual_start is not None or task.actual_finish is not None:
            conflict = None
        return TaskOut(start=start, finish=finish, duration=duration, is_summary=False,
                       percent_complete=task.percent_complete, conflict=conflict)

    def rollup(self, task: TaskIn, children: list[str]) -> TaskOut:
        """A summary from its direct subtasks, once all of them are placed."""
        start = min(self.out[child].start for child in children)
        finish = max(self.out[child].finish for child in children)
        progress = sum((self.progress[child] if child in self.progress
                        else _Progress.of_leaf(self.out[child]) for child in children),
                       _Progress())
        self.progress[task.id] = progress
        return TaskOut(start=start, finish=finish,
                       duration=max(self.cal.work_between(start, finish), 0),
                       is_summary=True, percent_complete=progress.rounded())


def schedule(tasks: list[TaskIn], links: list[LinkIn], calendar: WorkCalendar,
             project_start: datetime, settings: EngineSettings = DEFAULT_SETTINGS
             ) -> dict[str, TaskOut]:
    """Schedule the whole plan: a `TaskOut` per task id, summaries included.
    Raises SummaryConstraintError, OutlineLinkError or SummaryLinkError when
    the outline breaks a summary rule, CycleError when the links loop, and
    CalendarError when the calendar has no working time to place a task in
    or a date runs out of range. The late dates and slack stay None here."""
    by_id = _check(tasks, links)
    outline = _Outline.of(tasks, by_id)
    _check_summaries(tasks, links, outline)
    graph = _build_graph(tasks, links, outline)
    order = _topological_order(graph)
    try:
        forward = _ForwardPass(calendar, project_start, settings)
        for node in order:
            kind, task_id = node
            task, links_in = by_id[task_id], graph.links_into.get(node, [])
            if kind == GATE:
                forward.gates[task_id] = forward.gate(task, links_in)
            elif kind == ROLLUP:
                forward.out[task_id] = forward.rollup(task, outline.children[task_id])
            else:
                forward.out[task_id] = forward.leaf(task, links_in)
    except OverflowError:       # elapsed time past year 9999 (or before year 1)
        raise CalendarError("a date runs past the range the calendar can reach") from None
    return forward.out
