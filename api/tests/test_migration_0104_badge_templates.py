"""Migration 0104: the built-in ID Badge label type (`("type", "id_badge")`,
"ID Badge", after the five kiosk types) and the `label_images` table the
builder's static images live in (spec
docs/superpowers/specs/2026-10-20-badge-templates-design.md §4.1, §4.3). A
pending `id_badge` row a designer made through New template › Custom… is
taken over: activated, relabeled and re-sorted. Rolling back drops the
table and the row. Runs on a throwaway database (`<SS_TEST_DB>_m0104`) so
the shared test DB stays at head."""

import os

import psycopg
import pytest
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0104"


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


def _badge_row(conn):
    return conn.execute(
        "SELECT label, is_active, sort_order FROM label_vocab "
        "WHERE kind = 'type' AND key = 'id_badge'").fetchone()


def _table(conn):
    return conn.execute("SELECT to_regclass('label_images')").fetchone()[0]


def test_seeds_the_type_and_the_image_table_and_rolls_back(throwaway_url):
    _alembic(throwaway_url, "upgrade", "0103")
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _badge_row(conn) is None
        assert _table(conn) is None

    _alembic(throwaway_url, "upgrade", "head")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _badge_row(conn) == ("ID Badge", True, 6)
        # after the five kiosk types
        assert conn.execute(
            "SELECT max(sort_order) FROM label_vocab WHERE kind = 'type' AND key <> 'id_badge'"
        ).fetchone()[0] < 6
        assert _table(conn) == "label_images"
        cols = {name: (dtype, nullable) for name, dtype, nullable in conn.execute(
            "SELECT column_name, data_type, is_nullable FROM information_schema.columns "
            "WHERE table_name = 'label_images'")}
        assert cols == {
            "id": ("uuid", "NO"), "name": ("text", "NO"), "storage_key": ("text", "NO"),
            "width": ("integer", "NO"), "height": ("integer", "NO"), "mime": ("text", "NO"),
            "size_bytes": ("integer", "NO"), "created_by": ("uuid", "YES"),
            "created_at": ("timestamp with time zone", "NO"),
            "deleted_at": ("timestamp with time zone", "YES"),
        }
        assert conn.execute(
            "SELECT indexdef FROM pg_indexes WHERE tablename = 'label_images' "
            "AND indexname = 'label_images_deleted_at_idx'").fetchone() is not None
        image = conn.execute(
            "INSERT INTO label_images (name, storage_key, width, height, mime, size_bytes) "
            "VALUES ('Logo', 'label-images/x.png', 640, 200, 'image/png', 1234) "
            "RETURNING id, created_at IS NOT NULL").fetchone()
        assert image[0] is not None and image[1] is True

    _alembic(throwaway_url, "downgrade", "0103")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _table(conn) is None
        assert _badge_row(conn) is None
    _alembic(throwaway_url, "upgrade", "head")


def test_takes_over_a_pending_custom_id_badge_type(throwaway_url):
    """A designer's Custom… "ID badge" row (off the list, sorted 0) becomes
    the built-in one."""
    _alembic(throwaway_url, "upgrade", "0103")
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(sync, autocommit=True) as conn:
        conn.execute(
            "INSERT INTO label_vocab (kind, key, label, is_active, sort_order) "
            "VALUES ('type', 'id_badge', 'ID badge', false, 0)")
    _alembic(throwaway_url, "upgrade", "head")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _badge_row(conn) == ("ID Badge", True, 6)
        assert conn.execute(
            "SELECT count(*) FROM label_vocab WHERE kind = 'type' AND key = 'id_badge'"
        ).fetchone()[0] == 1
