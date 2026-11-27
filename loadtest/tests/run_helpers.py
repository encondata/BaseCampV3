"""Build a RunState for a move on the fake server (shared by the run-level tests)."""

from __future__ import annotations

import random
import uuid

from conftest import FAKE_BASE_URL
from fakeserver import FakeBaseCamp

from loadtest.clock import Clock
from loadtest.ids import make_tags
from loadtest.profile import Profile, containers_needed, trucks_needed
from loadtest.state import Container, RunState, Server, Truck


def state_for_move(fake: FakeBaseCamp, move_id: str, profile: Profile, clock: Clock) -> RunState:
    """Servers from the fake's roster with tags from `make_tags(random.Random(1), n)`,
    exactly the containers and trucks the profile needs (in name order), a dummy
    route with one point per location update, and both site ids."""
    move = fake.moves[move_id]
    assets = [a for a in fake.assets.values() if a["initiative_id"] == move_id]
    tags = make_tags(random.Random(1), len(assets))
    crates = sorted((c for c in fake.containers.values() if c["initiative_id"] == move_id),
                    key=lambda c: c["name"])[:containers_needed(profile, len(assets))]
    trucks = sorted((t for t in fake.trucks.values() if t["initiative_id"] == move_id),
                    key=lambda t: t["name"])[:trucks_needed(profile, len(crates))]
    return RunState(
        run_id=uuid.uuid5(uuid.NAMESPACE_URL, f"loadtest:{move_id}"),
        server_url=FAKE_BASE_URL,
        move_id=move_id,
        move_name=move["name"],
        profile_name=profile.name,
        profile_raw=profile.raw,
        origin_site_id=move["origin_site_id"],
        destination_site_id=move["destination_site_id"],
        route=[(39.0 + i * 0.01, -94.5 - i * 0.01) for i in range(profile.trip.updates)],
        started_at=clock.now(),
        servers={a["id"]: Server(a["id"], a["serial_number"], tag)
                 for a, tag in zip(assets, tags)},
        containers={c["id"]: Container(c["id"], c["name"]) for c in crates},
        trucks={t["id"]: Truck(t["id"], t["name"]) for t in trucks},
    )
