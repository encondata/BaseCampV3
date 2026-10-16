"""The paired FX9600's snapshot (spec 2026-10-16-fixed-reader-report §2–3).

Every minute the edge reads the reader's version, network and status (under
`pair_lock`, like `/edge/rfid/status`), counts the last 24 hours of raw tag
reads, and keeps the result in `state.reader_snapshot`. The proxy attaches a
fresh snapshot to the kiosk heartbeat; the portal turns it into a fixed
reader record. It runs on its own loop, not Background's, because it needs
the reader and not the internet.

Each reader call is tried on its own: a failure leaves that call's fields
out. A value that wouldn't pass the portal's limits (a string over 64
characters, a bad MAC or IP) is left out too. A reader that can't be opened
keeps its last values with `reachable: false`."""

import asyncio
import contextlib
import ipaddress
import logging
import re
from datetime import UTC, datetime, timedelta

from edge import laptop_setup
from edge.db import iso, now_iso
from edge.rfid import pairing, ziotc
from edge.rfid.ziotc import ReaderError

log = logging.getLogger("edge.rfid.reader_report")

INTERVAL_S = 60
FRESH_FOR = timedelta(minutes=3)
MAX_LEN = 64
MAC = re.compile(r"^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$")
UPTIME = re.compile(r"^(\d+):(\d+):(\d+)$")
FRESH_KEYS = ("reachable", "tags_24h", "taken_at")


def parse_uptime(value) -> int | None:
    """The reader's `h:m:s` uptime (any number of hours) as seconds."""
    match = UPTIME.match(value) if isinstance(value, str) else None
    if match is None:
        return None
    h, m, s = (int(g) for g in match.groups())
    return h * 3600 + m * 60 + s


def _text(value) -> str | None:
    return value if isinstance(value, str) and 0 < len(value) <= MAX_LEN else None


def _mac(value) -> str | None:
    return value if isinstance(value, str) and MAC.match(value) else None


def _ipv4(value) -> str | None:
    try:
        return str(ipaddress.IPv4Address(value)) if isinstance(value, str) else None
    except ValueError:
        return None


def _put(out: dict, key: str, value) -> None:
    if value is not None:
        out[key] = value


def _tags_24h(store, serial: str, now: datetime) -> int:
    row = store.one("SELECT COUNT(*) AS n FROM raw_tag_reads "
                    "WHERE reader_serial = ? AND received_at >= ?",
                    (serial, iso(now - timedelta(hours=24))))
    return int(row["n"])


async def build_snapshot(state, *, now: datetime | None = None) -> dict | None:
    """The reader snapshot, or None when there is no pairing or this laptop
    isn't an RFID Station."""
    now = now or datetime.now(UTC)
    store = state.store
    setup = laptop_setup.load(store)
    row = pairing.current_row(store)
    if row is None or not setup or setup.get("station_type") != "rfid":
        return None
    serial = row["serial"]
    snap: dict = {"serial": serial, "make": "Zebra"}
    reachable = True
    async with state.pair_lock:
        try:
            client, version, _row = await pairing.open_current(
                store, transport=state.reader_transport)
        except ReaderError:
            reachable = False
        else:
            async with client:
                _put(snap, "model", _text(version.get("model")))
                _put(snap, "firmware", _text(version.get("readerApplication")))
                try:
                    net = await client.network()
                except ReaderError:
                    pass
                else:
                    _put(snap, "name", _text(net.get("hostName")))
                    _put(snap, "mac", _mac(net.get("macAddress")))
                    _put(snap, "ip", _ipv4(net.get("ipAddress")))
                try:
                    status = await client.status()
                except ReaderError:
                    pass
                else:
                    _put(snap, "uptime_seconds", parse_uptime(status.get("uptime")))
                    antennas = status.get("antennas")
                    if isinstance(antennas, dict):
                        snap["antennas_connected"] = sum(
                            1 for v in antennas.values() if v == "connected")
                        snap["antennas_total"] = len(antennas)
                    snap["reading"] = ziotc.is_reading(status)
    if not reachable:
        previous = getattr(state, "reader_snapshot", None)
        if isinstance(previous, dict) and previous.get("serial") == serial:
            snap = {k: v for k, v in previous.items() if k not in FRESH_KEYS}
    snap["reachable"] = reachable
    snap["tags_24h"] = _tags_24h(store, serial, now)
    snap["taken_at"] = now_iso()
    return snap


def current_snapshot(state, *, now: datetime | None = None) -> dict | None:
    """The snapshot for the heartbeat: only an RFID Station's, and only one
    taken in the last 3 minutes."""
    snap = getattr(state, "reader_snapshot", None)
    if not isinstance(snap, dict):
        return None
    setup = laptop_setup.load(state.store)
    if not setup or setup.get("station_type") != "rfid":
        return None
    try:
        taken = datetime.fromisoformat(snap["taken_at"])
    except (KeyError, TypeError, ValueError):
        return None
    if taken.tzinfo is None:
        taken = taken.replace(tzinfo=UTC)
    return snap if (now or datetime.now(UTC)) - taken <= FRESH_FOR else None


class ReaderReporter:
    def __init__(self, state) -> None:
        self.state = state
        self._task: asyncio.Task | None = None

    async def _loop(self) -> None:
        while True:
            try:
                self.state.reader_snapshot = await build_snapshot(self.state)
            except Exception as exc:  # never fatal; type only (the reader's token is a secret)
                log.warning("reader snapshot failed: %s", type(exc).__name__)
            await asyncio.sleep(INTERVAL_S)

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
