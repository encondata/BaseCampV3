"""Migration 0068: asset_models.form_factor plus the orphan_node status.

The data work lives in two plain functions taking a raw connection so it
can be re-run against the test database (clean_db re-seeds status_values
and truncates asset_models before every test), same convention as 0067's
retire_handheld_reader(conn)."""

import importlib.util
from pathlib import Path

from sqlalchemy import select, text

from serversherpa.db.models import AssetModel, StatusValue

MIGRATION_PATH = (Path(__file__).resolve().parents[1] / "migrations" / "versions"
                  / "0068_model_form_factor_and_orphan_status.py")


def _load():
    spec = importlib.util.spec_from_file_location("_migration_0068_under_test", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def test_column_exists_with_check_constraint(db):
    await db.execute(text("INSERT INTO asset_models (make, model, form_factor) "
                          "VALUES ('A', 'ok', 'chassis')"))
    import pytest
    from sqlalchemy.exc import DBAPIError
    with pytest.raises(DBAPIError):
        await db.execute(text("INSERT INTO asset_models (make, model, form_factor) "
                              "VALUES ('A', 'bad', 'blade')"))
    await db.rollback()


async def test_seed_orphan_status_is_idempotent(db):
    m = _load()
    await db.execute(text("DELETE FROM status_values WHERE record_type='asset' AND key='orphan_node'"))
    await db.run_sync(lambda s: m.seed_orphan_status(s.connection()))
    await db.run_sync(lambda s: m.seed_orphan_status(s.connection()))
    row = await db.scalar(select(StatusValue).where(
        StatusValue.record_type == "asset", StatusValue.key == "orphan_node"))
    assert row is not None and row.label == "Orphan node" and row.progress_weight is None


async def test_backfill_sets_form_factor_from_the_model_name_only_where_null(db):
    m = _load()
    db.add_all([
        AssetModel(make="DellEMC", model="Isilon H5600 (Chassis)"),
        AssetModel(make="Dell", model="Isilon H5600"),
        AssetModel(make="Dell", model="H5600 node"),
        AssetModel(make="DellEMC_Isilon", model="H5600 Storage (Node)"),
        AssetModel(make="Netapp", model="AFF A900 (Chassis) 8U"),
        AssetModel(make="Dell", model="R740"),
        AssetModel(make="X", model="Odd Chassis", form_factor="standalone"),  # explicit wins
    ])
    await db.commit()
    await db.run_sync(lambda s: m.backfill_form_factor(s.connection()))
    await db.commit()
    rows = dict((await db.execute(
        select(AssetModel.model, AssetModel.form_factor))).all())
    assert rows == {
        "Isilon H5600 (Chassis)": "chassis",
        "Isilon H5600": None,
        "H5600 node": "node",
        "H5600 Storage (Node)": "node",
        "AFF A900 (Chassis) 8U": "chassis",
        "R740": None,
        "Odd Chassis": "standalone",
    }
