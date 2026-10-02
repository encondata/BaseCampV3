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
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from conftest import REPO, SS_STACK, docker_daemon_ok, wait_http

pytestmark = [
    pytest.mark.e2e,
    pytest.mark.skipif(os.environ.get("SS_STACK_E2E") != "1", reason="set SS_STACK_E2E=1"),
    pytest.mark.skipif(not docker_daemon_ok(), reason="Docker daemon not available"),
]

PORTS = {"API": 18000, "PORTAL": 18091, "KIOSK": 18090, "WIKI": 18096,
         "SPACES": 19000, "STATUS": 18095, "MAILPIT": 18025}
SERVICES = {"api", "import-worker", "log-service", "notification-worker",
            "scan-matching-worker", "report-worker", "label-worker",
            "spec-lookup-worker", "db-testing-worker", "wiki-worker", "wiki-export-worker"}


def ss(*args: str, timeout: int = 900) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", str(SS_STACK), *args], capture_output=True,
                          text=True, timeout=timeout)


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
    up = ss("up", str(d))
    try:
        assert up.returncode == 0, up.stdout[-4000:] + up.stderr[-4000:]
        yield d
    finally:
        ss("down", str(d), "--volumes")


@pytest.mark.parametrize("name,path", [
    ("API", "/healthz"), ("PORTAL", "/"), ("KIOSK", "/"), ("WIKI", "/healthz"),
    ("SPACES", "/minio/health/live"), ("STATUS", "/healthz"), ("MAILPIT", "/"),
])
def test_every_service_answers(env_dir: Path, name: str, path: str) -> None:
    assert wait_http(f"http://127.0.0.1:{PORTS[name]}{path}", timeout=60) == 200


def test_migrations_reached_head(env_dir: Path) -> None:
    out = subprocess.run(
        ["docker", "compose", "--env-file", str(env_dir / ".env"),
         "-f", str(REPO / "deploy/stack/api/compose.yml"),
         "exec", "-T", "-w", "/app/api", "api", "alembic", "current"],
        capture_output=True, text=True)
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
        restarts = subprocess.run(["docker", "inspect", "-f", "{{.RestartCount}}", cid],
                                  capture_output=True, text=True, check=True).stdout.strip()
        assert restarts == "0", f"{service} restarted {restarts} times"


def test_dump_produces_a_postgres_archive(env_dir: Path) -> None:
    out = ss("dump", str(env_dir))
    assert out.returncode == 0, out.stderr
    dump = Path(out.stdout.strip())
    assert dump.read_bytes()[:5] == b"PGDMP"
