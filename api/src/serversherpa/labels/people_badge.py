"""Whose badge it is: the person payload `fields.person_values` prints from,
and the photo and logo a badge image shows (spec
2026-10-20-badge-templates §4.2, §4.4, §4.11). Database-backed; the pure
field catalog stays in fields.py.

- Staff: any active role anchored `global` (Role.scope_anchor, not a list
  of names), even alongside the worker role. Company and logo come from
  System settings › Branding.
- Worker: otherwise, an active `worker` role or a worker profile. Company
  is their partner's name; the logo is the top-most non-archived partner up
  their partner's parent chain that has one, else their own partner's,
  else none; parent company is the top-most non-archived partner's name,
  logo or not (a partner with no parent is its own top).
- Anyone else (client and vendor contacts, external people): no type, no
  company, no logo.

A hidden move identity (the kiosk's per-move sign-in) is nobody's badge."""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Partner, Person, PersonRole, Role, WorkerLevel, WorkerProfile
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE
from serversherpa.status.labels import status_labels
from serversherpa.system.config_store import read_section

GLOBAL_ANCHOR = "global"
WORKER_ROLE = "worker"
# a parent chain is walked at most this far (the API refuses loops; the
# walk never trusts that), as routes/stakeholders.py
PARENT_WALK_LIMIT = 100


async def find_person(db: AsyncSession, person_id: object) -> Person | None:
    """The person a badge can be printed for: any person but a hidden move
    identity, archived or not. None for anything else, a non-UUID too."""
    if isinstance(person_id, uuid.UUID):
        pid = person_id
    else:
        try:
            pid = uuid.UUID(str(person_id))
        except (TypeError, ValueError, AttributeError):
            return None
    person = await db.get(Person, pid)
    if person is None or person.source == KIOSK_MOVE_SOURCE:
        return None
    return person


def photo_key(person: Person) -> str | None:
    """The stored key of the person's photo (their avatar), or None."""
    return person.avatar_key or None


@dataclass
class _Badge:
    person_type: str
    roles: list[str]
    profile: WorkerProfile | None
    company: str | None
    parent_company: str | None
    logo_key: str | None


@dataclass
class _Known:
    """What badges are worked out from, each read once and kept: grants and
    worker profiles by person, partners by id (up their parent chains), the
    branding section. One per request: the person search shares it across
    its rows (its grants and profiles read for every row at once), so a
    page of workers under one partner chain reads that chain once."""
    grants: dict[uuid.UUID, list[tuple[str, str | None, str | None]]] = field(
        default_factory=dict)
    profiles: dict[uuid.UUID, WorkerProfile | None] = field(default_factory=dict)
    partners: dict[uuid.UUID, Partner | None] = field(default_factory=dict)
    branding: dict | None = None


def _grants_query():
    return (select(PersonRole.person_id, Role.name, Role.label, Role.scope_anchor)
            .join(PersonRole, PersonRole.role == Role.name)
            .where(PersonRole.revoked_at.is_(None)))


async def _preload(db: AsyncSession, people: Sequence[Person], known: _Known) -> None:
    """Every one of `people`'s active grants and worker profile, in one
    query each."""
    ids = [p.id for p in people]
    if not ids:
        return
    for pid in ids:
        known.grants.setdefault(pid, [])
        known.profiles.setdefault(pid, None)
    for pid, name, label, anchor in (await db.execute(
            _grants_query().where(PersonRole.person_id.in_(ids)))).all():
        known.grants[pid].append((name, label, anchor))
    for profile in (await db.scalars(
            select(WorkerProfile).where(WorkerProfile.person_id.in_(ids)))).all():
        known.profiles[profile.person_id] = profile


async def _grants(db: AsyncSession, person_id: uuid.UUID,
                  known: _Known) -> list[tuple[str, str | None, str | None]]:
    if person_id not in known.grants:
        known.grants[person_id] = [
            (name, label, anchor) for _pid, name, label, anchor in (await db.execute(
                _grants_query().where(PersonRole.person_id == person_id))).all()]
    return known.grants[person_id]


async def _profile(db: AsyncSession, person_id: uuid.UUID, known: _Known) -> WorkerProfile | None:
    if person_id not in known.profiles:
        known.profiles[person_id] = await db.get(WorkerProfile, person_id)
    return known.profiles[person_id]


async def _partner(db: AsyncSession, partner_id: uuid.UUID, known: _Known) -> Partner | None:
    # db.get alone isn't enough: the session's identity map holds rows only
    # while something references them, so a partner went between rows
    if partner_id not in known.partners:
        known.partners[partner_id] = await db.get(Partner, partner_id)
    return known.partners[partner_id]


async def _branding(db: AsyncSession, known: _Known) -> dict:
    if known.branding is None:
        known.branding = await read_section(db, "branding")
    return known.branding


async def _partner_chain(db: AsyncSession, partner: Partner, known: _Known) -> list[Partner]:
    """The partner and its ancestors, nearest first, archived ones left out
    (the walk goes on above them)."""
    chain: list[Partner] = []
    seen: set[uuid.UUID] = set()
    row: Partner | None = partner
    while row is not None and row.id not in seen and len(seen) < PARENT_WALK_LIMIT:
        seen.add(row.id)
        if row.archived_at is None:
            chain.append(row)
        row = await _partner(db, row.parent_id, known) if row.parent_id else None
    return chain


async def _badge(db: AsyncSession, person: Person, known: _Known | None = None) -> _Badge:
    known = known if known is not None else _Known()
    grants = await _grants(db, person.id, known)
    profile = await _profile(db, person.id, known)
    staff_roles = [label or name for name, label, anchor in grants if anchor == GLOBAL_ANCHOR]
    if staff_roles:
        branding = await _branding(db, known)
        return _Badge("Staff", staff_roles, profile, branding.get("company_name"), None,
                      branding.get("company_logo_key") or None)
    if profile is None and not any(name == WORKER_ROLE for name, _l, _a in grants):
        return _Badge("", [], None, None, None, None)
    partner = (await _partner(db, profile.partner_id, known)
               if profile is not None and profile.partner_id else None)
    if partner is None:
        return _Badge("Worker", [], profile, None, None, None)
    chain = await _partner_chain(db, partner, known)
    logo = next((p.logo_key for p in reversed(chain) if p.logo_key), None) \
        or partner.logo_key or None
    return _Badge("Worker", [], profile, partner.name, chain[-1].name if chain else None, logo)


async def logo_key(db: AsyncSession, person: Person) -> str | None:
    """The stored key of the logo the person's badge shows (module
    docstring), or None."""
    return (await _badge(db, person)).logo_key


@dataclass(frozen=True)
class Summary:
    """One person as the builder's person search lists them: "Staff",
    "Worker" or "" (module docstring), the company their badge names (None
    when none), and whether they have a photo and a logo (the stored keys
    are set; a missing object still prints as no image)."""
    person_type: str
    company: str | None
    has_photo: bool
    has_logo: bool


def _summary(person: Person, badge: _Badge) -> Summary:
    return Summary(badge.person_type, badge.company or None, photo_key(person) is not None,
                   bool(badge.logo_key))


async def summary(db: AsyncSession, person: Person) -> Summary:
    return _summary(person, await _badge(db, person))


async def summaries(db: AsyncSession, people: Sequence[Person]) -> list[Summary]:
    """`summary` for each of `people`, in order, from lookups made once for
    all of them (`_Known`): their grants and worker profiles in one query
    each, each partner up their parent chains and the branding section
    once."""
    known = _Known()
    await _preload(db, people, known)
    return [_summary(person, await _badge(db, person, known)) for person in people]


async def person_payload(db: AsyncSession, person_id: object) -> dict | None:
    """The payload `fields.person_values` documents, for the person
    `find_person` finds; None when it finds no one."""
    person = await find_person(db, person_id)
    if person is None:
        return None
    return await _payload(db, person, await _badge(db, person))


async def payload_and_summary(db: AsyncSession, person: Person) -> tuple[dict, Summary]:
    """`person_payload` and `summary` of one person (as `find_person` found
    them), from one badge lookup."""
    badge = await _badge(db, person)
    return await _payload(db, person, badge), _summary(person, badge)


async def _payload(db: AsyncSession, person: Person, badge: _Badge) -> dict:
    profile = badge.profile
    level = None
    status = status_label = None
    if profile is not None:
        if profile.level:
            row = await db.get(WorkerLevel, profile.level)
            level = {"key": profile.level, "title": row.title if row else None}
        status = profile.status
        status_label = (await status_labels(db, "worker")).get(status, (None, None))[0]
    return {
        "person": {"id": person.id, "first_name": person.first_name,
                   "last_name": person.last_name, "preferred_name": person.preferred_name,
                   "job_title": person.job_title, "external_id": person.external_id,
                   "email": person.email, "phone": person.phone, "rfid_tag": person.rfid_tag},
        "person_type": badge.person_type,
        "company": badge.company,
        "parent_company": badge.parent_company,
        "roles": badge.roles,
        "trade": profile.trade if profile is not None else None,
        "level": level,
        "worker_status": status,
        "worker_status_label": status_label,
    }
