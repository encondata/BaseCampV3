"""Migration 0110's one-time data step: approval cards decided before the
delivery log arrived (a membership request, a router approval, a password-
reset request) are marked read, as every decision marks its copies read from
now on; pending and open cards stay unread, and a card already read keeps its
first read time. Rolling back leaves the read state alone (data only). Runs
on a throwaway database (`<SS_TEST_DB>_m0110`) so the shared test DB stays at
head."""

import os
from datetime import UTC, datetime

import psycopg
import pytest
from psycopg.types.json import Jsonb
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0110"

EARLIER = datetime(2026, 9, 1, 12, 0, tzinfo=UTC)

# title -> (kind, payload, read_at before the upgrade)
CARDS = {
    "approved join": ("membership_request", {"state": "approved"}, None),
    "pending join": ("membership_request", {"state": "pending"}, None),
    "join without a state": ("membership_request", {}, None),
    "revoked router": ("router_approval", {"state": "revoked"}, None),
    "pending router": ("router_approval", {"state": "pending"}, None),
    "router read earlier": ("router_approval", {"state": "approved"}, EARLIER),
    "resolved reset": ("password_reset_request", {"state": "resolved"}, None),
    "open reset": ("password_reset_request", {"state": "open"}, None),
    "not an approval": ("report_ready", {"state": "approved"}, None),
}
MARKED_READ = {"approved join", "revoked router", "resolved reset"}


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


def _read_at(conn) -> dict:
    return dict(conn.execute("SELECT title, read_at FROM notifications").fetchall())


def test_upgrade_marks_cards_decided_before_it_read(throwaway_url):
    _alembic(throwaway_url, "upgrade", "head")
    _alembic(throwaway_url, "downgrade", "0109")
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(sync, autocommit=True) as conn:
        person = conn.execute(
            "INSERT INTO people (first_name, last_name) VALUES ('Pat', 'Approver') "
            "RETURNING id").fetchone()[0]
        for title, (kind, payload, read_at) in CARDS.items():
            conn.execute(
                "INSERT INTO notifications (person_id, kind, title, payload, read_at) "
                "VALUES (%s, %s, %s, %s, %s)", (person, kind, title, Jsonb(payload), read_at))

    _alembic(throwaway_url, "upgrade", "head")
    with psycopg.connect(sync, autocommit=True) as conn:
        after = _read_at(conn)
    assert {title for title, read_at in after.items() if read_at is not None} == (
        MARKED_READ | {"router read earlier"})
    assert after["router read earlier"] == EARLIER      # the first read time stays

    _alembic(throwaway_url, "downgrade", "0109")          # data only: nothing to undo
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _read_at(conn) == after
