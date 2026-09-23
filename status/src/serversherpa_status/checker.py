"""The background loop: probe every service concurrently, record each
result, prune hourly. A crashing cycle is logged and the loop carries on —
a status page whose checker died silently would freeze on stale green."""

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx

from serversherpa_status.config import Settings
from serversherpa_status.probes import probe
from serversherpa_status.state import StateTracker
from serversherpa_status.store import Store

log = logging.getLogger("serversherpa_status.checker")

PRUNE_EVERY = timedelta(hours=1)


def utcnow() -> datetime:
    return datetime.now(UTC)


def seed_tracker(tracker: StateTracker, store: Store, settings: Settings) -> None:
    for service in settings.services:
        for row in store.recent(service.key, settings.failure_threshold):
            tracker.record(service.key, row.ok, row.latency_ms, row.at)


class Checker:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        tracker: StateTracker,
        client: httpx.AsyncClient,
        clock: Callable[[], datetime] = utcnow,
    ) -> None:
        self._settings = settings
        self._store = store
        self._tracker = tracker
        self._client = client
        self._clock = clock
        self._last_prune: datetime | None = None

    async def run_cycle(self) -> None:
        services = self._settings.services
        results = await asyncio.gather(
            *(probe(self._client, s, self._settings.timeout_seconds) for s in services)
        )
        now = self._clock()
        for service, result in zip(services, results):
            self._store.record(service.key, now, result.ok, result.latency_ms, result.detail)
            self._tracker.record(service.key, result.ok, result.latency_ms, now)
            if not result.ok:
                log.warning("%s check failed: %s", service.key, result.detail)
        if self._last_prune is None or now - self._last_prune >= PRUNE_EVERY:
            self._store.prune(now)
            self._last_prune = now

    async def run_forever(self) -> None:
        while True:
            try:
                await self.run_cycle()
            except Exception:
                log.exception("status check cycle failed; retrying next interval")
            await asyncio.sleep(self._settings.interval_seconds)
