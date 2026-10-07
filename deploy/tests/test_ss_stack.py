"""ss-stack runs the five stacks in dependency order. A fake `docker`
on PATH records every call, so these tests need no daemon."""
from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path

import pytest

from conftest import ENV_EXAMPLE, SS_STACK, STACK_DIR

FAKE_DOCKER = r"""#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$*" in
  "network inspect "*) [[ -n "${FAKE_NETWORK_EXISTS:-}" ]] && exit 0 || exit 1 ;;
  *pg_dump*)
    [[ -n "${FAKE_FAIL_PG_DUMP:-}" ]] && { printf 'PGDMP-cut'; exit 1; }
    # a dump that hangs halfway, so a test can kill ss-stack mid-dump
    [[ -n "${FAKE_SLOW_PG_DUMP:-}" ]] && { printf 'PGDMP-part'; sleep 30; exit 0; }
    printf 'PGDMP-fake' ;;
  *pg_restore*)
    cat > "$DOCKER_LOG.stdin"
    [[ -n "${FAKE_FAIL_PG_RESTORE:-}" ]] && exit 1 ;;
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
    assert "ss-stack restore <env-dir> <file.dump> [--clear-sessions]" in out.stdout + out.stderr


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
    assert list((env_dir / "backups").glob("*.partial")) == []


def test_dump_is_owner_only_and_leaves_no_partial(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "dump", str(env_dir))
    assert out.returncode == 0, out.stderr
    new = Path(out.stdout.strip())
    assert new.stat().st_mode & 0o777 == 0o600
    assert (env_dir / "backups").stat().st_mode & 0o777 == 0o700
    assert list((env_dir / "backups").glob("*.partial")) == []


def test_rotation_ignores_a_stray_partial(env_dir: Path, fake: dict[str, str]) -> None:
    # a .partial may belong to a dump still running, so rotation never
    # counts it and never deletes it
    backups = env_dir / "backups"
    backups.mkdir()
    for i in range(6):
        (backups / f"20200101T00000{i}Z.dump").write_text("old")
    stray = backups / "20200101T000009Z.dump.partial"
    stray.write_text("half")
    out = run(fake, "dump", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert len(list(backups.glob("*.dump"))) == 5
    assert stray.read_text() == "half"


@pytest.mark.parametrize("sig", [signal.SIGTERM, signal.SIGINT, signal.SIGHUP])
def test_interrupted_dump_leaves_no_partial(env_dir: Path, fake: dict[str, str],
                                            sig: signal.Signals) -> None:
    backups = env_dir / "backups"
    proc = subprocess.Popen(["bash", str(SS_STACK), "dump", str(env_dir)],
                            env={**fake, "FAKE_SLOW_PG_DUMP": "1"}, start_new_session=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        deadline = time.monotonic() + 10
        while not list(backups.glob("*.partial")):
            assert time.monotonic() < deadline, "no partial file appeared"
            time.sleep(0.05)
        os.killpg(proc.pid, sig)   # what Ctrl-C or a dropped SSH session does
        proc.wait(timeout=10)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.wait()
    assert proc.returncode != 0
    assert list(backups.iterdir()) == []


WAIT = "up -d --wait --wait-timeout 300 --remove-orphans"
PSQL = "exec -T postgres psql -U serversherpa -d serversherpa -v ON_ERROR_STOP=1 -q"
CLEAR = ("DO $$ BEGIN IF to_regclass('public.auth_sessions') IS NOT NULL THEN DELETE FROM "
         "auth_sessions; END IF; IF to_regclass('public.trusted_devices') IS NOT NULL THEN "
         "DELETE FROM trusted_devices; END IF; END $$;")


def test_data_starts_only_the_database_and_storage(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "data", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == ["network inspect ss-uat", "network create ss-uat",
                           dc(env_dir, "db", WAIT), dc(env_dir, "storage", WAIT)]


def test_data_refuses_placeholder_secrets(env_dir: Path, fake: dict[str, str]) -> None:
    (env_dir / ".env").write_text(ENV_EXAMPLE.read_text())
    out = run(fake, "data", str(env_dir))
    assert out.returncode != 0 and calls(fake) == []


def _dump(tmp_path: Path) -> Path:
    dump = tmp_path / "20261004T010203Z.dump"
    dump.write_bytes(b"PGDMP-restore-me")
    return dump


def test_restore_stops_writers_empties_the_schema_and_restores(
        env_dir: Path, fake: dict[str, str], tmp_path: Path) -> None:
    dump = _dump(tmp_path)
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "restore", str(env_dir), str(dump),
              "--clear-sessions")
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == f"restored {dump}"
    assert calls(fake) == [
        "network inspect ss-uat",
        dc(env_dir, "status", "stop"), dc(env_dir, "web", "stop"), dc(env_dir, "api", "stop"),
        dc(env_dir, "db", WAIT),
        dc(env_dir, "db", f"{PSQL} -c DROP SCHEMA public CASCADE; CREATE SCHEMA public;"),
        dc(env_dir, "db", "exec -T postgres pg_restore --exit-on-error --no-owner --no-acl "
                          "-U serversherpa -d serversherpa"),
        dc(env_dir, "db", f"{PSQL} -c {CLEAR}"),
    ]
    assert Path(fake["DOCKER_LOG"] + ".stdin").read_bytes() == b"PGDMP-restore-me"


def test_restore_keeps_sessions_unless_asked(env_dir: Path, fake: dict[str, str],
                                             tmp_path: Path) -> None:
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "restore", str(env_dir), str(_dump(tmp_path)))
    assert out.returncode == 0, out.stderr
    assert not any("auth_sessions" in c for c in calls(fake))


def test_restore_reports_a_failed_pg_restore(env_dir: Path, fake: dict[str, str],
                                             tmp_path: Path) -> None:
    out = run({**fake, "FAKE_FAIL_PG_RESTORE": "1"}, "restore", str(env_dir),
              str(_dump(tmp_path)), "--clear-sessions")
    assert out.returncode != 0
    assert "pg_restore failed" in out.stderr
    assert not any("auth_sessions" in c for c in calls(fake))


@pytest.mark.parametrize("args, code, message", [
    (["/no/such.dump"], 1, "no such dump file: /no/such.dump"),
    ([], 2, "ss-stack build"),
    (["DUMP", "--everything"], 2, "ss-stack build"),
])
def test_restore_arguments(env_dir: Path, fake: dict[str, str], tmp_path: Path,
                           args: list[str], code: int, message: str) -> None:
    args = [str(_dump(tmp_path)) if a == "DUMP" else a for a in args]
    out = run(fake, "restore", str(env_dir), *args)
    assert out.returncode == code
    assert message in out.stdout + out.stderr
    assert calls(fake) == []


def test_admin_runs_bootstrap_admin_in_the_api_container(env_dir: Path,
                                                         fake: dict[str, str]) -> None:
    out = subprocess.run(["bash", str(SS_STACK), "admin", str(env_dir), "--email",
                          "ada@test.example.com", "--password-stdin"], env=fake,
                         capture_output=True, text=True, input="Stdin-Only-Password-42\n")
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [dc(env_dir, "api", "exec -T api serversherpa bootstrap-admin "
                              "--email ada@test.example.com --password-stdin")]
    assert "Stdin-Only-Password-42" not in "\n".join(calls(fake))


def test_admin_passes_the_exit_code_through(env_dir: Path, fake: dict[str, str],
                                            tmp_path: Path) -> None:
    docker = tmp_path / "bin" / "docker"
    docker.write_text("#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$DOCKER_LOG\"\nexit 3\n")
    out = run(fake, "admin", str(env_dir), "--invite")
    assert out.returncode == 3


def test_admin_needs_arguments(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "admin", str(env_dir))
    assert out.returncode == 2
    assert calls(fake) == []
