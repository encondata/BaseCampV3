"""The scratch Postgres that Seed Data restores snapshots into (Task 2)."""

import asyncio
import os
import subprocess
import uuid
from pathlib import Path

import psycopg
import pytest
from sqlalchemy.engine import make_url

from sirdar_api.config import get_settings
from sirdar_api.db.models import Snapshot
from sirdar_api.deploy import bundle, snapshots
from sirdar_api.seed import SeedError, scratch

from .api_helpers import auth_headers
from .bundle_helpers import write_objects_tar
from .conftest import BASE_URL, TEST_DB, _psycopg_url, pg_bin_dir_for_tests
from .deploy_factories import secrets_key, snapshots_dir  # noqa: F401

SOURCE = f"{TEST_DB}_seedsrc"
KEYS = {"SS_PASSWORD_PEPPER": "pepper-for-scratch-tests",
        "SS_TOTP_ENCRYPTION_KEY": "hNq5Ui0YUe9vAAAMPjYaMxNt3ydN5zZ6cM2P7k1HJ6I="}


@pytest.fixture(scope="module")
def good_dump(tmp_path_factory) -> bytes:
    """A pg_dump -Fc of two tables, one pointing at the other."""
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{SOURCE}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{SOURCE}"')
    try:
        with psycopg.connect(_psycopg_url(SOURCE), autocommit=True) as conn:
            # The extensions ServerSherpa uses (trusted: a non-superuser restores them).
            conn.execute("CREATE EXTENSION citext")
            conn.execute("CREATE EXTENSION pg_trgm")
            conn.execute("CREATE TABLE sites (id int PRIMARY KEY, name citext NOT NULL)")
            conn.execute("CREATE INDEX sites_name_trgm ON sites USING gin "
                         "(name gin_trgm_ops)")
            conn.execute("CREATE TABLE racks (id int PRIMARY KEY, "
                         "site_id int NOT NULL REFERENCES sites(id), name text)")
            conn.execute("INSERT INTO sites VALUES (1, 'North'), (2, 'South')")
            conn.execute("INSERT INTO racks VALUES (10, 1, 'A1'), (11, 2, 'B1')")
        bin_dir = pg_bin_dir_for_tests()
        if bin_dir is None:
            pytest.skip("no pg_dump matching the test Postgres's major version")
        url = make_url(BASE_URL)
        tool = str(Path(bin_dir) / "pg_dump") if bin_dir else "pg_dump"
        done = subprocess.run(
            [tool, "-Fc", "--host", url.host, "--port", str(url.port),
             "--username", url.username, "--no-password", SOURCE],
            env={**os.environ, "PGPASSWORD": url.password or ""}, check=True,
            capture_output=True)
        assert done.stdout.startswith(b"PGDMP")
        return done.stdout
    finally:
        with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{SOURCE}" WITH (FORCE)')


def _snapshot(tmp_path, dump: bytes) -> Snapshot:
    """A stored bundle holding `dump`, and a (transient) row for it."""
    parts = tmp_path / f"parts-{uuid.uuid4().hex}"
    parts.mkdir()
    (parts / "db.dump").write_bytes(dump)
    write_objects_tar(parts / "objects.tar")
    (parts / "keys").write_bytes(snapshots.encrypt_keys(get_settings(), KEYS))
    snapshot_id = uuid.uuid4()
    src = parts / "bundle.tar.gz"
    bundle.pack(src, source="uat", revision="0089", bucket="serversherpa",
                db_dump=parts / "db.dump", objects_tar=parts / "objects.tar",
                keys_file=parts / "keys")
    snapshots.ensure_dirs(get_settings())
    stored = snapshots.store_bundle(get_settings(), src, snapshot_id)
    return Snapshot(id=snapshot_id, name=f"snap-{snapshot_id.hex[:8]}", origin="upload",
                    source="uat", status="ready", bundle_file=stored.bundle_file,
                    alembic_revision="0089", size_bytes=stored.size_bytes,
                    checksum=stored.checksum)


def _databases() -> set[str]:
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        return {r[0] for r in conn.execute("SELECT datname FROM pg_database").fetchall()}


def _tables(name: str) -> dict[str, int]:
    with psycopg.connect(_psycopg_url(name), autocommit=True) as conn:
        return {t: conn.execute(f"SELECT count(*) FROM {t}").fetchone()[0]
                for t in ("sites", "racks")}


def test_db_name():
    sid = uuid.UUID("12345678-1234-5678-1234-567812345678")
    assert scratch.db_name(sid) == f"{scratch.PREFIX}_browse_{sid.hex}"
    assert scratch.db_name(sid, "subset") == f"{scratch.PREFIX}_subset_{sid.hex}"
    assert len(scratch.db_name(sid, "subset")) <= 63


async def test_restores_both_tables(scratch_url, snapshots_dir, tmp_path, good_dump):
    snap = _snapshot(tmp_path, good_dump)
    assert scratch.status(snap.id) == "absent"
    name = await scratch.ensure_restored(get_settings(), snap)
    assert name == f"{TEST_DB}_scratch_browse_{snap.id.hex}"
    assert scratch.status(snap.id) == "ready"
    assert _tables(name) == {"sites": 2, "racks": 2}
    conn = await scratch.connect(get_settings(), name)
    try:
        fks = await conn.fetchval(
            "SELECT count(*) FROM pg_constraint WHERE contype = 'f'")
        assert fks == 1
    finally:
        await conn.close()
    # The extracted dump is gone: nothing but the bundle and incoming/ remain.
    assert sorted(p.name for p in snapshots_dir.iterdir()) == sorted(
        ["incoming", snap.bundle_file])
    assert list((snapshots_dir / "incoming").iterdir()) == []


def _role(name: str):
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        return conn.execute(
            "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, "
            "rolcanlogin FROM pg_roles WHERE rolname = %s", (name,)).fetchone()


async def test_restore_runs_as_the_databases_own_role(scratch_url, snapshots_dir, tmp_path,
                                                      good_dump):
    snap = _snapshot(tmp_path, good_dump)
    name = await scratch.ensure_restored(get_settings(), snap)
    assert _role(name) == (False, False, False, False, False, True)
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        owner = conn.execute("SELECT pg_get_userbyid(datdba) FROM pg_database "
                             "WHERE datname = %s", (name,)).fetchone()[0]
        assert owner == name
    with psycopg.connect(_psycopg_url(name), autocommit=True) as conn:
        owners = {r[0] for r in conn.execute(
            "SELECT DISTINCT pg_get_userbyid(c.relowner) FROM pg_class c "
            "JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'")}
        assert owners == {name}
        ext_owners = {r[0] for r in conn.execute(
            "SELECT pg_get_userbyid(extowner) FROM pg_extension WHERE extname <> 'plpgsql'")}
        assert ext_owners == {name}
    conn = await scratch.connect(get_settings(), name)
    try:
        assert await conn.fetchval("SELECT current_user") == name
        await conn.execute("SET session_replication_role = replica")   # granted
        assert await conn.fetchval("SHOW session_replication_role") == "replica"
    finally:
        await conn.close()


async def _as_role(name: str, database: str):
    """Log in as scratch database `name`'s role, to `database`."""
    import asyncpg
    url = make_url(BASE_URL)
    return await asyncpg.connect(host=url.host, port=url.port, user=name,
                                 password=scratch._passwords[name], database=database,
                                 timeout=10)


async def test_a_role_reaches_only_its_own_database(scratch_url, snapshots_dir, tmp_path,
                                                    good_dump):
    import asyncpg
    a = await scratch.ensure_restored(get_settings(), _snapshot(tmp_path, good_dump))
    b = await scratch.ensure_restored(get_settings(), _snapshot(tmp_path, good_dump))
    # postgres and template1 stay open here (a shared cluster: the admin-DB
    # REVOKE is off in tests and covered by test_setup_locks_the_admin_databases).
    for database in (b,):
        with pytest.raises(asyncpg.PostgresError):
            await (await _as_role(a, database)).close()
    conn = await _as_role(a, a)
    try:
        for sql in (f'DROP DATABASE "{b}"', f'ALTER DATABASE "{b}" RENAME TO x',
                    f'ALTER DATABASE "{b}" SET work_mem = \'7MB\'',
                    f'ALTER ROLE "{b}" PASSWORD \'x\'', "CREATE ROLE sneaky",
                    "CREATE DATABASE sneaky"):
            with pytest.raises(asyncpg.PostgresError):
                await conn.execute(sql)
    finally:
        await conn.close()
    assert b in _databases()


class _RecordingConn:
    def __init__(self):
        self.sql: list[str] = []

    async def execute(self, sql, *args):
        self.sql.append(sql)


@pytest.mark.parametrize("lock", [True, False])
async def test_setup_locks_the_admin_databases(monkeypatch, lock):
    monkeypatch.setenv("SIRDAR_SCRATCH_URL", "postgresql://su:pw@scratch:5432/postgres")
    monkeypatch.setenv("SIRDAR_SCRATCH_LOCK_ADMIN_DBS", str(lock).lower())
    get_settings.cache_clear()
    scratch.forget_all()
    try:
        conn = _RecordingConn()
        await scratch._setup_server(conn, get_settings())
        await scratch._setup_server(conn, get_settings())          # once per process
        assert conn.sql == ([
            'REVOKE CONNECT ON DATABASE "postgres" FROM PUBLIC',
            'REVOKE CONNECT ON DATABASE "template1" FROM PUBLIC'] if lock else [])
    finally:
        scratch.forget_all()
        get_settings.cache_clear()


def test_tests_never_lock_the_shared_clusters_admin_databases():
    assert get_settings().scratch_lock_admin_dbs is False


async def test_a_roles_own_settings_never_survive(scratch_url, snapshots_dir, tmp_path,
                                                  good_dump):
    snap = _snapshot(tmp_path, good_dump)
    name = await scratch.ensure_restored(get_settings(), snap)

    async def plant():
        conn = await scratch.connect(get_settings(), name)
        try:
            await conn.execute(f'ALTER ROLE "{name}" SET work_mem = \'7MB\'')
        finally:
            await conn.close()

    async def work_mem() -> str:
        conn = await scratch.connect(get_settings(), name)
        try:
            return await conn.fetchval("SHOW work_mem")
        finally:
            await conn.close()

    await plant()
    assert await work_mem() == "7MB"
    # A restart: the password is unknown, so the role is reset (RESET ALL).
    scratch.forget_all()
    assert await work_mem() != "7MB"
    # A fresh restore: a new role.
    await plant()
    await scratch.drop(get_settings(), name)
    assert _role(name) is None
    await scratch.ensure_restored(get_settings(), snap)
    assert await work_mem() != "7MB"


async def test_dropping_a_database_drops_its_role(scratch_url, snapshots_dir, tmp_path,
                                                  good_dump):
    name = await scratch.ensure_restored(get_settings(), _snapshot(tmp_path, good_dump))
    assert _role(name) is not None
    await scratch.drop(get_settings(), name)
    assert name not in _databases() and _role(name) is None
    assert name not in scratch._passwords


async def test_startup_sweep_removes_leftover_roles(scratch_url):
    name = scratch.db_name(uuid.uuid4())
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        conn.execute(f'CREATE ROLE "{name}" LOGIN')
        conn.execute(f'GRANT SET ON PARAMETER session_replication_role TO "{name}"')
    assert await scratch.sweep_idle(get_settings()) == 0
    assert _role(name) is None


async def test_a_dumps_grant_to_another_role_never_breaks_drops_or_sweeps(
        scratch_url, snapshots_dir, tmp_path, good_dump):
    """A crafted dump restored as role A grants on A's objects to role B (it
    can see every role in pg_roles). B's role then can't be dropped while
    database A exists: the drop must still finish, B's role is left NOLOGIN,
    the sweep goes on past it, B can be restored again, and once A is gone
    a later sweep removes B's role."""
    settings = get_settings()
    snap_b = _snapshot(tmp_path, good_dump)
    a = await scratch.ensure_restored(settings, _snapshot(tmp_path, good_dump))
    b = await scratch.ensure_restored(settings, snap_b)
    conn = await scratch.connect(settings, a)
    try:
        await conn.execute(f'GRANT SELECT ON sites TO "{b}"')
    finally:
        await conn.close()
    # Dropping B: no error, nothing left "ready", the database gone, the
    # role inert (NOLOGIN) rather than live.
    await scratch.drop(settings, b)
    assert scratch.status(snap_b.id) == "absent"
    assert b not in _databases()
    assert _role(b) is not None and _role(b)[-1] is False
    assert b not in scratch._passwords
    # The sweep gets past B's undroppable role to the leftovers after it
    # (names sorting after "_browse_").
    planted_db = scratch.db_name(uuid.uuid4(), "zzz")
    planted_role = scratch.db_name(uuid.uuid4(), "zzz")
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{planted_db}"')
        c.execute(f'CREATE ROLE "{planted_role}" LOGIN')
    assert await scratch.sweep_idle(settings) == 1
    assert planted_db not in _databases() and _role(planted_role) is None
    assert _role(b) is not None and _role(b)[-1] is False     # still there, still inert
    # B can be restored again: its leftover role is reset and gets LOGIN back.
    assert await scratch.ensure_restored(settings, snap_b) == b
    assert _role(b) == (False, False, False, False, False, True)
    assert _tables(b) == {"sites": 2, "racks": 2}
    await scratch.drop(settings, b)
    assert _role(b)[-1] is False
    # Once A is gone, so are the privileges holding B's role: the next sweep drops it.
    await scratch.drop(settings, a)
    assert _role(a) is None
    assert await scratch.sweep_idle(settings) == 0
    assert _role(b) is None


async def test_sweep_continues_past_a_failing_drop(scratch_url, monkeypatch):
    first = scratch.db_name(uuid.uuid4(), "aaa")
    second = scratch.db_name(uuid.uuid4(), "zzz")
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as c:
        for name in (first, second):
            c.execute(f'CREATE DATABASE "{name}"')
    real = scratch._drop_db

    async def flaky(settings, name):
        if name == first:
            raise OSError("connection reset")
        await real(settings, name)

    monkeypatch.setattr(scratch, "_drop_db", flaky)
    assert await scratch.sweep_idle(get_settings()) == 1
    assert second not in _databases() and first in _databases()


async def test_sweep_creates_no_lock_entries_for_names_it_leaves_alone(scratch_url):
    name = scratch.db_name(uuid.uuid4())
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as c:
        c.execute(f'CREATE DATABASE "{name}"')
    scratch._state[name] = "restoring"            # as start_restore does, before the lock
    try:
        assert await scratch.sweep_idle(get_settings()) == 0
        assert name in _databases()
        assert name not in scratch._locks
    finally:
        scratch._state.pop(name, None)


async def test_first_time_password_setup_runs_once_per_name(scratch_url, monkeypatch):
    name = scratch.db_name(uuid.uuid4())
    calls: list[str] = []

    async def slow_setup(conn, role):
        calls.append(role)
        await asyncio.sleep(0.02)
        scratch._passwords[role] = "pw-" + role
        return scratch._passwords[role]

    monkeypatch.setattr(scratch, "_setup_role", slow_setup)
    got = await asyncio.gather(scratch._role_password(get_settings(), name),
                               scratch._role_password(get_settings(), name))
    assert calls == [name]
    assert got == ["pw-" + name] * 2


class _RecordingReal:
    """A real admin connection that also records every statement sent."""

    def __init__(self, conn, sql: list[str]):
        self._conn, self.sql = conn, sql

    async def execute(self, sql, *args):
        self.sql.append(sql)
        return await self._conn.execute(sql, *args)

    def __getattr__(self, attr):
        return getattr(self._conn, attr)


async def test_role_passwords_reach_the_server_only_as_scram_verifiers(
        scratch_url, snapshots_dir, tmp_path, good_dump, monkeypatch):
    sql: list[str] = []
    real_admin = scratch._admin

    async def recording_admin(settings):
        return _RecordingReal(await real_admin(settings), sql)

    monkeypatch.setattr(scratch, "_admin", recording_admin)
    snap = _snapshot(tmp_path, good_dump)
    name = await scratch.ensure_restored(get_settings(), snap)
    password = scratch._passwords[name]
    role_sql = [s for s in sql if s.startswith(("CREATE ROLE", "ALTER ROLE"))]
    assert role_sql, sql
    assert all(password not in s for s in sql)
    assert any("PASSWORD 'SCRAM-SHA-256$4096:" in s for s in role_sql)
    # ...and the plaintext still logs in.
    conn = await scratch.connect(get_settings(), name)
    try:
        assert await conn.fetchval("SELECT current_user") == name
    finally:
        await conn.close()


async def test_concurrent_callers_restore_once(scratch_url, snapshots_dir, tmp_path,
                                               good_dump, monkeypatch):
    snap = _snapshot(tmp_path, good_dump)
    calls: list[str] = []
    real_run = scratch._run

    async def counting(settings, tool, args, **kw):
        calls.append(tool)
        return await real_run(settings, tool, args, **kw)

    monkeypatch.setattr(scratch, "_run", counting)
    a, b = await asyncio.gather(scratch.ensure_restored(get_settings(), snap),
                                scratch.ensure_restored(get_settings(), snap))
    assert a == b
    assert calls.count("pg_restore") == 1
    assert _tables(a) == {"sites": 2, "racks": 2}


async def test_corrupt_dump_fails_and_leaves_no_database(scratch_url, snapshots_dir,
                                                         tmp_path):
    snap = _snapshot(tmp_path, b"PGDMP-this-is-not-a-dump")
    with pytest.raises(SeedError) as exc:
        await scratch.ensure_restored(get_settings(), snap)
    assert exc.value.code == "restore_failed"
    assert "detail" not in exc.value.extra        # pg_restore's stderr stays in the log
    assert scratch.status(snap.id) == "failed"
    assert scratch.db_name(snap.id) not in _databases()


async def test_missing_bundle_fails(scratch_url, snapshots_dir, tmp_path, good_dump):
    snap = _snapshot(tmp_path, good_dump)
    (snapshots_dir / snap.bundle_file).unlink()
    with pytest.raises(SeedError) as exc:
        await scratch.ensure_restored(get_settings(), snap)
    assert exc.value.code == "restore_failed"
    assert scratch.db_name(snap.id) not in _databases()


async def test_sweep_drops_idle_and_keeps_fresh(scratch_url, snapshots_dir, tmp_path,
                                                good_dump):
    old, fresh = _snapshot(tmp_path, good_dump), _snapshot(tmp_path, good_dump)
    old_name = await scratch.ensure_restored(get_settings(), old)
    fresh_name = await scratch.ensure_restored(get_settings(), fresh)
    scratch._last_used[old_name] -= (get_settings().scratch_idle_minutes + 1) * 60
    assert await scratch.sweep_idle(get_settings()) == 1
    names = _databases()
    assert old_name not in names and fresh_name in names
    assert (scratch.status(old.id), scratch.status(fresh.id)) == ("absent", "ready")


async def test_sweep_drops_browse_databases_left_by_an_earlier_run(
        scratch_url, snapshots_dir, tmp_path, good_dump):
    snap = _snapshot(tmp_path, good_dump)
    name = await scratch.ensure_restored(get_settings(), snap)
    scratch.forget_all()                      # as after a restart
    assert await scratch.sweep_idle(get_settings()) == 1
    assert name not in _databases()


async def test_drop_forgets_the_database(scratch_url, snapshots_dir, tmp_path, good_dump):
    snap = _snapshot(tmp_path, good_dump)
    name = await scratch.ensure_restored(get_settings(), snap)
    await scratch.drop(get_settings(), name)
    assert name not in _databases()
    assert scratch.status(snap.id) == "absent"


async def test_sweep_drops_leftover_scratch_databases_of_any_purpose(scratch_url):
    name = scratch.db_name(uuid.uuid4(), "build")
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        conn.execute(f'CREATE DATABASE "{name}"')
    assert await scratch.sweep_idle(get_settings()) == 1
    assert name not in _databases()


async def test_cancelled_restore_leaves_no_files_or_database(scratch_url, snapshots_dir,
                                                             tmp_path, good_dump,
                                                             monkeypatch):
    snap = _snapshot(tmp_path, good_dump)
    started = asyncio.Event()

    async def hang(settings, tool, args, **kw):
        started.set()
        await asyncio.Event().wait()

    monkeypatch.setattr(scratch, "_run", hang)
    task = asyncio.create_task(scratch.ensure_restored(get_settings(), snap))
    await asyncio.wait_for(started.wait(), 10)
    assert [p.name[:8] for p in (snapshots_dir / "incoming").iterdir()] == ["scratch-"]
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert list((snapshots_dir / "incoming").iterdir()) == []
    assert scratch.db_name(snap.id) not in _databases()
    assert _role(scratch.db_name(snap.id)) is None
    assert scratch.status(snap.id) == "failed"


async def test_a_second_cancel_still_waits_for_the_extract(scratch_url, snapshots_dir,
                                                           tmp_path, good_dump, monkeypatch):
    import threading
    snap = _snapshot(tmp_path, good_dump)
    entered, release, seen = threading.Event(), threading.Event(), []

    def slow(settings, snap, dest, stop=None):
        entered.set()
        release.wait(10)
        seen.append(stop.is_set())
        raise scratch._Stopped

    monkeypatch.setattr(scratch, "_extract_dump", slow)
    task = asyncio.create_task(scratch.ensure_restored(get_settings(), snap))
    assert await asyncio.to_thread(entered.wait, 10)
    for _ in range(2):
        task.cancel()
        await asyncio.sleep(0.05)
    assert not task.done()                     # still waiting for the thread
    assert [p.name[:8] for p in (snapshots_dir / "incoming").iterdir()] == ["scratch-"]
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert seen == [True]
    assert list((snapshots_dir / "incoming").iterdir()) == []


async def test_a_check_hiccup_never_fails_a_ready_database(scratch_url, snapshots_dir,
                                                           tmp_path, good_dump, monkeypatch):
    snap = _snapshot(tmp_path, good_dump)
    name = await scratch.ensure_restored(get_settings(), snap)

    async def down(settings, name):
        raise OSError("connection refused")

    monkeypatch.setattr(scratch, "_exists", down)
    with pytest.raises(SeedError) as exc:
        await scratch.ensure_restored(get_settings(), snap)
    assert exc.value.code == "scratch_unavailable"
    assert scratch.status(snap.id) == "ready" and name in _databases()


def test_a_stopped_extract_writes_nothing(snapshots_dir, tmp_path, good_dump):
    import threading
    snap = _snapshot(tmp_path, good_dump)
    out = tmp_path / "out"
    out.mkdir()
    stop = threading.Event()
    stop.set()
    with pytest.raises(scratch._Stopped):
        scratch._extract_dump(get_settings(), snap, out, stop)
    assert list(out.iterdir()) == []


def test_startup_sweep_removes_scratch_work_folders(snapshots_dir):
    planted = snapshots_dir / "incoming" / "scratch-x"
    planted.mkdir(parents=True)
    (planted / "db.dump").write_bytes(b"PGDMP plaintext rows")
    keep = snapshots_dir / "incoming" / "other-folder"
    keep.mkdir()
    assert snapshots.sweep_incoming(get_settings()) == 1
    assert not planted.exists() and keep.exists()


async def test_background_restore_never_sticks_at_restoring(scratch_url, monkeypatch):
    async def boom(settings, snap, purpose="browse"):
        raise RuntimeError("scratch server went away")

    monkeypatch.setattr(scratch, "ensure_restored", boom)
    snap = Snapshot(id=uuid.uuid4(), bundle_file="x.tar.gz")
    assert scratch.start_restore(get_settings(), snap) == "restoring"
    await asyncio.gather(*scratch._tasks)
    assert scratch.status(snap.id) == "failed"


async def test_sweep_without_scratch_url_does_nothing(monkeypatch):
    monkeypatch.setenv("SIRDAR_SCRATCH_URL", "")
    get_settings.cache_clear()
    try:
        assert await scratch.sweep_idle(get_settings()) == 0
    finally:
        get_settings.cache_clear()


# ---- the API ---------------------------------------------------------------------

async def test_api_answers_409_without_a_scratch_url(client, db, monkeypatch):
    monkeypatch.setenv("SIRDAR_SCRATCH_URL", "")
    get_settings.cache_clear()
    try:
        headers = await auth_headers(client, db)
        sid = uuid.uuid4()
        for method, path in (("POST", f"/api/seed/snapshots/{sid}/open"),
                             ("GET", f"/api/seed/snapshots/{sid}")):
            resp = await client.request(method, path, headers=headers)
            assert resp.status_code == 409, resp.text
            assert resp.json()["detail"]["code"] == "scratch_not_configured"
    finally:
        get_settings.cache_clear()


async def test_api_answers_409_for_an_unusable_scratch_url(client, db, monkeypatch):
    monkeypatch.setenv("SIRDAR_SCRATCH_URL", "not a url")
    get_settings.cache_clear()
    try:
        assert not scratch.configured(get_settings())
        headers = await auth_headers(client, db)
        resp = await client.get(f"/api/seed/snapshots/{uuid.uuid4()}", headers=headers)
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "scratch_not_configured"
        assert "not a url" not in resp.text
    finally:
        get_settings.cache_clear()


async def test_api_needs_sign_in_first(client, monkeypatch):
    monkeypatch.setenv("SIRDAR_SCRATCH_URL", "")
    get_settings.cache_clear()
    try:
        resp = await client.get(f"/api/seed/snapshots/{uuid.uuid4()}")
        assert resp.status_code == 401
    finally:
        get_settings.cache_clear()


async def test_api_opens_a_snapshot(client, db, scratch_url, snapshots_dir, tmp_path,
                                    good_dump):
    snap = _snapshot(tmp_path, good_dump)
    db.add(snap)
    await db.commit()
    headers = await auth_headers(client, db)
    resp = await client.post(f"/api/seed/snapshots/{snap.id}/open", headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] in ("restoring", "ready")
    for _ in range(200):
        resp = await client.get(f"/api/seed/snapshots/{snap.id}", headers=headers)
        if resp.json()["status"] != "restoring":
            break
        await asyncio.sleep(0.05)
    assert resp.json() == {"status": "ready"}
    assert (await client.get(f"/api/seed/snapshots/{uuid.uuid4()}",
                             headers=headers)).status_code == 404


@pytest.mark.parametrize("url, runs", [("", False), ("postgresql://u:p@scratch/postgres", True)])
async def test_app_sweeps_only_with_a_scratch_url(monkeypatch, url, runs):
    from sirdar_api.api.app import create_app

    events: list[str] = []

    async def fake_loop(settings, seconds=scratch.SWEEP_SECONDS):
        events.append(f"loop {seconds}")
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            events.append("cancelled")
            raise

    async def fake_sweep(settings):
        events.append("startup sweep")
        return 0

    monkeypatch.setattr(scratch, "sweep_loop", fake_loop)
    monkeypatch.setattr(scratch, "sweep_idle", fake_sweep)
    monkeypatch.setenv("SIRDAR_SCRATCH_URL", url)
    get_settings.cache_clear()
    try:
        app = create_app()
        async with app.router.lifespan_context(app):
            await asyncio.sleep(0)
    finally:
        get_settings.cache_clear()
    assert events == (["startup sweep", f"loop {scratch.SWEEP_SECONDS}", "cancelled"]
                      if runs else [])


# ---- what a failed pg tool logs ----------------------------------------------------------

def test_tool_error_lines_keep_only_the_tools_error_lines():
    err = "\n".join([  # noqa: FLY002 - one stderr line per item
        "pg_restore: while PROCESSING TOC:",
        'pg_restore: from TOC entry 3 TABLE DATA people',
        ('pg_restore: error: COPY failed for table "people": ERROR:  bad row '
         "DETAIL:  Key (x)=(secret)"),
        "DETAIL:  Key (email)=(ann@x.test) already exists.",
        'CONTEXT:  COPY people, line 1: "1\tAnn\thash-ann"',
        "pg_dump: error: query failed CONTEXT: row text here",
        "  pg_restore: error: indented, not the tool's own line",
        "pg_restore: warning: errors ignored on restore: 1",
    ])
    assert scratch.tool_error_lines(err) == [
        'pg_restore: error: COPY failed for table "people": ERROR:  bad row',
        "pg_dump: error: query failed",
    ]
    assert scratch.tool_error_lines("") == []
    long = "pg_dump: error: " + "x" * 1000
    assert len(scratch.tool_error_lines(long)[0]) <= 300


def test_a_failed_restore_logs_the_code_and_error_lines_only(caplog):
    with caplog.at_level("WARNING"):
        scratch.log_tool_failure("pg_restore into a scratch database", 1,
                                 'pg_restore: error: oops\nCONTEXT:  COPY t, line 1: "row text"')
    text = caplog.text
    assert "exited with 1" in text and "pg_restore: error: oops" in text
    assert "row text" not in text
