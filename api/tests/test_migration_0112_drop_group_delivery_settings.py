"""Migration 0112 (notifications Phase 1): groups keep members only. The delivery
columns of `notification_groups` and `notification_group_members` go, with the nine
CHECKs that guarded them; `categories` and its own CHECK stay. Rolling back puts the
columns back with their 0033/0034 defaults and the CHECKs; the values that were dropped
are not restored.

The shape at head is read on the shared test database; migration 0113 has since dropped
`categories` and its CHECK too, which is the one difference from the shape 0112 left. The
upgrade and the rollback run on a throwaway database (`<SS_TEST_DB>_m0112`) so the shared
one stays at head.

Spec: docs/superpowers/specs/2026-11-01-notifications-phase1-design.md (sections 6 and 8)"""

import os
from datetime import time

import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from serversherpa.db.models import NotificationGroup, NotificationGroupMember
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0112"

# what stays
GROUP_KEPT = {"id", "name", "description", "enabled", "categories", "created_by",
              "created_at", "updated_at"}
MEMBER_KEPT = {"group_id", "person_id", "added_by", "added_at"}
KEPT_CHECKS = ["ck_notification_groups_categories"]

# what is left of a group at head: 0113 dropped `categories` and its CHECK
GROUP_AT_HEAD = GROUP_KEPT - {"categories"}

# what goes (and what the rollback restores)
GROUP_DELIVERY = ("channels", "quiet_start", "quiet_end", "timezone", "active_days",
                  "dnd_behavior", "urgent_bypass")
MEMBER_DELIVERY = ("channels", "quiet_mode", "quiet_start", "quiet_end", "timezone",
                   "active_days", "dnd_behavior", "urgent_bypass")
GROUP_CHECKS = [
    "notification_groups_active_days_check",
    "notification_groups_channels_check",
    "notification_groups_dnd_behavior_check",
    "notification_groups_quiet_pair_check",
]
MEMBER_CHECKS = [
    "notification_group_members_active_days_check",
    "notification_group_members_channels_check",
    "notification_group_members_dnd_behavior_check",
    "notification_group_members_quiet_custom_check",
    "notification_group_members_quiet_mode_check",
]

ALL_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

# column -> (is_nullable, column_default) as Postgres reports them once restored:
# migration 0033's defaults, with 0034's timezone
GROUP_RESTORED = {
    "channels": ("NO", "'{email,web}'::text[]"),
    "quiet_start": ("YES", None),
    "quiet_end": ("YES", None),
    "timezone": ("NO", "'America/New_York'::text"),
    "active_days": ("NO", "'{mon,tue,wed,thu,fri,sat,sun}'::text[]"),
    "dnd_behavior": ("NO", "'defer'::text"),
    "urgent_bypass": ("NO", "true"),
}
MEMBER_RESTORED = {column: ("YES", None) for column in MEMBER_DELIVERY}

# constraint -> a statement that breaks it (every table has a row by then)
CHECK_VIOLATIONS = [
    ("notification_groups_channels_check",
     "UPDATE notification_groups SET channels = '{carrier_pigeon}'"),
    ("notification_groups_active_days_check",
     "UPDATE notification_groups SET active_days = '{funday}'"),
    ("notification_groups_dnd_behavior_check",
     "UPDATE notification_groups SET dnd_behavior = 'ignore'"),
    ("notification_groups_quiet_pair_check",
     "UPDATE notification_groups SET quiet_start = '22:00'"),
    ("notification_group_members_channels_check",
     "UPDATE notification_group_members SET channels = '{carrier_pigeon}'"),
    ("notification_group_members_active_days_check",
     "UPDATE notification_group_members SET active_days = '{funday}'"),
    ("notification_group_members_quiet_mode_check",
     "UPDATE notification_group_members SET quiet_mode = 'sometimes'"),
    ("notification_group_members_dnd_behavior_check",
     "UPDATE notification_group_members SET dnd_behavior = 'ignore'"),
    ("notification_group_members_quiet_custom_check",
     "UPDATE notification_group_members SET quiet_mode = 'custom'"),
]


# ── the shape at head, on the shared database ──────────────────────

async def _columns(db, table) -> set[str]:
    return set((await db.execute(text(
        "SELECT column_name FROM information_schema.columns WHERE table_name = :t"),
        {"t": table})).scalars())


async def _checks(db, table) -> list[str]:
    return sorted((await db.execute(text(
        "SELECT conname FROM pg_constraint "
        "WHERE conrelid = CAST(:t AS regclass) AND contype = 'c'"),
        {"t": table})).scalars())


async def test_groups_keep_only_their_own_columns(db):
    assert await _columns(db, "notification_groups") == GROUP_AT_HEAD


async def test_members_keep_only_who_and_when(db):
    assert await _columns(db, "notification_group_members") == MEMBER_KEPT


async def test_no_check_remains(db):
    assert await _checks(db, "notification_groups") == []
    assert await _checks(db, "notification_group_members") == []


def test_the_models_mirror_the_tables():
    assert {c.name for c in NotificationGroup.__table__.columns} == GROUP_AT_HEAD
    assert {c.name for c in NotificationGroupMember.__table__.columns} == MEMBER_KEPT


# ── the upgrade and the rollback, on a throwaway database ──────────

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


def _sync(url) -> str:
    return url.set(drivername="postgresql").render_as_string(hide_password=False)


def _column_names(conn, table) -> set[str]:
    return {row[0] for row in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s", (table,))}


def _column_rules(conn, table, columns) -> dict:
    return {name: (nullable, default) for name, nullable, default in conn.execute(
        "SELECT column_name, is_nullable, column_default FROM information_schema.columns "
        "WHERE table_name = %s AND column_name = ANY(%s)", (table, list(columns)))}


def _check_names(conn, table) -> list[str]:
    return sorted(row[0] for row in conn.execute(
        "SELECT conname FROM pg_constraint "
        "WHERE conrelid = %s::regclass AND contype = 'c'", (table,)))


def _people(conn) -> dict:
    return {first: conn.execute(
        "INSERT INTO people (first_name, last_name) VALUES (%s, 'Tester') RETURNING id",
        (first,)).fetchone()[0] for first in ("Pat", "Sam")}


def _seed_at_0111(conn) -> dict:
    """A paused group with every delivery value set away from its default, a member
    with every override set, a member with none, and a pending leave request."""
    people = _people(conn)
    group = conn.execute(
        "INSERT INTO notification_groups (name, description, channels, quiet_start, "
        "quiet_end, timezone, active_days, dnd_behavior, urgent_bypass, enabled, "
        "categories, created_by) "
        "VALUES ('On-call', 'Night pager', '{email,text}', '22:00', '06:00', "
        "'America/Chicago', '{mon,tue}', 'skip', false, false, '{reports,wiki}', %s) "
        "RETURNING id", (people["Pat"],)).fetchone()[0]
    conn.execute(
        "INSERT INTO notification_group_members (group_id, person_id, added_by, channels, "
        "quiet_mode, quiet_start, quiet_end, timezone, active_days, dnd_behavior, "
        "urgent_bypass) "
        "VALUES (%s, %s, %s, '{web}', 'custom', '21:00', '05:00', 'Europe/Paris', '{sat}', "
        "'defer', true)", (group, people["Pat"], people["Sam"]))
    conn.execute(
        "INSERT INTO notification_group_members (group_id, person_id) VALUES (%s, %s)",
        (group, people["Sam"]))
    conn.execute(
        "INSERT INTO notification_membership_requests (group_id, person_id, action, note) "
        "VALUES (%s, %s, 'leave', 'swapping shifts')", (group, people["Pat"]))
    return {"group": group, **people}


def _seed_kept(conn) -> dict:
    """The same group and members through the columns that stay."""
    people = _people(conn)
    group = conn.execute(
        "INSERT INTO notification_groups (name, description, enabled, categories) "
        "VALUES ('On-call', 'Night pager', false, '{reports,wiki}') RETURNING id"
    ).fetchone()[0]
    conn.execute(
        "INSERT INTO notification_group_members (group_id, person_id, added_by) "
        "VALUES (%s, %s, %s)", (group, people["Pat"], people["Sam"]))
    conn.execute(
        "INSERT INTO notification_group_members (group_id, person_id) VALUES (%s, %s)",
        (group, people["Sam"]))
    return {"group": group, **people}


def test_upgrade_drops_the_columns_and_checks_and_keeps_the_rest(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0111")
    with psycopg.connect(sync, autocommit=True) as conn:
        ids = _seed_at_0111(conn)
        # before: the delivery columns and their CHECKs are all there
        assert set(GROUP_DELIVERY) <= _column_names(conn, "notification_groups")
        assert set(MEMBER_DELIVERY) <= _column_names(conn, "notification_group_members")
        assert _check_names(conn, "notification_groups") == sorted(KEPT_CHECKS + GROUP_CHECKS)
        assert _check_names(conn, "notification_group_members") == MEMBER_CHECKS

    _alembic(throwaway_url, "upgrade", "0112")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _column_names(conn, "notification_groups") == GROUP_KEPT
        assert _column_names(conn, "notification_group_members") == MEMBER_KEPT
        assert _check_names(conn, "notification_groups") == KEPT_CHECKS
        assert _check_names(conn, "notification_group_members") == []

        # the group keeps its name, description, status and categories
        assert conn.execute(
            "SELECT name, description, enabled, categories, created_by "
            "FROM notification_groups").fetchall() == [
            ("On-call", "Night pager", False, ["reports", "wiki"], ids["Pat"])]
        # both members stay, with who added them
        assert dict(conn.execute(
            "SELECT person_id, added_by FROM notification_group_members").fetchall()) == {
            ids["Pat"]: ids["Sam"], ids["Sam"]: None}
        # and the pending request, which lives in its own table
        assert conn.execute(
            "SELECT action, note, status FROM notification_membership_requests"
        ).fetchall() == [("leave", "swapping shifts", "pending")]

        # a group is still just a name, and its categories are still checked
        conn.execute("INSERT INTO notification_groups (name) VALUES ('Plain')")
        assert conn.execute(
            "SELECT description, enabled, categories FROM notification_groups "
            "WHERE name = 'Plain'").fetchone() == ("", True, [])
        with pytest.raises(psycopg.errors.CheckViolation) as raised:
            conn.execute("UPDATE notification_groups SET categories = '{bogus}'")
        assert raised.value.diag.constraint_name == "ck_notification_groups_categories"


def test_downgrade_restores_the_columns_with_their_defaults_and_checks(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0112")
    with psycopg.connect(sync, autocommit=True) as conn:
        _seed_kept(conn)

    _alembic(throwaway_url, "downgrade", "0111")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _column_rules(conn, "notification_groups", GROUP_DELIVERY) == GROUP_RESTORED
        assert _column_rules(
            conn, "notification_group_members", MEMBER_DELIVERY) == MEMBER_RESTORED
        # rows that were there take the defaults: the old values are not restored
        assert conn.execute(
            "SELECT channels, quiet_start, quiet_end, timezone, active_days, dnd_behavior, "
            "urgent_bypass FROM notification_groups").fetchall() == [
            (["email", "web"], None, None, "America/New_York", ALL_DAYS, "defer", True)]
        assert conn.execute(
            "SELECT channels, quiet_mode, quiet_start, quiet_end, timezone, active_days, "
            "dnd_behavior, urgent_bypass FROM notification_group_members").fetchall() == [
            (None,) * 8, (None,) * 8]
        # the new group takes them too
        conn.execute("INSERT INTO notification_groups (name) VALUES ('Fresh')")
        assert conn.execute(
            "SELECT channels, timezone, urgent_bypass FROM notification_groups "
            "WHERE name = 'Fresh'").fetchone() == (["email", "web"], "America/New_York", True)

        # every CHECK is back, by name, and guards its column again
        assert _check_names(conn, "notification_groups") == sorted(KEPT_CHECKS + GROUP_CHECKS)
        assert _check_names(conn, "notification_group_members") == MEMBER_CHECKS
        for constraint, statement in CHECK_VIOLATIONS:
            with pytest.raises(psycopg.errors.CheckViolation) as raised:
                conn.execute(statement)
            assert raised.value.diag.constraint_name == constraint, statement
        # a legal override still goes in
        conn.execute(
            "UPDATE notification_group_members SET quiet_mode = 'custom', "
            "quiet_start = %s, quiet_end = %s", (time(21, 0), time(5, 0)))

        # what stays is untouched
        assert conn.execute(
            "SELECT name, enabled, categories FROM notification_groups ORDER BY name"
        ).fetchall() == [("Fresh", True, []), ("On-call", False, ["reports", "wiki"])]

    # and forward again
    _alembic(throwaway_url, "upgrade", "0112")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _column_names(conn, "notification_groups") == GROUP_KEPT
        assert _column_names(conn, "notification_group_members") == MEMBER_KEPT
        assert _check_names(conn, "notification_groups") == KEPT_CHECKS
        assert _check_names(conn, "notification_group_members") == []
        assert conn.execute(
            "SELECT name, categories FROM notification_groups ORDER BY name"
        ).fetchall() == [("Fresh", []), ("On-call", ["reports", "wiki"])]
        assert conn.execute(
            "SELECT count(*) FROM notification_group_members").fetchone() == (2,)
