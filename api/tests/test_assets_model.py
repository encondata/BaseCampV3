"""Migration 0014 + model round-trips: tables exist, seeds landed,
constraints hold (rfid partial-unique, make+model unique, alias unique)."""

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import (
    Asset, AssetCategory, AssetModel, AssetModelAlias, Note, StatusValue,
)


async def test_seeds_present(db):
    cats = (await db.scalars(select(AssetCategory))).all()
    assert {c.key for c in cats} == {"server", "storage", "network", "power", "other"}
    statuses = (await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "asset"))).all()
    assert {s.key for s in statuses} == {
        "active", "in_transit", "in_storage", "decommissioned", "unknown"}
    assert all(s.color.startswith("#") for s in statuses)


async def test_asset_defaults_and_status_fk(db):
    asset = Asset(name="web-01")
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    assert asset.status == "unknown"
    assert asset.status_record_type == "asset"
    assert asset.location_detail == ""
    assert asset.created_at is not None

    bad = Asset(name="bad", status="not_a_status")
    db.add(bad)
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_rfid_unique_only_when_present(db):
    db.add_all([Asset(name="a1", rfid_tag=None), Asset(name="a2", rfid_tag=None)])
    await db.commit()          # two NULL tags fine

    db.add(Asset(name="a3", rfid_tag="TAG-1"))
    await db.commit()
    db.add(Asset(name="a4", rfid_tag="tag-1"))   # CITEXT: case-insensitive clash
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_duplicate_serial_allowed(db):
    db.add_all([Asset(serial_number="SN1"), Asset(serial_number="SN1")])
    await db.commit()          # serials deliberately NOT unique


async def test_make_model_unique_and_alias_cascade(db):
    m = AssetModel(make="Dell", model="R740")
    db.add(m)
    await db.commit()
    model_id = m.id  # read before the rollback below expires m's attributes
    db.add(AssetModel(make="dell", model="r740"))   # CITEXT pair clash
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()

    db.add(AssetModelAlias(model_id=model_id, alias="PowerEdge R740"))
    await db.commit()
    await db.delete(m)
    await db.commit()
    left = (await db.scalars(select(AssetModelAlias))).all()
    assert left == []          # ON DELETE CASCADE


async def test_notes_table_roundtrip(db):
    note = Note(entity_type="asset",
                entity_id=(await _mk_asset(db)), body="hello")
    db.add(note)
    await db.commit()
    await db.refresh(note)
    assert note.deleted_at is None and note.created_at is not None


async def _mk_asset(db):
    a = Asset(name="host")
    db.add(a)
    await db.flush()
    return a.id


async def test_role_grants_seeded(db):
    rows = (await db.execute(text(
        "SELECT role, action FROM role_permissions WHERE resource = 'assets'"
    ))).all()
    granted = {(r, a) for r, a in rows}
    assert ("staff", "change") in granted
    assert ("client_viewer", "view") in granted
    assert ("client_viewer", "change") not in granted
    model_rows = (await db.execute(text(
        "SELECT role FROM role_permissions WHERE resource = 'asset_models'"
    ))).all()
    assert all(r[0] not in ("client_owner", "client_admin", "client_viewer")
               for r in model_rows)
