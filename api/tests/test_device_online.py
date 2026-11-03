"""Device online rules (services/device_online.py): which devices notifications cover, how long
each may go quiet before it reads as offline, and where each one lives in the portal.

The thresholds are the screens' own, kept in one place so the API and the portal agree: a kiosk
is online for 3 minutes after it was last seen, a router for 4, and a fixed reader for 3 (offline
at once when its station reports it unreachable). `test_thresholds_are_the_screens` pins the
numbers, and the portal's own pins mirror it.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 5, Device offline)
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from serversherpa.api.routes import kiosk as kiosk_routes
from serversherpa.api.routes.devices import reader_status_for
from serversherpa.db.models import Device
from serversherpa.services.device_online import (
    KIOSK_ONLINE, LONGEST_THRESHOLD, READER_STALE_AFTER, ROUTER_ONLINE, covered,
    covered_clause, device_link, device_list_link, is_offline, is_rfid_station, kind_label,
)
from serversherpa.status.labels import status_labels

NOW = datetime(2026, 11, 2, 12, 0, tzinfo=UTC)


# ── devices, built as tests/test_devices_api.py builds them ────────

def _device(device_type: str, **fields) -> Device:
    return Device(**{"id": uuid.uuid4(), "device_type": device_type, "name": "Device A",
                     **fields})


def _station(**fields) -> Device:
    """An RFID Station: a laptop kiosk set up with station type rfid."""
    return _device("kiosk", **{"sub_type": "laptop", "station_type": "rfid", **fields})


def _reader(**fields) -> Device:
    return _device("fixed_reader", **fields)


def _router(**fields) -> Device:
    return _device("router", **{"approval_state": "approved", **fields})


def _covered_devices() -> dict[str, Device]:
    return {
        "RFID Station": _station(),
        "fixed reader": _reader(),
        "unreachable fixed reader": _reader(raw_info={"reachable": False}),
        "approved router": _router(),
    }


def _uncovered_devices() -> dict[str, Device]:
    return {
        "android kiosk": _device("kiosk", sub_type="android"),
        "Label Station": _device("kiosk", sub_type="laptop", station_type="label"),
        "Time Clock": _device("kiosk", sub_type="laptop", station_type="timeclock"),
        "laptop kiosk with no station type": _device("kiosk", sub_type="laptop"),
        "pi kiosk typed rfid": _device("kiosk", sub_type="pi", station_type="rfid"),
        "kiosk with no setup": _device("kiosk"),
        "pending router": _router(approval_state="pending"),
        "revoked router": _router(approval_state="revoked"),
        "router with no approval state": _router(approval_state=None),
    }


def _offline(device: Device, **age) -> bool | None:
    """`is_offline` for a device last seen `age` before NOW."""
    device.last_seen_at = NOW - timedelta(**age)
    return is_offline(device, NOW)


# ── which devices are covered ──────────────────────────────────────

def test_covered():
    for label, device in _covered_devices().items():
        assert covered(device) is True, label
    for label, device in _uncovered_devices().items():
        assert covered(device) is False, label


async def test_the_sql_rule_is_the_same_rule(db):
    devices = [*_covered_devices().values(), *_uncovered_devices().values()]
    covered_ids = {d.id for d in devices if covered(d)}
    other_ids = {d.id for d in devices} - covered_ids
    assert covered_ids and other_ids
    db.add_all(devices)
    await db.commit()

    assert set((await db.scalars(select(Device.id).where(covered_clause()))).all()) == covered_ids
    # never NULL (a kiosk with no station type, a router with no approval state), so its
    # negation finds every other device and none is lost to three-valued logic
    assert set((await db.scalars(select(Device.id).where(~covered_clause()))).all()) == other_ids


def test_is_rfid_station_moved_here():
    assert is_rfid_station(_station()) is True
    assert is_rfid_station(_device("kiosk", sub_type="laptop", station_type="label")) is False
    assert is_rfid_station(_device("kiosk", sub_type="android", station_type="rfid")) is False
    # the kiosk routes use this one, not a copy of it
    assert kiosk_routes.is_rfid_station is is_rfid_station


# ── when a device reads as offline ─────────────────────────────────

def test_thresholds():
    # an RFID Station is online while the age is at most 3 minutes
    station = _station()
    assert _offline(station, seconds=0) is False
    assert _offline(station, minutes=3) is False
    assert _offline(station, minutes=3, seconds=1) is True
    assert _offline(station, hours=2) is True

    # a router waits a minute longer
    router = _router()
    assert _offline(router, minutes=3, seconds=30) is False
    assert _offline(router, minutes=4) is False
    assert _offline(router, minutes=4, seconds=1) is True

    # a fixed reader is 3 minutes, like a station
    reader = _reader()
    assert _offline(reader, minutes=3) is False
    assert _offline(reader, minutes=3, seconds=1) is True

    # and goes offline at once when its station can't reach it, however fresh
    for raw_info in (None, {}, {"reachable": None}, {"reachable": True}):
        assert _offline(_reader(raw_info=raw_info), seconds=0) is False, raw_info
    assert _offline(_reader(raw_info={"reachable": False}), seconds=0) is True
    # only the boolean false does that: a flag that merely reads as false (0) does not
    assert _offline(_reader(raw_info={"reachable": 0}), seconds=0) is False
    # and only for a reader: the flag is its station's report about it
    assert _offline(_router(raw_info={"reachable": False}), seconds=0) is False
    assert _offline(_station(raw_info={"reachable": False}), seconds=0) is False

    # a timestamp a little ahead of the caller's clock is a device that just checked in
    assert _offline(_station(), seconds=-5) is False


def test_a_device_never_seen_is_not_judged():
    for device in (_station(), _reader(), _router(), _reader(raw_info={"reachable": False})):
        assert device.last_seen_at is None
        assert is_offline(device, NOW) is None


def test_a_naive_timestamp_reads_as_utc():
    assert is_offline(_station(last_seen_at=datetime(2026, 11, 2, 11, 57)), NOW) is False
    assert is_offline(_station(last_seen_at=datetime(2026, 11, 2, 11, 56, 59)), NOW) is True
    assert is_offline(_router(last_seen_at=datetime(2026, 11, 2, 11, 56)), NOW) is False
    assert is_offline(_router(last_seen_at=datetime(2026, 11, 2, 11, 55, 59)), NOW) is True


def test_thresholds_are_the_screens():
    """The numbers the screens use: KIOSK_ONLINE_MS (portal/src/lib/kioskConfig.ts),
    ROUTER_ONLINE_MS (portal/src/lib/devices.ts) and the Readers list's three minutes. The
    portal pins the same three, so a change on one side fails the other."""
    assert KIOSK_ONLINE == timedelta(minutes=3)
    assert ROUTER_ONLINE == timedelta(minutes=4)
    assert READER_STALE_AFTER == timedelta(minutes=3)
    # the quiet window after maintenance is the longest of them
    assert LONGEST_THRESHOLD == timedelta(minutes=4)
    assert LONGEST_THRESHOLD == max(KIOSK_ONLINE, ROUTER_ONLINE, READER_STALE_AFTER)


def test_the_readers_list_follows_the_shared_rule():
    """The Readers list's Offline and the device check's are one rule: the list shows Offline
    exactly when `is_offline` is true, and for a reader that never checked in (which the check
    skips) as well."""
    naive = datetime(2026, 11, 2, 11, 57)
    for seen in (None, NOW, NOW - timedelta(minutes=3), NOW - timedelta(minutes=3, seconds=1),
                 NOW - timedelta(hours=1), naive):
        for raw_info in (None, {}, {"reading": True}, {"reachable": True}, {"reachable": None},
                         {"reachable": False}, {"reading": True, "reachable": False}):
            reader = _reader(last_seen_at=seen, raw_info=raw_info)
            status = reader_status_for(reader, NOW)
            assert status in {"offline", "reading", "standby"}
            offline = is_offline(reader, NOW)
            assert (status == "offline") == (offline is None or offline), (seen, raw_info)


# ── where a device lives, and what to call it ──────────────────────

def test_links_and_labels():
    station, reader, router = _station(), _reader(), _router()
    vocab = {"router": "Router", "fixed_reader": "Fixed Reader", "kiosk": "Kiosk"}

    # an RFID Station has a page of its own; the readers and routers lists open on the row
    assert device_link(station) == f"/hardware/kiosks/{station.id}"
    assert device_link(reader) == f"/hardware/fixed-readers?focus={reader.id}"
    assert device_link(router) == f"/hardware/routers?focus={router.id}"
    # and without the row, the list
    assert device_list_link(station) == "/hardware/kiosks"
    assert device_list_link(reader) == "/hardware/fixed-readers"
    assert device_list_link(router) == "/hardware/routers"
    # any other kiosk has its page too (a watch outlives the setup that made it covered)
    android = _device("kiosk", sub_type="android")
    assert device_link(android) == f"/hardware/kiosks/{android.id}"
    assert device_list_link(android) == "/hardware/kiosks"

    assert kind_label(station, vocab) == "RFID Station"
    assert kind_label(reader, vocab) == "Fixed Reader"
    assert kind_label(router, vocab) == "Router"


def test_a_label_is_read_from_the_vocabulary():
    vocab = {"router": "Router A", "fixed_reader": "Reader A", "kiosk": "Kiosk A"}
    assert kind_label(_router(), vocab) == "Router A"
    assert kind_label(_reader(), vocab) == "Reader A"
    # an RFID Station is named for what it is, whatever the vocabulary calls a kiosk
    assert kind_label(_station(), vocab) == "RFID Station"
    assert kind_label(_station(), {}) == "RFID Station"
    # any other kiosk keeps the vocabulary's word
    assert kind_label(_device("kiosk", sub_type="android"), vocab) == "Kiosk A"
    # a type the vocabulary lacks is shown as its key rather than failing the caller
    assert kind_label(_reader(), {}) == "fixed_reader"


async def test_the_labels_are_the_device_type_vocabulary(db):
    labels = await status_labels(db, "device_type")
    vocab = {key: label for key, (label, _color) in labels.items()}
    assert kind_label(_station(), vocab) == "RFID Station"
    assert kind_label(_reader(), vocab) == "Fixed Reader"
    assert kind_label(_router(), vocab) == "Router"
