"""The run's simulated devices: one KioskDevice per profile device, signed in, set up,
synced, and heart-beating for the whole run."""

from __future__ import annotations

import asyncio
import math
import random
from collections.abc import Awaitable, Callable

import httpx

from .client.kiosk import KioskDevice, SyncData
from .client.portal import MoveInfo
from .clock import Clock
from .events import Events, FeedLine
from .http import CallFailed
from .ids import device_name, device_serial
from .metrics import Metrics
from .preflight import SIGN_IN_FAILURES, setup_failure, sign_in_failure
from .profile import Profile

BRING_UP_AT_ONCE = 8
READY = "signed in, set up, move downloaded"
STOPPED = "Stopped while the devices were starting."
NOT_UNDERSTOOD = "The server sent an answer this tool does not understand."
THEN = "continue the run"     # a failed bring-up leaves the run continuable


class FleetError(Exception):
    """A device could not be brought up. The message is safe to show a user: it names
    the device and the step in the readiness check's plain words, never a password,
    token, key or one of the server's internal codes."""


def _download_failure(exc: Exception) -> str:
    if not isinstance(exc, CallFailed):
        return NOT_UNDERSTOOD
    if exc.code == "redirected":
        return SIGN_IN_FAILURES["redirected"]
    if exc.status is None:
        return "The server could not be reached."
    return f"The server answered {exc.status}."


class Fleet:
    def __init__(self, *, profile: Profile, base_url: str, move: MoveInfo, metrics: Metrics,
                 clock: Clock, events: Events, transport: httpx.AsyncBaseTransport | None = None,
                 rng: random.Random | None = None) -> None:
        if move.origin is None or move.destination is None:
            raise FleetError(f"The move {move.name} needs both an origin and a destination site.")
        self.profile = profile
        self.move = move
        self.metrics = metrics
        self.clock = clock
        self.events = events
        self._rng = rng or random.Random(0)
        self.devices: list[KioskDevice] = []
        self._by_stage: dict[str, list[KioskDevice]] = {}
        self._setup: dict[str, tuple[str, str]] = {}     # serial -> (site id, checkpoint)
        self._beats: list[asyncio.Task] = []
        self._bringing: list[asyncio.Task] = []          # bring-ups in flight
        self._start_done: asyncio.Event | None = None    # set once start() has unwound
        self._stopping = False
        self._closed = False
        for stage in profile.stages:
            if stage.device is None or stage.checkpoint is None:
                continue
            site = move.origin if stage.site == "origin" else move.destination
            stage_devices = []
            for n in range(1, stage.devices + 1):
                device = KioskDevice(
                    base_url=base_url, serial=device_serial(stage.key, n),
                    name=device_name(stage.label, n, stage.devices), kind=stage.device,
                    metrics=metrics, clock=clock, retry=profile.retry,
                    timeout=profile.request_timeout_seconds, transport=transport)
                self._setup[device.serial] = (site.id, stage.checkpoint)
                stage_devices.append(device)
            self._by_stage[stage.key] = stage_devices
            self.devices.extend(stage_devices)

    def device_for(self, stage_key: str, crew: int) -> KioskDevice:
        stage_devices = self._by_stage[stage_key]
        return stage_devices[crew % len(stage_devices)]

    # ── start ──────────────────────────────────────────────────────────

    async def start(self, move_password: str) -> SyncData:
        """The first device alone (its sign-in may create the move's kiosk identity),
        then the rest at most 8 at a time; then the heartbeats. On the first failure,
        a stop() or a cancel, every device is closed; a failure or a stop raises
        FleetError."""
        if self._stopping or self._closed:
            raise FleetError(STOPPED)
        self._start_done = asyncio.Event()
        try:
            first = await self._bring_up_all(self.devices[:1], move_password, 1)
            await self._bring_up_all(self.devices[1:], move_password, BRING_UP_AT_ONCE)
            if self._stopping:
                raise FleetError(STOPPED)
            # no await from the check above to here: stop() cannot slip in between
            interval = self.profile.heartbeat_seconds
            self._beats = [asyncio.create_task(self._beat(d, self._rng.uniform(0, interval)))
                           for d in self.devices]
            return first[0]
        except BaseException:
            await self._cancel_bring_ups()
            await self._close_devices()
            raise
        finally:
            self._start_done.set()

    async def _bring_up_all(self, devices: list[KioskDevice], move_password: str,
                            at_once: int) -> list[SyncData]:
        gate = asyncio.Semaphore(at_once)

        async def gated(device: KioskDevice) -> SyncData:
            async with gate:
                if self._stopping:
                    raise FleetError(STOPPED)
                return await self._bring_up(device, move_password)

        tasks = [asyncio.create_task(gated(d)) for d in devices]
        self._bringing = tasks
        if tasks:
            await asyncio.wait(tasks, return_when=asyncio.FIRST_EXCEPTION)
        if self._stopping:
            raise FleetError(STOPPED)
        for task in tasks:              # the first failure, in device order
            if task.done() and not task.cancelled() and task.exception() is not None:
                raise task.exception()
        self._bringing = []
        return [task.result() for task in tasks]

    async def _cancel_bring_ups(self) -> None:
        tasks, self._bringing = self._bringing, []
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    async def _bring_up(self, device: KioskDevice, move_password: str) -> SyncData:
        site_id, checkpoint = self._setup[device.serial]
        await self._step(device, "sign in", lambda: device.sign_in(move_password),
                         lambda exc: sign_in_failure(exc, THEN))
        await self._step(device, "finish Kiosk Setup",
                         lambda: device.setup(initiative_id=self.move.id, site_id=site_id,
                                              scan_status=checkpoint),
                         lambda exc: setup_failure(exc, self.move, checkpoint, THEN))
        data = await self._step(device, "download the move", lambda: device.sync(self.move.id),
                                _download_failure)
        self.events.feed(FeedLine(self.clock.now(), device.name, "ready", READY, True, None))
        return data

    @staticmethod
    async def _step(device: KioskDevice, what: str, call: Callable[[], Awaitable],
                    why: Callable[[Exception], str]):
        """`why` words a CallFailed or a malformed answer (ValueError, KeyError, a group
        of them) as the readiness check does."""
        try:
            return await call()
        except Exception as exc:    # noqa: BLE001 - every failure is a FleetError
            raise FleetError(f"{device.name} could not {what}. {why(exc)}") from None

    # ── heartbeats ─────────────────────────────────────────────────────

    async def _beat(self, device: KioskDevice, offset: float) -> None:
        """Beats at start + offset + k × interval on the clock, until cancelled. A beat
        that overruns skips to the next due time that is still ahead; nothing it raises
        ends the loop."""
        interval = self.profile.heartbeat_seconds
        first = self.clock.now() + offset
        k = 0
        while True:
            await self.clock.sleep(max(0.0, first + k * interval - self.clock.now()))
            try:
                await device.heartbeat()
            except asyncio.CancelledError:
                raise
            except Exception:
                self.metrics.count("heartbeat_errors")
            k = max(k + 1, math.floor((self.clock.now() - first) / interval) + 1)

    # ── stop ───────────────────────────────────────────────────────────

    async def stop(self) -> None:
        """Ends a start() still running, cancels the heartbeats, waits for them, and
        closes every device. No heartbeat task is left once it returns. Safe to repeat."""
        self._stopping = True
        for task in self._bringing:
            task.cancel()
        if self._start_done is not None and not self._start_done.is_set():
            await self._start_done.wait()
        beats, self._beats = self._beats, []
        for task in beats:
            task.cancel()
        await asyncio.gather(*beats, return_exceptions=True)
        await self._close_devices()

    async def _close_devices(self) -> None:
        if not self._closed:
            self._closed = True
            for device in self.devices:
                await device.close()
