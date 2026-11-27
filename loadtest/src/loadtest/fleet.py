"""The run's simulated devices: one KioskDevice per profile device, signed in, set up,
synced, and heart-beating for the whole run."""

from __future__ import annotations

import asyncio
import random

import httpx

from .client.kiosk import KioskDevice, SyncData
from .client.portal import MoveInfo
from .clock import Clock
from .events import Events, FeedLine
from .http import CallFailed
from .ids import device_name, device_serial
from .metrics import Metrics
from .profile import Profile

BRING_UP_AT_ONCE = 8
READY = "signed in, set up, move downloaded"


class FleetError(Exception):
    """A device could not be brought up. The message is safe to show a user: it names
    the device, the step and the server's code, never a password, token or key."""


def _why(exc: CallFailed) -> str:
    if exc.code:
        return f"{exc.call} answered {exc.code}"
    if exc.status is not None:
        return f"{exc.call} answered HTTP {exc.status}"
    return f"{exc.call} got no answer"


class Fleet:
    def __init__(self, *, profile: Profile, base_url: str, move: MoveInfo, metrics: Metrics,
                 clock: Clock, events: Events, transport: httpx.AsyncBaseTransport | None = None,
                 rng: random.Random | None = None) -> None:
        if move.origin is None or move.destination is None:
            raise FleetError(f"the move {move.name} needs both an origin and a destination site")
        self.profile = profile
        self.move = move
        self.clock = clock
        self.events = events
        self._rng = rng or random.Random(0)
        self.devices: list[KioskDevice] = []
        self._by_stage: dict[str, list[KioskDevice]] = {}
        self._setup: dict[str, tuple[str, str]] = {}     # serial -> (site id, checkpoint)
        self._beats: list[asyncio.Task] = []
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

    async def start(self, move_password: str) -> SyncData:
        """The first device alone (its sign-in may create the move's kiosk identity),
        then the rest at most 8 at a time; then the heartbeats. On the first failure
        every device is closed and a FleetError raised."""
        try:
            first = await self._bring_up(self.devices[0], move_password)
            gate = asyncio.Semaphore(BRING_UP_AT_ONCE)

            async def gated(device: KioskDevice) -> None:
                async with gate:
                    await self._bring_up(device, move_password)

            try:
                async with asyncio.TaskGroup() as group:
                    for device in self.devices[1:]:
                        group.create_task(gated(device))
            except BaseExceptionGroup as failed:
                errors = [e for e in failed.exceptions if isinstance(e, FleetError)]
                if errors:
                    raise errors[0] from None
                raise
        except BaseException:
            await self.stop()
            raise
        interval = self.profile.heartbeat_seconds
        self._beats = [asyncio.create_task(self._beat(d, self._rng.uniform(0, interval)))
                       for d in self.devices]
        return first

    async def _bring_up(self, device: KioskDevice, move_password: str) -> SyncData:
        site_id, checkpoint = self._setup[device.serial]
        try:
            await device.sign_in(move_password)
        except CallFailed as exc:
            raise FleetError(f"{device.name} could not sign in: {_why(exc)}") from None
        try:
            await device.setup(initiative_id=self.move.id, site_id=site_id,
                               scan_status=checkpoint)
        except CallFailed as exc:
            raise FleetError(f"{device.name} could not finish Kiosk Setup: {_why(exc)}") from None
        try:
            data = await device.sync(self.move.id)
        except CallFailed as exc:
            raise FleetError(f"{device.name} could not download the move: {_why(exc)}") from None
        self.events.feed(FeedLine(self.clock.now(), device.name, "ready", READY, True, None))
        return data

    async def _beat(self, device: KioskDevice, offset: float) -> None:
        """heartbeat() returns normally on failure, so this loop runs until cancelled."""
        await self.clock.sleep(offset)
        while True:
            await device.heartbeat()
            await self.clock.sleep(self.profile.heartbeat_seconds)

    async def stop(self) -> None:
        """Cancel the heartbeats, wait for them, close every device. Safe to repeat."""
        beats, self._beats = self._beats, []
        for task in beats:
            task.cancel()
        await asyncio.gather(*beats, return_exceptions=True)
        if not self._closed:
            self._closed = True
            for device in self.devices:
                await device.close()
