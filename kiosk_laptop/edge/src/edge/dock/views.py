"""What the kiosk's Dock screen reads (dock station spec): the overview
(settings, the open pass, the newest closed passes) and one closed pass's
detail (its tags with what packing did, every read behind it).

The open pass is the grouper's open burst, not yet decided into passes,
shown with the grouper's own window test and the move's cached assets.
Plain reads of the edge's own tables; nothing here touches the network or
changes a row. `overview` takes `now` so the open pass's countdown can be
pinned in tests. An open pass has no detail yet (the overview shows it
whole), so `detail` answers None for it, as for an unknown id."""

from datetime import datetime, timedelta

from edge.db import Store
from edge.dock import grouper, state
from edge.rfid import processing

RECENT = 50                          # closed passes the overview lists
FLAGS = ("no_crate", "many_crates")  # the outcomes the screen flags


def _status(row) -> str:
    """The first that applies: `flagged` (no crate or several), `nothing`,
    `would_pack` (a dry run, so nothing was or will be sent), `waiting` (to be
    sent), `packed` (sent) or `refused` (the portal turned it away)."""
    if row["outcome"] in FLAGS:
        return "flagged"
    if row["outcome"] == "nothing":
        return "nothing"
    if row["dry_run"]:
        return "would_pack"
    if row["send_state"] == "pending":
        return "waiting"
    if row["send_state"] == "sent":
        return "packed"
    return "refused"


def _pass_row(row) -> dict:
    """A closed pass as the list and the detail show it."""
    return {"id": row["id"], "opened_at": row["opened_at"], "closed_at": row["closed_at"],
            "status": _status(row),
            "flag": row["outcome"] if row["outcome"] in FLAGS else None,
            "dry_run": bool(row["dry_run"]), "container_name": row["container_name"],
            "asset_count": row["asset_count"], "moved_count": row["moved_count"],
            "refused_count": row["refused_count"], "refuse_code": row["refuse_code"]}


def _distinct(tags, kind: str) -> int:
    """How many different crates or assets the tags matched (as the grouper
    counts them when it decides a pass)."""
    return len({t["matched_id"] for t in tags if t["kind"] == kind})


def _ms(t: datetime) -> str:
    """A read time as the screen gets it: UTC ISO with milliseconds."""
    return t.isoformat(timespec="milliseconds")


def _serial(assets: dict[str, dict], tag) -> str | None:
    """An asset tag's serial number from the move's cached assets, while the
    tag still belongs to the asset it was matched to (a sync can move it)."""
    item = assets.get(tag["epc"])
    if item is None or str(item.get("id")) != tag["matched_id"]:
        return None
    return item.get("serial_number") or None


def _open_pass(store: Store, window_s: int, now: datetime) -> dict | None:
    """The burst still open (always the newest row), with the seconds left
    before it is decided if no new tag is read: 2W after its last new tag.

    It is shown as deciding it now would split it, with the grouper's own
    window test: the crates read so far by first read (their anchors),
    `conflict` when a crate group would be flagged (two crates within 2W, or
    an asset in two of their windows) and `added_count`, the assets in the
    newest crate's window. Each asset tag has its serial, `in_window` (None
    until a crate is read) and the newest crate whose window holds it. The
    same few queries whatever the number of reads."""
    row = store.one("SELECT id, initiative_id, opened_at, last_new_received_at FROM dock_passes "
                    "WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1")
    if row is None:
        return None
    elapsed = (now - datetime.fromisoformat(row["last_new_received_at"])).total_seconds()
    tags = store.all("SELECT epc, kind, label, matched_id FROM dock_pass_tags "
                     "WHERE pass_id = ? ORDER BY rowid", (row["id"],))
    times: dict[str, list[datetime]] = {}   # epc -> its read times, sorted
    for r in store.all("SELECT r.epc, r.read_at, r.received_at FROM dock_pass_reads pr "
                       "JOIN raw_tag_reads r ON r.id = pr.raw_read_id WHERE pr.pass_id = ?",
                       (row["id"],)):
        times.setdefault(r["epc"], []).append(grouper.read_time(r))
    for read_times in times.values():
        read_times.sort()
    w = timedelta(seconds=window_s)
    crates = sorted((t for t in tags if t["kind"] == "container"),
                    key=lambda t: times[t["epc"]][0])
    anchors = [times[t["epc"]][0] for t in crates]
    hits = {t["epc"]: grouper.crate_windows(times[t["epc"]], anchors, w)
            for t in tags if t["kind"] == "asset"}
    groups = grouper.crate_groups(anchors, hits.values(), w)
    newest = len(anchors) - 1
    assets = (processing.indexes(store, row["initiative_id"]) or {}).get("assets", {})
    shown = []
    for t in tags:
        tag = {"epc": t["epc"], "kind": t["kind"], "label": t["label"],
               "first_read_at": _ms(times[t["epc"]][0]),
               "serial": None, "in_window": None, "crate_label": None}
        if t["kind"] == "asset":
            found = hits[t["epc"]]
            tag.update(serial=_serial(assets, t), in_window=bool(found) if anchors else None,
                       crate_label=crates[max(found)]["label"] if found else None)
        shown.append(tag)
    return {"id": row["id"], "opened_at": row["opened_at"],
            "seconds_left": round(max(0.0, 2 * window_s - elapsed), 3),
            "window_s": window_s,
            "crate_count": _distinct(tags, "container"),
            "asset_count": _distinct(tags, "asset"),
            "crates": [{"epc": t["epc"], "label": t["label"], "first_read_at": _ms(a)}
                       for t, a in zip(crates, anchors)],
            "conflict": len(set(groups)) < len(groups),
            "added_count": len({t["matched_id"] for t in tags
                                if t["kind"] == "asset" and newest in hits[t["epc"]]}),
            "tags": shown}


def overview(store: Store, now: datetime) -> dict:
    """The settings, the open pass (or None) and the newest `RECENT` closed
    passes, newest first."""
    settings = state.settings(store)
    closed = store.all("SELECT * FROM dock_passes WHERE closed_at IS NOT NULL "
                       "ORDER BY id DESC LIMIT ?", (RECENT,))
    return {"settings": settings,
            "open": _open_pass(store, settings["quiet_gap_s"], now),
            "passes": [_pass_row(r) for r in closed]}


def detail(store: Store, pass_id: int) -> dict | None:
    """A closed pass with its tags (what packing did with each) and every
    read behind it in id order, or None when `pass_id` isn't a closed pass."""
    row = store.one("SELECT * FROM dock_passes WHERE id = ? AND closed_at IS NOT NULL",
                    (pass_id,))
    if row is None:
        return None
    tags = store.all("SELECT epc, kind, label, result, moved_from, reason FROM dock_pass_tags "
                     "WHERE pass_id = ? ORDER BY rowid", (pass_id,))
    reads = store.all(
        "SELECT r.id, r.read_at, r.received_at, r.epc, r.antenna, r.peak_rssi, t.kind "
        "FROM dock_pass_reads pr JOIN raw_tag_reads r ON r.id = pr.raw_read_id "
        "LEFT JOIN dock_pass_tags t ON t.pass_id = pr.pass_id AND t.epc = r.epc "
        "WHERE pr.pass_id = ? ORDER BY r.id", (pass_id,))
    return {"pass": _pass_row(row),
            "tags": [dict(t) for t in tags],
            "reads": [{"id": r["id"],
                       "read_at": _ms(grouper.read_time(r)),
                       "epc": r["epc"], "kind": r["kind"], "antenna": r["antenna"],
                       "peak_rssi": r["peak_rssi"]} for r in reads]}
