"""Asset make/model catalog — the hardware knowledge base (legacy
assets_make_model). Internal-only resource: client actors see a summary
embedded in asset payloads, never these endpoints."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    AssetCategoryCreateIn, AssetCategoryOut, AssetCategoryUpdateIn,
    AssetModelAliasesIn, AssetModelCreateIn, AssetModelItem,
    AssetModelUpdateIn,
)
from serversherpa.assets.units import apply_unit_pairs
from serversherpa.db.models import AssetCategory, AssetModel, AssetModelAlias
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/asset-models", tags=["assets"])
categories_router = APIRouter(tags=["assets"])

MOUNT_TYPES = ("rails", "ears", "shelf", "custom")
FORM_FACTORS = ("standalone", "chassis", "node")

MODEL_FIELDS = [
    "make", "model", "category", "ru_size",
    "weight_lbs", "weight_kg", "length_in", "width_in", "height_in",
    "length_cm", "width_cm", "height_cm", "mount_type", "rail_type",
    "form_factor", "knowledge",
]
NON_NULLABLE_MODEL_FIELDS = ("make", "model")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _require_global(actor: AuthContext) -> None:
    if not actor.access.is_global:
        raise _err(403, "forbidden")


async def _cats(db: DbSession) -> dict:
    return {c.key: (c.label, c.color)
            for c in await db.scalars(select(AssetCategory))}


async def _aliases_by_model(db: DbSession, model_ids: list[uuid.UUID]) -> dict:
    if not model_ids:
        return {}
    rows = (await db.execute(
        select(AssetModelAlias.model_id, AssetModelAlias.alias)
        .where(AssetModelAlias.model_id.in_(model_ids))
        .order_by(AssetModelAlias.alias))).all()
    out: dict = {}
    for model_id, alias in rows:
        out.setdefault(model_id, []).append(alias)
    return out


def _item(m: AssetModel, cats: dict, aliases: dict) -> dict:
    label, color = (cats.get(m.category, (m.category, "#51606f"))
                    if m.category is not None else (None, None))
    def f(v):
        return float(v) if v is not None else None
    return {
        "id": m.id, "make": m.make, "model": m.model,
        "category": m.category, "category_label": label, "category_color": color,
        "ru_size": m.ru_size,
        "weight_lbs": f(m.weight_lbs), "weight_kg": f(m.weight_kg),
        "length_in": f(m.length_in), "width_in": f(m.width_in),
        "height_in": f(m.height_in), "length_cm": f(m.length_cm),
        "width_cm": f(m.width_cm), "height_cm": f(m.height_cm),
        "mount_type": m.mount_type, "rail_type": m.rail_type,
        "form_factor": m.form_factor,
        "knowledge": m.knowledge, "aliases": aliases.get(m.id, []),
        "created_at": m.created_at, "updated_at": m.updated_at,
    }


async def _detail(db: DbSession, m: AssetModel) -> AssetModelItem:
    cats = await _cats(db)
    aliases = await _aliases_by_model(db, [m.id])
    return AssetModelItem(**_item(m, cats, aliases))


async def _validate(db: DbSession, data: dict) -> None:
    if data.get("category") is not None and \
            await db.get(AssetCategory, data["category"]) is None:
        raise _err(422, "unknown_category")
    if data.get("mount_type") is not None and \
            data["mount_type"] not in MOUNT_TYPES:
        raise _err(422, "unknown_mount_type")
    if data.get("form_factor") is not None and \
            data["form_factor"] not in FORM_FACTORS:
        raise _err(422, "unknown_form_factor")


async def _check_duplicate(db: DbSession, make: str, model: str,
                           exclude: uuid.UUID | None = None) -> None:
    query = select(AssetModel.id).where(
        AssetModel.make == make, AssetModel.model == model)
    if exclude is not None:
        query = query.where(AssetModel.id != exclude)
    if await db.scalar(query) is not None:
        raise _err(409, "duplicate_model")


@router.get("", response_model=list[AssetModelItem])
async def list_asset_models(
    db: DbSession,
    _actor: AuthContext = require_permission("asset_models", "view"),
) -> list[AssetModelItem]:
    models = (await db.scalars(
        select(AssetModel).order_by(AssetModel.make, AssetModel.model))).all()
    cats = await _cats(db)
    aliases = await _aliases_by_model(db, [m.id for m in models])
    return [AssetModelItem(**_item(m, cats, aliases)) for m in models]


@router.get("/{model_id}", response_model=AssetModelItem)
async def get_asset_model(
    model_id: uuid.UUID,
    db: DbSession,
    _actor: AuthContext = require_permission("asset_models", "view"),
) -> AssetModelItem:
    m = await db.get(AssetModel, model_id)
    if m is None:
        raise _err(404, "asset_model_not_found")
    return await _detail(db, m)


@router.post("", response_model=AssetModelItem, status_code=201)
async def create_asset_model(
    body: AssetModelCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("asset_models", "add"),
) -> AssetModelItem:
    _require_global(actor)
    data = apply_unit_pairs(body.model_dump(exclude_unset=True))
    await _validate(db, data)
    await _check_duplicate(db, data["make"], data["model"])
    m = AssetModel(**data)
    db.add(m)
    await db.flush()
    initial = snapshot(m, MODEL_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items() if value not in (None, "")}
    audit(db, actor_id=actor.person.id, entity_type="asset_model",
          entity_id=str(m.id), action="create", changes=changes)
    await db.commit()
    return await _detail(db, m)


@router.patch("/{model_id}", response_model=AssetModelItem)
async def update_asset_model(
    model_id: uuid.UUID,
    body: AssetModelUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("asset_models", "change"),
) -> AssetModelItem:
    _require_global(actor)
    m = await db.get(AssetModel, model_id)
    if m is None:
        raise _err(404, "asset_model_not_found")
    data = apply_unit_pairs(body.model_dump(exclude_unset=True))
    for field in NON_NULLABLE_MODEL_FIELDS:
        if field in data and not data[field]:
            raise _err(422, f"{field}_required")
    if "knowledge" in data and data["knowledge"] is None:
        raise _err(422, "knowledge_required")
    await _validate(db, data)
    await _check_duplicate(db, data.get("make", m.make),
                           data.get("model", m.model), exclude=m.id)

    fields = list(data.keys())
    before = snapshot(m, fields)
    for field, value in data.items():
        setattr(m, field, value)
    changes = diff(before, snapshot(m, fields))
    if changes:
        m.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="asset_model",
              entity_id=str(model_id), action="update", changes=changes)
    await db.commit()
    return await _detail(db, m)


@router.put("/{model_id}/aliases", response_model=AssetModelItem)
async def set_asset_model_aliases(
    model_id: uuid.UUID,
    body: AssetModelAliasesIn,
    db: DbSession,
    actor: AuthContext = require_permission("asset_models", "change"),
) -> AssetModelItem:
    _require_global(actor)
    m = await db.get(AssetModel, model_id)
    if m is None:
        raise _err(404, "asset_model_not_found")
    desired = {a.strip() for a in body.aliases if a.strip()}

    # global uniqueness: an alias owned by ANOTHER model is a conflict
    if desired:
        clash = await db.scalar(
            select(AssetModelAlias.alias).where(
                AssetModelAlias.alias.in_(desired),
                AssetModelAlias.model_id != model_id))
        if clash is not None:
            raise _err(409, "alias_in_use", alias=str(clash))

    current = set(await db.scalars(
        select(AssetModelAlias.alias).where(AssetModelAlias.model_id == model_id)))
    # CITEXT compares case-insensitively in SQL, but the Python sets above are
    # case-sensitive — normalise via lowercase maps for the diff.
    cur_map = {a.lower(): a for a in current}
    des_map = {a.lower(): a for a in desired}
    removed = [cur_map[k] for k in cur_map.keys() - des_map.keys()]
    added = [des_map[k] for k in des_map.keys() - cur_map.keys()]
    for alias in removed:
        await db.execute(AssetModelAlias.__table__.delete().where(
            AssetModelAlias.model_id == model_id, AssetModelAlias.alias == alias))
    for alias in added:
        db.add(AssetModelAlias(model_id=model_id, alias=alias))
    if added or removed:
        audit(db, actor_id=actor.person.id, entity_type="asset_model",
              entity_id=str(model_id), action="aliases.set",
              changes={"added": sorted(added), "removed": sorted(removed)})
    await db.commit()
    return await _detail(db, m)


@categories_router.get("/asset-categories", response_model=list[AssetCategoryOut])
async def list_asset_categories(
    db: DbSession,
    _actor: AuthContext = require_permission("asset_models", "view"),
) -> list[AssetCategoryOut]:
    cats = (await db.scalars(
        select(AssetCategory).order_by(AssetCategory.sort_order,
                                       AssetCategory.label))).all()
    return [AssetCategoryOut.model_validate(c) for c in cats]


# ── category vocabulary (devtools-gated, mirrors site-types) ────────

# every mutable column on AssetCategory is NOT NULL — an explicit null in a
# PATCH must 422 up front rather than blind-setattr into an IntegrityError.
# `is None` predicate, not falsy: sort_order=0 is a legitimate value.
NON_NULLABLE_CATEGORY_FIELDS = ("label", "description", "sort_order", "color")


@categories_router.post("/asset-categories", response_model=AssetCategoryOut,
                        status_code=201)
async def create_asset_category(
    body: AssetCategoryCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "add"),
) -> AssetCategoryOut:
    if await db.get(AssetCategory, body.key) is not None:
        raise HTTPException(status_code=409,
                            detail={"code": "asset_category_exists"})
    row = AssetCategory(
        key=body.key, label=body.label, description=body.description,
        sort_order=body.sort_order, color=body.color,
        updated_at=datetime.now(UTC),
    )
    db.add(row)
    audit(db, actor_id=actor.person.id, entity_type="asset_category",
          entity_id=body.key, action="create",
          changes=diff({}, snapshot(row, list(NON_NULLABLE_CATEGORY_FIELDS))))
    await db.commit()
    return AssetCategoryOut.model_validate(row)


@categories_router.patch("/asset-categories/{key}",
                         response_model=AssetCategoryOut)
async def update_asset_category(
    key: str,
    body: AssetCategoryUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> AssetCategoryOut:
    row = await db.get(AssetCategory, key)
    if row is None:
        raise HTTPException(status_code=404,
                            detail={"code": "asset_category_not_found"})
    data = body.model_dump(exclude_unset=True)
    for field in NON_NULLABLE_CATEGORY_FIELDS:
        if field in data and data[field] is None:
            raise HTTPException(status_code=422,
                                detail={"code": f"{field}_required"})
    fields = list(NON_NULLABLE_CATEGORY_FIELDS)
    before = snapshot(row, fields)
    for field, value in data.items():
        setattr(row, field, value)
    changes = diff(before, snapshot(row, fields))
    if changes:
        row.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="asset_category",
              entity_id=key, action="update", changes=changes)
    await db.commit()
    return AssetCategoryOut.model_validate(row)
