"""Injectable clock: real time for live runs, virtual time for tests."""

from __future__ import annotations

import asyncio
import heapq
import itertools
import time
from collections.abc import Awaitable
from typing import Protocol, TypeVar

T = TypeVar("T")

# Event-loop passes spent letting every runnable task settle before time moves.
_SETTLE_PASSES = 25


class Clock(Protocol):
    def now(self) -> float: ...

    async def sleep(self, seconds: float) -> None: ...


class RealClock:
    def now(self) -> float:
        return time.time()

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(seconds)


class FakeClock:
    """Virtual time. Sleepers park on a heap; `run` advances time to the earliest wake."""

    def __init__(self, start: float = 1_800_000_000.0):
        self._now = start
        self._heap: list[tuple[float, int, asyncio.Future[None]]] = []
        self._seq = itertools.count()
        self.sleeps: list[float] = []

    def now(self) -> float:
        return self._now

    async def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        if seconds <= 0:
            await asyncio.sleep(0)
            return
        fut: asyncio.Future[None] = asyncio.get_running_loop().create_future()
        heapq.heappush(self._heap, (self._now + seconds, next(self._seq), fut))
        await fut

    def _next_wake(self) -> float | None:
        """Earliest wake time of a live sleeper, dropping cancelled entries."""
        while self._heap and self._heap[0][2].done():
            heapq.heappop(self._heap)
        return self._heap[0][0] if self._heap else None

    async def run(self, coro: Awaitable[T], *, limit: float | None = None) -> T:
        """Drive `coro` to completion in virtual time.

        `limit` is virtual seconds since the run began; exceeding it raises TimeoutError.
        """
        started = self._now
        task = asyncio.ensure_future(coro)
        try:
            while True:
                for _ in range(_SETTLE_PASSES):
                    await asyncio.sleep(0)
                    if task.done():
                        break
                if task.done():
                    return task.result()
                wake = self._next_wake()
                if wake is None:
                    raise RuntimeError("FakeClock.run: nothing is sleeping and the run has not ended")
                if limit is not None and wake - started > limit:
                    raise TimeoutError(f"run exceeded {limit} virtual seconds")
                self._now = max(self._now, wake)
                while self._heap and self._heap[0][0] <= wake:
                    _, _, fut = heapq.heappop(self._heap)
                    if not fut.done():
                        fut.set_result(None)
        finally:
            if not task.done():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
