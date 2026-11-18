"""Real Postgres for every test: devices_test (the devices schema, migrated
to head) on the dev Postgres container (127.0.0.1:5433). Only databases
whose names start with devices_test are ever created or written. Tables are
truncated before each test."""

import os
import subprocess
from pathlib import Path

import httpx
import psycopg
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import text
from sqlalchemy.engine import URL, make_url

API_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = API_DIR.parents[1]
TEST_DB = os.environ.get("DEVICES_TEST_DB", "devices_test")
if not TEST_DB.startswith("devices_test"):
    raise RuntimeError("DEVICES_TEST_DB must start with 'devices_test'")


def _dev_postgres_url() -> URL:
    """postgresql+asyncpg:// on 127.0.0.1:5433 with the dev .env's
    POSTGRES_USER / POSTGRES_PASSWORD (only those two values are read)."""
    values: dict[str, str] = {}
    env_file = REPO_ROOT / ".env"
    if env_file.is_file():
        for line in env_file.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep and key.strip() in ("POSTGRES_USER", "POSTGRES_PASSWORD"):
                values[key.strip()] = value.strip().strip("'\"")
    return URL.create("postgresql+asyncpg", username=values.get("POSTGRES_USER"),
                      password=values.get("POSTGRES_PASSWORD"), host="127.0.0.1",
                      port=5433, database="postgres")


_override = os.environ.get("DEVICES_TEST_DATABASE_URL")
BASE_URL = make_url(_override) if _override else _dev_postgres_url()


def psycopg_url(database: str) -> str:
    return BASE_URL.set(drivername="postgresql", database=database).render_as_string(
        hide_password=False)


def asyncpg_url(database: str) -> str:
    return BASE_URL.set(drivername="postgresql+asyncpg", database=database).render_as_string(
        hide_password=False)


def ensure_database(name: str) -> None:
    if not name.startswith("devices_test"):
        raise RuntimeError(f"refusing to create {name!r}: not a devices_test database")
    with psycopg.connect(psycopg_url("postgres"), autocommit=True) as conn:
        exists = conn.execute(
            "SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone()
        if exists is None:
            conn.execute(f'CREATE DATABASE "{name}"')


def alembic(*args: str, database: str) -> subprocess.CompletedProcess:
    if not database.startswith("devices_test"):
        raise RuntimeError(f"refusing to migrate {database!r}: not a devices_test database")
    return subprocess.run(
        [str(API_DIR / ".venv/bin/alembic"), *args], cwd=API_DIR,
        env={**os.environ, "DEVICES_DATABASE_URL": asyncpg_url(database)},
        check=True, capture_output=True, text=True)


DEVICES_TABLES = ("apple_settings, apps, app_versions, ios_devices, ios_profiles, "
                  "signed_builds, enroll_tokens, uploads, jobs, apple_device_counts")


def _prepare_environment() -> None:
    ensure_database(TEST_DB)

    # Every setting is set here, so a developer's devices/.env never leaks in.
    os.environ["DEVICES_ENV"] = "development"
    os.environ["DEVICES_DATABASE_URL"] = asyncpg_url(TEST_DB)
    os.environ["DEVICES_DATABASE_SSL"] = "disable"
    os.environ["DEVICES_MAIN_API_URL"] = "http://main-api.test"
    os.environ["DEVICES_SERVICE_TOKEN"] = "test-service-token"
    os.environ["DEVICES_SECRET_KEY"] = Fernet.generate_key().decode()
    os.environ["DEVICES_PUBLIC_URL"] = "https://devices.test"
    os.environ["DEVICES_IOS_OWNER_URL"] = ""
    os.environ["DEVICES_SPACES_ENDPOINT"] = "http://spaces.test"
    os.environ["DEVICES_SPACES_REGION"] = "us-east-1"
    os.environ["DEVICES_SPACES_BUCKET"] = "devices-test"
    os.environ["DEVICES_SPACES_ACCESS_KEY"] = "test-access-key"
    os.environ["DEVICES_SPACES_SECRET_KEY"] = "test-secret-key"
    os.environ["DEVICES_SPACES_USE_PATH_STYLE"] = "true"
    os.environ["DEVICES_STATIC_DIR"] = ""
    os.environ["DEVICES_RCODESIGN_PATH"] = "rcodesign"
    os.environ["DEVICES_AUTHORIZE_CACHE_SECONDS"] = "60"

    from serversherpa_devices.config import get_settings
    get_settings.cache_clear()

    alembic("upgrade", "head", database=TEST_DB)


_prepare_environment()


@pytest.fixture(autouse=True)
async def clean_db():
    from serversherpa_devices.db.engine import dispose_engine, get_sessionmaker

    async with get_sessionmaker()() as session:
        connected = await session.scalar(text("SELECT current_database()"))
        if not str(connected).startswith("devices_test"):
            raise RuntimeError(f"refusing to TRUNCATE: connected to {connected!r}")
        await session.execute(text(f"TRUNCATE {DEVICES_TABLES} CASCADE"))
        await session.commit()
    # Drop the setup engine so a sync test (the CLI, which runs its own event
    # loop) never inherits a pool bound to this fixture's loop.
    await dispose_engine()
    yield
    await dispose_engine()


@pytest.fixture
async def client():
    from httpx import ASGITransport, AsyncClient

    from serversherpa_devices.api.app import create_app

    transport = ASGITransport(app=create_app())
    async with AsyncClient(transport=transport, base_url="http://testserver") as c:
        yield c


@pytest.fixture
async def db():
    from serversherpa_devices.db.engine import get_sessionmaker

    async with get_sessionmaker()() as session:
        yield session


@pytest.fixture(autouse=True)
def no_real_http():
    """No test reaches a real server (the main API, Apple, a bucket): every
    outbound client takes a transport, and the real ones (async and sync)
    fail the request here. Each blocked host is also recorded, and the test
    fails at teardown if any was, since a catch-all `except Exception` can
    swallow the AssertionError. Yields that list (a test that blocks on
    purpose clears it). Its own MonkeyPatch, so a test's own `monkeypatch`
    undoes in the usual order."""
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


@pytest.fixture
def bucket(tmp_path, monkeypatch):
    """Storage in a temp directory (see fake_storage.py)."""
    from .fake_storage import FakeStorage

    return FakeStorage(tmp_path / "bucket").install(monkeypatch)


@pytest.fixture
def main_fake():
    """The fake main API, answering as an admin until told otherwise."""
    from .fake_main_api import FakeMainApi

    fake = FakeMainApi()
    fake.as_admin()
    return fake


@pytest.fixture
async def api(main_fake):
    """The app with the main API swapped for `main_fake`. Authorize answers
    aren't cached, so a test can change roles between calls."""
    from httpx import ASGITransport, AsyncClient

    from serversherpa_devices.api.app import create_app
    from serversherpa_devices.auth.main_api import MainApiClient, get_main_api
    from serversherpa_devices.config import get_settings

    settings = get_settings()
    main_api = MainApiClient(base_url=settings.main_api_url,
                             service_token=settings.service_token.get_secret_value(),
                             cache_seconds=0, transport=main_fake.transport())
    app = create_app()
    app.dependency_overrides[get_main_api] = lambda: main_api
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://testserver",
                           headers={"Authorization": "Bearer tok-test"}) as c:
        yield c
    await main_api.aclose()
