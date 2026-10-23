"""Shared worker edits: the person-field and worker-profile updates behind
the portal's `PATCH /workers/{id}/person` and `PUT /workers/{id}/profile`,
reused by the kiosk Rolodex.

Each helper checks, mutates and audits inside the CALLER's transaction and
never commits, so a route can apply a person change and a profile change
and commit them as one unit (or roll both back). The caller does the
existence/scope guard first and maps commit-time IntegrityErrors.

`audit_extra` keys are merged into the audit row's `changes` (the kiosk
passes `{"via": "kiosk_rolodex", "device": <serial>}`); an edit that
changes nothing writes no audit row, extras or not.

`visible_workers_query` is the one definition of which workers an actor
can see, shared by the portal's `GET /workers` and the Rolodex.
`initiative_history` is a worker's initiative/site history, shared by the
portal's `GET /workers/{id}` and the Rolodex's worker page ("Previous
jobs", which keeps the newest 50 and reads the count from
`initiative_history_total`); both answer global actors only.
"""

import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import Select, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import can_touch_rank
from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext
from serversherpa.api.schemas import WorkerInitiativeItem
from serversherpa.db.models import (
    AuthSession,
    Initiative,
    InitiativePerson,
    Partner,
    Person,
    PersonRole,
    Role,
    Site,
    StatusValue,
    UserAccount,
    WorkerLevel,
    WorkerProfile,
)
from serversherpa.db.ordering import natural
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE
from serversherpa.status.labels import UNKNOWN_COLOR

# A null on these Person columns is refused rather than cleared.
REQUIRED_PERSON_FIELDS = ("first_name", "last_name", "country")

# worker_profiles.status is Mapped[str] (NOT NULL, server_default 'active').
# trade/level/partner_id/status_note are all genuinely nullable — clearing
# them is a real edit, so they must NOT be listed here.
NON_NULLABLE_PROFILE_FIELDS = ("status",)

PROFILE_FIELDS = ["partner_id", "trade", "level", "status", "status_note"]


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


def _audit_changes(changes: dict, audit_extra: dict | None) -> dict:
    return {**changes, **(audit_extra or {})}


def visible_workers_query(actor: AuthContext) -> Select:
    """Every worker the actor may see: an active worker role, not
    archived, not a move's hidden kiosk identity, inside the actor's
    `workers` scope. One row per worker as (Person, WorkerProfile | None,
    partner id, partner name, account person_id | None). Unordered:
    callers add their own order_by (or a `Person.id ==` filter)."""
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


async def initiative_history(
    db: AsyncSession, actor: AuthContext, person_id: uuid.UUID,
    limit: int | None = None,
) -> list[WorkerInitiativeItem]:
    """Every initiative the person was added to (their initiative_people
    rows), newest first (equal times by initiative name, naturally), with
    the initiative's type and status and the person's work type resolved to
    vocabulary labels and colors (a key with no vocabulary row reads as
    itself in `UNKNOWN_COLOR`, as status chips do), the site they worked
    and the rating. `limit` keeps only the newest that many (the index on
    `(person_id, created_at DESC)`, migration 0106, serves it).

    Global actors only: anyone else gets an empty list. The history
    (rating above all) is internal, and the join carries no scope check of
    its own, so a partner-anchored actor (e.g. vendor_admin, who holds
    `workers:view` over their own supplied workers) must never receive it.
    The check lives here, not in the callers, so every route that shows the
    history inherits it."""
    if not actor.access.is_global:
        return []
    # one query per vocabulary, mirroring initiatives.py::_people_rows
    vocab_rows = await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(
            ["initiative", "initiative_type", "initiative_work_type"])))
    vocabs: dict[str, dict[str, tuple[str, str]]] = {}
    for s in vocab_rows:
        vocabs.setdefault(s.record_type, {})[s.key] = (s.label, s.color)

    memberships = (await db.execute(
        select(InitiativePerson, Initiative, Site.name)
        .join(Initiative, Initiative.id == InitiativePerson.initiative_id)
        .outerjoin(Site, Site.id == InitiativePerson.site_worked_id)
        .where(InitiativePerson.person_id == person_id)
        .order_by(InitiativePerson.created_at.desc(), natural(Initiative.name), Initiative.id)
        .limit(limit))).all()
    history: list[WorkerInitiativeItem] = []
    for m, init, site_name in memberships:
        wt = (vocabs.get("initiative_work_type", {}).get(
                  m.work_type, (m.work_type, UNKNOWN_COLOR))
              if m.work_type is not None else (None, None))
        t = vocabs.get("initiative_type", {}).get(
            init.initiative_type, (init.initiative_type, UNKNOWN_COLOR))
        st = vocabs.get("initiative", {}).get(
            init.status, (init.status, UNKNOWN_COLOR))
        history.append(WorkerInitiativeItem(
            initiative_id=init.id, initiative_name=init.name,
            type_label=t[0], type_color=t[1],
            status_label=st[0], status_color=st[1],
            work_type_label=wt[0], work_type_color=wt[1],
            site_worked_name=site_name, rating=m.rating,
            added_at=m.created_at))
    return history


async def initiative_history_total(
    db: AsyncSession, actor: AuthContext, person_id: uuid.UUID,
) -> int:
    """How many initiatives `initiative_history` would list for the
    person with no limit; 0 for a non-global actor (the same rule)."""
    if not actor.access.is_global:
        return 0
    return await db.scalar(
        select(func.count())
        .select_from(InitiativePerson)
        .join(Initiative, Initiative.id == InitiativePerson.initiative_id)
        .where(InitiativePerson.person_id == person_id)) or 0


async def target_rank(db: AsyncSession, person_id: uuid.UUID) -> int:
    """The highest rank among the person's live (unrevoked) roles; 0 if
    they hold none."""
    return (await db.scalar(
        select(func.max(Role.rank))
        .join(PersonRole, PersonRole.role == Role.name)
        .where(PersonRole.person_id == person_id,
               PersonRole.revoked_at.is_(None)))) or 0


async def apply_person_update(
    db: AsyncSession, actor: AuthContext, person: Person, data: dict, *,
    audit_extra: dict | None = None,
) -> dict:
    """Apply person contact/identity fields (`data` is the request body's
    `model_dump(exclude_unset=True)`: an explicit null clears a nullable
    field). Returns the field diff (without `audit_extra`).

    Unlike `PATCH /users/{person_id}/profile`, this does NOT require the
    target to hold a UserAccount and does NOT forbid self-targeting — both
    of which would make it unusable for imported, account-less workers and
    confusing for self-edits."""
    # rank guard only applies to targets who can actually log in and hold
    # elevated roles; account-less workers and self-edits skip it entirely
    # (mirrors apply_profile_update's status rank check, minus the
    # self-target exclusion — self-edits are allowed here).
    account = await db.get(UserAccount, person.id)
    if account is not None and person.id != actor.person.id:
        if not can_touch_rank(actor.access.max_rank, await target_rank(db, person.id)):
            raise _err(403, "rank_too_low")

    for required in REQUIRED_PERSON_FIELDS:
        if required in data and data[required] is None:
            raise _err(422, f"{required}_required")
    fields = list(data.keys())
    before = snapshot(person, fields)
    for field, value in data.items():
        setattr(person, field, value)
    person.updated_at = datetime.now(UTC)
    changes = diff(before, snapshot(person, fields))
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="person",
              entity_id=str(person.id), action="update",
              changes=_audit_changes(changes, audit_extra))
    return changes


async def get_or_create_profile(
    db: AsyncSession, person_id: uuid.UUID, actor_id: uuid.UUID,
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


async def apply_profile_update(
    db: AsyncSession, actor: AuthContext, person_id: uuid.UUID, data: dict, *,
    audit_extra: dict | None = None,
) -> dict:
    """Apply worker-profile fields (`data` is the request body's
    `model_dump(exclude_unset=True)`), creating the profile row on first
    edit. Entering or leaving blacklist disables or re-enables the
    target's login. Returns the field diff (without `audit_extra`)."""
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

    profile = await get_or_create_profile(db, person_id, actor.person.id)

    before = snapshot(profile, PROFILE_FIELDS)

    old_status = profile.status or "active"
    new_status = data.get("status", old_status)

    if new_status != old_status:
        # entering OR leaving blacklist toggles login access, so both
        # directions need the same rank/self guard — a worker who also
        # holds an elevated role must not be un-blacklisted (silently
        # re-enabling that account) by someone who couldn't have
        # blacklisted them in the first place.
        if not can_touch_rank(actor.access.max_rank, await target_rank(db, person_id)):
            raise _err(403, "rank_too_low")
        if person_id == actor.person.id:
            raise _err(403, "cannot_target_self")

    if new_status == "blacklist":
        note = data.get("status_note", profile.status_note)
        if not note:
            raise _err(422, "blacklist_requires_note")

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

    changes = diff(before, snapshot(profile, PROFILE_FIELDS))
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="worker",
              entity_id=str(person_id), action="profile.update",
              changes=_audit_changes(changes, audit_extra))
    return changes
