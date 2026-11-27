"""Turns each pipeline Step into the device or portal call it stands for, plus one feed line."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable
from datetime import UTC, datetime
from typing import Literal, TypeVar

from .client.kiosk import KioskDevice, ScanOut
from .client.portal import PortalClient
from .clock import Clock
from .events import Events, FeedLine
from .fleet import Fleet
from .ids import scan_id
from .metrics import Metrics
from .pipeline import Step
from .profile import Profile, StageSpec
from .state import RunState

T = TypeVar("T")
FAILED = "call failed"  # the clients say only whether a call landed
NO_KEY = "not sent: this station has no key"
NOT_UNDERSTOOD = "The server sent an answer this tool does not understand."
_TRIP_ACTIONS = {"depart": "departed", "location": "location", "arrive": "arrived"}


def truck_label(name: str) -> str:
    """The truck's feed name: its own, with "Truck " in front unless it already says truck."""
    return name if "truck" in name.lower() else f"Truck {name}"


async def _timed(call: Awaitable[T]) -> tuple[T, float]:
    """The call's result and how long it took in real milliseconds."""
    started = time.perf_counter()
    result = await call
    return result, (time.perf_counter() - started) * 1000


class Actions:
    def __init__(self, *, profile: Profile, state: RunState, fleet: Fleet, portal: PortalClient,
                 events: Events, metrics: Metrics, clock: Clock) -> None:
        self.profile = profile
        self.state = state
        self.fleet = fleet
        self.portal = portal
        self.events = events
        self.metrics = metrics
        self.clock = clock
        self._stages = {s.key: s for s in profile.stages}

    async def perform(self, step: Step) -> bool:
        """True when the call landed. Never raises, except CancelledError."""
        try:
            if step.kind in ("depart", "location", "arrive"):
                return await self._trip(step)
            return await self._device_step(step)
        except asyncio.CancelledError:
            raise
        except Exception:  # a malformed answer must not stop the move; it shows in the feed
            self.metrics.count("action_errors")
            device, action = self._who(step)
            self.events.feed(FeedLine(self.clock.now(), device, action, "", False, None,
                                      NOT_UNDERSTOOD))
            return False

    def _who(self, step: Step) -> tuple[str, str]:
        """Device and action for a step's feed line, as plain as the step allows."""
        try:
            if step.kind in _TRIP_ACTIONS:
                return truck_label(self.state.trucks[step.truck_id].name), _TRIP_ACTIONS[step.kind]
            return (self.fleet.device_for(step.stage, step.crew).name,
                    self._stages[step.stage].label)
        except KeyError:
            return step.stage, step.kind

    # ── device steps ───────────────────────────────────────────────────

    def _scan(self, spec: StageSpec, subject_id: str, value: str,
              scan_type: Literal["rfid", "barcode"]) -> ScanOut:
        site = (self.state.origin_site_id if spec.site == "origin"
                else self.state.destination_site_id)
        return ScanOut(client_scan_id=scan_id(self.state.run_id, spec.key, subject_id),
                       scanned_value=value, scan_type=scan_type,
                       scanned_at=datetime.fromtimestamp(self.clock.now(), tz=UTC),
                       scan_status=spec.checkpoint or "", site_id=site,
                       initiative_id=self.state.move_id)

    async def _device_step(self, step: Step) -> bool:
        spec = self._stages[step.stage]
        device = self.fleet.device_for(step.stage, step.crew)
        keyless = device.is_station and not device.has_key     # send_scans sends nothing
        note = ""
        if step.kind == "cart":
            servers = [self.state.servers[sid] for sid in step.server_ids]
            scans = [self._scan(spec, s.id, s.tag, "rfid") for s in servers]
            accepted, ms = await _timed(device.send_scans(scans))
            ok = accepted == len(scans)
            if not ok and not keyless:
                note = f"{accepted} of {len(scans)} accepted"
            subject = f"{len(scans)} tags"
        elif step.kind in ("load", "unload"):
            container = self.state.containers[step.container_id]
            scan = self._scan(spec, container.id, container.name, "barcode")
            call = device.load if step.kind == "load" else device.unload
            ok, ms = await _timed(call(truck_id=step.truck_id, container_id=container.id,
                                       scan=scan))
            subject = container.name
        else:
            server = self.state.servers[step.server_ids[0]]
            ok, ms = await _timed(self._server_call(step, spec, device, server.id))
            subject = f"SN {server.serial}"
        self.events.feed(FeedLine(self.clock.now(), device.name, spec.label, subject, ok, ms,
                                  note or ("" if ok else NO_KEY if keyless else FAILED)))
        return ok

    async def _server_call(self, step: Step, spec: StageSpec, device: KioskDevice,
                           sid: str) -> bool:
        server = self.state.servers[sid]
        if step.kind == "each" and spec.action == "enroll":
            scan = self._scan(spec, sid, server.tag, "rfid")
            return await device.enroll(asset_id=sid, tag=server.tag, scan=scan)
        scan = self._scan(spec, sid, server.serial, "barcode")
        if step.kind == "pack":
            return await device.pack(container_id=step.container_id, asset_id=sid, scan=scan)
        if step.kind == "unpack":
            return await device.unpack(container_id=step.container_id, asset_id=sid, scan=scan)
        return await device.send_scans([scan]) == 1      # scan / station_label

    # ── the trip ───────────────────────────────────────────────────────

    async def _trip(self, step: Step) -> bool:
        truck = self.state.trucks[step.truck_id]
        if step.kind == "location":
            lat, lng = self.state.route[step.index - 1]
            ok, ms = await _timed(self.portal.add_truck_location(truck.id, lat, lng))
            subject = f"{lat:.4f}, {lng:.4f} ({step.index} of {self.profile.trip.updates})"
        else:
            status = "in_transit" if step.kind == "depart" else "at_destination"
            ok, ms = await _timed(self.portal.set_truck_status(truck.id, status))
            subject = f"{len(truck.container_ids)} containers"
        self.events.feed(FeedLine(self.clock.now(), truck_label(truck.name),
                                  _TRIP_ACTIONS[step.kind], subject, ok, ms,
                                  "" if ok else FAILED))
        return ok
