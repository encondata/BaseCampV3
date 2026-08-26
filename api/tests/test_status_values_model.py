"""The composite FK is the point: a FK on `key` alone would let a site
reference a worker status."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, ProgrammingError

from serversherpa.db.models import Site, StatusValue


async def test_site_statuses_migrated_with_colors(db):
    rows = (await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "site")
        .order_by(StatusValue.sort_order))).all()
    assert [r.key for r in rows] == [
        "active", "planned", "inactive", "decommissioned"]
    assert [r.color for r in rows] == ["#178a4c", "#0f7c86", "#51606f", "#c03540"]
    assert all(r.is_active for r in rows)


async def test_worker_statuses_seeded_with_labels_and_colors(db):
    rows = (await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "worker")
        .order_by(StatusValue.sort_order))).all()
    assert [r.key for r in rows] == ["active", "standby", "blacklist"]
    assert [r.label for r in rows] == ["Active", "Standby", "Blacklist"]
    assert [r.color for r in rows] == ["#178a4c", "#a36207", "#c03540"]


async def test_site_cannot_reference_a_worker_only_status(db):
    """'standby' exists, but only as record_type='worker'. The composite FK
    must reject it — this is the whole reason the PK is composite."""
    db.add(Site(name="FK Probe", status="standby"))
    with pytest.raises(IntegrityError):
        await db.flush()
    await db.rollback()


async def test_generated_record_type_column_is_constant(db):
    """Three properties, all load-bearing:

    1. The column reads back 'site' — the VALUE is right. Nothing else in
       this file inserts a site that succeeds, so without this a migration
       generating the wrong constant ('bogus') would go unnoticed: the
       test DB's sites table is empty when migrations run, so the composite
       FK validates vacuously, and every other test here still passes (the
       FK test still rejects, just for the wrong reason). Production would
       500 on every site insert.
    2. Postgres reports it GENERATED ALWAYS — it is COMPUTED, not merely a
       `text DEFAULT 'site'` column. The read-back alone can't tell these
       apart: the ORM doesn't map status_record_type, so it's omitted from
       the INSERT either way.
    3. A direct write is rejected — so it cannot drift after the fact.

    Ordering matters: the read-back needs its flush to land, and the
    write-rejection poisons the transaction, so it goes last.
    """
    db.add(Site(name="Generated Probe", status="planned"))
    await db.flush()
    value = await db.scalar(text(
        "SELECT status_record_type FROM sites WHERE name = 'Generated Probe'"))
    assert value == "site"

    is_generated = await db.scalar(text(
        "SELECT is_generated FROM information_schema.columns "
        "WHERE table_name = 'sites' AND column_name = 'status_record_type'"))
    assert is_generated == "ALWAYS"

    # Postgres rejects a direct write to a GENERATED ALWAYS column with a
    # syntax/access error (SQLSTATE 428C9), not a constraint violation —
    # asyncpg's dialect surfaces that as ProgrammingError, not IntegrityError.
    with pytest.raises(ProgrammingError):
        await db.execute(text(
            "UPDATE sites SET status_record_type = 'worker'"))
    await db.rollback()


async def test_blacklist_note_check_survives(db):
    """The CHECK hardcodes the literal 'blacklist'. It stays valid only
    because no API can rename a key."""
    row = await db.scalar(text(
        "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
        "WHERE conname = 'worker_profiles_blacklist_note_check'"))
    assert row is not None
    assert "blacklist" in row


async def test_old_status_check_is_gone(db):
    row = await db.scalar(text(
        "SELECT 1 FROM pg_constraint "
        "WHERE conname = 'worker_profiles_status_check'"))
    assert row is None


async def test_site_statuses_table_is_dropped(db):
    row = await db.scalar(text("SELECT to_regclass('public.site_statuses')"))
    assert row is None


async def test_move_asset_status_weights_seeded_verbatim(db):
    """0021's seed UPDATEs, per the weighted-progress design doc's table
    (docs/superpowers/specs/2026-08-25-weighted-progress-design.md). Every
    key/weight pair here is a verbatim transcription of that table,
    including the two explicit nulls. in_container is absent from the
    doc's table entirely and stays null by default."""
    rows = (await db.execute(
        select(StatusValue.key, StatusValue.progress_weight)
        .where(StatusValue.record_type == "move_asset_status"))).all()
    weights = dict(rows)
    assert weights == {
        "loaded_in_system": 0,
        "pre_stage": 8,
        "racked": 15,
        "labeled": 23,
        "pack_logistics": 31,
        "in_container": None,
        "on_truck": 46,
        "received": 54,
        "un_pack": 62,
        "staged": 69,
        "re_racked": 77,
        "cabling": 85,
        "qa": 92,
        "complete": 100,
        "rfid_1_cage_exit": 35,
        "rfid_2_loading_dock": 40,
        "rfid_3_staging": 65,
        "rfid_4_into_cage": 72,
        "rfid_10_dock_to_truck": 44,
        "in_transit": 50,
        "e_waste": 100,
        "pending_client_handover": 95,
        "historical": None,
        "location_collision": None,
    }


async def test_progress_weight_defaults_to_null_for_other_record_types(db):
    """The column is generic — only move_asset_status is seeded. A site
    status must come back null, not some inherited default."""
    weight = await db.scalar(
        select(StatusValue.progress_weight)
        .where(StatusValue.record_type == "site", StatusValue.key == "active"))
    assert weight is None


async def test_progress_weight_check_constraint_rejects_out_of_range(db):
    db.add(StatusValue(record_type="site", key="probe_high", label="Probe",
                       color="#178a4c", progress_weight=101))
    with pytest.raises(IntegrityError):
        await db.flush()
    await db.rollback()

    db.add(StatusValue(record_type="site", key="probe_low", label="Probe",
                       color="#178a4c", progress_weight=-1))
    with pytest.raises(IntegrityError):
        await db.flush()
    await db.rollback()


async def test_progress_weight_check_constraint_allows_bounds_and_null(db):
    db.add(StatusValue(record_type="site", key="probe_zero", label="Probe",
                       color="#178a4c", progress_weight=0))
    db.add(StatusValue(record_type="site", key="probe_hundred", label="Probe",
                       color="#178a4c", progress_weight=100))
    db.add(StatusValue(record_type="site", key="probe_null", label="Probe",
                       color="#178a4c", progress_weight=None))
    await db.flush()
    await db.rollback()
