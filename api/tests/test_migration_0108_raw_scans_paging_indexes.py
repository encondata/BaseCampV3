"""Migration 0108: raw_scans is indexed for the server-paged Raw scans list —
(scanned_at DESC, id DESC) for the default newest-first order and its keyset
condition, (created_at DESC, id DESC) for sorting by Ingested."""

from sqlalchemy import text


async def _index_defs(db):
    return dict((await db.execute(text(
        "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'raw_scans'"
    ))).all())


async def test_raw_scans_has_the_paging_indexes(db):
    defs = await _index_defs(db)
    assert "(scanned_at DESC, id DESC)" in defs["raw_scans_scanned_at_id_idx"]
    assert "(created_at DESC, id DESC)" in defs["raw_scans_created_at_id_idx"]


async def test_the_older_indexes_are_untouched(db):
    defs = await _index_defs(db)
    assert {"raw_scans_scanned_at_idx", "raw_scans_scanned_value_idx",
            "raw_scans_match_attempted_idx"} <= set(defs)
