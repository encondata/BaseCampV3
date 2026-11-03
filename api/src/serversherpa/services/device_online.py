"""Device online rules: which devices notifications cover, how long each may go quiet before it
reads as offline, and where each one lives in the portal. They sit in one place so the Readers
list, the check that announces outages and the routes that watch devices all agree.

The thresholds are the screens' own, not new policy. The portal shows a kiosk offline after 3
minutes without a check-in (KIOSK_ONLINE_MS in portal/src/lib/kioskConfig.ts) and a router after
4 (ROUTER_ONLINE_MS in portal/src/lib/devices.ts); the Readers list has always used 3 minutes for
a fixed reader, which is offline at once when its station reports it unreachable. The portal
mirrors these numbers, with pin tests on both sides (tests/test_device_online.py here). Migration
0114 repeats them as SQL intervals to mark the outages already going on when it ran; that is a
snapshot of the rule on that day and does not follow later changes.

Covered devices are the only ones notifications check and people can watch: the ones that check
in on their own, whether or not anyone is using them. Phone, tablet and web kiosks beat only
while someone is signed in, Label Stations update only when they upload scans, Time Clock
stations only on a clock-in or clock-out, and a router that is pending or revoked reports
nothing, so a quiet stretch from any of them is not an outage.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 5, Device offline)
"""

from collections.abc import Mapping
from datetime import UTC, datetime, timedelta

from sqlalchemy import ColumnElement, and_, false, func, or_

from serversherpa.db.models import Device

# A device is online while the time since its `last_seen_at` is at most its threshold.
KIOSK_ONLINE = timedelta(minutes=3)      # kiosks check in every minute: three missed beats
ROUTER_ONLINE = timedelta(minutes=4)     # about three missed reports at the agent's 65 s default
READER_STALE_AFTER = timedelta(minutes=3)    # the Readers list's Offline
# The longest of the three: how long the device check stays quiet after maintenance.
LONGEST_THRESHOLD = ROUTER_ONLINE


def is_rfid_station(device: Device) -> bool:
    """An RFID Station: a laptop kiosk set up with station type rfid."""
    return device.sub_type == "laptop" and device.station_type == "rfid"


def covered(device: Device) -> bool:
    """Whether notifications check this device and people can watch it: an RFID Station, any
    fixed reader, or an approved router."""
    if device.device_type == "kiosk":
        return is_rfid_station(device)
    if device.device_type == "fixed_reader":
        return True
    return device.device_type == "router" and device.approval_state == "approved"


def covered_clause() -> ColumnElement[bool]:
    """`covered()` as SQL. It is never NULL (a kiosk with no station type is plainly not
    covered), so `~covered_clause()` finds the devices that are not."""
    return func.coalesce(or_(
        and_(Device.device_type == "kiosk", Device.sub_type == "laptop",
             Device.station_type == "rfid"),
        Device.device_type == "fixed_reader",
        and_(Device.device_type == "router", Device.approval_state == "approved"),
    ), false())


def is_offline(device: Device, now: datetime) -> bool | None:
    """Whether the device reads as offline at `now` (timezone-aware): quiet for more than its
    threshold, or, for a fixed reader, reported unreachable by its station. None when it has
    never checked in, so there is nothing to judge. A naive `last_seen_at` reads as UTC.

    This is the rule for the device's kind, covered or not; `covered()` says whether
    notifications act on it."""
    seen = device.last_seen_at
    if seen is None:
        return None
    if seen.tzinfo is None:
        seen = seen.replace(tzinfo=UTC)
    if device.device_type == "fixed_reader":
        if (device.raw_info or {}).get("reachable") is False:
            return True
        return now - seen > READER_STALE_AFTER
    if device.device_type == "router":
        return now - seen > ROUTER_ONLINE
    return now - seen > KIOSK_ONLINE


def device_list_link(device: Device) -> str:
    """The portal's list for this kind of device."""
    if device.device_type == "fixed_reader":
        return "/hardware/fixed-readers"
    if device.device_type == "router":
        return "/hardware/routers"
    return "/hardware/kiosks"


def device_link(device: Device) -> str:
    """Where a notification about this device points: a kiosk's own page, or the readers or
    routers list opened on its row."""
    if device.device_type in ("fixed_reader", "router"):
        return f"{device_list_link(device)}?focus={device.id}"
    return f"{device_list_link(device)}/{device.id}"


def kind_label(device: Device, vocab: Mapping[str, str]) -> str:
    """What a notification calls this kind of device: "RFID Station" for an RFID Station, else
    the device-type vocabulary's label ("Fixed Reader", "Router"). `vocab` maps a device type to
    its label; one it lacks shows as its key rather than failing the caller."""
    if device.device_type == "kiosk" and is_rfid_station(device):
        return "RFID Station"
    return vocab.get(device.device_type, device.device_type)
