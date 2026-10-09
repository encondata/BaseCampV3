"""Migration 0094: the ON DELETE SET NULL references the history cleanup
relies on are indexed, so a purge does not scan the table per deleted row."""

import pytest
from sqlalchemy import text


@pytest.mark.parametrize("table,index,column", [
    ("email_outbox", "email_outbox_notification_idx", "notification_id"),
    ("spec_suggestions", "spec_suggestions_job_idx", "job_id"),
])
async def test_set_null_references_are_indexed(db, table, index, column):
    defs = (await db.execute(text(
        "SELECT indexdef FROM pg_indexes WHERE tablename = :t AND indexname = :i"),
        {"t": table, "i": index})).scalars().all()
    assert len(defs) == 1
    assert f"({column})" in defs[0]
