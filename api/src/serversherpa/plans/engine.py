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

LEAF = "leaf"

# A graph node: (kind, task id). Every task is a leaf node here.
Node = tuple[str, str]


@dataclass
class _Graph:
    rank: dict[Node, tuple[int, int]]   # Kahn's tie-break: (position, input index)
    successors: dict[Node, list[Node]] = field(default_factory=dict)
    links_into: dict[Node, list[LinkIn]] = field(default_factory=dict)

    def add_edge(self, before: Node, after: Node) -> None:
        self.successors.setdefault(before, []).append(after)


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
    for link in links:
        for end in (link.predecessor_id, link.successor_id):
            if end not in by_id:
                raise ValueError(f"a link names unknown task {end}")
        if link.link_type not in LINK_TYPES:
            raise ValueError(f"unknown link type {link.link_type!r}")
    return by_id


def _build_graph(tasks: list[TaskIn], links: list[LinkIn]) -> _Graph:
    graph = _Graph(rank={(LEAF, task.id): (task.position, index)
                         for index, task in enumerate(tasks)})
    for link in links:
        before, after = (LEAF, link.predecessor_id), (LEAF, link.successor_id)
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


class _ForwardPass:
    def __init__(self, calendar: WorkCalendar, project_start: datetime,
                 settings: EngineSettings):
        self.cal = calendar
        self.settings = settings
        self.project_start = calendar.next_work_start(project_start)
        self.out: dict[str, TaskOut] = {}

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

    def auto(self, task: TaskIn, links: list[LinkIn]
             ) -> tuple[tuple[datetime, datetime], str | None]:
        """((start, finish), conflict) of an auto task."""
        linked = max((self.link_bound(link, task) for link in links), default=None)
        earliest = self.project_start if linked is None else max(self.project_start, linked)
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
            (start, finish), conflict = self.auto(task, links)
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


def schedule(tasks: list[TaskIn], links: list[LinkIn], calendar: WorkCalendar,
             project_start: datetime, settings: EngineSettings = DEFAULT_SETTINGS
             ) -> dict[str, TaskOut]:
    """Schedule the whole plan: a `TaskOut` per task id. Raises CycleError
    when the links loop, and CalendarError when the calendar has no working
    time to place a task in or a date runs out of range. The late dates and
    slack stay None here."""
    by_id = _check(tasks, links)
    graph = _build_graph(tasks, links)
    order = _topological_order(graph)
    try:
        forward = _ForwardPass(calendar, project_start, settings)
        for node in order:
            _, task_id = node
            forward.out[task_id] = forward.leaf(by_id[task_id], graph.links_into.get(node, []))
    except OverflowError:       # elapsed time past year 9999 (or before year 1)
        raise CalendarError("a date runs past the range the calendar can reach") from None
    return forward.out
