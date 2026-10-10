"""Migration 0096: trucks.trip_started_at (+ backfill) and the two feed
indexes."""

import json
from datetime import UTC, datetime, timedelta
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest.mock import patch

from sqlalchemy import text

PATH = (Path(__file__).resolve().parents[1]
        / "migrations/versions/0096_truck_trip_and_feed_indexes.py")


def _migration():
    spec = spec_from_file_location("migration_0096", PATH)
    mod = module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


T0 = datetime(2026, 3, 1, 12, tzinfo=UTC)


async def _truck(db, name, status, created_at=T0):
    return await db.scalar(text(
        "INSERT INTO trucks (name, status, created_at) "
        "VALUES (:n, :s, :c) RETURNING id"), {"n": name, "s": status, "c": created_at})


async def _status_audit(db, truck_id, frm, to, at, action="update", entity="truck"):
    await db.execute(text(
        "INSERT INTO audit_log (entity_type, entity_id, action, changes, at) "
        "VALUES (:e, :i, :a, CAST(:c AS jsonb), :at)"),
        {"e": entity, "i": str(truck_id), "a": action, "at": at,
         "c": json.dumps({"status": {"from": frm, "to": to}})})


async def _backfill(db):
    await db.execute(text("UPDATE trucks SET trip_started_at = NULL"))
    await db.execute(text(_migration().BACKFILL))
    await db.commit()


async def _trip(db, truck_id):
    return await db.scalar(text("SELECT trip_started_at FROM trucks WHERE id=:i"),
                           {"i": truck_id})


async def test_column_and_indexes_exist(db):
    col = (await db.execute(text(
        "SELECT data_type, is_nullable FROM information_schema.columns "
        "WHERE table_name='trucks' AND column_name='trip_started_at'"))).one()
    assert col == ("timestamp with time zone", "YES")
    defs = dict((await db.execute(text(
        "SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN "
        "('ix_truck_updates_recorded_at', 'ix_audit_log_entity_type_at')"))).all())
    assert "(recorded_at DESC)" in defs["ix_truck_updates_recorded_at"]
    assert "(entity_type, at DESC)" in defs["ix_audit_log_entity_type_at"]


async def test_backfill_uses_the_latest_trip_starting_status_change(db):
    tid = await _truck(db, "A", "in_transit")
    await _status_audit(db, tid, None, "active", T0 + timedelta(hours=1), action="create")
    await _status_audit(db, tid, "active", "in_transit", T0 + timedelta(hours=2))
    await _status_audit(db, tid, "in_transit", "at_destination", T0 + timedelta(hours=3))
    await _status_audit(db, tid, "at_destination", "in_transit", T0 + timedelta(hours=4))
    await _status_audit(db, tid, "in_transit", "active", T0 + timedelta(hours=5))
    await db.commit()
    await _backfill(db)
    # the active->in_transit (h2) and in_transit->active (h5) rows do not
    # start a trip; the latest one that does is at_destination->in_transit
    assert await _trip(db, tid) == T0 + timedelta(hours=4)


async def test_backfill_counts_a_create_row_into_a_trip_status(db):
    tid = await _truck(db, "B", "active")
    await _status_audit(db, tid, None, "in_transit", T0 + timedelta(hours=6), action="create")
    await db.commit()
    await _backfill(db)
    assert await _trip(db, tid) == T0 + timedelta(hours=6)


async def test_backfill_falls_back_to_created_at_for_live_statuses(db):
    ids = {s: await _truck(db, s, s, created_at=T0 + timedelta(days=1))
           for s in ("active", "in_transit", "at_destination")}
    await db.commit()
    await _backfill(db)
    for tid in ids.values():
        assert await _trip(db, tid) == T0 + timedelta(days=1)


async def test_backfill_leaves_other_trucks_null_and_ignores_other_entities(db):
    created = await _truck(db, "C", "created")
    historical = await _truck(db, "H", "historical")
    # a site's audit row with the same id text must not leak into a truck
    other = await _truck(db, "O", "created")
    await _status_audit(db, other, "created", "active", T0, entity="site")
    # a non-status change is not a trip start
    await db.execute(text(
        "INSERT INTO audit_log (entity_type, entity_id, action, changes) "
        "VALUES ('truck', :i, 'update', CAST('{\"load_number\": {\"from\": null, "
        "\"to\": \"L1\"}}' AS jsonb))"), {"i": str(created)})
    await db.commit()
    await _backfill(db)
    for tid in (created, historical, other):
        assert await _trip(db, tid) is None


async def test_backfill_audit_time_wins_over_created_at(db):
    tid = await _truck(db, "W", "at_destination")
    await _status_audit(db, tid, "created", "active", T0 + timedelta(hours=9))
    await db.commit()
    await _backfill(db)
    assert await _trip(db, tid) == T0 + timedelta(hours=9)


def test_downgrade_drops_everything_upgrade_adds():
    mod = _migration()
    with patch.object(mod.op, "add_column") as add_col, \
            patch.object(mod.op, "drop_column") as drop_col, \
            patch.object(mod.op, "execute") as execute, \
            patch.object(mod.op, "create_index") as create_idx, \
            patch.object(mod.op, "drop_index") as drop_idx:
        mod.upgrade()
        mod.downgrade()
    assert add_col.call_args.args[:2] == ("trucks", add_col.call_args.args[1])
    assert add_col.call_args.args[1].name == "trip_started_at"
    assert drop_col.call_args.args[:2] == ("trucks", "trip_started_at")
    assert execute.call_args.args[0] == mod.BACKFILL
    assert {c.args[0] for c in create_idx.call_args_list} == {
        "ix_truck_updates_recorded_at", "ix_audit_log_entity_type_at"}
    assert {c.args[0] for c in drop_idx.call_args_list} == {
        "ix_truck_updates_recorded_at", "ix_audit_log_entity_type_at"}
