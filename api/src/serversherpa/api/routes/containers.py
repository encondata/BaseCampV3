"""Containers — logistics transport containers (legacy V2 containers).
Internal-only resource; all actors are globally anchored. Asset
membership endpoints live here too (the container is the aggregate
root); the join table enforces one-container-per-asset."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    ContainerAssetRow, ContainerAssetsAddIn, ContainerCreateIn, ContainerItem,
    ContainerUpdateIn,
)
from serversherpa.db.models import (
    Asset, AssetModel, Container, ContainerAsset, Person, Site, StatusValue,
)
from serversherpa.logistics import bulk_import as bulk
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


# ── bulk import ────────────────────────────────────────────────────
# Declared ABOVE get_container: /containers/bulk-import/* must never be
# swallowed by GET /containers/{container_id} (which would 422 on the
# non-UUID segment).

def _bulk_err(exc: bulk.BulkImportError) -> HTTPException:
    return _err(422, exc.code, **exc.extra)


@router.get("/bulk-import/template")
async def bulk_import_template(
    fmt: str = "csv",
    actor: AuthContext = require_permission("containers", "add"),
) -> Response:
    if fmt == "csv":
        return Response(
            content=bulk.build_template_csv(), media_type="text/csv",
            headers={"Content-Disposition":
                     'attachment; filename="containers-template.csv"'})
    raise _err(422, "unsupported_format")


@router.post("/bulk-import/preview")
async def bulk_import_preview(
    body: dict,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "add"),
) -> dict:
    try:
        numbered = bulk.number_json_rows(body.get("rows"))
        return {"rows": await bulk.preview_rows(db, numbered)}
    except bulk.BulkImportError as exc:
        raise _bulk_err(exc) from exc


@router.post("/bulk-import/commit")
async def bulk_import_commit(
    body: dict,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "add"),
) -> dict:
    try:
        numbered = bulk.number_json_rows(body.get("rows"))
        return await bulk.commit_rows(db, actor.person.id, numbered)
    except bulk.BulkImportError as exc:
        raise _bulk_err(exc) from exc


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
    if not data.get("name"):
        raise _err(422, "name_required")
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
        if field in data and not data[field]:
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


async def _asset_rows(db: DbSession,
                      container_id: uuid.UUID) -> list[ContainerAssetRow]:
    rows = (await db.execute(
        select(ContainerAsset, Asset)
        .join(Asset, Asset.id == ContainerAsset.asset_id)
        .where(ContainerAsset.container_id == container_id)
        .order_by(ContainerAsset.added_at))).all()
    statuses = {s.key: (s.label, s.color) for s in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "asset"))}
    model_ids = {a.model_id for _, a in rows if a.model_id}
    models = dict((await db.execute(
        select(AssetModel.id, AssetModel.make + " " + AssetModel.model)
        .where(AssetModel.id.in_(model_ids)))).all()) if model_ids else {}
    person_ids = {m.added_by for m, _ in rows if m.added_by}
    people = dict((await db.execute(
        select(Person.id, Person.first_name + " " + Person.last_name)
        .where(Person.id.in_(person_ids)))).all()) if person_ids else {}
    out = []
    for membership, asset in rows:
        label, color = statuses.get(asset.status, (asset.status, "#51606f"))
        out.append(ContainerAssetRow(
            asset_id=asset.id, serial_number=asset.serial_number,
            name=asset.name, model_name=models.get(asset.model_id),
            status=asset.status, status_label=label, status_color=color,
            added_at=membership.added_at,
            added_by_name=people.get(membership.added_by)))
    return out


@router.get("/{container_id}/assets", response_model=list[ContainerAssetRow])
async def list_container_assets(
    container_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "view"),
) -> list[ContainerAssetRow]:
    await _get_container(db, container_id)
    return await _asset_rows(db, container_id)


@router.post("/{container_id}/assets", response_model=list[ContainerAssetRow])
async def add_container_assets(
    container_id: uuid.UUID,
    body: ContainerAssetsAddIn,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "change"),
) -> list[ContainerAssetRow]:
    container = await _get_container(db, container_id)
    ids = list(dict.fromkeys(body.asset_ids))  # dedupe, keep order
    if not ids:
        raise _err(422, "asset_ids_required")
    found = set(await db.scalars(select(Asset.id).where(Asset.id.in_(ids))))
    if missing := [i for i in ids if i not in found]:
        raise _err(422, "asset_not_found", asset_ids=[str(i) for i in missing])

    taken = (await db.execute(
        select(ContainerAsset.asset_id, Container.id, Container.name)
        .join(Container, Container.id == ContainerAsset.container_id)
        .where(ContainerAsset.asset_id.in_(ids)))).all()
    if conflicts := [
        {"asset_id": str(aid), "container_id": str(cid), "container_name": name}
        for aid, cid, name in taken if cid != container_id
    ]:
        raise _err(409, "assets_in_containers", conflicts=conflicts)

    already = {aid for aid, cid, _ in taken if cid == container_id}
    added = [i for i in ids if i not in already]
    for asset_id in added:
        db.add(ContainerAsset(container_id=container_id, asset_id=asset_id,
                              added_by=actor.person.id))
    if added:
        container.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="container",
              entity_id=str(container_id), action="assets_add",
              changes={"asset_ids": {
                  "from": None, "to": [str(i) for i in added]}})
    await db.commit()
    return await _asset_rows(db, container_id)


@router.delete("/{container_id}/assets/{asset_id}", status_code=204)
async def remove_container_asset(
    container_id: uuid.UUID,
    asset_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "change"),
) -> None:
    container = await _get_container(db, container_id)
    membership = await db.scalar(select(ContainerAsset).where(
        ContainerAsset.container_id == container_id,
        ContainerAsset.asset_id == asset_id))
    if membership is None:
        raise _err(404, "membership_not_found")
    await db.delete(membership)
    container.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="container",
          entity_id=str(container_id), action="assets_remove",
          changes={"asset_ids": {"from": [str(asset_id)], "to": None}})
    await db.commit()
