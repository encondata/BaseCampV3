#!/usr/bin/env python3
"""The orchestrator's only way to write factory/board.json.

  board.py add <id> "<title>"          new job, stage=spec
  board.py set <id> key=value …        set fields (stage, round, note, builder, …)
  board.py review <id> <key> <verdict> one reviewer chip: PASS | CHANGES | pending
  board.py next-round <id>             archive chips, round+1, fixes+1, stage=build
  board.py rework <id>                 human rework: archive chips, round+1, fixes=0
  board.py show <id>                   print one job

Writes are locked and atomic, so the dashboard never reads a half-written file.
"""
import fcntl
import json
import os
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

BOARD = Path(__file__).with_name("board.json")
REVIEWERS = ("security", "ux", "ui", "code")
STAGES = ("spec", "build", "review", "approve", "needs-human", "merged")
VERDICTS = ("PASS", "CHANGES", "pending")
COMMANDS = ("add", "set", "review", "next-round", "rework", "show")
NUMBERS = ("round", "fixes", "reworks")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def pending() -> dict:
    return {r: "pending" for r in REVIEWERS}


def find(board: dict, job_id: str) -> dict:
    for job in board["jobs"]:
        if job["id"] == job_id:
            return job
    sys.exit(f"no job {job_id!r} on the board")


def archive_round(job: dict) -> None:
    job.setdefault("history", []).append(job["reviews"])
    job["reviews"] = pending()
    job["round"] += 1
    job["stage"] = "build"


def apply(board: dict, cmd: str, args: list[str]) -> dict | None:
    if cmd == "add":
        job_id, title = args
        if any(j["id"] == job_id for j in board["jobs"]):
            sys.exit(f"job {job_id!r} already exists")
        job = {"id": job_id, "title": title, "branch": f"factory/{job_id}",
               "worktree": f".claude/worktrees/factory-{job_id}",
               "stage": "spec", "round": 0, "reviews": pending(), "history": [],
               "fixes": 0, "reworks": 0, "note": "", "created": now()}
        board["jobs"].append(job)
        return job
    job = find(board, args[0])
    if cmd == "set":
        for pair in args[1:]:
            key, _, value = pair.partition("=")
            if key == "stage" and value not in STAGES:
                sys.exit(f"stage must be one of {STAGES}")
            job[key] = int(value) if key in NUMBERS else value
    elif cmd == "review":
        key, verdict = args[1], args[2]
        if key not in REVIEWERS or verdict not in VERDICTS:
            sys.exit(f"reviewer in {REVIEWERS}, verdict in {VERDICTS}")
        job["reviews"][key] = verdict
    elif cmd == "next-round":
        archive_round(job)
        job["fixes"] += 1
    elif cmd == "rework":
        archive_round(job)
        job["fixes"] = 0
        job["reworks"] += 1
    return job


def main() -> None:
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd not in COMMANDS:
        sys.exit(__doc__)
    with open(BOARD.with_suffix(".lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        board = json.loads(BOARD.read_text()) if BOARD.exists() else {"jobs": []}
        job = apply(board, cmd, args)
        if cmd != "show":
            job["updated"] = board["updated"] = now()
            fd, tmp = tempfile.mkstemp(dir=BOARD.parent, suffix=".tmp")
            with os.fdopen(fd, "w") as f:
                json.dump(board, f, indent=2)
                f.write("\n")
            os.chmod(tmp, 0o644)
            os.replace(tmp, BOARD)
    print(json.dumps(job, indent=2))


if __name__ == "__main__":
    main()
