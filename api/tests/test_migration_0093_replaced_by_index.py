"""Migration 0093: auth_sessions.replaced_by is indexed, so the NO ACTION
self-reference check does not scan the table for every deleted session."""

from sqlalchemy import text


async def test_replaced_by_is_indexed(db):
    defs = (await db.execute(text(
        "SELECT indexdef FROM pg_indexes "
        "WHERE tablename = 'auth_sessions' AND indexname = 'auth_sessions_replaced_by_idx'"
    ))).scalars().all()
    assert len(defs) == 1
    assert "(replaced_by)" in defs[0]
