"""The move as a pipeline: servers flow through ordered stages on an injectable clock.

The engine makes no calls itself. For every step it waits the stage's time on the
clock, awaits `perform(step)`, then folds the matching journal entry into the run
state. A later layer turns steps into HTTP calls.

`run()` starts from whatever the state holds, so the same code starts a new run and
continues an interrupted one.
"""

from __future__ import annotations

import asyncio
import bisect
import math
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

# Stages a server passes itself (the truck stages and the trip move containers and trucks).
_SERVER_KINDS = ("each", "cart", "pack", "unpack")


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
    """Items ready for a stage, plus whether upstream has finished.

    A sorted pool hands items out in id order (servers by id, containers in
    `state.containers` order via `key`), not in arrival order; an unsorted pool
    (`sort=False`) hands them out first in, first out.

    `take(n)` waits for `n` items, or for whatever is left once upstream has finished.
    The check and the take happen with no await between them, so two crews never
    split one short remainder.
    """

    def __init__(self, key: Callable[[str], Hashable] | None = None, sort: bool = True):
        self._key = key
        self._sort = sort
        self._items: list[str] = []
        self._finished = False
        self._changed = asyncio.Event()

    def put(self, items: Iterable[str]) -> None:
        for item in items:
            if self._sort:
                bisect.insort(self._items, item, key=self._key)
            else:
                self._items.append(item)
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
        self._container_order = {cid: i for i, cid in enumerate(state.containers)}
        self._truck_ids = list(state.trucks)
        self._fill_lock = asyncio.Lock()  # one pack crew at a time picks its servers
        # Filled in by _seed from the state when run() starts.
        self._part_packed: list[str] = []
        self._unused_containers: list[str] = []
        self._claimed: dict[str, int] = {}  # truck -> containers claimed for it
        self._loaded: dict[str, int] = {}  # truck -> containers loaded on it
        self._load_truck = 0  # index of the first truck that may still take containers
        self._departing: set[str] = set()  # trucks handed to the trip stage

    # -- running ------------------------------------------------------------

    async def run(self) -> None:
        """Returns when every server has passed the last stage."""
        self._run_task = asyncio.current_task()
        stages = self.profile.stages
        pools = [self._pool_for(spec) for spec in stages]
        self._seed(pools)
        pools[0].finish()
        async with asyncio.TaskGroup() as tg:
            for i, spec in enumerate(stages):
                outbox = pools[i + 1] if i + 1 < len(stages) else None
                tg.create_task(self._run_stage(spec, pools[i], outbox))

    def _pool_for(self, spec: StageSpec) -> _Pool:
        """The inbox of a stage: servers, containers or trucks."""
        if spec.kind in ("each", "cart", "pack"):
            return _Pool()
        if spec.kind == "truck_load":
            return _Pool(self._container_order.get)
        return _Pool(sort=False)  # trucks departing / arrived, containers unloaded

    def _seed(self, pools: list[_Pool]) -> None:
        """Put everything the state holds where it belongs."""
        stages = self.profile.stages
        at = {s.kind: i for i, s in enumerate(stages)}
        cap = self.profile.containers_per_truck
        server_stages = [(i, s.key) for i, s in enumerate(stages) if s.kind in _SERVER_KINDS]
        for sid in sorted(self.state.servers):
            done = self.state.servers[sid].done
            nxt = next((i for i, key in server_stages if key not in done), None)
            if nxt is not None and stages[nxt].kind != "unpack":  # unpack follows the container
                pools[nxt].put([sid])

        containers = self.state.containers.values()
        self._part_packed = [c.id for c in containers if not c.closed and c.server_ids]
        self._unused_containers = [c.id for c in containers if not c.closed and not c.server_ids]
        pools[at["truck_load"]].put(c.id for c in containers if c.closed and c.truck_id is None)

        trucks = self.state.trucks.values()
        self._loaded = {t.id: len(t.container_ids) for t in trucks}
        self._claimed = dict(self._loaded)
        on_road = sorted((t for t in trucks if t.departed_at is not None and not t.arrived),
                         key=lambda t: t.departed_at)
        full = [t for t in trucks if t.departed_at is None and self._loaded[t.id] >= cap]
        for t in on_road + full:
            self._departing.add(t.id)
            pools[at["trip"]].put([t.id])
        self._departing.update(t.id for t in trucks if t.arrived)
        pools[at["truck_unload"]].put(
            t.id for t in trucks
            if t.arrived and any(not self.state.containers[c].unloaded for c in t.container_ids)
        )
        pools[at["unpack"]].put(
            c.id for c in containers if c.unloaded and set(c.server_ids) - c.unpacked
        )

    async def _run_stage(self, spec: StageSpec, inbox: _Pool, outbox: _Pool | None) -> None:
        if spec.kind == "trip":
            await self._trip_stage(inbox, outbox)
        else:
            crew_fn = {"each": self._each_crew, "cart": self._cart_crew,
                       "pack": self._pack_crew, "truck_load": self._load_crew,
                       "truck_unload": self._unload_crew, "unpack": self._unpack_crew}[spec.kind]
            async with asyncio.TaskGroup() as tg:
                for crew in range(spec.crews):
                    tg.create_task(crew_fn(spec, crew, inbox, outbox))
        if spec.kind == "truck_load":
            self._depart_remaining(outbox)
        if outbox is not None:
            outbox.finish()

    # -- server crews -------------------------------------------------------

    async def _each_crew(self, spec: StageSpec, crew: int, inbox: _Pool, outbox) -> None:
        while (taken := await inbox.take(1)) is not None:
            await self._server_step(spec, crew, "each", taken, outbox)

    async def _cart_crew(self, spec: StageSpec, crew: int, inbox: _Pool, outbox) -> None:
        while (taken := await inbox.take(spec.batch)) is not None:
            await self._server_step(spec, crew, "cart", taken, outbox)

    async def _server_step(self, spec: StageSpec, crew: int, kind: StepKind, server_ids: list[str],
                           outbox: _Pool | None) -> None:
        await self.clock.sleep(self._draw(spec.seconds))
        ok = await self._perform(Step(kind, spec.key, crew, tuple(server_ids)))
        self._record({"t": "stage_done", "stage": spec.key, "servers": list(server_ids),
                      "ok": ok})
        if outbox is not None:
            outbox.put(server_ids)

    def _share(self, spec: StageSpec) -> float | None:
        """Per-server time when the stage's time is a whole container's, else None.

        A container's time is a full one's; a short container takes proportionally less.
        """
        if spec.per != "container":
            return None
        return self._draw(spec.seconds) / self.profile.container_size

    async def _next_container(self, inbox: _Pool) -> tuple[str, list[str]] | None:
        """The container to fill next and the servers that go in it.

        A part-packed container (from an interrupted run) is finished before a new
        one is opened.
        """
        async with self._fill_lock:
            size = self.profile.container_size
            if self._part_packed:
                cid = self._part_packed[0]
                need = size - len(self.state.containers[cid].server_ids)
                taken = (await inbox.take(need) if need > 0 else []) or []
                self._part_packed.pop(0)
                return cid, taken
            taken = await inbox.take(size)
            if taken is None:
                return None
            if not self._unused_containers:
                raise RuntimeError("the run has more servers than its containers can hold")
            return self._unused_containers.pop(0), taken

    async def _pack_crew(self, spec: StageSpec, crew: int, inbox: _Pool, outbox: _Pool) -> None:
        while (picked := await self._next_container(inbox)) is not None:
            cid, server_ids = picked
            share = self._share(spec)
            for sid in server_ids:
                await self.clock.sleep(share if share is not None else self._draw(spec.seconds))
                ok = await self._perform(Step("pack", spec.key, crew, (sid,), container_id=cid))
                self._record({"t": "packed", "stage": spec.key, "server": sid,
                              "container": cid, "ok": ok})
            self._record({"t": "container_closed", "container": cid})
            outbox.put([cid])

    async def _unpack_crew(self, spec: StageSpec, crew: int, inbox: _Pool, outbox) -> None:
        while (taken := await inbox.take(1)) is not None:
            container = self.state.containers[taken[0]]
            share = self._share(spec)
            for sid in [s for s in container.server_ids if s not in container.unpacked]:
                await self.clock.sleep(share if share is not None else self._draw(spec.seconds))
                ok = await self._perform(Step("unpack", spec.key, crew, (sid,),
                                              container_id=container.id))
                self._record({"t": "unpacked", "stage": spec.key, "server": sid,
                              "container": container.id, "ok": ok})
                if outbox is not None:
                    outbox.put([sid])  # ready for the next stage at once

    # -- truck crews --------------------------------------------------------

    async def _load_crew(self, spec: StageSpec, crew: int, inbox: _Pool, outbox: _Pool) -> None:
        while (taken := await inbox.take(1)) is not None:
            cid = taken[0]
            truck = self._claim_truck_slot()
            await self.clock.sleep(self._draw(spec.seconds))
            ok = await self._perform(Step("load", spec.key, crew, container_id=cid,
                                          truck_id=truck))
            self._record({"t": "loaded", "container": cid, "truck": truck, "ok": ok})
            self._loaded[truck] += 1
            if self._loaded[truck] == self.profile.containers_per_truck:
                self._send_off(truck, outbox)

    def _claim_truck_slot(self) -> str:
        cap = self.profile.containers_per_truck
        while self._load_truck < len(self._truck_ids):
            truck = self._truck_ids[self._load_truck]
            if truck not in self._departing and self._claimed[truck] < cap:
                self._claimed[truck] += 1
                return truck
            self._load_truck += 1
        raise RuntimeError("the run has more containers than its trucks can carry")

    def _depart_remaining(self, trips: _Pool) -> None:
        """No more containers will close: every truck holding some leaves."""
        for truck in self._truck_ids:
            if self._loaded[truck] > 0:
                self._send_off(truck, trips)

    def _send_off(self, truck: str, trips: _Pool) -> None:
        if truck not in self._departing:
            self._departing.add(truck)
            trips.put([truck])

    async def _unload_crew(self, spec: StageSpec, crew: int, inbox: _Pool, outbox) -> None:
        while (taken := await inbox.take(1)) is not None:
            truck = self.state.trucks[taken[0]]
            for cid in truck.container_ids:
                if self.state.containers[cid].unloaded:
                    continue
                await self.clock.sleep(self._draw(spec.seconds))
                ok = await self._perform(Step("unload", spec.key, crew, container_id=cid,
                                              truck_id=truck.id))
                self._record({"t": "unloaded", "container": cid, "ok": ok})
                outbox.put([cid])

    # -- the trip -----------------------------------------------------------

    async def _trip_stage(self, inbox: _Pool, outbox: _Pool) -> None:
        """Every truck handed over travels at once; none waits for another."""
        async with asyncio.TaskGroup() as tg:
            while (taken := await inbox.take(1)) is not None:
                tg.create_task(self._trip(taken[0], outbox))

    async def _trip(self, truck_id: str, arrived: _Pool) -> None:
        truck = self.state.trucks[truck_id]
        if truck.departed_at is None:
            ok = await self._perform(Step("depart", "trip", 0, truck_id=truck_id))
            self._record({"t": "departed", "truck": truck_id, "ok": ok})
        trip = self.profile.trip
        lo, hi = trip.pause_seconds
        fixed = lo == hi  # real time: updates keep to the clock since departure
        # Indexes already sent or already journaled as skipped are never counted again.
        first = max(truck.updates_sent, truck.skipped_through) + 1
        if fixed and lo > 0:
            due = math.floor((self.clock.now() - truck.departed_at) / lo) + 1
            last = min(due, trip.updates + 1) - 1  # last index that fell while down
            if last >= first:
                self._record({"t": "location_skipped", "truck": truck_id, "through": last,
                              "count": truck.updates_skipped + (last - first + 1)})
                first = due
        for index in range(first, trip.updates + 1):
            if fixed:
                wait = max(0.0, truck.departed_at + lo * index - self.clock.now())
            else:
                wait = self._draw(trip.pause_seconds)
            await self.clock.sleep(wait)
            ok = await self._perform(Step("location", "trip", 0, truck_id=truck_id, index=index))
            self._record({"t": "location", "truck": truck_id, "index": index, "ok": ok})
        ok = await self._perform(Step("arrive", "trip", 0, truck_id=truck_id))
        self._record({"t": "arrived", "truck": truck_id, "ok": ok})
        arrived.put([truck_id])

    # -- helpers ------------------------------------------------------------

    def _draw(self, seconds: tuple[float, float]) -> float:
        lo, hi = seconds
        return self.rng.uniform(lo, hi)

    async def _perform(self, step: Step) -> bool:
        # A crew woken in the same instant as a cancel must not start a call.
        # cancelling() stays above 0 until someone calls uncancel(), so each run()
        # must be awaited in its own task (the runner does that); a second run() in
        # a task that caught the CancelledError would refuse every call.
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
