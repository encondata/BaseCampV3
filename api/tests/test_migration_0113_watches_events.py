"""Migration 0113 (notifications Phase 2, slice 1): the `notification_watches` and
`notification_events` tables, and `notification_groups.categories` dropped with its CHECK
(watches give a group its job, and the column named categories that are never watchable).

The shape at head is read on the shared test database. The CHECKs and the unique index, the
defaults, the deletes that follow a watch's links, the upgrade that drops the column and the
rollback that restores it run on a throwaway database (`<SS_TEST_DB>_m0113`) so the shared
one stays at head.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 1, 3 and 9)"""

import os
import uuid

import psycopg
import pytest
from sqlalchemy import CheckConstraint, text
from sqlalchemy.engine import make_url

from serversherpa.config import get_settings
from serversherpa.db.models import (
    NotificationEvent, NotificationGroup, NotificationWatch, Person,
)
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0113"

# the six things a watch can point at -> the table each column references
THINGS = {
    "initiative_id": "initiatives",
    "site_id": "sites",
    "truck_id": "trucks",
    "device_id": "devices",
    "wiki_space_id": "wiki_spaces",
    "wiki_node_id": "wiki_nodes",
}

# column -> (udt_name, is_nullable, column_default) as Postgres reports them
WATCH_COLUMNS = {
    "id": ("uuid", "NO", "gen_random_uuid()"),
    "person_id": ("uuid", "YES", None),
    "group_id": ("uuid", "YES", None),
    **{thing: ("uuid", "YES", None) for thing in THINGS},
    "kinds": ("_text", "NO", "'{}'::text[]"),
    "created_by": ("uuid", "YES", None),
    "created_at": ("timestamptz", "NO", "now()"),
}
EVENT_COLUMNS = {
    "id": ("int8", "NO", None),
    "kind": ("text", "NO", None),
    "subject_type": ("text", "NO", None),
    "subject_id": ("uuid", "NO", None),
    "reaches": ("jsonb", "NO", "'[]'::jsonb"),
    "actor_id": ("uuid", "YES", None),
    "person_ids": ("_uuid", "NO", "'{}'::uuid[]"),
    "group_ids": ("_uuid", "NO", "'{}'::uuid[]"),
    "watchers": ("bool", "NO", "true"),
    "rule_id": ("uuid", "YES", None),
    "item": ("jsonb", "NO", "'{}'::jsonb"),
    "created_at": ("timestamptz", "NO", "now()"),
    "sent_at": ("timestamptz", "YES", None),
}

SUBSCRIBER_CHECK = "ck_notification_watches_subscriber"
ONE_THING_CHECK = "ck_notification_watches_one_thing"
EVERYTHING_CHECK = "ck_notification_watches_everything_kinds"
UNIQUE_TARGET = "uq_notification_watches_target"

WATCH_CHECKS = {SUBSCRIBER_CHECK, ONE_THING_CHECK, EVERYTHING_CHECK}
WATCH_INDEXES = {
    UNIQUE_TARGET,
    "ix_notification_watches_group_id",
    *(f"ix_notification_watches_{thing}" for thing in THINGS),
}
EVENT_INDEXES = {"ix_notification_events_waiting", "ix_notification_events_sent_at"}

# the five categories migration 0109 left the group CHECK with
CATEGORIES_0109 = ["approvals", "reports", "wiki", "security", "learning"]


# ── the shape at head, on the shared database ──────────────────────

async def _columns(db, table) -> dict:
    rows = (await db.execute(text(
        "SELECT column_name, udt_name, is_nullable, column_default "
        "FROM information_schema.columns WHERE table_name = :t"), {"t": table})).all()
    return {name: (udt, nullable, default) for name, udt, nullable, default in rows}


async def _indexes(db, table) -> dict[str, str]:
    return dict((await db.execute(text(
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = :t"),
        {"t": table})).all())


async def _checks(db, table) -> list[str]:
    return sorted((await db.execute(text(
        "SELECT conname FROM pg_constraint "
        "WHERE conrelid = CAST(:t AS regclass) AND contype = 'c'"), {"t": table})).scalars())


async def test_notification_watches_columns(db):
    assert await _columns(db, "notification_watches") == WATCH_COLUMNS


async def test_notification_events_columns(db):
    assert await _columns(db, "notification_events") == EVENT_COLUMNS
    # the id is an identity, so the sweep reads the rows in the order they were announced
    assert await db.scalar(text(
        "SELECT is_identity FROM information_schema.columns "
        "WHERE table_name = 'notification_events' AND column_name = 'id'")) == "YES"


async def test_notification_watches_indexes(db):
    indexes = await _indexes(db, "notification_watches")
    assert set(indexes) == WATCH_INDEXES | {"notification_watches_pkey"}

    # one row per subscriber and thing, and NULLs count as equal: that is what makes a
    # second Everything watch collide
    unique = indexes[UNIQUE_TARGET]
    assert "CREATE UNIQUE INDEX" in unique and "NULLS NOT DISTINCT" in unique
    assert f"(person_id, group_id, {', '.join(THINGS)})" in unique

    assert "(group_id)" in indexes["ix_notification_watches_group_id"]
    assert "WHERE" not in indexes["ix_notification_watches_group_id"]
    # the fan-out looks a thing's watchers up through that thing's own partial index
    for thing in THINGS:
        definition = indexes[f"ix_notification_watches_{thing}"]
        assert f"({thing})" in definition, thing
        assert f"WHERE ({thing} IS NOT NULL)" in definition, thing


async def test_notification_events_indexes(db):
    indexes = await _indexes(db, "notification_events")
    assert set(indexes) == EVENT_INDEXES | {"notification_events_pkey"}
    # the sweep's read: the rows still waiting, in id order
    waiting = indexes["ix_notification_events_waiting"]
    assert "(id)" in waiting and "WHERE (sent_at IS NULL)" in waiting
    # and the retention delete
    assert "(sent_at)" in indexes["ix_notification_events_sent_at"]
    assert "WHERE" not in indexes["ix_notification_events_sent_at"]


async def test_notification_watches_names_its_checks(db):
    assert await _checks(db, "notification_watches") == sorted(WATCH_CHECKS)


async def test_a_group_has_no_categories_and_no_check_at_head(db):
    assert "categories" not in await _columns(db, "notification_groups")
    assert await _checks(db, "notification_groups") == []


def test_the_models_mirror_the_tables():
    assert {c.name for c in NotificationWatch.__table__.columns} == set(WATCH_COLUMNS)
    assert {c.name for c in NotificationEvent.__table__.columns} == set(EVENT_COLUMNS)
    assert "categories" not in {c.name for c in NotificationGroup.__table__.columns}
    watches = NotificationWatch.__table__
    assert {c.name for c in watches.constraints if isinstance(c, CheckConstraint)} == WATCH_CHECKS
    assert {i.name for i in watches.indexes} == WATCH_INDEXES
    assert {i.name for i in NotificationEvent.__table__.indexes} == EVENT_INDEXES


async def test_the_models_round_trip(db):
    person = Person(first_name="Person", last_name="A")
    group = NotificationGroup(name="Group A")
    db.add_all([person, group])
    await db.flush()
    initiative_id = await db.scalar(text(
        "INSERT INTO initiatives (name, initiative_type) VALUES ('Initiative A', 'move') "
        "RETURNING id"))
    reached = {"type": "site", "id": str(uuid.uuid4())}
    thing = NotificationWatch(person_id=person.id, initiative_id=initiative_id,
                              created_by=person.id)
    everything = NotificationWatch(group_id=group.id, kinds=["kind_a"])
    event = NotificationEvent(
        kind="kind_a", subject_type="initiative", subject_id=initiative_id, reaches=[reached],
        person_ids=[person.id], group_ids=[group.id], item={"title": "Title A"})
    db.add_all([thing, everything, event])
    await db.commit()
    for row in (thing, everything, event):
        await db.refresh(row)

    # a watch on a thing that names no events hears every event that applies
    assert (thing.kinds, thing.group_id, thing.initiative_id) == ([], None, initiative_id)
    assert thing.created_by == person.id and thing.created_at is not None
    assert (everything.kinds, everything.person_id, everything.initiative_id) == (
        ["kind_a"], None, None)
    assert event.id > 0
    assert (event.reaches, event.person_ids, event.group_ids, event.item) == (
        [reached], [person.id], [group.id], {"title": "Title A"})
    assert (event.watchers, event.actor_id, event.rule_id, event.sent_at) == (
        True, None, None, None)


# ── the checks, the defaults and the links, on a throwaway database ─

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


def _column_names(conn, table) -> set[str]:
    return {row[0] for row in conn.execute(
        "SELECT column_name FROM information_schema.columns WHERE table_name = %s", (table,))}


def _column_rules(conn, table, column) -> tuple:
    return conn.execute(
        "SELECT is_nullable, column_default FROM information_schema.columns "
        "WHERE table_name = %s AND column_name = %s", (table, column)).fetchone()


def _check_names(conn, table) -> list[str]:
    return sorted(row[0] for row in conn.execute(
        "SELECT conname FROM pg_constraint "
        "WHERE conrelid = %s::regclass AND contype = 'c'", (table,)))


def _exists(conn, table) -> bool:
    return _one(conn, "SELECT to_regclass(%s)", (table,)) is not None


def _seed(conn) -> dict:
    """Two people, a group and one of each thing a watch can point at, by column name."""
    ids = {
        "person": _one(conn, "INSERT INTO people (first_name, last_name) "
                             "VALUES ('Person', 'A') RETURNING id"),
        "other": _one(conn, "INSERT INTO people (first_name, last_name) "
                            "VALUES ('Person', 'B') RETURNING id"),
        "group": _one(conn, "INSERT INTO notification_groups (name) VALUES ('Group A') "
                            "RETURNING id"),
        "initiative_id": _one(conn, "INSERT INTO initiatives (name, initiative_type) "
                                    "VALUES ('Initiative A', 'move') RETURNING id"),
        "site_id": _one(conn, "INSERT INTO sites (name) VALUES ('Site A') RETURNING id"),
        "truck_id": _one(conn, "INSERT INTO trucks (name) VALUES ('Truck A') RETURNING id"),
        "device_id": _one(conn, "INSERT INTO devices (device_type, name) "
                                "VALUES ('kiosk', 'Device A') RETURNING id"),
        "wiki_space_id": _one(conn, "INSERT INTO wiki_spaces (key, name) "
                                    "VALUES ('space-a', 'Space A') RETURNING id"),
    }
    ids["wiki_node_id"] = _one(
        conn, "INSERT INTO wiki_nodes (space_id, kind, title) VALUES (%s, 'page', 'Page A') "
              "RETURNING id", (ids["wiki_space_id"],))
    return ids


def _watch(conn, *, person=None, group=None, kinds=(), created_by=None, **things):
    """Insert one watch and return its id. `things` maps thing columns to ids; none at all
    is an Everything watch."""
    values = {"person_id": person, "group_id": group, "kinds": list(kinds),
              "created_by": created_by, **things}
    return _one(
        conn, f"INSERT INTO notification_watches ({', '.join(values)}) "
              f"VALUES ({', '.join(['%s'] * len(values))}) RETURNING id", list(values.values()))


def _refused(conn, error, constraint, **watch):
    """The insert is refused by `error`, and by that constraint and no other."""
    with pytest.raises(error) as raised:
        _watch(conn, **watch)
    assert raised.value.diag.constraint_name == constraint


def test_watch_checks(throwaway_url):
    _alembic(throwaway_url, "upgrade", "0113")
    with psycopg.connect(_sync(throwaway_url), autocommit=True) as conn:
        ids = _seed(conn)
        person, other, group = ids["person"], ids["other"], ids["group"]
        initiative = ids["initiative_id"]

        # a person's watch on any one of the six things, naming no events (all that apply)
        for column in THINGS:
            _watch(conn, person=person, **{column: ids[column]})
        # the same initiative for another person and for a group: one row per subscriber
        _watch(conn, person=other, kinds=["kind_a"], initiative_id=initiative)
        _watch(conn, group=group, initiative_id=initiative)
        # an Everything watch names its events, and each subscriber has one
        _watch(conn, person=person, kinds=["kind_a"])
        _watch(conn, person=other, kinds=["kind_a"])
        _watch(conn, group=group, kinds=["kind_a"])
        assert _one(conn, "SELECT count(*) FROM notification_watches") == 11

        # exactly one subscriber (the rest is valid, so only this check can fire)
        _refused(conn, psycopg.errors.CheckViolation, SUBSCRIBER_CHECK,
                 person=person, group=group, initiative_id=initiative)
        _refused(conn, psycopg.errors.CheckViolation, SUBSCRIBER_CHECK,
                 initiative_id=initiative)
        # at most one thing
        _refused(conn, psycopg.errors.CheckViolation, ONE_THING_CHECK, person=other,
                 kinds=["kind_a"], initiative_id=initiative, site_id=ids["site_id"])
        # an Everything watch with no events would hear everything in the company
        _refused(conn, psycopg.errors.CheckViolation, EVERYTHING_CHECK, person=other)
        _refused(conn, psycopg.errors.CheckViolation, EVERYTHING_CHECK, group=group)

        # watching the same thing again is a unique violation, whatever the events
        _refused(conn, psycopg.errors.UniqueViolation, UNIQUE_TARGET,
                 person=person, kinds=["kind_a"], initiative_id=initiative)
        _refused(conn, psycopg.errors.UniqueViolation, UNIQUE_TARGET,
                 group=group, initiative_id=initiative)
        # and so is a second Everything watch for one person (NULLS NOT DISTINCT)
        _refused(conn, psycopg.errors.UniqueViolation, UNIQUE_TARGET,
                 person=person, kinds=["kind_b"])
        assert _one(conn, "SELECT count(*) FROM notification_watches") == 11


def test_deleting_a_subscriber_or_a_thing_deletes_its_watches(throwaway_url):
    _alembic(throwaway_url, "upgrade", "0113")
    with psycopg.connect(_sync(throwaway_url), autocommit=True) as conn:
        ids = _seed(conn)
        person, creator, group = ids["person"], ids["other"], ids["group"]

        def left() -> set:
            return {row[0] for row in conn.execute("SELECT id FROM notification_watches")}

        # Person A watches each thing; Group A watches the initiative and, with events
        # named, everything. Person B made all of them.
        pointing_at = {
            column: {_watch(conn, person=person, created_by=creator, **{column: ids[column]})}
            for column in THINGS}
        pointing_at["initiative_id"].add(
            _watch(conn, group=group, created_by=creator, initiative_id=ids["initiative_id"]))
        group_everything = _watch(conn, group=group, created_by=creator, kinds=["kind_a"])

        # a thing takes its watches with it, whoever's they are (a page before its library)
        remaining = {watch for watches in pointing_at.values() for watch in watches}
        remaining.add(group_everything)
        for column in reversed(THINGS):
            conn.execute(f"DELETE FROM {THINGS[column]} WHERE id = %s", (ids[column],))
            remaining -= pointing_at[column]
            assert left() == remaining, column
        assert remaining == {group_everything}

        # a group takes its watches with it
        conn.execute("DELETE FROM notification_groups WHERE id = %s", (group,))
        assert left() == set()

        # the person who made a watch is only a record: their deletion clears the link and
        # keeps the watch, and its subscriber's deletion removes it
        mine = _watch(conn, person=person, created_by=creator, kinds=["kind_a"])
        conn.execute("DELETE FROM people WHERE id = %s", (creator,))
        assert left() == {mine}
        assert _one(conn, "SELECT created_by FROM notification_watches WHERE id = %s",
                    (mine,)) is None
        conn.execute("DELETE FROM people WHERE id = %s", (person,))
        assert left() == set()


def test_event_defaults(throwaway_url):
    _alembic(throwaway_url, "upgrade", "0113")
    with psycopg.connect(_sync(throwaway_url), autocommit=True) as conn:
        subject = uuid.uuid4()
        announce = ("INSERT INTO notification_events (kind, subject_type, subject_id) "
                    "VALUES ('kind_a', 'initiative', %s) RETURNING id")
        first = _one(conn, announce, (subject,))
        assert conn.execute(
            "SELECT kind, subject_type, subject_id, reaches, actor_id, person_ids, group_ids, "
            "watchers, rule_id, item, sent_at, created_at IS NOT NULL "
            "FROM notification_events WHERE id = %s", (first,)).fetchone() == (
            "kind_a", "initiative", subject, [], None, [], [], True, None, {}, None, True)
        # the identity numbers the rows in the order they were announced
        assert _one(conn, announce, (subject,)) > first


def test_deleting_the_actor_or_the_rule_keeps_the_event(throwaway_url):
    _alembic(throwaway_url, "upgrade", "0113")
    with psycopg.connect(_sync(throwaway_url), autocommit=True) as conn:
        actor = _one(conn, "INSERT INTO people (first_name, last_name) "
                           "VALUES ('Person', 'A') RETURNING id")
        rule = _one(conn, "INSERT INTO status_rules (name, trigger_status, trigger_match_type) "
                          "VALUES ('Rule A', 'rfid_4_into_cage', 'asset') RETURNING id")
        event = _one(
            conn, "INSERT INTO notification_events "
                  "(kind, subject_type, subject_id, actor_id, rule_id) "
                  "VALUES ('kind_a', 'initiative', %s, %s, %s) RETURNING id",
            (uuid.uuid4(), actor, rule))

        def links() -> tuple:
            return conn.execute("SELECT actor_id, rule_id FROM notification_events "
                                "WHERE id = %s", (event,)).fetchone()

        assert links() == (actor, rule)
        conn.execute("DELETE FROM status_rules WHERE id = %s", (rule,))
        assert links() == (actor, None)
        conn.execute("DELETE FROM people WHERE id = %s", (actor,))
        assert links() == (None, None)


# ── the categories column, up and back ─────────────────────────────

def test_group_categories_dropped(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0112")
    with psycopg.connect(sync, autocommit=True) as conn:
        conn.execute("INSERT INTO notification_groups (name, description, enabled, categories) "
                     "VALUES ('Group A', 'Description A', false, '{wiki}')")
        # before: the column and its CHECK are there
        assert "categories" in _column_names(conn, "notification_groups")
        assert _check_names(conn, "notification_groups") == ["ck_notification_groups_categories"]

    _alembic(throwaway_url, "upgrade", "0113")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert "categories" not in _column_names(conn, "notification_groups")
        assert _check_names(conn, "notification_groups") == []
        # the group survives with everything else it had
        assert conn.execute(
            "SELECT name, description, enabled FROM notification_groups").fetchall() == [
            ("Group A", "Description A", False)]
        # and a new one is just a name
        conn.execute("INSERT INTO notification_groups (name) VALUES ('Group B')")


def test_downgrade_restores(throwaway_url):
    sync = _sync(throwaway_url)
    _alembic(throwaway_url, "upgrade", "0113")
    with psycopg.connect(sync, autocommit=True) as conn:
        ids = _seed(conn)
        # rows in both tables: the rollback drops them with the tables
        _watch(conn, person=ids["person"], initiative_id=ids["initiative_id"])
        conn.execute("INSERT INTO notification_events (kind, subject_type, subject_id) "
                     "VALUES ('kind_a', 'initiative', %s)", (ids["initiative_id"],))

    _alembic(throwaway_url, "downgrade", "0112")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert not _exists(conn, "notification_watches")
        assert not _exists(conn, "notification_events")
        # the column is back as 0092 made it: NOT NULL, empty by default, empty for the
        # group that was already there
        assert _column_rules(conn, "notification_groups", "categories") == (
            "NO", "'{}'::text[]")
        assert conn.execute("SELECT categories FROM notification_groups").fetchall() == [([],)]
        # and its CHECK takes the five categories of 0109 and nothing else
        conn.execute("UPDATE notification_groups SET categories = '{wiki}'")
        conn.execute("UPDATE notification_groups SET categories = %s", (CATEGORIES_0109,))
        assert _check_names(conn, "notification_groups") == ["ck_notification_groups_categories"]
        with pytest.raises(psycopg.errors.CheckViolation) as raised:
            conn.execute("UPDATE notification_groups SET categories = '{nope}'")
        assert raised.value.diag.constraint_name == "ck_notification_groups_categories"

    # and forward again
    _alembic(throwaway_url, "upgrade", "0113")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _exists(conn, "notification_watches") and _exists(conn, "notification_events")
        assert "categories" not in _column_names(conn, "notification_groups")
        assert _check_names(conn, "notification_groups") == []
