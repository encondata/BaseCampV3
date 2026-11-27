"""Runs on disk that began and never finished: their summary for the page, and ending one."""

from __future__ import annotations

import json
import os
from pathlib import Path

from .clock import Clock
from .connection import RunnerError, log
from .journal import Journal, find_unfinished, load_state
from .state import RunState


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


def _stat(path: Path | None) -> tuple | None:
    if path is None:
        return None
    try:
        st = path.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size)


class UnfinishedRuns:
    """`summary()` is polled by every idle snapshot, so it re-reads the journals only when
    the runs folder's listing or the unfinished journal's size or time changed, or after
    `forget_cache()` (this process finished or discarded a run)."""

    def __init__(self, runs_dir: Path, clock: Clock) -> None:
        self.runs_dir = Path(runs_dir)
        self.clock = clock
        # (listing, journal path, its stat, summary)
        self._cache: tuple[tuple, Path | None, tuple | None, dict | None] | None = None
        self._logged: set[str] = set()

    def find(self) -> Path | None:
        return find_unfinished(self.runs_dir)

    def forget_cache(self) -> None:
        self._cache = None

    def load(self, path: Path) -> RunState:
        """The run's state; a journal that cannot be replayed is a damaged run."""
        try:
            return load_state(path)
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            raise RunnerError("damaged_run") from None

    def summary(self) -> dict | None:
        """The newest unfinished run on disk, or None. A run whose journal cannot be
        replayed is `{"run_dir": …, "damaged": True}` (the other keys None), so the page
        can offer to discard it."""
        try:
            listing = tuple(sorted(os.listdir(self.runs_dir)))
        except OSError:
            return None
        if self._cache is not None:
            c_listing, c_path, c_stat, c_summary = self._cache
            if c_listing == listing and _stat(c_path) == c_stat:
                return c_summary
        try:
            path = find_unfinished(self.runs_dir)
        except OSError:
            return None
        summary = None if path is None else self._summarize(path)
        self._cache = (listing, path, _stat(path), summary)
        return summary

    def _summarize(self, path: Path) -> dict:
        try:
            state = load_state(path)
            last = state.profile_raw["stage"][-1]["key"]
            return {
                "run_dir": str(path.parent), "damaged": False, "server": state.server_url,
                "move_name": state.move_name, "speed": state.profile_name,
                "started_at": state.started_at, "servers": len(state.servers),
                "done": sum(last in s.done for s in state.servers.values()),
            }
        except Exception as exc:   # noqa: BLE001 - a damaged journal is reported as damaged
            if str(path) not in self._logged:
                self._logged.add(str(path))
                log(f"could not read the unfinished run's journal {path}", exc)
            return {"run_dir": str(path.parent), "damaged": True, "server": None,
                    "move_name": None, "speed": None, "started_at": None, "servers": None,
                    "done": None}

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
