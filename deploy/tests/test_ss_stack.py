"""ss-stack runs the five stacks in dependency order. A fake `docker`
on PATH records every call, so these tests need no daemon."""
from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest

from conftest import ENV_EXAMPLE, SS_STACK, STACK_DIR

FAKE_DOCKER = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  "network inspect "*) [[ -n "${FAKE_NETWORK_EXISTS:-}" ]] && exit 0 || exit 1 ;;
  *pg_dump*) [[ -n "${FAKE_FAIL_PG_DUMP:-}" ]] && exit 1; printf 'PGDMP-fake' ;;
esac
exit 0
"""


@pytest.fixture
def env_dir(tmp_path: Path) -> Path:
    d = tmp_path / "uat"
    d.mkdir()
    text = ENV_EXAMPLE.read_text().replace("=CHANGEME", "=0123abcd")
    (d / ".env").write_text(text)
    return d.resolve()   # ss-stack logs the physical path (macOS /private/var)


@pytest.fixture
def fake(tmp_path: Path) -> dict[str, str]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    docker = bin_dir / "docker"
    docker.write_text(FAKE_DOCKER)
    docker.chmod(0o755)
    log = tmp_path / "docker.log"
    log.touch()
    return {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "DOCKER_LOG": str(log)}


def run(env: dict[str, str], *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["bash", str(SS_STACK), *args], env=env,
                          capture_output=True, text=True)


def calls(env: dict[str, str]) -> list[str]:
    return Path(env["DOCKER_LOG"]).read_text().splitlines()


def dc(env_dir: Path, stack: str, rest: str) -> str:
    return (f"compose --env-file {env_dir}/.env -f {STACK_DIR}/{stack}/compose.yml {rest}")


def test_up_starts_stacks_in_dependency_order(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    wait = "up -d --wait --wait-timeout 300 --remove-orphans"
    assert calls(fake) == [
        "network inspect ss-uat",
        "network create ss-uat",
        dc(env_dir, "db", wait),
        dc(env_dir, "storage", wait),
        dc(env_dir, "storage", "run --rm minio-init"),
        dc(env_dir, "api", "run --rm migrate"),
        dc(env_dir, "api", wait),
        dc(env_dir, "web", wait),
        dc(env_dir, "status", wait),
    ]


def test_up_reuses_an_existing_network(env_dir: Path, fake: dict[str, str]) -> None:
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert "network create ss-uat" not in calls(fake)


@pytest.mark.parametrize("command", ["build", "up"])
def test_refuses_placeholder_secrets(env_dir: Path, fake: dict[str, str], command: str) -> None:
    (env_dir / ".env").write_text(ENV_EXAMPLE.read_text())
    out = run(fake, command, str(env_dir))
    assert out.returncode != 0
    assert "SS_JWT_SECRET" in out.stderr
    assert calls(fake) == []


@pytest.mark.parametrize("bad", ["Bad_Name", "-uat", "uat-", "a"])
def test_rejects_bad_environment_names(env_dir: Path, fake: dict[str, str], bad: str) -> None:
    env_file = env_dir / ".env"
    env_file.write_text(env_file.read_text().replace("STACK_ENV=uat", f"STACK_ENV={bad}"))
    out = run(fake, "ps", str(env_dir))
    assert out.returncode != 0
    assert "STACK_ENV" in out.stderr


def test_missing_env_file_is_refused(tmp_path: Path, fake: dict[str, str]) -> None:
    out = run(fake, "up", str(tmp_path))
    assert out.returncode != 0
    assert ".env" in out.stderr


def test_unknown_command_prints_usage(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "explode", str(env_dir))
    assert out.returncode == 2
    assert "ss-stack build" in out.stdout + out.stderr


def test_build_uses_only_the_build_file(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "build", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [f"compose --env-file {env_dir}/.env -f {STACK_DIR}/build.yml build"]


def test_down_stops_in_reverse_order_and_keeps_data(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "down", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [dc(env_dir, s, "down") for s in ("status", "web", "api", "storage", "db")]


def test_down_volumes_deletes_data_and_the_network(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "down", str(env_dir), "--volumes")
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [
        *[dc(env_dir, s, "down --volumes") for s in ("status", "web", "api", "storage", "db")],
        "network rm ss-uat",
    ]


def test_ps_lists_every_stack(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "ps", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [dc(env_dir, s, "ps") for s in ("db", "storage", "api", "web", "status")]


def test_dump_writes_and_keeps_the_newest(env_dir: Path, fake: dict[str, str]) -> None:
    backups = env_dir / "backups"
    backups.mkdir()
    for i in range(6):
        (backups / f"20200101T00000{i}Z.dump").write_text("old")
    out = run(fake, "dump", str(env_dir))
    assert out.returncode == 0, out.stderr
    new = Path(out.stdout.strip())
    assert new.parent == backups and new.read_text() == "PGDMP-fake"
    assert calls(fake) == [dc(env_dir, "db",
                              "exec -T postgres pg_dump -U serversherpa -d serversherpa -Fc")]
    remaining = sorted(p.name for p in backups.glob("*.dump"))
    assert len(remaining) == 5
    assert new.name in remaining
    assert "20200101T000000Z.dump" not in remaining
    assert "20200101T000001Z.dump" not in remaining


def test_failed_dump_leaves_no_partial_file(env_dir: Path, fake: dict[str, str]) -> None:
    out = run({**fake, "FAKE_FAIL_PG_DUMP": "1"}, "dump", str(env_dir))
    assert out.returncode != 0
    assert "pg_dump failed" in out.stderr
    assert list((env_dir / "backups").glob("*.dump")) == []
