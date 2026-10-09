"""Migration 0094: the ON DELETE SET NULL references the history cleanup
relies on are indexed, so a purge does not scan the table per deleted row."""

import pytest
from sqlalchemy import text


@pytest.mark.parametrize("table,index,column", [
    ("email_outbox", "email_outbox_notification_idx", "notification_id"),
    ("spec_suggestions", "spec_suggestions_job_idx", "job_id"),
    ("report_runs", "report_runs_attachment_idx", "attachment_id"),
])
async def test_set_null_references_are_indexed(db, table, index, column):
    defs = (await db.execute(text(
        "SELECT indexdef FROM pg_indexes WHERE tablename = :t AND indexname = :i"),
        {"t": table, "i": index})).scalars().all()
    assert len(defs) == 1
    assert f"({column})" in defs[0]


def test_downgrade_drops_every_index_it_creates():
    from importlib.util import module_from_spec, spec_from_file_location
    from pathlib import Path
    from unittest.mock import patch

    path = (Path(__file__).resolve().parents[1]
            / "migrations/versions/0094_cleanup_set_null_indexes.py")
    spec = spec_from_file_location("migration_0094", path)
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)
    with patch.object(mod.op, "create_index") as create, \
            patch.object(mod.op, "drop_index") as drop:
        mod.upgrade()
        mod.downgrade()
    created = {c.args[0] for c in create.call_args_list}
    dropped = {c.args[0] for c in drop.call_args_list}
    assert "report_runs_attachment_idx" in created
    assert created == dropped
