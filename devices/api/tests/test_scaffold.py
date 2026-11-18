"""The service scaffold: health checks, the SPA fallback, and migration 0001."""

import uuid

import psycopg
import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from .conftest import TEST_DB, alembic, ensure_database, psycopg_url

TABLES = {"apple_settings", "apps", "app_versions", "ios_devices", "ios_profiles",
          "signed_builds", "enroll_tokens", "uploads", "jobs", "apple_device_counts"}


@pytest.fixture
def settings_env(monkeypatch):
    """Set DEVICES_* values for one test; the settings cache is cleared
    before and after, so the next test reads the conftest values again."""
    from serversherpa_devices.config import get_settings

    def apply(**values: str) -> None:
        for key, value in values.items():
            monkeypatch.setenv(f"DEVICES_{key.upper()}", value)
        get_settings.cache_clear()

    yield apply
    get_settings.cache_clear()


async def _client():
    from serversherpa_devices.api.app import create_app

    return AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://testserver")


async def test_healthz_ok(client):
    for path in ("/healthz", "/api/healthz"):
        r = await client.get(path)
        assert r.status_code == 200, path
        assert r.json() == {"status": "ok"}


async def test_healthz_503_when_db_down(settings_env):
    settings_env(database_url="postgresql+asyncpg://nobody:nothing@127.0.0.1:1/devices_test")
    async with await _client() as c:
        for path in ("/healthz", "/api/healthz"):
            r = await c.get(path)
            assert r.status_code == 503, path
            assert r.json() == {"status": "db_unreachable"}


async def test_unknown_api_path_404_not_spa(settings_env, tmp_path):
    (tmp_path / "index.html").write_text("<!doctype html><title>Devices</title>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "app.js").write_text("console.log('devices')")
    settings_env(static_dir=str(tmp_path))

    async with await _client() as c:
        for path in ("/api/nope", "/api", "/enroll/abc/missing", "/enroll",
                     "/ota/x/manifest.plist", "/dl/x.apk"):
            r = await c.get(path)
            assert r.status_code == 404, path
            assert "Devices" not in r.text, path
        for path in ("/", "/apps/123", "/devices"):
            r = await c.get(path)
            assert r.status_code == 200, path
            assert "<title>Devices</title>" in r.text, path
        r = await c.get("/assets/app.js")
        assert r.status_code == 200
        assert "console.log" in r.text
        assert (await c.get("/api/healthz")).status_code == 200


async def test_docs_off_in_production(settings_env):
    async with await _client() as c:
        assert (await c.get("/api/openapi.json")).status_code == 200
    settings_env(env="production")
    async with await _client() as c:
        assert (await c.get("/api/openapi.json")).status_code == 404
        assert (await c.get("/api/docs")).status_code == 404


def _tables(database: str) -> set[str]:
    with psycopg.connect(psycopg_url(database)) as conn:
        rows = conn.execute(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'").fetchall()
    return {r[0] for r in rows} - {"alembic_version"}


def test_alembic_round_trip():
    database = f"{TEST_DB}_m0001"
    ensure_database(database)
    alembic("upgrade", "head", database=database)
    assert _tables(database) == TABLES
    alembic("downgrade", "base", database=database)
    assert _tables(database) == set()
    alembic("upgrade", "head", database=database)
    assert _tables(database) == TABLES


async def test_schema_rules(db):
    from serversherpa_devices.db.models import App, AppVersion, Job

    app = App(platform="android", identifier="com.serversherpa.kiosk", name="Kiosk")
    db.add(app)
    await db.flush()
    app_id = app.id   # a rollback expires `app`; reading it later would need IO

    def version(build: str, current: bool) -> AppVersion:
        return AppVersion(app_id=app_id, version_name="0.1.0", build=build,
                          build_sort=int(build), file_key=f"apk/{build}.apk", size=1,
                          sha256="0" * 64, uploaded_by=uuid.uuid4(), uploaded_by_name="Test",
                          is_current=current)

    db.add(version("1", True))
    await db.commit()
    assert (await db.scalar(select(AppVersion.notes))) == ""

    # Only one current, non-deleted version per app.
    db.add(version("2", True))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    # The same version and build can't be stored twice.
    db.add(version("1", False))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    db.add(Job(kind="register_device", payload={}))
    await db.commit()
    assert (await db.scalar(select(Job.status))) == "queued"
    db.add(Job(kind="not_a_kind", payload={}))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    db.add(App(platform="windows", identifier="x", name="X"))
    with pytest.raises(IntegrityError):
        await db.commit()
