"""The API image carries everything the API, every worker and the
migrate job need — one image, many commands."""
from __future__ import annotations

import json
import subprocess

import pytest

from conftest import build_image, docker_daemon_ok, docker_run

pytestmark = [
    pytest.mark.images,
    pytest.mark.skipif(not docker_daemon_ok(), reason="Docker daemon not available"),
]

TAG = "serversherpa-api:pytest"


@pytest.fixture(scope="module", autouse=True)
def api_image() -> None:
    build_image("api/Dockerfile", TAG)


def test_cli_lists_every_worker_command() -> None:
    out = docker_run(TAG, "serversherpa", "--help")
    assert out.returncode == 0, out.stderr
    for command in ("import-worker", "log-service", "notification-worker",
                    "scan-matching-worker", "report-worker", "label-worker",
                    "spec-lookup-worker", "db-testing-worker", "wiki-worker"):
        assert command in out.stdout


def test_runs_as_uid_10001() -> None:
    assert docker_run(TAG, "id", "-u").stdout.strip() == "10001"


def test_node_is_20_or_newer() -> None:
    out = docker_run(TAG, "node", "--version")
    assert out.returncode == 0, out.stderr
    assert int(out.stdout.strip().lstrip("v").split(".")[0]) >= 20


def test_renderers_are_bundled_and_wired() -> None:
    script = ("const fs=require('fs');"
              "for (const k of ['SS_REPORT_RACK_RENDERER','SS_REPORT_CONTAINER_LABEL_RENDERER'])"
              "{ fs.accessSync(process.env[k]); }")
    out = docker_run(TAG, "node", "-e", script)
    assert out.returncode == 0, out.stderr


@pytest.mark.parametrize("tool", [["pg_dump", "--version"],
                                  ["soffice", "--version"],
                                  ["pdftoppm", "-v"]])
def test_worker_tools_present(tool: list[str]) -> None:
    out = docker_run(TAG, *tool)
    assert out.returncode == 0, out.stderr


def test_migrations_ship_with_the_image() -> None:
    out = docker_run(TAG, "sh", "-c", "cd /app/api && alembic heads")
    assert out.returncode == 0, out.stderr
    assert "(head)" in out.stdout


def test_default_command_does_not_trust_every_proxy() -> None:
    # trusting "*" lets any caller pick its client IP via X-Forwarded-For
    out = subprocess.run(["docker", "image", "inspect", "-f", "{{json .Config.Cmd}}", TAG],
                         capture_output=True, text=True)
    assert out.returncode == 0, out.stderr
    cmd = json.loads(out.stdout)
    assert "--proxy-headers" in cmd
    assert "--forwarded-allow-ips" not in cmd
    assert "*" not in cmd


def test_home_belongs_to_the_runtime_user() -> None:
    # LibreOffice and fontconfig write caches under HOME; a root-owned
    # HOME breaks them ("Fontconfig error: No writable cache directories")
    out = docker_run(TAG, "sh", "-c",
                     'test -w "$HOME" && touch "$HOME/.probe" && stat -c %u "$HOME"'
                     ' && find "$HOME" ! -user 10001 | head -n 5')
    assert out.returncode == 0, out.stderr
    lines = out.stdout.split()
    assert lines[0] == "10001"
    assert lines[1:] == [], f"not owned by 10001: {lines[1:]}"
