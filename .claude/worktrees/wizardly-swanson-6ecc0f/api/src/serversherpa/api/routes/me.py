"""Self-service endpoints: my profile (view/edit) and my active sessions."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from serversherpa.api.deps import CurrentUser, DbSession
from serversherpa.api.schemas import (
    ChangePasswordIn,
    PersonDetail,
    ProfileUpdateIn,
    SessionItem,
)
from serversherpa.db.models import AuthSession
from serversherpa.config import get_settings
from serversherpa.security.passwords import hash_password, verify_password
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.auth import revoke_family
from serversherpa.services.storage import presign_get

router = APIRouter(prefix="/auth/me", tags=["me"])


def _detail(person) -> PersonDetail:
    out = PersonDetail.model_validate(person)
    out.avatar_url = presign_get(person.avatar_key)
    return out


@router.get("/profile", response_model=PersonDetail)
async def get_profile(user: CurrentUser) -> PersonDetail:
    return _detail(user.person)


@router.patch("/profile", response_model=PersonDetail)
async def update_profile(
    body: ProfileUpdateIn, user: CurrentUser, db: DbSession
) -> PersonDetail:
    data = body.model_dump(exclude_unset=True)
    for required in ("first_name", "last_name", "country"):
        if required in data and data[required] is None:
            raise HTTPException(status_code=422, detail={"code": f"{required}_required"})

    fields = list(data.keys())
    before = snapshot(user.person, fields)
    for field, value in data.items():
        setattr(user.person, field, value)
    user.person.updated_at = datetime.now(UTC)

    changes = diff(before, snapshot(user.person, fields))
    if changes:
        audit(db, actor_id=user.person.id, entity_type="person",
              entity_id=str(user.person.id), action="update",
              changes=changes)

    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        # partial unique index on people.email
        raise HTTPException(status_code=409, detail={"code": "email_in_use"}) from None

    return _detail(user.person)


@router.get("/sessions", response_model=list[SessionItem])
async def list_sessions(user: CurrentUser, db: DbSession) -> list[SessionItem]:
    now = datetime.now(UTC)

    live = (await db.scalars(
        select(AuthSession).where(
            AuthSession.person_id == user.person.id,
            AuthSession.revoked_at.is_(None),
            AuthSession.rotated_at.is_(None),
            AuthSession.expires_at > now,
        )
    )).all()

    family_ids = [s.family_id for s in live]
    starts = dict((await db.execute(
        select(AuthSession.family_id, func.min(AuthSession.created_at))
        .where(AuthSession.family_id.in_(family_ids or [uuid.uuid4()]))
        .group_by(AuthSession.family_id)
    )).all())

    items = [
        SessionItem(
            family_id=s.family_id,
            started_at=starts.get(s.family_id, s.created_at),
            last_active_at=s.created_at,
            expires_at=s.expires_at,
            ip_address=str(s.ip_address) if s.ip_address is not None else None,
            user_agent=s.user_agent,
            current=s.family_id == user.session.family_id,
        )
        for s in live
    ]
    # current login first, then most recently active
    items.sort(key=lambda i: (not i.current, i.last_active_at), reverse=False)
    items.sort(key=lambda i: i.last_active_at, reverse=True)
    items.sort(key=lambda i: not i.current)
    return items


@router.delete("/sessions/{family_id}", status_code=204)
async def revoke_session(
    family_id: uuid.UUID, user: CurrentUser, db: DbSession
) -> None:
    owned = await db.scalar(
        select(AuthSession.id).where(
            AuthSession.family_id == family_id,
            AuthSession.person_id == user.person.id,
        ).limit(1)
    )
    if owned is None:
        raise HTTPException(status_code=404, detail={"code": "session_not_found"})
    await revoke_family(db, family_id, reason="logout")
    audit(db, actor_id=user.person.id, entity_type="auth",
          entity_id=str(user.person.id), action="session.revoke",
          changes={"family_id": {"from": str(family_id), "to": None}})
    await db.commit()


@router.post("/password", status_code=204)
async def change_password(
    body: ChangePasswordIn, user: CurrentUser, db: DbSession
) -> None:
    """Self-service password change. Requires the current password; on
    success every OTHER login (family) is revoked — a stolen session
    can't ride through a password rotation."""
    pepper = get_settings().password_pepper.get_secret_value()
    account = user.account

    if account.password_hash is None or not verify_password(
            account.password_hash, body.current_password, pepper=pepper):
        raise HTTPException(status_code=403,
                            detail={"code": "invalid_current_password"})
    if verify_password(account.password_hash, body.new_password, pepper=pepper):
        raise HTTPException(status_code=422, detail={"code": "same_as_current"})

    now = datetime.now(UTC)
    account.password_hash = hash_password(body.new_password, pepper=pepper)
    account.password_updated_at = now
    account.must_change_password = False
    account.updated_at = now

    await db.execute(
        update(AuthSession)
        .where(AuthSession.person_id == account.person_id,
               AuthSession.family_id != user.session.family_id,
               AuthSession.revoked_at.is_(None))
        .values(revoked_at=now, revoke_reason="password_change")
    )
    audit(db, actor_id=user.person.id, entity_type="user_account",
          entity_id=str(user.person.id), action="password.change")
    await db.commit()
