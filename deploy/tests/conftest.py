"""Shared helpers for the deploy-stack tests.

Run with the main checkout's interpreter (the worktree has no venv):
    $PY -m pytest -c deploy/pytest.ini deploy/tests
The worktree's api/src goes first on sys.path so settings tests import
this checkout's serversherpa, not the main checkout's editable install.
"""
from __future__ import annotations

import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
STACK_DIR = REPO / "deploy" / "stack"
ENV_EXAMPLE = STACK_DIR / "env.example"
SS_STACK = STACK_DIR / "ss-stack"
README = STACK_DIR / "README.md"

sys.path.insert(0, str(REPO / "api" / "src"))


def docker_cli_ok() -> bool:
    return shutil.which("docker") is not None


def docker_daemon_ok() -> bool:
    if not docker_cli_ok():
        return False
    return subprocess.run(["docker", "info"], capture_output=True).returncode == 0


def build_image(dockerfile: str, tag: str) -> None:
    subprocess.run(["docker", "build", "-f", dockerfile, "-t", tag, "."],
                   cwd=REPO, check=True)


def docker_run(tag: str, *cmd: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["docker", "run", "--rm", tag, *cmd],
                          capture_output=True, text=True)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float = 60.0) -> int:
    deadline = time.monotonic() + timeout
    last: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                return resp.status
        except urllib.error.HTTPError as exc:
            return exc.code
        except (urllib.error.URLError, ConnectionError, OSError) as exc:
            last = exc
            time.sleep(1)
    raise TimeoutError(f"{url} not answering after {timeout}s: {last}")


def readme_restore_commands() -> list[str]:
    """The README's rollback restore step, one shell command per entry
    (continuation lines joined), exactly as an operator would paste it."""
    lines = README.read_text().splitlines()
    start = next(i for i, line in enumerate(lines) if "Restore the pre-deploy dump" in line)
    fence = next(i for i in range(start, len(lines)) if lines[i].strip().startswith("```"))
    end = next(i for i in range(fence + 1, len(lines)) if lines[i].strip().startswith("```"))
    commands: list[str] = []
    current = ""
    for raw in lines[fence + 1:end]:
        line = raw.strip()
        if not line:
            continue
        current += line[:-1].rstrip() + " " if line.endswith("\\") else line
        if not line.endswith("\\"):
            commands.append(current)
            current = ""
    return commands
