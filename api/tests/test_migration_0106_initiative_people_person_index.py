"""Migration 0106: initiative_people is indexed on (person_id, created_at
DESC), so a worker's newest jobs (the Rolodex's "Previous jobs", capped at
50, and the portal's worker history) are read from the index, not by
scanning every membership."""

from sqlalchemy import text


async def test_a_workers_jobs_are_indexed_newest_first(db):
    defs = (await db.execute(text(
        "SELECT indexdef FROM pg_indexes "
        "WHERE tablename = 'initiative_people' AND indexname = 'initiative_people_person_created_idx'"
    ))).scalars().all()
    assert len(defs) == 1
    assert "(person_id, created_at DESC)" in defs[0]
