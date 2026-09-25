"""Spaces, their grants, and the principal search that powers the grant
picker. Every route here goes through `WikiContext` (wiki:view gate +
Principal + AccessIndex); space creation additionally needs wiki:add,
and unarchive/principals additionally check `ctx.principal.is_admin` —
see the module docstring on `AccessIndex` for why those checks read the
Principal directly instead of going through `require_space_level`."""
from __future__ import annotations

import re
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import or_, select

from serversherpa.api.routes.wiki.deps import WikiContext, space_by_key
from serversherpa.api.routes.wiki.schemas import (
    GrantOut, GrantsOut, GrantsPutIn, MeOut, PersonRef, PrincipalOut, PrincipalType,
    SpaceCreateIn, SpaceOut, SpacePatchIn,
)
from serversherpa.api.routes.wiki.serialize import space_out
from serversherpa.db.models import (
    AccessGroup, Client, Partner, Person, Role, UserAccount, WikiGrant, WikiSpace,
)
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.wiki import space_settings
from serversherpa.wiki.permissions import AccessIndex, principal_labels, require_space_level
from serversherpa.wiki.tree import create_node, publish_empty_home

router = APIRouter()

KEY_RE = re.compile(r"^[a-z0-9][a-z0-9-]{1,39}$")
SPACE_FIELDS = ["name", "description", "icon", "color", "settings"]
# every principal type whose id is a row's uuid — used to validate a grant's
# principal exists. /principals search reuses only the "named org" subset
# below (person has its own query, joined to user_accounts).
_UUID_PRINCIPAL_MODELS = {
    "person": Person, "access_group": AccessGroup, "client": Client, "partner": Partner}
_SEARCHABLE_ORG_MODELS = {"access_group": AccessGroup, "client": Client, "partner": Partner}


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _forbidden(message: str = "You don't have access to do that.") -> HTTPException:
    return _err(403, "forbidden", message=message)


async def _can_manage_any_space(ctx: WikiContext) -> bool:
    if ctx.principal.is_admin:
        return True
    space_ids = (await ctx.db.scalars(select(WikiSpace.id))).all()
    levels = await ctx.ix.levels_for_spaces(space_ids)
    return any(level == "manage" for level in levels.values())


# ── /me ──────────────────────────────────────────────────────────────


@router.get("/me", response_model=MeOut)
async def get_me(ctx: WikiContext) -> MeOut:
    return MeOut(
        person=PersonRef(id=ctx.user.person.id, name=ctx.user.person.display_name),
        is_admin=ctx.principal.is_admin,
        can_create_spaces=ctx.user.access.can("wiki", "add"),
    )


# ── spaces ───────────────────────────────────────────────────────────


@router.get("/spaces", response_model=list[SpaceOut])
async def list_spaces(ctx: WikiContext, include_archived: bool = False) -> list[SpaceOut]:
    q = select(WikiSpace).order_by(WikiSpace.name)
    if not include_archived:
        q = q.where(WikiSpace.archived_at.is_(None))
    spaces = (await ctx.db.scalars(q)).all()
    levels = await ctx.ix.levels_for_spaces(s.id for s in spaces)
    return [space_out(s, levels[s.id]) for s in spaces if levels[s.id] is not None]


@router.post("/spaces", response_model=SpaceOut, status_code=201)
async def create_space(body: SpaceCreateIn, ctx: WikiContext) -> SpaceOut:
    if not ctx.user.access.can("wiki", "add"):
        raise _forbidden("You need wiki:add access to create a space.")

    key = body.key.strip().lower()
    if not KEY_RE.match(key):
        raise _err(422, "bad_key",
                   message="Key must be 2-40 lowercase letters, digits, or "
                           "hyphens, starting with a letter or digit.")
    if await space_by_key(ctx.db, key):
        raise _err(409, "key_taken")

    actor_id = ctx.user.person.id
    space = WikiSpace(
        key=key, name=body.name, description=body.description,
        icon=body.icon, color=body.color, created_by=actor_id,
    )
    ctx.db.add(space)
    await ctx.db.flush()

    home_node = await create_node(
        ctx.db, space=space, parent=None, kind="page",
        title=space.name, actor_id=actor_id)
    await publish_empty_home(ctx.db, home_node, actor_id)
    space.home_node_id = home_node.id

    ctx.db.add(WikiGrant(
        space_id=space.id, principal_type="person",
        principal_id=str(actor_id), level="manage", created_by=actor_id))
    if body.default_access == "internal":
        ctx.db.add(WikiGrant(
            space_id=space.id, principal_type="internal",
            level="view", created_by=actor_id))
    elif body.default_access == "everyone":
        ctx.db.add(WikiGrant(
            space_id=space.id, principal_type="everyone",
            level="view", created_by=actor_id))

    audit(ctx.db, actor_id=actor_id, entity_type="wiki_space",
          entity_id=str(space.id), action="create",
          changes=diff({}, {**snapshot(space, SPACE_FIELDS),
                            "default_access": body.default_access}))
    await ctx.db.commit()
    return space_out(space, "manage")


@router.get("/spaces/{key}", response_model=SpaceOut)
async def get_space(key: str, ctx: WikiContext) -> SpaceOut:
    space = await require_space_level(ctx.ix, await space_by_key(ctx.db, key), "view")
    level = await ctx.ix.level_for_space(space.id)
    return space_out(space, level)


@router.patch("/spaces/{key}", response_model=SpaceOut)
async def patch_space(key: str, body: SpacePatchIn, ctx: WikiContext) -> SpaceOut:
    space = await require_space_level(ctx.ix, await space_by_key(ctx.db, key), "manage")
    before = snapshot(space, SPACE_FIELDS)

    if body.settings is not None:
        bad = sorted(k for k in body.settings if k not in space_settings.ALLOWED)
        if bad:
            raise _err(422, "bad_setting", keys=bad)
        space.settings = {**(space.settings or {}), **body.settings}
    if body.name is not None:
        space.name = body.name
    if body.description is not None:
        space.description = body.description
    if body.icon is not None:
        space.icon = body.icon
    if body.color is not None:
        space.color = body.color

    audit(ctx.db, actor_id=ctx.user.person.id, entity_type="wiki_space",
          entity_id=str(space.id), action="update",
          changes=diff(before, snapshot(space, SPACE_FIELDS)))
    await ctx.db.commit()

    level = await ctx.ix.level_for_space(space.id)
    return space_out(space, level)


@router.post("/spaces/{key}/archive", response_model=SpaceOut)
async def archive_space(key: str, ctx: WikiContext) -> SpaceOut:
    space = await require_space_level(ctx.ix, await space_by_key(ctx.db, key), "manage")
    if space.archived_at is None:
        space.archived_at = datetime.now(UTC)
        audit(ctx.db, actor_id=ctx.user.person.id, entity_type="wiki_space",
              entity_id=str(space.id), action="archive", changes={})
        await ctx.db.commit()

    # archiving clamps everyone (incl. this actor) to view — the cached
    # AccessIndex doesn't know that, so build a fresh one for my_level.
    fresh_ix = AccessIndex(ctx.db, ctx.principal)
    level = await fresh_ix.level_for_space(space.id)
    return space_out(space, level)


@router.post("/spaces/{key}/unarchive", response_model=SpaceOut)
async def unarchive_space(key: str, ctx: WikiContext) -> SpaceOut:
    # unarchive is wiki-admin only — an archived space clamps every
    # non-admin (including a space manager) to view, so require_space_level
    # would never let anyone but an admin reach "manage" here anyway; this
    # checks the Principal directly so the 403 says what's actually needed.
    space = await require_space_level(ctx.ix, await space_by_key(ctx.db, key), "view")
    if not ctx.principal.is_admin:
        raise _forbidden("Only a wiki administrator can unarchive a space.")

    if space.archived_at is not None:
        space.archived_at = None
        audit(ctx.db, actor_id=ctx.user.person.id, entity_type="wiki_space",
              entity_id=str(space.id), action="unarchive", changes={})
        await ctx.db.commit()

    fresh_ix = AccessIndex(ctx.db, ctx.principal)
    level = await fresh_ix.level_for_space(space.id)
    return space_out(space, level)


# ── grants ───────────────────────────────────────────────────────────


async def _space_grants(db, space: WikiSpace) -> list[WikiGrant]:
    return (await db.scalars(
        select(WikiGrant)
        .where(WikiGrant.space_id == space.id, WikiGrant.node_id.is_(None))
        .order_by(WikiGrant.created_at)
    )).all()


async def _grants_out(db, grants: list[WikiGrant]) -> list[GrantOut]:
    labels = await principal_labels(db, grants)
    return [
        GrantOut(
            id=g.id, principal_type=g.principal_type, principal_id=g.principal_id,
            level=g.level, principal_label=labels[(g.principal_type, g.principal_id)],
            node_id=None,
        )
        for g in grants
    ]


@router.get("/spaces/{key}/grants", response_model=GrantsOut)
async def get_space_grants(key: str, ctx: WikiContext) -> GrantsOut:
    space = await require_space_level(ctx.ix, await space_by_key(ctx.db, key), "manage")
    return GrantsOut(grants=await _grants_out(ctx.db, await _space_grants(ctx.db, space)))


async def _principal_exists(db, principal_type: str, principal_id: str | None) -> bool:
    if principal_type in ("everyone", "internal"):
        return principal_id is None
    if principal_type == "role":
        return bool(principal_id) and await db.get(Role, principal_id) is not None
    model = _UUID_PRINCIPAL_MODELS.get(principal_type)
    if model is None or not principal_id:
        return False
    try:
        row_id = uuid.UUID(principal_id)
    except (ValueError, AttributeError, TypeError):
        return False
    return await db.get(model, row_id) is not None


@router.put("/spaces/{key}/grants", response_model=GrantsOut)
async def put_space_grants(key: str, body: GrantsPutIn, ctx: WikiContext) -> GrantsOut:
    space = await require_space_level(ctx.ix, await space_by_key(ctx.db, key), "manage")

    for g in body.grants:
        if not await _principal_exists(ctx.db, g.principal_type, g.principal_id):
            raise _err(422, "bad_principal",
                       principal_type=g.principal_type, principal_id=g.principal_id)

    has_manager = any(g.level == "manage" for g in body.grants)
    if not has_manager and not ctx.principal.is_admin:
        raise _err(422, "no_manager")

    existing = await _space_grants(ctx.db, space)
    before = [{"principal_type": g.principal_type, "principal_id": g.principal_id,
              "level": g.level} for g in existing]
    for g in existing:
        await ctx.db.delete(g)
    await ctx.db.flush()

    actor_id = ctx.user.person.id
    new_rows = [
        WikiGrant(space_id=space.id, principal_type=g.principal_type,
                  principal_id=g.principal_id, level=g.level, created_by=actor_id)
        for g in body.grants
    ]
    ctx.db.add_all(new_rows)
    after = [{"principal_type": g.principal_type, "principal_id": g.principal_id,
             "level": g.level} for g in body.grants]

    audit(ctx.db, actor_id=actor_id, entity_type="wiki_grant",
          entity_id=str(space.id), action="replace",
          changes=diff({"grants": before}, {"grants": after}))
    await ctx.db.commit()

    return GrantsOut(grants=await _grants_out(ctx.db, new_rows))


# ── principals ───────────────────────────────────────────────────────


@router.get("/principals", response_model=list[PrincipalOut])
async def list_principals(
    ctx: WikiContext, principal_type: PrincipalType = Query(..., alias="type"),
    q: str = "",
) -> list[PrincipalOut]:
    if not await _can_manage_any_space(ctx):
        raise _forbidden(
            "You need manage access on at least one space to search principals.")

    query = q.strip()
    like = f"%{query}%"

    if principal_type == "person":
        stmt = (
            select(Person)
            .join(UserAccount, UserAccount.person_id == Person.id)
            .where(Person.archived_at.is_(None))
        )
        if query:
            stmt = stmt.where(or_(
                Person.first_name.ilike(like), Person.last_name.ilike(like),
                Person.preferred_name.ilike(like), Person.email.ilike(like)))
        stmt = stmt.order_by(Person.last_name, Person.first_name).limit(20)
        rows = (await ctx.db.scalars(stmt)).all()
        return [PrincipalOut(type="person", id=str(p.id), label=p.display_name)
                for p in rows]

    if principal_type == "role":
        stmt = select(Role)
        if query:
            stmt = stmt.where(or_(Role.name.ilike(like), Role.label.ilike(like)))
        stmt = stmt.order_by(Role.label, Role.name).limit(20)
        rows = (await ctx.db.scalars(stmt)).all()
        return [PrincipalOut(type="role", id=r.name, label=r.label or r.name)
                for r in rows]

    model = _SEARCHABLE_ORG_MODELS.get(principal_type)
    if model is None:
        raise _err(422, "bad_type")
    stmt = select(model)
    if hasattr(model, "archived_at"):
        stmt = stmt.where(model.archived_at.is_(None))
    if query:
        stmt = stmt.where(model.name.ilike(like))
    stmt = stmt.order_by(model.name).limit(20)
    rows = (await ctx.db.scalars(stmt)).all()
    return [PrincipalOut(type=principal_type, id=str(r.id), label=r.name) for r in rows]
