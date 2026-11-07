"""Seed Data recipes: read and replace a recipe's tables, rows and files."""

import json
import uuid

from sqlalchemy import delete, func, insert, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.db.models import (
    SeedRecipe,
    SeedRecipeFile,
    SeedRecipeRow,
    SeedRecipeTable,
)

_CHUNK = 5000


async def summaries(db: AsyncSession) -> list[dict]:
    """Every recipe with its table, row and file counts."""
    tables = dict((await db.execute(
        select(SeedRecipeTable.recipe_id, func.count()).group_by(SeedRecipeTable.recipe_id))).all())
    rows = dict((await db.execute(
        select(SeedRecipeRow.recipe_id, func.count()).group_by(SeedRecipeRow.recipe_id))).all())
    files = dict((await db.execute(
        select(SeedRecipeFile.recipe_id, func.count()).group_by(SeedRecipeFile.recipe_id))).all())
    out = []
    for r in await db.scalars(select(SeedRecipe).order_by(SeedRecipe.name)):
        out.append({"id": str(r.id), "name": r.name, "notes": r.notes,
                    "tables": tables.get(r.id, 0), "rows": rows.get(r.id, 0),
                    "files": files.get(r.id, 0), "updated_at": r.updated_at.isoformat()})
    return out


async def detail(db: AsyncSession, recipe: SeedRecipe) -> dict:
    tables: dict[str, dict] = {
        t.table_name: {"mode": t.mode, "pks": []}
        for t in await db.scalars(select(SeedRecipeTable)
                                  .where(SeedRecipeTable.recipe_id == recipe.id)
                                  .order_by(SeedRecipeTable.table_name))}
    result = await db.execute(
        select(SeedRecipeRow.table_name, SeedRecipeRow.pk)
        .where(SeedRecipeRow.recipe_id == recipe.id)
        .order_by(SeedRecipeRow.table_name, text("pk::text")))
    for name, pk in result:
        if name in tables:
            tables[name]["pks"].append(dict(pk))
    files = {f.key: f.keep for f in await db.scalars(
        select(SeedRecipeFile).where(SeedRecipeFile.recipe_id == recipe.id)
        .order_by(SeedRecipeFile.key))}
    return {"id": str(recipe.id), "name": recipe.name, "notes": recipe.notes,
            "tables": tables, "files": files}


async def replace(db: AsyncSession, recipe_id: uuid.UUID, tables: dict[str, dict],
                  files: dict[str, bool]) -> dict:
    """Replace the recipe's tables, rows and files (the caller commits).
    Returns the counts."""
    for model in (SeedRecipeRow, SeedRecipeTable, SeedRecipeFile):
        await db.execute(delete(model).where(model.recipe_id == recipe_id))
    if tables:
        await db.execute(insert(SeedRecipeTable), [
            {"recipe_id": recipe_id, "table_name": name, "mode": t["mode"]}
            for name, t in tables.items()])
    row_values = []
    for name, t in tables.items():
        if t["mode"] != "rows":
            continue
        seen = set()
        for pk in t["pks"]:
            key = json.dumps(pk, sort_keys=True)
            if key not in seen:
                seen.add(key)
                row_values.append({"recipe_id": recipe_id, "table_name": name, "pk": pk})
    for i in range(0, len(row_values), _CHUNK):
        await db.execute(insert(SeedRecipeRow), row_values[i:i + _CHUNK])
    if files:
        await db.execute(insert(SeedRecipeFile), [
            {"recipe_id": recipe_id, "key": k, "keep": v} for k, v in files.items()])
    return {"tables": len(tables), "rows": len(row_values), "files": len(files)}


async def summaries_for(db: AsyncSession, recipe_id: uuid.UUID) -> dict:
    """Counts only, for the audit row."""
    out = {}
    for key, model in (("tables", SeedRecipeTable), ("rows", SeedRecipeRow),
                       ("files", SeedRecipeFile)):
        out[key] = await db.scalar(
            select(func.count()).select_from(model).where(model.recipe_id == recipe_id))
    return out
