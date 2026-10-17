"""The edge's heartbeat: every probe interval (or as soon as something is
queued) check the cloud; when it answers, drain the outbox, and refresh the
move every sync interval. An RFID Station with no station key asks the
portal for one at most once a minute, as a person signed in here with a
usable cloud session. One bad iteration is logged, never fatal."""

import asyncio
import contextlib
import logging
import time

from edge.rfid import station_key

log = logging.getLogger("edge.background")


class Background:
    def __init__(self, state) -> None:
        self.state = state
        self.last_sync = float("-inf")
        self.last_key_try = float("-inf")
        self._task: asyncio.Task | None = None

    async def tick(self, now: float) -> None:
        st = self.state
        if not await st.upstream.probe():
            return
        await st.outbox.drain_once()
        await self._retry_station_key(now)
        if now - self.last_sync >= st.settings.sync_interval_s:
            self.last_sync = now
            await st.syncer.run()

    async def _retry_station_key(self, now: float) -> None:
        st = self.state
        if now - self.last_key_try < station_key.RETRY_S or not station_key.needs_key(st.store):
            return
        person = st.syncer.actor()
        if not station_key.usable_session(st.store, person):
            return
        self.last_key_try = now
        await station_key.issue(st, person)

    async def _loop(self) -> None:
        while True:
            # clear BEFORE the tick: a wake that arrives while it runs is kept
            # and starts the next tick at once
            self.state.outbox_wake.clear()
            try:
                await self.tick(time.monotonic())
            except Exception:
                log.exception("background tick failed")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.state.outbox_wake.wait(),
                                       timeout=self.state.settings.probe_interval_s)

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
