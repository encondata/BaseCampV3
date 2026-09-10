"""Warehouse inventory — per-site view of containers (with contents),
loose tagged assets, and counted stock lines; stock-line CRUD.

The warehouse API owns ONLY stock_lines. Containers and assets are read
here but written through their own routers/permissions."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    AssetRef, StockLineCreateIn, StockLineOut, StockLineUpdateIn,
    WarehouseContainerOut, WarehouseInventoryOut, WarehouseSiteOut,
)
from serversherpa.db.models import (
    Asset, AssetModel, Container, ContainerAsset, Site, StatusValue, StockLine,
)
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/warehouse", tags=["warehouse"])

STOCK_FIELDS = ("site_id", "container_id", "model_id", "description",
                "quantity", "unit", "location_detail", "notes")
NON_NULLABLE_FIELDS = ("site_id", "description", "quantity", "unit",
                       "location_detail", "notes")
FALLBACK = ("", "#51606f")


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def _vocab(db: DbSession, *record_types: str) -> dict[str, dict[str, tuple[str, str]]]:
    rows = await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(record_types)))
    out: dict[str, dict[str, tuple[str, str]]] = {rt: {} for rt in record_types}
    for s in rows:
        out[s.record_type][s.key] = (s.label, s.color)
    return out


async def _warehouse_site(db: DbSession, site_id: uuid.UUID) -> Site:
    site = await db.get(Site, site_id)
    if site is None or site.archived_at is not None:
        raise _err(404, "site_not_found")
    if site.site_type != "warehouse":
        raise _err(422, "site_not_warehouse")
    return site


async def _site_counts(db: DbSession, site_ids: list[uuid.UUID]) -> dict[uuid.UUID, dict]:
    counts = {sid: {"container_count": 0, "asset_count": 0,
                    "stock_line_count": 0, "stock_units": 0} for sid in site_ids}
    if not site_ids:
        return counts
    for sid, n in (await db.execute(
            select(Container.site_id, func.count())
            .where(Container.site_id.in_(site_ids), Container.archived_at.is_(None))
            .group_by(Container.site_id))).all():
        counts[sid]["container_count"] = n
    for sid, n in (await db.execute(
            select(Asset.site_id, func.count())
            .where(Asset.site_id.in_(site_ids), Asset.archived_at.is_(None))
            .group_by(Asset.site_id))).all():
        counts[sid]["asset_count"] = n
    for sid, n, units in (await db.execute(
            select(StockLine.site_id, func.count(),
                   func.coalesce(func.sum(StockLine.quantity), 0))
            .where(StockLine.site_id.in_(site_ids), StockLine.archived_at.is_(None))
            .group_by(StockLine.site_id))).all():
        counts[sid]["stock_line_count"] = n
        counts[sid]["stock_units"] = int(units)
    return counts


def _site_out(site: Site, statuses: dict, counts: dict) -> WarehouseSiteOut:
    label, color = statuses.get(site.status, (site.status, FALLBACK[1]))
    return WarehouseSiteOut(
        id=site.id, name=site.name, code=site.code, city=site.city,
        region=site.region, status=site.status, status_label=label,
        status_color=color, **counts)


async def _stock_out(db: DbSession, lines: list[StockLine]) -> list[StockLineOut]:
    if not lines:
        return []
    site_ids = {l.site_id for l in lines}
    sites = dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(site_ids)))).all())
    cids = {l.container_id for l in lines if l.container_id}
    containers = dict((await db.execute(
        select(Container.id, Container.name).where(Container.id.in_(cids)))).all()) if cids else {}
    mids = {l.model_id for l in lines if l.model_id}
    models = {m.id: m for m in await db.scalars(
        select(AssetModel).where(AssetModel.id.in_(mids)))} if mids else {}
    out = []
    for l in lines:
        m = models.get(l.model_id) if l.model_id else None
        out.append(StockLineOut(
            id=l.id, site_id=l.site_id, site_name=sites.get(l.site_id, ""),
            container_id=l.container_id,
            container_name=containers.get(l.container_id) if l.container_id else None,
            model_id=l.model_id, model_make=m.make if m else None,
            model_model=m.model if m else None,
            description=l.description, quantity=l.quantity, unit=l.unit,
            location_detail=l.location_detail, notes=l.notes,
            archived_at=l.archived_at, created_at=l.created_at,
            updated_at=l.updated_at))
    return out


def _asset_ref(a: Asset, statuses: dict, model_names: dict) -> AssetRef:
    label, color = statuses.get(a.status, (a.status, FALLBACK[1]))
    return AssetRef(
        id=a.id, legacy_id=a.legacy_id, serial_number=a.serial_number,
        name=a.name, model_name=model_names.get(a.model_id) if a.model_id else None,
        status=a.status, status_label=label, status_color=color,
        location_detail=a.location_detail)


@router.get("/sites", response_model=list[WarehouseSiteOut])
async def list_warehouse_sites(
    db: DbSession,
    actor: AuthContext = require_permission("warehouse", "view"),
) -> list[WarehouseSiteOut]:
    sites = list(await db.scalars(
        select(Site).where(Site.site_type == "warehouse", Site.archived_at.is_(None))
        .order_by(Site.name)))
    vocab = await _vocab(db, "site")
    counts = await _site_counts(db, [s.id for s in sites])
    return [_site_out(s, vocab["site"], counts[s.id]) for s in sites]


@router.get("/{site_id}/inventory", response_model=WarehouseInventoryOut)
async def warehouse_inventory(
    site_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("warehouse", "view"),
) -> WarehouseInventoryOut:
    site = await _warehouse_site(db, site_id)
    vocab = await _vocab(db, "site", "container", "container_type", "asset")
    counts = await _site_counts(db, [site.id])

    containers = list(await db.scalars(
        select(Container)
        .where(Container.site_id == site.id, Container.archived_at.is_(None))
        .order_by(Container.name)))
    cids = [c.id for c in containers]

    assets = list(await db.scalars(
        select(Asset).where(Asset.site_id == site.id, Asset.archived_at.is_(None))
        .order_by(Asset.name, Asset.serial_number)))
    membership = dict((await db.execute(
        select(ContainerAsset.asset_id, ContainerAsset.container_id)
        .where(ContainerAsset.container_id.in_(cids)))).all()) if cids else {}
    model_ids = {a.model_id for a in assets if a.model_id}
    model_names = {mid: f"{make} {model}" for mid, make, model in (await db.execute(
        select(AssetModel.id, AssetModel.make, AssetModel.model)
        .where(AssetModel.id.in_(model_ids)))).all()} if model_ids else {}

    lines = list(await db.scalars(
        select(StockLine)
        .where(StockLine.site_id == site.id, StockLine.archived_at.is_(None))
        .order_by(StockLine.description)))
    lines_out = await _stock_out(db, lines)

    by_container_assets: dict[uuid.UUID, list[AssetRef]] = {cid: [] for cid in cids}
    loose_assets: list[AssetRef] = []
    for a in assets:
        ref = _asset_ref(a, vocab["asset"], model_names)
        cid = membership.get(a.id)
        if cid in by_container_assets:
            by_container_assets[cid].append(ref)
        else:
            loose_assets.append(ref)
    by_container_stock: dict[uuid.UUID, list[StockLineOut]] = {cid: [] for cid in cids}
    loose_stock: list[StockLineOut] = []
    for l in lines_out:
        if l.container_id in by_container_stock:
            by_container_stock[l.container_id].append(l)
        else:
            loose_stock.append(l)

    containers_out = []
    for c in containers:
        s_label, s_color = vocab["container"].get(c.status, (c.status, FALLBACK[1]))
        t_label, t_color = (vocab["container_type"].get(c.container_type, (c.container_type, FALLBACK[1]))
                            if c.container_type else (None, None))
        containers_out.append(WarehouseContainerOut(
            id=c.id, name=c.name, rfid_tag=c.rfid_tag,
            container_type=c.container_type, type_label=t_label, type_color=t_color,
            status=c.status, status_label=s_label, status_color=s_color,
            location_detail=c.location_detail, updated_at=c.updated_at,
            assets=by_container_assets[c.id], stock=by_container_stock[c.id]))

    return WarehouseInventoryOut(
        site=_site_out(site, vocab["site"], counts[site.id]),
        containers=containers_out, loose_assets=loose_assets, loose_stock=loose_stock)


async def _check_placement(db: DbSession, site_id: uuid.UUID,
                           container_id: uuid.UUID | None, model_id: uuid.UUID | None) -> None:
    await _warehouse_site(db, site_id)
    if container_id is not None:
        container = await db.get(Container, container_id)
        if container is None or container.archived_at is not None:
            raise _err(404, "container_not_found")
        if container.site_id != site_id:
            raise _err(422, "container_not_at_site")
    if model_id is not None and await db.get(AssetModel, model_id) is None:
        raise _err(404, "model_not_found")


async def _get_line(db: DbSession, line_id: uuid.UUID) -> StockLine:
    line = await db.get(StockLine, line_id)
    if line is None:
        raise _err(404, "stock_line_not_found")
    return line


@router.post("/stock", response_model=StockLineOut, status_code=201)
async def create_stock_line(
    body: StockLineCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("warehouse", "add"),
) -> StockLineOut:
    data = body.model_dump()
    data["description"] = data["description"].strip()
    if not data["description"]:
        raise _err(422, "description_required")
    data["unit"] = data["unit"].strip() or "each"
    await _check_placement(db, data["site_id"], data["container_id"], data["model_id"])
    line = StockLine(**data, created_by=actor.person.id)
    db.add(line)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="stock_line",
          entity_id=str(line.id), action="create",
          changes=snapshot(line, STOCK_FIELDS))
    await db.commit()
    await db.refresh(line)
    return (await _stock_out(db, [line]))[0]


@router.patch("/stock/{line_id}", response_model=StockLineOut)
async def update_stock_line(
    line_id: uuid.UUID,
    body: StockLineUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("warehouse", "change"),
) -> StockLineOut:
    line = await _get_line(db, line_id)
    data = body.model_dump(exclude_unset=True)
    for field in NON_NULLABLE_FIELDS:
        if field in data and data[field] is None:
            raise _err(422, f"{field}_required")
    if "description" in data:
        data["description"] = data["description"].strip()
        if not data["description"]:
            raise _err(422, "description_required")
    if "unit" in data:
        data["unit"] = data["unit"].strip() or "each"
    site_id = data.get("site_id", line.site_id)
    container_id = data.get("container_id", line.container_id)
    model_id = data.get("model_id", line.model_id)
    if {"site_id", "container_id", "model_id"} & data.keys():
        await _check_placement(db, site_id, container_id, model_id)
    before = snapshot(line, STOCK_FIELDS)
    for k, v in data.items():
        setattr(line, k, v)
    line.updated_at = datetime.now(UTC)
    changes = diff(before, snapshot(line, STOCK_FIELDS))
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="stock_line",
              entity_id=str(line.id), action="update", changes=changes)
    await db.commit()
    await db.refresh(line)
    return (await _stock_out(db, [line]))[0]


@router.post("/stock/{line_id}/archive", status_code=204)
async def archive_stock_line(
    line_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("warehouse", "delete"),
) -> None:
    line = await _get_line(db, line_id)
    line.archived_at = datetime.now(UTC)
    line.updated_at = line.archived_at
    audit(db, actor_id=actor.person.id, entity_type="stock_line",
          entity_id=str(line.id), action="archive")
    await db.commit()


@router.post("/stock/{line_id}/unarchive", status_code=204)
async def unarchive_stock_line(
    line_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("warehouse", "delete"),
) -> None:
    line = await _get_line(db, line_id)
    line.archived_at = None
    line.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="stock_line",
          entity_id=str(line.id), action="unarchive")
    await db.commit()
