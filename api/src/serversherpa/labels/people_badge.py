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
from dataclasses import dataclass

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


async def _partner_chain(db: AsyncSession, partner: Partner) -> list[Partner]:
    """The partner and its ancestors, nearest first, archived ones left out
    (the walk goes on above them)."""
    chain: list[Partner] = []
    seen: set[uuid.UUID] = set()
    row: Partner | None = partner
    while row is not None and row.id not in seen and len(seen) < PARENT_WALK_LIMIT:
        seen.add(row.id)
        if row.archived_at is None:
            chain.append(row)
        row = await db.get(Partner, row.parent_id) if row.parent_id else None
    return chain


async def _badge(db: AsyncSession, person: Person) -> _Badge:
    grants = (await db.execute(
        select(Role.name, Role.label, Role.scope_anchor)
        .join(PersonRole, PersonRole.role == Role.name)
        .where(PersonRole.person_id == person.id, PersonRole.revoked_at.is_(None)))).all()
    profile = await db.get(WorkerProfile, person.id)
    staff_roles = [label or name for name, label, anchor in grants if anchor == GLOBAL_ANCHOR]
    if staff_roles:
        branding = await read_section(db, "branding")
        return _Badge("Staff", staff_roles, profile, branding.get("company_name"), None,
                      branding.get("company_logo_key") or None)
    if profile is None and not any(name == WORKER_ROLE for name, _l, _a in grants):
        return _Badge("", [], None, None, None, None)
    partner = (await db.get(Partner, profile.partner_id)
               if profile is not None and profile.partner_id else None)
    if partner is None:
        return _Badge("Worker", [], profile, None, None, None)
    chain = await _partner_chain(db, partner)
    logo = next((p.logo_key for p in reversed(chain) if p.logo_key), None) \
        or partner.logo_key or None
    return _Badge("Worker", [], profile, partner.name, chain[-1].name if chain else None, logo)


async def logo_key(db: AsyncSession, person: Person) -> str | None:
    """The stored key of the logo the person's badge shows (module
    docstring), or None."""
    return (await _badge(db, person)).logo_key


async def person_payload(db: AsyncSession, person_id: object) -> dict | None:
    """The payload `fields.person_values` documents, for the person
    `find_person` finds; None when it finds no one."""
    person = await find_person(db, person_id)
    if person is None:
        return None
    badge = await _badge(db, person)
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
