"""Curtain reads -> Dock passes (dock station spec, pass rules).

A tick reads `raw_tag_reads` after the grouper's own cursor (`dock_meta`) in
id order, at most `BATCH` rows, and groups the setup move's reads into passes
by the reader's own read time:

- Any tag opens a pass, and read order inside it doesn't matter. A pass
  closes once no NEW tag has been read for the quiet gap (`edge.dock.state`,
  5 s by default): a re-read of a tag already in the pass is linked to it but
  never keeps it open, so a crate parked in the curtain still closes.
- Times are the reader's `read_at`, so a backlog the reader posts in one
  batch splits exactly as it would have live. A read with no usable
  `read_at` falls back to its `received_at`.
- An open pass with no further reads closes on the laptop clock at
  `last_received_at + gap + 1 s` (the second covers `received_at`'s
  one-second resolution, so it never closes early).
- A closed pass packs only with exactly one crate of the move and at least
  one asset of the move. No crate, or two or more, is flagged; people,
  off-move assets and unknown tags never pack. Ambiguity is flagged, never
  guessed: an asset packed into the wrong crate is the worst outcome.
- A pass is dry run when any of its reads was taken in dry run or dry run is
  on when it closes. Only a live `pack` waits to be sent (`send_state =
  'pending'`).
- Off a Dock setup, or without a move, the cursor jumps to the newest read,
  so reads taken as another station type never land in a pass later.
- A setup-move read whose sync data isn't cached yet stops the tick WITHOUT
  advancing the cursor, like the scan processor; the next tick tries again.

Each tick's writes and its cursor move are one transaction. Everything here
is synchronous and short, and never touches the network."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import NamedTuple

from edge import laptop_setup
from edge.db import Store, iso, now_iso
from edge.dock import state
from edge.rfid import processing, station_key

INTERVAL_S = 1.0
BATCH = 500
_IDLE_SLACK = timedelta(seconds=1)   # received_at's resolution

# match kind -> the index its item is in (off-move matches carry their item)
_SOURCES = {"asset": "assets", "container": "containers", "person": "people"}


class GroupResult(NamedTuple):
    scanned: int    # raw reads taken in (0 off a Dock setup: the cursor just jumps)
    closed: int     # passes closed
    to_send: int    # of those, live packs now waiting to be sent
    waiting: bool   # stopped at a setup-move read whose data isn't cached


@dataclass
class _Pass:
    """The open pass while a tick works on it. Read-derived times are kept
    as datetimes, `*_received_at` as `db.iso` strings (they compare as is)."""
    id: int
    last_new_at: datetime
    last_new_received_at: str
    last_received_at: str
    dry_run: bool
    epcs: set[str]
    changed: bool = False


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _stamp(value: datetime) -> str:
    """A read-derived time as stored: UTC ISO with milliseconds."""
    return value.isoformat(timespec="milliseconds")


def read_time(raw) -> datetime:
    """When the reader read it: `read_at` (the reader's `...22.512+0000` form
    included, no offset read as UTC) in UTC, else its `received_at` when
    `read_at` is missing or unparseable."""
    value = raw["read_at"]
    if isinstance(value, str):
        try:
            return _utc(datetime.fromisoformat(value))
        except (ValueError, OverflowError):
            pass
    return _utc(datetime.fromisoformat(raw["received_at"]))


def classify(indexes: dict[str, dict[str, dict]], epc: str) -> tuple[str, str | None, str | None]:
    """(kind, matched id, label) of one tag against the move's indexes, with
    the scan processor's precedence: `asset` (its name, else serial number,
    else asset id), `container` (name), `person` (display name), `off_move`
    (an asset of the move's client that isn't on the move; name) or
    `unknown`. A crate of another move isn't in the move's data, so it reads
    as `unknown`."""
    found = processing.match(indexes, epc)
    if found is None:
        return "unknown", None, None
    if found.off_move:
        return "off_move", found.matched_id, (found.item or {}).get("name") or None
    item = indexes[_SOURCES[found.kind]][epc]
    if found.kind == "asset":
        label = item.get("name") or item.get("serial_number") or item.get("asset_id")
    elif found.kind == "container":
        label = item.get("name")
    else:
        label = item.get("display_name")
    return found.kind, found.matched_id, label or None


def _set_cursor(c, raw_id: int) -> None:
    c.execute("INSERT INTO dock_meta (id, last_raw_id) VALUES (1, ?) "
              "ON CONFLICT (id) DO UPDATE SET last_raw_id = excluded.last_raw_id", (raw_id,))


def _open_pass(c) -> _Pass | None:
    """The open pass, if any: always the newest (a pass opens only once the
    one before it has closed)."""
    row = c.execute("SELECT id, closed_at, last_new_at, last_new_received_at, last_received_at, "
                    "dry_run FROM dock_passes ORDER BY id DESC LIMIT 1").fetchone()
    if row is None or row["closed_at"] is not None:
        return None
    epcs = {r["epc"] for r in c.execute("SELECT epc FROM dock_pass_tags WHERE pass_id = ?",
                                        (row["id"],))}
    return _Pass(row["id"], datetime.fromisoformat(row["last_new_at"]),
                 row["last_new_received_at"], row["last_received_at"], bool(row["dry_run"]),
                 epcs)


def _open(c, move: str, t: datetime, raw) -> _Pass:
    received = iso(raw["received_at"])
    pid = c.execute(
        "INSERT INTO dock_passes (pass_id, initiative_id, opened_at, last_new_at, "
        "last_new_received_at, last_received_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), move, _stamp(t), _stamp(t), received, received,
         now_iso())).lastrowid
    return _Pass(pid, t, received, received, False, set())


def _add(c, p: _Pass, raw, t: datetime, indexes: dict[str, dict[str, dict]]) -> None:
    """Link one read to the open pass. Only a tag new to the pass is
    classified and moves the pass's last new read on."""
    received = iso(raw["received_at"])
    if raw["epc"] not in p.epcs:
        kind, matched_id, label = classify(indexes, raw["epc"])
        c.execute("INSERT INTO dock_pass_tags (pass_id, epc, kind, matched_id, label, "
                  "first_read_at) VALUES (?, ?, ?, ?, ?, ?)",
                  (p.id, raw["epc"], kind, matched_id, label, _stamp(t)))
        p.epcs.add(raw["epc"])
        p.last_new_at = max(p.last_new_at, t)
        p.last_new_received_at = received
    c.execute("INSERT OR IGNORE INTO dock_pass_reads (pass_id, raw_read_id) VALUES (?, ?)",
              (p.id, raw["id"]))
    p.last_received_at = max(p.last_received_at, received)
    p.dry_run = p.dry_run or bool(raw["dry_run"])
    p.changed = True


def _save(c, p: _Pass) -> None:
    c.execute("UPDATE dock_passes SET last_new_at = ?, last_new_received_at = ?, "
              "last_received_at = ?, dry_run = ? WHERE id = ?",
              (_stamp(p.last_new_at), p.last_new_received_at, p.last_received_at,
               int(p.dry_run), p.id))


def _close(c, p: _Pass, gap_s: int, dry_run_now: bool) -> bool:
    """Close the pass with its outcome; True when it is a live pack, now
    waiting to be sent."""
    rows = c.execute("SELECT kind, matched_id, label FROM dock_pass_tags "
                     "WHERE pass_id = ? AND kind IN ('asset', 'container')", (p.id,)).fetchall()
    crates = {r["matched_id"]: r["label"] for r in rows if r["kind"] == "container"}
    assets = {r["matched_id"] for r in rows if r["kind"] == "asset"}
    crate_id = crate_name = None
    if len(crates) > 1:
        outcome = "many_crates"
    elif crates and assets:
        outcome = "pack"
        [(crate_id, crate_name)] = crates.items()
    elif assets:
        outcome = "no_crate"
    else:
        outcome = "nothing"
    p.dry_run = p.dry_run or dry_run_now
    send = outcome == "pack" and not p.dry_run
    _save(c, p)
    c.execute("UPDATE dock_passes SET closed_at = ?, quiet_gap_s = ?, outcome = ?, "
              "container_id = ?, container_name = ?, asset_count = ?, send_state = ? "
              "WHERE id = ?",
              (_stamp(p.last_new_at + timedelta(seconds=gap_s)), gap_s, outcome, crate_id,
               crate_name, len(assets), "pending" if send else "none", p.id))
    return send


def group(store: Store, now: datetime | None = None) -> GroupResult:
    """One tick: at most BATCH raw reads after the cursor into passes, then
    the idle close of a pass nothing more has been read for."""
    now = now or datetime.now(UTC)
    with store.tx() as c:
        row = c.execute("SELECT last_raw_id FROM dock_meta WHERE id = 1").fetchone()
        last = row["last_raw_id"] if row else 0
        move = (laptop_setup.load(store) or {}).get("initiative_id")
        if not station_key.is_dock_setup(store) or not move:
            newest = c.execute("SELECT COALESCE(MAX(id), 0) FROM raw_tag_reads").fetchone()[0]
            if newest != last:
                _set_cursor(c, newest)   # never grouped later, not even on a Dock
            return GroupResult(0, 0, 0, False)
        settings = state.settings_in(c)
        gap_s = settings["quiet_gap_s"]
        gap = timedelta(seconds=gap_s)
        rows = c.execute("SELECT id, epc, read_at, received_at, initiative_id, dry_run "
                         "FROM raw_tag_reads WHERE id > ? ORDER BY id LIMIT ?",
                         (last, BATCH)).fetchall()
        current = _open_pass(c)
        move_indexes = None
        advanced, scanned, closed, to_send, waiting = last, 0, 0, 0, False
        for raw in rows:
            if raw["initiative_id"] == move:
                if move_indexes is None:
                    move_indexes = processing.indexes(store, move)
                    if move_indexes is None:
                        waiting = True
                        break  # set up but not synced: stop here, never skip it
                t = read_time(raw)
                if current is not None and t - current.last_new_at > gap:
                    to_send += _close(c, current, gap_s, settings["dry_run"])
                    closed += 1
                    current = None
                if current is None:
                    current = _open(c, move, t, raw)
                _add(c, current, raw, t, move_indexes)
            advanced = raw["id"]   # another move's read (or none) is skipped
            scanned += 1
        if current is not None:
            idle_at = datetime.fromisoformat(current.last_received_at) + gap + _IDLE_SLACK
            if not waiting and len(rows) < BATCH and now >= idle_at:
                to_send += _close(c, current, gap_s, settings["dry_run"])
                closed += 1
            elif current.changed:
                _save(c, current)
        if advanced != last:
            _set_cursor(c, advanced)
    return GroupResult(scanned, closed, to_send, waiting)
