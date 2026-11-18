"""Migration 0131: the `app_distribution` permission resource and its grants.

The round trip runs on a throwaway database (`<SS_TEST_DB>_m0131`) so the
shared test DB stays at head."""

import os

import psycopg
import pytest
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0131"

FULL = {"view", "add", "change", "delete"}
GRANTED_ROLES = ("developer", "founder", "super_admin", "admin")
NO_GRANT_ROLES = ("client_owner", "client_admin", "learning_admin", "worker")


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


def _grants(conn) -> dict:
    return {role: {r[0] for r in conn.execute(
        "SELECT action FROM role_permissions "
        "WHERE role = %s AND resource = 'app_distribution'", (role,))}
        for role in (*GRANTED_ROLES, "staff", *NO_GRANT_ROLES)}


def test_downgrade_and_upgrade_again(throwaway_url):
    _alembic(throwaway_url, "upgrade", "head")
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(sync, autocommit=True) as conn:
        up = _grants(conn)
        for role in GRANTED_ROLES:
            assert up[role] == FULL, role
        assert up["staff"] == {"view"}
        for role in NO_GRANT_ROLES:
            assert up[role] == set(), role

    _alembic(throwaway_url, "downgrade", "0130")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert all(g == set() for g in _grants(conn).values())
        assert conn.execute(
            "SELECT count(*) FROM role_permissions WHERE resource = 'app_distribution'"
        ).fetchone()[0] == 0

    _alembic(throwaway_url, "upgrade", "head")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _grants(conn) == up
