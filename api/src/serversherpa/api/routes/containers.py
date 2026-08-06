"""Containers — logistics transport containers (legacy V2 containers).
Internal-only resource; all actors are globally anchored. Asset
membership endpoints live here too (the container is the aggregate
root); the join table enforces one-container-per-asset."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    ContainerCreateIn, ContainerItem, ContainerUpdateIn,
)
from serversherpa.db.models import Container, ContainerAsset, Site, StatusValue
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/containers", tags=["containers"])

CONTAINER_FIELDS = [
    "name", "rfid_tag", "container_type", "status", "site_id",
    "location_detail",
]
NON_NULLABLE_FIELDS = ("name", "location_detail", "status")


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _get_container(db: DbSession, container_id: uuid.UUID) -> Container:
    container = await db.get(Container, container_id)
    if container is None:
        raise _err(404, "container_not_found")
    return container


async def _vocab(db: DbSession) -> tuple[dict, dict]:
    rows = (await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(("container", "container_type"))))).all()
    statuses = {s.key: (s.label, s.color)
                for s in rows if s.record_type == "container"}
    types = {s.key: (s.label, s.color)
             for s in rows if s.record_type == "container_type"}
    return statuses, types


async def _context(db: DbSession, containers: list[Container]) -> tuple:
    statuses, types = await _vocab(db)
    site_ids = {c.site_id for c in containers if c.site_id}
    sites = dict((await db.execute(
        select(Site.id, Site.name).where(Site.id.in_(site_ids))
    )).all()) if site_ids else {}
    ids = [c.id for c in containers]
    counts = dict((await db.execute(
        select(ContainerAsset.container_id, func.count())
        .where(ContainerAsset.container_id.in_(ids))
        .group_by(ContainerAsset.container_id)
    )).all()) if ids else {}
    return statuses, types, sites, counts


def _item(c: Container, statuses: dict, types: dict, sites: dict,
          counts: dict) -> dict:
    s_label, s_color = statuses.get(c.status, (c.status, "#51606f"))
    t_label, t_color = (types.get(c.container_type, (c.container_type, "#51606f"))
                        if c.container_type is not None else (None, None))
    return {
        "id": c.id, "name": c.name, "rfid_tag": c.rfid_tag,
        "container_type": c.container_type,
        "type_label": t_label, "type_color": t_color,
        "status": c.status, "status_label": s_label, "status_color": s_color,
        "site_id": c.site_id, "site_name": sites.get(c.site_id),
        "location_detail": c.location_detail,
        "asset_count": counts.get(c.id, 0),
        "last_audit_at": c.last_audit_at,
        "last_validated_at": c.last_validated_at,
        "archived_at": c.archived_at, "created_at": c.created_at,
    }


async def _detail(db: DbSession, container: Container) -> ContainerItem:
    statuses, types, sites, counts = await _context(db, [container])
    return ContainerItem(**_item(container, statuses, types, sites, counts))


@router.get("", response_model=list[ContainerItem])
async def list_containers(
    db: DbSession,
    actor: AuthContext = require_permission("containers", "view"),
) -> list[ContainerItem]:
    containers = list(await db.scalars(
        select(Container).order_by(Container.created_at.desc())))
    statuses, types, sites, counts = await _context(db, containers)
    return [ContainerItem(**_item(c, statuses, types, sites, counts))
            for c in containers]


@router.get("/{container_id}", response_model=ContainerItem)
async def get_container(
    container_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "view"),
) -> ContainerItem:
    return await _detail(db, await _get_container(db, container_id))


async def _check_refs(db: DbSession, data: dict) -> None:
    if data.get("site_id") is not None and \
            await db.get(Site, data["site_id"]) is None:
        raise _err(422, "site_not_found")
    for field, record_type, code in (
        ("status", "container", "unknown_status"),
        ("container_type", "container_type", "unknown_container_type"),
    ):
        if data.get(field) is not None and await db.scalar(
            select(StatusValue).where(
                StatusValue.record_type == record_type,
                StatusValue.key == data[field])) is None:
            raise _err(422, code)


async def _check_rfid(db: DbSession, tag: str | None,
                      exclude: uuid.UUID | None = None) -> None:
    if tag is None:
        return
    query = select(Container.id).where(Container.rfid_tag == tag)
    if exclude is not None:
        query = query.where(Container.id != exclude)
    if await db.scalar(query) is not None:
        raise _err(409, "rfid_tag_in_use")


@router.post("", response_model=ContainerItem, status_code=201)
async def create_container(
    body: ContainerCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "add"),
) -> ContainerItem:
    data = body.model_dump(exclude_none=True)
    await _check_refs(db, data)
    await _check_rfid(db, data.get("rfid_tag"))
    container = Container(**data, created_by=actor.person.id)
    db.add(container)
    await db.flush()
    initial = snapshot(container, CONTAINER_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items() if value not in (None, "")}
    audit(db, actor_id=actor.person.id, entity_type="container",
          entity_id=str(container.id), action="create", changes=changes)
    await db.commit()
    return await _detail(db, container)


@router.patch("/{container_id}", response_model=ContainerItem)
async def update_container(
    container_id: uuid.UUID,
    body: ContainerUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "change"),
) -> ContainerItem:
    container = await _get_container(db, container_id)
    data = body.model_dump(exclude_unset=True)
    for field in NON_NULLABLE_FIELDS:
        if field in data and data[field] is None:
            raise _err(422, f"{field}_required")
    await _check_refs(db, data)
    if "rfid_tag" in data:
        await _check_rfid(db, data["rfid_tag"], exclude=container_id)

    fields = list(data.keys())
    before = snapshot(container, fields)
    for field, value in data.items():
        setattr(container, field, value)
    changes = diff(before, snapshot(container, fields))
    if changes:
        container.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="container",
              entity_id=str(container_id), action="update", changes=changes)
    await db.commit()
    return await _detail(db, container)


@router.post("/{container_id}/archive", status_code=204)
async def archive_container(
    container_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "change"),
) -> None:
    container = await _get_container(db, container_id)
    container.archived_at = datetime.now(UTC)
    container.updated_at = container.archived_at
    audit(db, actor_id=actor.person.id, entity_type="container",
          entity_id=str(container_id), action="archive")
    await db.commit()


@router.post("/{container_id}/unarchive", status_code=204)
async def unarchive_container(
    container_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "change"),
) -> None:
    container = await _get_container(db, container_id)
    container.archived_at = None
    container.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="container",
          entity_id=str(container_id), action="restore")
    await db.commit()
