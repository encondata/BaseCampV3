"""Client groups — staff-only endpoints for a client's groups and the Owner
review list. Included before the stakeholders clients router so `/{org_id}`
routes there never swallow these paths."""

import uuid

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import func, select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    ClientGroupIn,
    ClientGroupOut,
    ClientGroupPatchIn,
    GroupMergeIn,
    GroupMergePlanOut,
    GroupReviewDismissIn,
    GroupReviewMatchIn,
    GroupReviewValueOut,
)
from serversherpa.clientgroups import service as cg
from serversherpa.db.models import (
    Client,
    ClientContactGroup,
    ClientGroup,
    ClientGroupAlias,
    Initiative,
    InitiativeAsset,
)
from serversherpa.services.audit import audit

router = APIRouter(prefix="/clients", tags=["client-groups"])


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def _group_err(e: cg.GroupError) -> HTTPException:
    return _err(e.status, e.code)


async def _client(db, actor: AuthContext, client_id: uuid.UUID) -> Client:
    if not actor.access.is_global:
        raise _err(403, "forbidden")
    client = await db.get(Client, client_id)
    if client is None:
        raise _err(404, "org_not_found")
    return client


async def _group(db, client_id: uuid.UUID, gid: uuid.UUID) -> ClientGroup:
    g = await db.get(ClientGroup, gid)
    if g is None or g.client_id != client_id:
        raise _err(404, "group_not_found")
    return g


async def _outs(db, client_id: uuid.UUID,
                only: uuid.UUID | None = None) -> list[ClientGroupOut]:
    q = select(ClientGroup).where(ClientGroup.client_id == client_id)
    if only is not None:
        q = q.where(ClientGroup.id == only)
    groups = list(await db.scalars(q))
    aliases: dict[uuid.UUID, list[str]] = {}
    for gid, alias in await db.execute(
            select(ClientGroupAlias.group_id, ClientGroupAlias.alias)
            .where(ClientGroupAlias.client_id == client_id)
            .order_by(ClientGroupAlias.alias_key)):
        aliases.setdefault(gid, []).append(alias)
    assets = dict((await db.execute(
        select(InitiativeAsset.owner_group_id, func.count())
        .join(Initiative, Initiative.id == InitiativeAsset.initiative_id)
        .where(Initiative.client_id == client_id,
               InitiativeAsset.owner_group_id.is_not(None))
        .group_by(InitiativeAsset.owner_group_id))).all())
    people = dict((await db.execute(
        select(ClientContactGroup.group_id, func.count())
        .where(ClientContactGroup.client_id == client_id)
        .group_by(ClientContactGroup.group_id))).all())
    groups.sort(key=lambda g: g.name_key)
    return [ClientGroupOut(id=g.id, name=g.name, aliases=aliases.get(g.id, []),
                           asset_count=assets.get(g.id, 0),
                           people_count=people.get(g.id, 0)) for g in groups]


@router.get("/{client_id}/groups", response_model=list[ClientGroupOut])
async def list_groups(
    client_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("clients", "change"),
) -> list[ClientGroupOut]:
    await _client(db, actor, client_id)
    return await _outs(db, client_id)


@router.post("/{client_id}/groups", response_model=ClientGroupOut, status_code=201)
async def create_group(
    client_id: uuid.UUID, body: ClientGroupIn, db: DbSession,
    actor: AuthContext = require_permission("clients", "change"),
) -> ClientGroupOut:
    await _client(db, actor, client_id)
    try:
        g = await cg.create_group(db, client_id, body.name, actor.person.id)
    except cg.GroupError as e:
        raise _group_err(e) from e
    audit(db, actor_id=actor.person.id, entity_type="client", entity_id=str(client_id),
          action="group.create", changes={"group_id": str(g.id), "name": g.name})
    await db.commit()
    return (await _outs(db, client_id, g.id))[0]


@router.get("/{client_id}/groups/review", response_model=list[GroupReviewValueOut])
async def review_list(
    client_id: uuid.UUID, db: DbSession,
    include_dismissed: bool = Query(False),
    actor: AuthContext = require_permission("clients", "change"),
) -> list[GroupReviewValueOut]:
    await _client(db, actor, client_id)
    vals = await cg.review_values(db, client_id, include_dismissed=include_dismissed)
    return [GroupReviewValueOut(**v.__dict__) for v in vals]


@router.post("/{client_id}/groups/review/match", status_code=204)
async def review_match(
    client_id: uuid.UUID, body: GroupReviewMatchIn, db: DbSession,
    actor: AuthContext = require_permission("clients", "change"),
) -> Response:
    await _client(db, actor, client_id)
    try:
        g = await cg.match_value(db, client_id, body.value, body.group_id)
    except cg.GroupError as e:
        raise _group_err(e) from e
    audit(db, actor_id=actor.person.id, entity_type="client", entity_id=str(client_id),
          action="group.review.match",
          changes={"value": body.value, "group_id": str(g.id)})
    await db.commit()
    return Response(status_code=204)


@router.post("/{client_id}/groups/review/dismiss", status_code=204)
async def review_dismiss(
    client_id: uuid.UUID, body: GroupReviewDismissIn, db: DbSession,
    actor: AuthContext = require_permission("clients", "change"),
) -> Response:
    await _client(db, actor, client_id)
    try:
        await cg.set_dismissed(db, client_id, body.value, body.dismissed, actor.person.id)
    except cg.GroupError as e:
        raise _group_err(e) from e
    audit(db, actor_id=actor.person.id, entity_type="client", entity_id=str(client_id),
          action="group.review.dismiss",
          changes={"value": body.value, "dismissed": body.dismissed})
    await db.commit()
    return Response(status_code=204)


@router.patch("/{client_id}/groups/{gid}", response_model=ClientGroupOut)
async def update_group(
    client_id: uuid.UUID, gid: uuid.UUID, body: ClientGroupPatchIn, db: DbSession,
    actor: AuthContext = require_permission("clients", "change"),
) -> ClientGroupOut:
    await _client(db, actor, client_id)
    g = await _group(db, client_id, gid)
    before = {"name": g.name}
    try:
        # aliases first: a rename then adds the old name as one more alias
        if body.aliases is not None:
            await cg.set_aliases(db, g, body.aliases)
        if body.name is not None:
            await cg.rename_group(db, g, body.name, actor.person.id)
        await cg.rematch_client(db, client_id)
    except cg.GroupError as e:
        await db.rollback()
        raise _group_err(e) from e
    changes = {"group_id": str(gid), "before": before, "after": {"name": g.name}}
    if body.aliases is not None:
        changes["aliases"] = body.aliases
    audit(db, actor_id=actor.person.id, entity_type="client", entity_id=str(client_id),
          action="group.update", changes=changes)
    await db.commit()
    return (await _outs(db, client_id, gid))[0]


@router.delete("/{client_id}/groups/{gid}", status_code=204)
async def delete_group(
    client_id: uuid.UUID, gid: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("clients", "change"),
) -> Response:
    await _client(db, actor, client_id)
    g = await _group(db, client_id, gid)
    name = g.name
    try:
        await cg.delete_group(db, g)
    except cg.GroupError as e:
        raise _group_err(e) from e
    audit(db, actor_id=actor.person.id, entity_type="client", entity_id=str(client_id),
          action="group.delete", changes={"group_id": str(gid), "name": name})
    await db.commit()
    return Response(status_code=204)


@router.post("/{client_id}/groups/{gid}/merge", response_model=GroupMergePlanOut)
async def merge_group(
    client_id: uuid.UUID, gid: uuid.UUID, body: GroupMergeIn, db: DbSession,
    actor: AuthContext = require_permission("clients", "change"),
) -> GroupMergePlanOut:
    await _client(db, actor, client_id)
    target = await _group(db, client_id, gid)
    source = await _group(db, client_id, body.source_id)
    source_name, source_id = source.name, source.id
    try:
        plan = await cg.merge_groups(db, target, source, dry_run=body.dry_run)
    except cg.GroupError as e:
        raise _group_err(e) from e
    if not body.dry_run:
        audit(db, actor_id=actor.person.id, entity_type="client",
              entity_id=str(client_id), action="group.merge",
              changes={"target_id": str(gid), "source_id": str(source_id),
                       "source_name": source_name, "rows_moved": plan.rows_moved,
                       "people_moved": plan.people_moved})
        await db.commit()
    return GroupMergePlanOut(**plan.__dict__)
