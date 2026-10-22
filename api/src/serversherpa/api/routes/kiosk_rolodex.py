"""Kiosk Rolodex: admins list, open, edit, photograph and create workers
from the native kiosk apps (iOS and Android).

Design: docs/superpowers/specs/2026-10-22-kiosk-rolodex-design.md (§3.2-3.4,
§4.1).

Who gets in (`rolodex_actor`): a person session holding `kiosk:view`, rank
60 or more (GATE_BYPASS_RANK) and a global role, otherwise 403 `forbidden`.
The global check matters because a custom partner-anchored role can carry
a high rank; staff hold `workers` in full, so the rank bar is what keeps
them out. A move-password session is refused with 403 `move_locked`, and a
station key never reaches these routes (no person to rank-check, and
stations run unattended). Each route adds its own `workers:*` permission.

Which people (`require_rolodex_worker` and the list): exactly the portal's
`GET /workers` set — an active worker role, not archived, not a move's
hidden kiosk identity, inside the actor's `workers` scope. Anyone else is
404 `person_not_found`, so ids can't be probed.

Kiosk sessions reach `/kiosk/*` already (deps.enforce_session_scope), and
read-only mode (423) and a forced password change (403) apply to every
route here without anything extra.
"""

import hashlib
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.resolver import can_touch_rank
from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, DbSession, require_permission, require_rank
from serversherpa.api.schemas import (
    KioskRolodexCompany,
    KioskRolodexLevelOut,
    KioskRolodexListOut,
    KioskRolodexOptionsOut,
    KioskRolodexStatusOut,
    KioskRolodexWorkerDetailOut,
    KioskRolodexWorkerOut,
)
from serversherpa.api.worker_edits import target_rank
from serversherpa.db.models import (
    Partner,
    Person,
    PersonRole,
    StatusValue,
    UserAccount,
    WorkerLevel,
    WorkerProfile,
)
from serversherpa.db.ordering import natural
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE
from serversherpa.services.storage import presign_get
from serversherpa.status.labels import level_colors, level_fields, status_fields, status_labels

router = APIRouter(prefix="/kiosk/rolodex", tags=["kiosk"])


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


# ── gates ────────────────────────────────────────────────────────────

async def rolodex_actor(
    actor: AuthContext = require_permission("kiosk", "view"),
    _rank: AuthContext = require_rank(GATE_BYPASS_RANK),
) -> AuthContext:
    """The signed-in admin, or 403: `forbidden` without `kiosk:view`, rank
    60+ or a global role; `move_locked` for a move-password session."""
    if not actor.access.is_global:
        raise _err(403, "forbidden")
    if actor.session.initiative_id is not None:
        raise _err(403, "move_locked")
    return actor


def _visible_workers(actor: AuthContext) -> Select:
    """Every worker the actor can see in the portal: the query and scope
    filter of `GET /workers`, one row per worker as
    (Person, WorkerProfile | None, partner id, partner name, account id)."""
    query = (
        select(Person, WorkerProfile, Partner.id, Partner.name, UserAccount.person_id)
        .join(PersonRole, (PersonRole.person_id == Person.id)
              & (PersonRole.role == "worker")
              & (PersonRole.revoked_at.is_(None)))
        .outerjoin(WorkerProfile, WorkerProfile.person_id == Person.id)
        .outerjoin(Partner, Partner.id == WorkerProfile.partner_id)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .where(Person.archived_at.is_(None),
               Person.source != KIOSK_MOVE_SOURCE)   # a move's hidden kiosk identity
    )
    cond = scope_conditions("workers", actor.access, actor.person.id)
    if cond is not None:
        query = query.where(cond)
    return query


async def require_rolodex_worker(
    db: AsyncSession, actor: AuthContext, person_id: uuid.UUID,
) -> Person:
    """The worker behind a Rolodex id, or 404 `person_not_found` when the
    person is missing, archived, a move's hidden identity, holds no active
    worker role, or is outside the actor's `workers` scope."""
    person = await db.scalar(
        _visible_workers(actor).where(Person.id == person_id).limit(1))
    if person is None:
        raise _err(404, "person_not_found")
    return person


# ── payloads ─────────────────────────────────────────────────────────

def photo_version(avatar_key: str | None) -> str | None:
    """A stable cache key for the worker's photo: the first 16 hex of the
    key's sha256. Every upload stores a new key, so the version changes
    with the photo; the presigned URL changes on every request instead."""
    if not avatar_key:
        return None
    return hashlib.sha256(avatar_key.encode()).hexdigest()[:16]


def _row_fields(
    person: Person, profile: WorkerProfile | None, partner_id: uuid.UUID | None,
    partner_name: str | None, has_account: bool,
    labels: dict[str, tuple[str, str]], lvl_colors: dict[str, str],
) -> dict:
    """The list row's fields, shared by the row and the worker page. A
    worker with no profile row reads as Active, unleveled, no company."""
    return {
        "person_id": person.id,
        "first_name": person.first_name,
        "last_name": person.last_name,
        "preferred_name": person.preferred_name,
        "display_name": person.display_name,
        "job_title": person.job_title,
        "company": (KioskRolodexCompany(id=partner_id, name=partner_name)
                    if partner_id else None),
        "trade": profile.trade if profile else None,
        **level_fields(profile.level if profile else None, lvl_colors),
        **status_fields(profile.status if profile else "active", labels),
        "has_photo": bool(person.avatar_key),
        "photo_url": presign_get(person.avatar_key),
        "photo_version": photo_version(person.avatar_key),
        "rfid_enrolled": bool(person.rfid_tag),
        "has_account": has_account,
    }


async def _block_reasons(
    db: AsyncSession, actor: AuthContext, person: Person, has_account: bool,
) -> tuple[str | None, str | None]:
    """(edit_block_reason, status_block_reason), predicting the write
    guards in `worker_edits`. Person fields: only a target with a portal
    login ranked at or above the actor is locked (`can_touch_rank`), and
    never the actor's own row. Status: the actor's own row is `self`
    first (the profile guard checks rank before self, which would say
    `rank_too_low` to an admin looking at themselves), then any target
    the actor can't touch, login or not, as the profile guard ranks
    every target."""
    is_self = person.id == actor.person.id
    touchable = can_touch_rank(actor.access.max_rank, await target_rank(db, person.id))
    edit_block = "rank_too_low" if has_account and not is_self and not touchable else None
    if is_self:
        status_block = "self"
    elif not touchable:
        status_block = "rank_too_low"
    else:
        status_block = None
    return edit_block, status_block


async def worker_detail(
    db: AsyncSession, actor: AuthContext, person: Person,
) -> KioskRolodexWorkerDetailOut:
    """The worker page for a person `require_rolodex_worker` returned."""
    profile = await db.get(WorkerProfile, person.id)
    partner = (await db.get(Partner, profile.partner_id)
               if profile is not None and profile.partner_id else None)
    has_account = await db.get(UserAccount, person.id) is not None
    edit_block, status_block = await _block_reasons(db, actor, person, has_account)
    return KioskRolodexWorkerDetailOut(
        **_row_fields(person, profile,
                      partner.id if partner else None,
                      partner.name if partner else None,
                      has_account,
                      await status_labels(db, "worker"),
                      await level_colors(db)),
        email=person.email,
        phone=person.phone,
        external_id=person.external_id,
        status_note=profile.status_note if profile else None,
        can_edit=edit_block is None,
        can_change_status=status_block is None,
        edit_block_reason=edit_block,
        status_block_reason=status_block,
    )


# ── routes ───────────────────────────────────────────────────────────

@router.get("/workers", response_model=KioskRolodexListOut)
async def list_rolodex_workers(
    db: DbSession,
    actor: AuthContext = Depends(rolodex_actor),
    _perm: AuthContext = require_permission("workers", "view"),
) -> KioskRolodexListOut:
    """Every worker the admin can see in the portal, by last name, then
    first name (natural order). The apps cache this list offline, so it
    has no email or phone. One response, no paging."""
    generated_at = datetime.now(UTC)
    rows = (await db.execute(
        _visible_workers(actor)
        .order_by(natural(Person.last_name), natural(Person.first_name), Person.id)
    )).all()
    labels = await status_labels(db, "worker")
    lvl_colors = await level_colors(db)
    return KioskRolodexListOut(
        generated_at=generated_at,
        workers=[
            KioskRolodexWorkerOut(**_row_fields(
                person, profile, partner_id, partner_name, account_id is not None,
                labels, lvl_colors))
            for person, profile, partner_id, partner_name, account_id in rows
        ],
    )


@router.get("/workers/{person_id}", response_model=KioskRolodexWorkerDetailOut)
async def get_rolodex_worker(
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = Depends(rolodex_actor),
    _perm: AuthContext = require_permission("workers", "view"),
) -> KioskRolodexWorkerDetailOut:
    """The worker page: the row plus email, phone, Employee ID and status
    note, and what this admin may change (`can_edit`,
    `can_change_status` and their reasons)."""
    person = await require_rolodex_worker(db, actor, person_id)
    return await worker_detail(db, actor, person)


@router.get("/options", response_model=KioskRolodexOptionsOut)
async def rolodex_options(
    db: DbSession,
    actor: AuthContext = Depends(rolodex_actor),
    _perm: AuthContext = require_permission("workers", "view"),
) -> KioskRolodexOptionsOut:
    """The pickers' choices: the level scale in rank order, the active
    worker statuses in their sort order (the kiosk can't read
    /status-values), and the non-archived partners in natural order. A
    worker still linked to a since-archived partner keeps showing it on
    their row; it just isn't offered here."""
    levels = await db.scalars(select(WorkerLevel).order_by(WorkerLevel.rank))
    statuses = await db.scalars(
        select(StatusValue)
        .where(StatusValue.record_type == "worker", StatusValue.is_active.is_(True))
        .order_by(StatusValue.sort_order, StatusValue.key))
    partners_q = select(Partner.id, Partner.name).where(Partner.archived_at.is_(None))
    cond = scope_conditions("partners", actor.access, actor.person.id)
    if cond is not None:      # admins are global; kept for defense
        partners_q = partners_q.where(cond)
    partners = (await db.execute(
        partners_q.order_by(natural(Partner.name), Partner.id))).all()
    return KioskRolodexOptionsOut(
        levels=[KioskRolodexLevelOut(level=lv.level, title=lv.title, color=lv.color)
                for lv in levels],
        statuses=[KioskRolodexStatusOut(key=s.key, label=s.label, color=s.color)
                  for s in statuses],
        partners=[KioskRolodexCompany(id=pid, name=name) for pid, name in partners],
    )
