"""Shared per-request context for every `/wiki` route: the DB session,
the caller's `AuthContext`, their wiki `Principal`, and a fresh
`AccessIndex`. Every wiki route handler takes `ctx: WikiContext` instead
of assembling these four itself — and picks up the `wiki:view` gate for
free, since building a `Principal` at all requires it.

`AccessIndex` never invalidates its cache, so `ctx.ix` is only good for
levels computed against the grants that existed when it was built. A
route that changes grants mid-request must build a NEW `AccessIndex`
(see `spaces.py`) before re-checking or serializing `my_level`."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.db.models import WikiSpace
from serversherpa.wiki.permissions import AccessIndex, Principal, principal_for


@dataclass
class WikiCtx:
    db: AsyncSession
    user: AuthContext
    principal: Principal
    ix: AccessIndex


async def _build_wiki_ctx(
    db: DbSession,
    user: AuthContext = require_permission("wiki", "view"),
) -> WikiCtx:
    principal = await principal_for(db, user)
    return WikiCtx(db=db, user=user, principal=principal, ix=AccessIndex(db, principal))


WikiContext = Annotated[WikiCtx, Depends(_build_wiki_ctx)]


async def space_by_key(db: AsyncSession, key: str) -> WikiSpace | None:
    # wiki_spaces.key is CITEXT — case-insensitive equality already, this
    # just normalizes stray whitespace from the path.
    return await db.scalar(select(WikiSpace).where(WikiSpace.key == key.strip()))
