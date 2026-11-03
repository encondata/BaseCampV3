"""Migration 0116 (notifications Phase 2, slice 5): the wiki's watches join `notification_watches`.

Every row of `wiki_watches` (a person watching a library, folder or page) is copied into the
shared table with its id and created time, and the old table is dropped with its indexes. The
shape at head is read on the shared test database. The copy, the rollback and the way forward
again run on a throwaway database (`<SS_TEST_DB>_m0116`) so the shared one stays at head.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 7)"""

import os
from datetime import UTC, datetime

import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from serversherpa.db import models
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0116"

# what 0075 and 0077 left behind, and what the migration takes away
OLD_INDEXES = ("wiki_watches_person_target_key", "wiki_watches_node_idx",
               "wiki_watches_space_idx")
OLD_CHECK = "wiki_watches_target_check"


# ── the shape at head, on the shared database ──────────────────────

async def test_the_old_table_is_gone_at_head(db):
    assert await db.scalar(text("SELECT to_regclass('wiki_watches')")) is None
    for index in OLD_INDEXES:
        assert await db.scalar(text("SELECT to_regclass(:i)"), {"i": index}) is None, index
    assert await db.scalar(text(
        "SELECT count(*) FROM pg_constraint WHERE conname = :c"), {"c": OLD_CHECK}) == 0


def test_the_old_model_is_gone():
    assert not hasattr(models, "WikiWatch")
    assert "wiki_watches" not in models.Base.metadata.tables


# ── the copy and the rollback, on a throwaway database ─────────────

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


def _exists(conn, name) -> bool:
    return _one(conn, "SELECT to_regclass(%s)", (name,)) is not None


def _shape(conn, table) -> dict:
    """A table as Postgres reports it: its columns in order, and its indexes and constraints by
    name with their definitions."""
    return {
        "columns": conn.execute(
            "SELECT column_name, udt_name, is_nullable, column_default "
            "FROM information_schema.columns WHERE table_name = %s ORDER BY ordinal_position",
            (table,)).fetchall(),
        "indexes": dict(conn.execute(
            "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = %s", (table,))),
        "constraints": dict(conn.execute(
            "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid = %s::regclass", (table,))),
    }


# five created times, one second apart, so the order of the rows says which is which
T1, T2, T3, T4, T5 = (datetime(2026, 9, 30, 8, 15, second, tzinfo=UTC) for second in range(1, 6))


def _seed(conn) -> dict:
    """Two people, a library, a folder and a page."""
    ids = {
        "person": _one(conn, "INSERT INTO people (first_name, last_name) "
                             "VALUES ('Person', 'A') RETURNING id"),
        "other": _one(conn, "INSERT INTO people (first_name, last_name) "
                            "VALUES ('Person', 'B') RETURNING id"),
        "space": _one(conn, "INSERT INTO wiki_spaces (key, name) "
                            "VALUES ('space-a', 'Space A') RETURNING id"),
    }
    for kind, title in (("folder", "Folder A"), ("page", "Page A")):
        ids[kind] = _one(
            conn, "INSERT INTO wiki_nodes (space_id, kind, title) VALUES (%s, %s, %s) "
                  "RETURNING id", (ids["space"], kind, title))
    return ids


def _old_watches(conn, ids) -> list[tuple]:
    """Person A watches the library, the folder and the page; Person B watches the page.
    Returns (id, person, space, node, created_at) of each, oldest first."""
    rows = []
    for person, space, node, created_at in (
            (ids["person"], ids["space"], None, T1),
            (ids["person"], None, ids["folder"], T2),
            (ids["person"], None, ids["page"], T3),
            (ids["other"], None, ids["page"], T4)):
        watch = _one(conn, "INSERT INTO wiki_watches (person_id, space_id, node_id, created_at) "
                           "VALUES (%s, %s, %s, %s) RETURNING id",
                     (person, space, node, created_at))
        rows.append((watch, person, space, node, created_at))
    return rows


def _shared_row(conn, *, person=None, group=None, created_by=None, created_at=None, **things):
    """Insert one watch into the shared table, naming no events, and return its id."""
    values = {"person_id": person, "group_id": group, "created_by": created_by, **things}
    if created_at is not None:
        values["created_at"] = created_at
    return _one(
        conn, f"INSERT INTO notification_watches ({', '.join(values)}) "
              f"VALUES ({', '.join(['%s'] * len(values))}) RETURNING id", list(values.values()))


def _wiki_rows(conn) -> list[tuple]:
    """(id, person, group, space, node, kinds, created_by, created_at) of every wiki watch in
    the shared table, oldest first."""
    return conn.execute(
        "SELECT id, person_id, group_id, wiki_space_id, wiki_node_id, kinds, created_by, "
        "created_at FROM notification_watches "
        "WHERE wiki_space_id IS NOT NULL OR wiki_node_id IS NOT NULL "
        "ORDER BY created_at, id").fetchall()


def _as_shared(old: list[tuple]) -> list[tuple]:
    """What the copy makes of the old rows: the same id, person, target and created time, no
    events named, and the person themselves as the one who made it."""
    return [(watch, person, None, space, node, [], person, created_at)
            for watch, person, space, node, created_at in old]


def test_upgrade_copies_every_watch_and_drops_the_old_table(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0115")
    with psycopg.connect(sync, autocommit=True) as conn:
        ids = _seed(conn)
        old = _old_watches(conn, ids)
        # a watch on something else, which the move leaves alone
        initiative = _one(conn, "INSERT INTO initiatives (name, initiative_type) "
                                "VALUES ('Initiative A', 'move') RETURNING id")
        elsewhere = _shared_row(conn, person=ids["person"], created_by=ids["person"],
                                initiative_id=initiative)
        assert _exists(conn, "wiki_watches") and _wiki_rows(conn) == []

    _alembic(throwaway_url, "upgrade", "0116")
    with psycopg.connect(sync, autocommit=True) as conn:
        # a library, a folder and a page for one person, and the page for another
        assert _wiki_rows(conn) == _as_shared(old)
        assert [row[3:5] for row in _wiki_rows(conn)] == [
            (ids["space"], None), (None, ids["folder"]), (None, ids["page"]),
            (None, ids["page"])]
        assert [row[0] for row in conn.execute(
            "SELECT id FROM notification_watches WHERE initiative_id IS NOT NULL")] == [elsewhere]
        assert _one(conn, "SELECT count(*) FROM notification_watches") == 5

        # the table and everything of its own is gone
        assert not _exists(conn, "wiki_watches")
        assert not any(_exists(conn, index) for index in OLD_INDEXES)
        assert _one(conn, "SELECT count(*) FROM pg_constraint WHERE conname = %s",
                    (OLD_CHECK,)) == 0


def test_upgrade_leaves_a_watch_the_shared_table_already_has(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0115")
    with psycopg.connect(sync, autocommit=True) as conn:
        ids = _seed(conn)
        old = _old_watches(conn, ids)
        # Person A already watches the folder in the shared table (made by someone else, later)
        already = _shared_row(conn, person=ids["person"], created_by=ids["other"],
                              created_at=T5, wiki_node_id=ids["folder"])

    _alembic(throwaway_url, "upgrade", "0116")
    with psycopg.connect(sync, autocommit=True) as conn:
        rows = _wiki_rows(conn)
        # the upgrade finished, with one row per person and target: the one that was there
        # stays as it was and the other three come across
        copied = _as_shared([watch for watch in old if watch[3] != ids["folder"]])
        assert rows == [*copied, (already, ids["person"], None, None, ids["folder"], [],
                                  ids["other"], T5)]
        assert not _exists(conn, "wiki_watches")


def test_downgrade_puts_the_old_table_back_exactly(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0115")
    with psycopg.connect(sync, autocommit=True) as conn:
        before = _shape(conn, "wiki_watches")
    # not an empty comparison: the table, its check, its three indexes and its keys
    assert [column[0] for column in before["columns"]] == [
        "id", "person_id", "space_id", "node_id", "created_at"]
    assert set(before["indexes"]) == {"wiki_watches_pkey", *OLD_INDEXES}
    assert {"wiki_watches_pkey", OLD_CHECK, "wiki_watches_person_id_fkey",
            "wiki_watches_space_id_fkey", "wiki_watches_node_id_fkey"} <= set(
        before["constraints"])

    _alembic(throwaway_url, "upgrade", "0116")
    _alembic(throwaway_url, "downgrade", "0115")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _shape(conn, "wiki_watches") == before


def test_downgrade_restores_the_person_watches_and_drops_the_rest(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0115")
    with psycopg.connect(sync, autocommit=True) as conn:
        ids = _seed(conn)
        old = _old_watches(conn, ids)
    _alembic(throwaway_url, "upgrade", "0116")

    with psycopg.connect(sync, autocommit=True) as conn:
        # in the shared table since: a person's watch on the library (and the group's on the
        # folder and the page, which the old table has no place for), and watches on other
        # things that are not the wiki's to give back
        added = _shared_row(conn, person=ids["other"], created_by=ids["other"], created_at=T5,
                            wiki_space_id=ids["space"])
        group = _one(conn, "INSERT INTO notification_groups (name) VALUES ('Group A') "
                           "RETURNING id")
        _shared_row(conn, group=group, wiki_node_id=ids["folder"])
        _shared_row(conn, group=group, wiki_node_id=ids["page"])
        initiative = _one(conn, "INSERT INTO initiatives (name, initiative_type) "
                                "VALUES ('Initiative A', 'move') RETURNING id")
        elsewhere = _shared_row(conn, person=ids["person"], initiative_id=initiative)
        everything = _one(conn, "INSERT INTO notification_watches (group_id, kinds) "
                                "VALUES (%s, '{kind_a}') RETURNING id", (group,))
        assert len(_wiki_rows(conn)) == 7

    _alembic(throwaway_url, "downgrade", "0115")
    with psycopg.connect(sync, autocommit=True) as conn:
        # every person's watch is back, with its id and created time; the group's are not
        restored = conn.execute(
            "SELECT id, person_id, space_id, node_id, created_at FROM wiki_watches "
            "ORDER BY created_at, id").fetchall()
        assert restored == [*old, (added, ids["other"], ids["space"], None, T5)]
        # and none of the wiki's are left in the shared table, nor anything of anyone else's
        assert _wiki_rows(conn) == []
        assert {row[0] for row in conn.execute("SELECT id FROM notification_watches")} == {
            elsewhere, everything}


def test_upgrading_again_is_clean(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0115")
    with psycopg.connect(sync, autocommit=True) as conn:
        ids = _seed(conn)
        old = _old_watches(conn, ids)
    _alembic(throwaway_url, "upgrade", "0116")
    with psycopg.connect(sync, autocommit=True) as conn:
        group = _one(conn, "INSERT INTO notification_groups (name) VALUES ('Group A') "
                           "RETURNING id")
        _shared_row(conn, group=group, wiki_node_id=ids["folder"])
    _alembic(throwaway_url, "downgrade", "0115")
    _alembic(throwaway_url, "upgrade", "0116")

    with psycopg.connect(sync, autocommit=True) as conn:
        # the same watches as the first time, no more (the group's did not come back), and the
        # old table gone again
        assert _wiki_rows(conn) == _as_shared(old)
        assert not _exists(conn, "wiki_watches")
        assert _one(conn, "SELECT count(*) FROM notification_watches") == 4


def test_the_older_wiki_downgrades_still_run_over_the_restored_table(throwaway_url):
    """0077 drops two of the table's indexes and 0075 the third and the table, so rolling
    0116 back has to leave all of them for those to find."""
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0116")
    with psycopg.connect(sync, autocommit=True) as conn:
        ids = _seed(conn)
        _shared_row(conn, person=ids["person"], created_by=ids["person"], created_at=T1,
                    wiki_node_id=ids["folder"])
    _alembic(throwaway_url, "downgrade", "0074")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert not _exists(conn, "wiki_watches")
        assert not any(_exists(conn, index) for index in OLD_INDEXES)
    _alembic(throwaway_url, "upgrade", "0116")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert not _exists(conn, "wiki_watches")
        assert _one(conn, "SELECT count(*) FROM wiki_spaces") == 1
