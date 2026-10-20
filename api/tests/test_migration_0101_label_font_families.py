"""Migration 0101: font families on the label font library. A TT0003M_.TTF
uploaded before it becomes the resident row; rolling back drops the
fileless resident row. Runs on a throwaway database
(`<SS_TEST_DB>_m0101`) so the shared test DB stays at head."""

import os

import psycopg
import pytest
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0101"


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


def _fonts(conn):
    return {(r[0], r[1]): r[2:] for r in conn.execute(
        "SELECT name::text, deleted_at IS NOT NULL, resident, family, weight "
        "FROM label_fonts")}


def test_upgrade_marks_an_uploaded_swiss_font_resident_and_rolls_back(throwaway_url):
    _alembic(throwaway_url, "upgrade", "0100")
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(sync, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO label_fonts (name, storage_key, size_bytes, deleted_at) VALUES "
            "('tt0003m_.ttf', 'label-fonts/a.ttf', 10, NULL), "
            "('TT0003M_.TTF', 'label-fonts/old.ttf', 9, now()), "
            "('85620388.TTF', 'label-fonts/b.ttf', 11, NULL)")

    _alembic(throwaway_url, "upgrade", "head")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _fonts(conn) == {
            ("tt0003m_.ttf", False): (True, "swiss721-cond-bold", "regular"),
            ("TT0003M_.TTF", True): (False, None, None),     # soft-deleted: untouched
            ("85620388.TTF", False): (False, None, None),
        }
        # a non-resident row still needs its file
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("INSERT INTO label_fonts (name, storage_key, size_bytes) "
                         "VALUES ('X.TTF', NULL, 0)")
        conn.execute("UPDATE label_fonts SET deleted_at = now() WHERE name = 'tt0003m_.ttf'")
        conn.execute("INSERT INTO label_fonts (name, storage_key, size_bytes, resident, family, "
                     "weight) VALUES ('TT0003M_.TTF', NULL, 0, true, 'swiss721-cond-bold', "
                     "'regular')")

    _alembic(throwaway_url, "downgrade", "0100")
    with psycopg.connect(sync, autocommit=True) as conn:
        names = sorted(r[0] for r in conn.execute("SELECT name::text FROM label_fonts"))
        assert names == ["85620388.TTF", "TT0003M_.TTF", "tt0003m_.ttf"]   # fileless row gone
    _alembic(throwaway_url, "upgrade", "head")
