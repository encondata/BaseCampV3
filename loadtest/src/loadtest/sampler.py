"""Watches the server during the run: scans waiting, workers, move progress, database.

Every reading is also kept as a series in Metrics, so results.json can be charted later.
"""

from __future__ import annotations

from collections.abc import Awaitable
from typing import TypeVar

from .client.portal import PortalClient
from .clock import Clock
from . import throughput
from .metrics import Metrics

T = TypeVar("T")
CATCH_UP_POLL_SECONDS = 1.0
HEALTH_FLAG = "db_health"


async def _read(call: Awaitable[T]) -> tuple[bool, T | None]:
    """(True, answer), or (False, None) when the read failed in any way but a cancel."""
    try:
        return True, await call
    except Exception:  # noqa: BLE001 - one failed read must never stop the sampler
        return False, None


class Sampler:
    def __init__(self, *, portal: PortalClient, move_id: str, metrics: Metrics, clock: Clock,
                 every: float) -> None:
        self.portal = portal
        self.move_id = move_id
        self.metrics = metrics
        self.clock = clock
        self.every = every
        # A failed read leaves its value as it was. A continued run starts from the peak
        # and the database-health state its metrics replayed.
        self.latest: dict = {"waiting": None,
                             "waiting_peak": max(metrics.values("waiting"), default=0),
                             "workers": None, "totals": {},
                             # calls and scans per second over about the last interval
                             "rates": throughput.current(
                                 metrics.points(throughput.SERIES), every)}
        self._health: str = metrics.flags().get(
            HEALTH_FLAG, "sampled" if metrics.values("db_health") else "not_sampled")

    @property
    def db_health_state(self) -> str:
        """"sampled" (at least one reading), "not_available" (the account may not read
        Developer › Database › Health) or "not_sampled" (no reading yet)."""
        return self._health

    async def run(self) -> None:
        """One reading of everything every `every` seconds, until cancelled."""
        while True:
            await self._tick()
            await self.clock.sleep(self.every)

    async def wait_for_catch_up(self, *, quiet_samples: int = 6,
                                timeout: float = 3600) -> float | None:
        """Seconds from this call until no scan is waiting, read every second (or every
        sample interval, when that is shorter) so a quick catch-up is not rounded up to a
        whole interval. None when the count has not gone below its lowest reading for
        `quiet_samples` sample intervals (failed readings included), or when the next
        reading would fall past `timeout`."""
        start = self.clock.now()
        poll = min(self.every, CATCH_UP_POLL_SECONDS)
        quiet_window = quiet_samples * self.every
        lowest: int | None = None
        lowest_at = start
        while True:
            waiting = await self._read_waiting()
            now = self.clock.now()
            if waiting == 0:
                return now - start
            if waiting is not None and (lowest is None or waiting < lowest):
                lowest, lowest_at = waiting, now
            elif now - lowest_at >= quiet_window:
                return None
            if now - start + poll > timeout:
                return None
            await self.clock.sleep(poll)

    async def _read_waiting(self) -> int | None:
        ok, waiting = await _read(self.portal.waiting_scans())
        if not ok:
            return None
        now = self.clock.now()
        self.metrics.sample("waiting", now, waiting)
        # paired with this reading, so scans processed = sent less the waiting's growth
        self.metrics.sample(throughput.SERIES, now, {
            "calls": self.metrics.total_calls(),
            "scans": throughput.scans_taken(self.metrics.counters()),
            "waiting": waiting})
        self.latest["rates"] = throughput.current(self._throughput_points(), self.every)
        self.latest["waiting"] = waiting
        self.latest["waiting_peak"] = max(self.latest["waiting_peak"], waiting)
        return waiting

    def _throughput_points(self) -> list[list]:
        return self.metrics.points(throughput.SERIES)

    async def _tick(self) -> None:
        await self._read_waiting()
        ok, status = await _read(self.portal.system_status())
        if ok:
            self.metrics.sample("workers_running", self.clock.now(), status.workers_running)
            self.latest["workers"] = f"{status.workers_running}/{status.workers_total}"
        ok, totals = await _read(self.portal.asset_totals(self.move_id))
        if ok:
            self.metrics.sample("asset_totals", self.clock.now(), totals)
            self.latest["totals"] = dict(totals)
        if self._health != "not_available":
            ok, health = await _read(self.portal.db_health())
            if ok and health is None:
                self._health = "not_available"
                self.metrics.flag(HEALTH_FLAG, self._health)
            elif ok:
                self._health = "sampled"
                self.metrics.flag(HEALTH_FLAG, self._health)
                self.metrics.sample("db_health", self.clock.now(), health)

