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
  # does the devices database exist? (FAKE_DEVICES_DB: yes)
  *"-tAc SELECT 1 FROM pg_database WHERE datname = 'serversherpa_devices'")
    [[ -n "${FAKE_DEVICES_DB:-}" ]] && echo 1 ;;
  *"pg_dump"*"serversherpa_devices"*)
    [[ -n "${FAKE_FAIL_DEVICES_DUMP:-}" ]] && { printf 'PGDMP-cut'; exit 1; }
    printf 'PGDMP-devices' ;;
  *"pg_restore"*"serversherpa_devices"*)
    cat > "$DOCKER_LOG.devices-stdin"
    [[ -n "${FAKE_FAIL_DEVICES_RESTORE:-}" ]] && exit 1 ;;
  "network inspect "*) [[ -n "${FAKE_NETWORK_EXISTS:-}" ]] && exit 0 || exit 1 ;;
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
  *"/api/compose.yml up "*)
    # the apps the API is told run (SS_APPS comes from STACK_APPS; unset: the .env's)
    printf 'STACK_APPS=%s\n' "${STACK_APPS-unset}" >> "$DOCKER_LOG.apps" ;;
  # SQL on stdin (the devices database): recorded, so a test can read it
  *"psql -U serversherpa -d serversherpa -v ON_ERROR_STOP=1 -q"|*" psql -v ON_ERROR_STOP=1 -q")
    cat >> "$DOCKER_LOG.sql"
    [[ -n "${FAKE_FAIL_PSQL_STDIN:-}" ]] && exit 1 ;;
esac
exit 0
"""


DEVICES_SECRETS = "SS_DEVICES_SERVICE_TOKEN=0123abcd\nDEVICES_SECRET_KEY=0123abcd\n"


@pytest.fixture
def env_dir(tmp_path: Path) -> Path:
    d = tmp_path / "uat"
    d.mkdir()
    text = ENV_EXAMPLE.read_text().replace("=CHANGEME", "=0123abcd")
    # every app runs (no STACK_APPS), so the devices app's secrets too
    text += DEVICES_SECRETS
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


# the devices service's own database, created once (CREATE DATABASE has no IF NOT EXISTS)
DEVICES_DB = "exec -T postgres psql -U serversherpa -d serversherpa -v ON_ERROR_STOP=1 -q"
DEVICES_SQL = ("SELECT 'CREATE DATABASE serversherpa_devices' WHERE NOT EXISTS "
               "(SELECT FROM pg_database WHERE datname = 'serversherpa_devices')\\gexec\n")


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
        dc(env_dir, "db", DEVICES_DB),
        dc(env_dir, "devices", wait),
        dc(env_dir, "status", wait),
    ]
    assert Path(fake["DOCKER_LOG"] + ".sql").read_text() == DEVICES_SQL


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
    assert calls(fake) == [dc(env_dir, s, "down")
                           for s in ("status", "devices", "web", "api", "storage", "db")]


def test_down_volumes_deletes_data_and_the_network(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "down", str(env_dir), "--volumes")
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [
        *[dc(env_dir, s, "down --volumes")
          for s in ("status", "devices", "web", "api", "storage", "db")],
        "network rm ss-uat",
    ]


def test_ps_lists_every_stack(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "ps", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [dc(env_dir, s, "ps")
                           for s in ("db", "storage", "api", "web", "devices", "status")]


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
                              "exec -T postgres pg_dump -U serversherpa -d serversherpa -Fc"),
                           dc(env_dir, "db", DEVICES_EXISTS)]
    assert not (backups / "devices").exists()   # no devices database, no devices dump
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


# ---- the devices database (serversherpa_devices) rides along with dump and restore ----

DEVICES_EXISTS = ("exec -T postgres psql -U serversherpa -d serversherpa -tAc SELECT 1 FROM "
                  "pg_database WHERE datname = 'serversherpa_devices'")
DEVICES_DUMP = "exec -T postgres pg_dump -U serversherpa -d serversherpa_devices -Fc"
EXTERNAL = ("STACK_EXTERNAL_DATA=1\nSTACK_DB_HOST=db.internal\nSTACK_DB_PORT=25060\n"
            "STACK_DB_NAME=serversherpa\nSTACK_DB_USER=serversherpa\n")


def test_dump_writes_the_devices_database_beside_the_main_one(env_dir: Path,
                                                              fake: dict[str, str]) -> None:
    out = run({**fake, "FAKE_DEVICES_DB": "1"}, "dump", str(env_dir))
    assert out.returncode == 0, out.stderr
    new = Path(out.stdout.strip())       # one line: the main dump
    backups = env_dir / "backups"
    assert calls(fake) == [
        dc(env_dir, "db", "exec -T postgres pg_dump -U serversherpa -d serversherpa -Fc"),
        dc(env_dir, "db", DEVICES_EXISTS),
        dc(env_dir, "db", DEVICES_DUMP),
    ]
    sibling = backups / "devices" / new.name
    assert new.read_text() == "PGDMP-fake" and sibling.read_text() == "PGDMP-devices"
    assert sibling.stat().st_mode & 0o777 == 0o600
    assert (backups / "devices").stat().st_mode & 0o777 == 0o700
    # only the main dump is a backup (backups/*.dump); no partial is left
    assert [p.name for p in backups.glob("*.dump")] == [new.name]
    assert list(backups.rglob("*.partial")) == []


@pytest.mark.parametrize("devices_db", [True, False])
def test_rotation_removes_the_devices_dump_with_its_main_dump(env_dir: Path, fake: dict[str, str],
                                                              devices_db: bool) -> None:
    backups = env_dir / "backups"
    (backups / "devices").mkdir(parents=True)
    for i in range(6):
        (backups / f"20200101T00000{i}Z.dump").write_text("old")
        (backups / "devices" / f"20200101T00000{i}Z.dump").write_text("old")
    env = {**fake, "FAKE_DEVICES_DB": "1"} if devices_db else fake
    out = run(env, "dump", str(env_dir))
    assert out.returncode == 0, out.stderr
    new = Path(out.stdout.strip()).name
    mains = {p.name for p in backups.glob("*.dump")}
    assert len(mains) == 5 and new in mains
    siblings = {p.name for p in (backups / "devices").glob("*.dump")}
    assert siblings == (mains if devices_db else mains - {new})


def test_a_failed_devices_dump_keeps_no_backup(env_dir: Path, fake: dict[str, str]) -> None:
    out = run({**fake, "FAKE_DEVICES_DB": "1", "FAKE_FAIL_DEVICES_DUMP": "1"},
              "dump", str(env_dir))
    assert out.returncode != 0
    assert "pg_dump of the devices database failed" in out.stderr
    backups = env_dir / "backups"
    assert list(backups.rglob("*.dump")) == []
    assert list(backups.rglob("*.partial")) == []


def test_external_dump_writes_the_devices_database_and_leaves_no_ca_file(
        env_dir: Path, fake: dict[str, str], tmp_path: Path) -> None:
    """The existence check reads psql's output ($(…), a subshell): the CA
    file must still be this shell's, so nothing is left behind."""
    tmp = tmp_path / "tmp"
    tmp.mkdir()
    _apps(env_dir, EXTERNAL + f"SS_DATABASE_CA_B64={_ca_b64()}\n")
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1", "FAKE_DEVICES_DB": "1", "TMPDIR": str(tmp)},
              "dump", str(env_dir))
    assert out.returncode == 0, out.stderr
    pg = [x for x in calls(fake) if x.startswith("run --rm -i --network ss-uat ")]
    assert len(pg) == 3
    main, exists, devices = pg
    assert main.endswith("postgres:16-alpine pg_dump -Fc")
    assert exists.endswith("postgres:16-alpine psql -tAc SELECT 1 FROM pg_database "
                           "WHERE datname = 'serversherpa_devices'")
    assert devices.endswith("postgres:16-alpine pg_dump -d serversherpa_devices -Fc")
    assert all("-e PGSSLMODE=verify-full" in x for x in pg)
    assert not any("/db/compose.yml" in x for x in calls(fake))
    new = Path(out.stdout.strip())
    assert (new.parent / "devices" / new.name).read_text() == "PGDMP-devices"
    assert list(tmp.iterdir()) == []


@pytest.mark.parametrize("command", ["pgdump", "revision"])
def test_pgdump_and_revision_stay_on_the_main_database(env_dir: Path, fake: dict[str, str],
                                                       command: str, tmp_path: Path) -> None:
    extra = [str(tmp_path / "out.dump")] if command == "pgdump" else []
    out = run({**fake, "FAKE_DEVICES_DB": "1"}, command, str(env_dir), *extra)
    assert out.returncode == 0, out.stderr
    assert not any("serversherpa_devices" in c for c in calls(fake))


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
        dc(env_dir, "status", "stop"), dc(env_dir, "devices", "stop"),
        dc(env_dir, "web", "stop"), dc(env_dir, "api", "stop"),
        dc(env_dir, "db", WAIT),
        dc(env_dir, "db", f"{PSQL} -c DROP SCHEMA public CASCADE; CREATE SCHEMA public;"),
        dc(env_dir, "db", "exec -T postgres pg_restore --exit-on-error --no-owner --no-acl "
                          "-U serversherpa -d serversherpa"),
        dc(env_dir, "db", f"{PSQL} -c {CLEAR}"),
    ]
    assert Path(fake["DOCKER_LOG"] + ".stdin").read_bytes() == b"PGDMP-restore-me"


DEVICES_PSQL = "exec -T postgres psql -U serversherpa -d serversherpa_devices -v ON_ERROR_STOP=1 -q"


def _devices_dump(dump: Path) -> Path:
    sibling = dump.parent / "devices" / dump.name
    sibling.parent.mkdir()
    sibling.write_bytes(b"PGDMP-devices-restore-me")
    return sibling


def test_restore_restores_the_devices_database_from_its_sibling_dump(
        env_dir: Path, fake: dict[str, str], tmp_path: Path) -> None:
    dump = _dump(tmp_path)
    _devices_dump(dump)
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "restore", str(env_dir), str(dump),
              "--clear-sessions")
    assert out.returncode == 0, out.stderr
    c = calls(fake)
    main_restore = c.index(dc(env_dir, "db", "exec -T postgres pg_restore --exit-on-error "
                                             "--no-owner --no-acl -U serversherpa -d serversherpa"))
    assert c[main_restore + 1:] == [
        dc(env_dir, "db", f"{PSQL} -c {CLEAR}"),
        # an environment that never ran devices gets the database first
        dc(env_dir, "db", DEVICES_DB),
        dc(env_dir, "db", f"{DEVICES_PSQL} -c DROP SCHEMA public CASCADE; CREATE SCHEMA public;"),
        dc(env_dir, "db", "exec -T postgres pg_restore -U serversherpa -d serversherpa_devices "
                          "--exit-on-error --no-owner --no-acl"),
    ]
    assert Path(fake["DOCKER_LOG"] + ".sql").read_text() == DEVICES_SQL
    assert Path(fake["DOCKER_LOG"] + ".stdin").read_bytes() == b"PGDMP-restore-me"
    assert Path(fake["DOCKER_LOG"] + ".devices-stdin").read_bytes() == b"PGDMP-devices-restore-me"


def test_restore_without_a_devices_dump_leaves_the_devices_database(
        env_dir: Path, fake: dict[str, str], tmp_path: Path) -> None:
    # a backup from before devices was dumped: the main database only
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "restore", str(env_dir), str(_dump(tmp_path)))
    assert out.returncode == 0, out.stderr
    assert not any("serversherpa_devices" in c for c in calls(fake))
    assert not Path(fake["DOCKER_LOG"] + ".sql").exists()


def test_restore_reports_a_failed_devices_restore(env_dir: Path, fake: dict[str, str],
                                                  tmp_path: Path) -> None:
    dump = _dump(tmp_path)
    _devices_dump(dump)
    out = run({**fake, "FAKE_FAIL_DEVICES_RESTORE": "1"}, "restore", str(env_dir), str(dump),
              "--clear-sessions")
    assert out.returncode != 0
    assert "pg_restore of the devices database failed" in out.stderr
    # the message says what state it left: the main database is restored
    # (and signed out) already, the devices one emptied and maybe partly restored
    assert "the main database is already restored" in out.stderr
    assert "serversherpa_devices is now empty or only partly restored" in out.stderr
    assert "run the restore again" in out.stderr
    assert "restored " not in out.stdout
    c = calls(fake)
    main_restore = c.index(dc(env_dir, "db", "exec -T postgres pg_restore --exit-on-error "
                                             "--no-owner --no-acl -U serversherpa -d serversherpa"))
    devices_restore = c.index(dc(env_dir, "db", "exec -T postgres pg_restore -U serversherpa "
                                                "-d serversherpa_devices --exit-on-error "
                                                "--no-owner --no-acl"))
    assert main_restore < c.index(dc(env_dir, "db", f"{PSQL} -c {CLEAR}")) < devices_restore
    assert c[devices_restore - 1] == dc(
        env_dir, "db", f"{DEVICES_PSQL} -c DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    assert Path(fake["DOCKER_LOG"] + ".stdin").read_bytes() == b"PGDMP-restore-me"


def test_restore_says_the_devices_database_is_untouched_when_it_stops_before_it(
        env_dir: Path, fake: dict[str, str], tmp_path: Path) -> None:
    dump = _dump(tmp_path)
    _devices_dump(dump)
    out = run({**fake, "FAKE_FAIL_PSQL_STDIN": "1"}, "restore", str(env_dir), str(dump))
    assert out.returncode != 0
    assert "couldn't create the devices database" in out.stderr
    assert "the main database is already restored" in out.stderr
    assert "serversherpa_devices is as it was" in out.stderr
    assert not Path(fake["DOCKER_LOG"] + ".devices-stdin").exists()


def test_external_restore_restores_the_devices_database(env_dir: Path, fake: dict[str, str],
                                                        tmp_path: Path) -> None:
    dump = _dump(tmp_path)
    _devices_dump(dump)
    _apps(env_dir, EXTERNAL)
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "restore", str(env_dir), str(dump))
    assert out.returncode == 0, out.stderr
    pg = [x for x in calls(fake) if x.startswith("run --rm -i --network ss-uat ")]
    assert [x.split("postgres:16-alpine ", 1)[1] for x in pg] == [
        "psql -v ON_ERROR_STOP=1 -q -c DROP SCHEMA public CASCADE; CREATE SCHEMA public;",
        "pg_restore --exit-on-error --no-owner --no-acl -d serversherpa",
        "psql -v ON_ERROR_STOP=1 -q",
        ("psql -d serversherpa_devices -v ON_ERROR_STOP=1 -q -c DROP SCHEMA public CASCADE; "
         "CREATE SCHEMA public;"),
        "pg_restore -d serversherpa_devices --exit-on-error --no-owner --no-acl",
    ]
    assert all("-e PGSSLMODE=require" in x for x in pg)
    assert not any("/db/compose.yml" in x for x in calls(fake))
    assert Path(fake["DOCKER_LOG"] + ".devices-stdin").read_bytes() == b"PGDMP-devices-restore-me"


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


def test_a_data_vm_lets_its_app_servers_reach_the_devices_database(env_dir: Path,
                                                                    fake: dict[str, str]) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(LAN_DATA)
    out = run(fake, "data", str(env_dir))
    assert out.returncode == 0, out.stderr
    hosts = [line for line in (env_dir / "pg_hba.conf").read_text().splitlines()
             if line.startswith("host ")]
    assert hosts == [
        "host all all 127.0.0.1/32 scram-sha-256",
        "host serversherpa serversherpa 10.10.48.48/32 scram-sha-256",
        "host serversherpa_devices serversherpa 10.10.48.48/32 scram-sha-256",
        "host serversherpa serversherpa 10.10.48.49/32 scram-sha-256",
        "host serversherpa_devices serversherpa 10.10.48.49/32 scram-sha-256",
    ]


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


@pytest.mark.parametrize("command", ["down", "ps", "dump", "pgdump", "revision"])
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


# pg_hba.conf as an ss-stack from before the devices database wrote it
OLD_HBA = ("# Written by ss-stack from STACK_DB_ALLOW: edits are replaced.\n"
           "local all all trust\n"
           "host all all 127.0.0.1/32 scram-sha-256\n"
           "host serversherpa serversherpa 10.10.48.48/32 scram-sha-256\n"
           "host serversherpa serversherpa 10.10.48.49/32 scram-sha-256\n")


def test_hba_puts_back_the_lines_an_older_data_left_out(env_dir: Path,
                                                        fake: dict[str, str]) -> None:
    """Sirdar runs hba on the data VM before the pre-deploy dump: an older
    commit's `ss-stack data` wrote the file without the devices database."""
    with (env_dir / ".env").open("a") as f:
        f.write(LAN_DATA)
    hba = env_dir / "pg_hba.conf"
    hba.write_text(OLD_HBA)
    hba.chmod(0o644)
    inode = hba.stat().st_ino
    out = run({**fake, "FAKE_DB_RUNNING": "1"}, "hba", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "pg_hba.conf updated; Postgres reread it"
    assert hba.stat().st_ino == inode
    assert "host serversherpa_devices serversherpa 10.10.48.49/32 scram-sha-256" in hba.read_text()
    # the same file `data` writes, and nothing else runs: no compose up
    log = calls(fake)
    assert [c for c in log if RELOAD in c] and not any(" up " in c for c in log)
    assert all(f"-f {STACK_DIR}/db/lan.yml" in c for c in log if "/db/compose.yml" in c)
    written = hba.read_text()
    hba.unlink()
    assert run(fake, "data", str(env_dir)).returncode == 0
    assert hba.read_text() == written


def test_hba_writes_a_stopped_database_s_file_without_a_reload(env_dir: Path,
                                                               fake: dict[str, str]) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(LAN_DATA)
    (env_dir / "pg_hba.conf").write_text(OLD_HBA)
    out = run(fake, "hba", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "pg_hba.conf updated"
    assert not any(RELOAD in c for c in calls(fake))
    assert "serversherpa_devices" in (env_dir / "pg_hba.conf").read_text()


def test_hba_leaves_a_current_file_alone(env_dir: Path, fake: dict[str, str]) -> None:
    with (env_dir / ".env").open("a") as f:
        f.write(LAN_DATA)
    assert run(fake, "data", str(env_dir)).returncode == 0
    Path(fake["DOCKER_LOG"]).write_text("")
    out = run({**fake, "FAKE_DB_RUNNING": "1"}, "hba", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "pg_hba.conf already up to date"
    assert not any(RELOAD in c for c in calls(fake))


def test_hba_is_for_a_data_vm_only(env_dir: Path, fake: dict[str, str]) -> None:
    out = run(fake, "hba", str(env_dir))
    assert out.returncode != 0 and "STACK_DB_PUBLISH" in out.stderr
    assert calls(fake) == [] and not (env_dir / "pg_hba.conf").exists()
    out = run(fake, "hba", str(env_dir), "extra")
    assert out.returncode == 2 and "ss-stack hba" in out.stdout + out.stderr


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
    _apps(env_dir, "STACK_APPS=wiki,kiosk,learn,status,devices,mailpit\n")
    assert run(fake, "up", str(env_dir)).returncode == 0
    c = calls(fake)
    for stack in ("storage", "api", "web", "devices", "status"):
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
    "Devices", "device",
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
    for stack in ("storage", "api", "web", "devices", "status"):
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


@pytest.mark.parametrize("args, commands", [
    ((), ["seed-label-fonts", "seed-label-templates"]),
    (("--learning",), ["seed-label-fonts", "seed-label-templates", "learning-seed"]),
])
def test_seed_runs_the_starter_content_commands_in_the_api_container(
        env_dir: Path, fake: dict[str, str], args: tuple[str, ...], commands: list[str]) -> None:
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


# ---- the devices service (STACK_APPS: devices) ----

def test_devices_off_stops_its_stack_and_skips_its_database(env_dir: Path,
                                                            fake: dict[str, str]) -> None:
    _apps(env_dir, SMTP + "STACK_APPS=wiki\n")
    out = run(fake, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    c = calls(fake)
    assert dc(env_dir, "devices", "down") in c
    assert dc(env_dir, "devices", WAIT) not in c
    assert dc(env_dir, "db", DEVICES_DB) not in c
    assert not Path(fake["DOCKER_LOG"] + ".sql").exists()
    # still in its place: after web, before status
    assert c.index(dc(env_dir, "web", f"{WAIT} --scale kiosk=0 --scale learn=0")) \
        < c.index(dc(env_dir, "devices", "down")) < c.index(dc(env_dir, "status", "down"))


def test_devices_on_creates_its_database_then_starts(env_dir: Path,
                                                     fake: dict[str, str]) -> None:
    _apps(env_dir, SMTP + "STACK_APPS=devices\n")
    out = run(fake, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    c = calls(fake)
    assert c.index(dc(env_dir, "db", DEVICES_DB)) == c.index(dc(env_dir, "devices", WAIT)) - 1
    assert dc(env_dir, "devices", "down") not in c


def test_devices_database_on_the_external_database(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, "STACK_EXTERNAL_DATA=1\nSTACK_DB_HOST=db.internal\nSTACK_DB_PORT=25060\n"
                   "STACK_DB_NAME=serversherpa\nSTACK_DB_USER=serversherpa\n")
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1"}, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    c = calls(fake)
    create = next(i for i, x in enumerate(c) if x.endswith(" psql -v ON_ERROR_STOP=1 -q"))
    assert c[create].startswith("run --rm -i --network ss-uat ")
    assert "-e PGSSLMODE=require" in c[create] and "-e PGHOST=db.internal" in c[create]
    assert "postgres:16-alpine psql" in c[create]
    assert c[create + 1] == dc(env_dir, "devices", WAIT)
    assert not any("/db/compose.yml" in x for x in c)
    assert Path(fake["DOCKER_LOG"] + ".sql").read_text() == DEVICES_SQL


def test_a_failed_devices_database_stops_before_the_devices_stack(env_dir: Path,
                                                                  fake: dict[str, str]) -> None:
    out = run({**fake, "FAKE_FAIL_PSQL_STDIN": "1"}, "up", str(env_dir))
    assert out.returncode != 0
    assert "couldn't create the devices database" in out.stderr
    assert dc(env_dir, "devices", WAIT) not in calls(fake)


def test_external_down_walks_devices_too(env_dir: Path, fake: dict[str, str]) -> None:
    _apps(env_dir, "STACK_EXTERNAL_DATA=1\n")
    out = run(fake, "down", str(env_dir))
    assert out.returncode == 0, out.stderr
    assert calls(fake) == [dc(env_dir, s, "down")
                           for s in ("status", "devices", "web", "api", "storage")]


def _ca_b64() -> str:
    import base64
    import datetime as dt

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "fixture-ca")])
    now = dt.datetime.now(dt.UTC)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(1)
            .not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(now + dt.timedelta(days=1))
            .sign(key, hashes.SHA256()))
    return base64.b64encode(cert.public_bytes(serialization.Encoding.PEM)).decode()


def test_the_devices_database_with_a_ca_leaves_no_ca_file(env_dir: Path, fake: dict[str, str],
                                                          tmp_path: Path) -> None:
    """pg() writes the CA to a temp file only this shell removes: the devices
    database must not be created from a subshell (a pipe)."""
    tmp = tmp_path / "tmp"
    tmp.mkdir()
    _apps(env_dir, "STACK_EXTERNAL_DATA=1\nSTACK_DB_HOST=db.internal\nSTACK_DB_PORT=25060\n"
                   "STACK_DB_NAME=serversherpa\nSTACK_DB_USER=serversherpa\n"
                   f"SS_DATABASE_CA_B64={_ca_b64()}\n")
    out = run({**fake, "FAKE_NETWORK_EXISTS": "1", "TMPDIR": str(tmp)}, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    create = next(x for x in calls(fake) if x.endswith(" psql -v ON_ERROR_STOP=1 -q"))
    assert "-e PGSSLMODE=verify-full" in create
    assert Path(fake["DOCKER_LOG"] + ".sql").read_text() == DEVICES_SQL
    assert list(tmp.iterdir()) == []


def _without_devices_secrets(env_dir: Path, extra: str = "") -> None:
    env_file = env_dir / ".env"
    env_file.write_text(env_file.read_text().replace(DEVICES_SECRETS, "") + extra)


@pytest.mark.parametrize("extra, missing", [
    ("STACK_APPS=wiki,devices,mailpit\n", "SS_DEVICES_SERVICE_TOKEN DEVICES_SECRET_KEY"),
    ("STACK_APPS=devices,mailpit\nSS_DEVICES_SERVICE_TOKEN=0123abcd\n", "DEVICES_SECRET_KEY"),
    ("STACK_APPS=wiki,devices,mailpit\nDEVICES_SECRET_KEY=0123abcd\n", "SS_DEVICES_SERVICE_TOKEN"),
])
def test_explicit_devices_without_secrets_dies(env_dir: Path, fake: dict[str, str], extra: str,
                                               missing: str) -> None:
    _without_devices_secrets(env_dir, extra)
    out = run(fake, "up", str(env_dir))
    assert out.returncode != 0
    assert (f"The devices app is on (STACK_APPS lists it): set {missing} in "
            f"{env_dir}/.env, or leave devices out of STACK_APPS.") in out.stderr
    assert calls(fake) == []


def _apps_seen(env: dict[str, str]) -> list[str]:
    path = Path(env["DOCKER_LOG"] + ".apps")
    return path.read_text().splitlines() if path.exists() else []


@pytest.mark.parametrize("extra", [
    "",                                            # no STACK_APPS (uat's .env)
    "STACK_APPS=\n",
    "SS_DEVICES_SERVICE_TOKEN=0123abcd\n",         # one secret isn't enough
    "SS_DEVICES_SERVICE_TOKEN=0123abcd\nDEVICES_SECRET_KEY=\n",
])
def test_empty_stack_apps_without_devices_secrets_skips_devices(
        env_dir: Path, fake: dict[str, str], extra: str) -> None:
    """"Every app" means devices only once its secrets are set: an existing
    .env without them keeps working, the devices stack stays stopped, and
    the API is told the apps that run (no Devices link in the portal)."""
    _without_devices_secrets(env_dir, extra)
    out = run(fake, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    c = calls(fake)
    assert dc(env_dir, "devices", "down") in c
    assert dc(env_dir, "devices", WAIT) not in c
    assert dc(env_dir, "db", DEVICES_DB) not in c
    for stack in ("storage", "api", "web", "status"):
        assert dc(env_dir, stack, WAIT) in c, stack
    assert _apps_seen(fake) == ["STACK_APPS=wiki,kiosk,learn,status,mailpit"]


def test_empty_stack_apps_with_devices_secrets_runs_devices(env_dir: Path,
                                                            fake: dict[str, str]) -> None:
    out = run({k: v for k, v in fake.items() if k != "STACK_APPS"}, "up", str(env_dir))
    assert out.returncode == 0, out.stderr
    c = calls(fake)
    assert c.index(dc(env_dir, "db", DEVICES_DB)) == c.index(dc(env_dir, "devices", WAIT)) - 1
    # every app runs: the API reads the .env's own (empty) STACK_APPS
    assert _apps_seen(fake) == ["STACK_APPS=unset"]


def test_devices_secrets_left_at_changeme_are_refused(env_dir: Path, fake: dict[str, str]) -> None:
    _without_devices_secrets(env_dir, "SS_DEVICES_SERVICE_TOKEN=CHANGEME\nDEVICES_SECRET_KEY=x\n")
    out = run(fake, "up", str(env_dir))
    assert out.returncode != 0 and "SS_DEVICES_SERVICE_TOKEN" in out.stderr
    assert calls(fake) == []


@pytest.mark.parametrize("command", ["up", "down", "ps"])
def test_devices_off_needs_no_devices_secrets(env_dir: Path, fake: dict[str, str],
                                              command: str) -> None:
    """An environment without the devices app (every Sirdar-written .env
    today) carries no devices secrets: up stops the devices stack, and down
    and ps walk it, all without them."""
    _without_devices_secrets(env_dir, SMTP + "STACK_APPS=wiki,kiosk,learn,status,mailpit\n")
    out = run(fake, command, str(env_dir))
    assert out.returncode == 0, out.stderr
    verb = {"up": "down", "down": "down", "ps": "ps"}[command]
    assert dc(env_dir, "devices", verb) in calls(fake)
    assert dc(env_dir, "devices", WAIT) not in calls(fake)
