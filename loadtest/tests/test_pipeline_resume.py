"""Continuing a run: cancel a pipeline, reload its journal, run a fresh one."""

import asyncio
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
    # label starts at about 645 s (first cart through the cage exit at 630); stop inside it
    first, _ = await move.run(cancel_at=700)
    assert first.of("label") and not first.of("loading_dock")
    second, before = await move.run()
    assert_nothing_redone(second, before)
    counts = server_stage_counts(first, second)
    for sid in before.servers:
        for key in server_stage_keys(profile):
            assert counts[(sid, key)] == 1, (sid, key)
    assert_complete(move.state(), profile)


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
    # Every 3.7 s from start to end: stops land in every stage, the trip included.
    cancel_times = [3.7 * k for k in range(1, int(end // 3.7) + 1)]
    assert len(cancel_times) >= 30
    resent = 0  # server steps cut off mid-call by a cancel and sent again
    for i, cancel_at in enumerate(cancel_times):
        move = Move(tmp_path / f"stop{i}", 45, 3, 1, profile, SlowRecorder)
        first, _ = await move.run(cancel_at=cancel_at)
        second, before = await move.run()
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
