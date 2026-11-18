"""Migration 0131: push registration and outbox tables, and the snooze column."""

import os

import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from serversherpa.config import get_settings
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0131"


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


async def test_upgrade_creates_push_tables(db):
    tables = set((await db.execute(text(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_name IN ('push_registrations', 'push_outbox')"))).scalars())
    assert tables == {"push_registrations", "push_outbox"}
    index = await db.scalar(text(
        "SELECT indexdef FROM pg_indexes WHERE indexname = 'push_outbox_one_queued_idx'"))
    assert index and "UNIQUE" in index and "queued" in index
    assert await db.scalar(text(
        "SELECT count(*) FROM pg_indexes WHERE indexname = 'push_outbox_state_send_idx'")) == 1
    assert await db.scalar(text(
        "SELECT count(*) FROM information_schema.columns WHERE table_name = 'notifications' "
        "AND column_name = 'push_snoozed_until'")) == 1


async def test_second_queued_row_same_notification_rejected(db):
    person = await db.scalar(text(
        "INSERT INTO people (first_name, last_name) VALUES ('Pat', 'Pusher') RETURNING id"))
    note = await db.scalar(text(
        "INSERT INTO notifications (person_id, kind, title) VALUES (:p, 'x', 'T') "
        "RETURNING id"), {"p": person})

    async def add(state, message_type="notification"):
        await db.execute(text(
            "INSERT INTO push_outbox (notification_id, person_id, send_at, reason, state, "
            "message_type) VALUES (:n, :p, now(), 'new', :s, :m)"),
            {"n": note, "p": person, "s": state, "m": message_type})
        await db.flush()

    await add("sent")
    await add("queued")                       # a sent row plus a queued one is fine
    await add("queued", "clear")              # another message type is fine
    with pytest.raises(IntegrityError):
        await add("queued")
    await db.rollback()


def test_downgrade_removes_them(throwaway_url):
    _alembic(throwaway_url, "upgrade", "head")
    _alembic(throwaway_url, "downgrade", "0130")
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(sync, autocommit=True) as conn:
        tables = conn.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_name IN ('push_registrations', 'push_outbox')").fetchall()
        cols = conn.execute(
            "SELECT 1 FROM information_schema.columns WHERE table_name = 'notifications' "
            "AND column_name = 'push_snoozed_until'").fetchall()
    assert tables == [] and cols == []
    _alembic(throwaway_url, "upgrade", "head")
