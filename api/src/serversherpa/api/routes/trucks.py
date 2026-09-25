"""Trucks — logistics truckloads on a move (V2 parity). Internal-only
resource; all actors are globally anchored (mirrors containers.py)."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Request, Response
from sqlalchemy import delete, func, select

from serversherpa.api.bulk_routes import bulk_http_error, require_bulk_rank, rows_from_request
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    TruckContainerOut, TruckCreateIn, TruckDetail, TruckItem,
    TruckLastUpdate, TruckMapPoint, TruckTrailPoint, TruckUpdateCreateIn,
    TruckUpdateIn, TruckUpdateOut,
)
from serversherpa.db.models import (
    Container, ContainerAsset, Initiative, Site, StatusValue, Truck,
    TruckContainer, TruckUpdate,
)
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.trucks import bulk_import as bulk
from serversherpa.trucks.bulk_create import TRUCK_FIELDS
from serversherpa.trucks.location import LocationError, format_location, parse_location

router = APIRouter(prefix="/trucks", tags=["trucks"])

NON_NULLABLE_FIELDS = ("name", "status", "contact_info", "team_drive", "tracking_type")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _get_truck(db: DbSession, truck_id: uuid.UUID) -> Truck:
    truck = await db.get(Truck, truck_id)
    if truck is None:
        raise _err(404, "truck_not_found")
    return truck


async def _vocab(db: DbSession) -> tuple[dict, dict]:
    rows = (await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(("truck", "container"))))).all()
    statuses = {s.key: (s.label, s.color)
                for s in rows if s.record_type == "truck"}
    container_statuses = {s.key: (s.label, s.color)
                          for s in rows if s.record_type == "container"}
    return statuses, container_statuses


async def _truck_statuses(db: DbSession) -> dict:
    statuses, _ = await _vocab(db)
    return statuses


async def _context(db: DbSession, trucks: list[Truck]) -> tuple:
    statuses, container_statuses = await _vocab(db)

    initiative_ids = {t.initiative_id for t in trucks if t.initiative_id}
    initiatives = dict((await db.execute(
        select(Initiative.id, Initiative.name)
        .where(Initiative.id.in_(initiative_ids))
    )).all()) if initiative_ids else {}

    site_ids = ({t.start_site_id for t in trucks if t.start_site_id} |
                {t.end_site_id for t in trucks if t.end_site_id})
    sites = dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(site_ids))
    )).all()) if site_ids else {}

    ids = [t.id for t in trucks]
    counts = dict((await db.execute(
        select(TruckContainer.truck_id, func.count())
        .where(TruckContainer.truck_id.in_(ids))
        .group_by(TruckContainer.truck_id)
    )).all()) if ids else {}

    last_updates: dict[uuid.UUID, TruckUpdate] = {}
    if ids:
        rows = (await db.scalars(
            select(TruckUpdate).distinct(TruckUpdate.truck_id)
            .where(TruckUpdate.truck_id.in_(ids))
            .order_by(TruckUpdate.truck_id, TruckUpdate.recorded_at.desc())
        )).all()
        last_updates = {u.truck_id: u for u in rows}

    return statuses, container_statuses, initiatives, sites, counts, last_updates


def _item(t: Truck, statuses: dict, container_statuses: dict,
          initiatives: dict, sites: dict, counts: dict,
          last_updates: dict) -> dict:
    label, color = statuses.get(t.status, (t.status, "#51606f"))
    last = last_updates.get(t.id)
    last_update = None
    if last is not None:
        last_update = TruckLastUpdate(
            recorded_at=last.recorded_at, lat=last.lat, lng=last.lng,
            approximate_address=last.approximate_address)
    return {
        "id": t.id, "legacy_id": t.legacy_id, "name": t.name,
        "driver_name": t.driver_name, "co_driver_name": t.co_driver_name,
        "team_drive": t.team_drive, "contact_info": t.contact_info,
        "status": t.status, "status_label": label, "status_color": color,
        "load_number": t.load_number, "seal_id": t.seal_id,
        "tracking_type": t.tracking_type,
        "initiative_id": t.initiative_id,
        "initiative_name": initiatives.get(t.initiative_id),
        "start_site_id": t.start_site_id,
        "start_site_name": sites.get(t.start_site_id),
        "end_site_id": t.end_site_id,
        "end_site_name": sites.get(t.end_site_id),
        "container_count": counts.get(t.id, 0),
        "last_update": last_update,
        "archived_at": t.archived_at, "created_at": t.created_at,
        "updated_at": t.updated_at,
    }


async def _truck_containers(db: DbSession, truck_id: uuid.UUID,
                            container_statuses: dict) -> list[TruckContainerOut]:
    rows = list((await db.scalars(
        select(Container).join(
            TruckContainer, TruckContainer.container_id == Container.id)
        .where(TruckContainer.truck_id == truck_id)
        .order_by(Container.name))))
    ids = [c.id for c in rows]
    asset_counts = dict((await db.execute(
        select(ContainerAsset.container_id, func.count())
        .where(ContainerAsset.container_id.in_(ids))
        .group_by(ContainerAsset.container_id)
    )).all()) if ids else {}
    out = []
    for c in rows:
        label, color = container_statuses.get(c.status, (c.status, "#51606f"))
        out.append(TruckContainerOut(
            id=c.id, name=c.name, status=c.status,
            status_label=label, status_color=color,
            asset_count=asset_counts.get(c.id, 0)))
    return out


async def _detail(db: DbSession, truck: Truck) -> TruckDetail:
    ctx = await _context(db, [truck])
    item = _item(truck, *ctx)
    item["containers"] = await _truck_containers(db, truck.id, ctx[1])
    return TruckDetail(**item)


@router.get("", response_model=list[TruckItem])
async def list_trucks(
    db: DbSession,
    include_archived: bool = False,
    actor: AuthContext = require_permission("trucks", "view"),
) -> list[TruckItem]:
    query = select(Truck).order_by(Truck.created_at.desc())
    if not include_archived:
        query = query.where(Truck.archived_at.is_(None))
    trucks = list(await db.scalars(query))
    ctx = await _context(db, trucks)
    return [TruckItem(**_item(t, *ctx)) for t in trucks]


# ── map ────────────────────────────────────────────────────────────
# Declared ABOVE get_truck: /trucks/map must never be swallowed by
# GET /trucks/{truck_id} (which would 422 on the non-UUID segment).

@router.get("/map", response_model=list[TruckMapPoint])
async def trucks_map(
    db: DbSession, trails: bool = False,
    actor: AuthContext = require_permission("trucks", "view"),
) -> list[TruckMapPoint]:
    latest = (select(TruckUpdate)
              .distinct(TruckUpdate.truck_id)
              .order_by(TruckUpdate.truck_id, TruckUpdate.recorded_at.desc())
              .subquery())
    rows = (await db.execute(
        select(Truck, latest.c.recorded_at, latest.c.lat, latest.c.lng,
               latest.c.approximate_address)
        .join(latest, latest.c.truck_id == Truck.id)
        .where(Truck.archived_at.is_(None), Truck.status != "historical",
               latest.c.lat.isnot(None), latest.c.lng.isnot(None))
        .order_by(Truck.name))).all()
    statuses = await _truck_statuses(db)
    out = []
    for t, at, lat, lng, addr in rows:
        label, color = statuses.get(t.status, (t.status, "#51606f"))
        trail = []
        if trails:
            trail = [TruckTrailPoint(recorded_at=u.recorded_at, lat=u.lat, lng=u.lng)
                     for u in await db.scalars(
                         select(TruckUpdate).where(
                             TruckUpdate.truck_id == t.id,
                             TruckUpdate.lat.isnot(None))
                         .order_by(TruckUpdate.recorded_at))]
        out.append(TruckMapPoint(
            id=t.id, name=t.name, status=t.status, status_label=label,
            status_color=color, driver_name=t.driver_name,
            load_number=t.load_number, seal_id=t.seal_id,
            last_update=TruckLastUpdate(recorded_at=at, lat=lat, lng=lng,
                                        approximate_address=addr),
            trail=trail))
    return out


# ── bulk import ────────────────────────────────────────────────────
# Declared ABOVE get_truck, like /map: /trucks/bulk-import/* must never be
# swallowed by GET /trucks/{truck_id}.

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _attachment(filename: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


@router.get("/bulk-import/template")
async def bulk_import_template(
    db: DbSession,
    format: str = "csv",
    actor: AuthContext = require_permission("trucks", "add"),
):
    require_bulk_rank(actor)
    if format == "csv":
        return Response(bulk.build_template_csv(), media_type="text/csv",
                        headers=_attachment("trucks-template.csv"))
    if format == "xlsx":
        statuses, initiatives, sites = await bulk.reference_lists(db)
        return Response(bulk.build_template_xlsx(statuses, initiatives, sites),
                        media_type=_XLSX, headers=_attachment("trucks-template.xlsx"))
    raise _err(422, "unknown_format")


@router.get("/bulk-import/export")
async def bulk_import_export(
    db: DbSession,
    format: str = "xlsx",
    actor: AuthContext = require_permission("trucks", "add"),
):
    """The current trucks in the template's layout — fill in, re-upload."""
    require_bulk_rank(actor)
    if format not in ("csv", "xlsx"):
        raise _err(422, "unknown_format")
    rows = await bulk.export_rows(db)
    if format == "csv":
        return Response(bulk.build_rows_csv(rows), media_type="text/csv",
                        headers=_attachment("trucks-export.csv"))
    statuses, initiatives, sites = await bulk.reference_lists(db)
    return Response(bulk.build_rows_xlsx(rows, statuses, initiatives, sites),
                    media_type=_XLSX, headers=_attachment("trucks-export.xlsx"))


@router.post("/bulk-import/preview")
async def bulk_import_preview(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "add"),
) -> dict:
    require_bulk_rank(actor)
    numbered = await rows_from_request(
        request, parse_upload=bulk.parse_upload, number_json_rows=bulk.number_json_rows)
    return await bulk.preview_rows(db, numbered)


@router.post("/bulk-import/commit")
async def bulk_import_commit(
    request: Request,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "add"),
) -> dict:
    require_bulk_rank(actor)
    # updates go through here too, so the change permission is required as well
    if not actor.access.can("trucks", "change"):
        raise _err(403, "forbidden")
    try:
        body = await request.json()
    except ValueError:
        raise _err(422, "invalid_json") from None
    try:
        numbered = bulk.number_json_rows(body.get("rows"))
    except bulk.BulkImportError as exc:
        raise bulk_http_error(exc) from None
    approved = {str(s) for s in body.get("approved_updates") or []}
    try:
        return await bulk.commit_rows(
            db, actor.person.id, numbered, approved_updates=approved,
            source_label=str(body.get("source") or "upload"))
    except bulk.BulkImportError as exc:
        raise bulk_http_error(exc) from None


@router.get("/{truck_id}", response_model=TruckDetail)
async def get_truck(
    truck_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "view"),
) -> TruckDetail:
    return await _detail(db, await _get_truck(db, truck_id))


async def _check_refs(db: DbSession, data: dict) -> None:
    for field in ("start_site_id", "end_site_id"):
        if data.get(field) is not None and \
                await db.get(Site, data[field]) is None:
            raise _err(422, "site_not_found")
    if data.get("initiative_id") is not None and \
            await db.get(Initiative, data["initiative_id"]) is None:
        raise _err(422, "initiative_not_found")
    if data.get("status") is not None and await db.scalar(
        select(StatusValue).where(
            StatusValue.record_type == "truck",
            StatusValue.key == data["status"])) is None:
        raise _err(422, "unknown_status")
    container_ids = data.get("container_ids") or []
    if container_ids:
        found = set(await db.scalars(
            select(Container.id).where(Container.id.in_(container_ids))))
        if missing := [i for i in container_ids if i not in found]:
            raise _err(422, "container_not_found",
                      container_ids=[str(i) for i in missing])


@router.post("", response_model=TruckDetail, status_code=201)
async def create_truck(
    body: TruckCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "add"),
) -> TruckDetail:
    data = body.model_dump(exclude={"container_ids"})
    data["name"] = (data.get("name") or "").strip()
    if not data["name"]:
        raise _err(422, "name_required")
    await _check_refs(db, {**data, "container_ids": body.container_ids})
    truck = Truck(**data, created_by=actor.person.id)
    db.add(truck)
    await db.flush()
    for container_id in dict.fromkeys(body.container_ids):
        db.add(TruckContainer(truck_id=truck.id, container_id=container_id))
    initial = snapshot(truck, TRUCK_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items()
               if value not in (None, "", {}, False)}
    audit(db, actor_id=actor.person.id, entity_type="truck",
          entity_id=str(truck.id), action="create", changes=changes)
    await db.commit()
    return await _detail(db, truck)


@router.patch("/{truck_id}", response_model=TruckDetail)
async def update_truck(
    truck_id: uuid.UUID,
    body: TruckUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "change"),
) -> TruckDetail:
    truck = await _get_truck(db, truck_id)
    data = body.model_dump(exclude_unset=True)
    for field in NON_NULLABLE_FIELDS:
        if field in data and data[field] is None:
            raise _err(422, f"{field}_required")
    container_ids = data.pop("container_ids", None)
    if "name" in data:
        data["name"] = (data["name"] or "").strip()
        if not data["name"]:
            raise _err(422, "name_required")
    await _check_refs(db, {**data, "container_ids": container_ids or []})

    fields = list(data.keys())
    before = snapshot(truck, fields)
    for field, value in data.items():
        setattr(truck, field, value)
    changes = diff(before, snapshot(truck, fields))

    if container_ids is not None:
        existing = set(await db.scalars(
            select(TruckContainer.container_id)
            .where(TruckContainer.truck_id == truck_id)))
        new_ids = set(dict.fromkeys(container_ids))
        if new_ids != existing:
            for container_id in existing - new_ids:
                await db.execute(delete(TruckContainer).where(
                    TruckContainer.truck_id == truck_id,
                    TruckContainer.container_id == container_id))
            for container_id in new_ids - existing:
                db.add(TruckContainer(truck_id=truck_id, container_id=container_id))
            changes["container_ids"] = {
                "from": [str(i) for i in existing],
                "to": [str(i) for i in new_ids]}

    if changes:
        truck.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="truck",
              entity_id=str(truck_id), action="update", changes=changes)
    await db.commit()
    return await _detail(db, truck)


@router.post("/{truck_id}/archive", status_code=204)
async def archive_truck(
    truck_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "delete"),
) -> None:
    truck = await _get_truck(db, truck_id)
    truck.archived_at = datetime.now(UTC)
    truck.updated_at = truck.archived_at
    audit(db, actor_id=actor.person.id, entity_type="truck",
          entity_id=str(truck_id), action="archive")
    await db.commit()


@router.post("/{truck_id}/unarchive", status_code=204)
async def unarchive_truck(
    truck_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "delete"),
) -> None:
    truck = await _get_truck(db, truck_id)
    truck.archived_at = None
    truck.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="truck",
          entity_id=str(truck_id), action="restore")
    await db.commit()


def _update_out(u: TruckUpdate) -> TruckUpdateOut:
    return TruckUpdateOut(
        id=u.id, truck_id=u.truck_id, recorded_at=u.recorded_at,
        location=u.location, lat=u.lat, lng=u.lng,
        approximate_address=u.approximate_address, source=u.source)


@router.get("/{truck_id}/updates", response_model=list[TruckUpdateOut])
async def list_truck_updates(
    truck_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "view"),
) -> list[TruckUpdateOut]:
    await _get_truck(db, truck_id)
    rows = await db.scalars(
        select(TruckUpdate).where(TruckUpdate.truck_id == truck_id)
        .order_by(TruckUpdate.recorded_at.desc()))
    return [_update_out(u) for u in rows]


@router.post("/{truck_id}/updates", response_model=TruckUpdateOut, status_code=201)
async def create_truck_update(
    truck_id: uuid.UUID,
    body: TruckUpdateCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "change"),
) -> TruckUpdateOut:
    await _get_truck(db, truck_id)
    try:
        lat, lng = parse_location(body.location)
    except LocationError as exc:
        raise _err(422, "invalid_location") from exc
    # Always store the canonical "lat, lng" text — a hand-typed "34.0007,-81"
    # and a tracker's {lat, lng} render identically in the updates table.
    location = format_location(lat, lng)
    update = TruckUpdate(
        truck_id=truck_id, recorded_at=body.recorded_at or datetime.now(UTC),
        location=location, lat=lat, lng=lng,
        approximate_address=body.approximate_address, source=body.source)
    db.add(update)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="truck",
          entity_id=str(truck_id), action="update_location",
          changes={"location": {"from": None, "to": location}})
    await db.commit()
    return _update_out(update)


@router.delete("/{truck_id}/updates", status_code=204)
async def clear_truck_updates(
    truck_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("trucks", "delete"),
) -> None:
    await _get_truck(db, truck_id)
    await db.execute(delete(TruckUpdate).where(TruckUpdate.truck_id == truck_id))
    audit(db, actor_id=actor.person.id, entity_type="truck",
          entity_id=str(truck_id), action="clear_updates")
    await db.commit()
