"""Learn sessions: what a worker signed in with a learning code (or its
link) carries on the learn site. They are their own table, never
`auth_sessions`, so a worker without an account gets no `user_accounts`
row and a learn token is worth nothing outside /learn.

The learn app keeps the raw token in sessionStorage and sends
`Authorization: Learn <token>` (no cookie, so no CSRF surface); only its
SHA-256 is stored. A session lasts SS_SESSION_TTL_SECONDS, never past its
code's expiry, and dies with its code.

`LearnActor` is the /learn worker routes' caller: a learn session, or a
signed-in account (a normal bearer, checked exactly as get_current_user
checks it) acting on that person's own rows.

Nothing here commits; callers own the transaction."""
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.deps import (
    AuthContext,
    DbSession,
    authenticate_request,
    enforce_read_only_config,
)
from serversherpa.config import get_settings
from serversherpa.db.models import Person
from serversherpa.learning.models import LearningCode, LearningSession
from serversherpa.services.password_reset import hash_token

TOKEN_BYTES = 32
SCHEME = "Learn"


async def start(db: AsyncSession, *, code: LearningCode | None, person_id: uuid.UUID,
                ip: str | None, user_agent: str | None) -> str:
    """A new learn session for `person_id`, started from `code`. Returns the
    raw token, shown once to the caller; `find` reads the row back."""
    now = datetime.now(UTC)
    expires_at = now + timedelta(seconds=get_settings().session_ttl_seconds)
    if code is not None and code.expires_at is not None:
        expires_at = min(expires_at, code.expires_at)
    raw = secrets.token_urlsafe(TOKEN_BYTES)
    session = LearningSession(code_id=code.id if code else None, person_id=person_id,
                              token_hash=hash_token(raw), expires_at=expires_at,
                              ip=ip, user_agent=(user_agent or "")[:500] or None)
    db.add(session)
    await db.flush()
    return raw


async def find(db: AsyncSession, raw: str) -> LearningSession | None:
    """The live session for a raw token: not revoked or expired, its code
    (if any) neither revoked nor expired, its person not archived."""
    now = datetime.now(UTC)
    return await db.scalar(
        select(LearningSession)
        .join(Person, Person.id == LearningSession.person_id)
        .outerjoin(LearningCode, LearningCode.id == LearningSession.code_id)
        .where(LearningSession.token_hash == hash_token(raw),
               LearningSession.revoked_at.is_(None),
               LearningSession.expires_at > now,
               Person.archived_at.is_(None),
               or_(LearningSession.code_id.is_(None),
                   and_(LearningCode.revoked_at.is_(None),
                        or_(LearningCode.expires_at.is_(None), LearningCode.expires_at > now)))))


def learn_auth_required() -> HTTPException:
    return HTTPException(status_code=401, detail={"code": "learn_auth_required"},
                         headers={"WWW-Authenticate": SCHEME})


@dataclass
class LearnActor:
    """Who is calling a /learn worker route. `session` is set for a learn
    session, `user` for a signed-in account; `person_id` either way."""

    person_id: uuid.UUID
    session: LearningSession | None
    user: AuthContext | None


async def learn_actor(request: Request, db: DbSession) -> LearnActor:
    scheme, _, raw = (request.headers.get("authorization") or "").partition(" ")
    raw = raw.strip()
    if scheme.lower() == "bearer" and raw:
        # the portal's own check, errors and all (the learn app refreshes on
        # them like the portal does)
        user = await authenticate_request(db, request, raw)
        return LearnActor(person_id=user.person.id, session=None, user=user)
    if scheme != SCHEME or not raw:
        raise learn_auth_required()
    session = await find(db, raw)
    if session is None:
        raise learn_auth_required()
    # read-only maintenance freezes learn writes too (a learn session has no
    # roles, so no developer pass)
    await enforce_read_only_config(db, request)
    return LearnActor(person_id=session.person_id, session=session, user=None)


CurrentLearner = Annotated[LearnActor, Depends(learn_actor)]
