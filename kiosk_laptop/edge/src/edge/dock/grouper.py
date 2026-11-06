"""Curtain reads -> Dock passes (dock station spec, "The crate window").

A tick reads `raw_tag_reads` after the grouper's own cursor (`dock_meta`) in
id order, at most `BATCH` rows, and groups the setup move's reads by the
reader's own read time. W is the fixed window `state.WINDOW_S` (5 s).

- Reads gather into a burst: the open `dock_passes` row. Any tag opens one,
  and read order inside it doesn't matter. A burst ends once the reader's
  clock passes its settle time (`settle`): 2W after its newest crate's
  first read, or W after its newest NEW tag's first read when that is later
  (a straggler) or the burst holds no crate. No read after that can fall in
  one of its crates' windows or chain with them. A re-read of a tag already
  in it is linked to it but never moves the settle time (tags are read once
  at the curtain), so a crate parked in the curtain still ends it. The
  first read past the settle time decides the burst and opens the next one.
- Times are the reader's `read_at`, so a backlog the reader posts in one
  batch splits exactly as it would have live. A read with no usable
  `read_at` falls back to its `received_at`.
- An open burst with no further reads is decided on the laptop clock: its
  settle time moved onto that clock by the newest new tag's own read and
  arrival times, `last_new_received_at + (settle - last_new_at) + 1 s`, so it
  holds however far off the reader's clock is. The second covers
  `received_at`'s one-second resolution, so it is never decided early.
- The Dock screen's Stop (`decide_now`) groups the backlog, then decides the
  open burst at once with what has been read. A read that arrives after
  that, even one read before it, opens a new burst.
- Deciding splits the burst into passes. Each crate tag is anchored at its
  first read (re-reads never move it). Crates anchored within 2W of the
  next form one group, and an asset joins every group with a crate within W
  of one of its reads: an asset in two groups merges them. A group with one
  crate packs its assets (`pack`, or `nothing` without any), one with two
  or more is flagged `many_crates`, and assets in no window make one
  `no_crate` pass. People, off-move assets and unknown tags join the
  earliest group whose window holds one of their reads (else that last
  pass), and never pack or merge. Ambiguity is flagged, never guessed: an
  asset packed into the wrong crate is the worst outcome. The window test
  and the grouping (`crate_windows`, `crate_groups`) are shared with the
  Dock screen's view of the open burst, so the screen agrees with them.
- A crate group's pass closes at its first anchor + W, the no-crate pass at
  the burst's last new read + W.
- A pass is dry run (and reads "Would pack") only when one of its own reads
  is stamped `dry_run`: reads taken before dry run was removed. Nothing new
  is stamped, so only such a pass is never sent; every other `pack` waits to
  be sent (`send_state = 'pending'`).
- Off a Dock setup, or without a move, the cursor jumps to the newest read,
  so reads taken as another station type never land in a pass later.
- A setup-move read whose sync data isn't cached yet stops the tick WITHOUT
  advancing the cursor, like the scan processor; the next tick tries again.

Each tick's writes and its cursor move are one transaction. Everything here
is synchronous and short, and never touches the network."""

import uuid
from bisect import bisect_left
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import NamedTuple

from edge import laptop_setup
from edge.db import Store, iso, now_iso
from edge.dock import state
from edge.rfid import processing, station_key

INTERVAL_S = 1.0
BATCH = 500
_IDLE_SLACK = timedelta(seconds=1)   # received_at's resolution
# the read times a burst can be decided from: one outside them would overflow
# its settle time (up to 2W on) or a window's `anchor - W`, roll the tick back
# and stall the cursor for good
_EDGE = timedelta(seconds=2 * state.WINDOW_S) + _IDLE_SLACK
_EARLIEST = datetime.min.replace(tzinfo=UTC) + _EDGE
_LATEST = datetime.max.replace(tzinfo=UTC) - _EDGE

# match kind -> the index its item is in (off-move matches carry their item)
_SOURCES = {"asset": "assets", "container": "containers", "person": "people"}


class GroupResult(NamedTuple):
    scanned: int    # raw reads taken in (0 off a Dock setup: the cursor just jumps)
    closed: int     # passes decided (one burst can decide several)
    to_send: int    # of those, live packs now waiting to be sent
    waiting: bool   # stopped at a setup-move read whose data isn't cached


@dataclass
class _Burst:
    """The open burst while a tick works on it. Read-derived times are kept
    as datetimes, `*_received_at` as `db.iso` strings (they compare as is)."""
    id: int
    last_new_at: datetime
    last_new_received_at: str
    last_received_at: str
    epcs: set[str]
    last_crate_at: datetime | None = None   # the newest crate tag's first read
    changed: bool = False


@dataclass
class _Split:
    """One pass a burst is decided into: a crate group, anchored at its
    earliest crate's first read, or the leftover (no anchor)."""
    anchor: tuple[datetime, str] | None   # (that read's time, its received_at)
    tags: list = field(default_factory=list)
    reads: list = field(default_factory=list)   # (read time, raw read)

    @property
    def opened(self) -> datetime:
        return min(t for t, _ in self.reads)


def _utc(value: datetime) -> datetime:
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


def _stamp(value: datetime) -> str:
    """A read-derived time as stored: UTC ISO with milliseconds."""
    return value.isoformat(timespec="milliseconds")


def read_time(raw) -> datetime:
    """When the reader read it: `read_at` (the reader's `...22.512+0000` form
    included, no offset read as UTC) in UTC, else its `received_at` when
    `read_at` is missing, unparseable or too close to either end of time to
    decide a burst from."""
    value = raw["read_at"]
    if isinstance(value, str):
        try:
            parsed = _utc(datetime.fromisoformat(value))
        except (ValueError, OverflowError):
            parsed = None
        if parsed is not None and _EARLIEST <= parsed <= _LATEST:
            return parsed
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


def _open_burst(c) -> _Burst | None:
    """The open burst, if any: always the newest row (a burst opens only once
    the one before it has been decided into its passes)."""
    row = c.execute("SELECT id, closed_at, last_new_at, last_new_received_at, last_received_at "
                    "FROM dock_passes ORDER BY id DESC LIMIT 1").fetchone()
    if row is None or row["closed_at"] is not None:
        return None
    tags = c.execute("SELECT epc, kind, first_read_at FROM dock_pass_tags WHERE pass_id = ?",
                     (row["id"],)).fetchall()
    crates = [datetime.fromisoformat(t["first_read_at"]) for t in tags
              if t["kind"] == "container"]
    return _Burst(row["id"], datetime.fromisoformat(row["last_new_at"]),
                  row["last_new_received_at"], row["last_received_at"],
                  {t["epc"] for t in tags}, max(crates, default=None))


def _open(c, move: str, t: datetime, raw) -> _Burst:
    received = iso(raw["received_at"])
    pid = c.execute(
        "INSERT INTO dock_passes (pass_id, initiative_id, opened_at, last_new_at, "
        "last_new_received_at, last_received_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (str(uuid.uuid4()), move, _stamp(t), _stamp(t), received, received,
         now_iso())).lastrowid
    return _Burst(pid, t, received, received, set())


def _add(c, b: _Burst, raw, t: datetime, indexes: dict[str, dict[str, dict]]) -> None:
    """Link one read to the open burst. Only a tag new to the burst is
    classified and moves the burst's last new read (and, for a crate, its
    newest crate read) on."""
    received = iso(raw["received_at"])
    if raw["epc"] not in b.epcs:
        kind, matched_id, label = classify(indexes, raw["epc"])
        c.execute("INSERT INTO dock_pass_tags (pass_id, epc, kind, matched_id, label, "
                  "first_read_at) VALUES (?, ?, ?, ?, ?, ?)",
                  (b.id, raw["epc"], kind, matched_id, label, _stamp(t)))
        b.epcs.add(raw["epc"])
        b.last_new_at = max(b.last_new_at, t)
        b.last_new_received_at = received
        if kind == "container":
            b.last_crate_at = t if b.last_crate_at is None else max(b.last_crate_at, t)
    c.execute("INSERT OR IGNORE INTO dock_pass_reads (pass_id, raw_read_id) VALUES (?, ?)",
              (b.id, raw["id"]))
    b.last_received_at = max(b.last_received_at, received)
    b.changed = True


def _save(c, b: _Burst) -> None:
    c.execute("UPDATE dock_passes SET last_new_at = ?, last_new_received_at = ?, "
              "last_received_at = ? WHERE id = ?",
              (_stamp(b.last_new_at), b.last_new_received_at, b.last_received_at, b.id))


def settle(b: _Burst, w: timedelta) -> datetime:
    """When the burst is decided, on the reader's clock: 2W after its newest
    crate's first read, or W after its newest new tag's when that is later
    or it holds no crate. A crate's first read here is the first one taken
    in: an earlier read of it taken in later only makes the true anchor
    earlier, so this is never early."""
    end = b.last_new_at + w
    return end if b.last_crate_at is None else max(b.last_crate_at + 2 * w, end)


def _near(times: list[datetime], at: datetime, w: timedelta) -> bool:
    """Whether any of the sorted `times` is within `w` of `at` (inclusive)."""
    i = bisect_left(times, at - w)
    return i < len(times) and times[i] <= at + w


def crate_windows(times: list[datetime], anchors: list[datetime], w: timedelta) -> list[int]:
    """The crate windows that hold a tag, as indexes into `anchors` (the
    crates' first reads, sorted): those within `w` of one of its sorted read
    `times`, inclusive. Also what the Dock screen's open pass shows."""
    return [i for i, a in enumerate(anchors) if _near(times, a, w)]


def crate_groups(anchors: list[datetime], hits: Iterable[list[int]], w: timedelta) -> list[int]:
    """Each anchor's crate group, as the index of the group's earliest
    anchor: anchors within 2W of the next chain into one group, and an asset
    whose windows (`hits`, from `crate_windows`) span several merges them."""
    root = list(range(len(anchors)))   # union-find: a group's root is its earliest anchor

    def find(i: int) -> int:
        while root[i] != i:
            i = root[i]
        return i

    def join(i: int, j: int) -> None:
        i, j = find(i), find(j)
        root[max(i, j)] = min(i, j)

    for i in range(1, len(anchors)):   # crates chained within 2W: one group
        if anchors[i] - anchors[i - 1] <= 2 * w:
            join(i - 1, i)
    for found in hits:                 # an asset in several groups merges them
        for i in found[1:]:
            join(found[0], i)
    return [find(i) for i in range(len(anchors))]


def _split(tags, reads: dict[str, list], w: timedelta) -> list[_Split]:
    """The burst's tags as the passes it is decided into, in the order they
    are written: by first read, a crate group before the leftover on a tie.
    `reads` holds each tag's (read time, raw read) pairs."""
    times = {epc: sorted(t for t, _ in rs) for epc, rs in reads.items()}
    anchors = []   # (first read time, its received_at, crate epc), in anchor order
    for tag in tags:
        if tag["kind"] == "container":
            t, raw = min(reads[tag["epc"]], key=lambda r: r[0])
            anchors.append((t, iso(raw["received_at"]), tag["epc"]))
    anchors.sort(key=lambda a: a[0])
    starts = [a for a, _, _ in anchors]
    index = {epc: i for i, (_, _, epc) in enumerate(anchors)}
    hits = {tag["epc"]: crate_windows(times[tag["epc"]], starts, w)
            for tag in tags if tag["kind"] == "asset"}
    root = crate_groups(starts, hits.values(), w)
    groups = {r: _Split(anchors[r][:2]) for r in sorted(set(root))}
    left = _Split(None)
    for tag in tags:
        epc = tag["epc"]
        if tag["kind"] == "container":
            found = [index[epc]]
        elif tag["kind"] == "asset":
            found = hits[epc]
        else:   # people, off-move, unknown: never merge, join the earliest group
            found = crate_windows(times[epc], starts, w)
        g = groups[min(root[i] for i in found)] if found else left
        g.tags.append(tag)
        g.reads.extend(reads[epc])
    out = list(groups.values()) + ([left] if left.tags else [])
    return sorted(out, key=lambda g: (g.opened, g.anchor is None))


def _decide(c, b: _Burst, w_s: int) -> tuple[int, int]:
    """Decide the burst: split it into its passes and close each with its
    outcome. The burst's row becomes the first pass, the rest are inserted
    after it, and each tag moves with every read of it. (passes decided,
    live packs among them now waiting to be sent)."""
    w = timedelta(seconds=w_s)
    tags = c.execute("SELECT epc, kind, matched_id, label FROM dock_pass_tags "
                     "WHERE pass_id = ? ORDER BY rowid", (b.id,)).fetchall()
    reads: dict[str, list] = {}
    for r in c.execute("SELECT r.id, r.epc, r.read_at, r.received_at, r.dry_run "
                       "FROM dock_pass_reads pr JOIN raw_tag_reads r ON r.id = pr.raw_read_id "
                       "WHERE pr.pass_id = ? ORDER BY r.id", (b.id,)):
        reads.setdefault(r["epc"], []).append((read_time(r), r))
    split = _split(tags, reads, w)
    _save(c, b)   # the burst's own columns, copied to every pass below
    sends = 0
    for n, g in enumerate(split):
        pid = b.id
        if n:
            pid = c.execute(
                "INSERT INTO dock_passes (pass_id, initiative_id, opened_at, last_new_at, "
                "last_new_received_at, last_received_at, created_at) "
                "SELECT ?, initiative_id, opened_at, last_new_at, last_new_received_at, "
                "last_received_at, ? FROM dock_passes WHERE id = ?",
                (str(uuid.uuid4()), now_iso(), b.id)).lastrowid
            c.executemany("UPDATE dock_pass_tags SET pass_id = ? WHERE pass_id = ? AND epc = ?",
                          [(pid, b.id, tag["epc"]) for tag in g.tags])
            c.executemany("UPDATE dock_pass_reads SET pass_id = ? "
                          "WHERE pass_id = ? AND raw_read_id = ?",
                          [(pid, b.id, raw["id"]) for _, raw in g.reads])
        crates = {t["matched_id"]: t["label"] for t in g.tags if t["kind"] == "container"}
        assets = {t["matched_id"] for t in g.tags if t["kind"] == "asset"}
        crate_id = crate_name = anchor_at = anchor_received_at = None
        if g.anchor is None:
            outcome = "no_crate" if assets else "nothing"
            closed = b.last_new_at + w
        else:
            anchor, anchor_received_at = g.anchor
            anchor_at, closed = _stamp(anchor), anchor + w
            if len(crates) > 1:
                outcome = "many_crates"
            else:
                outcome = "pack" if assets else "nothing"
                [(crate_id, crate_name)] = crates.items()
        dry_run = any(raw["dry_run"] for _, raw in g.reads)
        send = outcome == "pack" and not dry_run
        sends += send
        c.execute("UPDATE dock_passes SET opened_at = ?, closed_at = ?, quiet_gap_s = ?, "
                  "dry_run = ?, outcome = ?, container_id = ?, container_name = ?, "
                  "asset_count = ?, send_state = ?, anchor_at = ?, anchor_received_at = ? "
                  "WHERE id = ?",
                  (_stamp(g.opened), _stamp(closed), w_s, int(dry_run), outcome, crate_id,
                   crate_name, len(assets), "pending" if send else "none", anchor_at,
                   anchor_received_at, pid))
    return len(split), sends


def group(store: Store, now: datetime | None = None, *, decide: bool = False) -> GroupResult:
    """One tick: at most BATCH raw reads after the cursor into bursts (each
    one that ends decided into its passes), then the idle decision of a
    burst nothing more has been read for. With `decide`, a tick that read
    everything available decides the open burst at once, idle or not."""
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
        w_s = state.WINDOW_S
        w = timedelta(seconds=w_s)
        rows = c.execute("SELECT id, epc, read_at, received_at, initiative_id "
                         "FROM raw_tag_reads WHERE id > ? ORDER BY id LIMIT ?",
                         (last, BATCH)).fetchall()
        current = _open_burst(c)
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
                if current is not None and t > settle(current, w):
                    decided, sends = _decide(c, current, w_s)
                    closed, to_send, current = closed + decided, to_send + sends, None
                if current is None:
                    current = _open(c, move, t, raw)
                _add(c, current, raw, t, move_indexes)
            advanced = raw["id"]   # another move's read (or none) is skipped
            scanned += 1
        if current is not None:
            idle_at = (datetime.fromisoformat(current.last_new_received_at)
                       + (settle(current, w) - current.last_new_at) + _IDLE_SLACK)
            if not waiting and len(rows) < BATCH and (decide or now >= idle_at):
                decided, sends = _decide(c, current, w_s)
                closed, to_send = closed + decided, to_send + sends
            elif current.changed:
                _save(c, current)
        if advanced != last:
            _set_cursor(c, advanced)
    return GroupResult(scanned, closed, to_send, waiting)


def decide_now(store: Store, now: datetime | None = None) -> GroupResult:
    """The Dock screen's Stop: `group` with `decide`, tick after tick, until
    one is not a full batch (the backlog grouped, then the open burst decided
    with what has been read) or is waiting (the burst stays open). Each tick
    is its own transaction. The counts are summed; `waiting` is the last
    tick's."""
    scanned = closed = to_send = 0
    while True:
        result = group(store, now, decide=True)
        scanned, closed, to_send = (scanned + result.scanned, closed + result.closed,
                                    to_send + result.to_send)
        if result.scanned < BATCH or result.waiting:
            return GroupResult(scanned, closed, to_send, result.waiting)
