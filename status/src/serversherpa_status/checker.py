"""The background loop: probe every service concurrently, record each
result, prune hourly. A crashing cycle is logged and the loop carries on —
a status page whose checker died silently would freeze on stale green."""

import asyncio
import logging
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import httpx

from serversherpa_status.alerts import Alert, AlertWatcher, publish
from serversherpa_status.api_status import BACKGROUND_KEY, LatestApiStatus, parse_api_status
from serversherpa_status.config import Settings
from serversherpa_status.probes import probe
from serversherpa_status.state import StateTracker
from serversherpa_status.store import Store

log = logging.getLogger("serversherpa_status.checker")

PRUNE_EVERY = timedelta(hours=1)


def utcnow() -> datetime:
    return datetime.now(UTC)


def seed_tracker(tracker: StateTracker, store: Store, settings: Settings) -> None:
    for key in [s.key for s in settings.services] + [BACKGROUND_KEY]:
        for row in store.recent(key, settings.failure_threshold):
            tracker.record(key, row.ok, row.latency_ms, row.at)


class Checker:
    def __init__(
        self,
        settings: Settings,
        store: Store,
        tracker: StateTracker,
        client: httpx.AsyncClient,
        clock: Callable[[], datetime] = utcnow,
        latest: LatestApiStatus | None = None,
        watcher: AlertWatcher | None = None,
    ) -> None:
        self._watcher = watcher
        self._latest = latest
        self._settings = settings
        self._store = store
        self._tracker = tracker
        self._client = client
        self._clock = clock
        self._last_prune: datetime | None = None
        self._alert_tasks: set[asyncio.Task] = set()
        self.last_cycle_at: datetime | None = None
        self.store_ok: bool = True

    def _spawn_alerts(self, alerts: list[Alert]) -> None:
        """Publish off the cycle's critical path: a slow ntfy must not delay
        the next check or the page's freshness."""
        ntfy = self._settings.ntfy
        client = self._client

        async def send() -> None:
            await asyncio.gather(*(publish(client, ntfy, a) for a in alerts))

        task = asyncio.create_task(send())
        self._alert_tasks.add(task)
        task.add_done_callback(self._alert_tasks.discard)

    async def drain_alerts(self) -> None:
        """Wait for in-flight alert publishes (tests, shutdown)."""
        while self._alert_tasks:
            await asyncio.gather(*list(self._alert_tasks), return_exceptions=True)

    async def run_cycle(self) -> None:
        services = self._settings.services
        results = await asyncio.gather(
            *(probe(self._client, s, self._settings.timeout_seconds) for s in services)
        )
        now = self._clock()
        store_ok = True
        for service, result in zip(services, results):
            # Tracker is updated first: displayed state must reflect this
            # probe even if the store write below fails.
            self._tracker.record(service.key, result.ok, result.latency_ms, now)
            if not result.ok:
                log.warning("%s check failed: %s", service.key, result.detail)
            try:
                self._store.record(service.key, now, result.ok, result.latency_ms, result.detail)
            except Exception:
                store_ok = False
                log.exception("failed to record %s check", service.key)
        api_result = next((r for s, r in zip(services, results) if s.key == "api"), None)
        api_ok = api_result is not None and api_result.ok
        status = (
            parse_api_status(api_result.payload)
            if api_ok and api_result.payload is not None
            else None
        )
        # A failed probe leaves the last known status to age out via the stale
        # window, so one blip doesn't flicker the banner or the Background card.
        if self._latest is not None and api_ok:
            self._latest.set(status, now)
        if status is not None and status.background is not None:
            ok = status.background.state != "down"
            self._tracker.record(BACKGROUND_KEY, ok, None, now)
            try:
                self._store.record(BACKGROUND_KEY, now, ok, None, "" if ok else "workers down")
            except Exception:
                store_ok = False
                log.exception("failed to record background check")
        if self._watcher is not None and self._settings.ntfy is not None:
            keys = [s.key for s in services] + [BACKGROUND_KEY]
            states = {k: self._tracker.snapshot(k).state for k in keys}
            alerts = self._watcher.evaluate(
                states,
                status.maintenance if status else None,
                status.maintenance_message if status else None,
                now,
            )
            if alerts:
                self._spawn_alerts(alerts)
        if self._last_prune is None or now - self._last_prune >= PRUNE_EVERY:
            try:
                self._store.prune(now)
                self._last_prune = now
            except Exception:
                store_ok = False
                log.exception("failed to prune store")
        self.last_cycle_at = now
        self.store_ok = store_ok

    async def run_forever(self) -> None:
        while True:
            try:
                await self.run_cycle()
            except Exception:
                log.exception("status check cycle failed; retrying next interval")
            await asyncio.sleep(self._settings.interval_seconds)
