"""The Timesheet definition seeded by migration 0090 must stay in step with
the module that validates it (same pattern as test_move_scan_history_seed.py)."""

import importlib.util
import json
from pathlib import Path

from sqlalchemy import text

from serversherpa.db.models import ReportDefinition
from serversherpa.reports import timesheet

MIGRATION = (Path(__file__).resolve().parents[1]
             / "migrations" / "versions" / "0090_timesheet_report.py")


def _migration_module():
    spec = importlib.util.spec_from_file_location("_migration_0090", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_revision_chain():
    m = _migration_module()
    assert m.revision == "0090" and m.down_revision == "0089"


def test_seeded_timesheet_options_match_the_module_defaults():
    migration = _migration_module()
    seeded = json.loads(migration.DEFAULT_OPTIONS)
    assert seeded == timesheet.default_options()
    assert timesheet.validate_options(seeded) == seeded


def test_migration_seeds_the_expected_definition_literals():
    migration = _migration_module()
    assert migration.DEFINITION_NAME == "Timesheet"
    assert migration.REPORT_TYPE == "timesheet"
    assert migration.DEFINITION_DESCRIPTION == (
        "Hours worked by person and job over a date range, with a day view, "
        "every punch and verification flags, as Excel or PDF.")


async def test_migration_insert_sql_seeds_and_is_idempotent(db):
    migration = _migration_module()
    params = {"name": migration.DEFINITION_NAME,
              "description": migration.DEFINITION_DESCRIPTION,
              "report_type": migration.REPORT_TYPE,
              "options": migration.DEFAULT_OPTIONS}
    await db.execute(text(migration.INSERT_DEFINITION_SQL), params)
    await db.execute(text(migration.INSERT_DEFINITION_SQL), params)
    await db.commit()

    rows = (await db.execute(text(
        "SELECT report_type, options, is_system FROM report_definitions WHERE name = :name"),
        {"name": migration.DEFINITION_NAME})).all()
    assert len(rows) == 1
    report_type, options, is_system = rows[0]
    assert report_type == "timesheet" and is_system is True
    assert options == json.loads(migration.DEFAULT_OPTIONS)


async def test_migration_downgrade_deletes_the_definition(db):
    migration = _migration_module()
    db.add(ReportDefinition(name=migration.DEFINITION_NAME,
                            report_type=migration.REPORT_TYPE,
                            description=migration.DEFINITION_DESCRIPTION,
                            options=json.loads(migration.DEFAULT_OPTIONS),
                            is_system=True))
    await db.commit()
    await db.execute(text(migration.DELETE_DEFINITION_SQL),
                     {"report_type": migration.REPORT_TYPE})
    await db.commit()
    remaining = await db.scalar(text(
        "SELECT count(*) FROM report_definitions WHERE report_type = :report_type"),
        {"report_type": migration.REPORT_TYPE})
    assert remaining == 0
