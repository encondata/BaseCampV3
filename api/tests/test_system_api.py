"""System routes: registry gating, logs paging/filter/search, WS
stream, audited clear."""

import asyncio
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select
from starlette.testclient import TestClient

from serversherpa.api.app import create_app
from serversherpa.db.models import (
    AuditLog, LogEntry, Person, PersonRole, SystemProcess,
)

from .test_assets_api import login, make_login


async def _super_admin_headers(db, client):
    person = Person(first_name="Sue", last_name="Prime")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="super_admin"))
    await db.commit()
    return await make_login(db, client, person, "sue@test.example.com")


async def _developer_headers(db, client):
    person = Person(first_name="Dev", last_name="Eloper")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="developer"))
    await db.commit()
    return await make_login(db, client, person, "dev@test.example.com")


def _proc(name="api", kind="service", beat_age=2, stopped=False):
    now = datetime.now(UTC)
    return SystemProcess(
        name=name, kind=kind, pid=123, hostname="devbox",
        started_at=now - timedelta(minutes=5),
        heartbeat_at=now - timedelta(seconds=beat_age),
        stopped_at=now if stopped else None)


async def test_processes_requires_rank_80(client, db, seeded_user):
    staff = await login(client)          # staff: rank < 80
    resp = await client.get("/system/processes", headers=staff)
    assert resp.status_code == 403

    sa = await _super_admin_headers(db, client)
    db.add_all([_proc(), _proc(name="import-worker", kind="worker",
                              beat_age=60)])
    await db.commit()
    resp = await client.get("/system/processes", headers=sa)
    assert resp.status_code == 200
    rows = {r["name"]: r for r in resp.json()}
    assert rows["api"]["status"] == "running"
    assert rows["api"]["uptime_seconds"] > 0
    assert rows["import-worker"]["status"] == "failed"


async def test_logs_require_devtools(client, db, seeded_user):
    sa = await _super_admin_headers(db, client)     # rank 80, no devtools
    resp = await client.get("/system/processes/api/logs", headers=sa)
    assert resp.status_code == 403


async def test_logs_page_filter_search(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    db.add_all([
        LogEntry(process="api", level="DEBUG", levelno=10, message="noise"),
        LogEntry(process="api", level="INFO", levelno=20,
                 message="import started"),
        LogEntry(process="api", level="ERROR", levelno=40,
                 message="import failed hard"),
        LogEntry(process="other", level="ERROR", levelno=40, message="x"),
    ])
    await db.commit()

    resp = await client.get("/system/processes/api/logs", headers=dev)
    assert resp.status_code == 200
    body = resp.json()
    assert [e["message"] for e in body["entries"]] == [
        "import failed hard", "import started", "noise"]   # newest first
    assert body["has_more"] is False

    resp = await client.get(
        "/system/processes/api/logs?min_level=ERROR", headers=dev)
    assert [e["message"] for e in resp.json()["entries"]] == [
        "import failed hard"]

    resp = await client.get(
        "/system/processes/api/logs?q=import", headers=dev)
    assert len(resp.json()["entries"]) == 2

    first_page = await client.get(
        "/system/processes/api/logs?limit=2", headers=dev)
    assert first_page.json()["has_more"] is True
    before = first_page.json()["entries"][-1]["id"]
    second = await client.get(
        f"/system/processes/api/logs?limit=2&before_id={before}",
        headers=dev)
    assert [e["message"] for e in second.json()["entries"]] == ["noise"]


async def test_probe_process_has_no_logs(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    db.add(_proc(name="web", kind="probe"))
    await db.commit()
    resp = await client.get("/system/processes/web/logs", headers=dev)
    assert resp.status_code == 404
    assert resp.json()["detail"]["code"] == "process_has_no_logs"


async def test_clear_logs_audited(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    db.add_all([LogEntry(process="api", level="INFO", levelno=20,
                         message=f"m{i}") for i in range(3)])
    await db.commit()
    resp = await client.delete("/system/processes/api/logs", headers=dev)
    assert resp.status_code == 200
    assert resp.json() == {"deleted": 3}
    assert await db.scalar(select(func.count()).select_from(LogEntry)
                           .where(LogEntry.process == "api")) == 0
    entry = await db.scalar(select(AuditLog).where(
        AuditLog.entity_type == "system",
        AuditLog.action == "logs_clear"))
    assert entry is not None
    assert entry.changes["process"] == "api"
    assert entry.changes["deleted"] == 3


async def test_ws_stream_and_auth(client, db, seeded_user):
    dev = await _developer_headers(db, client)
    token = dev["Authorization"].removeprefix("Bearer ")

    # TestClient runs the app in its own thread + event loop. asyncpg
    # connections are loop-bound, so the async engine pooled in pytest's
    # loop must be dropped first — the app's loop then builds its own
    # fresh pool, and pytest's side lazily recreates one afterwards.
    from serversherpa.db.engine import dispose_engine
    await db.close()
    await dispose_engine()

    from sqlalchemy import create_engine, text as sql_text

    from serversherpa.config import get_settings
    sync = create_engine(get_settings().sync_database_url)

    def insert_row(message):
        with sync.begin() as conn:
            conn.execute(sql_text(
                "INSERT INTO log_entries (process, level, levelno, "
                "logger, message) VALUES ('api', 'INFO', 20, 't', :m)"),
                {"m": message})

    with TestClient(create_app()) as tc:
        with tc.websocket_connect(
                f"/system/processes/api/logs/stream?token={token}") as ws:
            insert_row("streamed hello")
            msg = ws.receive_json()          # tail poll is 1 s
            assert msg["entries"][0]["message"] == "streamed hello"

        # bad token → closed with 4401 before any data
        import pytest
        from starlette.websockets import WebSocketDisconnect
        with pytest.raises(WebSocketDisconnect) as exc:
            with tc.websocket_connect(
                    "/system/processes/api/logs/stream?token=junk") as ws:
                ws.receive_json()
        assert exc.value.code == 4401
    sync.dispose()


async def test_ws_stream_survives_bursts_beyond_batch_cap(
        client, db, seeded_user, monkeypatch):
    from serversherpa.api.routes import system as system_routes
    monkeypatch.setattr(system_routes, "STREAM_BATCH_CAP", 2)

    dev = await _developer_headers(db, client)
    token = dev["Authorization"].removeprefix("Bearer ")

    from serversherpa.db.engine import dispose_engine
    await db.close()
    await dispose_engine()

    from sqlalchemy import create_engine, text as sql_text

    from serversherpa.config import get_settings
    sync = create_engine(get_settings().sync_database_url)

    with TestClient(create_app()) as tc:
        with tc.websocket_connect(
                f"/system/processes/api/logs/stream?token={token}") as ws:
            with sync.begin() as conn:
                for i in range(5):
                    conn.execute(sql_text(
                        "INSERT INTO log_entries (process, level, levelno, "
                        "logger, message) VALUES ('api', 'INFO', 20, 't', "
                        ":m)"), {"m": f"burst {i}"})
            got: list[str] = []
            while len(got) < 5:
                msg = ws.receive_json()
                got += [e["message"] for e in msg.get("entries", [])]
            assert got == [f"burst {i}" for i in range(5)]   # nothing skipped
    sync.dispose()
