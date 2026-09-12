"""DB testing mode: the password gate, the start/end API, the
db-testing-worker's snapshot and revert processing, and the status
endpoint's live change tracking. Storage, pg_dump/psql, and the
terminate-backends/schema-reset step are all monkeypatched onto
devtools.testing.runner — the suite must never actually drop its own
test schema."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import delete, select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    AuditLog, DbBackup, DbTestingSession, Person, PersonRole, SystemConfig,
    SystemProcess,
)
from serversherpa.devtools.testing import worker
from serversherpa.devtools.testing.jobs import claim_next, requeue_stale
from serversherpa.services.db_backup import PsqlFailed
from serversherpa.system.admin_config import read_admin_config
from tests.test_assets_api import login, make_login
from tests.test_devtools import login as devtools_login
from tests.test_devtools import set_role

TESTING_PASSWORD = "TestingPass9!"
FAKE_DUMP = b"-- fake testing snapshot dump\n"


@pytest.fixture
def testing_password(monkeypatch):
    """Pin the password for the test rather than depending on the
    SS_DB_TESTING_PASSWORD default."""
    from serversherpa.config import get_settings

    monkeypatch.setenv("SS_DB_TESTING_PASSWORD", TESTING_PASSWORD)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


class _FakeStorage:
    def __init__(self):
        self.objects: dict[str, bytes] = {}

    async def put_object(self, key, data, content_type):
        self.objects[key] = data

    async def get_object(self, key):
        return self.objects[key]


@pytest.fixture
def fake_storage(monkeypatch):
    fake = _FakeStorage()
    monkeypatch.setattr("serversherpa.devtools.testing.runner.put_object", fake.put_object)
    monkeypatch.setattr("serversherpa.devtools.testing.runner.get_object", fake.get_object)
    return fake


@pytest.fixture
def fake_pg_dump(monkeypatch):
    async def _fake(database_url):
        return FAKE_DUMP

    monkeypatch.setattr("serversherpa.devtools.testing.runner.run_pg_dump", _fake)


@pytest.fixture
def fake_psql_restore(monkeypatch):
    """Simulates what a REAL restore does — the snapshot's own db_backups
    row and the admin config's `admin` row both post-date the dump, so a
    genuine restore wipes them; the session row is deleted here too (the
    reviewer's simulation, standing in for "gone, must be rebuilt from
    memory" regardless of the finer point that a real restore actually
    brings it back in its pre-snapshot shape — see the runner's
    docstring). This makes the runner's re-insert/rewrite branches
    load-bearing: disable any one of them and a test here must fail,
    never pass silently because the stub never took anything away."""
    calls = []

    async def _fake(database_url, sql):
        calls.append((database_url, sql))
        async with get_sessionmaker()() as wipe:
            await wipe.execute(delete(DbTestingSession))
            await wipe.execute(delete(DbBackup))
            await wipe.execute(delete(SystemConfig).where(SystemConfig.section == "admin"))
            await wipe.commit()

    monkeypatch.setattr("serversherpa.devtools.testing.runner.run_psql_restore", _fake)
    return calls


@pytest.fixture
def fake_terminate(monkeypatch):
    """Stub the terminate-other-backends-and-dispose step: the suite must
    never actually terminate its own connections or dispose the shared
    test engine. The schema drop/recreate itself is no longer part of
    this step (see runner._SCHEMA_RESET_SQL) — it travels inside
    run_psql_restore's own transaction, so `fake_psql_restore` above is
    what simulates the wipe."""
    calls = []

    async def _fake(database_url):
        calls.append(database_url)

    monkeypatch.setattr(
        "serversherpa.devtools.testing.runner._terminate_other_backends_and_dispose",
        _fake)
    return calls


async def _developer(db, client_api, seeded_user):
    await set_role(db, seeded_user.id, "developer")
    return await devtools_login(client_api)


async def _mark_worker(db, *, online=True, stale=False):
    if online:
        age = timedelta(seconds=45) if stale else timedelta(seconds=1)
    else:
        age = None
    row = SystemProcess(
        name="db-testing-worker", kind="worker",
        heartbeat_at=(datetime.now(UTC) - age) if age is not None else None,
        started_at=datetime.now(UTC))
    db.add(row)
    await db.commit()


PRE_TESTING_MESSAGE = "pre-existing maintenance note, unrelated to testing mode"


async def _seed_pre_testing_admin_config(db):
    """A non-default admin config row, so a revert test that asserts the
    banner/read-only state "came back" can't be satisfied by coincidence:
    Postgres's own defaults (read_only=False, banner_enabled=False) would
    silently match an admin row that was never rewritten at all — this
    sentinel wouldn't."""
    db.add(SystemConfig(section="admin", data={
        "read_only": False, "read_only_message": PRE_TESTING_MESSAGE,
        "pause_workers": False, "banner_enabled": False, "banner_message": ""}))
    await db.commit()


# ── password gate ────────────────────────────────────────────────────


async def test_start_missing_password_is_422(client, db, seeded_user, testing_password):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/db-testing/start", headers=hdrs, json={})
    assert resp.status_code == 422


async def test_start_wrong_password_is_403_and_audited(
        client, db, seeded_user, testing_password):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/db-testing/start", headers=hdrs,
                             json={"password": "nope"})
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "invalid_testing_password"

    row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "db_testing.auth_failed"))
    assert row is not None
    assert TESTING_PASSWORD not in str(row.changes)
    assert "nope" not in str(row.changes)


async def test_five_failures_then_rate_limited(client, db, seeded_user, testing_password):
    hdrs = await _developer(db, client, seeded_user)
    for _ in range(5):
        resp = await client.post("/devtools/db-testing/start", headers=hdrs,
                                 json={"password": "nope"})
        assert resp.status_code == 403
    resp = await client.post("/devtools/db-testing/start", headers=hdrs,
                             json={"password": "nope"})
    assert resp.status_code == 429
    assert resp.json()["detail"]["code"] == "too_many_attempts"
    # even the RIGHT password is refused once rate-limited
    resp = await client.post("/devtools/db-testing/start", headers=hdrs,
                             json={"password": TESTING_PASSWORD})
    assert resp.status_code == 429


async def test_viewer_without_devtools_is_403(client, db, seeded_user, testing_password):
    staff = Person(first_name="St", last_name="Aff")
    db.add(staff)
    await db.flush()
    db.add(PersonRole(person_id=staff.id, role="staff"))
    await db.commit()
    hdrs = await make_login(db, client, staff, "staff-dbtest@test.example.com")
    resp = await client.get("/devtools/db-testing/status", headers=hdrs)
    assert resp.status_code == 403
    resp = await client.post("/devtools/db-testing/start", headers=hdrs,
                             json={"password": TESTING_PASSWORD})
    assert resp.status_code == 403


# ── start ────────────────────────────────────────────────────────────


async def test_start_worker_offline_is_503(client, db, seeded_user, testing_password):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/db-testing/start", headers=hdrs,
                             json={"password": TESTING_PASSWORD})
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "worker_offline"


async def test_start_stale_heartbeat_counts_as_offline(client, db, seeded_user,
                                                       testing_password):
    await _mark_worker(db, online=True, stale=True)
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/db-testing/start", headers=hdrs,
                             json={"password": TESTING_PASSWORD})
    assert resp.status_code == 503


async def test_start_creates_snapshotting_session(client, db, seeded_user, testing_password):
    await _mark_worker(db)
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/db-testing/start", headers=hdrs,
                             json={"password": TESTING_PASSWORD})
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["status"] == "snapshotting"
    assert body["started_by_name"] == "Alice Anderson"
    assert body["snapshot_filename"] is None

    row = await db.scalar(select(AuditLog).where(AuditLog.action == "db_testing.start"))
    assert row is not None


async def test_second_start_while_active_is_409(client, db, seeded_user, testing_password):
    await _mark_worker(db)
    hdrs = await _developer(db, client, seeded_user)
    first = await client.post("/devtools/db-testing/start", headers=hdrs,
                              json={"password": TESTING_PASSWORD})
    assert first.status_code == 202
    second = await client.post("/devtools/db-testing/start", headers=hdrs,
                               json={"password": TESTING_PASSWORD})
    assert second.status_code == 409
    assert second.json()["detail"]["code"] == "session_active"


# ── worker: snapshot ─────────────────────────────────────────────────


async def _start_session(db, client, seeded_user, testing_password) -> tuple[dict, str]:
    await _mark_worker(db)
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/db-testing/start", headers=hdrs,
                             json={"password": TESTING_PASSWORD})
    assert resp.status_code == 202, resp.text
    return hdrs, resp.json()["id"]


async def test_worker_snapshot_captures_row_counts_and_sets_banner(
        client, db, seeded_user, testing_password, fake_storage, fake_pg_dump):
    hdrs, session_id = await _start_session(db, client, seeded_user, testing_password)

    worked = await worker.run_once(get_sessionmaker())
    assert worked is True

    session = await db.get(DbTestingSession, session_id)
    assert session.status == "active", session.error
    assert session.row_counts
    assert "people" in session.row_counts
    assert session.snapshot_backup_id is not None
    assert session.previous_banner == {
        "read_only": False, "read_only_message": "", "pause_workers": False,
        "banner_enabled": False, "banner_message": "",
    }

    backup = await db.get(DbBackup, session.snapshot_backup_id)
    assert backup.purpose == "testing_snapshot"
    assert backup.encrypted is False
    [stored] = fake_storage.objects.values()
    assert stored == FAKE_DUMP

    cfg = await read_admin_config(db)
    assert cfg["banner_enabled"] is True
    assert "Database testing mode is ON" in cfg["banner_message"]

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "db_testing.snapshotted"))
    assert audit_row is not None


async def test_worker_snapshot_failure_marks_session_failed(
        client, db, seeded_user, testing_password, monkeypatch):
    from serversherpa.services.db_backup import PgDumpUnavailable

    async def _boom(database_url):
        raise PgDumpUnavailable()

    monkeypatch.setattr("serversherpa.devtools.testing.runner.run_pg_dump", _boom)
    hdrs, session_id = await _start_session(db, client, seeded_user, testing_password)

    assert await worker.run_once(get_sessionmaker()) is True
    session = await db.get(DbTestingSession, session_id)
    assert session.status == "failed"
    assert "PgDumpUnavailable" in session.error


# ── end: keep ────────────────────────────────────────────────────────


async def test_end_keep_restores_banner_and_keeps_snapshot(
        client, db, seeded_user, testing_password, fake_storage, fake_pg_dump):
    hdrs, session_id = await _start_session(db, client, seeded_user, testing_password)
    assert await worker.run_once(get_sessionmaker()) is True

    resp = await client.post("/devtools/db-testing/end", headers=hdrs,
                             json={"password": TESTING_PASSWORD, "revert": False})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "ended"
    assert body["ended_with"] == "kept"

    cfg = await read_admin_config(db)
    assert cfg["banner_enabled"] is False
    assert cfg["read_only"] is False

    listing = (await client.get("/devtools/backups", headers=hdrs)).json()
    snapshots = [b for b in listing if b["purpose"] == "testing_snapshot"]
    assert len(snapshots) == 1


async def test_end_wrong_password_is_403(
        client, db, seeded_user, testing_password, fake_storage, fake_pg_dump):
    hdrs, session_id = await _start_session(db, client, seeded_user, testing_password)
    assert await worker.run_once(get_sessionmaker()) is True

    resp = await client.post("/devtools/db-testing/end", headers=hdrs,
                             json={"password": "nope", "revert": False})
    assert resp.status_code == 403
    session = await db.get(DbTestingSession, session_id)
    assert session.status == "active"


async def test_end_when_not_active_is_409(client, db, seeded_user, testing_password):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/db-testing/end", headers=hdrs,
                             json={"password": TESTING_PASSWORD, "revert": False})
    assert resp.status_code == 409
    assert resp.json()["detail"]["code"] == "session_not_active"


async def test_end_revert_with_worker_offline_is_503(
        client, db, seeded_user, testing_password, fake_storage, fake_pg_dump):
    hdrs, session_id = await _start_session(db, client, seeded_user, testing_password)
    assert await worker.run_once(get_sessionmaker()) is True

    # the worker that took the snapshot has since gone quiet
    proc = await db.get(SystemProcess, "db-testing-worker")
    proc.heartbeat_at = datetime.now(UTC) - timedelta(seconds=45)
    await db.commit()

    resp = await client.post("/devtools/db-testing/end", headers=hdrs,
                             json={"password": TESTING_PASSWORD, "revert": True})
    assert resp.status_code == 503
    assert resp.json()["detail"]["code"] == "worker_offline"

    session = await db.get(DbTestingSession, uuid.UUID(session_id))
    assert session.status == "active"          # untouched — nothing was claimed


async def test_end_keep_does_not_require_worker_online(
        client, db, seeded_user, testing_password, fake_storage, fake_pg_dump):
    """Keep is API-side and immediate — it needs no worker at all."""
    hdrs, session_id = await _start_session(db, client, seeded_user, testing_password)
    assert await worker.run_once(get_sessionmaker()) is True

    proc = await db.get(SystemProcess, "db-testing-worker")
    proc.heartbeat_at = None
    await db.commit()

    resp = await client.post("/devtools/db-testing/end", headers=hdrs,
                             json={"password": TESTING_PASSWORD, "revert": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["ended_with"] == "kept"


# ── end: revert ──────────────────────────────────────────────────────


async def test_end_revert_then_worker_restores_and_reinserts_rows(
        client, db, seeded_user, testing_password, fake_storage, fake_pg_dump,
        fake_psql_restore, fake_terminate):
    await _seed_pre_testing_admin_config(db)
    hdrs, session_id = await _start_session(db, client, seeded_user, testing_password)
    assert await worker.run_once(get_sessionmaker()) is True

    resp = await client.post("/devtools/db-testing/end", headers=hdrs,
                             json={"password": TESTING_PASSWORD, "revert": True})
    assert resp.status_code == 202, resp.text
    assert resp.json()["status"] == "reverting"

    assert await worker.run_once(get_sessionmaker()) is True

    session = await db.get(DbTestingSession, session_id)
    assert session.status == "ended", session.error
    assert session.ended_with == "reverted"
    assert session.ended_at is not None

    # terminate-backends and the psql restore both ran, with the schema
    # drop/recreate prepended INSIDE the same SQL psql restores — never a
    # separate, already-committed statement ahead of it — and the
    # snapshot's own dump bytes fed back in after it
    assert len(fake_terminate) == 1
    assert len(fake_psql_restore) == 1
    _database_url, restored_sql = fake_psql_restore[0]
    assert restored_sql.startswith(b"DROP SCHEMA public CASCADE;")
    assert b"CREATE SCHEMA public;" in restored_sql
    assert restored_sql.endswith(FAKE_DUMP)

    # the snapshot backup row still exists (re-inserted from the values
    # held in memory — fake_psql_restore's stub genuinely deleted it)
    backup = await db.get(DbBackup, session.snapshot_backup_id)
    assert backup is not None
    assert backup.purpose == "testing_snapshot"

    cfg = await read_admin_config(db)
    assert cfg["read_only"] is False
    assert cfg["banner_enabled"] is False
    # the pre-existing sentinel, not just Postgres's own defaults —
    # proves _write_admin_config actually ran with previous_banner rather
    # than the assertion above being satisfied by an absent row
    assert cfg["read_only_message"] == PRE_TESTING_MESSAGE

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "db_testing.reverted"))
    assert audit_row is not None


async def test_revert_turns_read_only_on_during_and_off_after(
        client, db, seeded_user, testing_password, fake_storage, fake_pg_dump,
        fake_psql_restore, monkeypatch):
    hdrs, session_id = await _start_session(db, client, seeded_user, testing_password)
    assert await worker.run_once(get_sessionmaker()) is True
    resp = await client.post("/devtools/db-testing/end", headers=hdrs,
                             json={"password": TESTING_PASSWORD, "revert": True})
    assert resp.status_code == 202

    observed = {}

    async def _check_read_only_then_noop(database_url):
        async with get_sessionmaker()() as check:
            observed["cfg"] = await read_admin_config(check)

    monkeypatch.setattr(
        "serversherpa.devtools.testing.runner._terminate_other_backends_and_dispose",
        _check_read_only_then_noop)

    assert await worker.run_once(get_sessionmaker()) is True
    assert observed["cfg"]["read_only"] is True
    assert observed["cfg"]["pause_workers"] is True

    cfg_after = await read_admin_config(db)
    assert cfg_after["read_only"] is False
    assert cfg_after["pause_workers"] is False


async def test_revert_failure_leaves_read_only_on_and_session_failed(
        client, db, seeded_user, testing_password, fake_storage, fake_pg_dump,
        fake_terminate, monkeypatch):
    hdrs, session_id = await _start_session(db, client, seeded_user, testing_password)
    assert await worker.run_once(get_sessionmaker()) is True
    resp = await client.post("/devtools/db-testing/end", headers=hdrs,
                             json={"password": TESTING_PASSWORD, "revert": True})
    assert resp.status_code == 202

    async def _boom(database_url, sql):
        raise PsqlFailed(b"syntax error near restore")

    monkeypatch.setattr("serversherpa.devtools.testing.runner.run_psql_restore", _boom)

    assert await worker.run_once(get_sessionmaker()) is True

    session = await db.get(DbTestingSession, session_id)
    assert session.status == "failed"
    assert "PsqlFailed" in session.error

    cfg = await read_admin_config(db)
    assert cfg["read_only"] is True          # left ON on purpose

    audit_row = await db.scalar(select(AuditLog).where(
        AuditLog.action == "db_testing.failed"))
    assert audit_row is not None


# ── status / changes ─────────────────────────────────────────────────


async def test_status_reports_worker_online_and_recent(client, db, seeded_user,
                                                        testing_password):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get("/devtools/db-testing/status", headers=hdrs)
    assert resp.status_code == 200
    assert resp.json()["worker_online"] is False

    await _mark_worker(db)
    resp = await client.get("/devtools/db-testing/status", headers=hdrs)
    assert resp.json()["worker_online"] is True


async def test_status_snapshot_filename_null_then_set(
        client, db, seeded_user, testing_password, fake_storage, fake_pg_dump):
    hdrs, session_id = await _start_session(db, client, seeded_user, testing_password)

    # still snapshotting — no backup row yet, so no filename
    before = (await client.get("/devtools/db-testing/status", headers=hdrs)).json()
    assert before["session"]["status"] == "snapshotting"
    assert before["session"]["snapshot_filename"] is None

    assert await worker.run_once(get_sessionmaker()) is True

    after = (await client.get("/devtools/db-testing/status", headers=hdrs)).json()
    assert after["session"]["status"] == "active"
    assert after["session"]["snapshot_filename"] is not None
    assert after["session"]["snapshot_filename"].startswith("testing_snapshot_")

    session = await db.get(DbTestingSession, uuid.UUID(session_id))
    backup = await db.get(DbBackup, session.snapshot_backup_id)
    assert after["session"]["snapshot_filename"] == backup.filename

    resp = await client.post("/devtools/db-testing/end", headers=hdrs,
                             json={"password": TESTING_PASSWORD, "revert": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["snapshot_filename"] == backup.filename

    recent = (await client.get(
        "/devtools/db-testing/status", headers=hdrs)).json()["recent"]
    ended = next(s for s in recent if s["id"] == session_id)
    assert ended["snapshot_filename"] == backup.filename


async def test_status_changes_reports_deltas_and_audit_rows(
        client, db, seeded_user, testing_password, fake_storage, fake_pg_dump):
    hdrs, session_id = await _start_session(db, client, seeded_user, testing_password)
    assert await worker.run_once(get_sessionmaker()) is True

    baseline = (await client.get("/devtools/db-testing/status", headers=hdrs)).json()
    assert baseline["session"]["status"] == "active"
    baseline_audit_rows = baseline["changes"]["audit_rows"]

    extra = Person(first_name="New", last_name="Person")
    db.add(extra)
    await db.commit()

    resp = await client.get("/devtools/db-testing/status", headers=hdrs)
    body = resp.json()
    people_change = next(t for t in body["changes"]["tables"] if t["table"] == "people")
    assert people_change["delta"] == 1
    assert people_change["after"] == people_change["before"] + 1
    assert body["changes"]["audit_rows"] >= baseline_audit_rows


# ── jobs: claim/requeue ──────────────────────────────────────────────


async def test_claim_next_skips_freshly_claimed_and_requeue_frees_stale(
        client, db, seeded_user, testing_password):
    hdrs, session_id_str = await _start_session(db, client, seeded_user, testing_password)
    session_id = uuid.UUID(session_id_str)

    claimed = await claim_next(db)
    assert claimed is not None and claimed.id == session_id
    assert claimed.worker_id is not None

    # a second claim attempt finds nothing — the row's heartbeat is fresh
    assert await claim_next(db) is None

    # simulate a dead worker: heartbeat far in the past
    session = await db.get(DbTestingSession, session_id)
    session.heartbeat_at = datetime.now(UTC) - timedelta(minutes=30)
    await db.commit()

    requeued = await requeue_stale(db)
    assert requeued == 1
    session = await db.get(DbTestingSession, session_id)
    assert session.worker_id is None
    assert session.heartbeat_at is None

    reclaimed = await claim_next(db)
    assert reclaimed is not None and reclaimed.id == session_id


# ── db_backups.purpose ───────────────────────────────────────────────


async def test_list_db_backups_reports_purpose(
        client, db, seeded_user, monkeypatch):
    async def _fake_pg_dump(database_url):
        return b"-- manual dump\n"

    class _Storage:
        def __init__(self):
            self.objects = {}

        async def put_object(self, key, data, content_type):
            self.objects[key] = data

    storage = _Storage()
    monkeypatch.setattr("serversherpa.api.routes.devtools.run_pg_dump", _fake_pg_dump)
    monkeypatch.setattr("serversherpa.api.routes.devtools.put_object", storage.put_object)
    monkeypatch.setattr(
        "serversherpa.api.routes.devtools.presign_get",
        lambda key, **kw: f"https://fake/{key}")

    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post("/devtools/backups", headers=hdrs, json={"encrypt": False})
    assert resp.status_code == 200, resp.text
    assert resp.json()["purpose"] == "manual"

    listing = (await client.get("/devtools/backups", headers=hdrs)).json()
    assert listing[0]["purpose"] == "manual"


# ── CLI ──────────────────────────────────────────────────────────────


def test_cli_db_testing_worker_command_exists():
    from typer.testing import CliRunner

    from serversherpa.cli import app

    result = CliRunner().invoke(app, ["db-testing-worker", "--help"])
    assert result.exit_code == 0
    assert "--reload" in result.output
