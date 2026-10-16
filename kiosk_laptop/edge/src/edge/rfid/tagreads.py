"""Zebra FX9600 tag events -> the edge's raw_tag_reads / rfid_tags_seen tables.

`parse_events` is forgiving per event (a bad event is skipped and counted,
never failing the batch); `store_batch` writes a whole batch in one
transaction so a retry after a failure can't duplicate half of it.
"""

import json
import math
import re

from ..db import Store, now_iso

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
