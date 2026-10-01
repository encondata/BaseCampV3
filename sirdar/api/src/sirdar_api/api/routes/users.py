import uuid
from datetime import UTC, datetime
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from sirdar_api.access.resolver import AccessInfo, can_touch_rank, resolve_access
from sirdar_api.api.deps import AuthContext, DbSession, require_permission
from sirdar_api.api.schemas import EffectiveCellOut
from sirdar_api.config import get_settings
from sirdar_api.db.models import (
    AuthSession, ImportRun, PermissionOverride, Role, User, UserRole,
)
from sirdar_api.services.audit import audit
from sirdar_api.services.auth import revoke_sessions
from sirdar_api.services.import_users import (
    ImportNotConfigured, ImportSourceError, import_users,
)

router = APIRouter(prefix="/users", tags=["users"])


class UserRowOut(BaseModel):
    person_id: uuid.UUID
    display_name: str
    email: str
    source: Literal["portal", "local"]
    roles: list[str]
    max_rank: int
    totp_enrolled: bool
    totp_required: bool
    last_login_at: datetime | None
    disabled_at: datetime | None
    disabled_reason: str | None
    last_imported_at: datetime | None


class ImportRowOut(BaseModel):
    person_id: uuid.UUID | None
    email: str
    name: str
    action: Literal["added", "updated", "unchanged", "disabled", "skipped"]
    reason: str | None = None
    roles: list[str] = []
    changes: list[str] = []


class ImportRunOut(BaseModel):
    id: uuid.UUID
    started_at: datetime
    finished_at: datetime | None
    trigger: str
    status: str
    error: str | None
    actor_name: str | None
    added: int
    updated: int
    unchanged: int
    disabled: int
    skipped: int
    rows: list[ImportRowOut] = []


class SessionRowOut(BaseModel):
    id: uuid.UUID
    family_id: uuid.UUID
    created_at: datetime
    expires_at: datetime
    ip_address: str | None
    user_agent: str | None


class UserDetailOut(BaseModel):
    user: UserRowOut
    first_name: str
    last_name: str
    preferred_name: str | None
    job_title: str | None
    cells: dict[str, dict[str, EffectiveCellOut]]
    overrides: dict[str, dict[str, bool]]
    sessions: list[SessionRowOut]
    can_manage: bool


async def _roles_by_person(db: AsyncSession) -> tuple[dict[uuid.UUID, list[str]], dict[str, int]]:
    ranks = {name: rank for name, rank in (await db.execute(select(Role.name, Role.rank))).all()}
    roles: dict[uuid.UUID, list[str]] = {}
    for pid, role in (await db.execute(select(UserRole.person_id, UserRole.role))).all():
        roles.setdefault(pid, []).append(role)
    return roles, ranks


def _row(user: User, roles: list[str], ranks: dict[str, int]) -> UserRowOut:
    return UserRowOut(
        person_id=user.person_id, display_name=user.display_name, email=user.email,
        source=user.source, roles=sorted(roles),
        max_rank=max((ranks.get(r, 0) for r in roles), default=0),
        totp_enrolled=user.totp_confirmed_at is not None, totp_required=user.totp_required,
        last_login_at=user.last_login_at, disabled_at=user.disabled_at,
        disabled_reason=user.disabled_reason, last_imported_at=user.last_imported_at)


async def _run_out(db: AsyncSession, run: ImportRun, *, with_rows: bool) -> ImportRunOut:
    actor = await db.get(User, run.actor_id) if run.actor_id else None
    return ImportRunOut(
        id=run.id, started_at=run.started_at, finished_at=run.finished_at, trigger=run.trigger,
        status=run.status, error=run.error,
        actor_name=actor.display_name if actor else None,
        added=run.added, updated=run.updated, unchanged=run.unchanged, disabled=run.disabled,
        skipped=run.skipped,
        rows=[ImportRowOut(**r) for r in run.rows] if with_rows else [])


@router.get("", response_model=list[UserRowOut])
async def list_users(db: DbSession, actor: AuthContext = require_permission("users", "view")):
    roles, ranks = await _roles_by_person(db)
    users = await db.scalars(select(User).order_by(User.last_name, User.first_name))
    return [_row(u, roles.get(u.person_id, []), ranks) for u in users]


# ── import (declared before /{person_id} so "import" never parses as an id) ──

@router.get("/import/source")
async def import_source(db: DbSession, actor: AuthContext = require_permission("users", "view")):
    return {"configured": get_settings().source_database_url is not None}


@router.get("/import/runs", response_model=list[ImportRunOut])
async def import_runs(db: DbSession, actor: AuthContext = require_permission("users", "view")):
    runs = await db.scalars(select(ImportRun).order_by(ImportRun.started_at.desc()).limit(20))
    return [await _run_out(db, r, with_rows=False) for r in runs]


@router.get("/import/runs/{run_id}", response_model=ImportRunOut)
async def import_run(run_id: uuid.UUID, db: DbSession,
                     actor: AuthContext = require_permission("users", "view")):
    run = await db.get(ImportRun, run_id)
    if run is None:
        raise HTTPException(status_code=404, detail={"code": "run_not_found"})
    return await _run_out(db, run, with_rows=True)


@router.post("/import", response_model=ImportRunOut)
async def run_import(db: DbSession, actor: AuthContext = require_permission("users", "add")):
    try:
        run = await import_users(db, actor_id=actor.user.person_id, trigger="web")
    except ImportNotConfigured:
        raise HTTPException(status_code=409, detail={"code": "source_not_configured"}) from None
    except ImportSourceError as exc:
        raise HTTPException(status_code=502, detail={
            "code": "source_unavailable", "run_id": str(exc.run_id)}) from None
    return await _run_out(db, run, with_rows=True)


# ── one person ──

async def _target(db: AsyncSession, person_id: uuid.UUID) -> User:
    user = await db.get(User, person_id)
    if user is None:
        raise HTTPException(status_code=404, detail={"code": "person_not_found"})
    return user


def _can_manage(actor: AccessInfo, actor_id: uuid.UUID, target_id: uuid.UUID,
                target_rank: int) -> bool:
    return actor_id == target_id or can_touch_rank(actor.max_rank, target_rank)


@router.get("/{person_id}", response_model=UserDetailOut)
async def get_user(person_id: uuid.UUID, db: DbSession,
                   actor: AuthContext = require_permission("users", "view")):
    user = await _target(db, person_id)
    roles, ranks = await _roles_by_person(db)
    access = await resolve_access(db, person_id)
    overrides: dict[str, dict[str, bool]] = {}
    for res, action, allow in (await db.execute(
            select(PermissionOverride.resource, PermissionOverride.action,
                   PermissionOverride.allow)
            .where(PermissionOverride.person_id == person_id))).all():
        overrides.setdefault(res, {})[action] = allow
    can_manage = _can_manage(actor.access, actor.user.person_id, person_id, access.max_rank)
    sessions = []   # session details (IPs, browsers) stay hidden for people who outrank you
    if can_manage:
        now = datetime.now(UTC)
        sessions = await db.scalars(select(AuthSession).where(
            AuthSession.person_id == person_id, AuthSession.revoked_at.is_(None),
            AuthSession.rotated_at.is_(None), AuthSession.expires_at > now)
            .order_by(AuthSession.created_at.desc()))
    return UserDetailOut(
        user=_row(user, roles.get(person_id, []), ranks),
        first_name=user.first_name, last_name=user.last_name,
        preferred_name=user.preferred_name, job_title=user.job_title,
        cells={res: {a: EffectiveCellOut(value=access.perms[res][a],
                                          source=access.sources[res][a])
                     for a in access.perms[res]} for res in access.perms},
        overrides=overrides,
        sessions=[SessionRowOut(id=s.id, family_id=s.family_id, created_at=s.created_at,
                                expires_at=s.expires_at,
                                ip_address=str(s.ip_address) if s.ip_address else None,
                                user_agent=s.user_agent) for s in sessions],
        can_manage=can_manage)


@router.post("/{person_id}/sessions/revoke")
async def revoke_user_sessions(person_id: uuid.UUID, db: DbSession,
                               actor: AuthContext = require_permission("users", "change")):
    await _target(db, person_id)
    target_rank = (await resolve_access(db, person_id)).max_rank
    if not _can_manage(actor.access, actor.user.person_id, person_id, target_rank):
        raise HTTPException(status_code=403, detail={"code": "rank_too_low"})
    revoked = await revoke_sessions(db, person_id, reason="admin_revoke")
    audit(db, actor_id=actor.user.person_id, action="sessions.revoke", entity_type="user",
          entity_id=str(person_id), changes={"revoked": revoked})
    await db.commit()
    return {"revoked": revoked}
