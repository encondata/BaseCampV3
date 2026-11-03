"""Migration 0115 (notifications Phase 2, slice 4): `status_rule_notified`, when a status rule's
Notify action last told anyone about a matched thing (status_rules/notify.py's repeat guard).

The shape at head and the cascade from a deleted rule are read on the shared test database. The
upgrade and the rollback run on a throwaway database (`<SS_TEST_DB>_m0115`) so the shared one
stays at head.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 6 and 9)"""

import os
import uuid
from datetime import UTC, datetime

import psycopg
import pytest
from sqlalchemy import select, text
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from serversherpa.db.models import StatusRule, StatusRuleNotified
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0115"

# column -> (udt_name, is_nullable, column_default) as Postgres reports them
COLUMNS = {
    "rule_id": ("uuid", "NO", None),
    "subject_type": ("text", "NO", None),
    "subject_id": ("uuid", "NO", None),
    "notified_at": ("timestamptz", "NO", None),
}
PRIMARY_KEY = ["rule_id", "subject_type", "subject_id"]

RULE = ("INSERT INTO status_rules (name, trigger_status, trigger_match_type) "
        "VALUES ('Rule A', 'rfid_4_into_cage', 'asset') RETURNING id")
GUARD = ("INSERT INTO status_rule_notified (rule_id, subject_type, subject_id, notified_at) "
         "VALUES (%s, 'asset', %s, now())")


# ── the shape at head, on the shared database ──────────────────────

async def test_the_table_at_head(db):
    rows = (await db.execute(text(
        "SELECT column_name, udt_name, is_nullable, column_default "
        "FROM information_schema.columns WHERE table_name = 'status_rule_notified'"))).all()
    assert {name: (udt, nullable, default) for name, udt, nullable, default in rows} == COLUMNS

    # the primary key is the rule and the thing, in that order
    assert list((await db.execute(text(
        "SELECT a.attname FROM pg_index i "
        "JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) "
        "WHERE i.indrelid = 'status_rule_notified'::regclass AND i.indisprimary "
        "ORDER BY array_position(i.indkey, a.attnum)"))).scalars()) == PRIMARY_KEY
    # the rule is a foreign key that takes its rows along; the thing is not one
    assert (await db.execute(text(
        "SELECT confrelid::regclass::text, confdeltype::text, "
        "ARRAY(SELECT attname FROM pg_attribute WHERE attrelid = conrelid "
        "AND attnum = ANY(conkey)) FROM pg_constraint "
        "WHERE conrelid = 'status_rule_notified'::regclass AND contype = 'f'"))).all() == [
        ("status_rules", "c", ["rule_id"])]
    # the primary key is the only index: the cascade and the guard both lead with the rule
    assert list((await db.execute(text(
        "SELECT indexname FROM pg_indexes WHERE tablename = 'status_rule_notified'"))
    ).scalars()) == ["status_rule_notified_pkey"]


def test_the_model_mirrors_the_table():
    table = StatusRuleNotified.__table__
    assert {c.name for c in table.columns} == set(COLUMNS)
    assert [c.name for c in table.primary_key.columns] == PRIMARY_KEY
    assert not any(c.nullable for c in table.columns)
    assert table.columns["notified_at"].type.timezone
    [fk] = table.columns["rule_id"].foreign_keys
    assert (fk.column.table.name, fk.ondelete) == ("status_rules", "CASCADE")


async def test_a_deleted_rule_takes_its_rows(db):
    rule = StatusRule(name="Rule A", trigger_status="rfid_4_into_cage",
                      trigger_match_type="asset")
    other = StatusRule(name="Rule B", trigger_status="rfid_4_into_cage",
                       trigger_match_type="asset")
    db.add_all([rule, other])
    await db.flush()
    thing = uuid.uuid4()
    at = datetime(2026, 11, 3, 12, 0, tzinfo=UTC)
    db.add_all([StatusRuleNotified(rule_id=rule.id, subject_type="asset", subject_id=thing,
                                   notified_at=at),
                StatusRuleNotified(rule_id=other.id, subject_type="asset", subject_id=thing,
                                   notified_at=at)])
    await db.commit()

    await db.delete(rule)
    await db.commit()
    rows = (await db.execute(select(StatusRuleNotified.rule_id, StatusRuleNotified.subject_type,
                                    StatusRuleNotified.subject_id,
                                    StatusRuleNotified.notified_at))).all()
    assert rows == [(other.id, "asset", thing, at)]


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


def _exists(conn) -> bool:
    return conn.execute("SELECT to_regclass('status_rule_notified')").fetchone()[0] is not None


def test_upgrade_adds_the_table_and_the_downgrade_drops_it(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0114")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert not _exists(conn)
        rule_id = conn.execute(RULE).fetchone()[0]

    _alembic(throwaway_url, "upgrade", "0115")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _exists(conn)
        thing = uuid.uuid4()
        conn.execute(GUARD, (rule_id, thing))
        # one row per rule and thing
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute(GUARD, (rule_id, thing))
        # the rule must exist
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            conn.execute(GUARD, (uuid.uuid4(), thing))
        # and a time is required
        with pytest.raises(psycopg.errors.NotNullViolation):
            conn.execute("INSERT INTO status_rule_notified (rule_id, subject_type, subject_id) "
                         "VALUES (%s, 'asset', %s)", (rule_id, uuid.uuid4()))
        # a deleted rule takes its rows, and only its own
        other_id = conn.execute(RULE).fetchone()[0]
        conn.execute(GUARD, (other_id, thing))
        conn.execute("DELETE FROM status_rules WHERE id = %s", (rule_id,))
        assert conn.execute("SELECT rule_id, subject_id FROM status_rule_notified").fetchall() \
            == [(other_id, thing)]

    _alembic(throwaway_url, "downgrade", "0114")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert not _exists(conn)
        # the rules themselves stay
        assert conn.execute("SELECT id FROM status_rules").fetchall() == [(other_id,)]

    # and forward again: the table comes back empty
    _alembic(throwaway_url, "upgrade", "0115")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert conn.execute("SELECT count(*) FROM status_rule_notified").fetchone() == (0,)
