"""The Move Report definition seeded by migration 0046 must stay in step
with the module that validates it: the JSON literal in the migration is
hand-written, so nothing else catches a key that drifted or a section that
was added to SECTION_KEYS but never seeded."""

import importlib.util
import json
from pathlib import Path

from serversherpa.reports import move_report

MIGRATION = (Path(__file__).resolve().parents[1]
             / "migrations" / "versions" / "0046_reports_and_inbox.py")


def _migration_module():
    spec = importlib.util.spec_from_file_location("_migration_0046", MIGRATION)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_seeded_move_report_options_match_the_module_defaults():
    seeded = json.loads(_migration_module().MOVE_REPORT_DEFAULTS)
    assert seeded == move_report.default_options()
    # and the validator accepts it untouched — no unknown key, nothing defaulted in
    assert move_report.validate_options(seeded) == seeded
