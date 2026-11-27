import asyncio
import time

import pytest

from loadtest.clock import FakeClock, RealClock

START = 1_800_000_000.0


async def test_fake_clock_runs_sleepers_in_time_order_without_waiting():
    clock, seen = FakeClock(), []

    async def worker(name, s):
        await clock.sleep(s)
        seen.append((name, clock.now() - START))

    async def main():
        await asyncio.gather(worker("b", 600), worker("a", 15), worker("c", 61200))

    t0 = time.monotonic()
    await clock.run(main())
    assert seen == [("a", 15.0), ("b", 600.0), ("c", 61200.0)]
    assert time.monotonic() - t0 < 1.0


async def test_fake_clock_limit_stops_a_run_that_never_ends():
    clock = FakeClock()

    async def forever():
        while True:
            await clock.sleep(60)

    with pytest.raises(TimeoutError):
        await clock.run(forever(), limit=3600)


async def test_fake_clock_records_sleeps_and_returns_the_result():
    clock = FakeClock()

    async def main():
        await clock.sleep(5)
        await clock.sleep(0)
        await clock.sleep(2.5)
        return "done"

    assert await clock.run(main()) == "done"
    assert clock.sleeps == [5, 0, 2.5]
    assert clock.now() == START + 7.5


async def test_queue_handoff_registers_the_next_sleep_before_time_jumps():
    clock, finished = FakeClock(), []
    queue: asyncio.Queue[int] = asyncio.Queue()

    async def producer():
        await clock.sleep(10)
        await queue.put(1)

    async def consumer():
        await queue.get()
        await clock.sleep(5)
        finished.append(clock.now() - START)

    async def main():
        await asyncio.gather(producer(), consumer(), clock.sleep(100))

    await clock.run(main())
    assert finished == [15.0]


async def test_cancelled_sleeper_does_not_stall_the_heap():
    clock, seen = FakeClock(), {}

    async def victim():
        try:
            await clock.sleep(15)
            seen["victim"] = "woke"
        except asyncio.CancelledError:
            seen["victim"] = clock.now() - START
            raise

    async def main():
        task = asyncio.create_task(victim())
        await clock.sleep(10)
        task.cancel()
        await clock.sleep(20)
        seen["killer"] = clock.now() - START
        with pytest.raises(asyncio.CancelledError):
            await task

    await clock.run(main())
    assert seen == {"victim": 10.0, "killer": 30.0}


async def test_deep_queue_chain_settles_before_time_moves():
    clock, seen = FakeClock(), {}
    queues = [asyncio.Queue() for _ in range(201)]

    async def first():
        await clock.sleep(10)
        await queues[0].put(1)

    async def link(i):
        await queues[i].get()
        await queues[i + 1].put(1)

    async def last():
        await queues[200].get()
        await clock.sleep(5)
        seen["last"] = clock.now() - START

    async def other():
        await clock.sleep(12)
        seen["other"] = clock.now() - START

    async def main():
        await asyncio.gather(first(), *(link(i) for i in range(200)), last(), other())

    await clock.run(main())
    assert seen == {"last": 15.0, "other": 12.0}


async def test_many_explicit_yields_do_not_let_time_jump():
    clock, seen = FakeClock(), {}

    async def yielder():
        await clock.sleep(10)
        for _ in range(500):
            await asyncio.sleep(0)
        await clock.sleep(5)
        seen["yielder"] = clock.now() - START

    async def other():
        await clock.sleep(12)
        seen["other"] = clock.now() - START

    async def main():
        await asyncio.gather(yielder(), other())

    await clock.run(main())
    assert seen == {"yielder": 15.0, "other": 12.0}


async def test_run_that_waits_on_nothing_raises():
    clock = FakeClock()

    async def stuck():
        await asyncio.get_running_loop().create_future()

    with pytest.raises(RuntimeError, match="nothing is sleeping"):
        await clock.run(stuck())


async def test_busy_loop_that_never_sleeps_on_the_clock_trips_the_backstop():
    clock = FakeClock(max_passes=200)

    async def spin():
        while True:
            await asyncio.sleep(0)

    with pytest.raises(RuntimeError, match="never went quiet"):
        await clock.run(spin())


async def test_exception_from_the_driven_coroutine_propagates():
    clock = FakeClock()

    async def main():
        await clock.sleep(1)
        raise ValueError("boom")

    with pytest.raises(ValueError, match="boom"):
        await clock.run(main())


async def test_real_clock_reports_wall_time_and_sleeps():
    clock = RealClock()
    before = clock.now()
    await clock.sleep(0.01)
    assert clock.now() >= before
