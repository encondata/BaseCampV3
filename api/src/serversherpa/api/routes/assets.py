"""Assets — the core hardware registry (legacy BaseCamp assets). Client
org roles see their own org's rows read-only (SCOPE_COLUMNS); all writes
are globally anchored. The embedded model summary (AssetModelRef) is the
only catalog surface a client actor ever receives."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    AssetCreateIn, AssetItem, AssetModelRef, AssetMoveRow, AssetUpdateIn,
)
from serversherpa.db.models import (
    Asset, AssetCategory, AssetModel, Client, Initiative, InitiativeAsset,
    Site, StatusValue,
)
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.status.labels import UNKNOWN_COLOR, status_labels

router = APIRouter(prefix="/assets", tags=["assets"])

ASSET_FIELDS = [
    "serial_number", "name", "rfid_tag", "pod_number", "model_id",
    "client_id", "site_id", "location_detail", "status", "has_rails",
]
NON_NULLABLE_ASSET_FIELDS = ("location_detail", "status")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _require_global(actor: AuthContext) -> None:
    if not actor.access.is_global:
        raise _err(403, "forbidden")


async def _get_asset(db: DbSession, asset_id: uuid.UUID, actor: AuthContext) -> Asset:
    """404 for missing AND out-of-scope — an actor must not learn an id exists."""
    asset = await db.get(Asset, asset_id)
    if asset is None:
        raise _err(404, "asset_not_found")
    cond = scope_conditions("assets", actor.access, actor.person.id)
    if cond is not None:
        visible = await db.scalar(select(Asset.id).where(Asset.id == asset_id, cond))
        if visible is None:
            raise _err(404, "asset_not_found")
    return asset


async def _statuses(db: DbSession) -> dict:
    return {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "asset"))}


async def _model_refs(db: DbSession, model_ids: set[uuid.UUID]) -> dict:
    if not model_ids:
        return {}
    cats = {c.key: (c.label, c.color)
            for c in await db.scalars(select(AssetCategory))}
    models = (await db.scalars(
        select(AssetModel).where(AssetModel.id.in_(model_ids)))).all()
    out = {}
    for m in models:
        label, color = (cats.get(m.category, (m.category, "#51606f"))
                        if m.category is not None else (None, None))
        out[m.id] = AssetModelRef(
            id=m.id, make=m.make, model=m.model, category=m.category,
            category_label=label, category_color=color, ru_size=m.ru_size)
    return out


def _item(a: Asset, statuses: dict, models: dict, clients: dict,
          sites: dict) -> dict:
    label, color = statuses.get(a.status, (a.status, "#51606f"))
    return {
        "id": a.id, "legacy_id": a.legacy_id,
        "serial_number": a.serial_number, "name": a.name,
        "rfid_tag": a.rfid_tag, "pod_number": a.pod_number,
        "model_id": a.model_id,
        "model": models.get(a.model_id),
        "client_id": a.client_id, "client_name": clients.get(a.client_id),
        "site_id": a.site_id, "site_name": sites.get(a.site_id),
        "location_detail": a.location_detail,
        "status": a.status, "status_label": label, "status_color": color,
        "has_rails": a.has_rails, "last_seen_at": a.last_seen_at,
        "archived_at": a.archived_at, "created_at": a.created_at,
    }


async def _context(db: DbSession, assets: list[Asset]) -> tuple:
    statuses = await _statuses(db)
    models = await _model_refs(db, {a.model_id for a in assets if a.model_id})
    client_ids = {a.client_id for a in assets if a.client_id}
    clients = dict((await db.execute(
        select(Client.id, Client.name).where(Client.id.in_(client_ids))
    )).all()) if client_ids else {}
    site_ids = {a.site_id for a in assets if a.site_id}
    sites = dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(site_ids))
    )).all()) if site_ids else {}
    return statuses, models, clients, sites


async def _detail(db: DbSession, asset: Asset) -> AssetItem:
    statuses, models, clients, sites = await _context(db, [asset])
    return AssetItem(**_item(asset, statuses, models, clients, sites))


@router.get("", response_model=list[AssetItem])
async def list_assets(
    db: DbSession,
    actor: AuthContext = require_permission("assets", "view"),
) -> list[AssetItem]:
    query = select(Asset).order_by(Asset.created_at.desc())
    cond = scope_conditions("assets", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    assets = (await db.scalars(query)).all()
    statuses, models, clients, sites = await _context(db, list(assets))
    return [AssetItem(**_item(a, statuses, models, clients, sites))
            for a in assets]


@router.get("/{asset_id}", response_model=AssetItem)
async def get_asset(
    asset_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("assets", "view"),
) -> AssetItem:
    asset = await _get_asset(db, asset_id, actor)
    return await _detail(db, asset)


@router.get("/{asset_id}/moves", response_model=list[AssetMoveRow])
async def list_asset_moves(
    asset_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("assets", "view"),
) -> list[AssetMoveRow]:
    """Every move roster this asset has appeared on, newest scheduled first.

    Scoped by INITIATIVE, not only by asset: one asset can sit on two
    clients' moves, and a client-anchored actor must not learn another
    client's move exists through an asset they can legitimately see."""
    await _get_asset(db, asset_id, actor)

    query = (
        select(InitiativeAsset, Initiative)
        .join(Initiative, Initiative.id == InitiativeAsset.initiative_id)
        .where(InitiativeAsset.asset_id == asset_id)
        .order_by(Initiative.scheduled_start.desc().nullslast(),
                  InitiativeAsset.created_at.desc())
    )
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    rows = (await db.execute(query)).all()

    init_labels = await status_labels(db, "initiative")
    asset_labels = await _statuses(db)
    out: list[AssetMoveRow] = []
    for row, init in rows:
        i_label, i_color = init_labels.get(init.status, (init.status, UNKNOWN_COLOR))
        a_label, a_color = asset_labels.get(row.status, (row.status, UNKNOWN_COLOR))
        out.append(AssetMoveRow(
            row_id=row.id, initiative_id=init.id, initiative_name=init.name,
            initiative_status=init.status, initiative_status_label=i_label,
            initiative_status_color=i_color,
            asset_status=row.status, asset_status_label=a_label,
            asset_status_color=a_color,
            scheduled_start=init.scheduled_start, scheduled_end=init.scheduled_end,
            added_at=row.created_at))
    return out


async def _check_refs(db: DbSession, data: dict) -> None:
    if data.get("model_id") is not None and \
            await db.get(AssetModel, data["model_id"]) is None:
        raise _err(422, "asset_model_not_found")
    if data.get("client_id") is not None and \
            await db.get(Client, data["client_id"]) is None:
        raise _err(422, "client_not_found")
    if data.get("site_id") is not None and \
            await db.get(Site, data["site_id"]) is None:
        raise _err(422, "site_not_found")
    if data.get("status") is not None and await db.scalar(
        select(StatusValue).where(StatusValue.record_type == "asset",
                                  StatusValue.key == data["status"])) is None:
        raise _err(422, "unknown_status")


async def _check_rfid(db: DbSession, tag: str | None,
                      exclude: uuid.UUID | None = None) -> None:
    if tag is None:
        return
    query = select(Asset.id).where(Asset.rfid_tag == tag)
    if exclude is not None:
        query = query.where(Asset.id != exclude)
    if await db.scalar(query) is not None:
        raise _err(409, "rfid_tag_in_use")


@router.post("", response_model=AssetItem, status_code=201)
async def create_asset(
    body: AssetCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("assets", "add"),
) -> AssetItem:
    _require_global(actor)
    data = body.model_dump(exclude_none=True)
    await _check_refs(db, data)
    await _check_rfid(db, data.get("rfid_tag"))
    asset = Asset(**data, created_by=actor.person.id)
    db.add(asset)
    await db.flush()
    initial = snapshot(asset, ASSET_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items() if value not in (None, "")}
    audit(db, actor_id=actor.person.id, entity_type="asset",
          entity_id=str(asset.id), action="create", changes=changes)
    await db.commit()
    return await _detail(db, asset)


@router.patch("/{asset_id}", response_model=AssetItem)
async def update_asset(
    asset_id: uuid.UUID,
    body: AssetUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("assets", "change"),
) -> AssetItem:
    _require_global(actor)
    asset = await _get_asset(db, asset_id, actor)
    data = body.model_dump(exclude_unset=True)
    for field in NON_NULLABLE_ASSET_FIELDS:
        if field in data and data[field] is None:
            raise _err(422, f"{field}_required")
    await _check_refs(db, data)
    if "rfid_tag" in data:
        await _check_rfid(db, data["rfid_tag"], exclude=asset_id)

    fields = list(data.keys())
    before = snapshot(asset, fields)
    for field, value in data.items():
        setattr(asset, field, value)
    changes = diff(before, snapshot(asset, fields))
    if changes:
        asset.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="asset",
              entity_id=str(asset_id), action="update", changes=changes)
    await db.commit()
    return await _detail(db, asset)


@router.post("/{asset_id}/archive", status_code=204)
async def archive_asset(
    asset_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("assets", "delete"),
) -> None:
    _require_global(actor)
    asset = await _get_asset(db, asset_id, actor)
    asset.archived_at = datetime.now(UTC)
    asset.updated_at = asset.archived_at
    audit(db, actor_id=actor.person.id, entity_type="asset",
          entity_id=str(asset_id), action="archive")
    await db.commit()


@router.post("/{asset_id}/unarchive", status_code=204)
async def unarchive_asset(
    asset_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("assets", "delete"),
) -> None:
    _require_global(actor)
    asset = await _get_asset(db, asset_id, actor)
    asset.archived_at = None
    asset.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="asset",
          entity_id=str(asset_id), action="restore")
    await db.commit()
