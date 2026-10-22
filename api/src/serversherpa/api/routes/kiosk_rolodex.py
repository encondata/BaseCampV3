"""Kiosk Rolodex: admins list, open, edit, photograph and create workers
from the native kiosk apps (iOS and Android).

Design: docs/superpowers/specs/2026-10-22-kiosk-rolodex-design.md (§3.2-3.9,
§3.14, §3.16, §3.17, §4.1).

Who gets in (`rolodex_actor`): a person session holding `kiosk:view`, rank
60 or more (GATE_BYPASS_RANK) and a global role, otherwise 403 `forbidden`.
The global check matters because a custom partner-anchored role can carry
a high rank; staff hold `workers` in full, so the rank bar is what keeps
them out. A move-password session is refused with 403 `move_locked`, and a
station key never reaches these routes (no person to rank-check, and
stations run unattended). Each route adds its own `workers:*` permission.

Which people (`require_rolodex_worker` and the list): exactly the portal's
`GET /workers` set, through the same `worker_edits.visible_workers_query`
— an active worker role, not archived, not a move's hidden kiosk
identity, inside the actor's `workers` scope. Anyone else is 404
`person_not_found`, so ids can't be probed.

Writes (duplicates, create, edit) reuse the portal's rules: edits go
through `worker_edits.apply_person_update` / `apply_profile_update`, so
`rank_too_low`, `blacklist_requires_note`, the vocab checks and the
blacklist ⇄ login coupling are the portal's own. Every write audits with
the generic actions plus `"via": "kiosk_rolodex"` and `"device"` (the
kiosk serial bound to the session, None until a kiosk binds it).

The photo (`PUT /workers/{id}/photo`) is a raw JPEG body, not multipart:
the route declares no body parameter, so every gate runs before a byte of
the upload is read, then it reads the body itself under the 5 MiB cap. It
follows the edit rule (§3.17) and reuses the portal's avatar bookkeeping
(`attachments.replace_avatar`).

Kiosk sessions reach `/kiosk/*` already (deps.enforce_session_scope), and
read-only mode (423) and a forced password change (403) apply to every
route here without anything extra.
"""

import asyncio
import hashlib
import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import exists, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.resolver import can_touch_rank
from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, DbSession, require_permission, require_rank
from serversherpa.api.routes.attachments import MAX_IMAGE_BYTES, _sniff_image, replace_avatar
from serversherpa.api.schemas import (
    KioskRolodexCompany,
    KioskRolodexCreateIn,
    KioskRolodexDuplicatesIn,
    KioskRolodexDuplicatesOut,
    KioskRolodexLevelOut,
    KioskRolodexListOut,
    KioskRolodexMatchOut,
    KioskRolodexOptionsOut,
    KioskRolodexPatchIn,
    KioskRolodexPhotoOut,
    KioskRolodexStatusOut,
    KioskRolodexWorkerDetailOut,
    KioskRolodexWorkerOut,
)
from serversherpa.api.worker_edits import (
    apply_person_update,
    apply_profile_update,
    get_or_create_profile,
    target_rank,
    visible_workers_query,
)
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
from serversherpa.people.bulk_import import name_keys, normalize_phone
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE
from serversherpa.services.storage import delete_object, loggable, presign_get, put_object
from serversherpa.status.labels import level_colors, level_fields, status_fields, status_labels

router = APIRouter(prefix="/kiosk/rolodex", tags=["kiosk"])
logger = logging.getLogger("serversherpa.api.routes.kiosk_rolodex")


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


async def require_rolodex_worker(
    db: AsyncSession, actor: AuthContext, person_id: uuid.UUID,
) -> Person:
    """The worker behind a Rolodex id, or 404 `person_not_found` when the
    person is missing, archived, a move's hidden identity, holds no active
    worker role, or is outside the actor's `workers` scope."""
    person = await db.scalar(
        visible_workers_query(actor).where(Person.id == person_id).limit(1))
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
        visible_workers_query(actor)
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


# ── writes ───────────────────────────────────────────────────────────

# The worker page's fields, split by the helper that owns them.
PERSON_FIELDS = ("first_name", "last_name", "preferred_name", "job_title", "phone", "email")
PROFILE_FIELDS = ("partner_id", "trade", "level", "status", "status_note")

# people.email's partial unique index (migration 0001); it covers archived
# people too.
EMAIL_INDEX = "people_email_uniq"


def _audit_extra(actor: AuthContext) -> dict:
    """What every Rolodex audit row adds to its changes (spec §3.14)."""
    return {"via": "kiosk_rolodex", "device": actor.session.kiosk_serial}


def _is_email_clash(exc: IntegrityError) -> bool:
    """True only when the failure is the people email index, so any other
    integrity error (a vanished foreign key, say) isn't misreported as
    `email_in_use`. The constraint name lives on the original asyncpg
    exception, which SQLAlchemy's DBAPI wrapper chains as `__cause__`."""
    cause = exc.orig.__cause__ if exc.orig is not None else None
    return getattr(cause, "constraint_name", None) == EMAIL_INDEX


async def _email_taken(
    db: AsyncSession, email: str, *, exclude: uuid.UUID | None = None,
) -> bool:
    """Whether someone other than `exclude` already uses `email`, in any
    case (CITEXT), archived people included, as the unique index sees it.
    The IntegrityError mapping stays as the fallback for a race."""
    query = select(Person.id).where(Person.email == email)
    if exclude is not None:
        query = query.where(Person.id != exclude)
    return await db.scalar(query.limit(1)) is not None


async def _check_new_partner(db: AsyncSession, partner_id: uuid.UUID) -> None:
    """A company the worker is newly linked to must exist (422
    `partner_not_found`) and not be archived (422 `partner_archived`). A
    worker keeps a company that was archived after they joined it."""
    partner = await db.get(Partner, partner_id)
    if partner is None:
        raise _err(422, "partner_not_found")
    if partner.archived_at is not None:
        raise _err(422, "partner_archived")


def _squashed_sql(expr):
    """SQL's take on `bulk_import._squash` (which builds `name_keys`):
    whitespace runs collapsed, trimmed, lowercased. Exactly `_squash` for
    printable ASCII; beyond it Postgres lower() isn't casefold (ß stays ß,
    İ becomes i, final ς stays ς), see `_NOT_PLAIN_ASCII`."""
    return func.lower(func.btrim(func.regexp_replace(expr, r"\s+", " ", "g")))


# Any character outside printable ASCII (space through tilde). Names made
# only of printable ASCII squash identically in SQL and Python, so the IN
# check finds every name match among them; a name with anything else may
# casefold differently from Postgres lower(), so it is always a candidate
# and the Python rule decides.
_NOT_PLAIN_ASCII = r"[^ -~]"


async def find_duplicates(
    db: AsyncSession, *, first_name: str, last_name: str,
    preferred_name: str | None = None, email: str | None = None,
    phone: str | None = None,
) -> list[KioskRolodexMatchOut]:
    """Everyone already in the portal who may be this new worker (spec
    §3.7, §3.16): any non-archived person, worker or not, except a move's
    hidden kiosk identity, whose `first last` or `preferred last` matches
    either spelling of the new name (case- and whitespace-insensitive, the
    bulk import's `name_keys`), whose email matches in any case, or whose
    phone matches once normalized (`normalize_phone`: digits only, a US
    leading 1 dropped, under 7 digits is no key). `matched_on` names every
    way each person matched. Sorted by last name, then first name.

    SQL only narrows the candidates, and always to a superset of what the
    Python rules match; the Python rules are the answer."""
    keys = name_keys(first_name, last_name, preferred_name or "")
    email_key = (email or "").strip()
    phone_key = normalize_phone(phone or "")

    conds = []
    if keys:
        # Whole "given last" strings, so "Mary Ann" + "Smith" finds "Mary" +
        # "Ann Smith" (a null preferred name concatenates to null: no match).
        wanted = sorted(keys)
        conds.append(or_(
            _squashed_sql(Person.first_name + " " + Person.last_name).in_(wanted),
            _squashed_sql(Person.preferred_name + " " + Person.last_name).in_(wanted),
            func.concat(Person.first_name, Person.last_name, Person.preferred_name)
            .regexp_match(_NOT_PLAIN_ASCII)))
    if email_key:
        conds.append(Person.email == email_key)            # CITEXT: any case
    if phone_key:
        # normalize_phone drops a leading 1 only from an 11-digit number
        spellings = [phone_key, f"1{phone_key}"] if len(phone_key) == 10 else [phone_key]
        conds.append(func.regexp_replace(Person.phone, r"\D", "", "g").in_(spellings))
    if not conds:
        return []

    # Pass 1: just the matching columns of the candidates, judged in Python.
    candidates = (await db.execute(
        select(Person.id, Person.first_name, Person.last_name, Person.preferred_name,
               Person.email, Person.phone)
        .where(Person.archived_at.is_(None),
               Person.source != KIOSK_MOVE_SOURCE,     # a move's hidden kiosk identity
               or_(*conds))
    )).all()
    matched_on: dict[uuid.UUID, list[str]] = {}
    for pid, first, last, preferred, p_email, p_phone in candidates:
        on = []
        if keys & name_keys(first, last, preferred or ""):
            on.append("name")
        if email_key and (p_email or "").casefold() == email_key.casefold():
            on.append("email")
        if phone_key and normalize_phone(p_phone or "") == phone_key:
            on.append("phone")
        if on:
            matched_on[pid] = on
    if not matched_on:
        return []

    # Pass 2: the match cards, for the matches only.
    is_worker = exists().where(
        PersonRole.person_id == Person.id, PersonRole.role == "worker",
        PersonRole.revoked_at.is_(None)).label("is_worker")
    rows = (await db.execute(
        select(Person, is_worker, UserAccount.person_id, Partner.name)
        .outerjoin(UserAccount, UserAccount.person_id == Person.id)
        .outerjoin(WorkerProfile, WorkerProfile.person_id == Person.id)
        .outerjoin(Partner, Partner.id == WorkerProfile.partner_id)
        .where(Person.id.in_(list(matched_on)))
        .order_by(natural(Person.last_name), natural(Person.first_name), Person.id)
    )).all()
    return [
        KioskRolodexMatchOut(
            person_id=person.id,
            display_name=person.display_name,
            job_title=person.job_title,
            company=company,
            is_worker=bool(worker),
            has_account=account_id is not None,
            photo_url=presign_get(person.avatar_key),
            photo_version=photo_version(person.avatar_key),
            matched_on=matched_on[person.id],
        )
        for person, worker, account_id, company in rows
    ]


@router.post("/duplicates", response_model=KioskRolodexDuplicatesOut)
async def rolodex_duplicates(
    body: KioskRolodexDuplicatesIn,
    db: DbSession,
    actor: AuthContext = Depends(rolodex_actor),
    _perm: AuthContext = require_permission("workers", "add"),
) -> KioskRolodexDuplicatesOut:
    """The New worker form's duplicate check, run when the admin leaves
    the details step (`find_duplicates`). A POST so names stay out of
    URLs; it writes nothing. Matches that aren't workers get no Open in
    the apps (the kiosk never grants roles); an email match blocks Create
    anyway, since the email can't be reused."""
    return KioskRolodexDuplicatesOut(matches=await find_duplicates(db, **body.model_dump()))


@router.post("/workers", response_model=KioskRolodexWorkerDetailOut, status_code=201)
async def create_rolodex_worker(
    body: KioskRolodexCreateIn,
    db: DbSession,
    actor: AuthContext = Depends(rolodex_actor),
    _perm: AuthContext = require_permission("workers", "add"),
) -> KioskRolodexWorkerDetailOut:
    """New worker, in one transaction: the Person (`source="manual"`,
    `source_ref="kiosk-rolodex:<serial or 'unknown'>"`), an active
    `worker` role and an Active worker profile, so the Time Clock's roster
    (`/kiosk/sync/people`) picks them up. No portal login.

    422 `unknown_level` / `partner_not_found` / `partner_archived`; 409
    `email_in_use` when anyone (archived people too) has the email, even
    with `allow_duplicate`; 409 `possible_duplicate` (with the `matches`)
    when `find_duplicates` finds anyone, unless `allow_duplicate`. One
    `person/create` audit row, with `photo_skipped` when the admin chose
    Create without photo."""
    if body.level is not None and await db.get(WorkerLevel, body.level) is None:
        raise _err(422, "unknown_level")
    if body.partner_id is not None:
        await _check_new_partner(db, body.partner_id)
    if body.email is not None and await _email_taken(db, body.email):
        raise _err(409, "email_in_use")
    if not body.allow_duplicate:
        matches = await find_duplicates(
            db, first_name=body.first_name, last_name=body.last_name,
            preferred_name=body.preferred_name, email=body.email, phone=body.phone)
        if matches:
            raise _err(409, "possible_duplicate",
                       matches=[m.model_dump(mode="json") for m in matches])

    actor_id = actor.person.id
    person = Person(**{f: getattr(body, f) for f in PERSON_FIELDS},
                    source="manual",
                    source_ref=f"kiosk-rolodex:{actor.session.kiosk_serial or 'unknown'}",
                    created_by=actor_id)
    try:
        db.add(person)
        await db.flush()
        profile = WorkerProfile(person_id=person.id, created_by=actor_id,
                                partner_id=body.partner_id, trade=body.trade,
                                level=body.level, status="active")
        db.add(profile)
        db.add(PersonRole(person_id=person.id, role="worker", granted_by=actor_id))
        changes = diff({}, {**snapshot(person, list(PERSON_FIELDS)),
                            **snapshot(profile, list(PROFILE_FIELDS))})
        changes["roles"] = {"from": None, "to": ["worker"]}
        changes["account"] = {"from": None, "to": False}
        if body.photo_skipped:
            changes["photo_skipped"] = {"from": None, "to": True}
        audit(db, actor_id=actor_id, entity_type="person", entity_id=str(person.id),
              action="create", changes={**changes, **_audit_extra(actor)})
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        if _is_email_clash(exc):
            raise _err(409, "email_in_use") from None
        raise
    return await worker_detail(db, actor, await require_rolodex_worker(db, actor, person.id))


@router.patch("/workers/{person_id}", response_model=KioskRolodexWorkerDetailOut)
async def update_rolodex_worker(
    person_id: uuid.UUID,
    body: KioskRolodexPatchIn,
    db: DbSession,
    actor: AuthContext = Depends(rolodex_actor),
    _perm: AuthContext = require_permission("workers", "change"),
) -> KioskRolodexWorkerDetailOut:
    """Save the worker page: only the fields sent (null clears). Person
    fields go through the portal's `PATCH /workers/{id}/person` rules
    (`rank_too_low` on a login ranked at or above yours, `{field}_required`)
    and profile fields through `PUT /workers/{id}/profile`'s
    (`rank_too_low` / `cannot_target_self` on a status change,
    `blacklist_requires_note`, `unknown_level`, `partner_not_found`,
    `unknown_status`; blacklisting an account holder disables the login
    and ends their sessions), all in ONE transaction: if either part is
    refused, neither lands. Rolodex extras: your own status is
    `cannot_target_self` (not the profile guard's `rank_too_low`), a new
    link to an archived company is 422 `partner_archived`, and every save
    creates a missing worker profile (Active), so the worker stays on the
    Time Clock's roster. 409 `email_in_use` for an email someone else has.
    Returns the worker page."""
    person = await require_rolodex_worker(db, actor, person_id)
    data = body.model_dump(exclude_unset=True)
    person_data = {k: v for k, v in data.items() if k in PERSON_FIELDS}
    profile_data = {k: v for k, v in data.items() if k in PROFILE_FIELDS}

    profile = await db.get(WorkerProfile, person.id)
    if (profile_data.get("status") is not None and person.id == actor.person.id
            and profile_data["status"] != (profile.status if profile else "active")):
        # the profile guard ranks before it checks self, which would tell
        # an admin `rank_too_low` about their own row
        raise _err(403, "cannot_target_self")
    new_partner = profile_data.get("partner_id")
    if new_partner is not None and new_partner != (profile.partner_id if profile else None):
        await _check_new_partner(db, new_partner)
    if person_data.get("email") is not None and await _email_taken(
            db, person_data["email"], exclude=person.id):
        raise _err(409, "email_in_use")

    extra = _audit_extra(actor)
    try:
        # The person change is only flushed by the profile step's first
        # query, so a racing email clash raises inside it, not at commit.
        if person_data:
            await apply_person_update(db, actor, person, person_data, audit_extra=extra)
        if profile_data:
            await apply_profile_update(db, actor, person.id, profile_data, audit_extra=extra)
        else:
            # /kiosk/sync/people reads the profile row as "is a worker", and
            # the apps put a saved worker into the Time Clock's roster, so a
            # save always leaves one (the portal's Add person makes none).
            await get_or_create_profile(db, person.id, actor.person.id)
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        if _is_email_clash(exc):
            raise _err(409, "email_in_use") from None
        raise
    return await worker_detail(db, actor, await require_rolodex_worker(db, actor, person_id))


# ── photo ────────────────────────────────────────────────────────────

# What the Attachment row calls every Rolodex photo (the apps send no name).
PHOTO_FILENAME = "kiosk-photo.jpg"


async def _read_photo(request: Request) -> bytes:
    """The raw upload, at most MAX_IMAGE_BYTES (5 MiB). The declared length
    is checked before anything is read: none (a chunked body) is 411
    `length_required`, over the cap is 413 `file_too_large`. The body is
    then streamed with a running total, so one longer than it declared is
    cut off at the cap too (413). Empty is 422 `empty_file`."""
    declared = request.headers.get("content-length")
    if declared is None or not (declared.isascii() and declared.isdigit()):
        raise _err(411, "length_required")
    # the length check first: int() refuses strings of thousands of digits
    if len(declared) > len(str(MAX_IMAGE_BYTES)) or int(declared) > MAX_IMAGE_BYTES:
        raise _err(413, "file_too_large")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_IMAGE_BYTES:
            raise _err(413, "file_too_large")
        chunks.append(chunk)
    if total == 0:
        raise _err(422, "empty_file")
    return b"".join(chunks)


async def _drop_new_photo(key: str) -> None:
    """Delete a just-stored photo whose database write failed: nothing
    points at it, so it would only be an orphan. Best effort; the
    failure the caller re-raises is the one that matters."""
    try:
        await delete_object(key)
    except Exception as exc:  # noqa: BLE001 - the write already failed
        # the class and S3 code only: botocore's message carries the endpoint
        logger.warning("rolodex photo %s left behind: %s", key, loggable(exc))


@router.put("/workers/{person_id}/photo", response_model=KioskRolodexPhotoOut)
async def put_rolodex_photo(
    person_id: uuid.UUID,
    request: Request,
    db: DbSession,
    actor: AuthContext = Depends(rolodex_actor),
    _perm: AuthContext = require_permission("workers", "change"),
    _attach: AuthContext = require_permission("attachments", "add"),
) -> KioskRolodexPhotoOut:
    """Take or replace a worker's photo. The body is the raw JPEG the
    apps made (512×512, quality 0.92), sent with `Content-Type:
    image/jpeg` and a Content-Length; only the bytes are trusted.

    Who: the edit rule (§3.17, the worker page's `can_edit`): 403
    `rank_too_low` for a target with a portal login ranked at or above
    yours, never for your own photo or an account-less worker; 404
    `person_not_found` for anyone the Rolodex doesn't show. These run
    before the body is read. Then 411 `length_required`, 413
    `file_too_large` (over 5 MiB), 422 `empty_file`, `invalid_file_type`
    (not a JPEG by its bytes), `unreadable_image` and `image_too_large`
    (past 40 megapixels).

    Stored at `attachments/person/{id}/avatar/<32 hex>.jpg`; the old
    avatar rows are retired, `avatar_key` repointed, the new Attachment
    row added and audited (`attachment.add` with `via` and `device`), as
    the portal's avatar upload does. If the database write fails, the new
    object is deleted and the error re-raised. Returns the new
    `photo_url` and `photo_version`."""
    from serversherpa.labels import image_prep  # Pillow, only when a photo arrives

    person = await require_rolodex_worker(db, actor, person_id)
    has_account = await db.get(UserAccount, person.id) is not None
    edit_block, _status_block = await _block_reasons(db, actor, person, has_account)
    if edit_block is not None:
        raise _err(403, edit_block)

    data = await _read_photo(request)
    sniffed = _sniff_image(data)
    if sniffed is None or sniffed[0] != "image/jpeg":
        raise _err(422, "invalid_file_type")
    try:
        await asyncio.to_thread(image_prep.probe, data)
    except image_prep.ImageTooLarge as exc:
        raise _err(422, "image_too_large") from exc
    except image_prep.UnreadableImage as exc:
        raise _err(422, "unreadable_image") from exc

    key = f"attachments/person/{person.id}/avatar/{uuid.uuid4().hex}.jpg"
    await put_object(key, data, "image/jpeg")
    try:
        await replace_avatar(
            db, entity_type="person", entity=person, key=key, filename=PHOTO_FILENAME,
            content_type="image/jpeg", size=len(data), actor_id=actor.person.id,
            now=datetime.now(UTC), audit_extra=_audit_extra(actor))
        await db.commit()
    except Exception:
        # the key was never committed, so nothing else can reach the object
        await db.rollback()
        await _drop_new_photo(key)
        raise
    return KioskRolodexPhotoOut(photo_url=presign_get(key), photo_version=photo_version(key))
