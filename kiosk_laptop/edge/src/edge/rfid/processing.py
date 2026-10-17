"""Raw tag reads -> `pending_rfid_scans` (spec section 2.2).

A pass reads `raw_tag_reads` after the durable cursor in id order, at most
`PASS_LIMIT` rows, and matches each read against the laptop's cached copy of
the move it was taken on (its `initiative_id` snapshot): the move's assets,
then its containers, then people badges, then the client asset list (an
off-move sighting). Each raw read becomes at most one pending scan
(`raw_read_id` is UNIQUE), so re-running a pass never duplicates.

- A read with no move, or for a move that is no longer the laptop's setup
  move, is skipped: it stays only in `raw_tag_reads`.
- A read for the current move whose data isn't cached yet stops the pass
  WITHOUT advancing the cursor; the next tick tries again.
- A current-move read that matches nothing goes into `rfid_unmatched`, which
  `recheck_unmatched` re-matches after every successful sync for 24 h.
- On an RFID station, a fresh off-move match (received at most
  `alarm.FRESH_S` before the pass) raises the "Asset Not Part Of Move" alarm
  in the pass's own transaction. Late matches (a backlog, the re-check) never
  alarm.

Everything here is synchronous and short: it runs on the event loop the
8091 ingest shares, against the one SQLite store, and never touches the
network."""

import json
import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import NamedTuple

from edge import laptop_setup
from edge import sync as edge_sync  # module ref: edge.sync imports this module
from edge.db import Store, iso, now_iso
from edge.rfid import alarm, tagreads

log = logging.getLogger("edge.rfid.processing")

INTERVAL_S = 2.0
PASS_LIMIT = 500
RECHECK_HOURS = 24

# (sync path name, list field in its body, tag field on each item)
_SOURCES = {
    "assets": ("assets", "rfid"),
    "containers": ("containers", "rfid_tag"),
    "people": ("people", "rfid_tag"),
    "client-assets": ("assets", "rfid"),
}


class PassResult(NamedTuple):
    inserted: int   # pending scans created
    scanned: int    # raw reads the cursor moved past
    waiting: bool   # stopped at a current-move read whose data isn't cached


class Match(NamedTuple):
    kind: str
    matched_id: str
    off_move: int = 0
    off_move_initiative_id: str | None = None
    off_move_initiative_name: str | None = None
    item: dict | None = None    # the client-assets item behind an off-move match


# source name -> (stamp, index). Stamp: (id(store), cache key, rowid, stored_at,
# tagreads' cache-write counter), like tagreads' asset index. Keyed by source
# name, so a new setup move's index replaces the old move's in memory.
_memo: dict[str, tuple[tuple, dict[str, dict]]] = {}


def _cache_key(name: str, move_id: str) -> str:
    path = f"/kiosk/sync/{name}"
    return next(p for p in edge_sync.sync_paths(move_id) if p.split("?", 1)[0] == path)


def _index(store: Store, name: str, move_id: str) -> dict[str, dict] | None:
    """normalized tag -> item for one cached sync body; None when not cached.
    A malformed body indexes as empty (it would never get better by waiting)."""
    key = _cache_key(name, move_id)
    meta = store.one("SELECT rowid AS id, stored_at FROM cache WHERE key = ?", (key,))
    if meta is None:
        return None
    stamp = (id(store), key, meta["id"], meta["stored_at"], tagreads._cache_generation)
    hit = _memo.get(name)
    if hit is not None and hit[0] == stamp:
        return hit[1]
    list_field, tag_field = _SOURCES[name]
    row = store.one("SELECT body FROM cache WHERE key = ?", (key,))
    try:
        items = json.loads(row["body"]).get(list_field) if row else None
    except (ValueError, AttributeError):
        items = None
    if not isinstance(items, list):
        log.warning("cached %s body has no %s list; matching it as empty", name, list_field)
        items = []
    index: dict[str, dict] = {}
    for item in items:
        if not isinstance(item, dict) or item.get("id") is None:
            continue
        epc = tagreads.normalize_epc(item.get(tag_field))
        if epc is not None:
            index.setdefault(epc, item)  # the first item with a tag wins
    _memo[name] = (stamp, index)
    return index


def _indexes(store: Store, move_id: str) -> dict[str, dict[str, dict]] | None:
    """Every source for the move, or None while any one isn't cached yet."""
    found = {}
    for name in _SOURCES:
        index = _index(store, name, move_id)
        if index is None:
            return None
        found[name] = index
    return found


def _match(indexes: dict[str, dict[str, dict]], epc: str) -> Match | None:
    for name, kind in (("assets", "asset"), ("containers", "container"), ("people", "person")):
        item = indexes[name].get(epc)
        if item is not None:
            return Match(kind, str(item["id"]))
    item = indexes["client-assets"].get(epc)
    if item is not None:
        move = item.get("initiative_id")
        return Match("asset", str(item["id"]), 1, str(move) if move is not None else None,
                     item.get("initiative_name"), item)
    return None


def _current_move(setup: dict | None) -> str | None:
    """The setup move from a loaded laptop setup (None when not set up)."""
    return (setup or {}).get("initiative_id") or None


def _alarm_item(match: Match) -> dict:
    item = match.item or {}
    return {"asset_id": match.matched_id, "make": item.get("make"), "model": item.get("model"),
            "name": item.get("name"), "serial": item.get("serial_number"),
            "rfid": item.get("rfid")}


def _fresh(received_at: str, now: datetime) -> bool:
    try:
        return datetime.fromisoformat(iso(received_at)) >= now - timedelta(seconds=alarm.FRESH_S)
    except (TypeError, ValueError):
        return False


_INSERT = """
    INSERT OR IGNORE INTO pending_rfid_scans (raw_read_id, client_scan_id, epc, matched_kind,
        matched_id, off_move, off_move_initiative_id, off_move_initiative_name, scanned_at,
        initiative_id, site_id, scan_status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"""


def _insert(c, raw, match: Match, created_at: str) -> int:
    return c.execute(_INSERT, (
        raw["id"], str(uuid.uuid4()), raw["epc"], match.kind, match.matched_id, match.off_move,
        match.off_move_initiative_id, match.off_move_initiative_name, raw["received_at"],
        raw["initiative_id"], raw["site_id"], raw["scan_status"], created_at)).rowcount


def _cursor(store: Store) -> int:
    row = store.one("SELECT last_raw_id FROM rfid_processing_meta WHERE id = 1")
    return row["last_raw_id"] if row else 0


def process(store: Store, now: datetime | None = None) -> PassResult:
    """One pass of at most PASS_LIMIT raw reads after the cursor."""
    now = now or datetime.now(UTC)
    last = _cursor(store)
    rows = store.all("SELECT id, epc, received_at, initiative_id, site_id, scan_status "
                     "FROM raw_tag_reads WHERE id > ? ORDER BY id LIMIT ?", (last, PASS_LIMIT))
    if not rows:
        return PassResult(0, 0, False)
    setup = laptop_setup.load(store) or {}
    current = _current_move(setup)
    alarms_on = setup.get("station_type") == "rfid"
    indexes = None
    matches: list[tuple] = []
    misses: list[tuple] = []
    advanced = last
    waiting = False
    scanned = 0
    for raw in rows:
        move = raw["initiative_id"]
        if move and move == current:
            if indexes is None:
                indexes = _indexes(store, current)
                if indexes is None:
                    waiting = True
                    break  # set up but not synced: stop here, never skip it
            match = _match(indexes, raw["epc"])
            if match is None:
                misses.append((raw["id"], raw["received_at"]))
            else:
                matches.append((raw, match))
        advanced = raw["id"]
        scanned += 1
    if advanced == last:
        return PassResult(0, 0, waiting)
    inserted = 0
    created_at = now_iso()
    raised: list[dict] = []
    with store.tx() as c:
        to_alarm = []
        for raw, match in matches:
            added = _insert(c, raw, match, created_at)
            inserted += added
            if added and alarms_on and match.off_move and _fresh(raw["received_at"], now):
                to_alarm.append(_alarm_item(match))
        if to_alarm:
            # an alarm failure rolls back only the alarm, never the pass
            c.execute("SAVEPOINT alarm")
            try:
                raised = alarm.raise_for(c, to_alarm, now)
                c.execute("RELEASE alarm")
            except Exception:
                log.exception("raising the off-move alarm failed")
                c.execute("ROLLBACK TO alarm")
                c.execute("RELEASE alarm")
                raised = []
        c.executemany("INSERT OR IGNORE INTO rfid_unmatched (raw_read_id, received_at) "
                      "VALUES (?, ?)", misses)
        c.execute("INSERT INTO rfid_processing_meta (id, last_raw_id) VALUES (1, ?) "
                  "ON CONFLICT (id) DO UPDATE SET last_raw_id = excluded.last_raw_id",
                  (advanced,))
    alarm.record_event(store, raised)
    return PassResult(inserted, scanned, waiting)


def run_once(store: Store) -> int:
    """One pass; the number of pending scans inserted."""
    return process(store).inserted


def recheck_unmatched(store: Store, *, now: datetime | None = None) -> int:
    """After a successful sync: forget unmatched reads older than 24 h (and any
    no longer for the setup move), re-match the rest against the fresh data,
    and turn matches into pending scans. Returns how many were inserted."""
    cutoff = iso((now or datetime.now(UTC)) - timedelta(hours=RECHECK_HOURS))
    current = _current_move(laptop_setup.load(store))
    with store.tx() as c:
        c.execute("DELETE FROM rfid_unmatched WHERE received_at < ?", (cutoff,))
        c.execute("DELETE FROM rfid_unmatched WHERE NOT EXISTS (SELECT 1 FROM raw_tag_reads r "
                  "WHERE r.id = rfid_unmatched.raw_read_id AND r.initiative_id = ?)",
                  (current,))
    if current is None:
        return 0
    indexes = _indexes(store, current)
    if indexes is None:
        return 0
    # one lookup per distinct tag: a stray tag in range leaves many reads behind
    epcs = store.all("SELECT DISTINCT r.epc FROM rfid_unmatched u "
                     "JOIN raw_tag_reads r ON r.id = u.raw_read_id")
    found = {row["epc"]: m for row in epcs if (m := _match(indexes, row["epc"])) is not None}
    inserted = 0
    created_at = now_iso()
    for epc, match in found.items():
        reads = store.all("SELECT r.id, r.epc, r.received_at, r.initiative_id, r.site_id, "
                          "r.scan_status FROM rfid_unmatched u "
                          "JOIN raw_tag_reads r ON r.id = u.raw_read_id WHERE r.epc = ? "
                          "ORDER BY r.id", (epc,))
        for start in range(0, len(reads), PASS_LIMIT):
            chunk = reads[start:start + PASS_LIMIT]
            with store.tx() as c:
                for raw in chunk:
                    inserted += _insert(c, raw, match, created_at)
                c.executemany("DELETE FROM rfid_unmatched WHERE raw_read_id = ?",
                              [(raw["id"],) for raw in chunk])
    return inserted
