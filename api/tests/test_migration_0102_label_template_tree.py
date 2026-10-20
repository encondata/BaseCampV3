"""Migration 0102: the label template tree. Existing templates keep working
as single schema 1 rows and get their current state as their first
version; a 600 DPI vocabulary row joins 203 and 300; one current child
per parent and DPI. Rolling back drops the builder's rows. Runs on a
throwaway database (`<SS_TEST_DB>_m0102`) so the shared test DB stays at
head."""

import os

import psycopg
import pytest
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0102"


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


def _insert(conn, name, **cols):
    base = {"label_type": "top", "size_key": "4x2", "dpi_key": "203", "language_key": "zpl",
            "kind": "code", "code": "^XA^XZ", "design": None}
    base.update(cols)
    keys = ["name", *base]
    return conn.execute(
        f"INSERT INTO label_templates ({', '.join(keys)}) "
        f"VALUES ({', '.join(['%s'] * len(keys))}) RETURNING id",
        [name, *(psycopg.types.json.Jsonb(v) if isinstance(v, dict) else v
                 for v in base.values())]).fetchone()[0]


def test_upgrade_keeps_old_rows_with_a_first_version_and_rolls_back(throwaway_url):
    _alembic(throwaway_url, "upgrade", "0101")
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(sync, autocommit=True) as conn:
        conn.execute("DELETE FROM label_templates")
        old = _insert(conn, "Front Tag - 203DPI", version=4)

    _alembic(throwaway_url, "upgrade", "head")
    with psycopg.connect(sync, autocommit=True) as conn:
        row = conn.execute(
            "SELECT parent_id, schema_version, samples, customized, is_old, child_edits, "
            "dpis FROM label_templates WHERE id = %s", [old]).fetchone()
        assert row == (None, 1, {}, False, False, 0, ["203"])
        assert conn.execute(
            "SELECT version, child_edits, code, summary FROM label_template_versions "
            "WHERE template_id = %s", [old]).fetchall() == [
                (4, 0, "^XA^XZ", "Saved before versions were kept")]
        assert conn.execute("SELECT meta FROM label_vocab WHERE kind = 'dpi' AND key = '600'"
                            ).fetchone() == ({"dots": 600},)

        design = {"schema": 2, "size": {"w": 4, "h": 2}, "elements": []}
        parent = _insert(conn, "Builder", kind="design", code=None, design=design,
                         dpi_key="300", schema_version=2)
        _insert(conn, "Builder · 600", kind="design", code=None, design=design,
                dpi_key="600", schema_version=2, parent_id=parent)
        # one current child per parent and DPI; a kept Old one may share it
        with pytest.raises(psycopg.errors.UniqueViolation):
            _insert(conn, "Builder · 600 again", kind="design", code=None, design=design,
                    dpi_key="600", schema_version=2, parent_id=parent)
        _insert(conn, "Builder · 600 Old", kind="design", code=None, design=design,
                dpi_key="600", schema_version=2, parent_id=parent, is_old=True)
        # a child is always a builder (schema 2) row
        with pytest.raises(psycopg.errors.CheckViolation):
            _insert(conn, "Builder · 203", dpi_key="203", parent_id=parent)
        # the parent takes its children with it
        conn.execute("DELETE FROM label_templates WHERE id = %s", [parent])
        assert conn.execute("SELECT count(*) FROM label_templates").fetchone() == (1,)
        _insert(conn, "Builder 2", kind="design", code=None, design=design, dpi_key="600",
                schema_version=2)

    _alembic(throwaway_url, "downgrade", "0101")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert conn.execute("SELECT name::text FROM label_templates").fetchall() == [
            ("Front Tag - 203DPI",)]
        assert conn.execute("SELECT count(*) FROM label_vocab WHERE kind = 'dpi' "
                            "AND key = '600'").fetchone() == (0,)
    _alembic(throwaway_url, "upgrade", "head")
