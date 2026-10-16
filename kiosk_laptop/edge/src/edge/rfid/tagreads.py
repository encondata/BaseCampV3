"""Zebra FX9600 tag events -> the edge's raw_tag_reads / rfid_tags_seen tables.

`parse_events` is forgiving per event (a bad event is skipped and counted,
never failing the batch); `store_batch` writes a whole batch in one
transaction so a retry after a failure can't duplicate half of it.
"""

import json
import math
import re
from datetime import UTC, datetime, time
from zoneinfo import ZoneInfo

from .. import laptop_setup
from ..db import Store, iso, now_iso

_HEX = re.compile(r"[0-9A-F]{1,128}")
_WHITESPACE = re.compile(r"\s+")


def normalize_epc(value) -> str | None:
    """Strip all whitespace and uppercase; None unless 1-128 hex characters."""
    if not isinstance(value, str):
        return None
    epc = _WHITESPACE.sub("", value).upper()
    return epc if _HEX.fullmatch(epc) else None


def _number(value) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return float(value) if math.isfinite(value) else None
    except (OverflowError, ValueError):
        return None


def _integer(value) -> int | None:
    """An int that fits SQLite's signed 64-bit INTEGER, else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, int):
        return value if -(2**63) <= value <= 2**63 - 1 else None
    number = _number(value)
    if number is None or not -(2**63) <= number < 2**63:
        return None
    return int(number)


def _text(value, limit: int) -> str | None:
    return value if isinstance(value, str) and len(value) <= limit else None


def _parse_event(event) -> dict | None:
    if not isinstance(event, dict):
        return None
    data = event.get("data")
    if not isinstance(data, dict):
        return None
    epc = normalize_epc(data.get("idHex"))
    if epc is None:
        return None
    return {
        "read_at": _text(event.get("timestamp"), 64),
        "epc": epc,
        "antenna": _integer(data.get("antenna")),
        "peak_rssi": _number(data.get("peakRssi")),
        "reads": _integer(data.get("reads")),
        "channel": _number(data.get("channel")),
        "phase": _number(data.get("phase")),
        "event_num": _integer(data.get("eventNum")),
        "event_type": _text(event.get("type"), 32),
        "raw_json": json.dumps(event, separators=(",", ":")),
    }


def parse_events(body) -> tuple[list[dict], int]:
    """(rows, skipped) for a decoded POST body: one event object or a list."""
    if isinstance(body, dict):
        events = [body]
    elif isinstance(body, list):
        events = body
    else:
        raise ValueError("body must be a JSON object or array")
    rows: list[dict] = []
    skipped = 0
    for event in events:
        row = _parse_event(event)
        if row is None:
            skipped += 1
        else:
            rows.append(row)
    return rows, skipped


_INSERT = """
    INSERT INTO raw_tag_reads (received_at, read_at, reader_serial, epc, antenna, peak_rssi,
        reads, channel, phase, event_num, event_type, initiative_id, site_id, scan_status,
        raw_json)
    VALUES (:received_at, :read_at, :reader_serial, :epc, :antenna, :peak_rssi,
        :reads, :channel, :phase, :event_num, :event_type, :initiative_id, :site_id,
        :scan_status, :raw_json)"""

_UPSERT = """
    INSERT INTO rfid_tags_seen (epc, first_seen, last_seen, total_reads, last_antenna,
        last_rssi, reader_serial)
    VALUES (:epc, :received_at, :received_at, MAX(COALESCE(:reads, 1), 1), :antenna,
        :peak_rssi, :reader_serial)
    ON CONFLICT(epc) DO UPDATE SET
        last_seen = excluded.last_seen,
        total_reads = total_reads + excluded.total_reads,
        last_antenna = excluded.last_antenna,
        last_rssi = excluded.last_rssi,
        reader_serial = excluded.reader_serial"""


def store_batch(store: Store, *, reader_serial: str, rows: list[dict],
                setup: dict | None, received_at: str | None = None) -> int:
    """Insert every row and upsert the per-tag summary in one transaction."""
    received_at = received_at or now_iso()
    setup = setup or {}
    context = {"initiative_id": setup.get("initiative_id"), "site_id": setup.get("site_id"),
               "scan_status": setup.get("scan_status")}
    with store.tx() as c:
        for row in rows:
            params = {**row, **context, "reader_serial": reader_serial,
                      "received_at": received_at}
            c.execute(_INSERT, params)
            c.execute(_UPSERT, params)
    return len(rows)


RECENT_LIMIT = 50

# One entry: ((id(store), cache key, stored_at, body length), index, total).
_asset_index: dict[tuple, tuple[dict[str, dict], int]] = {}


def _zone(tz):
    try:
        return ZoneInfo(tz) if isinstance(tz, str) and tz else UTC
    except (ValueError, OSError, KeyError):  # ZoneInfoNotFoundError is a KeyError
        return UTC


def local_midnight_iso(tz, now: datetime | None = None) -> str:
    """Local midnight in `tz` as a UTC string formatted like db.now_iso(), so the
    cutoff compares correctly against stored `last_seen` / `received_at`."""
    zone = _zone(tz)
    local = (now or datetime.now(UTC)).astimezone(zone)
    return iso(datetime.combine(local.date(), time.min, tzinfo=zone))


def _assets(store: Store, move_id: str) -> tuple[dict[str, dict], int] | None:
    """(normalized rfid -> asset summary, asset count) from the cached sync body."""
    key = f"/kiosk/sync/assets?initiative_id={move_id}"
    meta = store.one("SELECT stored_at, length(body) AS n FROM cache WHERE key = ?", (key,))
    if meta is None:
        return None
    stamp = (id(store), key, meta["stored_at"], meta["n"])
    hit = _asset_index.get(stamp)
    if hit is not None:
        return hit
    row = store.one("SELECT body FROM cache WHERE key = ?", (key,))
    try:
        assets = json.loads(row["body"]).get("assets") if row else None
    except (ValueError, AttributeError):
        assets = None
    if not isinstance(assets, list):
        return None
    index: dict[str, dict] = {}
    for a in assets:
        if not isinstance(a, dict):
            continue
        epc = normalize_epc(a.get("rfid"))
        if epc is not None:
            index.setdefault(epc, {"serial_number": a.get("serial_number"),
                                   "name": a.get("name"), "make_model": a.get("make_model")})
    result = (index, len(assets))
    _asset_index.clear()
    _asset_index[stamp] = result
    return result


def reads_summary(store: Store, *, tz: str = "UTC", limit: int = RECENT_LIMIT,
                  now: datetime | None = None) -> dict:
    """The RFID dashboard's data (spec section 5)."""
    cutoff = local_midnight_iso(tz, now)
    tags_today = store.one("SELECT COUNT(*) AS n FROM rfid_tags_seen WHERE last_seen >= ?",
                           (cutoff,))["n"]
    setup = laptop_setup.load(store)
    found = _assets(store, setup["initiative_id"]) if setup and setup.get("initiative_id") \
        else None
    index: dict[str, dict] = {}
    move_total = move_seen = None
    if found is not None:
        index, move_total = found
        seen = {r["epc"] for r in store.all("SELECT epc FROM rfid_tags_seen")}
        move_seen = sum(1 for epc in index if epc in seen)
    rows = store.all("SELECT epc, received_at, antenna, peak_rssi FROM raw_tag_reads "
                     "ORDER BY id DESC LIMIT ?", (limit,))
    recent = [{"epc": r["epc"], "received_at": r["received_at"], "antenna": r["antenna"],
               "peak_rssi": r["peak_rssi"], "asset": index.get(r["epc"])} for r in rows]
    last = store.one("SELECT MAX(received_at) AS t FROM raw_tag_reads")["t"]
    return {"tags_today": tags_today, "move_total": move_total, "move_seen": move_seen,
            "recent": recent, "last_received_at": last}
