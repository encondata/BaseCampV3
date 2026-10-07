"""Real Postgres for every test: sirdar_test (Sirdar's schema, migrated to
head) and sirdar_test_source (a minimal portal-shaped schema the import
reads). Both live in the dev sirdar-db container (127.0.0.1:5434).
Tables are truncated before each test; roles are restored to defaults."""

import os
import subprocess
from pathlib import Path

import httpx
import psycopg
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import text
from sqlalchemy.engine import make_url

API_DIR = Path(__file__).resolve().parents[1]
TEST_DB = os.environ.get("SIRDAR_TEST_DB", "sirdar_test")
if not TEST_DB.startswith("sirdar_test"):
    raise RuntimeError("SIRDAR_TEST_DB must start with 'sirdar_test'")
SOURCE_DB = f"{TEST_DB}_source"
BASE_URL = make_url(os.environ.get(
    "SIRDAR_TEST_DATABASE_URL", "postgresql+asyncpg://sirdar:sirdar@127.0.0.1:5434/sirdar"))


def _psycopg_url(database: str) -> str:
    return BASE_URL.set(drivername="postgresql", database=database).render_as_string(
        hide_password=False)


def _asyncpg_url(database: str) -> str:
    return BASE_URL.set(database=database).render_as_string(hide_password=False)


SOURCE_URL = _asyncpg_url(SOURCE_DB)
SOURCE_PSYCOPG_URL = _psycopg_url(SOURCE_DB)

SIRDAR_TABLES = ("users, user_roles, permission_overrides, totp_backup_codes, "
                 "auth_sessions, audit_log, import_runs, ssh_known_hosts, "
                 "environments, environment_services, environment_secrets, deployments, "
                 "deployment_steps, snapshots, integrations, managed_records, proxmox_vms, "
                 "esxi_vms, do_environments, do_slots, do_resources, acme_accounts, "
                 "environment_first_admins, vm_slots")
SOURCE_TABLES = ("people, user_accounts, roles, person_roles, access_groups, "
                 "access_group_members, totp_backup_codes, system_config")


def _prepare_environment() -> None:
    with psycopg.connect(_psycopg_url("postgres"), autocommit=True) as conn:
        for name in (TEST_DB, SOURCE_DB):
            exists = conn.execute(
                "SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone()
            if exists is None:
                conn.execute(f'CREATE DATABASE "{name}"')

    os.environ["SIRDAR_ENV"] = "development"
    os.environ["SIRDAR_DATABASE_URL"] = _asyncpg_url(TEST_DB)
    os.environ["SIRDAR_SOURCE_DATABASE_URL"] = SOURCE_URL
    os.environ["SIRDAR_JWT_SECRET"] = "test-jwt-secret-" + "x" * 32
    os.environ["SS_PASSWORD_PEPPER"] = "test-pepper"
    os.environ["SS_TOTP_ENCRYPTION_KEY"] = Fernet.generate_key().decode()

    from sirdar_api.config import get_settings
    get_settings.cache_clear()

    subprocess.run([str(API_DIR / ".venv/bin/alembic"), "upgrade", "head"],
                   cwd=API_DIR, env={**os.environ}, check=True, capture_output=True)
    with psycopg.connect(SOURCE_PSYCOPG_URL, autocommit=True) as conn:
        conn.execute((Path(__file__).parent / "source_schema.sql").read_text())


_prepare_environment()


@pytest.fixture(autouse=True)
async def clean_db():
    from sirdar_api.access.defaults import restore_default_roles
    from sirdar_api.db.engine import dispose_engine, get_sessionmaker

    async with get_sessionmaker()() as session:
        connected = await session.scalar(text("SELECT current_database()"))
        if not str(connected).startswith("sirdar_test"):
            raise RuntimeError(f"refusing to TRUNCATE: connected to {connected!r}")
        await session.execute(text(f"TRUNCATE {SIRDAR_TABLES} CASCADE"))
        # The two DigitalOcean accounts are fixed rows: reset them, never drop them.
        await session.execute(text(
            "UPDATE do_accounts SET label = CASE key WHEN 'production' THEN 'Production' "
            "ELSE 'Development' END, region = NULL, token_enc = NULL, "
            "renewal_token_enc = NULL, team_uuid = NULL, team_name = NULL, updated_by = NULL"))
        await restore_default_roles(session)
        await session.commit()
    with psycopg.connect(SOURCE_PSYCOPG_URL, autocommit=True) as conn:
        conn.execute(f"TRUNCATE {SOURCE_TABLES} CASCADE")
    # Drop the setup engine so a sync test (the CLI, which runs its own event
    # loop) never inherits a pool bound to this fixture's loop.
    await dispose_engine()
    yield
    await dispose_engine()


@pytest.fixture
async def client():
    from httpx import ASGITransport, AsyncClient

    from sirdar_api.api.app import create_app

    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


@pytest.fixture
async def db():
    from sirdar_api.db.engine import get_sessionmaker

    async with get_sessionmaker()() as session:
        yield session


@pytest.fixture
def source():
    with psycopg.connect(SOURCE_PSYCOPG_URL, autocommit=True) as conn:
        yield conn


@pytest.fixture(autouse=True)
def no_real_http():
    """No test reaches a real server (Cloudflare, Nginx Proxy Manager, a
    public URL): every outbound client takes a transport, and the real ones
    (async and sync) fail the request here. Each blocked host is also
    recorded, and the test fails at teardown if any was: a catch-all such as
    the pipeline's `except Exception` can swallow the AssertionError. Yields
    that list (a test that blocks on purpose clears it).

    Its own MonkeyPatch, not the shared `monkeypatch` fixture: requesting
    that from an autouse fixture would set it up first and so undo a test's
    patches only after every other teardown ran (e.g. stop_pipeline would
    see a test's fake pipeline._tasks)."""
    hits: list[str] = []

    def blocked(request):
        hits.append(request.url.host)
        return AssertionError(f"a test made a real HTTP request to {request.url.host}")

    async def refuse_async(self, request):
        raise blocked(request)

    def refuse_sync(self, request):
        raise blocked(request)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(httpx.AsyncHTTPTransport, "handle_async_request", refuse_async)
        mp.setattr(httpx.HTTPTransport, "handle_request", refuse_sync)
        yield hits
    assert not hits, f"a test made real HTTP requests to {', '.join(hits)}"


@pytest.fixture(autouse=True)
def fake_certs():
    """The dashboard's live certificate check never dials out: every test
    gets a fresh checker around a FakeCerts (set `fake_certs.dates[host]`).
    Its own MonkeyPatch, like no_real_http."""
    from sirdar_api.dashboard import certcheck, service

    from .fake_certs import FakeCerts

    fake = FakeCerts()
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(service, "cert_checker", certcheck.Checker(check=fake))
        yield fake


@pytest.fixture(autouse=True)
def no_real_hosts():
    """No test reaches a real Proxmox host outside httpx: the raw TLS
    certificate fetch and the dashboard's certificate check may only dial
    127.0.0.1 (the tests' own TLS server),
    Terraform only runs fake-* scripts, never opens a real ESXi session
    (esxi._smart_connect), and the provisioners' port probe (vmcommon.tcp_open)
    never dials out. Yields the list of blocked attempts (a test that
    blocks on purpose clears it); the test fails at teardown if any is
    left. Its own MonkeyPatch, like no_real_http."""
    from sirdar_api.dashboard import certcheck
    from sirdar_api.deploy import esxi, terraform, tls_pin, vmcommon

    hits: list[str] = []
    real_read = tls_pin._read_certificate
    real_open = certcheck._open

    async def cert_open(host, port):
        if host != "127.0.0.1":
            hits.append(f"certcheck:{host}")
            raise AssertionError(f"a test checked a real host's certificate ({host})")
        return await real_open(host, port)
    real_spawn = terraform._spawn

    def read(host, port):
        if host != "127.0.0.1":
            hits.append(f"tls:{host}")
            raise AssertionError(f"a test fetched a real TLS certificate from {host}")
        return real_read(host, port)

    async def spawn(argv, **kw):
        if not Path(argv[0]).name.startswith("fake-"):
            hits.append(f"terraform:{argv[0]}")
            raise AssertionError(f"a test started a real Terraform ({argv[0]})")
        return await real_spawn(argv, **kw)

    async def probe(host, port, timeout=3.0):
        hits.append(f"probe:{host}")
        raise AssertionError(f"a test probed a real port ({host}:{port})")

    def esxi_session(cfg):
        host = esxi.split_url(cfg.url)[0]
        hits.append(f"esxi:{host}")
        raise AssertionError(f"a test opened a real ESXi session ({host})")

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(tls_pin, "_read_certificate", read)
        mp.setattr(certcheck, "_open", cert_open)
        mp.setattr(terraform, "_spawn", spawn)
        mp.setattr(vmcommon, "tcp_open", probe)
        mp.setattr(esxi, "_smart_connect", esxi_session)
        yield hits
    assert not hits, f"a test reached real hosts: {', '.join(hits)}"
