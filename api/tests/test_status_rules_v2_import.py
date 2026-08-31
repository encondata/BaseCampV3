"""V2 process-engine rule import: translation, skip/partial reporting,
idempotent upsert, enabled preservation, and an end-to-end run through
the worker. Fixture rows are verbatim from backup_20260825_193157.sql
(timestamps shortened)."""

from datetime import UTC, datetime

from sqlalchemy import select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, ProcessedScan, RawScan, StatusRule,
)
from serversherpa.scans import worker
from serversherpa.status_rules.engine import invalidate_cache
from serversherpa.status_rules.v2_import import import_rules

FIXTURE = """
INSERT INTO status_options (id, status_name, association_type, sort_order, process_order, color, metadata, created_at, updated_at, list_in_dropdown, process_type, description) VALUES (9, 'RFID 1 - Cage Exit', 'Assets', 9, 9, '#31F527', NULL, '2025-10-13T00:00:00+00:00', '2025-10-13T00:00:00+00:00', NULL, NULL, NULL);
INSERT INTO status_options (id, status_name, association_type, sort_order, process_order, color, metadata, created_at, updated_at, list_in_dropdown, process_type, description) VALUES (19, 'RFID 4 - Into Cage', 'Assets', 19, 19, '#f5297a', NULL, '2025-10-13T00:00:00+00:00', '2025-10-13T00:00:00+00:00', NULL, NULL, NULL);
INSERT INTO status_options (id, status_name, association_type, sort_order, process_order, color, metadata, created_at, updated_at, list_in_dropdown, process_type, description) VALUES (13, 'In Container', 'Assets', 13, 13, '#888888', NULL, '2025-10-13T00:00:00+00:00', '2025-10-13T00:00:00+00:00', NULL, NULL, NULL);
INSERT INTO status_options (id, status_name, association_type, sort_order, process_order, color, metadata, created_at, updated_at, list_in_dropdown, process_type, description) VALUES (45, 'In-Transit', 'Trucks', 45, 45, '#111111', NULL, '2025-10-13T00:00:00+00:00', '2025-10-13T00:00:00+00:00', NULL, NULL, NULL);
INSERT INTO process_engine_rules (id, name, description, trigger_table, trigger_status_id, priority, enabled, created_at, updated_at, created_by) VALUES (16, 'RFID 1 - Exiting Cage', 'Asset detected leaving the cage via RFID reader.', 'moves_assets_list', 9, 9, TRUE, '2026-01-03T06:36:04+00:00', '2026-01-14T20:23:29+00:00', NULL);
INSERT INTO process_engine_rules (id, name, description, trigger_table, trigger_status_id, priority, enabled, created_at, updated_at, created_by) VALUES (23, 'Scan Type 19: RFID 4 - In Cage', 'Asset detected entering destination cage via RFID.', 'moves_assets_list', 19, 19, TRUE, '2026-01-03T06:36:05+00:00', '2026-01-14T21:00:50+00:00', NULL);
INSERT INTO process_engine_rules (id, name, description, trigger_table, trigger_status_id, priority, enabled, created_at, updated_at, created_by) VALUES (29, 'Asset Packed In Container', '', 'moves_assets_list', 13, 10, TRUE, '2026-01-21T04:18:22+00:00', '2026-01-29T21:24:34+00:00', NULL);
INSERT INTO process_engine_rules (id, name, description, trigger_table, trigger_status_id, priority, enabled, created_at, updated_at, created_by) VALUES (27, 'Truck Left Source - In Transit', 'GPS.', 'trucks', 45, 100, TRUE, '2026-01-03T06:36:05+00:00', '2026-01-03T06:36:05+00:00', NULL);
INSERT INTO process_engine_conditions (id, rule_id, condition_table, field_name, operator, value, logic, value_min, value_max) VALUES (4, 27, 'trucks', 'start_site', 'is_not_null', '', 'AND', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (135, 16, 1, 'set_status', 'moves_assets_list', 'asset_status', NULL, '9', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (136, 16, 2, 'set_status', 'assets', 'status', NULL, '9', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (137, 16, 3, 'clear_field', 'assets', 'location', NULL, NULL, NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (141, 23, 1, 'set_status', 'moves_assets_list', 'asset_status', NULL, '19', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (142, 23, 2, 'copy_field', 'assets', 'location', 'field_reference', 'trigger.scan_location', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (143, 23, 3, 'set_status', 'assets', 'status', 'static', '19', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (150, 29, 1, 'set_field', 'assets', 'location', 'field_reference', 'container.container_name', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (151, 29, 2, 'clear_field', 'assets', 'site', NULL, NULL, NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (152, 29, 3, 'set_status', 'assets', 'status', 'static', '13', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (160, 29, 4, 'set_field', 'assets', 'weird_field', 'static', 'x', NULL, NULL);
INSERT INTO process_engine_actions (id, rule_id, action_order, action_type, target_table, target_field, value_source, value, expression_type, expression_inputs) VALUES (87, 27, 1, 'set_status', 'trucks', 'truck_status', NULL, '45', NULL, NULL);
"""


def _dump(tmp_path):
    p = tmp_path / "v2.sql"
    p.write_text(FIXTURE)
    return str(p)


async def test_import_translates_and_reports(db, tmp_path):
    stats = await import_rules(db, _dump(tmp_path))
    await db.commit()

    assert stats["imported"] == 3
    assert stats["updated"] == 0
    assert [name for name, _ in stats["skipped"]] == [
        "Truck Left Source - In Transit"]
    assert len(stats["partial"]) == 1          # rule 29's weird_field action
    assert stats["partial"][0][0] == "Asset Packed In Container"

    rules = {r.name: r for r in (await db.scalars(
        select(StatusRule))).all()}
    cage = rules["RFID 1 - Exiting Cage"]
    assert cage.trigger_status == "rfid_1_cage_exit"
    assert cage.trigger_match_type == "asset"
    assert cage.priority == 9
    assert cage.enabled is False
    assert [(a.action_type, a.params) for a in cage.actions] == [
        ("set_initiative_asset_status", {"status": "rfid_1_cage_exit"}),
        ("set_asset_status", {"status": "rfid_1_cage_exit"}),
        ("clear_asset_location", {}),
    ]
    incage = rules["Scan Type 19: RFID 4 - In Cage"]
    assert [(a.action_type, a.params) for a in incage.actions] == [
        ("set_initiative_asset_status", {"status": "rfid_4_into_cage"}),
        ("set_asset_location_from_scan", {"fields": "location"}),
        ("set_asset_status", {"status": "rfid_4_into_cage"}),
    ]
    packed = rules["Asset Packed In Container"]
    assert [(a.action_type, a.params) for a in packed.actions] == [
        ("set_asset_location_from_container", {}),
        ("clear_asset_site", {}),
        ("set_asset_status", {"status": "in_container"}),
    ]


async def test_reimport_is_idempotent_and_preserves_enabled(db, tmp_path):
    path = _dump(tmp_path)
    await import_rules(db, path)
    await db.commit()
    rule = (await db.scalars(select(StatusRule).where(
        StatusRule.name == "RFID 1 - Exiting Cage"))).one()
    rule.enabled = True
    rule.priority = 99                          # local drift, gets re-imported
    await db.commit()

    stats = await import_rules(db, path)
    await db.commit()
    assert stats["imported"] == 0
    assert stats["updated"] == 3

    again = (await db.scalars(select(StatusRule).where(
        StatusRule.name == "RFID 1 - Exiting Cage"))).one()
    assert again.enabled is True                # preserved
    assert again.priority == 9                  # V2 value restored
    assert len(again.actions) == 3              # children replaced, not doubled


async def test_end_to_end_imported_rule_fires(db, tmp_path):
    invalidate_cache()
    await import_rules(db, _dump(tmp_path))
    rule = (await db.scalars(select(StatusRule).where(
        StatusRule.name == "RFID 1 - Exiting Cage"))).one()
    rule.enabled = True
    a = Asset(serial_number="SN-E2E", status="racked",
              location_detail="R4 RU10")
    scan = RawScan(scanned_value="SN-E2E", scan_type="rfid",
                   status="rfid_1_cage_exit", scanned_at=datetime.now(UTC))
    db.add_all([a, scan])
    await db.commit()

    assert await worker.process_raw_scan(get_sessionmaker(), scan.id) == "matched"
    async with get_sessionmaker()() as check:
        seen = await check.get(Asset, a.id)
        assert seen.status == "rfid_1_cage_exit"
        assert seen.location_detail == ""       # clear_asset_location fired
    invalidate_cache()
