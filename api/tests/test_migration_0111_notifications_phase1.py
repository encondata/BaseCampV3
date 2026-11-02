"""Migration 0111 (notifications Phase 1): the `notification_held` table, the
delivery log's CHECK widened to ten events, and the one-time conversion of
`ui_prefs.notif.categories` (a choice per category) into `notif.switches` (only
the person's own Inbox and Email values) with the legacy keys stripped.

The table and the CHECK are read on the shared test database (at head). The
data step and the rollback run on a throwaway database (`<SS_TEST_DB>_m0111`)
so the shared one stays at head.

Spec: docs/superpowers/specs/2026-11-01-notifications-phase1-design.md (sections 1, 4 and 8)"""

import os
from datetime import UTC, datetime

import psycopg
import pytest
from psycopg.types.json import Jsonb
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import DBAPIError

from serversherpa.config import get_settings
from serversherpa.db.models import Notification, NotificationHeld, Person
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0111"

HELD_AT = datetime(2026, 10, 7, 23, 0, tzinfo=UTC)


# ── the table, on the shared database ──────────────────────────────

async def test_notification_held_columns(db):
    rows = (await db.execute(text(
        "SELECT column_name, data_type, is_nullable, column_default "
        "FROM information_schema.columns WHERE table_name = 'notification_held'"))).all()
    assert {r[0]: (r[1], r[2]) for r in rows} == {
        "id": ("uuid", "NO"),
        "person_id": ("uuid", "NO"),
        "notification_id": ("uuid", "YES"),
        "kind": ("text", "NO"),
        "category": ("text", "NO"),
        "reason": ("text", "NO"),
        "held_at": ("timestamp with time zone", "NO"),
    }
    defaults = {r[0]: r[3] for r in rows}
    assert "gen_random_uuid" in defaults["id"]
    # the writer stamps held_at itself (a transaction's now() would freeze it)
    assert defaults["held_at"] is None


async def test_notification_held_is_indexed_for_a_persons_oldest_first(db):
    [indexdef] = (await db.execute(text(
        "SELECT indexdef FROM pg_indexes "
        "WHERE tablename = 'notification_held' AND indexname = 'notification_held_person_idx'"
    ))).scalars().all()
    assert "(person_id, held_at)" in indexdef


async def test_notification_held_names_its_reason_check(db):
    names = (await db.execute(text(
        "SELECT conname FROM pg_constraint "
        "WHERE conrelid = 'notification_held'::regclass AND contype = 'c'"))).scalars().all()
    assert names == ["ck_notification_held_reason"]


async def test_notification_held_links_cascade_and_clear(db):
    rules = dict((await db.execute(text(
        "SELECT kcu.column_name, rc.delete_rule "
        "FROM information_schema.referential_constraints rc "
        "JOIN information_schema.key_column_usage kcu "
        "  ON kcu.constraint_name = rc.constraint_name "
        "WHERE kcu.table_name = 'notification_held'"))).all())
    assert rules == {"person_id": "CASCADE", "notification_id": "SET NULL"}


async def test_notification_held_rows_round_trip_and_follow_their_links(db):
    person = Person(first_name="Pat", last_name="Tester")
    db.add(person)
    await db.flush()
    note = Notification(person_id=person.id, kind="report_ready", title="Ready")
    db.add(note)
    await db.flush()
    held = NotificationHeld(person_id=person.id, notification_id=note.id, kind="report_ready",
                            category="reports", reason="quiet_hours", held_at=HELD_AT)
    db.add(held)
    await db.commit()
    await db.refresh(held)
    assert held.id is not None
    assert (held.kind, held.category, held.reason, held.held_at) == (
        "report_ready", "reports", "quiet_hours", HELD_AT)

    # a deleted notification leaves the row, with the link cleared
    await db.execute(text("DELETE FROM notifications WHERE id = :i"), {"i": note.id})
    await db.commit()
    await db.refresh(held)
    assert held.notification_id is None

    # a deleted person takes the row with them
    await db.execute(text("DELETE FROM people WHERE id = :i"), {"i": person.id})
    await db.commit()
    assert await db.scalar(text("SELECT count(*) FROM notification_held")) == 0


@pytest.mark.parametrize("reason,accepted", [
    ("quiet_hours", True),
    ("inactive_day", True),
    ("no_email_group", False),
    ("", False),
])
async def test_notification_held_reason_check(db, reason, accepted):
    person = Person(first_name="Pat", last_name="Tester")
    db.add(person)
    await db.flush()
    db.add(NotificationHeld(person_id=person.id, kind="report_ready", category="reports",
                            reason=reason, held_at=HELD_AT))
    if accepted:
        await db.flush()
    else:
        with pytest.raises(DBAPIError):
            await db.flush()
    await db.rollback()


@pytest.mark.parametrize("event,accepted", [
    ("email_held", True),
    ("email_summarized", True),
    ("email_failed", True),            # the eight of Phase 0 stay
    ("email_scheduled", False),
])
async def test_log_event_check_lists_ten_events(db, event, accepted):
    insert = text("INSERT INTO notification_log (event, channel) VALUES (:e, 'email')")
    if accepted:
        await db.execute(insert, {"e": event})
    else:
        with pytest.raises(DBAPIError):
            await db.execute(insert, {"e": event})
    await db.rollback()


# ── the data step and the rollback, on a throwaway database ────────

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


# first name -> the ui_prefs stored before the upgrade
BEFORE = {
    # the legacy keys go, security and "email" add nothing, the rest become switches
    "Choices": {"notif": {
        "categories": {"approvals": "email", "reports": "inbox", "wiki": "off",
                       "security": "inbox"},
        "critical": True, "digest": "daily", "sound": "ping"}},
    # no notif at all
    "Plain": {"accent": "aqua"},
    # an account whose prefs are just the empty default
    "Empty": {},
    # the legacy keys alone: stripped, and no switches appear
    "Legacy": {"accent": "aqua", "notif": {
        "critical": False, "email": False, "maint": True, "digest": True, "sound": "pop"}},
    # every category on "email": nothing to keep, so no switches key
    "AllEmail": {"notif": {"categories": {"approvals": "email", "reports": "email",
                                          "wiki": "email", "learning": "email",
                                          "security": "email"}}},
    # merges into switches that are already there: reports adds its other value,
    # wiki's Inbox is already set (on) and wins over the old "off", learning stays
    "Merge": {"notif": {
        "categories": {"reports": "inbox", "wiki": "off"},
        "switches": {"reports": {"inbox": False}, "wiki": {"inbox": True},
                     "learning": {"email": False}}}},
    # every configurable category, and an unknown one that is dropped
    "Every": {"notif": {"categories": {"approvals": "off", "reports": "inbox", "wiki": "inbox",
                                       "learning": "off", "bogus": "off"}}},
    # choices that are not one of the three, and categories that is not a mapping
    "Odd": {"notif": {"categories": {"approvals": "sms", "reports": 7, "wiki": None,
                                     "learning": ["off"]}, "sound": "bell"}},
    "NotAMapping": {"notif": {"categories": "garbage", "sound": "bell"}},
    # a notif that is not an object is left alone
    "NotAnObject": {"notif": "legacy"},
    "Null": {"notif": None},
}

AFTER = {
    "Choices": {"notif": {"sound": "ping", "switches": {
        "reports": {"email": False}, "wiki": {"inbox": False, "email": False}}}},
    "Plain": {"accent": "aqua"},
    "Empty": {},
    "Legacy": {"accent": "aqua", "notif": {"sound": "pop"}},
    "AllEmail": {"notif": {}},
    "Merge": {"notif": {"switches": {
        "reports": {"inbox": False, "email": False},
        "wiki": {"inbox": True, "email": False},
        "learning": {"email": False}}}},
    "Every": {"notif": {"switches": {
        "approvals": {"inbox": False, "email": False}, "reports": {"email": False},
        "wiki": {"email": False}, "learning": {"inbox": False, "email": False}}}},
    "Odd": {"notif": {"sound": "bell"}},
    "NotAMapping": {"notif": {"sound": "bell"}},
    "NotAnObject": {"notif": "legacy"},
    "Null": {"notif": None},
}

ALL_EMAIL = {"approvals": "email", "reports": "email", "wiki": "email", "learning": "email",
             "security": "email"}

# what the rollback makes of AFTER (the old shape: five keys, no switches or schedule)
ROLLED_BACK = {
    "Choices": {"notif": {"sound": "ping", "categories": {
        "approvals": "email", "reports": "inbox", "wiki": "off", "learning": "email",
        "security": "email"}}},
    "Plain": {"accent": "aqua"},
    "Empty": {},
    "Legacy": {"accent": "aqua", "notif": {"sound": "pop", "categories": ALL_EMAIL}},
    "AllEmail": {"notif": {"categories": ALL_EMAIL}},
    "Merge": {"notif": {"categories": {
        "approvals": "email", "reports": "off", "wiki": "inbox", "learning": "inbox",
        "security": "email"}}},
    "Every": {"notif": {"categories": {
        "approvals": "off", "reports": "inbox", "wiki": "inbox", "learning": "off",
        "security": "email"}}},
    "Odd": {"notif": {"sound": "bell", "categories": ALL_EMAIL}},
    "NotAMapping": {"notif": {"sound": "bell", "categories": ALL_EMAIL}},
    "NotAnObject": {"notif": "legacy"},
    "Null": {"notif": None},
}


def _seed(conn) -> dict:
    ids = {}
    for first_name, prefs in BEFORE.items():
        person = conn.execute(
            "INSERT INTO people (first_name, last_name) VALUES (%s, 'Tester') RETURNING id",
            (first_name,)).fetchone()[0]
        conn.execute("INSERT INTO user_accounts (person_id, email, ui_prefs) VALUES (%s, %s, %s)",
                     (person, f"{first_name.lower()}@test.example.com", Jsonb(prefs)))
        ids[first_name] = person
    return ids


def _prefs(conn) -> dict:
    return {name: prefs for name, prefs in conn.execute(
        "SELECT p.first_name, a.ui_prefs FROM user_accounts a "
        "JOIN people p ON p.id = a.person_id").fetchall()}


def test_upgrade_converts_choices_into_switches_and_downgrade_restores_the_shape(
        throwaway_url):
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)

    _alembic(throwaway_url, "upgrade", "0110")
    with psycopg.connect(sync, autocommit=True) as conn:
        ids = _seed(conn)

    _alembic(throwaway_url, "upgrade", "0111")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _prefs(conn) == AFTER
        # the new table exists and the log takes a held event
        assert conn.execute("SELECT to_regclass('notification_held')").fetchone()[0] is not None
        conn.execute("INSERT INTO notification_log (event, channel) "
                     "VALUES ('email_held', 'email'), ('email_summarized', 'email')")
        conn.execute("INSERT INTO notification_held "
                     "(person_id, kind, category, reason, held_at) "
                     "VALUES (%s, 'report_ready', 'reports', 'inactive_day', now())",
                     (ids["Choices"],))
        # a schedule saved after the upgrade is dropped by the rollback
        conn.execute(
            "UPDATE user_accounts SET ui_prefs = jsonb_set(ui_prefs, '{notif,schedule}', %s) "
            "WHERE person_id = %s",
            (Jsonb({"timezone": "America/Chicago", "days": ["mon"],
                    "quiet_start": "21:00", "quiet_end": "06:00"}), ids["Choices"]))

    _alembic(throwaway_url, "downgrade", "0110")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _prefs(conn) == ROLLED_BACK
        assert conn.execute("SELECT to_regclass('notification_held')").fetchone()[0] is None
        # the held and summarized rows went with the two events, the rest stay
        events = conn.execute("SELECT event FROM notification_log").fetchall()
        assert events == []
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute("INSERT INTO notification_log (event, channel) "
                         "VALUES ('email_held', 'email')")
        conn.execute("INSERT INTO notification_log (event, channel) "
                     "VALUES ('email_failed', 'email')")
        conn.execute("DELETE FROM notification_log")

    # and forward again: the same switches come back from the restored choices
    _alembic(throwaway_url, "upgrade", "0111")
    with psycopg.connect(sync, autocommit=True) as conn:
        again = _prefs(conn)
    assert again["Choices"] == AFTER["Choices"]
    assert again["Every"] == AFTER["Every"]
    assert again["Merge"]["notif"]["switches"]["reports"] == {"email": False, "inbox": False}


def test_downgrade_keeps_the_other_log_events(throwaway_url):
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    _alembic(throwaway_url, "upgrade", "0111")
    with psycopg.connect(sync, autocommit=True) as conn:
        conn.execute("INSERT INTO notification_log (event, channel) VALUES "
                     "('inbox_written', 'inbox'), ('email_held', 'email'), "
                     "('email_sent', 'email'), ('email_summarized', 'email')")
    _alembic(throwaway_url, "downgrade", "0110")
    with psycopg.connect(sync, autocommit=True) as conn:
        events = sorted(r[0] for r in conn.execute("SELECT event FROM notification_log"))
    assert events == ["email_sent", "inbox_written"]
