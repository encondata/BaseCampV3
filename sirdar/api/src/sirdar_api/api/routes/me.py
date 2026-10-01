"""Self-service /me endpoints under /auth/me (the portal's paths): profile,
active sessions, my activity. Sub-paths only — GET /auth/me and
PUT /auth/me/preferences live in routes/auth.py."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy import or_, select, update

from sirdar_api.api.deps import CurrentUser, DbSession, client_ip
from sirdar_api.config import get_settings
from sirdar_api.db.models import AuditLog, AuthSession, User
from sirdar_api.services.audit import audit
from sirdar_api.security.passwords import hash_password, verify_password
from sirdar_api.services.auth import _revoke_family

router = APIRouter(prefix="/auth/me", tags=["me"])

PROFILE_FIELDS = ("first_name", "last_name", "preferred_name", "phone", "job_title",
                  "address_line1", "address_line2", "city", "region", "postal_code",
                  "country")


class ProfileOut(BaseModel):
    """The portal's PersonDetail, plus login_email and source."""

    id: uuid.UUID
    first_name: str
    last_name: str
    preferred_name: str | None
    display_name: str
    badge_uid: None = None
    email: str | None
    phone: str | None
    job_title: str | None
    address_line1: str | None
    address_line2: str | None
    city: str | None
    region: str | None
    postal_code: str | None
    country: str
    avatar_key: None = None
    avatar_url: None = None
    created_at: datetime
    password_updated_at: datetime | None
    login_email: str
    source: str


class ProfileUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    first_name: str | None = None
    last_name: str | None = None
    preferred_name: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    job_title: str | None = None
    address_line1: str | None = None
    address_line2: str | None = None
    city: str | None = None
    region: str | None = None
    postal_code: str | None = None
    country: str | None = None

    @field_validator("country")
    @classmethod
    def _country(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip()
        if not v:
            return None          # blank → the handler reports country_required
        if len(v) != 2 or not v.isalpha() or not v.isascii():
            raise ValueError("country must be a 2-letter code")
        return v.upper()


class SessionInfo(BaseModel):
    family_id: uuid.UUID
    started_at: datetime
    last_active_at: datetime
    expires_at: datetime
    ip_address: str | None
    user_agent: str | None
    current: bool


class MyActivityItem(BaseModel):
    id: str
    at: datetime
    action: str
    entity_type: str
    entity_id: str | None
    entity_name: str | None
    actor_id: uuid.UUID | None
    actor_name: str | None
    ip: str | None
    changes: dict
    by_me: bool            # portal MyActivityItem field
    entity_summary: dict[str, str] = Field(default_factory=dict)   # portal field; unused here


def profile_out(user: User) -> ProfileOut:
    return ProfileOut(
        id=user.person_id, first_name=user.first_name, last_name=user.last_name,
        preferred_name=user.preferred_name, display_name=user.display_name,
        email=user.contact_email, phone=user.phone, job_title=user.job_title,
        address_line1=user.address_line1, address_line2=user.address_line2, city=user.city,
        region=user.region, postal_code=user.postal_code, country=user.country,
        created_at=user.created_at, password_updated_at=user.password_updated_at,
        login_email=user.email, source=user.source)


@router.get("/profile", response_model=ProfileOut)
async def get_profile(ctx: CurrentUser):
    return profile_out(ctx.user)


@router.patch("/profile", response_model=ProfileOut)
async def update_profile(body: ProfileUpdateIn, request: Request, ctx: CurrentUser,
                         db: DbSession):
    data = body.model_dump(exclude_unset=True)
    for required in ("first_name", "last_name", "country"):
        if required in data and (data[required] is None or not data[required].strip()):
            raise HTTPException(status_code=422, detail={"code": f"{required}_required"})
    if "email" in data:
        data["contact_email"] = data.pop("email")
    user = ctx.user
    changed: dict[str, dict] = {}
    for field, value in data.items():
        old = getattr(user, field)
        if isinstance(value, str) and field != "contact_email":
            value = value.strip() if field in ("first_name", "last_name") else value
        if old != value:
            setattr(user, field, value)
            changed["email" if field == "contact_email" else field] = {"from": old, "to": value}
    if changed:
        user.updated_at = datetime.now(UTC)
        audit(db, actor_id=user.person_id, action="profile.update", entity_type="user",
              entity_id=str(user.person_id), ip=client_ip(request), changes=changed)
    await db.commit()
    await db.refresh(user)
    return profile_out(user)


@router.get("/sessions", response_model=list[SessionInfo])
async def list_sessions(ctx: CurrentUser, db: DbSession):
    now = datetime.now(UTC)
    rows = (await db.scalars(
        select(AuthSession).where(AuthSession.person_id == ctx.user.person_id)
        .order_by(AuthSession.created_at))).all()
    families: dict[uuid.UUID, list[AuthSession]] = {}
    for row in rows:
        families.setdefault(row.family_id, []).append(row)
    items: list[SessionInfo] = []
    for family_id, members in families.items():
        if any(m.revoked_at is not None for m in members):
            continue
        live = [m for m in members if m.rotated_at is None] or members[-1:]
        head = live[-1]
        if head.expires_at <= now:
            continue
        items.append(SessionInfo(
            family_id=family_id, started_at=members[0].created_at,
            last_active_at=members[-1].created_at, expires_at=head.expires_at,
            ip_address=str(head.ip_address) if head.ip_address else None, user_agent=head.user_agent,
            current=family_id == ctx.session.family_id))
    items.sort(key=lambda i: i.last_active_at, reverse=True)
    items.sort(key=lambda i: not i.current)     # stable: current first, then newest
    return items


@router.delete("/sessions/{family_id}", status_code=204)
async def revoke_session(family_id: uuid.UUID, request: Request, ctx: CurrentUser,
                         db: DbSession):
    owned = await db.scalar(select(AuthSession.id).where(
        AuthSession.family_id == family_id,
        AuthSession.person_id == ctx.user.person_id).limit(1))
    if owned is None:
        raise HTTPException(status_code=404, detail={"code": "session_not_found"})
    await _revoke_family(db, family_id, reason="user_revoked")
    audit(db, actor_id=ctx.user.person_id, action="session.revoke", entity_type="auth",
          entity_id=str(ctx.user.person_id), ip=client_ip(request),
          changes={"family_id": str(family_id)})
    await db.commit()


@router.get("/activity", response_model=list[MyActivityItem])
async def my_activity(ctx: CurrentUser, db: DbSession,
                      limit: int = Query(200, ge=1, le=500)):
    me = ctx.user.person_id
    rows = (await db.scalars(
        select(AuditLog).where(or_(
            AuditLog.actor_id == me,
            (AuditLog.entity_type.in_(("user", "auth"))) & (AuditLog.entity_id == str(me))))
        .order_by(AuditLog.at.desc(), AuditLog.id.desc()).limit(limit))).all()
    ids = {r.actor_id for r in rows if r.actor_id}
    for r in rows:
        if r.entity_type == "user" and r.entity_id:
            try:
                ids.add(uuid.UUID(r.entity_id))
            except ValueError:
                pass
    names = {u.person_id: u.display_name for u in (
        await db.scalars(select(User).where(User.person_id.in_(ids)))).all()} if ids else {}
    out = []
    for r in rows:
        entity_name = None
        if r.entity_type == "user" and r.entity_id:
            try:
                entity_name = names.get(uuid.UUID(r.entity_id))
            except ValueError:
                pass
        out.append(MyActivityItem(
            id=str(r.id), at=r.at, action=r.action, entity_type=r.entity_type,
            entity_id=r.entity_id, entity_name=entity_name, actor_id=r.actor_id,
            actor_name=names.get(r.actor_id) if r.actor_id else None,
            ip=str(r.ip) if r.ip else None, changes=r.changes, by_me=r.actor_id == me))
    return out


class PasswordChangeIn(BaseModel):
    current_password: str
    new_password: str


@router.post("/password", status_code=204)
async def change_password(body: PasswordChangeIn, request: Request, ctx: CurrentUser,
                          db: DbSession):
    """Local users only. A wrong current password is not a lockout strike
    (the caller already holds a valid session), matching the portal."""
    user = ctx.user
    if user.source != "local":
        raise HTTPException(status_code=403, detail={"code": "managed_in_portal"})
    settings = get_settings()
    pepper = settings.password_pepper.get_secret_value()
    if len(body.new_password) < settings.password_min_length:
        raise HTTPException(status_code=422, detail={
            "code": "password_too_short", "min_length": settings.password_min_length})
    if user.password_hash is None or not verify_password(
            user.password_hash, body.current_password, pepper=pepper):
        raise HTTPException(status_code=403, detail={"code": "invalid_current_password"})
    if body.new_password == body.current_password:
        raise HTTPException(status_code=422, detail={"code": "same_as_current"})
    now = datetime.now(UTC)
    user.password_hash = hash_password(body.new_password, pepper=pepper)
    user.password_updated_at = now
    user.must_change_password = False
    user.updated_at = now
    await db.execute(update(AuthSession).where(
        AuthSession.person_id == user.person_id,
        AuthSession.family_id != ctx.session.family_id,
        AuthSession.revoked_at.is_(None),
    ).values(revoked_at=now, revoke_reason="password_change"))
    audit(db, actor_id=user.person_id, action="password.change", entity_type="user",
          entity_id=str(user.person_id), ip=client_ip(request))
    await db.commit()
