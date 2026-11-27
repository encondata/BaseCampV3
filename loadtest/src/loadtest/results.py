"""results.json: the run's facts, verdict, findings, call table and every sample.

Never a password, token or key: `build_results` refuses a result holding any secret
it is given.
"""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

from .finalcheck import FinalReport
from .metrics import Metrics
from .profile import Profile
from .state import RunState

RESULTS_FILE = "results.json"


def _iso(t: float | None) -> str | None:
    return None if t is None else datetime.fromtimestamp(t, UTC).isoformat()


def _strings(value) -> Iterable[str]:
    """Every string in a nested result, dictionary keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for k, v in value.items():
            if isinstance(k, str):
                yield k
            yield from _strings(v)
    elif isinstance(value, (list, tuple)):
        for v in value:
            yield from _strings(v)


def _refuse_secrets(result: dict, secrets: Iterable[str]) -> None:
    wanted = [s for s in secrets if s]
    if not wanted:
        return
    for text in _strings(result):
        if any(s in text for s in wanted):
            raise ValueError("the result holds a secret; it was not written")


def build_results(*, state: RunState, profile: Profile, metrics: Metrics,
                  report: FinalReport | None, catch_up_seconds: float | None, ended_at: float,
                  reason: str, secrets: Iterable[str] = frozenset()) -> dict:
    """`report` is None when the run ended in an error before the final check."""
    waiting = [v for _, v in metrics.series().get("waiting", [])]
    if report is None:
        verdict = "Fail"
        findings = [{"level": "fail",
                     "text": f"The run ended before the final check could run: {reason}."}]
        scans = {"sent": None, "processed": None, "processed_twice": None,
                 "never_processed": None, "container_scans_sent": None,
                 "container_scans_checked": False}
        delay = {"median": None, "p95": None, "max": None}
    else:
        verdict = report.verdict
        findings = [{"level": f.level, "text": f.text} for f in report.findings]
        scans = {"sent": report.scans_sent, "processed": report.scans_processed,
                 "processed_twice": report.scans_twice, "never_processed": report.scans_missing,
                 "container_scans_sent": report.container_scans_sent,
                 "container_scans_checked": report.container_scans_checked}
        delay = dict(report.delay_ms)
    result = {
        "run": {
            "server_url": state.server_url,
            "move_id": state.move_id,
            "move_name": state.move_name,
            "servers": len(state.servers),
            "containers": len(state.containers),
            "trucks": len(state.trucks),
            "profile": state.profile_name,
            "profile_raw": state.profile_raw,
            "started_at": _iso(state.started_at),
            "ended_at": _iso(ended_at),
            "reason": reason,
            "interruptions": [{"stopped_at": _iso(stopped), "resumed_at": _iso(resumed)}
                              for stopped, resumed in state.interruptions],
        },
        "verdict": verdict,
        "findings": findings,
        "calls": metrics.calls(),
        "counters": metrics.counters(),
        "scans": scans,
        "scan_delay_ms": delay,
        "backlog": {"peak": max(waiting, default=0), "catch_up_seconds": catch_up_seconds},
        "series": metrics.series(),
    }
    _refuse_secrets(result, secrets)
    return result


def write_results(run_dir: Path, results: dict) -> Path:
    """Pretty, sorted JSON, written whole or not at all (temp file, then replace)."""
    run_dir = Path(run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)
    text = json.dumps(results, indent=2, sort_keys=True, allow_nan=False) + "\n"
    path = run_dir / RESULTS_FILE
    fd, tmp = tempfile.mkstemp(dir=run_dir, prefix=".results-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return path
