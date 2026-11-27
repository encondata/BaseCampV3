"""Builders shared by the pipeline tests."""

from __future__ import annotations

import random
import uuid

from loadtest.clock import Clock
from loadtest.ids import make_tags
from loadtest.pipeline import Step
from loadtest.profile import Profile, load_profile, profile_path
from loadtest.state import Container, RunState, Server, Truck


def real_time() -> Profile:
    return load_profile(profile_path("real-time"))


def fast() -> Profile:
    return load_profile(profile_path("fast"))


def make_state(servers: int, containers: int, trucks: int, profile: Profile | None = None,
               started_at: float = 1_800_000_000.0) -> RunState:
    profile = profile or real_time()
    tags = make_tags(random.Random(1), servers)
    server_ids = [f"s{i:04d}" for i in range(1, servers + 1)]
    container_ids = [f"c{i:03d}" for i in range(1, containers + 1)]
    truck_ids = [f"t{i:02d}" for i in range(1, trucks + 1)]
    return RunState(
        run_id=uuid.UUID(int=42),
        server_url="http://localhost:8000",
        move_id="move-1",
        move_name="Load test move",
        profile_name=profile.name,
        profile_raw=profile.raw,
        origin_site_id="site-origin",
        destination_site_id="site-destination",
        route=[(40.0 + i * 0.01, -75.0 + i * 0.01) for i in range(68)],
        started_at=started_at,
        servers={sid: Server(sid, f"LOADTEST-SRV-{sid}", tag) for sid, tag in zip(server_ids, tags)},
        containers={cid: Container(cid, f"Load test container {cid}") for cid in container_ids},
        trucks={tid: Truck(tid, f"Load test truck {tid}") for tid in truck_ids},
    )


class Recorder:
    """A `perform` callback that records (virtual seconds since start, step).

    `fail` holds (stage key, subject id) pairs; a step whose stage matches and whose
    servers, container or truck include the subject returns False.
    """

    def __init__(self, clock: Clock, fail: set[tuple[str, str]] | None = None):
        self.clock = clock
        self.start = clock.now()
        self.fail = fail or set()
        self.steps: list[tuple[float, Step]] = []

    async def __call__(self, step: Step) -> bool:
        self.steps.append((self.clock.now() - self.start, step))
        subjects = set(step.server_ids) | {step.container_id, step.truck_id}
        return not any(stage == step.stage and subject in subjects
                       for stage, subject in self.fail)

    def of(self, stage: str) -> list[tuple[float, Step]]:
        return [(t, s) for t, s in self.steps if s.stage == stage]
