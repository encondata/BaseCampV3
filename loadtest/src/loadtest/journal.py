"""The run's memory: one JSON line per finished step, replayed after a crash."""

from __future__ import annotations

import json
import os
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from .state import Container, RunState, Server, Truck

JOURNAL_NAME = "journal.jsonl"
SYNC_INTERVAL = 1.0  # seconds between fsyncs


class Journal:
    """Append-only JSON-lines file. Every entry is flushed to the OS as written and
    fsynced to disk at most once a second (and on close), so a power loss costs
    about a second of entries."""

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._repair_torn_tail()
        self._fh = open(self.path, "ab")
        self._last_sync = time.monotonic()

    def _repair_torn_tail(self) -> None:
        """Drop an unreadable last line (torn or garbage, newline or not) so new
        entries never turn it into a damaged middle line."""
        if not self.path.exists():
            return
        data = self.path.read_bytes()
        if not data:
            return
        body = data[:-1] if data.endswith(b"\n") else data
        cut = body.rfind(b"\n") + 1
        if _parse_line(body[cut:]) is None:
            with open(self.path, "r+b") as fh:
                fh.truncate(cut)
        elif not data.endswith(b"\n"):
            with open(self.path, "ab") as fh:  # complete entry, only the newline is missing
                fh.write(b"\n")

    def append(self, entry: dict) -> None:
        if self._fh.closed:
            raise ValueError("journal is closed")
        line = json.dumps(entry, allow_nan=False, separators=(",", ":")) + "\n"
        self._fh.write(line.encode("utf-8"))
        self._fh.flush()
        now = time.monotonic()
        if now - self._last_sync >= SYNC_INTERVAL:
            os.fsync(self._fh.fileno())
            self._last_sync = now

    def close(self) -> None:
        if self._fh.closed:
            return
        self._fh.flush()
        os.fsync(self._fh.fileno())
        self._fh.close()


def _parse_line(raw: bytes) -> dict | None:
    try:
        entry = json.loads(raw)
    except ValueError:  # includes UnicodeDecodeError
        return None
    return entry if isinstance(entry, dict) else None


def start_entry(state: RunState) -> dict:
    """The `run_started` entry: everything needed to rebuild the state alone."""
    parts = urlsplit(state.server_url)
    if parts.username is not None or parts.password is not None:
        raise ValueError("server URL must not carry credentials")
    if parts.query or parts.fragment:
        raise ValueError("server URL must not carry a query or fragment")
    return {
        "t": "run_started",
        "at": state.started_at,
        "run_id": str(state.run_id),
        "server_url": state.server_url,
        "move_id": state.move_id,
        "move_name": state.move_name,
        "profile_name": state.profile_name,
        "profile_raw": state.profile_raw,
        "origin_site_id": state.origin_site_id,
        "destination_site_id": state.destination_site_id,
        "route": [[lat, lng] for lat, lng in state.route],
        "started_at": state.started_at,
        "servers": [{"id": s.id, "serial": s.serial, "tag": s.tag} for s in state.servers.values()],
        "containers": [{"id": c.id, "name": c.name} for c in state.containers.values()],
        "trucks": [{"id": t.id, "name": t.name} for t in state.trucks.values()],
    }


def _state_from_start(e: dict) -> RunState:
    return RunState(
        run_id=uuid.UUID(e["run_id"]),
        server_url=e["server_url"],
        move_id=e["move_id"],
        move_name=e["move_name"],
        profile_name=e["profile_name"],
        profile_raw=e["profile_raw"],
        origin_site_id=e["origin_site_id"],
        destination_site_id=e["destination_site_id"],
        route=[(lat, lng) for lat, lng in e["route"]],
        started_at=e["started_at"],
        servers={s["id"]: Server(s["id"], s["serial"], s["tag"]) for s in e["servers"]},
        containers={c["id"]: Container(c["id"], c["name"]) for c in e["containers"]},
        trucks={t["id"]: Truck(t["id"], t["name"]) for t in e["trucks"]},
    )


def _read_entries(path: Path) -> list[dict]:
    """All entries in order. An unreadable last line (a torn write) is ignored;
    an unreadable line anywhere else means the journal is damaged."""
    lines = Path(path).read_bytes().split(b"\n")
    if lines and not lines[-1].strip():
        lines.pop()
    entries: list[dict] = []
    for i, raw in enumerate(lines):
        entry = _parse_line(raw)
        if entry is None:
            if i == len(lines) - 1:
                break
            raise ValueError(f"{path}: line {i + 1} is not a journal entry")
        entries.append(entry)
    return entries


def load_state(path: Path) -> RunState:
    """Rebuild the run state by replaying the journal."""
    entries = _read_entries(path)
    if not entries or entries[0].get("t") != "run_started":
        raise ValueError(f"{path}: journal does not begin with run_started")
    state = _state_from_start(entries[0])
    for entry in entries[1:]:
        state.apply(entry)
    return state


def find_unfinished(runs_dir: Path) -> Path | None:
    """The newest run's journal that has a run_started and no run_finished."""
    runs_dir = Path(runs_dir)
    if not runs_dir.is_dir():
        return None
    for folder in sorted((p for p in runs_dir.iterdir() if p.is_dir()), reverse=True):
        journal = folder / JOURNAL_NAME
        if not journal.is_file():
            continue
        try:
            entries = _read_entries(journal)
        except (ValueError, OSError):
            continue
        if not entries or entries[0].get("t") != "run_started":
            continue
        if entries[-1].get("t") == "run_finished":
            continue
        return journal
    return None
