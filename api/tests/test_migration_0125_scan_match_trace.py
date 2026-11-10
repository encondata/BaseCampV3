"""Migration 0125: scans keep the matcher's trace and the kiosk's own match;
processed scans also keep the kiosk scan id, the reported checkpoint and the
move, and lose only the move when it is deleted."""

from sqlalchemy import text


async def _columns(db, table):
    return dict((await db.execute(text(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_name = :t"), {"t": table})).all())


async def test_raw_scans_has_the_trace_and_kiosk_match(db):
    cols = await _columns(db, "raw_scans")
    assert cols["kiosk_asset_id"] == "uuid"
    assert cols["match_trace"] == "jsonb"


async def test_processed_scans_keeps_the_whole_context(db):
    cols = await _columns(db, "processed_scans")
    assert cols["kiosk_asset_id"] == "uuid"
    assert cols["match_trace"] == "jsonb"
    assert cols["client_scan_id"] == "uuid"
    assert cols["scan_status"] == "text"
    assert cols["initiative_id"] == "uuid"


async def test_kiosk_asset_id_is_not_a_foreign_key_and_the_move_sets_null(db):
    fks = dict((await db.execute(text(
        "SELECT kcu.table_name || '.' || kcu.column_name, rc.delete_rule "
        "FROM information_schema.referential_constraints rc "
        "JOIN information_schema.key_column_usage kcu "
        "  ON kcu.constraint_name = rc.constraint_name "
        "WHERE kcu.table_name IN ('raw_scans', 'processed_scans')"))).all())
    assert "raw_scans.kiosk_asset_id" not in fks
    assert "processed_scans.kiosk_asset_id" not in fks
    assert fks["processed_scans.initiative_id"] == "SET NULL"
