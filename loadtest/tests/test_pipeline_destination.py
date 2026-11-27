import random
from collections import defaultdict

from loadtest.clock import FakeClock
from loadtest.pipeline import Pipeline

from pipeline_helpers import Recorder, fast, make_state, real_time

DESTINATION_SERVER_STAGES = ["unpack", "staging", "into_cage", "qa", "complete"]
SERVER_STAGES = ["enroll", "cage_exit", "label", "loading_dock", "pack",
                 *DESTINATION_SERVER_STAGES]
LIMIT = 400_000


async def run_pipeline(servers, containers, trucks, profile=None):
    profile = profile or real_time()
    clock = FakeClock()
    state = make_state(servers, containers, trucks, profile, started_at=clock.now())
    recorder = Recorder(clock)
    pipeline = Pipeline(profile, state, recorder, clock, random.Random(11))
    await clock.run(pipeline.run(), limit=LIMIT)
    return pipeline, recorder, clock


def trip_steps(rec, truck, kind):
    return [(t, s) for t, s in rec.of("trip") if s.truck_id == truck and s.kind == kind]


async def test_trip_is_68_updates_over_17_hours():
    _, rec, _ = await run_pipeline(20, 1, 1)
    locations = trip_steps(rec, "t01", "location")
    assert [s.index for _, s in locations] == list(range(1, 69))
    (depart_at, _), = trip_steps(rec, "t01", "depart")
    (arrive_at, _), = trip_steps(rec, "t01", "arrive")
    assert arrive_at - depart_at == 61200.0
    assert [t - depart_at for t, _ in locations] == [900.0 * i for i in range(1, 69)]


async def test_trucks_travel_together():
    _, rec, _ = await run_pipeline(340, 17, 2)
    (t01_arrive, _), = trip_steps(rec, "t01", "arrive")
    first_t02_location = trip_steps(rec, "t02", "location")[0][0]
    assert first_t02_location < t01_arrive


async def test_destination_order_per_server():
    pipeline, rec, _ = await run_pipeline(45, 3, 1)
    seen = defaultdict(list)
    for _, step in rec.steps:
        for sid in step.server_ids:
            seen[sid].append(step.stage)
    assert set(seen) == set(pipeline.state.servers)
    for sid, stages in seen.items():
        assert stages[stages.index("pack") + 1:] == DESTINATION_SERVER_STAGES, sid


async def test_unload_then_unpack_per_container():
    _, rec, _ = await run_pipeline(45, 3, 1)
    unloaded = {s.container_id: t for t, s in rec.of("truck_unload")}
    assert sorted(unloaded) == ["c001", "c002", "c003"]
    unpacks = rec.of("unpack")
    assert len(unpacks) == 45
    for t, s in unpacks:
        assert t > unloaded[s.container_id]
    (arrive_at, _), = trip_steps(rec, "t01", "arrive")
    assert min(unloaded.values()) > arrive_at


async def test_unpack_spreads_a_container_like_pack():
    _, rec, _ = await run_pipeline(45, 3, 1)
    for cid, count in (("c001", 20), ("c003", 5)):
        times = [t for t, s in rec.of("unpack") if s.container_id == cid]
        assert len(times) == count
        assert [b - a for a, b in zip(times, times[1:])] == [21.0] * (count - 1)


async def test_run_ends_when_every_server_is_complete():
    pipeline, rec, _ = await run_pipeline(45, 3, 1)
    assert all("complete" in s.done for s in pipeline.state.servers.values())
    for p in pipeline.progress():
        assert p.done == p.total, p
    # nothing happens after the last server is complete
    assert rec.steps[-1][1].stage == "complete"


async def test_fast_trip_sends_all_68():
    _, rec, clock = await run_pipeline(40, 2, 1, profile=fast())
    locations = trip_steps(rec, "t01", "location")
    assert [s.index for _, s in locations] == list(range(1, 69))
    (depart_at, _), = trip_steps(rec, "t01", "depart")
    times = [depart_at] + [t for t, _ in locations]
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert all(0.5 <= g <= 1.0 for g in gaps)
    assert all(0.5 <= s <= 1.0 for s in clock.sleeps)


async def test_whole_move_uneven_counts():
    # The profile has 13 stages; every one but trip and the two truck stages is a server's.
    pipeline, _, _ = await run_pipeline(45, 3, 1, profile=fast())
    for server in pipeline.state.servers.values():
        assert sorted(server.done) == sorted(SERVER_STAGES), server.id
        assert len(server.done) == 10
    sizes = [len(c.server_ids) for c in pipeline.state.containers.values()]
    assert sizes == [20, 20, 5]
    assert all(c.unloaded and c.unpacked == set(c.server_ids)
               for c in pipeline.state.containers.values())
    assert pipeline.state.trucks["t01"].arrived
    assert pipeline.state.trucks["t01"].updates_sent == 68
