"""Previous results: the finished runs saved in the runs folder.

A run is listed once its folder holds results.json (written when the run ends). Nothing
here is ever written or removed: the folders are only read.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .results import RESULTS_FILE

# the names Runner gives its run folders: the start time, then -2, -3… for a same-second run
RUN_NAME = re.compile(r"\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}Z(?:-\d{1,3})?")
_TEXT = ("server_url", "move_name", "profile", "started_at", "ended_at")
_COUNTS = ("servers", "containers", "trucks")


def _load(path: Path) -> dict | None:
    """The saved result, or None when the file is missing, unreadable or not a result."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if (not isinstance(data, dict) or not isinstance(data.get("run"), dict)
            or not isinstance(data.get("verdict"), str)):
        return None
    return data


def _summary(run_id: str, result: dict) -> dict:
    run = result["run"]
    line: dict = {"id": run_id, "verdict": result["verdict"]}
    for name in _TEXT:
        line[name] = run[name] if isinstance(run.get(name), str) else None
    for name in _COUNTS:
        value = run.get(name)
        line[name] = value if isinstance(value, int) and not isinstance(value, bool) else None
    return line


class History:
    """Reads the runs folder. A result file is read again only after it changed."""

    def __init__(self, runs_dir: Path) -> None:
        self.runs_dir = Path(runs_dir)
        self._seen: dict[str, tuple[tuple[int, int], dict | None]] = {}

    def list(self) -> list[dict]:
        """One line per finished run, newest first. A folder with no result file (a run
        still going, or one that never ended) and a file that is not a result are left out."""
        try:
            names = sorted((p.name for p in self.runs_dir.iterdir()
                            if RUN_NAME.fullmatch(p.name)), reverse=True)
        except OSError:
            return []
        lines = []
        seen: dict[str, tuple[tuple[int, int], dict | None]] = {}
        for name in names:
            path = self.runs_dir / name / RESULTS_FILE
            try:
                stat = path.stat()
            except OSError:
                continue
            key = (stat.st_mtime_ns, stat.st_size)
            kept = self._seen.get(name)
            if kept is None or kept[0] != key:
                result = _load(path)
                kept = (key, None if result is None else _summary(name, result))
            seen[name] = kept
            if kept[1] is not None:
                lines.append(dict(kept[1]))
        self._seen = seen
        return lines

    def read(self, run_id: str) -> dict | None:
        """`{"id", "run_dir", "result"}` for one finished run, or None when there is no such
        result. Only a run folder's own name is accepted, never a path."""
        if not isinstance(run_id, str) or not RUN_NAME.fullmatch(run_id):
            return None
        folder = self.runs_dir / run_id
        result = _load(folder / RESULTS_FILE)
        if result is None:
            return None
        return {"id": run_id, "run_dir": str(folder), "result": result}
