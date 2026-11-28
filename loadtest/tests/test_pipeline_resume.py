"""Continuing a run: cancel a pipeline, reload its journal, run a fresh one."""

import asyncio
import json
import random
from collections import Counter

import pytest

from loadtest.clock import FakeClock
from loadtest.journal import Journal, load_state, start_entry
from loadtest.pipeline import Pipeline

from pipeline_helpers import Recorder, fast, make_state, real_time

LIMIT = 400_000


class SlowRecorder(Recorder):
    """Each call takes `seconds` on the clock, so a cancel can land mid-call."""

    seconds = 0.25

    async def __call__(self, step):
        landed = await super().__call__(step)
        await self.clock.sleep(self.seconds)
        return landed


class Move:
    """One move on one FakeClock, run in pieces against one journal file."""

    def __init__(self, tmp_path, servers, containers, trucks, profile, recorder_cls=Recorder):
        self.clock = FakeClock()
        self.profile = profile
        self.recorder_cls = recorder_cls
        self.path = tmp_path / "journal.jsonl"
        state = make_state(servers, containers, trucks, profile, started_at=self.clock.now())
        journal = Journal(self.path)
        journal.append(start_entry(state))
        journal.close()

    async def run(self, cancel_at: float | None = None):
        """Run a fresh Pipeline on the reloaded state, in its own task, until it ends or
        `cancel_at` virtual seconds pass. Returns (recorder, state it started from)."""
        state = load_state(self.path)
        before = load_state(self.path)
        journal = Journal(self.path)
        rec = self.recorder_cls(self.clock)
        pipeline = Pipeline(self.profile, state, rec, self.clock, random.Random(5),
                            journal=journal)

        async def scenario():
            task = asyncio.create_task(pipeline.run())
            if cancel_at is None:
                await task
                return
            timer = asyncio.create_task(self.clock.sleep(cancel_at))
            await asyncio.wait({task, timer}, return_when=asyncio.FIRST_COMPLETED)
            timer.cancel()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, timer, return_exceptions=True)

        try:
            await self.clock.run(scenario(), limit=LIMIT)
        finally:
            journal.close()
        return rec, before

    async def wait(self, seconds: float):
        """The runner is down: virtual time passes with nothing running."""
        await self.clock.run(self.clock.sleep(seconds))

    def state(self):
        return load_state(self.path)


def server_stage_counts(*recorders) -> Counter:
    counts = Counter()
    for rec in recorders:
        for _, step in rec.steps:
            if step.kind in ("each", "cart", "pack", "unpack"):
                for sid in step.server_ids:
                    counts[(sid, step.stage)] += 1
    return counts


def server_stage_keys(profile):
    return [s.key for s in profile.stages if s.kind in ("each", "cart", "pack", "unpack")]


def assert_complete(state, profile):
    keys = set(server_stage_keys(profile))
    for server in state.servers.values():
        assert set(server.done) == keys, server.id
    for c in state.containers.values():
        if c.server_ids:
            assert c.closed and c.truck_id and c.unloaded and c.unpacked == set(c.server_ids)
    assert all(t.arrived for t in state.trucks.values() if t.container_ids)


def journal_entries(move, kind):
    return [e for e in map(json.loads, move.path.read_text().splitlines()) if e["t"] == kind]


def stop_kinds(state) -> set[str]:
    """Which mid-move situations a stopped run's state holds."""
    containers = state.containers.values()
    trucks = state.trucks.values()
    kinds = set()
    if any(not c.closed and c.server_ids for c in containers):
        kinds.add("part-packed")
    if any(c.closed and c.truck_id is None for c in containers):
        kinds.add("closed-not-loaded")
    if any(t.container_ids and t.departed_at is None for t in trucks):
        kinds.add("loaded-more-to-come")
    if any(t.departed_at is not None and not t.arrived for t in trucks):
        kinds.add("mid-trip")
    if any(t.arrived and any(not state.containers[c].unloaded for c in t.container_ids)
           for t in trucks):
        kinds.add("arrived-not-unloaded")
    if any(c.unloaded and 0 < len(c.unpacked) < len(c.server_ids) for c in containers):
        kinds.add("part-unpacked")
    if any("unpack" in s.done and "complete" not in s.done for s in state.servers.values()):
        kinds.add("mid-destination")
    return kinds


ALL_STOP_KINDS = {"part-packed", "closed-not-loaded", "loaded-more-to-come", "mid-trip",
                  "arrived-not-unloaded", "part-unpacked", "mid-destination"}


def assert_nothing_redone(rec, before):
    """No step in the continued run is for something the reloaded state had finished."""
    for _, step in rec.steps:
        for sid in step.server_ids:
            assert step.stage not in before.servers[sid].done, (sid, step.stage)
        if step.kind == "load":
            assert before.containers[step.container_id].truck_id is None
        if step.kind == "unload":
            assert not before.containers[step.container_id].unloaded
        if step.kind == "depart":
            assert before.trucks[step.truck_id].departed_at is None
        if step.kind == "location":
            assert step.index > before.trucks[step.truck_id].updates_sent
        if step.kind == "arrive":
            assert not before.trucks[step.truck_id].arrived


async def test_continue_performs_only_what_is_left(tmp_path):
    profile = real_time()
    move = Move(tmp_path, 45, 3, 1, profile)
    # enroll is complete at 135 s, the first carts are through the cage exit 600 s later
    # (735 s) and label starts at about 750 s; stop inside it
    first, _ = await move.run(cancel_at=800)
    assert first.of("label") and not first.of("loading_dock")
    second, before = await move.run()
    assert_nothing_redone(second, before)
    counts = server_stage_counts(first, second)
    for sid in before.servers:
        for key in server_stage_keys(profile):
            assert counts[(sid, key)] == 1, (sid, key)
    assert_complete(move.state(), profile)


async def test_continue_with_one_truck_on_the_road_and_one_loading(tmp_path):
    profile = real_time()
    probe = Move(tmp_path / "probe", 340, 17, 2, profile)
    full, _ = await probe.run()
    t02_loads = [t for t, s in full.of("truck_load") if s.truck_id == "t02"]
    move = Move(tmp_path / "move", 340, 17, 2, profile)
    await move.run(cancel_at=(t02_loads[0] + t02_loads[1]) / 2)
    stopped = move.state()
    t01, t02 = stopped.trucks["t01"], stopped.trucks["t02"]
    assert t01.departed_at is not None and not t01.arrived and t01.updates_sent < 68
    assert len(t02.container_ids) == 1 and t02.departed_at is None

    second, before = await move.run()
    assert_nothing_redone(second, before)
    assert [(s.container_id, s.truck_id) for _, s in second.of("truck_load")] == [("c017", "t02")]
    departs = [s.truck_id for _, s in second.of("trip") if s.kind == "depart"]
    assert departs == ["t02"]
    t01_indexes = [s.index for _, s in second.of("trip")
                   if s.kind == "location" and s.truck_id == "t01"]
    assert t01_indexes == list(range(t01.updates_sent + 1, 69))
    final = move.state()
    assert final.trucks["t02"].container_ids == ["c016", "c017"]
    assert all(t.updates_skipped == 0 for t in final.trucks.values())
    assert_complete(final, profile)


async def test_continue_finishes_several_part_packed_containers(tmp_path):
    profile = real_time()
    probe = Move(tmp_path / "probe", 45, 3, 1, profile)
    full, _ = await probe.run()
    c001 = [t for t, s in full.of("pack") if s.container_id == "c001"]
    c002 = [t for t, s in full.of("pack") if s.container_id == "c002"]
    assert c002[0] < c001[-1]  # two crews pack at once
    move = Move(tmp_path / "move", 45, 3, 1, profile)
    await move.run(cancel_at=(c002[0] + c001[-1]) / 2)
    stopped = move.state()
    already = {c.id: list(c.server_ids) for c in stopped.containers.values()
               if c.server_ids and not c.closed}
    assert {"c001", "c002"} <= set(already)  # each crew stopped with its own container

    second, before = await move.run()
    assert_nothing_redone(second, before)
    packs = second.of("pack")
    crews = {cid: {s.crew for _, s in packs if s.container_id == cid} for cid in already}
    assert all(len(c) <= 1 for c in crews.values())
    used = [next(iter(c)) for c in crews.values() if c]
    assert len(used) == len(set(used))  # each part-packed container has its own crew
    counts = server_stage_counts(second)
    assert all(counts[(sid, "pack")] == 0 for ids in already.values() for sid in ids)
    final = move.state()
    for cid, ids in already.items():
        assert final.containers[cid].server_ids[:len(ids)] == ids
    assert [len(c.server_ids) for c in final.containers.values()] == [20, 20, 5]
    assert_complete(final, profile)


async def test_continue_finishes_a_part_packed_container(tmp_path):
    profile = real_time()
    probe = Move(tmp_path / "probe", 45, 3, 1, profile)
    full, _ = await probe.run()
    c001 = [t for t, s in full.of("pack") if s.container_id == "c001"]
    move = Move(tmp_path / "move", 45, 3, 1, profile)
    await move.run(cancel_at=c001[6] + 1)  # 7 servers in c001
    stopped = move.state()
    assert len(stopped.containers["c001"].server_ids) == 7
    assert not stopped.containers["c001"].closed
    already = list(stopped.containers["c001"].server_ids)

    second, before = await move.run()
    assert_nothing_redone(second, before)
    packs = second.of("pack")
    assert packs[0][1].container_id == "c001"
    first_c002 = min((t for t, s in packs if s.container_id == "c002"), default=None)
    c001_steps = [(t, s) for t, s in packs if s.container_id == "c001"]
    assert len(c001_steps) == 13
    assert first_c002 is None or c001_steps[0][0] < first_c002
    assert not set(already) & {s.server_ids[0] for _, s in c001_steps}
    final = move.state()
    assert [len(c.server_ids) for c in final.containers.values()] == [20, 20, 5]
    assert final.containers["c001"].server_ids[:7] == already
    assert_complete(final, profile)


async def _stop_after_updates(tmp_path, profile, updates):
    """A 20-server move stopped just after its truck's `updates`-th location update."""
    probe = Move(tmp_path / "probe", 20, 1, 1, profile)
    full, _ = await probe.run()
    locations = [t for t, s in full.of("trip") if s.kind == "location"]
    move = Move(tmp_path / "move", 20, 1, 1, profile)
    # the probe ran on its own clock from the same start, so its times carry over
    await move.run(cancel_at=(locations[updates - 1] + locations[updates]) / 2)
    stopped = move.state()
    assert stopped.trucks["t01"].updates_sent == updates
    return move, stopped


async def test_continue_real_time_trip_skips_missed_updates(tmp_path):
    profile = real_time()
    move, stopped = await _stop_after_updates(tmp_path, profile, 10)
    departed_at = stopped.trucks["t01"].departed_at
    await move.wait(10800)
    second, before = await move.run()
    assert_nothing_redone(second, before)
    trip = [s for _, s in second.of("trip")]
    assert [s.kind for s in trip] == ["location"] * 46 + ["arrive"]
    assert [s.index for s in trip[:-1]] == list(range(23, 69))  # 10 + 12 missed + 1
    final = move.state()
    assert final.trucks["t01"].updates_skipped == 12
    assert final.trucks["t01"].updates_sent == 68
    # the truck keeps to its 17-hour schedule from its departure
    arrive_at = second.start + [t for t, s in second.of("trip") if s.kind == "arrive"][0]
    assert arrive_at == pytest.approx(departed_at + 61200.0)
    assert_complete(final, profile)


async def test_a_trip_interrupted_twice_counts_each_skip_once(tmp_path):
    profile = real_time()
    move, _ = await _stop_after_updates(tmp_path, profile, 10)
    await move.wait(10800)
    second, _ = await move.run(cancel_at=100)  # skips 11-22, stops before 23 is due
    assert not [s for _, s in second.of("trip") if s.kind == "location"]
    assert move.state().trucks["t01"].updates_skipped == 12
    await move.wait(1800)
    third, before = await move.run()  # 23 and 24 fell in the second gap
    assert_nothing_redone(third, before)
    truck = move.state().trucks["t01"]
    assert truck.updates_skipped == 14 and truck.skipped_through == 24
    sent = [e["index"] for e in journal_entries(move, "location")]
    assert sent == list(range(1, 11)) + list(range(25, 69))
    assert [e["count"] for e in journal_entries(move, "location_skipped")] == [12, 14]
    assert_complete(move.state(), profile)


async def test_continue_real_time_trip_past_arrival_goes_straight_to_arrive(tmp_path):
    profile = real_time()
    move, stopped = await _stop_after_updates(tmp_path, profile, 10)
    await move.wait(61200)
    second, before = await move.run()
    assert_nothing_redone(second, before)
    trip = [(t, s) for t, s in second.of("trip")]
    assert [s.kind for _, s in trip] == ["arrive"]
    assert trip[0][0] == 0.0
    final = move.state()
    assert final.trucks["t01"].updates_skipped == 58
    assert final.trucks["t01"].arrived
    assert_complete(final, profile)


async def test_continue_fast_trip_continues_at_next_index(tmp_path):
    profile = fast()
    move, _ = await _stop_after_updates(tmp_path, profile, 30)
    await move.wait(10800)  # downtime does not skip fast updates
    second, before = await move.run()
    assert_nothing_redone(second, before)
    indexes = [s.index for _, s in second.of("trip") if s.kind == "location"]
    assert indexes == list(range(31, 69))
    final = move.state()
    assert final.trucks["t01"].updates_skipped == 0
    assert_complete(final, profile)


async def test_continue_an_arrival_that_was_not_journaled(tmp_path):
    # Calls take 0.25 s, so a cancel can land while `arrive` is in flight.
    profile = real_time()
    probe = Move(tmp_path / "probe", 20, 1, 1, profile, SlowRecorder)
    full, _ = await probe.run()
    (arrive_at,) = [t for t, s in full.of("trip") if s.kind == "arrive"]
    move = Move(tmp_path / "move", 20, 1, 1, profile, SlowRecorder)
    first, _ = await move.run(cancel_at=arrive_at + 0.1)
    assert first.of("trip")[-1][1].kind == "arrive"
    stopped = move.state()
    assert stopped.trucks["t01"].updates_sent == 68 and not stopped.trucks["t01"].arrived
    second, before = await move.run()
    assert_nothing_redone(second, before)
    assert [s.kind for _, s in second.of("trip")] == ["arrive"]
    assert move.state().trucks["t01"].updates_skipped == 0
    assert_complete(move.state(), profile)


async def test_an_arrival_continued_after_a_long_gap_skips_nothing(tmp_path):
    # All 68 updates were sent and `arrive` was cut off; the runner was then down long
    # past the next pause boundary. Nothing is left to skip, so nothing is journaled.
    profile = real_time()
    probe = Move(tmp_path / "probe", 20, 1, 1, profile, SlowRecorder)
    full, _ = await probe.run()
    (arrive_at,) = [t for t, s in full.of("trip") if s.kind == "arrive"]
    move = Move(tmp_path / "move", 20, 1, 1, profile, SlowRecorder)
    await move.run(cancel_at=arrive_at + 0.1)
    await move.wait(1800)
    second, _ = await move.run()
    assert [s.kind for _, s in second.of("trip")] == ["arrive"]
    assert journal_entries(move, "location_skipped") == []
    assert move.state().trucks["t01"].updates_skipped == 0


async def test_a_finished_run_continues_with_no_steps(tmp_path):
    profile = fast()
    move = Move(tmp_path, 25, 2, 1, profile)
    await move.run()
    again, _ = await move.run()
    assert again.steps == []


async def test_continue_from_any_stop(tmp_path):
    profile = fast()
    probe = Move(tmp_path / "probe", 45, 3, 1, profile, SlowRecorder)
    full, _ = await probe.run()
    end = full.steps[-1][0]
    keys = server_stage_keys(profile)
    # Every 2.9 s from start to end: stops land in every stage, the trip included (and
    # in the short moment a closed container waits for its truck).
    cancel_times = [2.9 * k for k in range(1, int(end // 2.9) + 1)]
    assert len(cancel_times) >= 30
    resent = 0  # server steps cut off mid-call by a cancel and sent again
    kinds_hit: set[str] = set()
    for i, cancel_at in enumerate(cancel_times):
        move = Move(tmp_path / f"stop{i}", 45, 3, 1, profile, SlowRecorder)
        first, _ = await move.run(cancel_at=cancel_at)
        second, before = await move.run()
        kinds_hit |= stop_kinds(before)
        assert_nothing_redone(second, before)
        first_counts = server_stage_counts(first)
        second_counts = server_stage_counts(second)
        for sid in before.servers:
            for key in keys:
                pair = (sid, key)
                if key in before.servers[sid].done:  # its step had returned
                    assert (first_counts[pair], second_counts[pair]) == (1, 0), (cancel_at, pair)
                else:  # never sent, or sent and cut off by the cancel
                    assert first_counts[pair] <= 1 and second_counts[pair] == 1, (cancel_at, pair)
                    resent += first_counts[pair]
        assert_complete(move.state(), profile)
    assert resent > 0  # the cut-off path was exercised
    assert kinds_hit == ALL_STOP_KINDS  # every mid-move situation was continued from


def test_trip_percent_counts_each_update_once_after_a_skip():
    """`updates_sent` is the last index sent, `skipped_through` the last one skipped: the
    trip has passed the larger of the two, never their sum."""
    from loadtest.snapshot import _trip_fraction
    profile = real_time()
    state = make_state(20, 1, 1, profile)
    t = next(iter(state.trucks))
    state.apply({"t": "departed", "truck": t, "at": 0.0, "ok": True})
    for i in range(1, 11):
        state.apply({"t": "location", "truck": t, "index": i, "ok": True, "at": 900.0 * i})
    state.apply({"t": "location_skipped", "truck": t, "through": 22, "count": 12, "at": 1.0})
    state.apply({"t": "location", "truck": t, "index": 23, "ok": True, "at": 2.0})
    assert _trip_fraction(state, profile) == 23 / 68
