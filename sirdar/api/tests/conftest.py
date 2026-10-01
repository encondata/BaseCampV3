"""Real Postgres for every test: sirdar_test (Sirdar's schema, migrated to
head) and sirdar_test_source (a minimal portal-shaped schema the import
reads). Both live in the dev sirdar-db container (127.0.0.1:5434).
Tables are truncated before each test; roles are restored to defaults."""

import os
import subprocess
from pathlib import Path

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
                 "auth_sessions, audit_log, import_runs")
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
        await restore_default_roles(session)
        await session.commit()
    with psycopg.connect(SOURCE_PSYCOPG_URL, autocommit=True) as conn:
        conn.execute(f"TRUNCATE {SOURCE_TABLES} CASCADE")
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
