"""A whole environment on this machine: build every image, start every
stack, check every service answers and every worker stays up, dump the
database, tear it all down. Opt-in (minutes, real containers):

    SS_STACK_E2E=1 $PY -m pytest -c deploy/pytest.ini deploy/tests -m e2e -s

Ports sit in the 18xxx/19xxx range so the Mac dev stack (8000, 8025,
9000, ...) can keep running alongside.
"""
from __future__ import annotations

import base64
import os
import secrets
import subprocess
import sys
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from conftest import REPO, SS_STACK, docker_daemon_ok, wait_http

OPTED_IN = os.environ.get("SS_STACK_E2E") == "1"

pytestmark = [
    pytest.mark.e2e,
    pytest.mark.skipif(not OPTED_IN, reason="set SS_STACK_E2E=1"),
    # only probe the daemon when opted in, so plain collection stays fast
    pytest.mark.skipif(OPTED_IN and not docker_daemon_ok(), reason="Docker daemon not available"),
]

PORTS = {"API": 18000, "PORTAL": 18091, "KIOSK": 18090, "WIKI": 18096,
         "SPACES": 19000, "STATUS": 18095, "MAILPIT": 18025}
# which stack and Compose service answers on each published port
OWNERS = {"API": ("api", "api"), "PORTAL": ("web", "portal"), "KIOSK": ("web", "kiosk"),
          "WIKI": ("web", "wiki"), "SPACES": ("storage", "minio"),
          "STATUS": ("status", "status"), "MAILPIT": ("storage", "mailpit")}
SERVICES = {"api", "import-worker", "log-service", "notification-worker",
            "scan-matching-worker", "report-worker", "label-worker",
            "spec-lookup-worker", "db-testing-worker", "wiki-worker", "wiki-export-worker"}
# a migrated schema dumps to hundreds of KB; an empty database is ~1 KB
MIN_DUMP_BYTES = 10_000


def ss(*args: str, timeout: int = 900) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", str(SS_STACK), *args], capture_output=True,
                          text=True, timeout=timeout)


def compose(env_dir: Path, stack: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["docker", "compose", "--env-file", str(env_dir / ".env"),
         "-f", str(REPO / f"deploy/stack/{stack}/compose.yml"), *args],
        capture_output=True, text=True)


def service_logs(env_dir: Path, stack: str, service: str, lines: int = 40) -> str:
    """The last few log lines of one service, for failure messages."""
    out = compose(env_dir, stack, "logs", "--no-color", "--tail", str(lines), service)
    return f"--- {stack}/{service} logs ---\n{out.stdout}{out.stderr}"


@pytest.fixture(scope="module")
def env_dir(tmp_path_factory: pytest.TempPathFactory) -> Iterator[Path]:
    d = tmp_path_factory.mktemp("e2e")
    fernet = base64.urlsafe_b64encode(os.urandom(32)).decode()
    lines = [
        "STACK_ENV=e2e", "STACK_DOMAIN=e2e.serversherpa.test", "STACK_IMAGE_TAG=e2e",
        f"STACK_REPO_DIR={REPO}", "STACK_PROXY_IP=127.0.0.1", "STACK_BIND_IP=127.0.0.1",
        *[f"STACK_{k}_PORT={v}" for k, v in PORTS.items()],
        "STACK_KEEP_DUMPS=5",
        f"POSTGRES_PASSWORD={secrets.token_hex(16)}",
        f"MINIO_ROOT_PASSWORD={secrets.token_hex(16)}",
        f"SS_JWT_SECRET={secrets.token_hex(32)}",
        f"SS_TOTP_ENCRYPTION_KEY={fernet}",
        f"SS_PASSWORD_PEPPER={secrets.token_hex(32)}",
        f"SS_WIKI_SERVICE_TOKEN={secrets.token_hex(32)}",
    ]
    (d / ".env").write_text("\n".join(lines) + "\n")
    build = ss("build", str(d), timeout=3600)
    assert build.returncode == 0, build.stdout[-4000:] + build.stderr[-4000:]
    try:
        # inside the try: a hung `up --wait` (TimeoutExpired) must still tear down
        up = ss("up", str(d))
        assert up.returncode == 0, up.stdout[-4000:] + up.stderr[-4000:]
        yield d
    finally:
        # report a failed teardown loudly, but never mask the original failure
        try:
            down = ss("down", str(d), "--volumes")
            if down.returncode != 0:
                print(f"\nss-stack down --volumes FAILED (rc {down.returncode}); "
                      f"ss-e2e containers/volumes may be left behind:\n"
                      f"{down.stdout[-2000:]}{down.stderr[-2000:]}", file=sys.stderr)
        except Exception as exc:  # noqa: BLE001 - teardown must not raise
            print(f"\nss-stack down --volumes did not finish: {exc!r}", file=sys.stderr)


@pytest.mark.parametrize("name,path", [
    ("API", "/healthz"), ("PORTAL", "/"), ("KIOSK", "/"), ("WIKI", "/healthz"),
    ("SPACES", "/minio/health/live"), ("STATUS", "/healthz"), ("MAILPIT", "/"),
])
def test_every_service_answers(env_dir: Path, name: str, path: str) -> None:
    url = f"http://127.0.0.1:{PORTS[name]}{path}"
    try:
        status = wait_http(url, timeout=60)
    except TimeoutError as exc:
        pytest.fail(f"{exc}\n{service_logs(env_dir, *OWNERS[name])}")
    assert status == 200, f"{url} answered {status}\n{service_logs(env_dir, *OWNERS[name])}"


def test_migrations_reached_head(env_dir: Path) -> None:
    out = compose(env_dir, "api", "exec", "-T", "-w", "/app/api", "api", "alembic", "current")
    assert out.returncode == 0, out.stderr
    assert "(head)" in out.stdout


def test_every_worker_stays_up(env_dir: Path) -> None:
    time.sleep(20)   # long enough for a crashing worker to restart at least once
    out = subprocess.run(
        ["docker", "ps", "--filter", "label=com.docker.compose.project=ss-e2e-api",
         "--format", '{{.Label "com.docker.compose.service"}} {{.ID}}'],
        capture_output=True, text=True, check=True)
    rows = dict(line.split() for line in out.stdout.splitlines())
    assert set(rows) == SERVICES
    for service, cid in rows.items():
        state, restarts = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Status}} {{.RestartCount}}", cid],
            capture_output=True, text=True, check=True).stdout.split()
        assert state == "running" and restarts == "0", (
            f"{service} is {state}, restarted {restarts} times\n"
            f"{service_logs(env_dir, 'api', service)}")


def test_dump_produces_a_postgres_archive(env_dir: Path) -> None:
    out = ss("dump", str(env_dir))
    assert out.returncode == 0, out.stderr
    dump = Path(out.stdout.strip())
    data = dump.read_bytes()
    assert data[:5] == b"PGDMP"
    assert len(data) > MIN_DUMP_BYTES, f"dump is only {len(data)} bytes; schema missing?"
