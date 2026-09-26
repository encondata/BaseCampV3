"""The internal API the wiki's live-editing server calls — never the
browser. Every route presents the shared service token
(`X-Wiki-Service-Token`, SS_WIKI_SERVICE_TOKEN); none use the wiki:view
gate, since the caller is a service, not a user.

- `GET /internal/collab/authorize?node=` — may this user (their own
  bearer token, passed through) open this page live, and how? Editors
  only (the live document is the draft): 404 when they can't view it,
  403 when they only have view. Read-only maintenance mode answers
  `view` to editors (all but developers), so they connect read-only.
- `GET /internal/collab/level?node=&person=` — the same answer for a
  person, without their token: the collab server re-checks open
  connections with it long after the connecting access token expired.
- `GET /internal/pages/{id}/state` — the stored Yjs update and draft JSON
  a document loads from.
- `PUT /internal/pages/{id}/state` — store the document (`pages.store_draft`).
"""
from __future__ import annotations

import base64
import binascii
import hmac
import uuid
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import joinedload

from serversherpa.access.resolver import resolve_access
from serversherpa.api.deps import (
    DbSession,
    authenticate_token,
    enforce_forced_password_change,
    enforce_read_only,
    enforce_session_scope,
)
from serversherpa.api.routes.wiki.errors import err, forbidden, not_found
from serversherpa.api.routes.wiki.schemas import (
    CollabAuthorizeOut,
    CollabLevelOut,
    PageStateIn,
    PageStateOut,
    PersonRef,
)
from serversherpa.config import get_settings
from serversherpa.db.models import AuthSession, Person, UserAccount, WikiNode, WikiPage
from serversherpa.wiki import pages
from serversherpa.wiki.content import MAX_DOC_BYTES
from serversherpa.wiki.permissions import (
    AccessIndex,
    Principal,
    principal_for,
    principal_from_access,
)

_bearer = HTTPBearer(auto_error=False)

# the collab server acts for the editors, none of whom is a developer, so
# read-only mode freezes its stores like any other write
_SERVICE_USER = SimpleNamespace(roles=())

# a bare cap on the encoded Yjs update PUT /state accepts, well above any
# legitimate document (MAX_DOC_BYTES caps the ProseMirror JSON alongside
# it) — big enough for normal editing history, small enough to refuse an
# abusive or corrupt payload before it's held in memory
MAX_YDOC_BYTES = 4 * MAX_DOC_BYTES


async def service_auth(
    x_wiki_service_token: Annotated[str | None, Header()] = None,
) -> None:
    """The caller must present the configured service token: 503
    `internal_disabled` while none is configured, 401 `bad_service_token`
    for a missing or wrong one (constant-time compare)."""
    expected = get_settings().wiki_service_token.get_secret_value()
    if not expected:
        raise err(503, "internal_disabled", "The wiki internal API isn't configured.")
    if not x_wiki_service_token or not hmac.compare_digest(
            x_wiki_service_token.encode(), expected.encode()):
        raise err(401, "bad_service_token", "Bad service token.")


router = APIRouter(prefix="/internal", dependencies=[Depends(service_auth)])


# ── authorize ────────────────────────────────────────────────────────


@router.get("/collab/authorize", response_model=CollabAuthorizeOut)
async def authorize(
    node: uuid.UUID, request: Request, db: DbSession,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> CollabAuthorizeOut:
    """The user's level on a page they may open live, with their name and
    cursor color. 401 `unauthenticated` for a missing or invalid bearer;
    404 for anything that isn't a live page they can see (a view-only
    user can't see a never-published page); 403 when they only have view
    (see `_live_level`)."""
    if credentials is None:
        raise err(401, "unauthenticated", "Sign in to edit.")
    try:
        user = await authenticate_token(db, credentials.credentials)
    except HTTPException as exc:
        if exc.status_code == 401:
            raise err(401, "unauthenticated", "Sign in to edit.") from None
        raise
    enforce_session_scope(request, user)
    enforce_forced_password_change(request, user)

    level = await _live_level(db, await principal_for(db, user), node)
    level = await _frozen_to_view(db, level, user.roles)
    person = user.person
    return CollabAuthorizeOut(
        level=level, person=PersonRef(id=person.id, name=person.display_name),
        color=pages.person_color(person.id))


@router.get("/collab/level", response_model=CollabLevelOut)
async def level(node: uuid.UUID, person: uuid.UUID, db: DbSession) -> CollabLevelOut:
    """`authorize`'s level for a person, by id: 404 when they have no
    active account (none, disabled, or the person archived) or no live
    session (every one revoked or expired — "revoke all sessions" and a
    password reset end live editing too), the same checks
    `authenticate_token` makes, or when they can't open the page live."""
    account = await db.scalar(
        select(UserAccount)
        .options(joinedload(UserAccount.person))
        .where(UserAccount.person_id == person))
    if (account is None or account.disabled_at is not None
            or account.person.archived_at is not None):
        raise not_found()
    live_session = await db.scalar(
        select(AuthSession.id)
        .where(AuthSession.person_id == person,
               AuthSession.revoked_at.is_(None),
               AuthSession.expires_at > datetime.now(UTC))
        .limit(1))
    if live_session is None:
        raise not_found()
    access = await resolve_access(db, person)
    principal = await principal_from_access(db, person, access)
    level = await _live_level(db, principal, node)
    return CollabLevelOut(level=await _frozen_to_view(db, level, access.role_names))


async def _frozen_to_view(db, level: str, roles) -> str:
    """Read-only maintenance mode refuses every store (except for
    developers, like any write), so live editing opens read-only rather
    than letting editors type into a document that can't be saved; the
    collab server's re-check downgrades connections already open."""
    if level == "view" or "developer" in roles:
        return level
    from serversherpa.system.admin_config import read_admin_config

    return "view" if (await read_admin_config(db))["read_only"] else level


async def _live_level(db, principal: Principal, node_id: uuid.UUID) -> str:
    """The principal's level on a page they may edit live — edit or
    manage — before any freeze (`_frozen_to_view`). The live document IS
    the page's draft, which the REST API never shows a view-only reader,
    so live editing is for editors only: 404 when it isn't a live page or
    they can't view it (a view-only reader of a never-published page
    can't), 403 `forbidden` when they only have view."""
    row = await db.get(WikiNode, node_id)
    if row is None or row.deleted_at is not None or row.kind != "page":
        raise not_found()
    level = await AccessIndex(db, principal).level_for_node(row)
    if level is None:
        raise not_found()
    if level == "view":
        published_id = await db.scalar(
            select(WikiPage.published_version_id).where(WikiPage.node_id == row.id))
        if published_id is None:
            raise not_found()
        raise forbidden("edit")
    return level


# ── state ────────────────────────────────────────────────────────────


async def _page(db, node_id: uuid.UUID) -> tuple[WikiNode, WikiPage]:
    node = await db.get(WikiNode, node_id)
    page = await db.get(WikiPage, node_id) if node is not None else None
    if page is None:
        raise not_found()
    return node, page


@router.get("/pages/{node_id}/state", response_model=PageStateOut)
async def get_state(node_id: uuid.UUID, db: DbSession) -> PageStateOut:
    """What a document loads from: the stored Yjs update (standard
    base64), or null for a page never opened live — the collab server
    then seeds from `draft_json` when there is one (an import, a copy)."""
    node, page = await _page(db, node_id)
    return PageStateOut(
        ydoc_b64=base64.b64encode(page.ydoc).decode() if page.ydoc is not None else None,
        draft_json=page.draft_json, title=node.title)


@router.put("/pages/{node_id}/state", status_code=204)
async def put_state(node_id: uuid.UUID, body: PageStateIn, request: Request,
                    db: DbSession) -> Response:
    """Store the live document. 409 `deleted` once the page is in the
    trash; 413 `too_large` for a ydoc above MAX_YDOC_BYTES decoded; read-only
    mode refuses it like any write. `editor_ids` that aren't people are
    ignored."""
    await enforce_read_only(db, request, _SERVICE_USER)
    node, page = await _page(db, node_id)
    if node.deleted_at is not None:
        raise err(409, "deleted", "This page is in the trash.")
    try:
        ydoc = base64.b64decode(body.ydoc_b64, validate=True)
    except (binascii.Error, ValueError):
        raise err(422, "bad_ydoc", "ydoc_b64 isn't valid base64.") from None
    if len(ydoc) > MAX_YDOC_BYTES:
        raise err(413, "too_large",
                  f"The document is larger than {MAX_YDOC_BYTES // (1024 * 1024)} MB.")

    editor_ids = body.editor_ids
    if editor_ids:
        known = set((await db.scalars(
            select(Person.id).where(Person.id.in_(set(editor_ids))))).all())
        editor_ids = [pid for pid in editor_ids if pid in known]
    await pages.store_draft(db, page, node, ydoc=ydoc,
                            content_json=body.content_json, editor_ids=editor_ids)
    await db.commit()
    return Response(status_code=204)
