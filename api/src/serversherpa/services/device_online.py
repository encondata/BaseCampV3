"""Device online rules: which devices notifications cover, how long each may go quiet before it
reads as offline, where each one lives in the portal and what it is called there. They sit in one
place so the Readers list, the check that announces outages and the routes that watch devices all
agree.

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
nothing, so a quiet stretch from any of them is not an outage. RFID and Dock Stations send a
telemetry beat of their own, so they are covered.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 5, Device offline)
"""

import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta

from sqlalchemy import ColumnElement, and_, false, func, or_

from serversherpa.db.models import Device
from serversherpa.services import station_keys

# A device is online while the time since its `last_seen_at` is at most its threshold.
KIOSK_ONLINE = timedelta(minutes=3)      # kiosks check in every minute: three missed beats
ROUTER_ONLINE = timedelta(minutes=4)     # about three missed reports at the agent's 65 s default
READER_STALE_AFTER = timedelta(minutes=3)    # the Readers list's Offline
# The longest of the three: how long the device check stays quiet after maintenance.
LONGEST_THRESHOLD = ROUTER_ONLINE


def is_rfid_station(device: Device) -> bool:
    """An RFID Station: a laptop kiosk set up with station type rfid."""
    return device.sub_type == "laptop" and device.station_type == "rfid"


def is_reader_station(device: Device) -> bool:
    """A laptop kiosk set up as an RFID or Dock Station: the stations with a paired reader,
    which send their own telemetry beat."""
    return (device.sub_type == "laptop"
            and device.station_type in station_keys.READER_STATION_TYPES)


def covered(device: Device) -> bool:
    """Whether notifications check this device and people can watch it: an RFID or Dock
    Station, any fixed reader, or an approved router."""
    if device.device_type == "kiosk":
        return is_reader_station(device)
    if device.device_type == "fixed_reader":
        return True
    return device.device_type == "router" and device.approval_state == "approved"


def covered_clause() -> ColumnElement[bool]:
    """`covered()` as SQL. It is never NULL (a kiosk with no station type is plainly not
    covered), so `~covered_clause()` finds the devices that are not."""
    return func.coalesce(or_(
        and_(Device.device_type == "kiosk", Device.sub_type == "laptop",
             Device.station_type.in_(station_keys.READER_STATION_TYPES)),
        Device.device_type == "fixed_reader",
        and_(Device.device_type == "router", Device.approval_state == "approved"),
    ), false())


def is_offline(device: Device, now: datetime) -> bool | None:
    """Whether the device reads as offline at `now` (timezone-aware): quiet for more than its
    threshold, or, for a fixed reader, reported unreachable by its station. None when it has
    never checked in, so there is nothing to judge. A naive `last_seen_at` reads as UTC.

    This is the rule for the device's kind, covered or not; `covered()` says whether
    notifications act on it.

    Three clocks meet here. A router's `last_seen_at` is the database's clock (`now()` in
    services/router_agent.py `handle_report`); a kiosk's and a reader's are the API's (a
    reader's can be its station's own time for the reading, never later than the API's); and
    `now` is the caller's, the worker's for the device check. All of them are kept by NTP, so
    they agree far more closely than any threshold needs."""
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
    """What a notification calls this kind of device: "RFID Station" for an RFID Station,
    "Dock Station" for a Dock Station, else the device-type vocabulary's label ("Fixed
    Reader", "Router"). `vocab` maps a device type to its label; one it lacks shows as its
    key rather than failing the caller."""
    if device.device_type == "kiosk" and is_reader_station(device):
        return "Dock Station" if device.station_type == station_keys.DOCK else "RFID Station"
    return vocab.get(device.device_type, device.device_type)


# Words a router hostname spells in capitals ("csg" → "CSG"): the portal's ROUTER_ACRONYMS
# (portal/src/lib/devices.ts), copied exactly. devices.test.ts pins the list there and
# tests/test_device_online.py here.
ROUTER_ACRONYMS = ("csg", "gl", "vpn", "lte", "nap", "dc", "ups", "lan", "wan", "ap")
_ROUTER_WORD_BREAK = re.compile(r"[\s_.-]+")
_DIGIT = re.compile(r"[0-9]")


def display_name(device: Device) -> str:
    """What the portal calls this device. A router's hostname is made readable as the Routers
    page shows it (routerDisplayName in portal/src/lib/devices.ts): `csg_router_kit_19` →
    "CSG Router Kit 19". Its words are split at whitespace, underscores, dots and hyphens; a word of
    ROUTER_ACRONYMS goes to capitals, a word with a digit in it is kept as typed, and every other
    word gets a capital first letter. Every other device is called by its name, as stored."""
    if device.device_type != "router":
        return device.name
    words = []
    for word in _ROUTER_WORD_BREAK.split(device.name):
        if not word:
            continue
        if word.lower() in ROUTER_ACRONYMS:
            words.append(word.upper())
        elif _DIGIT.search(word):
            words.append(word)
        else:
            words.append(word[:1].upper() + word[1:].lower())
    return " ".join(words) if words else device.name
