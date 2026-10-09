"""Database health (Dev -> Database -> Health): process connection names,
the summary and the who's-connected view."""

import asyncio
from types import SimpleNamespace

import asyncpg
import pytest
from sqlalchemy.engine import make_url
from typer.testing import CliRunner

from serversherpa import cli
from serversherpa.config import get_settings
from serversherpa.db import engine
from serversherpa.db.models import Person, PersonRole
from tests.test_assets_api import make_login
from tests.test_devtools import login as devtools_login
from tests.test_devtools import set_role

runner = CliRunner()


# -- connection names ---------------------------------------------------


@pytest.fixture
def app_name():
    """Leave the process-wide connection name as the test found it."""
    before = engine._application_name
    yield
    engine._application_name = before


def _args():
    return engine.connect_args(SimpleNamespace(database_ssl="disable", database_ca_b64=None))


def test_connect_args_default_name(app_name):
    engine._application_name = engine.DEFAULT_APPLICATION_NAME
    assert _args()["server_settings"] == {"application_name": "serversherpa"}


def test_set_application_name_flows_into_connect_args(app_name):
    engine.set_application_name("serversherpa-report-worker")
    assert _args()["server_settings"] == {"application_name": "serversherpa-report-worker"}
    engine.set_application_name("")     # an empty name resets to the default
    assert _args()["server_settings"] == {"application_name": "serversherpa"}


def test_set_application_name_caps_at_postgres_limit(app_name):
    engine.set_application_name("x" * 100)
    assert len(_args()["server_settings"]["application_name"]) == 63


async def test_engine_connections_carry_the_name(app_name):
    from sqlalchemy import text

    await engine.dispose_engine()
    engine.set_application_name("serversherpa-test-engine")
    try:
        async with engine.get_sessionmaker()() as s:
            got = await s.scalar(text("SHOW application_name"))
    finally:
        await engine.dispose_engine()   # the next test builds a default-named one
    assert got == "serversherpa-test-engine"


# (reload-mode child entry point, CLI command name)
PROCESS_ENTRY_POINTS = [
    ("_run_worker_process", "import-worker"),
    ("_run_report_worker_process", "report-worker"),
    ("_run_label_worker_process", "label-worker"),
    ("_run_wiki_worker_process", "wiki-worker"),
    ("_run_spec_lookup_worker_process", "spec-lookup-worker"),
    ("_run_db_testing_worker_process", "db-testing-worker"),
    ("_run_log_service_process", "log-service"),
    ("_run_notification_worker_process", "notification-worker"),
    ("_run_scan_matching_worker_process", "scan-matching-worker"),
]
WORKER_COMMANDS = [cmd for _, cmd in PROCESS_ENTRY_POINTS] + ["cert-worker"]


@pytest.fixture
def named(monkeypatch):
    """Record every name a CLI entry point sets, and never run a worker."""
    names: list[str] = []
    monkeypatch.setattr(cli, "set_application_name", names.append)
    monkeypatch.setattr(cli, "_ensure_pango_on_macos", lambda **_: None)

    def fake_run(coro):
        coro.close()

    monkeypatch.setattr(cli.asyncio, "run", fake_run)
    return names


def test_every_reload_entry_point_is_covered():
    found = {n for n in dir(cli) if n.startswith("_run_") and n.endswith("_process")}
    assert found == {fn for fn, _ in PROCESS_ENTRY_POINTS}


def test_every_worker_command_is_covered():
    commands = {c.name or c.callback.__name__.replace("_", "-")
                for c in cli.app.registered_commands}
    workers = {c for c in commands if c.endswith("-worker") or c == "log-service"}
    assert workers == set(WORKER_COMMANDS)


@pytest.mark.parametrize(("fn", "command"), PROCESS_ENTRY_POINTS)
def test_reload_entry_point_names_its_connections(named, fn, command):
    getattr(cli, fn)(2.0)
    assert named == [f"serversherpa-{command}"]


@pytest.mark.parametrize("command", WORKER_COMMANDS)
def test_command_names_its_connections(named, command):
    result = runner.invoke(cli.app, [command])
    assert result.exit_code == 0, result.output
    assert named == [f"serversherpa-{command}"]


async def test_api_startup_names_its_connections(monkeypatch):
    from serversherpa.api import app as app_module

    names: list[str] = []
    monkeypatch.setattr(app_module, "set_application_name", names.append)
    app = app_module.create_app()
    async with app.router.lifespan_context(app):
        pass
    assert names == ["serversherpa-api"]


# -- routes --------------------------------------------------------------


async def _developer(db, client, seeded_user):
    await set_role(db, seeded_user.id, "developer")
    return await devtools_login(client)


async def test_summary_fields_and_types(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get("/devtools/health/summary", headers=hdrs)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"database_size_bytes", "version", "started_at", "latency_ms",
                         "connections", "max_connections", "cache_hit_ratio"}
    assert body["database_size_bytes"] > 0
    assert body["version"][0].isdigit() and " " not in body["version"]
    assert body["started_at"]
    assert body["latency_ms"] >= 0
    assert 1 <= body["connections"] <= body["max_connections"]
    ratio = body["cache_hit_ratio"]
    assert ratio is None or 0 <= ratio <= 1


async def test_summary_leaks_no_host_or_user(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    text = (await client.get("/devtools/health/summary", headers=hdrs)).text
    url = make_url(get_settings().database_url.get_secret_value())
    assert url.username not in text
    assert url.host not in text
    assert str(url.password) not in text


async def _holder(application_name, *, in_transaction):
    url = make_url(get_settings().database_url.get_secret_value())
    conn = await asyncpg.connect(
        host=url.host, port=url.port, user=url.username, password=url.password,
        database=url.database,
        server_settings={"application_name": application_name} if application_name else None)
    if in_transaction:
        await conn.execute("BEGIN")
        await conn.fetchval("SELECT 1")
    return conn


def _group(groups, app, state):
    return next((g for g in groups if g["application_name"] == app and g["state"] == state), None)


async def test_connections_group_a_connection_idle_in_transaction(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    holder = await _holder("test-holder", in_transaction=True)
    try:
        await asyncio.sleep(1.2)
        resp = await client.get("/devtools/health/connections", headers=hdrs)
    finally:
        await holder.close()
    assert resp.status_code == 200, resp.text
    group = _group(resp.json()["groups"], "test-holder", "idle in transaction")
    assert group is not None
    assert group["count"] == 1
    assert group["oldest_transaction_seconds"] >= 1
    assert group["oldest_query_seconds"] is None        # only active queries have one
    assert group["waiting_on_lock"] == 0


async def test_connections_name_unnamed_ones_other(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    holder = await _holder(None, in_transaction=False)
    try:
        resp = await client.get("/devtools/health/connections", headers=hdrs)
    finally:
        await holder.close()
    group = _group(resp.json()["groups"], "Other", "idle")
    assert group is not None and group["count"] >= 1
    assert group["oldest_transaction_seconds"] is None


async def test_connections_exclude_the_requesting_backend(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    resp = await client.get("/devtools/health/connections", headers=hdrs)
    groups = resp.json()["groups"]
    # the only active backend is the one running this very query
    assert [g for g in groups if g["state"] == "active"] == []


async def test_connections_sorted_and_free_of_sensitive_keys(client, db, seeded_user):
    hdrs = await _developer(db, client, seeded_user)
    a = await _holder("test-b", in_transaction=True)
    b = await _holder("test-a", in_transaction=False)
    try:
        resp = await client.get("/devtools/health/connections", headers=hdrs)
    finally:
        await a.close()
        await b.close()
    groups = resp.json()["groups"]
    names = [g["application_name"] for g in groups]
    assert names.index("test-a") < names.index("test-b")
    for g in groups:
        assert set(g) == {"application_name", "state", "count", "oldest_query_seconds",
                          "oldest_transaction_seconds", "waiting_on_lock"}


# -- permissions -----------------------------------------------------------


@pytest.mark.parametrize("path", ["summary", "connections"])
async def test_non_developers_get_403(client, db, seeded_user, path):
    staff = Person(first_name="St", last_name="Aff")
    db.add(staff)
    await db.flush()
    db.add(PersonRole(person_id=staff.id, role="staff"))
    await db.commit()
    hdrs = await make_login(db, client, staff, "staff-health@test.example.com")
    assert (await client.get(f"/devtools/health/{path}", headers=hdrs)).status_code == 403


@pytest.mark.parametrize("path", ["summary", "connections"])
async def test_unauthenticated_is_401(client, path):
    assert (await client.get(f"/devtools/health/{path}")).status_code == 401
