"""What the kiosk's Dock screen reads (dock station spec): the overview
(settings, the open pass, the newest closed passes) and one closed pass's
detail (its tags with what packing did, every read behind it).

Plain reads of the edge's own tables; nothing here touches the network or
changes a row. `overview` takes `now` so the open pass's countdown can be
pinned in tests. An open pass has no detail yet (the overview shows it
whole), so `detail` answers None for it, as for an unknown id."""

from datetime import datetime

from edge.db import Store
from edge.dock import grouper, state

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
    counts them when it closes the pass)."""
    return len({t["matched_id"] for t in tags if t["kind"] == kind})


def _open_pass(store: Store, gap_s: int, now: datetime) -> dict | None:
    """The pass still open (always the newest), with the seconds left before
    it closes if no new tag is read."""
    row = store.one("SELECT id, opened_at, last_new_received_at FROM dock_passes "
                    "WHERE closed_at IS NULL ORDER BY id DESC LIMIT 1")
    if row is None:
        return None
    elapsed = (now - datetime.fromisoformat(row["last_new_received_at"])).total_seconds()
    tags = store.all("SELECT epc, kind, label, matched_id FROM dock_pass_tags "
                     "WHERE pass_id = ? ORDER BY rowid", (row["id"],))
    return {"id": row["id"], "opened_at": row["opened_at"],
            "seconds_left": round(max(0.0, gap_s - elapsed), 3),
            "crate_count": _distinct(tags, "container"),
            "asset_count": _distinct(tags, "asset"),
            "tags": [{"epc": t["epc"], "kind": t["kind"], "label": t["label"]} for t in tags]}


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
                       "read_at": grouper.read_time(r).isoformat(timespec="milliseconds"),
                       "epc": r["epc"], "kind": r["kind"], "antenna": r["antenna"],
                       "peak_rssi": r["peak_rssi"]} for r in reads]}
