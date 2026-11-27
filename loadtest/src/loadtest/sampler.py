"""Watches the server during the run: scans waiting, workers, move progress, database.

Every reading is also kept as a series in Metrics, so results.json can be charted later.
"""

from __future__ import annotations

from collections.abc import Awaitable
from typing import TypeVar

from .client.portal import PortalClient
from .clock import Clock
from .metrics import Metrics

T = TypeVar("T")


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
        # A failed read leaves its value as it was.
        self.latest: dict = {"waiting": None, "waiting_peak": 0, "workers": None, "totals": {}}
        self._health: str = "not_sampled"

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
        """Seconds from this call until no scan is waiting. None when the count has not
        gone below its lowest reading for `quiet_samples` readings in a row (a failed
        reading counts as one), or when the next reading would fall past `timeout`."""
        start = self.clock.now()
        lowest: int | None = None
        quiet = 0
        while True:
            waiting = await self._read_waiting()
            if waiting == 0:
                return self.clock.now() - start
            if waiting is not None and (lowest is None or waiting < lowest):
                lowest, quiet = waiting, 0
            else:
                quiet += 1
                if quiet >= quiet_samples:
                    return None
            if self.clock.now() - start + self.every > timeout:
                return None
            await self.clock.sleep(self.every)

    async def _read_waiting(self) -> int | None:
        ok, waiting = await _read(self.portal.waiting_scans())
        if not ok:
            return None
        self.metrics.sample("waiting", self.clock.now(), waiting)
        self.latest["waiting"] = waiting
        self.latest["waiting_peak"] = max(self.latest["waiting_peak"], waiting)
        return waiting

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
            elif ok:
                self._health = "sampled"
                self.metrics.sample("db_health", self.clock.now(), health)

