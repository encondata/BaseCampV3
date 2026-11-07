import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from sirdar_api.access.defaults import DEFAULT_GRANTS
from sirdar_api.access.resources import REGISTRY
from sirdar_api.db.models import (
    SeedRecipe,
    SeedRecipeFile,
    SeedRecipeRow,
    SeedRecipeTable,
    Snapshot,
)


async def _recipe(db, name="demo") -> SeedRecipe:
    r = SeedRecipe(name=name)
    db.add(r)
    await db.commit()
    return r


async def test_recipe_children_round_trip(db):
    r = await _recipe(db)
    assert r.notes == "" and r.created_at is not None and r.updated_at is not None
    db.add_all([
        SeedRecipeTable(recipe_id=r.id, table_name="people", mode="all"),
        SeedRecipeTable(recipe_id=r.id, table_name="assets", mode="rows"),
        SeedRecipeRow(recipe_id=r.id, table_name="assets", pk={"id": "42"}),
        SeedRecipeFile(recipe_id=r.id, key="photos/a.jpg", keep=True),
    ])
    await db.commit()
    modes = {t.table_name: t.mode for t in await db.scalars(select(SeedRecipeTable))}
    assert modes == {"people": "all", "assets": "rows"}
    assert (await db.scalar(select(SeedRecipeRow.pk))) == {"id": "42"}
    assert (await db.scalar(select(SeedRecipeFile.keep))) is True


async def test_delete_cascades_and_unlinks_snapshots(db):
    r = await _recipe(db)
    db.add_all([
        SeedRecipeTable(recipe_id=r.id, table_name="assets", mode="rows"),
        SeedRecipeRow(recipe_id=r.id, table_name="assets", pk={"id": "1"}),
        SeedRecipeFile(recipe_id=r.id, key="k", keep=False),
        Snapshot(name="s1", origin="recipe", source="demo", status="failed", recipe_id=r.id),
    ])
    await db.commit()
    snap = await db.scalar(select(Snapshot))
    assert snap.reset_passwords is False
    await db.delete(r)
    await db.commit()
    for model in (SeedRecipeTable, SeedRecipeRow, SeedRecipeFile):
        assert await db.scalar(select(func.count()).select_from(model)) == 0
    await db.refresh(snap)
    assert snap.recipe_id is None


async def test_source_snapshot_set_null(db):
    src = Snapshot(name="src", origin="upload", source="x", status="failed")
    db.add(src)
    await db.commit()
    child = Snapshot(name="child", origin="recipe", source="x", status="failed", source_snapshot_id=src.id)
    db.add(child)
    await db.commit()
    await db.delete(src)
    await db.commit()
    await db.refresh(child)
    assert child.source_snapshot_id is None


async def test_duplicate_name_refused(db):
    await _recipe(db)
    db.add(SeedRecipe(name="demo"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


async def test_bad_mode_refused(db):
    r = await _recipe(db)
    db.add(SeedRecipeTable(recipe_id=r.id, table_name="t", mode="x"))
    with pytest.raises(IntegrityError):
        await db.commit()
    await db.rollback()


def test_seed_data_resource_and_grants():
    assert "seed_data" in REGISTRY and REGISTRY["seed_data"].label == "Seed Data"
    for role, grants in DEFAULT_GRANTS.items():
        assert grants["seed_data"] == grants["deploy"], role
