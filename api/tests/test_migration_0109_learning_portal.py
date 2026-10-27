"""Migration 0109 rolled back and applied again: the downgrade removes the
learning tables, the learning_admin role and its grants, the compliance
report definition, the widened notification category (repairing a group
that already uses it), the worker_certifications and email_outbox columns;
the upgrade brings them all back with their indexes. Runs on a throwaway
database (`<SS_TEST_DB>_m0109`) so the shared test DB stays at head."""

import os

import psycopg
import pytest
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from tests.test_learning_migration import TABLES
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0109"

INDEXES = ("learning_assignments_person_idx", "learning_email_log_initiative_idx",
           "learning_assignments_open_uniq", "learning_email_log_dedupe_uniq")


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


def _state(conn) -> dict:
    tables = {r[0] for r in conn.execute(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema = 'public' AND table_name LIKE 'learning\\_%'")}
    indexes = {r[0] for r in conn.execute(
        "SELECT indexname FROM pg_indexes WHERE indexname = ANY(%s)", (list(INDEXES),))}
    columns = {f"{t}.{c}" for t, c in conn.execute(
        "SELECT table_name, column_name FROM information_schema.columns "
        "WHERE (table_name = 'worker_certifications' "
        "       AND column_name IN ('source', 'learning_initiative_id')) "
        "   OR (table_name = 'email_outbox' AND column_name = 'attachments')")}
    return {
        "tables": tables, "indexes": indexes, "columns": columns,
        "role": conn.execute(
            "SELECT count(*) FROM roles WHERE name = 'learning_admin'").fetchone()[0],
        "grants": conn.execute(
            "SELECT count(*) FROM role_permissions WHERE resource = 'learning' "
            "OR role = 'learning_admin'").fetchone()[0],
        "report": conn.execute(
            "SELECT count(*) FROM report_definitions "
            "WHERE report_type = 'learning_compliance'").fetchone()[0],
    }


def test_downgrade_removes_everything_and_upgrade_restores_it(throwaway_url):
    _alembic(throwaway_url, "upgrade", "head")
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(sync, autocommit=True) as conn:
        up = _state(conn)
        assert up["tables"] == set(TABLES)
        assert up["indexes"] == set(INDEXES)
        assert len(up["columns"]) == 3
        assert up["role"] == 1 and up["grants"] > 0 and up["report"] == 1
        # data the downgrade has to clear or repair first
        person = conn.execute(
            "INSERT INTO people (first_name, last_name) VALUES ('Pat', 'Tester') "
            "RETURNING id").fetchone()[0]
        conn.execute("INSERT INTO person_roles (person_id, role) VALUES (%s, 'learning_admin')",
                     (person,))
        conn.execute("INSERT INTO notification_groups (name, categories) "
                     "VALUES ('Learning', ARRAY['learning','wiki'])")
        conn.execute("INSERT INTO learning_documents (title) VALUES ('Safety')")

    _alembic(throwaway_url, "downgrade", "0108")
    with psycopg.connect(sync, autocommit=True) as conn:
        down = _state(conn)
        assert down == {"tables": set(), "indexes": set(), "columns": set(),
                        "role": 0, "grants": 0, "report": 0}
        assert conn.execute(
            "SELECT categories FROM notification_groups WHERE name = 'Learning'"
        ).fetchone()[0] == ["wiki"]
        # the narrower category check is back
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("INSERT INTO notification_groups (name, categories) "
                         "VALUES ('Again', ARRAY['learning'])")

    _alembic(throwaway_url, "upgrade", "head")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _state(conn) == up
