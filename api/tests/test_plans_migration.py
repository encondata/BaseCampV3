"""Migration 0117: the project-plan tables, the `project_plans` permission
resource and its grants, and the Project plan PDF's report definition.

The rollback/upgrade round trip runs on a throwaway database
(`<SS_TEST_DB>_m0117`) so the shared test DB stays at head; the constraint
tests use the regular test DB through the `db` fixture."""

import os
import re
import uuid
from datetime import datetime

import psycopg
import pytest
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError

from serversherpa.config import get_settings
from tests.test_migration_0099_kiosk_config import _alembic

THROWAWAY_DB = os.environ.get("SS_TEST_DB", "serversherpa_test") + "_m0117"

TABLES = ("project_plans", "plan_tasks", "plan_links", "plan_assignments",
          "plan_reminder_log", "plan_templates")
INDEXES = ("plan_tasks_plan_position_idx", "plan_tasks_parent_idx",
           "plan_links_plan_idx", "plan_tasks_open_deadline_idx",
           "plan_assignments_task_person_uniq", "plan_assignments_task_partner_uniq",
           "plan_links_successor_idx", "plan_assignments_task_idx",
           "plan_assignments_person_idx", "plan_assignments_partner_idx",
           "plan_reminder_log_person_idx", "plan_tasks_completed_by_idx",
           "plan_tasks_created_by_idx", "plan_tasks_updated_by_idx")
# what a cascading delete looks rows up by: the FK trigger's
# `DELETE ... WHERE col = $1` can use neither a partial index nor one that
# leads with another column. Index -> its columns (and predicate).
FK_INDEXES = {
    "plan_links_successor_idx": "(successor_id)",
    "plan_assignments_task_idx": "(task_id)",
    "plan_assignments_person_idx": "(person_id) WHERE (person_id IS NOT NULL)",
    "plan_assignments_partner_idx": "(partner_id) WHERE (partner_id IS NOT NULL)",
    "plan_reminder_log_person_idx": "(person_id)",
    # a person delete nulls these on every task they touched (ON DELETE SET NULL)
    "plan_tasks_completed_by_idx": "(completed_by) WHERE (completed_by IS NOT NULL)",
    "plan_tasks_created_by_idx": "(created_by) WHERE (created_by IS NOT NULL)",
    "plan_tasks_updated_by_idx": "(updated_by) WHERE (updated_by IS NOT NULL)",
}
# the per-row tables: every foreign key on them must lead an index a delete
# (or a SET NULL) on the referenced row can use. project_plans and
# plan_templates hold a row per initiative / template, so a scan is cheaper
# than an index there and they are left out.
PER_ROW_TABLES = ("plan_tasks", "plan_links", "plan_assignments", "plan_reminder_log")
FULL = {"view", "add", "change", "delete"}
GRANTED_ROLES = ("developer", "founder", "super_admin", "admin")


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
        "WHERE table_schema = 'public' AND table_name = ANY(%s)", (list(TABLES),))}
    indexes = {r[0] for r in conn.execute(
        "SELECT indexname FROM pg_indexes WHERE indexname = ANY(%s)", (list(INDEXES),))}
    color = conn.execute(
        "SELECT c.data_type, c.is_nullable, pg_get_constraintdef(k.oid) "
        "FROM information_schema.columns c LEFT JOIN pg_constraint k "
        "ON k.conname = 'plan_tasks_color_check' "
        "WHERE c.table_name = 'plan_tasks' AND c.column_name = 'color'").fetchone()
    return {
        "tables": tables,
        "indexes": indexes,
        "color": color and tuple(color),
        # the "Project plan" PDF's system report definition, and its runs
        "definitions": [tuple(r) for r in conn.execute(
            "SELECT name, report_type, options, is_system FROM report_definitions "
            "WHERE report_type = 'project_plan'")],
        "plan_runs": conn.execute(
            "SELECT count(*) FROM report_runs WHERE report_type = 'project_plan'").fetchone()[0],
        "grants": {role: {r[0] for r in conn.execute(
            "SELECT action FROM role_permissions "
            "WHERE role = %s AND resource = 'project_plans'", (role,))}
            for role in (*GRANTED_ROLES, "staff", "worker", "learning_admin")},
    }


def _seed_plan(conn) -> dict:
    """One row in every plan table, so the downgrade has data to drop."""
    person = conn.execute(
        "INSERT INTO people (first_name, last_name) VALUES ('Pat', 'Tester') "
        "RETURNING id").fetchone()[0]
    initiative = conn.execute(
        "INSERT INTO initiatives (name, initiative_type) VALUES ('Move', 'move') "
        "RETURNING id").fetchone()[0]
    plan = conn.execute(
        "INSERT INTO project_plans (initiative_id, timezone, project_start, calendar) "
        "VALUES (%s, 'America/New_York', '2026-11-02 08:00', '{}'::jsonb) "
        "RETURNING id", (initiative,)).fetchone()[0]
    a, b = [conn.execute(
        "INSERT INTO plan_tasks (plan_id, position, name) VALUES (%s, %s, %s) "
        "RETURNING id", (plan, i, n)).fetchone()[0] for i, n in enumerate("AB")]
    conn.execute("INSERT INTO plan_links (plan_id, predecessor_id, successor_id) "
                 "VALUES (%s, %s, %s)", (plan, a, b))
    conn.execute("INSERT INTO plan_assignments (task_id, person_id) VALUES (%s, %s)",
                 (a, person))
    conn.execute("INSERT INTO plan_reminder_log (task_id, person_id, stage, due_at) "
                 "VALUES (%s, %s, 'd3', '2026-11-05 08:00')", (a, person))
    conn.execute("INSERT INTO plan_templates (name, data) VALUES ('Standard move', '{}'::jsonb)")
    # a run of the seeded Project plan report: the downgrade deletes it
    # before its definition (report_runs.definition_id doesn't cascade)
    conn.execute(
        "INSERT INTO report_runs (definition_id, report_type, initiative_id, requested_by) "
        "SELECT id, 'project_plan', %s, %s FROM report_definitions "
        "WHERE report_type = 'project_plan'", (initiative, person))
    return {"person": person, "plan": plan}


def test_downgrade_and_upgrade_again(throwaway_url):
    _alembic(throwaway_url, "upgrade", "head")
    sync = throwaway_url.set(drivername="postgresql").render_as_string(hide_password=False)
    with psycopg.connect(sync, autocommit=True) as conn:
        up = _state(conn)
        assert up["tables"] == set(TABLES)
        assert up["indexes"] == set(INDEXES)
        # a task's color: optional, lower-case #rrggbb
        assert up["color"] == ("text", "YES", "CHECK ((color ~ '^#[0-9a-f]{6}$'::text))")
        assert up["definitions"] == [("Project plan", "project_plan", {}, True)]
        for role in GRANTED_ROLES:
            assert up["grants"][role] == FULL, role
        # nothing for staff or below, and the learning_admin role is untouched
        assert up["grants"]["staff"] == set()
        assert up["grants"]["worker"] == set()
        assert up["grants"]["learning_admin"] == set()
        # data the downgrade has to clear first
        _seed_plan(conn)
        assert _state(conn)["plan_runs"] == 1

    _alembic(throwaway_url, "downgrade", "0116")
    with psycopg.connect(sync, autocommit=True) as conn:
        down = _state(conn)
        assert down["tables"] == set()
        assert down["indexes"] == set()
        assert down["color"] is None
        assert down["definitions"] == []
        assert down["plan_runs"] == 0
        assert all(grants == set() for grants in down["grants"].values())

    _alembic(throwaway_url, "upgrade", "head")
    with psycopg.connect(sync, autocommit=True) as conn:
        assert _state(conn) == up


def test_models_declare_every_index():
    """The ORM models name the indexes the migration creates (the ones
    behind a constraint aside: the models declare those as constraints)."""
    from serversherpa.db.models import Base

    declared = {ix.name for table in TABLES for ix in Base.metadata.tables[table].indexes}
    assert declared == set(INDEXES)


async def test_a_delete_finds_dependent_rows_by_index(db):
    """Deleting a task (or a person) finds its links, assignments and
    reminder rows through an index, not a scan of every plan's rows."""
    rows = dict((await db.execute(text(
        "SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY(:n)"),
        {"n": list(FK_INDEXES)})).all())
    assert set(rows) == set(FK_INDEXES)
    for name, columns in FK_INDEXES.items():
        assert rows[name].endswith(f"USING btree {columns}"), rows[name]


async def test_every_per_row_foreign_key_leads_an_index(db):
    """A guard for the next column: each FK on a per-row plan table has a
    btree index leading with it (a partial `IS NOT NULL` one is fine, since
    the FK trigger's `col = $1` implies it)."""
    fks = (await db.execute(text(
        "SELECT c.conrelid::regclass::text, a.attname "
        "FROM pg_constraint c JOIN pg_attribute a "
        "ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey) "
        "WHERE c.contype = 'f' AND c.conrelid::regclass::text = ANY(:t)"),
        {"t": list(PER_ROW_TABLES)})).all()
    # 13 today: plan_id, parent_id and three person audit columns on
    # plan_tasks; plan_id, predecessor_id, successor_id on plan_links;
    # task_id, person_id, partner_id on plan_assignments; task_id, person_id
    # on plan_reminder_log
    assert len(fks) >= 13, sorted(fks)
    defs = (await db.execute(text(
        "SELECT tablename, indexdef FROM pg_indexes WHERE tablename = ANY(:t)"),
        {"t": list(PER_ROW_TABLES)})).all()
    missing = []
    for table, column in fks:
        lead = re.compile(rf"USING btree \({column}[,)]")
        usable = re.compile(rf"WHERE \({column} IS NOT NULL\)$")
        if not any(t == table and lead.search(d) and (" WHERE " not in d or usable.search(d))
                   for t, d in defs):
            missing.append((table, column))
    assert not missing, f"foreign keys without a leading index: {missing}"


async def _initiative(db):
    return await db.scalar(text(
        "INSERT INTO initiatives (name, initiative_type) VALUES (:n, 'move') RETURNING id"),
        {"n": f"init-{uuid.uuid4()}"})


async def _plan_with_tasks(db, count=2):
    initiative = await _initiative(db)
    plan = await db.scalar(text(
        "INSERT INTO project_plans (initiative_id, timezone, project_start, calendar) "
        "VALUES (:i, 'America/New_York', '2026-11-02 08:00', '{}'::jsonb) RETURNING id"),
        {"i": initiative})
    tasks = [await db.scalar(text(
        "INSERT INTO plan_tasks (plan_id, position, name) VALUES (:p, :pos, :n) "
        "RETURNING id"), {"p": plan, "pos": i, "n": f"Task {i}"}) for i in range(count)]
    return initiative, plan, tasks


async def test_task_check_constraints(db):
    _, plan, (a, _b) = await _plan_with_tasks(db)
    person = await db.scalar(text(
        "INSERT INTO people (first_name, last_name) VALUES ('Pat', 'Tester') RETURNING id"))
    partner = await db.scalar(text(
        "INSERT INTO partners (name) VALUES ('Acme Freight') "
        "RETURNING id"))
    await db.commit()

    # percent_complete is 0..100
    for bad in (101, -1):
        with pytest.raises(IntegrityError):
            await db.execute(text("UPDATE plan_tasks SET percent_complete = :v WHERE id = :t"),
                             {"v": bad, "t": a})
        await db.rollback()
    await db.execute(text("UPDATE plan_tasks SET percent_complete = 100 WHERE id = :t"),
                     {"t": a})
    await db.commit()

    # an assignment names exactly one resource
    with pytest.raises(IntegrityError):
        await db.execute(text(
            "INSERT INTO plan_assignments (task_id, person_id, partner_id) "
            "VALUES (:t, :p, :q)"), {"t": a, "p": person, "q": partner})
    await db.rollback()
    with pytest.raises(IntegrityError):
        await db.execute(text("INSERT INTO plan_assignments (task_id) VALUES (:t)"), {"t": a})
    await db.rollback()

    # a task cannot be linked to itself
    with pytest.raises(IntegrityError):
        await db.execute(text(
            "INSERT INTO plan_links (plan_id, predecessor_id, successor_id) "
            "VALUES (:p, :t, :t)"), {"p": plan, "t": a})
    await db.rollback()


@pytest.mark.parametrize("column, bad", [
    ("mode", "semi"), ("duration_unit", "y"), ("constraint_type", "alap"),
    ("conflict", "other"), ("duration_minutes", -1),
    ("color", "#1E88E5"), ("color", "blue"), ("color", "#1e88e5x"), ("color", "#1e88e"),
])
async def test_task_enum_checks(db, column, bad):
    _, _plan, (a, _b) = await _plan_with_tasks(db)
    await db.commit()
    with pytest.raises(IntegrityError):
        await db.execute(text(f"UPDATE plan_tasks SET {column} = :v WHERE id = :t"),
                         {"v": bad, "t": a})
    await db.rollback()


async def test_task_defaults_and_conflict_values(db):
    _, _plan, (a, _b) = await _plan_with_tasks(db)
    await db.commit()
    row = (await db.execute(text(
        "SELECT mode, duration_minutes, duration_unit, elapsed, constraint_type, "
        "percent_complete, is_milestone, is_critical, conflict, parent_id "
        "FROM plan_tasks WHERE id = :t"), {"t": a})).one()
    assert tuple(row) == ("auto", 0, "d", False, "asap", 0, False, False, None, None)
    for ok in ("link", "constraint", None):
        await db.execute(text("UPDATE plan_tasks SET conflict = :v WHERE id = :t"),
                         {"v": ok, "t": a})
    await db.commit()
    assert await db.scalar(text("SELECT color FROM plan_tasks WHERE id = :t"), {"t": a}) is None
    for ok in ("#1e88e5", "#000000", None):
        await db.execute(text("UPDATE plan_tasks SET color = :v WHERE id = :t"),
                         {"v": ok, "t": a})
    await db.commit()


async def test_link_checks_and_uniqueness(db):
    _, plan, (a, b) = await _plan_with_tasks(db)
    sql = text("INSERT INTO plan_links (plan_id, predecessor_id, successor_id, link_type, "
               "lag_unit) VALUES (:p, :a, :b, :t, :u)")
    await db.execute(sql, {"p": plan, "a": a, "b": b, "t": "SS", "u": "h"})
    await db.commit()
    # one link per ordered pair, whatever its type
    with pytest.raises(IntegrityError):
        await db.execute(sql, {"p": plan, "a": a, "b": b, "t": "FS", "u": "d"})
    await db.rollback()
    # the reverse direction is a different pair (cycles are the engine's job)
    await db.execute(sql, {"p": plan, "a": b, "b": a, "t": "FF", "u": "mo"})
    await db.commit()
    for t, u in (("XX", "d"), ("fs", "d"), ("FS", "y")):
        c = await db.scalar(text(
            "INSERT INTO plan_tasks (plan_id, position, name) VALUES (:p, 9, 'C') RETURNING id"),
            {"p": plan})
        with pytest.raises(IntegrityError):
            await db.execute(sql, {"p": plan, "a": a, "b": c, "t": t, "u": u})
        await db.rollback()


async def test_assignment_unique_per_task_and_resource(db):
    _, _plan, (a, b) = await _plan_with_tasks(db)
    person = await db.scalar(text(
        "INSERT INTO people (first_name, last_name) VALUES ('Pat', 'Tester') RETURNING id"))
    partner = await db.scalar(text(
        "INSERT INTO partners (name) VALUES ('Acme Freight') "
        "RETURNING id"))
    by_person = text("INSERT INTO plan_assignments (task_id, person_id) VALUES (:t, :r)")
    by_partner = text("INSERT INTO plan_assignments (task_id, partner_id) VALUES (:t, :r)")
    await db.execute(by_person, {"t": a, "r": person})
    await db.execute(by_partner, {"t": a, "r": partner})
    await db.execute(by_person, {"t": b, "r": person})  # same person, another task
    await db.commit()
    for sql, rid in ((by_person, person), (by_partner, partner)):
        with pytest.raises(IntegrityError):
            await db.execute(sql, {"t": a, "r": rid})
        await db.rollback()


async def test_reminder_log_rearms_on_a_new_due_date(db):
    _, _plan, (a, _b) = await _plan_with_tasks(db)
    person = await db.scalar(text(
        "INSERT INTO people (first_name, last_name) VALUES ('Pat', 'Tester') RETURNING id"))
    sql = text("INSERT INTO plan_reminder_log (task_id, person_id, stage, due_at) "
               "VALUES (:t, :p, :s, :d)")
    args = {"t": a, "p": person, "s": "d3", "d": datetime(2026, 11, 5, 17, 0)}  # noqa: DTZ001 (wall-clock)
    await db.execute(sql, args)
    await db.commit()
    with pytest.raises(IntegrityError):
        await db.execute(sql, args)
    await db.rollback()
    # the same stage for a moved due date is a new key
    await db.execute(sql, {**args, "d": datetime(2026, 11, 12, 17, 0)})  # noqa: DTZ001 (wall-clock)
    await db.commit()


async def test_one_plan_per_initiative_and_cascade(db):
    initiative, plan, (a, b) = await _plan_with_tasks(db)
    await db.commit()
    with pytest.raises(IntegrityError):
        await db.execute(text(
            "INSERT INTO project_plans (initiative_id, timezone, project_start, calendar) "
            "VALUES (:i, 'UTC', '2026-11-02 08:00', '{}'::jsonb)"), {"i": initiative})
    await db.rollback()

    # a subtask goes with its parent; everything goes with the initiative
    child = await db.scalar(text(
        "INSERT INTO plan_tasks (plan_id, parent_id, position, name) "
        "VALUES (:p, :a, 5, 'Child') RETURNING id"), {"p": plan, "a": a})
    await db.execute(text("INSERT INTO plan_links (plan_id, predecessor_id, successor_id) "
                          "VALUES (:p, :c, :b)"), {"p": plan, "c": child, "b": b})
    await db.commit()
    await db.execute(text("DELETE FROM plan_tasks WHERE id = :a"), {"a": a})
    await db.commit()
    assert await db.scalar(text("SELECT count(*) FROM plan_tasks WHERE id = :c"),
                           {"c": child}) == 0
    assert await db.scalar(text("SELECT count(*) FROM plan_links")) == 0
    await db.execute(text("DELETE FROM initiatives WHERE id = :i"), {"i": initiative})
    await db.commit()
    assert await db.scalar(text("SELECT count(*) FROM project_plans")) == 0
    assert await db.scalar(text("SELECT count(*) FROM plan_tasks")) == 0


async def test_parent_fk_is_checked_at_commit(db):
    """A task may name a parent inserted later in the same transaction (an
    ops batch flushes UPDATEs before INSERTs); a parent that never comes
    still fails, at COMMIT."""
    row = await db.execute(text(
        "SELECT condeferrable, condeferred, confdeltype::text FROM pg_constraint "
        "WHERE conname = 'plan_tasks_parent_id_fkey'"))
    assert tuple(row.one()) == (True, True, "c")

    _initiative, plan, (a, _b) = await _plan_with_tasks(db)
    await db.commit()
    later = uuid.uuid4()
    await db.execute(text("UPDATE plan_tasks SET parent_id = :l WHERE id = :a"),
                     {"l": later, "a": a})
    await db.execute(text("INSERT INTO plan_tasks (id, plan_id, position, name) "
                          "VALUES (:l, :p, 9, 'Later')"), {"l": later, "p": plan})
    await db.commit()
    assert await db.scalar(text("SELECT parent_id FROM plan_tasks WHERE id = :a"),
                           {"a": a}) == later

    await db.execute(text("UPDATE plan_tasks SET parent_id = :n WHERE id = :a"),
                     {"n": uuid.uuid4(), "a": a})
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_template_names_are_unique_ignoring_case(db):
    sql = text("INSERT INTO plan_templates (name, data) VALUES (:n, '{}'::jsonb)")
    try:
        await db.execute(sql, {"n": "Data center move"})
        await db.commit()
        with pytest.raises(IntegrityError):
            await db.execute(sql, {"n": "DATA CENTER MOVE"})
        await db.rollback()
    finally:
        await db.execute(text("DELETE FROM plan_templates"))
        await db.commit()


async def test_wall_clock_columns_are_timezone_free(db):
    """Plan times are floating wall-clock times; only the audit columns are
    timestamptz. The ORM models must agree with the migration."""
    from serversherpa.db.models import Base

    wall = {
        "project_plans": {"project_start", "status_date"},
        "plan_tasks": {"start", "finish", "constraint_date", "deadline", "actual_start",
                       "actual_finish", "baseline_start", "baseline_finish"},
        "plan_reminder_log": {"due_at"},
    }
    audit = {
        "project_plans": {"locked_at", "baseline_set_at", "created_at", "updated_at"},
        "plan_tasks": {"completed_at", "created_at", "updated_at"},
        "plan_reminder_log": {"sent_at"},
        "plan_templates": {"created_at", "updated_at"},
    }
    rows = (await db.execute(text(
        "SELECT table_name, column_name, data_type FROM information_schema.columns "
        "WHERE table_name = ANY(:t)"), {"t": list(TABLES)})).all()
    in_db = {(t, c): d for t, c, d in rows}
    for table, columns in wall.items():
        for column in columns:
            assert in_db[(table, column)] == "timestamp without time zone", (table, column)
            assert Base.metadata.tables[table].c[column].type.timezone is False, (table, column)
    for table, columns in audit.items():
        for column in columns:
            assert in_db[(table, column)] == "timestamp with time zone", (table, column)
            assert Base.metadata.tables[table].c[column].type.timezone is True, (table, column)
    # and nothing else in these tables is a timestamp we have not classified
    classified = {(t, c) for group in (wall, audit) for t, cs in group.items() for c in cs}
    stray = {k for k, d in in_db.items() if d.startswith("timestamp")} - classified
    assert stray == set()


async def test_models_cover_every_column(db):
    """Each ORM model names exactly the columns the migration created."""
    from serversherpa.db.models import Base

    rows = (await db.execute(text(
        "SELECT table_name, column_name FROM information_schema.columns "
        "WHERE table_name = ANY(:t)"), {"t": list(TABLES)})).all()
    in_db: dict[str, set[str]] = {t: set() for t in TABLES}
    for table, column in rows:
        in_db[table].add(column)
    for table in TABLES:
        assert {c.name for c in Base.metadata.tables[table].columns} == in_db[table], table
