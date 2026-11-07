"""The scratch Postgres (SIRDAR_SCRATCH_URL): snapshots are restored into
databases of their own there, for browsing and for cutting subsets. It is
a server of its own beside Sirdar's database (docker-compose's
sirdar-scratch), at ServerSherpa's major version, so pg_restore matches
the dumps.

One browse database per snapshot (shared by everyone browsing it), named
from the snapshot id; it is dropped once it has sat unused for
SIRDAR_SCRATCH_IDLE_MINUTES. Which databases are ready, and when each was
last used, is kept in memory: a browse database this process didn't
restore is dropped by the next sweep and restored again when asked for.

Snapshots are uploaded, so their dumps are untrusted SQL. The superuser
in SIRDAR_SCRATCH_URL only sets up roles and creates and drops databases.
Each scratch database has a login role of its own, named like it (no
superuser, no CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS, allowed only to SET
session_replication_role), that owns it; CONNECT on it is revoked from
PUBLIC, as it is on the server's own database and template1, so a role can
reach only its own database. pg_restore and every browsing connection log
in as that role. Its password is random, kept in memory, and replaced
whenever the role is set up again (a new process resets it, with RESET ALL);
the server only ever sees its SCRAM-SHA-256 verifier. The role is dropped
with its database. A dump restored as one role can grant on its objects to
another scratch role (it can see pg_roles), and that other role can't be
dropped while those privileges exist: it is left NOLOGIN, inert, and swept
once the granting database is gone.

The scratch URL holds a password: it is never logged, and the Postgres
tools get passwords through PGPASSWORD in their own environment only."""

import asyncio
import logging
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import uuid
from contextlib import suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import asyncpg
from sqlalchemy.engine import make_url

from sirdar_api.config import Settings
from sirdar_api.db.models import Snapshot
from sirdar_api.deploy import bundle, pgauth, snapshots
from sirdar_api.seed import SeedError, browse

log = logging.getLogger(__name__)

# Database names start with this; the tests use sirdar_test_scratch.
PREFIX = "sirdar_scratch"
PURPOSE_RE = re.compile(r"[a-z]{1,10}")
NAME_RE = re.compile(r"[a-z0-9_]{1,63}")
SWEEP_SECONDS = 300
# The environment the Postgres tools run with (plus PGPASSWORD): nothing of
# Sirdar's own (its database URL, its secrets key) reaches them.
_ENV_KEEP = ("PATH", "HOME", "LANG", "LC_ALL", "TMPDIR")

Status = Literal["absent", "restoring", "ready", "failed"]

_state: dict[str, str] = {}           # name -> restoring | ready | failed
_last_used: dict[str, float] = {}     # name -> time.monotonic() of last use
_locks: dict[str, asyncio.Lock] = {}
_tasks: set[asyncio.Task] = set()
_passwords: dict[str, str] = {}      # name -> its role's password
_password_locks: dict[str, asyncio.Lock] = {}   # one role setup at a time per name
_setup: dict[str, bool] = {}          # "done" once the server-wide REVOKEs ran


@dataclass(frozen=True)
class _Server:
    host: str
    port: int
    user: str
    password: str
    database: str


def db_name(snapshot_id: uuid.UUID, purpose: str = "browse") -> str:
    if not PURPOSE_RE.fullmatch(purpose):
        raise ValueError("purpose must be a short lowercase word")
    return f"{PREFIX}_{purpose}_{snapshot_id.hex}"


def status(snapshot_id: uuid.UUID) -> Status:
    """The browse database's state, as this process knows it."""
    return _state.get(db_name(snapshot_id), "absent")  # type: ignore[return-value]


def forget_all() -> None:
    """Forget every database (tests; never drops anything)."""
    for task in list(_tasks):
        task.cancel()
    _tasks.clear()
    _state.clear()
    _last_used.clear()
    _locks.clear()
    _passwords.clear()
    _password_locks.clear()
    _setup.clear()
    browse.forget_counts()


def _parse(settings: Settings) -> _Server | None:
    raw = settings.scratch_url.get_secret_value().strip()
    if not raw:
        return None
    try:
        url = make_url(raw)
    except Exception:  # noqa: BLE001 - the message would quote the URL
        return None
    if not url.drivername.startswith("postgresql") or not url.host:
        return None
    try:
        port = url.port or 5432
    except ValueError:
        return None
    return _Server(host=url.host, port=port, user=url.username or "postgres",
                   password=url.password or "", database=url.database or "postgres")


def configured(settings: Settings) -> bool:
    """A usable SIRDAR_SCRATCH_URL (a postgresql:// URL with a host)."""
    return _parse(settings) is not None


def _server(settings: Settings) -> _Server:
    server = _parse(settings)
    if server is None:
        raise SeedError("scratch_not_configured")
    return server


def _check_name(name: str) -> str:
    if not NAME_RE.fullmatch(name) or not name.startswith(PREFIX + "_"):
        raise ValueError("not a scratch database name")
    return name


def _touch(name: str) -> None:
    _last_used[name] = time.monotonic()


def _lock(name: str) -> asyncio.Lock:
    return _locks.setdefault(name, asyncio.Lock())


def _locked(name: str) -> bool:
    """Whether `name`'s lock is held (without making an entry for it)."""
    lock = _locks.get(name)
    return lock is not None and lock.locked()


def _password_lock(name: str) -> asyncio.Lock:
    return _password_locks.setdefault(name, asyncio.Lock())


# ---- connections and the Postgres tools ------------------------------------------

async def _admin(settings: Settings) -> asyncpg.Connection:
    s = _server(settings)
    return await asyncpg.connect(host=s.host, port=s.port, user=s.user, password=s.password,
                                 database=s.database, timeout=10)


# CREATE/ALTER ROLE take no parameters, so the password is part of the
# statement text, which the server may log (log_statement, or
# log_min_error_statement when it fails). So the statement carries the
# password's SCRAM-SHA-256 verifier (what the server stores anyway), never
# the password itself: nothing in a server log logs in.
_ROLE_ATTRS = "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"


async def _setup_server(conn: asyncpg.Connection, settings: Settings) -> None:
    """Once per process: no role but the superuser may connect to the
    server's own database or template1 (unless SIRDAR_SCRATCH_LOCK_ADMIN_DBS
    is off, for a server Sirdar shares)."""
    if _setup.get("done"):
        return
    if settings.scratch_lock_admin_dbs:
        for database in (_server(settings).database, "template1"):
            await conn.execute(f'REVOKE CONNECT ON DATABASE "{database}" FROM PUBLIC')
    _setup["done"] = True


async def _setup_role(conn: asyncpg.Connection, name: str) -> str:
    """Create, or reset, database `name`'s own role: restricted attributes,
    LOGIN (a leftover role was made NOLOGIN), a fresh password, no settings
    of its own (RESET ALL), allowed to SET session_replication_role (a later
    step loads rows as replica). Its password."""
    _check_name(name)
    password = secrets.token_urlsafe(32)
    # The verifier is [A-Za-z0-9+/=$:] only: safe in a literal.
    attrs = f"{_ROLE_ATTRS} PASSWORD '{pgauth.scram_sha256(password)}'"
    exists = await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", name)
    if not exists:
        try:
            await conn.execute(f'CREATE ROLE "{name}" {attrs}')
        except asyncpg.DuplicateObjectError:
            exists = True
    if exists:
        await conn.execute(f'ALTER ROLE "{name}" {attrs}')
    await conn.execute(f'ALTER ROLE "{name}" RESET ALL')
    await conn.execute(f'GRANT SET ON PARAMETER session_replication_role TO "{name}"')
    _passwords[name] = password
    return password


async def _drop_role(conn: asyncpg.Connection, name: str) -> bool:
    """Drop database `name`'s role (its database must be gone already).
    True once it is gone. False when Postgres refuses, which happens when
    another scratch database's dump granted it privileges there (we can't
    revoke those from here: DROP OWNED works only inside that database, and
    the superuser never enters a database restored from a dump): the role
    is left NOLOGIN, so nothing can use it, and the sweep drops it once that
    database is gone."""
    _check_name(name)
    _passwords.pop(name, None)
    if not await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", name):
        return True
    # The parameter grant is the one thing outside the databases it holds.
    await conn.execute(f'REVOKE SET ON PARAMETER session_replication_role FROM "{name}"')
    try:
        await conn.execute(f'DROP ROLE IF EXISTS "{name}"')
    except asyncpg.PostgresError as e:    # DependentObjectsStillExistError, mostly
        log.info("scratch role %s can't be dropped yet (%s); left NOLOGIN for a later sweep",
                 name, type(e).__name__)
        await conn.execute(f'ALTER ROLE "{name}" NOLOGIN')
        return False
    return True


async def _role_password(settings: Settings, name: str) -> str:
    """Database `name`'s role password; reset by the superuser when this
    process doesn't know it (say, after a restart). One setup at a time
    per name."""
    if name in _passwords:
        return _passwords[name]
    async with _password_lock(name):
        if name in _passwords:
            return _passwords[name]
        conn = await _admin(settings)
        try:
            await _setup_server(conn, settings)
            return await _setup_role(conn, name)
        finally:
            await conn.close()


async def connect(settings: Settings, name: str) -> asyncpg.Connection:
    """A connection to scratch database `name` as its own restricted role
    (the caller closes it)."""
    s = _server(settings)
    _check_name(name)
    password = await _role_password(settings, name)
    conn = await asyncpg.connect(host=s.host, port=s.port, user=name,
                                 password=password, database=name, timeout=10)
    _touch(name)
    return conn


async def _exists(settings: Settings, name: str) -> bool:
    conn = await _admin(settings)
    try:
        return bool(await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", name))
    finally:
        await conn.close()


async def _create_db(settings: Settings, name: str) -> None:
    """Database `name`, owned by a role of its own (fresh, or a leftover one
    reset: new password, LOGIN, RESET ALL); only that role may connect to
    it."""
    conn = await _admin(settings)
    try:
        await _setup_server(conn, settings)
        async with _password_lock(name):
            await _setup_role(conn, _check_name(name))
        await conn.execute(f'CREATE DATABASE "{name}" OWNER "{name}" TEMPLATE template0')
        await conn.execute(f'REVOKE CONNECT ON DATABASE "{name}" FROM PUBLIC')
    finally:
        await conn.close()


async def _drop_db(settings: Settings, name: str) -> None:
    """Drop database `name` and then its role. Returning means the database
    is gone; the role is gone, or left NOLOGIN for the sweep (see
    _drop_role), or, should its drop fail some other way, left for the
    sweep too (logged by type)."""
    conn = await _admin(settings)
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{_check_name(name)}" WITH (FORCE)')
        browse.forget_counts(name)
        try:
            await _drop_role(conn, name)
        except Exception as e:  # noqa: BLE001 - the database is gone; the role can wait
            log.warning("scratch role %s couldn't be dropped: %s", name, type(e).__name__)
    finally:
        await conn.close()


def _tool(settings: Settings, tool: str) -> str:
    return str(Path(settings.pg_bin_dir) / tool) if settings.pg_bin_dir else tool


async def _run(settings: Settings, tool: str, args: list[str], *,
               role: str, stdout_path: Path | None = None) -> tuple[int, str]:
    """Run a Postgres client tool against the scratch server as scratch
    database `role`'s own role (never the superuser); (exit code, stderr).
    The password goes in the child's PGPASSWORD only. Its standard output
    is discarded, or written to `stdout_path` (a new mode-600 file: pg_dump
    writes its dump there, so the tools need no path of their own, which
    a wrapper running them elsewhere couldn't reach). A cancelled caller
    kills the child."""
    s = _server(settings)
    password = await _role_password(settings, role)
    env = {k: os.environ[k] for k in _ENV_KEEP if k in os.environ}
    env.update(PGPASSWORD=password, PGCONNECT_TIMEOUT="10")
    argv = [_tool(settings, tool), "--host", s.host, "--port", str(s.port),
            "--username", role, "--no-password", *args]
    out = asyncio.subprocess.DEVNULL
    if stdout_path is not None:
        out = bundle._open_private(stdout_path)
    try:
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv, env=env, stdin=asyncio.subprocess.DEVNULL,
                stdout=out, stderr=asyncio.subprocess.PIPE)
        except OSError:
            return 127, f"{tool} could not be started"
    finally:
        if stdout_path is not None:
            os.close(out)
    try:
        _, err = await proc.communicate()
    except BaseException:
        with suppress(ProcessLookupError):
            proc.kill()
        await proc.wait()
        raise
    return proc.returncode or 0, err.decode("utf-8", errors="replace")


run_tool = _run      # for seed/build.py: its pg_dump and pg_restore runs


# ---- restoring -----------------------------------------------------------------

class _Stopped(Exception):
    """The restore was cancelled while the dump was being extracted."""


def _extract_dump(settings: Settings, snap: Snapshot, dest: Path,
                  stop: threading.Event | None = None) -> Path:
    """Write the bundle's db.dump (mode 600) into dest, checking every
    checksum on the way. Sync: run it in a thread. Setting `stop` makes it
    give up (raising _Stopped) before it writes anything more."""
    stop = stop or threading.Event()
    path = snapshots.bundle_path(settings, snap)
    if not path.is_file():
        raise snapshots.SnapshotError("snapshot_file_missing")
    out = dest / bundle.DB_DUMP

    def on_data(name: str, size: int, reader) -> None:
        if stop.is_set():
            raise _Stopped
        if name != bundle.DB_DUMP:
            return
        with os.fdopen(bundle._open_private(out), "wb") as f:
            while chunk := reader.read(bundle.CHUNK):
                if stop.is_set():
                    raise _Stopped
                f.write(chunk)

    bundle._scan(path, on_data=on_data, max_bytes=4 * settings.snapshot_max_bytes)
    return out


def _work_dir(settings: Settings) -> Path:
    snapshots.ensure_dirs(settings)
    return Path(tempfile.mkdtemp(prefix="scratch-", dir=snapshots.incoming_dir(settings)))


async def _restore(settings: Settings, snap: Snapshot, name: str) -> None:
    work = await asyncio.to_thread(_work_dir, settings)
    try:
        stop = threading.Event()
        extract = asyncio.ensure_future(
            asyncio.to_thread(_extract_dump, settings, snap, work, stop))
        try:
            dump = await asyncio.shield(extract)
        except asyncio.CancelledError:
            # The thread can't be cancelled: stop it writing, and wait for it
            # (through further cancels too) before the folder is removed.
            stop.set()
            while not extract.done():
                try:
                    await asyncio.shield(extract)
                except asyncio.CancelledError:
                    continue
                except BaseException:  # noqa: BLE001 - _Stopped, or its own failure
                    break
            raise
        await _drop_db(settings, name)            # whatever an earlier run left
        await _create_db(settings, name)
        code, err = await _run(settings, "pg_restore",
                               ["--no-owner", "--no-privileges", "--dbname", name, str(dump)],
                               role=name)
        if code != 0:
            # stderr may quote the dump's rows: the log only, never the API.
            first = next((ln for ln in err.splitlines() if ln.strip()), "")[:300]
            log.warning("pg_restore into a scratch database exited with %d: %s", code, first)
            raise SeedError("restore_failed", reason=f"pg_restore exited with {code}")
    finally:
        await asyncio.to_thread(shutil.rmtree, work, True)


async def ensure_restored(settings: Settings, snap: Snapshot, purpose: str = "browse") -> str:
    """The name of a scratch database holding `snap`'s db.dump, restoring
    it first unless this process already did. Concurrent callers share one
    restore. A failed restore leaves no database: SeedError restore_failed."""
    name = db_name(snap.id, purpose)
    _server(settings)                            # scratch_not_configured first
    async with _lock(name):
        # Already ready: a hiccup checking (or a cancel) leaves it be.
        if _state.get(name) == "ready":
            try:
                exists = await _exists(settings, name)
            except Exception as e:  # noqa: BLE001 - asyncpg's messages may quote the server
                log.warning("couldn't check scratch database for snapshot %s: %s", snap.id,
                            type(e).__name__)
                raise SeedError("scratch_unavailable",
                                reason="The scratch Postgres can't be reached.") from None
            if exists:
                _touch(name)
                return name
        _state[name] = "restoring"
        try:
            await _restore(settings, snap, name)
        except BaseException as e:
            _state[name] = "failed"
            _last_used.pop(name, None)
            with suppress(Exception):
                await _drop_db(settings, name)
            if isinstance(e, SeedError):
                log.warning("scratch restore of snapshot %s failed: %s", snap.id,
                            e.extra.get("reason", e.code))
                raise
            if isinstance(e, snapshots.SnapshotError):
                log.warning("scratch restore of snapshot %s failed: %s", snap.id, e.reason)
                raise SeedError("restore_failed", reason=e.reason) from None
            if isinstance(e, bundle.BundleError):
                log.warning("scratch restore of snapshot %s failed: %s", snap.id, e.reason)
                raise SeedError("restore_failed", reason=e.reason) from None
            if isinstance(e, Exception):
                log.warning("scratch restore of snapshot %s failed: %s", snap.id,
                            type(e).__name__)
                raise SeedError("restore_failed",
                                reason="The scratch database couldn't be restored.") from None
            raise                                 # cancelled: still no database left
        _state[name] = "ready"
        _touch(name)
        return name


async def create_blank(settings: Settings, snapshot_id: uuid.UUID, purpose: str) -> str:
    """A new, empty scratch database for `snapshot_id` (whatever an earlier
    run left under that name dropped first), owned by a role of its own
    like a restored one, and known here as ready, so only its owner drops
    it (see _sweepable). Its name. SeedError scratch_unavailable when the
    scratch server can't do it."""
    name = db_name(snapshot_id, purpose)
    _server(settings)
    async with _lock(name):
        _state[name] = "restoring"
        try:
            await _drop_db(settings, name)
            await _create_db(settings, name)
        except BaseException as e:
            _state.pop(name, None)
            if isinstance(e, Exception):
                log.warning("couldn't create scratch database %s: %s", name, type(e).__name__)
                raise SeedError("scratch_unavailable") from None
            raise
        _state[name] = "ready"
        _touch(name)
        return name


def start_restore(settings: Settings, snap: Snapshot) -> Status:
    """Restore `snap`'s browse database in the background (unless it is
    ready or already restoring); its status now."""
    current = status(snap.id)
    if current in ("ready", "restoring"):
        if current == "ready":
            _touch(db_name(snap.id))
        return current
    name = db_name(snap.id)
    _state[name] = "restoring"

    async def run() -> None:
        try:
            await ensure_restored(settings, snap)
        except SeedError:
            pass                                  # ensure_restored logged and recorded it
        except Exception as e:  # noqa: BLE001 - a background task must record, not raise
            log.warning("scratch restore of snapshot %s failed: %s", snap.id,
                        type(e).__name__)
        finally:
            if _state.get(name) == "restoring" and not _lock(name).locked():
                _state[name] = "failed"

    task = asyncio.create_task(run(), name=f"scratch-restore-{snap.id}")
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return "restoring"


async def drop(settings: Settings, name: str) -> None:
    """Drop scratch database `name` (if it exists) and forget it."""
    _check_name(name)
    async with _lock(name):
        await _drop_db(settings, name)            # back only once the database is gone
        _state.pop(name, None)
        _last_used.pop(name, None)


def _sweepable(name: str, cutoff: float, browse: str) -> bool:
    """Whether the sweep may drop database `name` now, going by what this
    process knows (not by its lock): unknown here, or a browse database
    unused since `cutoff`. Checked again once its lock is held."""
    if _state.get(name) == "restoring":
        return False
    if name in _state:
        if not name.startswith(browse):
            return False                          # a build in this process: its owner drops it
        last = _last_used.get(name)
        if last is not None and last >= cutoff:
            return False
    return True


async def sweep_idle(settings: Settings) -> int:
    """Drop the browse databases unused for SIRDAR_SCRATCH_IDLE_MINUTES, and
    every scratch database this process doesn't know, whatever its purpose
    (what an earlier run or a crash left), then the roles whose database is
    gone. Runs at startup and then periodically. Each drop fails on its own
    (logged by type), never the sweep. How many databases it dropped."""
    if not configured(settings):
        return 0
    conn = await _admin(settings)
    try:
        names = [r["datname"] for r in await conn.fetch(
            "SELECT datname FROM pg_database WHERE starts_with(datname, $1) ORDER BY datname",
            f"{PREFIX}_")]
    finally:
        await conn.close()
    cutoff = time.monotonic() - settings.scratch_idle_minutes * 60
    browse = f"{PREFIX}_browse_"
    dropped = 0
    for name in names:
        if not NAME_RE.fullmatch(name) or _locked(name) or not _sweepable(name, cutoff, browse):
            continue
        try:
            async with _lock(name):
                if not _sweepable(name, cutoff, browse):    # a restore got in first
                    continue
                await _drop_db(settings, name)
                _state.pop(name, None)
                _last_used.pop(name, None)
        except Exception as e:  # noqa: BLE001 - on to the next one
            log.warning("scratch sweep couldn't drop database %s: %s", name, type(e).__name__)
            continue
        dropped += 1
    # Roles whose database is gone: a crash between the two drops, a drop
    # Postgres refused (see _drop_role), or an earlier version's shared role.
    conn = await _admin(settings)
    try:
        orphans = [r["rolname"] for r in await conn.fetch(
            "SELECT rolname FROM pg_roles r WHERE starts_with(rolname, $1) AND NOT EXISTS "
            "(SELECT 1 FROM pg_database d WHERE d.datname = r.rolname) ORDER BY rolname",
            f"{PREFIX}_")]
        for name in orphans:
            if not NAME_RE.fullmatch(name) or name in _state or _locked(name):
                continue
            try:
                async with _lock(name):
                    if name in _state:                   # a restore got in first
                        continue
                    await _drop_role(conn, name)
            except Exception as e:  # noqa: BLE001 - on to the next one
                log.warning("scratch sweep couldn't drop role %s: %s", name, type(e).__name__)
    finally:
        await conn.close()
    return dropped


async def sweep_loop(settings: Settings, seconds: int = SWEEP_SECONDS) -> None:
    """The app's background sweep; it never raises."""
    while True:
        await asyncio.sleep(seconds)
        try:
            count = await sweep_idle(settings)
            if count:
                log.info("dropped %d idle scratch database(s)", count)
        except Exception as e:  # noqa: BLE001 - the loop must keep running
            log.warning("scratch sweep failed: %s", type(e).__name__)
