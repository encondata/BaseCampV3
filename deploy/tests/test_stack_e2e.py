"""A whole environment on this machine: build every image, start every
stack, check every service answers and every worker stays up, dump the
database, tear it all down. Opt-in (minutes, real containers):

    SS_STACK_E2E=1 $PY -m pytest -c deploy/pytest.ini deploy/tests -m e2e -s

Ports sit in the 18xxx/19xxx range so the Mac dev stack (8000, 8025,
9000, ...) can keep running alongside.
"""
from __future__ import annotations

import base64
import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.request
from collections.abc import Iterator
from pathlib import Path

import pytest

from conftest import REPO, SS_STACK, STACK_DIR, docker_daemon_ok, readme_restore_commands, wait_http

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
          "WIKI": ("web", "wiki"), "SPACES": ("storage", "seaweedfs"),
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
        f"SPACES_SECRET_KEY={secrets.token_hex(16)}",
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
    ("SPACES", "/healthz"), ("STATUS", "/healthz"), ("MAILPIT", "/"),
])
def test_every_service_answers(env_dir: Path, name: str, path: str) -> None:
    url = f"http://127.0.0.1:{PORTS[name]}{path}"
    try:
        status = wait_http(url, timeout=60)
    except TimeoutError as exc:
        pytest.fail(f"{exc}\n{service_logs(env_dir, *OWNERS[name])}")
    assert status == 200, f"{url} answered {status}\n{service_logs(env_dir, *OWNERS[name])}"


def test_spaces_accepts_the_stack_credentials(env_dir: Path) -> None:
    import boto3
    from botocore.config import Config
    secret = dict(l.split("=", 1) for l in (env_dir / ".env").read_text().splitlines()
                  if "=" in l)["SPACES_SECRET_KEY"]
    s3 = boto3.client("s3", endpoint_url=f"http://127.0.0.1:{PORTS['SPACES']}",
                      region_name="us-east-1", aws_access_key_id="serversherpa",
                      aws_secret_access_key=secret,
                      config=Config(s3={"addressing_style": "path"}))
    s3.put_object(Bucket="serversherpa", Key="e2e/probe.txt", Body=b"ok")
    url = s3.generate_presigned_url("get_object", ExpiresIn=60,
                                    Params={"Bucket": "serversherpa", "Key": "e2e/probe.txt"})
    with urllib.request.urlopen(url, timeout=5) as resp:
        assert resp.read() == b"ok"


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


def psql(env_dir: Path, sql: str) -> subprocess.CompletedProcess[str]:
    return compose(env_dir, "db", "exec", "-T", "postgres", "psql", "-U", "serversherpa",
                   "-d", "serversherpa", "-v", "ON_ERROR_STOP=1", "-tAc", sql)


# it stops and restarts the api, web and status stacks
def test_readme_rollback_restores_the_dump_cleanly(env_dir: Path) -> None:
    """The runbook's rollback, end to end: dump, let a "newer migration"
    create a table, then stop, restore with the README's own commands and
    `ss-stack up` again. The table must be gone (or the next forward
    migrate fails with "relation already exists") and migrate at head."""
    dumped = ss("dump", str(env_dir))
    assert dumped.returncode == 0, dumped.stderr
    dump = Path(dumped.stdout.strip())
    made = psql(env_dir, "CREATE TABLE rollback_probe (id int)")
    assert made.returncode == 0, made.stderr

    for stack in ("api", "web", "status"):
        stopped = compose(env_dir, stack, "stop")
        assert stopped.returncode == 0, stopped.stderr
    for command in readme_restore_commands():
        command = (command.replace("/opt/serversherpa/uat/.env", str(env_dir / ".env"))
                          .replace("/opt/serversherpa/uat/backups/<file>.dump", str(dump)))
        out = subprocess.run(["bash", "-c", command], cwd=STACK_DIR,
                             capture_output=True, text=True, timeout=600)
        assert out.returncode == 0, f"{command}\n{out.stdout}{out.stderr}"

    probe = psql(env_dir, "SELECT to_regclass('public.rollback_probe') IS NULL")
    assert probe.stdout.strip() == "t", "a table the dump never held survived the restore"
    up = ss("up", str(env_dir))
    assert up.returncode == 0, up.stdout[-4000:] + up.stderr[-4000:]
    current = compose(env_dir, "api", "exec", "-T", "-w", "/app/api", "api", "alembic", "current")
    assert current.returncode == 0, current.stderr
    assert "(head)" in current.stdout


BUNDLE_TOOL = REPO / "sirdar" / "api" / "src" / "sirdar_api" / "deploy" / "bundle.py"


def _spaces(env_dir: Path):
    import boto3
    from botocore.config import Config
    secret = dict(line.split("=", 1) for line in (env_dir / ".env").read_text().splitlines()
                  if "=" in line)["SPACES_SECRET_KEY"]
    return boto3.client("s3", endpoint_url=f"http://127.0.0.1:{PORTS['SPACES']}",
                        region_name="us-east-1", aws_access_key_id="serversherpa",
                        aws_secret_access_key=secret,
                        config=Config(s3={"addressing_style": "path"}))


def _bundle_tool(env_dir: Path, mount: str, *args: str) -> subprocess.CompletedProcess[str]:
    """bundle.py in a one-off api container on ss-e2e, the way Sirdar's
    export.yml and restore.yml run it."""
    return subprocess.run(
        ["docker", "run", "--rm", "--network", "ss-e2e", "--env-file", str(env_dir / ".env"),
         "--user", f"{os.getuid()}:{os.getgid()}", "-e", "HOME=/tmp", "-v", mount,
         "serversherpa-api:e2e", "python", "/work/bundle.py", *args],
        capture_output=True, text=True, timeout=600)


SIGNED_IN_SQL = """
WITH p AS (INSERT INTO people (first_name, last_name) VALUES ('Snap', 'Probe') RETURNING id),
u AS (INSERT INTO user_accounts (person_id, email)
      SELECT id, 'snap-probe@e2e.serversherpa.test' FROM p RETURNING person_id),
s AS (INSERT INTO auth_sessions (person_id, family_id, token_hash, expires_at)
      SELECT person_id, gen_random_uuid(), 'snap-probe-session', now() + interval '1 day'
      FROM u RETURNING id)
INSERT INTO trusted_devices (person_id, token_hash, expires_at)
SELECT person_id, 'snap-probe-device', now() + interval '30 days' FROM u, s
"""
SESSION_COUNTS = ("SELECT (SELECT count(*) FROM auth_sessions) || '|' || "
                  "(SELECT count(*) FROM trusted_devices)")


# last in the file: it replaces the database and restarts the app stacks
def test_snapshot_commands_round_trip(env_dir: Path, tmp_path: Path) -> None:
    """The real-container half of Sirdar's Take snapshot and Restore snapshot
    steps: export.yml's pg_dump inside the db container and `compose cp`,
    bundle.py's object export and import through the api image on ss-e2e,
    and `ss-stack restore --clear-sessions` and `ss-stack data`."""
    work = tmp_path / "work"
    work.mkdir()
    shutil.copy(BUNDLE_TOOL, work / "bundle.py")
    (work / "bundle.py").chmod(0o644)
    s3 = _spaces(env_dir)
    s3.put_object(Bucket="serversherpa", Key="snap/probe.txt", Body=b"snapshot me",
                  ContentType="text/plain")

    # a signed-in user with a trusted device, so --clear-sessions has rows to clear
    signed_in = psql(env_dir, SIGNED_IN_SQL)
    assert signed_in.returncode == 0, signed_in.stderr

    in_container = "/tmp/sirdar-snapshot.dump"
    for args in (("exec", "-T", "postgres", "pg_dump", "-U", "serversherpa", "-d",
                  "serversherpa", "-Fc", "--no-owner", "--no-acl", "-f", in_container),
                 ("cp", f"postgres:{in_container}", str(work / "db.dump")),
                 ("exec", "-T", "postgres", "rm", "-f", in_container)):
        out = compose(env_dir, "db", *args)
        assert out.returncode == 0, out.stderr
    assert (work / "db.dump").read_bytes()[:5] == b"PGDMP"
    exported = _bundle_tool(env_dir, f"{work}:/work", "export-objects", "--out",
                            "/work/objects.tar")
    assert exported.returncode == 0, exported.stderr
    assert json.loads(exported.stdout)["objects"] >= 1

    assert psql(env_dir, "CREATE TABLE snapshot_probe (id int)").returncode == 0
    s3.delete_object(Bucket="serversherpa", Key="snap/probe.txt")
    restored = ss("restore", str(env_dir), str(work / "db.dump"))
    assert restored.returncode == 0, restored.stdout[-2000:] + restored.stderr[-2000:]
    probe = psql(env_dir, "SELECT to_regclass('public.snapshot_probe') IS NULL")
    assert probe.stdout.strip() == "t", "a table the dump never held survived the restore"
    assert psql(env_dir, SESSION_COUNTS).stdout.strip() == "1|1", "the dump lost the sessions"

    restored = ss("restore", str(env_dir), str(work / "db.dump"), "--clear-sessions")
    assert restored.returncode == 0, restored.stdout[-2000:] + restored.stderr[-2000:]
    assert psql(env_dir, SESSION_COUNTS).stdout.strip() == "0|0"

    imported = _bundle_tool(env_dir, f"{work}:/work:ro", "import-objects", "--in",
                            "/work/objects.tar")
    assert imported.returncode == 0, imported.stderr
    obj = s3.get_object(Bucket="serversherpa", Key="snap/probe.txt")
    assert (obj["Body"].read(), obj["ContentType"]) == (b"snapshot me", "text/plain")

    data = ss("data", str(env_dir))
    assert data.returncode == 0, data.stderr[-2000:]
    up = ss("up", str(env_dir))
    assert up.returncode == 0, up.stdout[-4000:] + up.stderr[-4000:]
    current = compose(env_dir, "api", "exec", "-T", "-w", "/app/api", "api", "alembic", "current")
    assert "(head)" in current.stdout
