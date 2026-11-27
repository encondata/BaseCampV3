import asyncio
import random
from collections import Counter, defaultdict

import pytest

from loadtest.clock import FakeClock
from loadtest.journal import Journal, load_state, start_entry
from loadtest.pipeline import Pipeline

from pipeline_helpers import Recorder, fast, make_state, real_time

ORIGIN_SERVER_STAGES = ["enroll", "cage_exit", "label", "loading_dock", "pack"]
LIMIT = 200_000


class RecordingRandom(random.Random):
    """Logs every uniform(a, b) draw so a test can pick out one stage's draws."""

    def __init__(self, seed):
        super().__init__(seed)
        self.draws: list[tuple[float, float, float]] = []

    def uniform(self, a, b):
        value = super().uniform(a, b)
        self.draws.append((a, b, value))
        return value


class SlowDepartRecorder(Recorder):
    """A Recorder whose depart call takes DEPART_SECONDS on the clock."""

    DEPART_SECONDS = 1000.0

    async def __call__(self, step):
        landed = await super().__call__(step)
        if step.kind == "depart":
            await self.clock.sleep(self.DEPART_SECONDS)
        return landed


async def run_pipeline(servers, containers, trucks, profile=None, fail=None, rng=None,
                       journal=None, state=None, recorder_cls=Recorder):
    profile = profile or real_time()
    clock = FakeClock()
    state = state or make_state(servers, containers, trucks, profile, started_at=clock.now())
    recorder = recorder_cls(clock, fail)
    pipeline = Pipeline(profile, state, recorder, clock, rng or random.Random(7), journal=journal)
    await clock.run(pipeline.run(), limit=LIMIT)
    return pipeline, recorder, clock


async def test_every_server_passes_origin_stages_in_order():
    pipeline, rec, _ = await run_pipeline(45, 3, 1)
    seen = defaultdict(list)
    for _, step in rec.steps:
        for sid in step.server_ids:
            seen[sid].append(step.stage)
    assert set(seen) == set(pipeline.state.servers)
    for sid, stages in seen.items():
        assert stages == ORIGIN_SERVER_STAGES, sid


async def test_last_cart_is_short_only_after_upstream_is_done():
    _, rec, _ = await run_pipeline(25, 2, 1)
    carts = rec.of("cage_exit")
    assert [len(s.server_ids) for _, s in carts] == [10, 10, 5]
    last_enroll = max(t for t, _ in rec.of("enroll"))
    short_time = [t for t, s in carts if len(s.server_ids) == 5][0]
    assert short_time > last_enroll


async def test_enroll_pace_is_five_people_at_fifteen_seconds():
    _, rec, _ = await run_pipeline(50, 3, 1)
    times = Counter(t for t, _ in rec.of("enroll"))
    assert times == {15.0 * k: 5 for k in range(1, 11)}
    assert max(times) == 150.0
    crews = Counter(s.crew for _, s in rec.of("enroll"))
    assert crews == {c: 10 for c in range(5)}


async def test_label_waits_fall_in_15_to_30_seconds():
    rng = RecordingRandom(3)
    _, rec, clock = await run_pipeline(40, 2, 1, rng=rng)
    label_draws = [v for a, b, v in rng.draws if (a, b) == (15, 30)]
    assert len(label_draws) == len(rec.of("label")) == 40
    assert all(15 <= v <= 30 for v in label_draws)
    assert len(set(label_draws)) > 1  # a fresh pick each time
    remaining = Counter(clock.sleeps)
    for v in label_draws:
        assert remaining[v] > 0  # every draw was slept on the clock
        remaining[v] -= 1


async def test_stages_overlap():
    # 300 servers: enroll alone takes 900 s, longer than the first cart's 600 s at the cage exit
    _, rec, _ = await run_pipeline(300, 15, 1)
    first_label = min(t for t, _ in rec.of("label"))
    assert first_label < max(t for t, _ in rec.of("enroll"))
    assert first_label < max(t for t, _ in rec.of("cage_exit"))


async def test_containers_fill_to_twenty_then_short():
    _, rec, _ = await run_pipeline(45, 3, 1)
    per_container = Counter(s.container_id for _, s in rec.of("pack"))
    assert [per_container[c] for c in ("c001", "c002", "c003")] == [20, 20, 5]


async def test_pack_spreads_one_container_over_seven_minutes():
    _, rec, _ = await run_pipeline(40, 2, 1)
    steps = [(t, s) for t, s in rec.of("pack") if s.container_id == "c001"]
    assert len(steps) == 20
    assert len({s.crew for _, s in steps}) == 1
    times = [t for t, _ in steps]
    gaps = [b - a for a, b in zip(times, times[1:])]
    assert gaps == pytest.approx([21.0] * 19)


async def test_a_short_container_takes_its_share_of_the_time():
    # 7 min is a full container's time; 5 servers take 5 shares of 420 / 20 = 21 s
    _, rec, _ = await run_pipeline(45, 3, 1)
    times = [t for t, s in rec.of("pack") if s.container_id == "c003"]
    assert len(times) == 5
    assert [b - a for a, b in zip(times, times[1:])] == pytest.approx([21.0] * 4)


async def test_trucks_depart_full_or_when_nothing_is_left():
    pipeline, rec, _ = await run_pipeline(340, 17, 2, recorder_cls=SlowDepartRecorder)
    assert pipeline.profile.containers_per_truck == 15
    by_truck = defaultdict(list)
    for i, (t, s) in enumerate(rec.steps):
        if s.kind in ("load", "depart"):
            by_truck[s.truck_id].append((i, t, s.kind))
    assert [k for _, _, k in by_truck["t01"]] == ["load"] * 15 + ["depart"]
    assert [k for _, _, k in by_truck["t02"]] == ["load"] * 2 + ["depart"]
    for truck in ("t01", "t02"):
        *loads, depart = by_truck[truck]
        assert depart[1] >= loads[-1][1]
    # t01's trip never blocks loading: a t02 load lands while t01's depart call is running
    depart_t01 = by_truck["t01"][-1][1]
    window_end = depart_t01 + SlowDepartRecorder.DEPART_SECONDS
    assert any(depart_t01 <= t < window_end for _, t, kind in by_truck["t02"] if kind == "load")
    assert pipeline.state.trucks["t01"].departed_at is not None
    assert pipeline.state.trucks["t02"].departed_at is not None


async def test_tiny_move_finishes():
    pipeline, rec, _ = await run_pipeline(3, 1, 1)
    assert [len(s.server_ids) for _, s in rec.of("cage_exit")] == [3]
    assert [len(s.server_ids) for _, s in rec.of("loading_dock")] == [3]
    assert [s.container_id for _, s in rec.of("pack")] == ["c001"] * 3
    assert [s.kind for _, s in rec.of("truck_load")] == ["load"]
    assert [(s.kind, s.truck_id) for _, s in rec.of("trip")] == [("depart", "t01")]
    assert pipeline.state.containers["c001"].closed


async def test_a_failed_call_does_not_hold_the_server_back():
    pipeline, rec, _ = await run_pipeline(20, 1, 1, fail={("label", "s0001")})
    stages = [s.stage for _, s in rec.steps if "s0001" in s.server_ids]
    assert stages == ORIGIN_SERVER_STAGES
    done = pipeline.state.servers["s0001"].done
    assert done["label"] is False
    assert done["loading_dock"] is True and done["pack"] is True


async def test_fast_profile_waits_are_half_to_one_second():
    _, rec, clock = await run_pipeline(40, 2, 1, profile=fast())
    assert clock.sleeps and all(0.5 <= s <= 1.0 for s in clock.sleeps)
    departs = [t for t, s in rec.steps if s.kind == "depart"]
    assert len(departs) == 1 and departs[0] < 600


async def _cancel_after(seconds):
    clock = FakeClock()
    profile = real_time()
    state = make_state(50, 3, 1, profile, started_at=clock.now())
    rec = Recorder(clock)
    pipeline = Pipeline(profile, state, rec, clock, random.Random(7))
    outcome = {}

    async def scenario():
        task = asyncio.create_task(pipeline.run())
        await clock.sleep(seconds)
        task.cancel()
        outcome["at_cancel"] = len(rec.steps)
        try:
            await task
        except asyncio.CancelledError:
            outcome["cancelled"] = True

    await clock.run(scenario(), limit=LIMIT)
    return rec, outcome


async def test_cancel_stops_cleanly():
    rec, outcome = await _cancel_after(100)
    assert outcome.get("cancelled") is True
    assert len(rec.steps) == outcome["at_cancel"] > 0
    assert all(t <= 100 for t, _ in rec.steps)


async def test_cancel_on_a_wake_starts_no_more_calls():
    # Enroll crews wake at t=90 in the same instant the cancel lands; none may call.
    rec, outcome = await _cancel_after(90)
    assert outcome.get("cancelled") is True
    assert len(rec.steps) == outcome["at_cancel"]
    assert max(t for t, _ in rec.steps) == 75.0


async def test_journal_and_state_follow_every_step(tmp_path):
    clock = FakeClock()
    profile = real_time()
    state = make_state(45, 3, 1, profile, started_at=clock.now())
    path = tmp_path / "journal.jsonl"
    journal = Journal(path)
    journal.append(start_entry(state))
    changes = []
    rec = Recorder(clock, fail={("label", "s0002"), ("truck_load", "c002")})
    pipeline = Pipeline(profile, state, rec, clock, random.Random(7), journal=journal,
                        on_change=lambda: changes.append(1))
    await clock.run(pipeline.run(), limit=LIMIT)
    journal.close()
    assert load_state(path) == pipeline.state
    lines = path.read_text().splitlines()
    assert len(changes) == len(lines) - 1  # one change per entry after run_started
    assert pipeline.state.servers["s0002"].done["label"] is False
    assert pipeline.state.containers["c002"].truck_id == "t01"


async def test_progress_counts():
    pipeline, _, _ = await run_pipeline(45, 3, 1)
    progress = {p.key: p for p in pipeline.progress()}
    assert list(progress) == [s.key for s in pipeline.profile.stages]
    for key in ORIGIN_SERVER_STAGES:
        assert progress[key].done == progress[key].total == 45, key
    assert progress["truck_load"].done == progress["truck_load"].total == 3
    assert progress["trip"].total == 1
    for spec in pipeline.profile.stages:
        if spec.site == "destination":
            assert progress[spec.key].done == 0
    assert progress["enroll"].label == "RFID enroll"
