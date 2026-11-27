"""The move as a pipeline: servers flow through ordered stages on an injectable clock.

The engine makes no calls itself. For every step it waits the stage's time on the
clock, awaits `perform(step)`, then folds the matching journal entry into the run
state. A later layer turns steps into HTTP calls.
"""

from __future__ import annotations

import asyncio
import bisect
import random
from collections.abc import Awaitable, Callable, Hashable, Iterable
from dataclasses import dataclass
from typing import Literal

from .clock import Clock
from .journal import Journal
from .profile import Profile, StageSpec
from .state import RunState

StepKind = Literal["each", "cart", "pack", "unpack", "load", "unload", "depart", "location",
                   "arrive"]


@dataclass(frozen=True)
class Step:
    kind: StepKind
    stage: str  # stage key ("trip" for depart/location/arrive)
    crew: int  # 0-based crew index within the stage
    server_ids: tuple[str, ...] = ()
    container_id: str | None = None
    truck_id: str | None = None
    index: int = 0  # location update number, 1-based


Perform = Callable[[Step], Awaitable[bool]]  # True when the call landed


@dataclass(frozen=True)
class StageProgress:
    key: str
    label: str
    done: int
    total: int  # servers, except truck stages count containers and trip counts trucks arrived


class _Pool:
    """Items ready for a stage, kept sorted, plus whether upstream has finished.

    `take(n)` waits for `n` items, or for whatever is left once upstream has finished.
    The check and the take happen with no await between them, so two crews never
    split one short remainder.
    """

    def __init__(self, key: Callable[[str], Hashable] | None = None):
        self._key = key
        self._items: list[str] = []
        self._finished = False
        self._changed = asyncio.Event()

    def put(self, items: Iterable[str]) -> None:
        for item in items:
            bisect.insort(self._items, item, key=self._key)
        self._wake()

    def finish(self) -> None:
        self._finished = True
        self._wake()

    def _wake(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()

    async def take(self, n: int) -> list[str] | None:
        """Up to `n` items; None once upstream has finished and nothing is left."""
        while True:
            if len(self._items) >= n or (self._finished and self._items):
                taken = self._items[:n]
                del self._items[:n]
                return taken
            if self._finished:
                return None
            await self._changed.wait()


class Pipeline:
    def __init__(self, profile: Profile, state: RunState, perform: Perform, clock: Clock,
                 rng: random.Random, journal: Journal | None = None,
                 on_change: Callable[[], None] | None = None):
        self.profile = profile
        self.state = state
        self.perform = perform
        self.clock = clock
        self.rng = rng
        self.journal = journal
        self.on_change = on_change
        self._run_task: asyncio.Task | None = None
        self._tg: asyncio.TaskGroup | None = None
        # Containers and trucks in the order the state lists them.
        self._container_order = {cid: i for i, cid in enumerate(state.containers)}
        self._unused_containers = list(state.containers)
        self._truck_ids = list(state.trucks)
        self._load_truck = 0  # index of the truck now being filled
        self._load_claimed = 0  # containers claimed for that truck
        self._loaded: dict[str, int] = {tid: 0 for tid in state.trucks}
        self._departing: set[str] = set()

    # -- running ------------------------------------------------------------

    async def run(self) -> None:
        """Returns once loading is finished and every loaded truck has departed."""
        self._run_task = asyncio.current_task()
        stages = self.profile.stages
        trip_at = next(i for i, s in enumerate(stages) if s.kind == "trip")
        origin = stages[:trip_at]  # stages after the trip are Task 5's
        first = _Pool()
        first.put(sorted(self.state.servers))
        first.finish()
        async with asyncio.TaskGroup() as tg:
            self._tg = tg
            inbox = first
            for spec in origin:
                if spec.kind == "truck_load":
                    tg.create_task(self._run_stage(spec, inbox, None, self._load_crew))
                    break
                outbox = _Pool(self._container_order.get if spec.kind == "pack" else None)
                crew_fn = {"each": self._each_crew, "cart": self._cart_crew,
                           "pack": self._pack_crew}[spec.kind]
                tg.create_task(self._run_stage(spec, inbox, outbox, crew_fn))
                inbox = outbox

    async def _run_stage(self, spec: StageSpec, inbox: _Pool, outbox: _Pool | None,
                         crew_fn) -> None:
        async with asyncio.TaskGroup() as tg:
            for crew in range(spec.crews):
                tg.create_task(crew_fn(spec, crew, inbox, outbox))
        if spec.kind == "truck_load":
            self._depart_remaining()
        if outbox is not None:
            outbox.finish()

    # -- crews --------------------------------------------------------------

    async def _each_crew(self, spec: StageSpec, crew: int, inbox: _Pool, outbox: _Pool) -> None:
        while (taken := await inbox.take(1)) is not None:
            await self._server_step(spec, crew, "each", taken, outbox)

    async def _cart_crew(self, spec: StageSpec, crew: int, inbox: _Pool, outbox: _Pool) -> None:
        while (taken := await inbox.take(spec.batch)) is not None:
            await self._server_step(spec, crew, "cart", taken, outbox)

    async def _server_step(self, spec: StageSpec, crew: int, kind: StepKind, server_ids: list[str],
                           outbox: _Pool) -> None:
        await self.clock.sleep(self._draw(spec))
        ok = await self._perform(Step(kind, spec.key, crew, tuple(server_ids)))
        self._record({"t": "stage_done", "stage": spec.key, "servers": list(server_ids),
                      "ok": ok})
        outbox.put(server_ids)

    async def _pack_crew(self, spec: StageSpec, crew: int, inbox: _Pool, outbox: _Pool) -> None:
        while (server_ids := await inbox.take(self.profile.container_size)) is not None:
            cid = self._claim_container()
            share = self._draw(spec) / len(server_ids) if spec.per == "container" else None
            for sid in server_ids:
                await self.clock.sleep(share if share is not None else self._draw(spec))
                ok = await self._perform(Step("pack", spec.key, crew, (sid,), container_id=cid))
                self._record({"t": "packed", "stage": spec.key, "server": sid,
                              "container": cid, "ok": ok})
            self._record({"t": "container_closed", "container": cid})
            outbox.put([cid])

    async def _load_crew(self, spec: StageSpec, crew: int, inbox: _Pool, _outbox) -> None:
        while (taken := await inbox.take(1)) is not None:
            cid = taken[0]
            truck = self._claim_truck_slot()
            await self.clock.sleep(self._draw(spec))
            ok = await self._perform(Step("load", spec.key, crew, container_id=cid,
                                          truck_id=truck))
            self._record({"t": "loaded", "container": cid, "truck": truck, "ok": ok})
            self._loaded[truck] += 1
            if self._loaded[truck] == self.profile.containers_per_truck:
                self._start_trip(truck)

    # -- trucks -------------------------------------------------------------

    def _depart_remaining(self) -> None:
        """No more containers will close: every truck holding some leaves."""
        for truck in self._truck_ids:
            if self._loaded[truck] > 0:
                self._start_trip(truck)

    def _start_trip(self, truck: str) -> None:
        if truck in self._departing:
            return
        self._departing.add(truck)
        assert self._tg is not None
        self._tg.create_task(self._trip(truck))  # never blocks the next truck's loading

    async def _trip(self, truck: str) -> None:
        # Stub: Task 5 adds the location updates, the arrival and the destination.
        await self._perform(Step("depart", "trip", 0, truck_id=truck))
        self._record({"t": "departed", "truck": truck})

    # -- helpers ------------------------------------------------------------

    def _draw(self, spec: StageSpec) -> float:
        lo, hi = spec.seconds
        return self.rng.uniform(lo, hi)

    async def _perform(self, step: Step) -> bool:
        # A crew woken in the same instant as a cancel must not start a call.
        if self._run_task is not None and self._run_task.cancelling():
            raise asyncio.CancelledError()
        return await self.perform(step)

    def _record(self, entry: dict) -> None:
        entry["at"] = self.clock.now()
        self.state.apply(entry)
        if self.journal is not None:
            self.journal.append(entry)
        if self.on_change is not None:
            self.on_change()

    def _claim_container(self) -> str:
        if not self._unused_containers:
            raise RuntimeError("the run has more servers than its containers can hold")
        return self._unused_containers.pop(0)

    def _claim_truck_slot(self) -> str:
        if self._load_claimed == self.profile.containers_per_truck:
            self._load_truck += 1
            self._load_claimed = 0
        if self._load_truck >= len(self._truck_ids):
            raise RuntimeError("the run has more containers than its trucks can carry")
        self._load_claimed += 1
        return self._truck_ids[self._load_truck]

    # -- progress -----------------------------------------------------------

    def progress(self) -> list[StageProgress]:
        servers = self.state.servers.values()
        containers = self.state.containers.values()
        trucks = self.state.trucks.values()
        out = []
        for spec in self.profile.stages:
            if spec.kind == "truck_load":
                done, total = sum(c.truck_id is not None for c in containers), len(containers)
            elif spec.kind == "truck_unload":
                done, total = sum(c.unloaded for c in containers), len(containers)
            elif spec.kind == "trip":
                done, total = sum(t.arrived for t in trucks), len(trucks)
            else:
                done, total = sum(spec.key in s.done for s in servers), len(servers)
            out.append(StageProgress(spec.key, spec.label, done, total))
        return out
