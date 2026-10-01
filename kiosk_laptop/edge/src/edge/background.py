"""The edge's heartbeat: every probe interval (or as soon as something is
queued) check the cloud; when it answers, drain the outbox, and refresh the
move every sync interval. One bad iteration is logged, never fatal."""

import asyncio
import contextlib
import logging
import time

log = logging.getLogger("edge.background")


class Background:
    def __init__(self, state) -> None:
        self.state = state
        self.last_sync = float("-inf")
        self._task: asyncio.Task | None = None

    async def tick(self, now: float) -> None:
        st = self.state
        if not await st.upstream.probe():
            return
        await st.outbox.drain_once()
        if now - self.last_sync >= st.settings.sync_interval_s:
            self.last_sync = now
            await st.syncer.run()

    async def _loop(self) -> None:
        while True:
            try:
                await self.tick(time.monotonic())
            except Exception:
                log.exception("background tick failed")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self.state.outbox_wake.wait(),
                                       timeout=self.state.settings.probe_interval_s)
            self.state.outbox_wake.clear()

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
