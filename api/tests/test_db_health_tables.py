"""Database health (Dev -> Database -> Health): per-table statistics and the
per-table Vacuum & analyze."""

import uuid
from contextlib import AsyncExitStack
from datetime import UTC, datetime

import pytest
from sqlalchemy import select, text

from serversherpa.db.models import (
    AuditLog,
    DbTestingSession,
    Note,
    PermissionOverride,
    Person,
    PersonRole,
)
from tests.test_assets_api import make_login
from tests.test_devtools import login as devtools_login
from tests.test_devtools import set_role

NOW = datetime.now(UTC)
STAT_KEYS = {"name", "rows", "total_bytes", "table_bytes", "index_bytes", "dead_rows",
             "dead_ratio", "last_vacuum_at", "last_analyze_at"}


async def _developer(db, client, seeded_user):
    await set_role(db, seeded_user.id, "developer")
    return await devtools_login(client)


def _vacuum(client, hdrs, name):
    return client.post(f"/devtools/health/tables/{name}/vacuum", headers=hdrs)


# -- tables ------------------------------------------------------------


async def test_tables_lists_known_tables_with_sane_numbers(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get("/devtools/health/tables", headers=hdrs)
    assert resp.status_code == 200, resp.text
    tables = resp.json()["tables"]
    by_name = {t["name"]: t for t in tables}
    assert {"assets", "people", "audit_log"} <= set(by_name)
    for t in tables:
        assert set(t) == STAT_KEYS
        for key in ("rows", "total_bytes", "table_bytes", "index_bytes", "dead_rows"):
            assert isinstance(t[key], int) and t[key] >= 0, (t["name"], key)
        if t["dead_ratio"] is not None:
            assert 0 <= t["dead_ratio"] <= 1
        else:
            assert t["rows"] == 0 and t["dead_rows"] == 0
    assert by_name["people"]["total_bytes"] > 0


async def test_tables_sorted_by_total_size_descending(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    tables = (await client.get("/devtools/health/tables", headers=hdrs)).json()["tables"]
    sizes = [t["total_bytes"] for t in tables]
    assert sizes == sorted(sizes, reverse=True)


async def test_tables_only_public_schema_tables(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    names = {t["name"] for t in
             (await client.get("/devtools/health/tables", headers=hdrs)).json()["tables"]}
    public = set((await db.scalars(text(
        "SELECT relname FROM pg_stat_user_tables WHERE schemaname = 'public'"))).all())
    assert names == public


# -- vacuum --------------------------------------------------------------


async def test_vacuum_refreshes_stats_and_writes_an_audit_row(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    actor_id = seeded_user.id
    note = Note(entity_type="asset", entity_id=uuid.uuid4(), body="x")
    db.add(note)
    await db.commit()
    await db.delete(note)
    await db.commit()

    resp = await _vacuum(client, hdrs, "notes")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"table", "duration_ms"}
    assert set(body["table"]) == STAT_KEYS
    assert body["table"]["name"] == "notes"
    assert isinstance(body["duration_ms"], int) and body["duration_ms"] >= 0
    # Postgres records a manual VACUUM / ANALYZE synchronously
    assert body["table"]["last_vacuum_at"] is not None
    assert body["table"]["last_analyze_at"] is not None

    db.expire_all()
    (row,) = (await db.scalars(select(AuditLog).where(AuditLog.action == "db.vacuum"))).all()
    assert row.entity_type == "system"
    assert row.actor_person_id == actor_id
    assert row.changes["table"] == "notes"
    assert row.changes["duration_ms"] == body["duration_ms"]


async def test_vacuum_unknown_table_is_404(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await _vacuum(client, hdrs, "no_such_table")
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "unknown_table"


@pytest.mark.parametrize("name", [
    'notes"; DROP TABLE people; --',
    "notes;DROP TABLE people",
    "pg_catalog.pg_class",
    "information_schema.tables",
    "pg_class",
])
async def test_vacuum_crafted_or_non_public_names_are_404(client, db, seeded_user, name):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.post(
        "/devtools/health/tables/" + name.replace(";", "%3B").replace('"', "%22")
        .replace(" ", "%20") + "/vacuum", headers=hdrs)
    assert resp.status_code == 404, resp.text
    db.expire_all()
    assert await db.scalar(text("SELECT count(*) FROM people")) >= 1   # still there
    assert (await db.scalars(select(AuditLog).where(AuditLog.action == "db.vacuum"))).all() == []


@pytest.mark.parametrize("status", ["snapshotting", "active", "reverting"])
async def test_vacuum_refused_while_a_db_testing_session_is_unfinished(
        client, db, seeded_user, status):
    db.add(DbTestingSession(
        status=status, row_counts={}, audit_watermark=NOW, started_by=seeded_user.id))
    await db.commit()
    hdrs = await _developer(db, client, seeded_user)
    resp = await _vacuum(client, hdrs, "notes")
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "testing_session_active"
    db.expire_all()
    assert (await db.scalars(select(AuditLog).where(AuditLog.action == "db.vacuum"))).all() == []
    # looking is still fine
    assert (await client.get("/devtools/health/tables", headers=hdrs)).status_code == 200


async def test_vacuum_allowed_once_the_db_testing_session_has_ended(client, db, seeded_user):
    db.add(DbTestingSession(
        status="ended", ended_with="kept", row_counts={}, audit_watermark=NOW,
        started_by=seeded_user.id))
    await db.commit()
    hdrs = await _developer(db, client, seeded_user)
    assert (await _vacuum(client, hdrs, "notes")).status_code == 200


# -- request transaction ---------------------------------------------------


async def test_vacuum_request_session_is_not_idle_in_transaction_during_the_vacuum(
        client, db, seeded_user, monkeypatch):
    from serversherpa.api.routes import health as routes
    from serversherpa.devtools import health
    from tests.test_db_health_api import _holder

    real_check = routes.testing_session_unfinished
    real_vacuum = health.vacuum_table
    seen: dict = {}

    async def check(session):
        seen["pid"] = await session.scalar(text("SELECT pg_backend_pid()"))
        return await real_check(session)

    async def vacuum(name):
        # the start of the VACUUM, seen from a separate connection
        probe = await _holder("test-vacuum-probe", in_transaction=False)
        try:
            seen["state"] = await probe.fetchval(
                "SELECT state FROM pg_stat_activity WHERE pid = $1", seen["pid"])
        finally:
            await probe.close()
        return await real_vacuum(name)

    monkeypatch.setattr(routes, "testing_session_unfinished", check)
    monkeypatch.setattr(health, "vacuum_table", vacuum)
    hdrs = await _developer(db, client, seeded_user)
    resp = await _vacuum(client, hdrs, "notes")
    assert resp.status_code == 200, resp.text
    assert seen["state"] == "idle"
    # the audit row still lands, after the vacuum
    db.expire_all()
    assert len((await db.scalars(select(AuditLog).where(AuditLog.action == "db.vacuum"))).all()) == 1


# -- lock timeout ----------------------------------------------------------


async def test_vacuum_gives_up_on_a_held_lock_with_409_table_busy(
        client, db, seeded_user, monkeypatch):
    from sqlalchemy import text as sql_text

    from serversherpa.db.engine import get_engine
    from serversherpa.devtools import health
    from tests.test_db_health_api import _holder

    monkeypatch.setattr(health, "VACUUM_LOCK_TIMEOUT", "200ms")
    hdrs = await _developer(db, client, seeded_user)
    holder = await _holder("test-lock-holder", in_transaction=True)
    try:
        await holder.execute("LOCK TABLE notes IN SHARE UPDATE EXCLUSIVE MODE")
        resp = await _vacuum(client, hdrs, "notes")
    finally:
        await holder.close()
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["code"] == "table_busy"
    db.expire_all()
    assert (await db.scalars(select(AuditLog).where(AuditLog.action == "db.vacuum"))).all() == []

    # no pooled connection keeps the timeout: check out every idle one at once
    # (plus one fresh), since a single checkout might not be the one VACUUM used
    await db.rollback()     # the test's own session may be holding the very connection VACUUM used
    engine = get_engine()
    async with AsyncExitStack() as stack:
        conns = [await stack.enter_async_context(engine.connect())
                 for _ in range(engine.pool.checkedin() + 1)]
        assert len(conns) >= 2
        for conn in conns:
            assert await conn.scalar(sql_text("SHOW lock_timeout")) == "0"
    # and once the lock is gone the same call works
    assert (await _vacuum(client, hdrs, "notes")).status_code == 200


# -- permissions -----------------------------------------------------------


async def test_view_only_developer_can_list_but_not_vacuum(client, db, seeded_user):
    await set_role(db, seeded_user.id, "developer")
    db.add(PermissionOverride(person_id=seeded_user.id, resource="devtools",
                              action="change", allow=False))
    await db.commit()
    hdrs = await devtools_login(client)
    assert (await client.get("/devtools/health/tables", headers=hdrs)).status_code == 200
    assert (await _vacuum(client, hdrs, "notes")).status_code == 403
    assert (await db.scalars(select(AuditLog).where(AuditLog.action == "db.vacuum"))).all() == []


async def test_non_developers_get_403_on_tables_and_vacuum(client, db, seeded_user):
    staff = Person(first_name="St", last_name="Aff")
    db.add(staff)
    await db.flush()
    db.add(PersonRole(person_id=staff.id, role="staff"))
    await db.commit()
    hdrs = await make_login(db, client, staff, "staff-tables@test.example.com")
    assert (await client.get("/devtools/health/tables", headers=hdrs)).status_code == 403
    assert (await _vacuum(client, hdrs, "notes")).status_code == 403


async def test_unauthenticated_is_401(client):
    assert (await client.get("/devtools/health/tables")).status_code == 401
    assert (await client.post("/devtools/health/tables/notes/vacuum")).status_code == 401
