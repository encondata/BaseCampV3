"""The Move Scan History definition seeded by migration 0054 must stay in
step with the module that validates it — same pattern as
test_report_seed.py (migration 0046 / Move Report) and
test_site_move_survey_fixtures.py (migration 0052 / Site & Move Survey):
the JSON literal in the migration is hand-written, so nothing else
catches a key that drifted from the module's own `default_options()`."""

import importlib.util
import json
from pathlib import Path

from sqlalchemy import text

from serversherpa.db.models import ReportDefinition
from serversherpa.reports import move_scan_history

MIGRATION = (Path(__file__).resolve().parents[1]
             / "migrations" / "versions" / "0054_move_scan_history.py")


def _migration_module():
    spec = importlib.util.spec_from_file_location("_migration_0054", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_seeded_move_scan_history_options_match_the_module_defaults():
    migration = _migration_module()
    seeded = json.loads(migration.DEFAULT_OPTIONS)
    assert seeded == move_scan_history.default_options()
    # and the validator accepts it untouched — no unknown key, nothing defaulted in
    assert move_scan_history.validate_options(seeded) == seeded


def test_migration_seeds_the_expected_definition_literals():
    migration = _migration_module()
    assert migration.DEFINITION_NAME == "Move Scan History"
    assert migration.REPORT_TYPE == "move_scan_history"
    assert json.loads(migration.DEFAULT_OPTIONS) == {
        "default_format": "xlsx", "status_columns": "pipeline"}


async def test_migration_insert_sql_seeds_and_is_idempotent(db):
    """Executes the migration's own INSERT_DEFINITION_SQL constant (the
    exact statement upgrade() runs) directly against the (freshly
    truncated) report_definitions table — proving it is valid SQL that
    seeds the right row, and that ON CONFLICT makes re-running it a
    no-op rather than a duplicate-key error — same shape as 0052's
    equivalent test."""
    migration = _migration_module()
    params = {"name": migration.DEFINITION_NAME, "description": migration.DEFINITION_DESCRIPTION,
              "report_type": migration.REPORT_TYPE, "options": migration.DEFAULT_OPTIONS}
    await db.execute(text(migration.INSERT_DEFINITION_SQL), params)
    await db.execute(text(migration.INSERT_DEFINITION_SQL), params)   # idempotent
    await db.commit()

    rows = (await db.execute(text(
        "SELECT report_type, options, is_system FROM report_definitions WHERE name = :name"),
        {"name": migration.DEFINITION_NAME})).all()
    assert len(rows) == 1, "ON CONFLICT should have prevented a duplicate row"
    report_type, options, is_system = rows[0]
    assert report_type == "move_scan_history" and is_system is True
    assert options == json.loads(migration.DEFAULT_OPTIONS)


async def test_migration_downgrade_deletes_the_definition(db):
    migration = _migration_module()
    db.add(ReportDefinition(name=migration.DEFINITION_NAME, report_type=migration.REPORT_TYPE,
                            description=migration.DEFINITION_DESCRIPTION,
                            options=json.loads(migration.DEFAULT_OPTIONS), is_system=True))
    await db.commit()

    await db.execute(text(migration.DELETE_DEFINITION_SQL), {"report_type": migration.REPORT_TYPE})
    await db.commit()

    remaining = await db.scalar(text(
        "SELECT count(*) FROM report_definitions WHERE report_type = :report_type"),
        {"report_type": migration.REPORT_TYPE})
    assert remaining == 0
