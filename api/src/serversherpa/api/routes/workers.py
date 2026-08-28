"""Workers — people holding the worker role, with profile (trade / level /
status / partner rollup), certifications, and the editable level scale.

Blacklist policy: setting a worker's status to blacklist automatically
disables their login account and revokes every session; leaving blacklist
re-enables the account (noted in the UI).
"""

import uuid
from datetime import UTC, date, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import can_touch_rank
from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    CertCreateIn,
    CertItem,
    PartnerRef,
    WorkerItem,
    WorkerLevelCreateIn,
    WorkerLevelOut,
    WorkerLevelUpdateIn,
    WorkerProfileIn,
)
from serversherpa.db.models import (
    AuthSession,
    Partner,
    Person,
    PersonRole,
    Role,
    StatusValue,
    UserAccount,
    WorkerCertification,
    WorkerLevel,
    WorkerProfile,
)
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.storage import presign_get
from serversherpa.status.labels import (
    level_colors, level_fields, status_fields, status_labels,
)

router = APIRouter(prefix="/workers", tags=["workers"])
levels_router = APIRouter(prefix="/worker-levels", tags=["workers"])


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def _require_worker(db: AsyncSession, person_id: uuid.UUID) -> Person:
    person = await db.get(Person, person_id)
    if person is None:
        raise _err(404, "person_not_found")
    has_role = await db.scalar(
        select(PersonRole.id).where(
            PersonRole.person_id == person_id,
            PersonRole.role == "worker",
            PersonRole.revoked_at.is_(None),
        ).limit(1))
    if has_role is None:
        raise _err(422, "not_a_worker")
    return person


async def _check_worker_scope(
    db: AsyncSession, actor: AuthContext, person_id: uuid.UUID,
) -> None:
    """Detail/mutation re-check: 404 (never 403) on an out-of-scope worker —
    no ID probing."""
    cond = scope_conditions("workers", actor.access, actor.person.id)
    if cond is None:
        return
    visible = await db.scalar(
        select(WorkerProfile.person_id)
        .where(WorkerProfile.person_id == person_id, cond))
    if visible is None:
        raise _err(404, "person_not_found")


@router.get("", response_model=list[WorkerItem])
async def list_workers(
    db: DbSession,
    actor: AuthContext = require_permission("workers", "view"),
) -> list[WorkerItem]:
    today = date.today()
    query = (
        select(Person, WorkerProfile, Partner.id, Partner.name, UserAccount.person_id)
        .join(PersonRole, (PersonRole.person_id == Person.id)
              & (PersonRole.role == "worker")
              & (PersonRole.revoked_at.is_(None)))
        .outerjoin(WorkerProfile, WorkerProfile.person_id == Person.id)
        .outerjoin(Partner, Partner.id == WorkerProfile.partner_id)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(Person.archived_at.is_(None))
        .order_by(Person.last_name, Person.first_name)
    )
    cond = scope_conditions("workers", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    rows = (await db.execute(query)).all()

    person_ids = [p.id for p, *_ in rows]
    cert_rows = (await db.execute(
        select(
            WorkerCertification.person_id,
            func.count(),
            func.count().filter(WorkerCertification.expires_on < today),
        )
        .where(WorkerCertification.person_id.in_(person_ids or [uuid.uuid4()]))
        .group_by(WorkerCertification.person_id)
    )).all()
    certs = {pid: (total, expired) for pid, total, expired in cert_rows}
    labels = await status_labels(db, "worker")
    lvl_colors = await level_colors(db)

    return [
        WorkerItem(
            person_id=person.id,
            display_name=person.display_name,
            first_name=person.first_name,
            last_name=person.last_name,
            contact_email=person.email,
            phone=person.phone,
            avatar_url=presign_get(person.avatar_key),
            has_account=account_id is not None,
            trade=profile.trade if profile else None,
            **level_fields(profile.level if profile else None, lvl_colors),
            **status_fields(profile.status if profile else "active", labels),
            status_note=profile.status_note if profile else None,
            partner=(PartnerRef(id=partner_id, name=partner_name)
                     if partner_id else None),
            cert_count=certs.get(person.id, (0, 0))[0],
            certs_expired=certs.get(person.id, (0, 0))[1],
        )
        for person, profile, partner_id, partner_name, account_id in rows
    ]


# worker_profiles.status is Mapped[str] (NOT NULL, server_default 'active').
# trade/level/partner_id/status_note are all genuinely nullable — clearing
# them is a real edit, so they must NOT be listed here.
NON_NULLABLE_PROFILE_FIELDS = ("status",)


async def _get_or_create_profile(
    db: DbSession, person_id: uuid.UUID, actor_id: uuid.UUID,
) -> WorkerProfile:
    """Get the existing profile, or create one and flush it immediately
    inside a savepoint. worker_profiles' PK is person_id — under
    concurrent PUTs for the same worker, both requests can miss the
    initial get() and both insert. Flushing inside the guard (rather than
    letting the insert ride along to the final commit) catches the
    conflict here, before the mutate/audit/session-revocation flow below
    ever runs against what would otherwise be a doomed pending row. On
    IntegrityError the pending row is expunged automatically, so
    re-select the concurrent winner and return that instead."""
    profile = await db.get(WorkerProfile, person_id)
    if profile is not None:
        return profile
    try:
        async with db.begin_nested():
            profile = WorkerProfile(person_id=person_id, created_by=actor_id)
            db.add(profile)
            await db.flush()
        return profile
    except IntegrityError:
        profile = await db.get(WorkerProfile, person_id)
        if profile is None:       # violation wasn't ours — re-raise
            raise
        return profile


@router.put("/{person_id}/profile", status_code=204)
async def upsert_profile(
    person_id: uuid.UUID,
    body: WorkerProfileIn,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "change"),
) -> None:
    await _require_worker(db, person_id)
    await _check_worker_scope(db, actor, person_id)
    data = body.model_dump(exclude_unset=True)
    # status is the only NOT NULL column among the mutable fields
    # (db/models.py:251), but the schema types it `str | None` and
    # exclude_unset INCLUDES an explicitly sent null — so `{"status": null}`
    # would setattr None and surface as an unhandled IntegrityError. Mirrors
    # sites' NON_NULLABLE_SITE_FIELDS, which likewise includes "status".
    # `is None`, not falsy: the empty string is a distinct (if unknown) key
    # and belongs to the unknown_status check below, not here.
    for field in NON_NULLABLE_PROFILE_FIELDS:
        if field in data and data[field] is None:
            raise _err(422, f"{field}_required")

    profile = await _get_or_create_profile(db, person_id, actor.person.id)

    fields = ["partner_id", "trade", "level", "status", "status_note"]
    before = snapshot(profile, fields)

    old_status = profile.status or "active"
    new_status = data.get("status", old_status)

    if new_status == "blacklist":
        note = data.get("status_note", profile.status_note)
        if not note:
            raise _err(422, "blacklist_requires_note")
        # blacklisting someone with elevated roles requires outranking them
        target_rank = (await db.scalar(
            select(func.max(Role.rank))
            .join(PersonRole, PersonRole.role == Role.name)
            .where(PersonRole.person_id == person_id,
                   PersonRole.revoked_at.is_(None)))) or 0
        if not can_touch_rank(actor.access.max_rank, target_rank):
            raise _err(403, "rank_too_low")
        if person_id == actor.person.id:
            raise _err(403, "cannot_target_self")

    if "level" in data and data["level"] is not None:
        if await db.get(WorkerLevel, data["level"]) is None:
            raise _err(422, "unknown_level")
    if "partner_id" in data and data["partner_id"] is not None:
        if await db.get(Partner, data["partner_id"]) is None:
            raise _err(422, "partner_not_found")
    if "status" in data and data["status"] is not None:
        # status is vocabulary, not free text — validate against status_values
        # the same way sites' _check_lookups does. No is_active filter: the
        # portal rebuilds the whole profile payload (including status) on
        # every edit, so filtering out retired statuses here would make any
        # record on a retired status uneditable. Sites don't filter it either.
        if await db.scalar(
            select(StatusValue).where(
                StatusValue.record_type == "worker", StatusValue.key == data["status"])
        ) is None:
            raise _err(422, "unknown_status")

    for field, value in data.items():
        setattr(profile, field, value)
    if profile.status != "blacklist":
        profile.status_note = data.get("status_note", profile.status_note)
    now = datetime.now(UTC)
    profile.updated_at = now

    # blacklist ⇄ login access coupling
    account = await db.get(UserAccount, person_id)
    if account is not None:
        if new_status == "blacklist" and old_status != "blacklist":
            account.disabled_at = now
            account.updated_at = now
            await db.execute(
                update(AuthSession)
                .where(AuthSession.person_id == person_id,
                       AuthSession.revoked_at.is_(None))
                .values(revoked_at=now, revoke_reason="account_disabled")
            )
        elif old_status == "blacklist" and new_status != "blacklist":
            account.disabled_at = None
            account.failed_login_count = 0
            account.locked_until = None
            account.updated_at = now

    changes = diff(before, snapshot(profile, fields))
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="worker",
              entity_id=str(person_id), action="profile.update",
              changes=changes)
    await db.commit()


# ── certifications ─────────────────────────────────────────────────


@router.get("/{person_id}/certifications", response_model=list[CertItem])
async def list_certifications(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "view"),
) -> list[CertItem]:
    await _require_worker(db, person_id)
    await _check_worker_scope(db, actor, person_id)
    rows = (await db.scalars(
        select(WorkerCertification)
        .where(WorkerCertification.person_id == person_id)
        .order_by(WorkerCertification.expires_on.asc().nulls_last(),
                  WorkerCertification.name)
    )).all()
    return [CertItem.model_validate(c) for c in rows]


@router.post("/{person_id}/certifications", response_model=CertItem, status_code=201)
async def add_certification(
    person_id: uuid.UUID,
    body: CertCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "add"),
) -> CertItem:
    await _require_worker(db, person_id)
    await _check_worker_scope(db, actor, person_id)
    cert = WorkerCertification(
        person_id=person_id, created_by=actor.person.id,
        **body.model_dump())
    db.add(cert)
    audit(db, actor_id=actor.person.id, entity_type="worker",
          entity_id=str(person_id), action="certification.add",
          changes={"name": {"from": None, "to": body.name}})
    await db.commit()
    return CertItem.model_validate(cert)


@router.delete("/{person_id}/certifications/{cert_id}", status_code=204)
async def delete_certification(
    person_id: uuid.UUID,
    cert_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("workers", "delete"),
) -> None:
    cert = await db.get(WorkerCertification, cert_id)
    if cert is None or cert.person_id != person_id:
        raise _err(404, "certification_not_found")
    await _check_worker_scope(db, actor, person_id)
    audit(db, actor_id=actor.person.id, entity_type="worker",
          entity_id=str(person_id), action="certification.remove",
          changes={"name": {"from": cert.name, "to": None}})
    await db.delete(cert)
    await db.commit()


# ── editable level scale ───────────────────────────────────────────


@levels_router.get("", response_model=list[WorkerLevelOut])
async def list_levels(
    db: DbSession,
    _actor: AuthContext = require_permission("workers", "view"),
) -> list[WorkerLevelOut]:
    rows = (await db.scalars(
        select(WorkerLevel).order_by(WorkerLevel.rank))).all()
    return [WorkerLevelOut.model_validate(r) for r in rows]


# every mutable column on WorkerLevel is NOT NULL (db/models.py:236-239), but
# the update schema types them `X | None` and exclude_unset INCLUDES an
# explicitly sent null — so `{"description": null}` would setattr None and
# either 500 on IntegrityError or (for JSONB) silently no-op. Pre-checking
# mirrors update_status_value / update_site_type.
# The predicate is `is None`, NOT a falsy check: `expected_skills: []` is a
# legitimate value (a level with no listed skills) that must pass through.
NON_NULLABLE_WORKER_LEVEL_FIELDS = ("title", "description", "expected_skills", "color")


@levels_router.patch("/{level}", response_model=WorkerLevelOut)
async def update_level(
    level: str,
    body: WorkerLevelUpdateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> WorkerLevelOut:
    row = await db.get(WorkerLevel, level)
    if row is None:
        raise _err(404, "level_not_found")
    fields = ["title", "description", "expected_skills", "color"]
    data = body.model_dump(exclude_unset=True)
    # reject an explicit null up front rather than letting it reach the UPDATE
    for field in NON_NULLABLE_WORKER_LEVEL_FIELDS:
        if field in data and data[field] is None:
            raise _err(422, f"{field}_required")
    before = snapshot(row, fields)
    # no `value is not None` guard: it would silently DROP an explicit
    # `expected_skills: []`, leaving the row unchanged while still returning
    # 200. exclude_unset already means "the caller named this field", and the
    # null case is handled by the pre-check above. Mirrors update_status_value.
    for field, value in data.items():
        setattr(row, field, value)
    changes = diff(before, snapshot(row, fields))
    if changes:
        row.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type="worker_level",
              entity_id=level, action="update", changes=changes)
    await db.commit()
    return WorkerLevelOut.model_validate(row)


# fields captured for the create audit snapshot: the mutable columns
# update_level touches, plus the two that only exist at creation time.
LEVEL_FIELDS = ["level", "rank", "title", "description", "expected_skills", "color"]


@levels_router.post("", response_model=WorkerLevelOut, status_code=201)
async def create_level(
    body: WorkerLevelCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "add"),
) -> WorkerLevelOut:
    if await db.get(WorkerLevel, body.level) is not None:
        raise _err(409, "worker_level_exists")

    if body.after is None:
        new_rank = 1
    else:
        anchor = await db.get(WorkerLevel, body.after)
        if anchor is None:
            raise _err(422, "unknown_level")
        new_rank = anchor.rank + 1

    # Safe without deferring to commit: worker_levels_rank_key is DEFERRABLE,
    # which makes Postgres check uniqueness at STATEMENT end rather than per
    # row, so this single `rank + 1` shift never sees the transient collision
    # a per-row check would (3 -> 4 landing on the row still at 4). It stays
    # INITIALLY IMMEDIATE so a real violation still raises on this statement,
    # where it's attributable, instead of at COMMIT.
    await db.execute(
        update(WorkerLevel)
        .where(WorkerLevel.rank >= new_rank)
        .values(rank=WorkerLevel.rank + 1))

    row = WorkerLevel(level=body.level, rank=new_rank, title=body.title,
                      description=body.description,
                      expected_skills=body.expected_skills, color=body.color,
                      updated_at=datetime.now(UTC))
    db.add(row)
    audit(db, actor_id=actor.person.id, entity_type="worker_level",
          entity_id=body.level, action="create",
          changes=diff({}, snapshot(row, LEVEL_FIELDS)))
    await db.commit()
    return WorkerLevelOut.model_validate(row)
