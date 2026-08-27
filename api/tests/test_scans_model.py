"""Scans schema — defaults, vocab seeds, FK + CHECK constraints."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    Asset, Person, ProcessedScan, RawScan, StatusValue,
)

NOW = datetime(2026, 8, 27, 12, 0, tzinfo=UTC)


async def test_raw_scan_defaults(db):
    s = RawScan(scanned_value="EPC-0001", scan_type="rfid", scanned_at=NOW)
    db.add(s)
    await db.commit()
    assert isinstance(s.id, int)
    assert s.device_id == ""
    assert s.location_detail == ""
    assert s.source == ""
    assert s.operator_id is None
    assert s.site_id is None
    assert s.created_at is not None


async def test_vocabulary_seeds(db):
    scan = {s.key for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "scan"))}
    assert scan == {"rfid", "barcode", "manual"}
    match = {s.key for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "processed_scan"))}
    assert match == {"asset", "container", "person"}


async def test_unknown_scan_type_rejected_by_fk(db):
    db.add(RawScan(scanned_value="X", scan_type="nope", scanned_at=NOW))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_processed_scan_roundtrip(db):
    asset = Asset(name="srv-1")
    db.add(asset)
    await db.flush()
    p = ProcessedScan(
        scanned_value="EPC-0001", scan_type="rfid", scanned_at=NOW,
        raw_scan_id=12345, match_type="asset", asset_id=asset.id,
        processed_at=NOW)
    db.add(p)
    await db.commit()
    assert p.id is not None
    assert p.archived_at is None
    assert p.created_at is not None and p.updated_at is not None


async def test_match_check_constraint(db):
    # match_type says asset but asset_id is NULL -> CHECK must reject
    db.add(ProcessedScan(
        scanned_value="EPC-0002", scan_type="rfid", scanned_at=NOW,
        match_type="asset", processed_at=NOW))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_match_person_distinct_from_operator(db):
    operator = Person(first_name="Op", last_name="Erator")
    badge = Person(first_name="Badge", last_name="Holder")
    db.add_all([operator, badge])
    await db.flush()
    p = ProcessedScan(
        scanned_value="BADGE-1", scan_type="rfid", scanned_at=NOW,
        operator_id=operator.id, match_type="person", person_id=badge.id,
        processed_at=NOW)
    db.add(p)
    await db.commit()
    assert p.operator_id != p.person_id


async def test_scans_role_grants_seeded(db):
    rows = (await db.execute(text(
        "SELECT role, action FROM role_permissions WHERE resource='scans'"
    ))).all()
    grants = {}
    for role, action in rows:
        grants.setdefault(role, set()).add(action)
    assert grants["developer"] == {"view", "add", "change", "delete"}
    assert grants["admin"] == {"view", "change", "delete"}
    assert grants["staff"] == {"view"}
    assert "worker" not in grants


async def test_scans_registry_shape():
    from serversherpa.access.defaults import DEFAULT_GRANTS
    from serversherpa.access.resources import REGISTRY
    from serversherpa.status.registry import STATUS_REGISTRY

    assert REGISTRY["scans"].visible_to == frozenset({"global"})
    assert "/admin/scans" in REGISTRY["scans"].routes
    assert DEFAULT_GRANTS["admin"]["scans"] == ("view", "change", "delete")
    assert DEFAULT_GRANTS["staff"]["scans"] == ("view",)
    assert "scans" not in DEFAULT_GRANTS["worker"]
    assert STATUS_REGISTRY["scan"].sources == (
        ("raw_scans", "scan_type"), ("processed_scans", "scan_type"))
    assert STATUS_REGISTRY["processed_scan"].sources == (
        ("processed_scans", "match_type"),)
    assert STATUS_REGISTRY["scan"].resource == "scans"
