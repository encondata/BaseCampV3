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
  "volume ls -q")
    [[ -n "${FAKE_DOCKER_DOWN:-}" ]] && exit 1
    [[ -n "${FAKE_VOLUMES:-}" ]] && printf '%s\n' $FAKE_VOLUMES
    exit 0 ;;
  *"to_regclass('public.alembic_version') IS NOT NULL")
    [[ -n "${FAKE_FAIL_PSQL:-}" ]] && exit 1
    echo "${FAKE_HAS_TABLES:-f}" ;;
  *"python /objects.py "*)
    # what objects.py would be given: the S3 settings arrive in the environment
    printf 'endpoint=%s key=%s secret=%s bucket=%s region=%s style=%s\n' \
      "${SS_OBJECTS_ENDPOINT-unset}" "${SS_OBJECTS_KEY_ID-unset}" "${SS_OBJECTS_SECRET-unset}" \
      "${SS_OBJECTS_BUCKET-unset}" "${SS_OBJECTS_REGION-unset}" "${SS_OBJECTS_PATH_STYLE-unset}" \
      >> "$DOCKER_LOG.objects"
    [[ -n "${FAKE_FAIL_OBJECTS:-}" ]] && { echo "objects.py: the object store failed" >&2; exit 1; }
    exit 0 ;;
  *"auth_sessions"*) [[ -n "${FAKE_FAIL_PSQL:-}" ]] && exit 1 ;;
  *" ps --status running -q postgres") [[ -n "${FAKE_DB_RUNNING:-}" ]] && echo 0123abcdef ;;
  *pg_dump*)
    [[ -n "${FAKE_FAIL_PG_DUMP:-}" ]] && { printf 'PGDMP-cut'; exit 1; }
    # a dump that hangs halfway, so a test can kill ss-stack mid-dump
    [[ -n "${FAKE_SLOW_PG_DUMP:-}" ]] && { printf 'PGDMP-part'; sleep 30; exit 0; }
    printf 'PGDMP-fake' ;;
  *bootstrap-admin*)
    cat > "$DOCKER_LOG.stdin" ;;
  *"/status/compose.yml up"*)
    # what the status page is told to check (unset: compose's default)
    printf 'kiosk=%s wiki=%s learn=%s\n' "${STATUS_KIOSK_URL-unset}" "${STATUS_WIKI_URL-unset}" \
      "${STATUS_LEARN_URL-unset}" >> "$DOCKER_LOG.status" ;;
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
    for command in ("has-data", "accepts", "verify-dump", "clear-sessions", "export-objects",
                    "import-objects"):
        assert f"ss-stack {command} <env-dir>" in out.stdout, command
    # the header's env-dir paragraph isn't part of the usage
    assert "holds the environment's .env" not in out.stdout


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
    # the password reaches the container's stdin byte for byte
    assert Path(fake["DOCKER_LOG"] + ".stdin").read_bytes() == b"Stdin-Only-Password-42\n"
    assert "Stdin-Only-Password-42" not in out.stdout + out.stderr


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


# ---- LAN Blue/Green (Sirdar phase 8b): the data VM and its app VMs ----

LAN_DATA = ("STACK_DB_PUBLISH=1\nSTACK_DB_PORT=5432\n"
            "STACK_DB_ALLOW=10.10.48.48,10.10.48.49\n")


def test_a_data_vm_publishes_postgres_with_its_hba(env_dir: Path, fake: dict[str, str]) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(LAN_DATA)
    out = run(fake, "data", str(env_dir))
    assert out.returncode == 0, out.stderr
    lan = f"-f {STACK_DIR}/db/lan.yml"
    db_calls = [c for c in calls(fake) if "/db/compose.yml" in c]
    assert db_calls and all(lan in c for c in db_calls)
    hba = (env_dir / "pg_hba.conf").read_text()
    assert "host serversherpa serversherpa 10.10.48.48/32 scram-sha-256" in hba
    assert "host serversherpa serversherpa 10.10.48.49/32 scram-sha-256" in hba
    assert "local all all trust" in hba and "0.0.0.0/0" not in hba
    assert oct((env_dir / "pg_hba.conf").stat().st_mode & 0o777) == "0o644"


@pytest.mark.parametrize("allow", ["", "10.10.48.48,not-an-ip", "10.10.48.48;rm -rf /",
                                   "10.10.48.256", "10.10.48.48,", "10.10.048.48",
                                   "010.10.48.48"])
def test_a_bad_allow_list_is_refused(env_dir: Path, fake: dict[str, str], allow: str) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(f"STACK_DB_PUBLISH=1\nSTACK_DB_ALLOW={allow}\n")
    out = run(fake, "data", str(env_dir))
    assert out.returncode != 0
    assert "STACK_DB_ALLOW" in out.stderr
    assert not any("/db/compose.yml" in c for c in calls(fake))


@pytest.mark.parametrize("command", ["up", "restore"])
def test_up_and_restore_on_a_data_vm_write_the_hba_too(env_dir: Path, fake: dict[str, str],
                                                       command: str, tmp_path: Path) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(LAN_DATA)
    dump = tmp_path / "x.dump"
    dump.write_bytes(b"PGDMP")
    out = run(fake, command, str(env_dir), *([str(dump)] if command == "restore" else []))
    assert out.returncode == 0, out.stderr
    assert "10.10.48.49/32" in (env_dir / "pg_hba.conf").read_text()
    db_calls = [c for c in calls(fake) if "/db/compose.yml" in c]
    assert db_calls and all(f"-f {STACK_DIR}/db/lan.yml" in c for c in db_calls)


@pytest.mark.parametrize("command", ["down", "ps", "dump", "pgdump", "revision",
                                     "clear-sessions"])
def test_every_db_call_on_a_data_vm_takes_the_override(env_dir: Path, fake: dict[str, str],
                                                       command: str, tmp_path: Path) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(LAN_DATA)
    extra = [str(tmp_path / "out.dump")] if command == "pgdump" else []
    out = run(fake, command, str(env_dir), *extra)
    assert out.returncode == 0, out.stderr
    db_calls = [c for c in calls(fake) if "/db/compose.yml" in c]
    assert db_calls and all(f"-f {STACK_DIR}/db/lan.yml" in c for c in db_calls)
    # only up, data and restore (re)write the file
    assert not (env_dir / "pg_hba.conf").exists()


def test_an_app_vm_on_a_lan_data_vm_talks_without_tls(env_dir: Path,
                                                      fake: dict[str, str]) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write("STACK_EXTERNAL_DATA=1\nSTACK_DB_HOST=10.10.48.47\nSTACK_DB_PORT=5432\n"
                "STACK_DB_NAME=serversherpa\nSTACK_DB_USER=serversherpa\n"
                "STACK_DB_SSLMODE=disable\n")
    out = run(fake, "dump", str(env_dir))
    assert out.returncode == 0, out.stderr
    dump = next(c for c in calls(fake) if "pg_dump" in c)
    assert "-e PGSSLMODE=disable" in dump and "PGSSLMODE=require" not in dump
    assert "-e PGHOST=10.10.48.47" in dump


def test_the_managed_database_still_requires_tls(env_dir: Path, fake: dict[str, str]) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write("STACK_EXTERNAL_DATA=1\nSTACK_DB_HOST=db.internal\nSTACK_DB_PORT=25060\n"
                "STACK_DB_NAME=serversherpa\nSTACK_DB_USER=serversherpa\n")
    run(fake, "dump", str(env_dir))
    assert "-e PGSSLMODE=require" in next(c for c in calls(fake) if "pg_dump" in c)


def test_an_unknown_sslmode_is_refused(env_dir: Path, fake: dict[str, str]) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write("STACK_EXTERNAL_DATA=1\nSTACK_DB_HOST=db.internal\nSTACK_DB_PORT=25060\n"
                "STACK_DB_NAME=serversherpa\nSTACK_DB_USER=serversherpa\n"
                "STACK_DB_SSLMODE=allow\n")
    out = run(fake, "dump", str(env_dir))
    assert out.returncode != 0 and "STACK_DB_SSLMODE" in out.stderr
    assert not any("pg_dump" in c for c in calls(fake))


RELOAD = ("exec -T postgres psql -U serversherpa -d serversherpa -v ON_ERROR_STOP=1 "
          "-tAc SELECT pg_reload_conf()")


def test_a_changed_allow_list_reaches_the_running_database(env_dir: Path,
                                                           fake: dict[str, str]) -> None:
    """The container bind-mounts the file itself, so it must keep its inode,
    and a running Postgres rereads it (pg_reload_conf)."""
    with (env_dir / ".env").open("a") as f:
        f.write(LAN_DATA)
    assert run(fake, "data", str(env_dir)).returncode == 0
    hba = env_dir / "pg_hba.conf"
    inode = hba.stat().st_ino
    assert not any(RELOAD in c for c in calls(fake))   # nothing was running
    with (env_dir / ".env").open("a") as f:
        f.write("STACK_DB_ALLOW=10.10.48.50\n")
    Path(fake["DOCKER_LOG"]).write_text("")
    out = run({**fake, "FAKE_DB_RUNNING": "1"}, "data", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert hba.stat().st_ino == inode
    assert oct(hba.stat().st_mode & 0o777) == "0o644"
    text = hba.read_text()
    assert "10.10.48.50/32" in text and "10.10.48.48" not in text
    log = calls(fake)
    reload = [i for i, c in enumerate(log) if RELOAD in c]
    assert len(reload) == 1 and f"-f {STACK_DIR}/db/lan.yml" in log[reload[0]]
    assert reload[0] < next(i for i, c in enumerate(log) if " up -d " in c)


def test_an_unchanged_allow_list_doesnt_reload(env_dir: Path, fake: dict[str, str]) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(LAN_DATA)
    assert run(fake, "data", str(env_dir)).returncode == 0
    out = run({**fake, "FAKE_DB_RUNNING": "1"}, "data", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert not any(RELOAD in c for c in calls(fake))


def test_a_data_vm_starts_no_mail_catcher(env_dir: Path, fake: dict[str, str]) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(LAN_DATA)
    assert run(fake, "data", str(env_dir)).returncode == 0
    storage = [c for c in calls(fake) if "/storage/compose.yml" in c]
    wait = "up -d --wait --wait-timeout 300 --remove-orphans"
    assert storage == [dc(env_dir, "storage", f"{wait} seaweedfs")]


@pytest.mark.parametrize("port", ["70000", "0", "54x", "05432"])
def test_a_bad_db_port_on_a_data_vm_is_refused(env_dir: Path, fake: dict[str, str],
                                               port: str) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(LAN_DATA + f"STACK_DB_PORT={port}\n")
    out = run(fake, "data", str(env_dir))
    assert out.returncode != 0 and "STACK_DB_PORT" in out.stderr
    assert not any("/db/compose.yml" in c for c in calls(fake))


def _free_port() -> int:
    import socket
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.mark.e2e
@pytest.mark.skipif(os.environ.get("SS_STACK_E2E") != "1", reason="set SS_STACK_E2E=1")
def test_a_data_vm_lets_only_its_app_servers_in(tmp_path: Path) -> None:
    """Real Docker: ss-stack data with db/lan.yml. Postgres initializes with
    the override's command, and its pg_hba.conf lets in the allowed address
    only, and only to the serversherpa database."""
    name = f"lanhba{os.getpid() % 10000}"
    env_dir = tmp_path / name
    env_dir.mkdir()
    password = "hba-e2e-0123abcd"
    text = (ENV_EXAMPLE.read_text().replace("=CHANGEME", f"={password}")
            .replace("STACK_ENV=uat", f"STACK_ENV={name}")
            .replace("STACK_BIND_IP=0.0.0.0", "STACK_BIND_IP=127.0.0.1")
            .replace("STACK_SPACES_PORT=9000", f"STACK_SPACES_PORT={_free_port()}")
            .replace("STACK_MAILPIT_PORT=8025", f"STACK_MAILPIT_PORT={_free_port()}"))
    text += (f"STACK_NETWORK_SUBNET=172.31.77.0/24\nSTACK_DB_PUBLISH=1\n"
             f"STACK_DB_PORT={_free_port()}\nSTACK_DB_ALLOW=172.31.77.10\n")
    (env_dir / ".env").write_text(text)

    def client(ip: str, db: str = "serversherpa") -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["docker", "run", "--rm", "--network", f"ss-{name}", "--ip", ip,
             "-e", "PGPASSWORD", "postgres:16-alpine", "psql", "-h", "postgres",
             "-U", "serversherpa", "-d", db, "-tAc", "SELECT 1"],
            capture_output=True, text=True, env={**os.environ, "PGPASSWORD": password},
            check=False)

    try:
        up = subprocess.run(["bash", str(SS_STACK), "data", str(env_dir)],
                            capture_output=True, text=True, check=False)
        assert up.returncode == 0, up.stdout + up.stderr
        allowed = client("172.31.77.10")
        assert allowed.returncode == 0 and allowed.stdout.strip() == "1", allowed.stderr
        other = client("172.31.77.11")
        assert other.returncode != 0 and "no pg_hba.conf entry" in other.stderr
        wrong_db = client("172.31.77.10", "postgres")
        assert wrong_db.returncode != 0 and "no pg_hba.conf entry" in wrong_db.stderr
        # the local socket still answers (ss-stack dump, the health check)
        rev = subprocess.run(["bash", str(SS_STACK), "pgdump", str(env_dir),
                              str(tmp_path / "out.dump")], capture_output=True, text=True,
                             check=False)
        assert rev.returncode == 0, rev.stderr
        assert (tmp_path / "out.dump").read_bytes().startswith(b"PGDMP")
        # a new allow list reaches the running database: .11 in, .10 out
        with (env_dir / ".env").open("a") as f:
            f.write("STACK_DB_ALLOW=172.31.77.11\n")
        again = subprocess.run(["bash", str(SS_STACK), "data", str(env_dir)],
                               capture_output=True, text=True, check=False)
        assert again.returncode == 0, again.stdout + again.stderr
        now_in = client("172.31.77.11")
        assert now_in.returncode == 0 and now_in.stdout.strip() == "1", now_in.stderr
        now_out = client("172.31.77.10")
        assert now_out.returncode != 0 and "no pg_hba.conf entry" in now_out.stderr
    finally:
        subprocess.run(["bash", str(SS_STACK), "down", str(env_dir), "--volumes"],
                       capture_output=True, text=True, check=False)


# an SMTP server, so Mailpit may be off; the password must never reach argv
SMTP = "SS_SMTP_HOST=smtp.example.com\nSS_SMTP_PASSWORD=Mail-Secret-1\n"


def _apps(env_dir: Path, line: str) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(line)


def test_apps_that_are_off_dont_run(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, SMTP + "STACK_APPS=kiosk\n")
    out = run(fake, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    c = calls(fake)
    assert dc(env_dir, "storage", f"{WAIT} --scale mailpit=0") in c
    assert dc(env_dir, "api", f"{WAIT} --scale wiki-worker=0 --scale wiki-export-worker=0") in c
    assert dc(env_dir, "web", f"{WAIT} --scale wiki=0 --scale learn=0") in c
    assert dc(env_dir, "status", "down") in c
    assert dc(env_dir, "status", WAIT) not in c


def test_none_runs_only_the_api_and_the_portal(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, SMTP + "STACK_APPS=none\n")
    assert run(fake, "up", str(env_dir)).returncode == 0
    c = calls(fake)
    assert dc(env_dir, "web", f"{WAIT} --scale kiosk=0 --scale wiki=0 --scale learn=0") in c
    assert dc(env_dir, "status", "down") in c


def _status_targets(env: dict[str, str]) -> list[str]:
    path = Path(env["DOCKER_LOG"] + ".status")
    return path.read_text().splitlines() if path.exists() else []


@pytest.mark.parametrize("apps, seen", [
    ("", "kiosk=unset wiki=unset learn=unset"),
    ("wiki,kiosk,learn,status,mailpit", "kiosk=unset wiki=unset learn=unset"),
    ("wiki,kiosk,status,mailpit", "kiosk=unset wiki=unset learn="),
    ("status,mailpit", "kiosk= wiki= learn="),
    ("wiki,status,mailpit", "kiosk= wiki=unset learn="),
    ("kiosk,status,mailpit", "kiosk=unset wiki= learn="),
])
def test_the_status_page_checks_only_the_apps_that_run(env_dir: Path, fake: dict[str, str],
                                                       apps: str, seen: str) -> None:
    """An app that is off gets an empty URL (the status page leaves its card
    out); one that runs keeps compose's default. A caller's own value never
    gets through."""
    _apps(env_dir, f"STACK_APPS={apps}\n")
    env = {**fake, "STATUS_KIOSK_URL": "https://elsewhere.example", "STATUS_WIKI_URL": "x",
           "STATUS_LEARN_URL": "y"}
    out = run(env, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert _status_targets(fake) == [seen]


def test_every_app_runs_when_the_key_is_absent_or_lists_them_all(env_dir: Path,
                                                                 fake: dict[str, str]) -> None:
    _apps(env_dir, "STACK_APPS=wiki,kiosk,learn,status,mailpit\n")
    assert run(fake, "up", str(env_dir)).returncode == 0
    c = calls(fake)
    for stack in ("storage", "api", "web", "status"):
        assert dc(env_dir, stack, WAIT) in c, stack


def test_external_data_without_mailpit_removes_it(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, SMTP + "STACK_EXTERNAL_DATA=1\nSTACK_APPS=wiki,kiosk,status\n")
    assert run(fake, "up", str(env_dir)).returncode == 0
    c = calls(fake)
    assert dc(env_dir, "storage", "rm -sf mailpit") in c
    assert dc(env_dir, "storage", f"{WAIT} mailpit") not in c


def test_data_without_mailpit_starts_only_seaweedfs_storage(env_dir: Path,
                                                            fake: dict[str, str]) -> None:
    _apps(env_dir, "STACK_APPS=wiki,kiosk,status\n")
    assert run(fake, "data", str(env_dir)).returncode == 0
    assert calls(fake) == ["network inspect ss-uat", "network create ss-uat",
                           dc(env_dir, "db", WAIT),
                           dc(env_dir, "storage", f"{WAIT} --scale mailpit=0")]


def test_the_learn_site_runs_when_listed(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, SMTP + "STACK_APPS=wiki,learn\n")
    assert run(fake, "up", str(env_dir)).returncode == 0
    assert dc(env_dir, "web", f"{WAIT} --scale kiosk=0") in calls(fake)


@pytest.mark.parametrize("command", ["up", "data"])
def test_the_learning_site_needs_the_wiki(env_dir: Path, fake: dict[str, str],
                                          command: str) -> None:
    _apps(env_dir, SMTP + "STACK_APPS=kiosk,learn,status\n")
    out = run(fake, command, str(env_dir))
    assert out.returncode != 0
    assert ("The learning site needs the wiki: turn the wiki on, or turn learning off."
            in out.stderr)
    assert calls(fake) == []


def test_a_data_vm_ignores_stack_apps(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, LAN_DATA + "STACK_APPS=none\n")
    assert run(fake, "data", str(env_dir)).returncode == 0
    storage = [c for c in calls(fake) if "/storage/compose.yml" in c]
    assert storage == [dc(env_dir, "storage", f"{WAIT} seaweedfs")]



@pytest.mark.parametrize("apps", [
    "wiki, kiosk", " wiki", "kiosk ", "Wiki", "KIOSK,status", "wiki,blog", "portal", "Learn",
    "wiki,", ",wiki", "wiki,,kiosk", "none,wiki", "\"wiki kiosk\""])
@pytest.mark.parametrize("command", ["up", "data"])
def test_a_bad_app_list_is_refused(env_dir: Path, fake: dict[str, str], apps: str,
                                   command: str) -> None:
    _apps(env_dir, SMTP + f"STACK_APPS={apps}\n")
    out = run(fake, command, str(env_dir))
    assert out.returncode != 0
    assert "STACK_APPS" in out.stderr
    assert calls(fake) == []


def test_an_empty_app_list_runs_every_app(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, "STACK_APPS=\n")
    out = run(fake, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    c = calls(fake)
    for stack in ("storage", "api", "web", "status"):
        assert dc(env_dir, stack, WAIT) in c, stack


@pytest.mark.parametrize("smtp", ["", "SS_SMTP_HOST=\n"])
@pytest.mark.parametrize("extra", ["", "STACK_EXTERNAL_DATA=1\n"])
def test_mailpit_off_without_an_smtp_host_is_refused(env_dir: Path, fake: dict[str, str],
                                                     smtp: str, extra: str) -> None:
    _apps(env_dir, extra + smtp + "STACK_APPS=wiki,kiosk,status\n")
    out = run(fake, "up", str(env_dir))
    assert out.returncode != 0
    assert "Mailpit is off and no SMTP host is set: mail would fail." in out.stderr
    assert calls(fake) == []


def test_mailpit_off_with_an_smtp_host_runs(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, SMTP + "STACK_APPS=none\n")
    out = run(fake, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert dc(env_dir, "storage", f"{WAIT} --scale mailpit=0") in calls(fake)


@pytest.mark.parametrize("extra", ["", "STACK_EXTERNAL_DATA=1\n", "STACK_APPS=none\n"])
def test_the_smtp_password_never_reaches_argv(env_dir: Path, fake: dict[str, str],
                                              extra: str) -> None:
    _apps(env_dir, SMTP + extra)
    for command in ("up", "data", "ps", "down"):
        out = run(fake, command, str(env_dir))
        assert out.returncode == 0, out.stderr
        assert "Mail-Secret-1" not in out.stdout + out.stderr
    assert calls(fake)
    assert not any("Mail-Secret-1" in c for c in calls(fake))


LABELS = ["seed-label-fonts", "seed-label-templates"]


@pytest.mark.parametrize("apps, args, commands", [
    # the learning site runs (every app runs, or STACK_APPS lists learn): its space is seeded too
    ("", (), [*LABELS, "learning-seed"]),
    ("STACK_APPS=wiki,learn\n", (), [*LABELS, "learning-seed"]),
    ("STACK_APPS=wiki,kiosk\n", (), LABELS),
    ("STACK_APPS=none\n", (), LABELS),
    ("STACK_APPS=wiki,kiosk\n", ("--learning",), [*LABELS, "learning-seed"]),
])
def test_seed_runs_the_starter_content_commands_in_the_api_container(
        env_dir: Path, fake: dict[str, str], apps: str, args: tuple[str, ...],
        commands: list[str]) -> None:
    _apps(env_dir, apps)
    out = run(fake, "seed", str(env_dir), *args)
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [dc(env_dir, "api", f"exec -T api serversherpa {c}") for c in commands]


def test_seed_stops_at_the_first_failure_with_its_exit_code(env_dir: Path, fake: dict[str, str],
                                                            tmp_path: Path) -> None:
    docker = tmp_path / "bin" / "docker"
    docker.write_text("#!/usr/bin/env bash\nprintf '%s\\n' \"$*\" >> \"$DOCKER_LOG\"\n"
                      "[[ \"$*\" == *seed-label-fonts* ]] && exit 4\nexit 0\n")
    out = run(fake, "seed", str(env_dir), "--learning")
    assert out.returncode == 4
    assert calls(fake) == [dc(env_dir, "api", "exec -T api serversherpa seed-label-fonts")]


def test_seed_takes_only_learning(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "seed", str(env_dir), "--everything")
    assert out.returncode == 2
    assert calls(fake) == []


# ---- Slipway's data commands (slipway.yml: has_data, accepts, verify_dump,
# after_import, export_files, import_files) ----

VOLUME = "ss-uat-db_pgdata"
HAS_TABLES = ("exec -T postgres psql -U serversherpa -d serversherpa -v ON_ERROR_STOP=1 -tAc "
              "SELECT to_regclass('public.alembic_version') IS NOT NULL")


def test_has_data_without_the_volume_is_empty(env_dir: Path, fake: dict[str, str]) -> None:
    out = run({**fake, "FAKE_VOLUMES": "ss-other-db_pgdata ss-uat-db_pgdata-old"},
              "has-data", str(env_dir))
    assert out.returncode == 3, out.stderr
    assert f"there is no volume {VOLUME}" in out.stdout
    # nothing is started, nothing is created
    assert calls(fake) == ["volume ls -q"]


@pytest.mark.parametrize("tables, code", [("t", 0), ("f", 3)])
def test_has_data_asks_the_database(env_dir: Path, fake: dict[str, str], tables: str,
                                    code: int) -> None:
    out = run({**fake, "FAKE_VOLUMES": f"other {VOLUME}", "FAKE_HAS_TABLES": tables},
              "has-data", str(env_dir))
    assert out.returncode == code, out.stderr
    assert calls(fake) == ["volume ls -q", "network inspect ss-uat", "network create ss-uat",
                           dc(env_dir, "db", WAIT), dc(env_dir, "db", HAS_TABLES)]
    assert ("has ServerSherpa's tables" if code == 0 else "has no tables") in out.stdout


@pytest.mark.parametrize("change", [{"FAKE_DOCKER_DOWN": "1"}, {"FAKE_FAIL_PSQL": "1"}])
def test_has_data_that_cant_tell_is_an_error_not_empty(env_dir: Path, fake: dict[str, str],
                                                        change: dict[str, str]) -> None:
    out = run({**fake, "FAKE_VOLUMES": VOLUME, **change}, "has-data", str(env_dir))
    assert out.returncode == 1
    assert "ss-stack: couldn't" in out.stderr


@pytest.mark.parametrize("extra", [
    "STACK_EXTERNAL_DATA=1\n",
    "STACK_DB_HOST=10.10.48.47\n",
    LAN_DATA,
])
def test_has_data_is_4_when_the_database_is_shared_or_elsewhere(env_dir: Path,
                                                                fake: dict[str, str],
                                                                extra: str) -> None:
    _apps(env_dir, extra)
    out = run({**fake, "FAKE_VOLUMES": VOLUME, "FAKE_HAS_TABLES": "t"}, "has-data", str(env_dir))
    assert out.returncode == 4, out.stderr
    assert calls(fake) == []


def test_has_data_takes_no_arguments(env_dir: Path, fake: dict[str, str]) -> None:
    assert run(fake, "has-data", str(env_dir), "--now").returncode == 2


def _revision(tmp_path: Path, text: str) -> Path:
    f = tmp_path / "revision"
    f.write_text(text)
    return f


def _newest_migration() -> str:
    versions = STACK_DIR.parent.parent / "api" / "migrations" / "versions"
    return max(p.name.split("_")[0] for p in versions.glob("[0-9]*_*.py"))


@pytest.mark.parametrize("text", ["{rev}", "{rev}\n", "  {rev}\n\n", "0001"])
def test_accepts_a_revision_this_commit_has(env_dir: Path, fake: dict[str, str], tmp_path: Path,
                                            text: str) -> None:
    rev = _newest_migration()
    out = run(fake, "accepts", str(env_dir), str(_revision(tmp_path, text.format(rev=rev))))
    assert out.returncode == 0, out.stdout + out.stderr
    assert "This commit has migration" in out.stdout
    assert calls(fake) == []   # no database, no docker


def test_accepts_refuses_a_newer_or_foreign_revision(env_dir: Path, fake: dict[str, str],
                                                     tmp_path: Path) -> None:
    newer = f"{int(_newest_migration()) + 1:04d}"
    out = run(fake, "accepts", str(env_dir), str(_revision(tmp_path, newer + "\n")))
    assert out.returncode == 3
    assert out.stdout.strip().splitlines()[-1] == (
        f"This commit has no migration {newer}: the data is newer than this commit, or from "
        "another branch; deploy a commit that has it")


@pytest.mark.parametrize("text, shown", [
    ("abc123", "abc123"),
    ("", ""),
    ("0090 0091", "0090?0091"),
    ("../0001", "..?0001"),
    ("*", "?"),
    ("123456789", "123456789"),
    ("ae1027a6acf\n", "ae1027a6acf"),
])
def test_accepts_refuses_what_isnt_a_migration_number(env_dir: Path, fake: dict[str, str],
                                                      tmp_path: Path, text: str,
                                                      shown: str) -> None:
    out = run(fake, "accepts", str(env_dir), str(_revision(tmp_path, text)))
    assert out.returncode == 3
    assert out.stdout.strip().splitlines()[-1] == f"'{shown}' isn't a ServerSherpa migration number"


def test_accepts_reads_only_the_start_of_the_file(env_dir: Path, fake: dict[str, str],
                                                  tmp_path: Path) -> None:
    out = run(fake, "accepts", str(env_dir), str(_revision(tmp_path, "9" * 5000)))
    assert out.returncode == 3
    assert len(out.stdout) < 200


@pytest.mark.parametrize("args, code", [([], 2), (["/no/such/revision"], 1), (["a", "b"], 2)])
def test_accepts_arguments(env_dir: Path, fake: dict[str, str], args: list[str],
                           code: int) -> None:
    assert run(fake, "accepts", str(env_dir), *args).returncode == code


VERIFY = "run --rm -i --network none postgres:16-alpine pg_restore -f /dev/null"


def test_verify_dump_reads_the_whole_archive_without_a_network(
        env_dir: Path, fake: dict[str, str], tmp_path: Path) -> None:
    dump = _dump(tmp_path)
    out = run(fake, "verify-dump", str(env_dir), str(dump))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [VERIFY]
    assert Path(fake["DOCKER_LOG"] + ".stdin").read_bytes() == b"PGDMP-restore-me"


def test_verify_dump_refuses_a_broken_archive(env_dir: Path, fake: dict[str, str],
                                              tmp_path: Path) -> None:
    dump = _dump(tmp_path)
    out = run({**fake, "FAKE_FAIL_PG_RESTORE": "1"}, "verify-dump", str(env_dir), str(dump))
    assert out.returncode == 1
    assert f"ss-stack: {dump} isn't a complete pg_dump archive" in out.stderr


@pytest.mark.parametrize("args, code", [([], 2), (["/no/such.dump"], 1)])
def test_verify_dump_arguments(env_dir: Path, fake: dict[str, str], args: list[str],
                               code: int) -> None:
    assert run(fake, "verify-dump", str(env_dir), *args).returncode == code
    assert calls(fake) == []


def test_clear_sessions_signs_everyone_out(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "clear-sessions", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [dc(env_dir, "db", f"{PSQL} -c {CLEAR}")]


def test_clear_sessions_reports_a_failure(env_dir: Path, fake: dict[str, str]) -> None:
    out = run({**fake, "FAKE_FAIL_PSQL": "1"}, "clear-sessions", str(env_dir))
    assert out.returncode == 1
    assert "couldn't clear the sessions" in out.stderr


def test_clear_sessions_on_the_managed_database(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, "STACK_EXTERNAL_DATA=1\nSTACK_DB_HOST=db.internal\nSTACK_DB_PORT=25060\n"
                   "STACK_DB_NAME=serversherpa\nSTACK_DB_USER=serversherpa\n")
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "clear-sessions", str(env_dir))
    assert out.returncode == 0, out.stderr
    psql = [c for c in calls(fake) if "auth_sessions" in c]
    assert len(psql) == 1 and "postgres:16-alpine psql" in psql[0] and "PGHOST=db.internal" in psql[0]


SPACES_SECRET = "Spaces-Secret-0123"


def _objects_call(env_dir: Path, action: str, folder: Path, name: str, ro: str = "") -> str:
    uid, gid = os.getuid(), os.getgid()
    return (f"run --rm --network ss-uat --user {uid}:{gid} -e HOME=/tmp "
            "-e SS_OBJECTS_ENDPOINT -e SS_OBJECTS_KEY_ID -e SS_OBJECTS_SECRET -e SS_OBJECTS_BUCKET "
            "-e SS_OBJECTS_REGION -e SS_OBJECTS_PATH_STYLE "
            f"-v {STACK_DIR}/objects.py:/objects.py:ro -v {folder}:/work{ro} "
            f"serversherpa-api:local python /objects.py {action} /work/{name}")


def _objects_env(fake: dict[str, str]) -> list[str]:
    return Path(fake["DOCKER_LOG"] + ".objects").read_text().splitlines()


def test_export_objects_runs_objects_py_in_the_api_image(env_dir: Path, fake: dict[str, str],
                                                         tmp_path: Path) -> None:
    _apps(env_dir, f"SPACES_SECRET_KEY={SPACES_SECRET}\n")
    folder = (tmp_path / "incoming").resolve()
    folder.mkdir()
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "export-objects", str(env_dir),
              str(folder / "files.partial"))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == ["network inspect ss-uat",
                           _objects_call(env_dir, "export", folder, "files.partial")]
    # this host's SeaweedFS, with its fixed key; the secret only in the environment
    assert _objects_env(fake) == [f"endpoint=http://seaweedfs:8333 key=serversherpa "
                                  f"secret={SPACES_SECRET} bucket=serversherpa region=us-east-1 "
                                  "style=true"]
    assert SPACES_SECRET not in "\n".join(calls(fake)) + out.stdout + out.stderr


def test_import_objects_mounts_the_file_read_only(env_dir: Path, fake: dict[str, str],
                                                  tmp_path: Path) -> None:
    folder = tmp_path.resolve()
    src = folder / "files"
    src.write_bytes(b"tar")
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "import-objects", str(env_dir), str(src))
    assert out.returncode == 0, out.stderr
    assert calls(fake)[-1] == _objects_call(env_dir, "import", folder, "files", ":ro")


def test_objects_go_to_the_bucket_the_api_uses(env_dir: Path, fake: dict[str, str],
                                               tmp_path: Path) -> None:
    _apps(env_dir, "STACK_EXTERNAL_DATA=1\nSTACK_IMAGE_TAG=0123456789ab\n"
                   "SS_SPACES_ENDPOINT=https://ams3.digitaloceanspaces.com\n"
                   "SS_SPACES_ACCESS_KEY=DO00KEYID\nSS_SPACES_SECRET_KEY=Do-Secret-1\n"
                   "SS_SPACES_BUCKET=ss-uat-files\nSS_SPACES_REGION=ams3\n"
                   "SS_SPACES_USE_PATH_STYLE=false\n")
    src = tmp_path / "files"
    src.write_bytes(b"tar")
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "import-objects", str(env_dir), str(src))
    assert out.returncode == 0, out.stderr
    assert calls(fake)[-1].endswith("serversherpa-api:0123456789ab python /objects.py import "
                                    "/work/files")
    assert _objects_env(fake) == ["endpoint=https://ams3.digitaloceanspaces.com key=DO00KEYID "
                                  "secret=Do-Secret-1 bucket=ss-uat-files region=ams3 style=false"]
    assert not any("Do-Secret-1" in c or "DO00KEYID" in c for c in calls(fake))


def test_external_objects_need_an_endpoint(env_dir: Path, fake: dict[str, str],
                                           tmp_path: Path) -> None:
    _apps(env_dir, "STACK_EXTERNAL_DATA=1\n")
    out = run(fake, "export-objects", str(env_dir), str(tmp_path / "files"))
    assert out.returncode == 1
    assert "SS_SPACES_ENDPOINT, which isn't set" in out.stderr
    assert calls(fake) == []


def test_a_failed_export_passes_its_exit_code_and_leaves_no_partial(
        env_dir: Path, fake: dict[str, str], tmp_path: Path) -> None:
    target = tmp_path / "files"
    (tmp_path / "files.partial").write_bytes(b"half")   # what a killed objects.py leaves
    out = run({**fake, "FAKE_FAIL_OBJECTS": "1"}, "export-objects", str(env_dir), str(target))
    assert out.returncode == 1
    assert "objects.py: the object store failed" in out.stderr
    assert not (tmp_path / "files.partial").exists() and not target.exists()


@pytest.mark.parametrize("command, make, code, message", [
    ("export-objects", True, 1, "already exists"),
    ("import-objects", False, 1, "no such objects file"),
    ("export-objects", None, 2, "ss-stack build"),
    ("import-objects", None, 2, "ss-stack build"),
])
def test_objects_arguments(env_dir: Path, fake: dict[str, str], tmp_path: Path, command: str,
                           make: bool | None, code: int, message: str) -> None:
    f = tmp_path / "files"
    if make:
        f.write_bytes(b"there")
    args = [] if make is None else [str(f)]
    out = run(fake, command, str(env_dir), *args)
    assert out.returncode == code
    assert message in out.stdout + out.stderr
    assert calls(fake) == []
    if make:
        assert f.read_bytes() == b"there"


@pytest.mark.e2e
@pytest.mark.skipif(os.environ.get("SS_STACK_E2E") != "1", reason="set SS_STACK_E2E=1")
def test_verify_dump_refuses_a_cut_off_real_dump(env_dir: Path, tmp_path: Path) -> None:
    """Real Docker: a real pg_dump passes verify-dump, and the same file cut
    in half fails it (pg_restore --list alone would pass it)."""
    name = f"verifydump{os.getpid() % 10000}"
    subprocess.run(["docker", "run", "-d", "--name", name, "-e", "POSTGRES_PASSWORD=x",
                    "postgres:16-alpine"], check=True, capture_output=True)
    try:
        for _ in range(60):
            if subprocess.run(["docker", "exec", name, "pg_isready", "-U", "postgres"],
                              capture_output=True).returncode == 0:
                break
            time.sleep(1)
        time.sleep(2)
        subprocess.run(["docker", "exec", name, "psql", "-U", "postgres", "-qc",
                        "CREATE TABLE t AS SELECT g, md5(g::text) m FROM generate_series(1, 100000) g"],
                       check=True, capture_output=True)
        full = tmp_path / "full.dump"
        with full.open("wb") as f:
            subprocess.run(["docker", "exec", name, "pg_dump", "-U", "postgres", "-Fc",
                            "--no-owner", "--no-acl"], check=True, stdout=f)
        half = tmp_path / "half.dump"
        half.write_bytes(full.read_bytes()[:full.stat().st_size // 2])
        ok = run(dict(os.environ), "verify-dump", str(env_dir), str(full))
        assert ok.returncode == 0, ok.stderr
        cut = run(dict(os.environ), "verify-dump", str(env_dir), str(half))
        assert cut.returncode == 1 and "isn't a complete pg_dump archive" in cut.stderr
        listed = subprocess.run(["docker", "run", "--rm", "-i", "--network", "none",
                                 "postgres:16-alpine", "pg_restore", "--list"],
                                stdin=half.open("rb"), capture_output=True)
        assert listed.returncode == 0   # why verify-dump reads the whole archive
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)


def test_every_subcommand_slipway_yml_runs_exists() -> None:
    """slipway.yml (how Slipway deploys this repository) runs ss-stack
    subcommands by name; each one must be a case of the script."""
    import re

    from conftest import REPO

    manifest = (REPO / "slipway.yml").read_text()
    used = set(re.findall(r"\[deploy/stack/ss-stack, ([a-z-]+),", manifest))
    assert {"build", "up", "down", "has-data", "data", "pgdump", "verify-dump", "revision",
            "accepts", "restore", "export-objects", "import-objects", "clear-sessions", "seed",
            "admin"} <= used
    script = SS_STACK.read_text()
    for sub in used:
        assert re.search(rf"^  {re.escape(sub)}\)$", script, re.M), sub
    assert (STACK_DIR / "objects.py").is_file()
