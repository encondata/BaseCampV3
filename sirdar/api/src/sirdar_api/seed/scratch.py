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

Snapshots are uploaded, so their dumps are untrusted SQL: the superuser in
SIRDAR_SCRATCH_URL only creates and drops the databases and sets up one
restricted login role (PREFIX_owner: no superuser, no CREATEDB/CREATEROLE,
allowed only to SET session_replication_role). Each scratch database is
owned by that role, and pg_restore and every browsing connection log in as
it. Its password is random, made fresh by each process and kept in memory.

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
from sirdar_api.deploy import bundle, snapshots
from sirdar_api.seed import SeedError

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
_owner: dict[str, object] = {}        # "password" once the role is set up, "lock"


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
    _owner.clear()


def owner_role() -> str:
    return f"{PREFIX}_owner"


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


async def _ensure_owner(settings: Settings) -> str:
    """Create (or reset) the restricted owner role; its password."""
    lock = _owner.setdefault("lock", asyncio.Lock())
    async with lock:  # type: ignore[union-attr]
        if "password" in _owner:
            return _owner["password"]  # type: ignore[return-value]
        password = secrets.token_urlsafe(32)     # [A-Za-z0-9_-]: safe in a literal
        role = owner_role()
        attrs = ("LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS "
                 f"PASSWORD '{password}'")
        conn = await _admin(settings)
        try:
            exists = await conn.fetchval("SELECT 1 FROM pg_roles WHERE rolname = $1", role)
            if not exists:
                try:
                    await conn.execute(f'CREATE ROLE "{role}" {attrs}')
                except asyncpg.DuplicateObjectError:
                    exists = True
            if exists:
                await conn.execute(f'ALTER ROLE "{role}" {attrs}')
            # A later step loads rows with session_replication_role = replica.
            await conn.execute(
                f'GRANT SET ON PARAMETER session_replication_role TO "{role}"')
        finally:
            await conn.close()
        _owner["password"] = password
        return password


def _check_name(name: str) -> str:
    if not NAME_RE.fullmatch(name) or not name.startswith(PREFIX + "_"):
        raise ValueError("not a scratch database name")
    return name


def _touch(name: str) -> None:
    _last_used[name] = time.monotonic()


def _lock(name: str) -> asyncio.Lock:
    return _locks.setdefault(name, asyncio.Lock())


# ---- connections and the Postgres tools ------------------------------------------

async def _admin(settings: Settings) -> asyncpg.Connection:
    s = _server(settings)
    return await asyncpg.connect(host=s.host, port=s.port, user=s.user, password=s.password,
                                 database=s.database, timeout=10)


async def connect(settings: Settings, name: str) -> asyncpg.Connection:
    """A connection to scratch database `name` as the restricted owner role
    (the caller closes it)."""
    s = _server(settings)
    _check_name(name)
    password = await _ensure_owner(settings)
    conn = await asyncpg.connect(host=s.host, port=s.port, user=owner_role(),
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
    conn = await _admin(settings)
    try:
        await conn.execute(f'CREATE DATABASE "{_check_name(name)}" '
                           f'OWNER "{owner_role()}" TEMPLATE template0')
    finally:
        await conn.close()


async def _drop_db(settings: Settings, name: str) -> None:
    conn = await _admin(settings)
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{_check_name(name)}" WITH (FORCE)')
    finally:
        await conn.close()


def _tool(settings: Settings, tool: str) -> str:
    return str(Path(settings.pg_bin_dir) / tool) if settings.pg_bin_dir else tool


async def _run(settings: Settings, tool: str, args: list[str]) -> tuple[int, str]:
    """Run a Postgres client tool against the scratch server as the
    restricted owner role (never the superuser); (exit code, stderr). The
    password goes in the child's PGPASSWORD only. A cancelled caller kills
    the child."""
    s = _server(settings)
    password = await _ensure_owner(settings)
    env = {k: os.environ[k] for k in _ENV_KEEP if k in os.environ}
    env.update(PGPASSWORD=password, PGCONNECT_TIMEOUT="10")
    argv = [_tool(settings, tool), "--host", s.host, "--port", str(s.port),
            "--username", owner_role(), "--no-password", *args]
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv, env=env, stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
    except OSError:
        return 127, f"{tool} could not be started"
    try:
        _, err = await proc.communicate()
    except BaseException:
        with suppress(ProcessLookupError):
            proc.kill()
        await proc.wait()
        raise
    return proc.returncode or 0, err.decode("utf-8", errors="replace")


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
            # before the folder is removed.
            stop.set()
            with suppress(BaseException):
                await extract
            raise
        await _ensure_owner(settings)
        await _drop_db(settings, name)            # whatever an earlier run left
        await _create_db(settings, name)
        code, err = await _run(settings, "pg_restore",
                               ["--no-owner", "--no-privileges", "--dbname", name, str(dump)])
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
        try:
            if _state.get(name) == "ready" and await _exists(settings, name):
                _touch(name)
                return name
            _state[name] = "restoring"
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
        await _drop_db(settings, name)
        _state.pop(name, None)
        _last_used.pop(name, None)


async def sweep_idle(settings: Settings) -> int:
    """Drop the browse databases unused for SIRDAR_SCRATCH_IDLE_MINUTES, and
    every scratch database this process doesn't know, whatever its purpose
    (what an earlier run or a crash left). Runs at startup and then
    periodically. How many it dropped."""
    if not configured(settings):
        return 0
    conn = await _admin(settings)
    try:
        names = [r["datname"] for r in await conn.fetch(
            "SELECT datname FROM pg_database WHERE starts_with(datname, $1)", f"{PREFIX}_")]
    finally:
        await conn.close()
    cutoff = time.monotonic() - settings.scratch_idle_minutes * 60
    browse = f"{PREFIX}_browse_"
    dropped = 0
    for name in names:
        if not NAME_RE.fullmatch(name):
            continue
        lock = _lock(name)
        if lock.locked() or _state.get(name) == "restoring":
            continue
        if name in _state:
            if not name.startswith(browse):
                continue                          # a build in this process: its owner drops it
            last = _last_used.get(name)
            if last is not None and last >= cutoff:
                continue
        async with lock:
            await _drop_db(settings, name)
            _state.pop(name, None)
            _last_used.pop(name, None)
        dropped += 1
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
