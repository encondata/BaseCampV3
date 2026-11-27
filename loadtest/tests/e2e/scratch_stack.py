"""A throwaway BaseCamp server for trying the load test against the real API.

    scratch_stack.sh up | down | status | restart

`restart` stops and starts the three processes only (to pick up
LOADTEST_SCRATCH_TOKEN_SECONDS / LOADTEST_SCRATCH_SESSION_SECONDS, which shorten the
access token and sign-in lifetimes so refresh and re-sign-in show up in a short run).

`up` makes the database `serversherpa_loadtest` on the dev Postgres container, restores
the clean starter dump into it, migrates it to head, makes the object storage bucket
`serversherpa-loadtest`, creates a super admin with a generated password, and starts an
API on 127.0.0.1:8010 plus one import worker and one scan-matching worker. They run from
the main checkout's code and virtualenv, with every setting that differs from the dev
stack set by environment only. `down` stops exactly the processes `up` started, drops
the scratch database and removes the scratch bucket.

The database and bucket names are fixed below and are never read from an argument or
the environment. Every statement that creates, changes or drops a database checks the
name first and refuses anything else. Nothing here ever connects to the dev database.

Run it with the API's virtualenv Python (it needs boto3). Logs, pid files and the
admin password go to LOADTEST_SCRATCH_DIR (default: a folder in the system temp dir).
No secret is ever printed.
"""

from __future__ import annotations

import os
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

SCRATCH_DB = "serversherpa_loadtest"          # the only database this script touches
SCRATCH_BUCKET = "serversherpa-loadtest"      # the only bucket this script touches
CONTAINER = "serversherpa-dev-postgres-1"
API_HOST, API_PORT = "127.0.0.1", 8010
STORAGE_ENDPOINT = "http://127.0.0.1:9000"
ADMIN_EMAIL = "loadtest-admin@example.com"

HERE = Path(__file__).resolve()
SCRATCH = Path(os.environ.get("LOADTEST_SCRATCH_DIR")
               or Path(tempfile.gettempdir()) / "loadtest-scratch").resolve()


def repo_root() -> Path:
    """The main checkout (it holds .env and api/.venv), also from a worktree."""
    common = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
                            cwd=HERE.parent, capture_output=True, text=True, check=True)
    return Path(common.stdout.strip()).parent


REPO = repo_root()
VENV = REPO / "api" / ".venv" / "bin"
DUMP = REPO / "api" / "backups" / "clean-starter-20NOV26.sql"

PROCESSES = {
    "api": [str(VENV / "python"), "-m", "uvicorn", "--factory",
            "serversherpa.api.app:create_app", "--app-dir", str(REPO / "api" / "src"),
            "--host", API_HOST, "--port", str(API_PORT), "--no-access-log"],
    "import-worker": [str(VENV / "serversherpa"), "import-worker"],
    "scan-matching-worker": [str(VENV / "serversherpa"), "scan-matching-worker"],
}


# what each process's command line must contain to count as ours (ps shows the real
# interpreter, not the virtualenv's link to it)
SIGNATURES = {
    "api": ("serversherpa.api.app:create_app", f"--port {API_PORT}", "--no-access-log"),
    "import-worker": (str(VENV / "serversherpa"), " import-worker"),
    "scan-matching-worker": (str(VENV / "serversherpa"), " scan-matching-worker"),
}


def say(text: str) -> None:
    print(text, flush=True)


def die(text: str) -> None:
    print(f"scratch_stack: {text}", file=sys.stderr, flush=True)
    sys.exit(1)


def require_scratch(name: str) -> str:
    """Every database statement goes through this: anything but the scratch name stops."""
    if name != SCRATCH_DB:
        die(f"refusing to touch database {name!r}: only {SCRATCH_DB} is allowed")
    return name


def require_bucket(name: str) -> str:
    if name != SCRATCH_BUCKET:
        die(f"refusing to touch bucket {name!r}: only {SCRATCH_BUCKET} is allowed")
    return name


# ── the dev .env, read without echoing ─────────────────────────────────


def dotenv() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (REPO / ".env").read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def scratch_database_url(dev_url: str) -> str:
    parts = urlsplit(dev_url)
    url = urlunsplit(parts._replace(path="/" + SCRATCH_DB))
    require_scratch(urlsplit(url).path.lstrip("/"))
    return url


def process_env() -> dict[str, str]:
    """The dev settings with the scratch database, bucket and address, and every
    outbound side effect switched off (empty means off in config.py and its callers)."""
    env_file = dotenv()
    env = {k: v for k, v in os.environ.items() if not k.startswith("SS_")}
    env.update({
        "SS_ENV": "development",           # refresh cookies usable over plain http
        "SS_DATABASE_URL": scratch_database_url(env_file["SS_DATABASE_URL"]),
        "SS_DATABASE_SSL": "disable",
        "SS_API_BASE_URL": f"http://{API_HOST}:{API_PORT}",
        "SS_SPACES_ENDPOINT": STORAGE_ENDPOINT,
        "SS_SPACES_BUCKET": require_bucket(SCRATCH_BUCKET),
        "SS_SPACES_USE_PATH_STYLE": "true",
        "SS_FCM_SERVICE_ACCOUNT_FILE": "",       # push/fcm.py: empty path → no client
        "SS_FCM_SERVICE_ACCOUNT_B64": "",        # notifications/push.py: push_enabled False
        "SS_SMTP_HOST": "",                      # mail/outbox.py: no host → mail off
        "SS_SMTP_FROM": "",
        "SS_SENTRY_DSN": "",
        "SS_AI_ENABLED": "false",                # ai/client.py
        "SS_ANTHROPIC_API_KEY": "",              # spec_lookup/provider.py: no key → off
        "SS_LABELARY_BASE_URL": "http://127.0.0.1:9",
        "SS_ATTESTATION_STATUS_URL": "http://127.0.0.1:9/attestation",
        "SS_COOKIE_DOMAIN": "",
    })
    # short sign-ins, to see token refresh and re-sign-in within a short run
    for ours, theirs in (("LOADTEST_SCRATCH_TOKEN_SECONDS", "SS_ACCESS_TOKEN_TTL_SECONDS"),
                         ("LOADTEST_SCRATCH_SESSION_SECONDS", "SS_SESSION_TTL_SECONDS")):
        if os.environ.get(ours):
            env[theirs] = str(int(os.environ[ours]))
    return env


# ── Postgres through the container's own psql ──────────────────────────


def psql(database: str, sql: str | None = None, *, stdin_path: Path | None = None,
         quiet: bool = True) -> str:
    """Runs psql in the dev Postgres container against `database`, which must be the
    scratch database or `postgres` (only for CREATE/DROP of the scratch database)."""
    if database != "postgres":
        require_scratch(database)
    user = dotenv().get("POSTGRES_USER") or "postgres"
    cmd = ["docker", "exec", "-i", CONTAINER, "psql", "-X", "-v", "ON_ERROR_STOP=1",
           "-U", user, "-d", database, "-At"]
    if quiet:
        cmd += ["-q"]
    if sql is not None:
        cmd += ["-c", sql]
    stdin = open(stdin_path, "rb") if stdin_path else subprocess.DEVNULL
    try:
        done = subprocess.run(cmd, stdin=stdin, capture_output=True, timeout=600)
    finally:
        if stdin_path:
            stdin.close()
    if done.returncode != 0:
        die(f"psql on {database} failed: {done.stderr.decode(errors='replace')[-800:]}")
    return done.stdout.decode()


def database_exists() -> bool:
    name = require_scratch(SCRATCH_DB)
    return psql("postgres", f"SELECT 1 FROM pg_database WHERE datname = '{name}'").strip() == "1"


def create_database() -> None:
    psql("postgres", f"CREATE DATABASE {require_scratch(SCRATCH_DB)}")


def drop_database() -> None:
    psql("postgres", f"DROP DATABASE IF EXISTS {require_scratch(SCRATCH_DB)} WITH (FORCE)")


def restore_dump() -> None:
    text = DUMP.read_bytes()
    for line in text.splitlines():
        # a database switch inside the dump would send the rest elsewhere
        if line.startswith((b"\\connect", b"\\c ")) or line.upper().startswith(
                (b"CREATE DATABASE", b"DROP DATABASE", b"ALTER DATABASE")):
            die("the starter dump switches or changes databases; refusing to restore it")
    psql(require_scratch(SCRATCH_DB), stdin_path=DUMP)


def migrate(env: dict[str, str]) -> None:
    done = subprocess.run([str(VENV / "alembic"), "upgrade", "head"], cwd=REPO / "api",
                          env=env, capture_output=True, text=True, timeout=900)
    log = SCRATCH / "migrate.log"
    log.write_text(done.stdout + done.stderr, encoding="utf-8")
    if done.returncode != 0:
        die(f"migrations failed; see {log}")


def prepare_database() -> None:
    """Rows restored from the dump that would get in the way of a scratch run."""
    db = require_scratch(SCRATCH_DB)
    # the dump's worker-registry rows would read as dead workers on /system/status
    psql(db, "DELETE FROM processes")
    # the starter admin settings: not read-only, workers not paused
    psql(db, "UPDATE system_config SET data = data || "
             "'{\"read_only\": false, \"pause_workers\": false}'::jsonb "
             "WHERE section = 'admin'")
    # no forced 2FA enrollment for the scratch admin
    psql(db, "UPDATE system_config SET data = data || '{\"two_factor_required\": false}'::jsonb "
             "WHERE section = 'security'")


# ── object storage ─────────────────────────────────────────────────────


def storage():
    import boto3
    from botocore.config import Config
    env_file = dotenv()
    return boto3.client(
        "s3", endpoint_url=STORAGE_ENDPOINT, region_name=env_file.get("SS_SPACES_REGION") or
        "us-east-1", aws_access_key_id=env_file["SS_SPACES_ACCESS_KEY"],
        aws_secret_access_key=env_file["SS_SPACES_SECRET_KEY"],
        config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 2}))


def bucket_exists(client) -> bool:
    names = {b["Name"] for b in client.list_buckets().get("Buckets", [])}
    return require_bucket(SCRATCH_BUCKET) in names


def make_bucket() -> None:
    client = storage()
    if not bucket_exists(client):
        client.create_bucket(Bucket=require_bucket(SCRATCH_BUCKET))


def bucket_objects(client) -> list[str]:
    keys: list[str] = []
    for page in client.get_paginator("list_objects_v2").paginate(
            Bucket=require_bucket(SCRATCH_BUCKET)):
        keys += [o["Key"] for o in page.get("Contents", [])]
    return keys


def remove_bucket() -> list[str]:
    client = storage()
    if not bucket_exists(client):
        return []
    keys = bucket_objects(client)
    for key in keys:
        client.delete_object(Bucket=require_bucket(SCRATCH_BUCKET), Key=key)
    client.delete_bucket(Bucket=require_bucket(SCRATCH_BUCKET))
    return keys


# ── the admin account ──────────────────────────────────────────────────


def password_file() -> Path:
    return SCRATCH / "admin-password"


def make_admin(env: dict[str, str]) -> None:
    path = password_file()
    password = secrets.token_urlsafe(18)
    cli = str(VENV / "serversherpa")
    done = subprocess.run(
        [cli, "bootstrap-admin", "--email", ADMIN_EMAIL, "--first-name", "Load",
         "--last-name", "Test", "--role", "developer", "--password-stdin"],
        input=password + "\n", env=env, capture_output=True, text=True, timeout=120)
    if done.returncode != 0:
        die(f"bootstrap-admin failed: {done.stderr[-400:]}")
    # bootstrap-admin's own hash has been seen unusable; set-password fixes it
    done = subprocess.run([cli, "set-password", "--email", ADMIN_EMAIL],
                          input=f"{password}\n{password}\n", env=env, capture_output=True,
                          text=True, timeout=120)
    if done.returncode != 0:
        die(f"set-password failed: {done.stderr[-400:]}")
    path.write_text(password + "\n", encoding="utf-8")
    path.chmod(0o600)


# ── processes ──────────────────────────────────────────────────────────


def pid_file(name: str) -> Path:
    return SCRATCH / f"{name}.pid"


def _ps(field: str, pid: int) -> str | None:
    done = subprocess.run(["ps", "-o", f"{field}=", "-p", str(pid)],
                          capture_output=True, text=True)
    return done.stdout.strip() if done.returncode == 0 else None


def started_pid(name: str) -> int | None:
    """The pid this script started for `name`, if that process still runs it: the same
    pid, a command line with the process's signature, and the start time recorded beside
    the pid (a dev worker run from the same virtualenv has the signature too, but never
    that start time). A pid file from before start times were kept is checked by its
    signature only."""
    path = pid_file(name)
    if not path.exists():
        return None
    lines = path.read_text().splitlines()
    pid = int(lines[0].strip())
    command = _ps("command", pid)
    if command is None or not all(part in command for part in SIGNATURES[name]):
        return None         # gone, or the pid now belongs to something else
    if len(lines) > 1 and lines[1].strip() and _ps("lstart", pid) != lines[1].strip():
        return None         # the pid was reused by another process
    return pid


def start(name: str, env: dict[str, str]) -> int:
    pid = started_pid(name)
    if pid is not None:
        say(f"  {name}: already running (pid {pid})")
        return pid
    log = open(SCRATCH / f"{name}.log", "ab")
    proc = subprocess.Popen(PROCESSES[name], cwd=SCRATCH, env=env, stdin=subprocess.DEVNULL,
                            stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    pid_file(name).write_text(f"{proc.pid}\n{_ps('lstart', proc.pid) or ''}\n")
    say(f"  {name}: started (pid {proc.pid}, log {SCRATCH / (name + '.log')})")
    return proc.pid


def stop(name: str) -> None:
    pid = started_pid(name)
    if pid is None:
        pid_file(name).unlink(missing_ok=True)
        return
    os.kill(pid, signal.SIGTERM)
    for _ in range(100):
        if started_pid(name) is None:
            break
        time.sleep(0.2)
    else:
        os.kill(pid, signal.SIGKILL)
        time.sleep(0.5)
    pid_file(name).unlink(missing_ok=True)
    say(f"  {name}: stopped (pid {pid})")


def port_free(port: int) -> bool:
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def wait_for_api(timeout: float = 90) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://{API_HOST}:{API_PORT}/system/status",
                                        timeout=5) as r:
                if r.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            pass
        if started_pid("api") is None:
            die(f"the API exited; see {SCRATCH / 'api.log'}")
        time.sleep(1)
    die("the API did not answer in time")


# ── commands ───────────────────────────────────────────────────────────


def up() -> None:
    SCRATCH.mkdir(parents=True, exist_ok=True)
    SCRATCH.chmod(0o700)
    env = process_env()
    if database_exists():
        say(f"Database {SCRATCH_DB}: already there")
    else:
        if any(started_pid(n) for n in PROCESSES):
            die("processes from an earlier run are still alive; run down first")
        if not port_free(API_PORT):
            die(f"port {API_PORT} is in use by something this script did not start")
        say(f"Database {SCRATCH_DB}: creating, restoring the starter dump, migrating…")
        create_database()
        restore_dump()
        migrate(env)
        prepare_database()
        say(f"Database {SCRATCH_DB}: ready")
    make_bucket()
    say(f"Bucket {SCRATCH_BUCKET}: ready")
    if not password_file().exists():
        make_admin(env)
        say(f"Admin {ADMIN_EMAIL}: created (password in {password_file()})")
    else:
        say(f"Admin {ADMIN_EMAIL}: already there (password in {password_file()})")
    say("Processes:")
    if started_pid("api") is None and not port_free(API_PORT):
        die(f"port {API_PORT} is in use by something this script did not start")
    for name in PROCESSES:
        start(name, env)
    wait_for_api()
    say(f"Scratch server: http://{API_HOST}:{API_PORT}")


def down() -> None:
    say("Processes:")
    for name in reversed(list(PROCESSES)):
        stop(name)
    left = [n for n in PROCESSES if started_pid(n) is not None]
    if left:
        die(f"still running: {', '.join(left)}")
    drop_database()
    say(f"Database {SCRATCH_DB}: dropped" if not database_exists()
        else f"Database {SCRATCH_DB}: STILL THERE")
    keys = remove_bucket()
    say(f"Bucket {SCRATCH_BUCKET}: removed with {len(keys)} object(s)")
    password_file().unlink(missing_ok=True)
    say(f"Port {API_PORT}: {'free' if port_free(API_PORT) else 'IN USE'}")


def restart() -> None:
    """Stops and starts the processes only, to pick up new settings; data stays."""
    if not database_exists():
        die("there is no scratch database; run up")
    env = process_env()
    say("Processes:")
    for name in reversed(list(PROCESSES)):
        stop(name)
    if not port_free(API_PORT):
        die(f"port {API_PORT} is in use by something this script did not start")
    for name in PROCESSES:
        start(name, env)
    wait_for_api()
    say(f"Scratch server: http://{API_HOST}:{API_PORT}")


def status() -> None:
    say(f"Database {SCRATCH_DB}: {'present' if database_exists() else 'absent'}")
    for name in PROCESSES:
        pid = started_pid(name)
        say(f"  {name}: {'running (pid %d)' % pid if pid else 'not running'}")
    if started_pid("api"):
        try:
            with urllib.request.urlopen(f"http://{API_HOST}:{API_PORT}/system/status",
                                        timeout=5) as r:
                say(f"  /system/status: {r.read().decode()}")
        except (urllib.error.URLError, OSError) as exc:
            say(f"  /system/status: no answer ({type(exc).__name__})")
    try:
        client = storage()
        there = bucket_exists(client)
        say(f"Bucket {SCRATCH_BUCKET}: "
            f"{'present, %d object(s)' % len(bucket_objects(client)) if there else 'absent'}")
    except Exception as exc:  # noqa: BLE001 - status is informational
        say(f"Bucket {SCRATCH_BUCKET}: unknown ({type(exc).__name__})")


def main() -> None:
    commands = {"up": up, "down": down, "status": status, "restart": restart}
    if len(sys.argv) != 2 or sys.argv[1] not in commands:
        die("usage: scratch_stack.sh up | down | status | restart")
    commands[sys.argv[1]]()


if __name__ == "__main__":
    main()
