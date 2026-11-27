"""Runs on disk that began and never finished: their summary for the page, and ending one."""

from __future__ import annotations

import json
from pathlib import Path

from .clock import Clock
from .connection import RunnerError, log
from .journal import Journal, find_unfinished, load_state


def last_at(path: Path) -> float | None:
    """The `at` of the journal's last readable entry."""
    last = None
    for raw in path.read_bytes().split(b"\n"):
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if isinstance(entry, dict) and isinstance(entry.get("at"), (int, float)):
            last = float(entry["at"])
    return last


class UnfinishedRuns:
    def __init__(self, runs_dir: Path, clock: Clock) -> None:
        self.runs_dir = Path(runs_dir)
        self.clock = clock
        self._cache: tuple[tuple, dict | None] | None = None
        self._logged: set[str] = set()

    def find(self) -> Path | None:
        return find_unfinished(self.runs_dir)

    def forget_cache(self) -> None:
        self._cache = None

    def summary(self) -> dict | None:
        """The newest unfinished run on disk, or None."""
        try:
            path = find_unfinished(self.runs_dir)
            if path is None:
                return None
            stat = path.stat()
        except OSError:
            return None
        key = (str(path), stat.st_mtime_ns, stat.st_size)
        if self._cache is not None and self._cache[0] == key:
            return self._cache[1]
        try:
            state = load_state(path)
            last = state.profile_raw["stage"][-1]["key"]
            summary = {
                "run_dir": str(path.parent), "server": state.server_url,
                "move_name": state.move_name, "speed": state.profile_name,
                "started_at": state.started_at, "servers": len(state.servers),
                "done": sum(last in s.done for s in state.servers.values()),
            }
        except Exception as exc:   # noqa: BLE001 - a damaged journal is reported as none
            if str(path) not in self._logged:
                self._logged.add(str(path))
                log(f"could not read the unfinished run's journal {path}", exc)
            summary = None
        self._cache = (key, summary)
        return summary

    def mark_finished(self, path: Path, reason: str) -> None:
        try:
            journal = Journal(path)
            try:
                journal.append({"t": "run_finished", "reason": reason, "at": self.clock.now()})
            finally:
                journal.close()
        except OSError:
            raise RunnerError("cannot_write") from None
        self._cache = None
