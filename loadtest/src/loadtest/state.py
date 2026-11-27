"""In-memory run state, rebuilt entry by entry from the journal."""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field


@dataclass
class Server:
    id: str
    serial: str
    tag: str
    done: dict[str, bool] = field(default_factory=dict)  # stage key -> call landed
    container_id: str | None = None


@dataclass
class Container:
    id: str
    name: str
    server_ids: list[str] = field(default_factory=list)
    closed: bool = False  # packing finished
    truck_id: str | None = None  # set when loaded
    unloaded: bool = False
    unpacked: set[str] = field(default_factory=set)


@dataclass
class Truck:
    id: str
    name: str
    container_ids: list[str] = field(default_factory=list)
    departed_at: float | None = None
    updates_sent: int = 0
    updates_skipped: int = 0
    arrived: bool = False


@dataclass
class RunState:
    run_id: uuid.UUID
    server_url: str
    move_id: str
    move_name: str
    profile_name: str
    profile_raw: dict
    origin_site_id: str
    destination_site_id: str
    route: list[tuple[float, float]]  # lat/lng points
    started_at: float
    servers: dict[str, Server]
    containers: dict[str, Container]
    trucks: dict[str, Truck]
    interruptions: list[tuple[float, float | None]] = field(default_factory=list)
    finished: str | None = None  # None | "completed" | "stopped"

    def apply(self, entry: dict) -> None:
        """Fold one journal entry into the state.

        Applying the same entry twice leaves the same state: a step can be
        journaled, the process killed, and the step journaled again on continue.
        An unknown entry kind raises ValueError.
        """
        kind = entry.get("t")
        handler = _HANDLERS.get(kind)
        if handler is None:
            raise ValueError(f"unknown journal entry kind: {kind!r}")
        handler(self, entry)

    # -- handlers ---------------------------------------------------------

    def _run_started(self, e: dict) -> None:
        pass  # the state was built from this entry; see journal.load_state

    def _stage_done(self, e: dict) -> None:
        for sid in e["servers"]:
            self.servers[sid].done[e["stage"]] = bool(e["ok"])

    def _packed(self, e: dict) -> None:
        # The server is physically in the container whether or not the call landed.
        server = self.servers[e["server"]]
        container = self.containers[e["container"]]
        server.container_id = container.id
        if server.id not in container.server_ids:
            container.server_ids.append(server.id)
        server.done[e["stage"]] = bool(e["ok"])

    def _container_closed(self, e: dict) -> None:
        self.containers[e["container"]].closed = True

    def _loaded(self, e: dict) -> None:
        container = self.containers[e["container"]]
        truck = self.trucks[e["truck"]]
        container.truck_id = truck.id
        if container.id not in truck.container_ids:
            truck.container_ids.append(container.id)

    def _departed(self, e: dict) -> None:
        self.trucks[e["truck"]].departed_at = e["at"]

    def _location(self, e: dict) -> None:
        self.trucks[e["truck"]].updates_sent = e["index"]

    def _location_skipped(self, e: dict) -> None:
        # `count` is the truck's cumulative skipped total, so a repeat is harmless.
        self.trucks[e["truck"]].updates_skipped = e["count"]

    def _arrived(self, e: dict) -> None:
        self.trucks[e["truck"]].arrived = True

    def _unloaded(self, e: dict) -> None:
        self.containers[e["container"]].unloaded = True

    def _unpacked(self, e: dict) -> None:
        self.containers[e["container"]].unpacked.add(e["server"])
        self.servers[e["server"]].done[e["stage"]] = bool(e["ok"])

    def _interrupted(self, e: dict) -> None:
        if not any(stopped == e["at"] for stopped, _ in self.interruptions):
            self.interruptions.append((e["at"], None))

    def _resumed(self, e: dict) -> None:
        # One resume closes every open interruption: the run was down from the
        # first stop until now. A repeat of the same `at` is a no-op.
        if any(resumed == e["at"] for _, resumed in self.interruptions):
            return
        self.interruptions = [
            (stopped, e["at"] if resumed is None else resumed)
            for stopped, resumed in self.interruptions
        ]

    def _run_finished(self, e: dict) -> None:
        self.finished = e["reason"]


_HANDLERS = {
    "run_started": RunState._run_started,
    "stage_done": RunState._stage_done,
    "packed": RunState._packed,
    "container_closed": RunState._container_closed,
    "loaded": RunState._loaded,
    "departed": RunState._departed,
    "location": RunState._location,
    "location_skipped": RunState._location_skipped,
    "arrived": RunState._arrived,
    "unloaded": RunState._unloaded,
    "unpacked": RunState._unpacked,
    "interrupted": RunState._interrupted,
    "resumed": RunState._resumed,
    "run_finished": RunState._run_finished,
}
