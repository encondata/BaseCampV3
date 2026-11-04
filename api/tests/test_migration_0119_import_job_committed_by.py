"""Migration 0119 (notifications Phase 2, answer 7): `import_jobs.committed_by`, the person who
queued a job to write its data.

The shape at head and the model are read on the shared test database. The upgrade and the
rollback run on a throwaway database (`<SS_TEST_DB>_m0119`) so the shared one stays at head.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-as-built.md (Answers, 7)"""

import os
import uuid

import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from serversherpa.db.models import ImportJob, Person
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0119"


# ── the shape at head, on the shared database ──────────────────────

async def test_the_column_at_head(db):
    rows = (await db.execute(text(
        "SELECT column_name, udt_name, is_nullable, column_default "
        "FROM information_schema.columns WHERE table_name = 'import_jobs' "
        "AND column_name IN ('created_by', 'committed_by')"))).all()
    # nullable and with no default, the same as created_by
    assert {name: (udt, nullable, default) for name, udt, nullable, default in rows} == {
        "created_by": ("uuid", "YES", None), "committed_by": ("uuid", "YES", None)}

    # a foreign key to people, declared as created_by's is (no cascade, no clearing)
    keys = {column: (table, action) for column, table, action in (await db.execute(text(
        "SELECT a.attname, c.confrelid::regclass::text, c.confdeltype::text "
        "FROM pg_constraint c JOIN pg_attribute a "
        "ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) "
        "WHERE c.conrelid = 'import_jobs'::regclass AND c.contype = 'f'"))).all()}
    assert keys["committed_by"] == keys["created_by"] == ("people", "a")


def test_the_model_mirrors_the_column():
    columns = ImportJob.__table__.columns
    assert columns["committed_by"].nullable and columns["committed_by"].server_default is None
    assert str(columns["committed_by"].type) == str(columns["created_by"].type)
    [fk] = columns["committed_by"].foreign_keys
    assert (fk.column.table.name, fk.ondelete) == ("people", None)


async def test_the_model_round_trips(db):
    person = Person(first_name="Person", last_name="A")
    db.add(person)
    await db.flush()
    job = ImportJob(kind="asset_bulk_update", filename="a.csv", created_by=person.id)
    db.add(job)
    await db.commit()
    await db.refresh(job)
    # a job nobody has committed
    assert job.committed_by is None

    job.committed_by = person.id
    await db.commit()
    await db.refresh(job)
    assert job.committed_by == person.id


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


def _one(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()[0]


def _has_column(conn) -> bool:
    return _one(conn, "SELECT count(*) FROM information_schema.columns "
                      "WHERE table_name = 'import_jobs' AND column_name = 'committed_by'") == 1


# a job its person uploaded, with no committer named (the only kind there is before 0119)
UPLOADED = ("INSERT INTO import_jobs (kind, filename, created_by) "
            "VALUES ('asset_bulk_update', 'a.csv', %s) RETURNING id")


def test_upgrade_adds_the_column_and_the_downgrade_drops_it(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0118")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert not _has_column(conn)
        person = _one(conn, "INSERT INTO people (first_name, last_name) "
                            "VALUES ('Person', 'A') RETURNING id")
        queued_before = _one(conn, UPLOADED, (person,))

    _alembic(throwaway_url, "upgrade", "0119")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _has_column(conn)
        # a job from before the upgrade has no committer, and a new one need name none
        assert _one(conn, "SELECT committed_by FROM import_jobs WHERE id = %s",
                    (queued_before,)) is None
        queued_after = _one(conn, UPLOADED, (person,))
        assert _one(conn, "SELECT committed_by FROM import_jobs WHERE id = %s",
                    (queued_after,)) is None
        # a committer is a person who exists
        conn.execute("UPDATE import_jobs SET committed_by = %s WHERE id = %s",
                     (person, queued_after))
        with pytest.raises(psycopg.errors.ForeignKeyViolation):
            conn.execute("UPDATE import_jobs SET committed_by = %s WHERE id = %s",
                         (uuid.uuid4(), queued_before))

    _alembic(throwaway_url, "downgrade", "0118")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert not _has_column(conn)
        # the jobs stay, and so does who uploaded them
        assert sorted(conn.execute("SELECT id, created_by FROM import_jobs").fetchall()) == sorted(
            [(queued_before, person), (queued_after, person)])

    # and forward again: the column comes back empty
    _alembic(throwaway_url, "upgrade", "0119")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _has_column(conn)
        assert _one(conn, "SELECT count(*) FROM import_jobs WHERE committed_by IS NOT NULL") == 0
