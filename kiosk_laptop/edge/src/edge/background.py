"""The edge's heartbeat: every probe interval (or as soon as something is
queued) check the cloud; when it answers, drain the outbox, and refresh the
move every sync interval. An RFID Station with no station key asks the
portal for one at most once a minute, as a person signed in here with a
usable cloud session. One bad iteration is logged, never fatal.

A second loop, independent of the internet, matches raw RFID tag reads into
pending scans every 2 s, and at once when the ingest stores a batch. A third
uploads pending RFID scans under the station key every 5 s, and at once when
the processor inserts some (it does its own internet probing, spec §4).
A fourth runs the Label Station's label generation whenever one is
requested (edge/labels/runner.py)."""

import asyncio
import contextlib
import logging
import time

from edge.rfid import processing, station_key, uploader

log = logging.getLogger("edge.background")
LABEL_INTERVAL_S = 60  # a request wakes the label loop at once; this is only a backstop


class Background:
    def __init__(self, state) -> None:
        self.state = state
        self.last_sync = float("-inf")
        self.last_key_try = float("-inf")
        self._task: asyncio.Task | None = None
        self._process_task: asyncio.Task | None = None
        self._upload_task: asyncio.Task | None = None
        self._label_task: asyncio.Task | None = None
        self.uploader = uploader.Uploader(state.store, state)

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

    async def _process_loop(self) -> None:
        wake = self.state.rfid_wake
        while True:
            wake.clear()  # before the pass: a batch stored during it wakes the next one
            more = False
            try:
                result = processing.process(self.state.store)
                more = result.scanned == processing.PASS_LIMIT and not result.waiting
                if result.inserted:
                    self.state.rfid_upload_wake.set()
            except Exception:
                log.exception("rfid processing pass failed")
            if more:  # a backlog: yield to the ingest, then the next 500
                await asyncio.sleep(0)
                continue
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(wake.wait(), timeout=processing.INTERVAL_S)

    async def _upload_loop(self) -> None:
        wake = self.state.rfid_upload_wake
        while True:
            wake.clear()  # before the batch: rows inserted during it wake the next one
            sent = 0
            try:
                sent = await self.uploader.drain_once()
            except Exception:
                log.exception("rfid upload batch failed")
            if sent == uploader.BATCH and self.uploader.last_ok:  # a backlog: next batch now
                await asyncio.sleep(0)
                continue
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(wake.wait(), timeout=uploader.INTERVAL_S)

    async def _label_loop(self) -> None:
        wake = self.state.label_wake
        while True:
            wake.clear()  # before the run: a request made during it wakes the next one
            try:
                await self.state.label_runner.run_pending()
            except Exception:
                log.exception("label run failed")
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(wake.wait(), timeout=LABEL_INTERVAL_S)

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())
        self._process_task = asyncio.create_task(self._process_loop())
        self._upload_task = asyncio.create_task(self._upload_loop())
        self._label_task = asyncio.create_task(self._label_loop())

    async def stop(self) -> None:
        for task in (self._task, self._process_task, self._upload_task, self._label_task):
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
