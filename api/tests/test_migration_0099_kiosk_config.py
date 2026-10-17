"""Migration 0099: the per-kiosk config document on devices, and the
kiosk_sounds table. Also rolls 0099 back and forward again on a throwaway
database (`<SS_TEST_DB>_m0099`) so the shared test DB stays at head."""

import os
import subprocess
from pathlib import Path

import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from serversherpa.config import get_settings
from serversherpa.db.models import Device, KioskSound

API_DIR = Path(__file__).resolve().parents[1]
THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0099"

CONFIG_COLUMNS = {
    "config": ("jsonb", "YES", None),
    "config_version": ("integer", "NO", "0"),
    "config_changed_at": ("timestamp with time zone", "YES", None),
    "config_source": ("text", "YES", None),
    "config_changed_by": ("uuid", "YES", None),
    "config_reported_at": ("timestamp with time zone", "YES", None),
    "config_applied_version": ("integer", "YES", None),
}


async def test_device_config_columns(db):
    rows = (await db.execute(text(
        "SELECT column_name, data_type, is_nullable, column_default "
        "FROM information_schema.columns "
        "WHERE table_name='devices' AND column_name LIKE 'config%'"))).all()
    assert {r[0]: (r[1], r[2], r[3]) for r in rows} == CONFIG_COLUMNS


async def test_auth_sessions_kiosk_serial_column(db):
    row = (await db.execute(text(
        "SELECT data_type, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_name='auth_sessions' AND column_name='kiosk_serial'"))).one()
    assert tuple(row) == ("text", "YES", None)


async def test_device_config_defaults_and_source_check(db):
    d = Device(device_type="kiosk", name="K1", serial="k-0099-1", sub_type="web")
    db.add(d)
    await db.commit()
    await db.refresh(d)
    assert d.config is None
    assert d.config_version == 0
    assert d.config_source is None
    await db.execute(text("UPDATE devices SET config_source='kiosk' WHERE id=:i"), {"i": d.id})
    await db.commit()
    with pytest.raises(IntegrityError):
        await db.execute(text("UPDATE devices SET config_source='elsewhere' WHERE id=:i"),
                         {"i": d.id})
    await db.rollback()


async def test_kiosk_sounds_table(db):
    d = Device(device_type="kiosk", name="K2", serial="k-0099-2", sub_type="laptop")
    db.add(d)
    await db.flush()
    device_id = d.id
    s = KioskSound(name="ding.mp3", content_type="audio/mpeg", size=1234,
                   storage_key="kiosk-sounds/a.mp3", uploaded_from_device=device_id)
    db.add(s)
    await db.commit()
    await db.refresh(s)
    assert s.id is not None and s.created_at is not None
    db.add(KioskSound(name="dup.mp3", content_type="audio/mpeg", size=1,
                      storage_key="kiosk-sounds/a.mp3"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()
    # deleting the uploading kiosk keeps the sound, with the link cleared
    await db.execute(text("DELETE FROM devices WHERE id=:i"), {"i": device_id})
    await db.commit()
    assert (await db.scalar(text(
        "SELECT uploaded_from_device FROM kiosk_sounds WHERE name='ding.mp3'"))) is None


@pytest.fixture
def throwaway_url():
    assert THROWAWAY_DB.startswith("serversherpa_test")
    base = make_url(get_settings().database_url.get_secret_value())
    admin = base.set(drivername="postgresql", database="postgres").render_as_string(
        hide_password=False)
    with psycopg.connect(admin, autocommit=True) as conn:
        conn.execute(f'DROP DATABASE IF EXISTS "{THROWAWAY_DB}" WITH (FORCE)')
        conn.execute(f'CREATE DATABASE "{THROWAWAY_DB}"')
    try:
        yield base.set(database=THROWAWAY_DB)
    finally:
        with psycopg.connect(admin, autocommit=True) as conn:
            conn.execute(f'DROP DATABASE IF EXISTS "{THROWAWAY_DB}" WITH (FORCE)')


def _alembic(url, *args):
    env = {**os.environ, "SS_DATABASE_URL": url.render_as_string(hide_password=False)}
    result = subprocess.run([str(API_DIR / ".venv/bin/alembic"), *args], cwd=API_DIR,
                            env=env, capture_output=True, text=True, check=False)
    assert result.returncode == 0, result.stderr[-2000:]


def test_downgrade_and_upgrade_again(throwaway_url):
    _alembic(throwaway_url, "upgrade", "head")
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(sync, autocommit=True) as conn:
        conn.execute("INSERT INTO devices (device_type, name, config, config_version, "
                     "config_source) VALUES ('kiosk', 'K', '{\"schema\": 1}', 3, 'portal')")
        conn.execute("INSERT INTO kiosk_sounds (name, content_type, size, storage_key) "
                     "VALUES ('a', 'audio/wav', 1, 'k/a')")
    _alembic(throwaway_url, "downgrade", "0098")
    with psycopg.connect(sync, autocommit=True) as conn:
        cols = {r[0] for r in conn.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name='devices' AND column_name LIKE 'config%'")}
        table = conn.execute("SELECT to_regclass('kiosk_sounds')").fetchone()[0]
        kiosk_serial = conn.execute(
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name='auth_sessions' AND column_name='kiosk_serial'").fetchone()
    assert cols == set()
    assert kiosk_serial is None
    assert table is None
    _alembic(throwaway_url, "upgrade", "head")
