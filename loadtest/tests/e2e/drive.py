"""Drives a running load test tool through its own HTTP API, as the page does, against
the scratch server.

    .venv/bin/python tests/e2e/drive.py check MOVE_ID [--speed fast] [--password-of OTHER_ID]
    .venv/bin/python tests/e2e/drive.py run MOVE_ID [--speed fast] [--no-wait]
    .venv/bin/python tests/e2e/drive.py wait
    .venv/bin/python tests/e2e/drive.py state
    .venv/bin/python tests/e2e/drive.py stop
    .venv/bin/python tests/e2e/drive.py continue MOVE_ID

The tool must be listening on http://127.0.0.1:8795 (start it with `--host 127.0.0.1`).
Passwords are read from LOADTEST_SCRATCH_DIR (admin-password, moves/<id>.password),
sent only to the tool, and never printed.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

import httpx

TOOL = "http://127.0.0.1:8795"
SERVER = "http://127.0.0.1:8010"
ADMIN_EMAIL = "loadtest-admin@example.com"
SCRATCH = Path(os.environ.get("LOADTEST_SCRATCH_DIR")
               or Path(tempfile.gettempdir()) / "loadtest-scratch").resolve()
ACTIVE = ("starting", "running", "finishing")


def secret(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip()


def move_password(move_id: str) -> str:
    return secret(SCRATCH / "moves" / f"{move_id}.password")


class Tool:
    def __init__(self) -> None:
        self.http = httpx.Client(base_url=TOOL, timeout=120,
                                 headers={"X-Loadtest": "1"})

    def post(self, path: str, body: dict | None = None) -> tuple[int, dict]:
        r = self.http.post(path, json=body or {})
        return r.status_code, (r.json() if r.content else {})

    def state(self) -> dict:
        return self.http.get("/api/state").json()


def connect(tool: Tool) -> dict:
    status, body = tool.post("/api/connect", {
        "server": SERVER, "email": ADMIN_EMAIL, "password": secret(SCRATCH / "admin-password")})
    if status != 200:
        sys.exit(f"connect: {status} {body}")
    return body


def check(tool: Tool, move_id: str, speed: str, password_of: str | None = None,
          password: str | None = None) -> dict:
    connect(tool)
    status, body = tool.post("/api/check", {
        "move_id": move_id, "speed": speed,
        "move_password": password if password is not None
        else move_password(password_of or move_id)})
    if status != 200:
        sys.exit(f"check: {status} {body}")
    for line in body["checks"]:
        print(f"  {line['status']:5} {line['label']}: {line['detail']}")
    print(f"  can_start={body['can_start']} summary={body['summary']}")
    return body


def progress_line(state: dict) -> str:
    overall = state.get("overall") or {}
    server = state.get("server") or {}
    return (f"{time.strftime('%H:%M:%S')} {state['phase']:9} "
            f"{overall.get('done')}/{overall.get('total')} complete "
            f"({overall.get('percent', 0):.0f}%) waiting={server.get('waiting')} "
            f"peak={server.get('waiting_peak')} failed={server.get('failed_calls')} "
            f"elapsed={state.get('elapsed')}")


def wait(tool: Tool, every: float = 10) -> dict:
    while True:
        state = tool.state()
        print(progress_line(state), flush=True)
        if state["phase"] not in ACTIVE and not state.get("stopping"):
            return state
        time.sleep(every)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("check", "run"):
        p = sub.add_parser(name)
        p.add_argument("move_id")
        p.add_argument("--speed", default="fast", choices=("fast", "real-time"))
        if name == "check":
            p.add_argument("--password-of", metavar="OTHER_MOVE_ID",
                           help="send another move's password")
            p.add_argument("--wrong-password", action="store_true",
                           help="send a password no move has")
        else:
            p.add_argument("--no-wait", action="store_true")
    sub.add_parser("wait")
    sub.add_parser("state")
    sub.add_parser("stop")
    p = sub.add_parser("continue")
    p.add_argument("move_id")
    args = parser.parse_args()
    tool = Tool()

    if args.command == "check":
        check(tool, args.move_id, args.speed, args.password_of,
              "not-the-password-1" if args.wrong_password else None)
    elif args.command == "run":
        if not check(tool, args.move_id, args.speed)["can_start"]:
            sys.exit("the readiness check did not pass")
        status, body = tool.post("/api/start")
        if status != 202:
            sys.exit(f"start: {status} {body}")
        print(f"started; run folder {tool.state().get('run_dir')}", flush=True)
        if not args.no_wait:
            final = wait(tool)
            print(json.dumps(final.get("verdict"), indent=1))
    elif args.command == "wait":
        final = wait(tool)
        print(json.dumps(final.get("verdict"), indent=1))
    elif args.command == "state":
        print(json.dumps(tool.state(), indent=1))
    elif args.command == "stop":
        print(tool.post("/api/stop"))
    elif args.command == "continue":
        status, body = tool.post("/api/continue", {
            "email": ADMIN_EMAIL, "password": secret(SCRATCH / "admin-password"),
            "move_password": move_password(args.move_id)})
        print(status, body, flush=True)


if __name__ == "__main__":
    main()
