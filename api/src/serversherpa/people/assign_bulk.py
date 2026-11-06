"""Assign workers to an initiative from a template: parse (via imports/bulk)
→ match each row to a person by name, then email, then phone → preview with
flags and per-row decisions → commit.

A row carries a worker's contact details (first, last, preferred, phone,
email) and the role they work. The initiative, site and partner are picked
on the page. Rows match live workers (`bulk_import._worker_query`) and
partner contacts (non-archived people with a partner `contact_profiles`
row); nobody else. The match order is fixed: name first (first + last or
preferred + last, see `bulk_import.name_keys`), then email, then phone. A
key that finds two or more people counts as no match for that key."""

import uuid
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    ContactProfile,
    InitiativePerson,
    Partner,
    Person,
    Site,
    StatusValue,
    WorkerProfile,
)
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import BulkImportError
from serversherpa.people.bulk_import import _worker_query, name_keys, normalize_phone
from serversherpa.people.contact_format import lower_email

COLUMNS = ["first_name", "last_name", "preferred_name", "phone", "email", "role"]
SHEET = "Workers"
DEFAULT_ROLE = "tech"
WORK_TYPE = "initiative_work_type"
DECISION_FIELDS = ("person", "role", "change", "acknowledged")
CHANGES = ("update", "ignore")
ACKNOWLEDGEABLE = ("name_differs", "status", "shared_contact", "no_contact", "phone_invalid")


def _squash(text: str) -> str:
    return " ".join((text or "").split()).casefold()


# ── parsing ─────────────────────────────────────────────────────────

def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    return core.number_json_rows(rows, COLUMNS)


def number_posted_rows(rows: Any, row_numbers: Any) -> list[tuple[int, dict]]:
    """JSON rows re-posted after a file preview carry the spreadsheet line
    numbers the preview assigned, so decisions keyed by those numbers still
    line up."""
    return core.renumber(number_json_rows(rows), row_numbers)


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    return core.parse_upload(filename, content, COLUMNS, SHEET)


def _valid_decision(d: Any) -> bool:
    if not isinstance(d, dict) or not all(k in DECISION_FIELDS for k in d):
        return False
    for key in ("person", "role"):
        if key in d and not (isinstance(d[key], str) and d[key]):
            return False
    if "change" in d and d["change"] not in CHANGES:
        return False
    if "acknowledged" in d:
        ack = d["acknowledged"]
        if not isinstance(ack, list) or not all(
                isinstance(k, str) and k in ACKNOWLEDGEABLE for k in ack):
            return False
    return True


def parse_decisions(raw: Any) -> dict[int, dict]:
    """`{"<row>": {"person": "<id>"|"new", "role": "<key>",
    "change": "update"|"ignore", "acknowledged": [<kind>, ...]}}` →
    {row: decision}. Every field is optional; whether a picked person
    exists is checked by the preview, not here."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise BulkImportError("invalid_decisions")
    out: dict[int, dict] = {}
    for key, decision in raw.items():
        try:
            row = int(key)
        except (TypeError, ValueError):
            raise BulkImportError("invalid_decisions") from None
        if not _valid_decision(decision):
            raise BulkImportError("invalid_decisions")
        out[row] = dict(decision)
    return out


# ── reference data ──────────────────────────────────────────────────

@dataclass
class Candidate:
    """A person a row may match: a live worker or a partner contact."""
    person: Person
    profile: WorkerProfile | None
    is_worker: bool
    partner_contact_of: set[uuid.UUID] = field(default_factory=set)
    partner_name: str | None = None


async def load_reference(db: AsyncSession, initiative_id: uuid.UUID,
                         partner_id: uuid.UUID) -> dict:
    partner_names: dict[uuid.UUID, str] = dict(
        (await db.execute(select(Partner.id, Partner.name))).all())
    people: dict[str, Candidate] = {}
    for person, profile in (await db.execute(_worker_query())).all():
        people[str(person.id)] = Candidate(person=person, profile=profile, is_worker=True)

    contact_rows = (await db.execute(
        select(Person, ContactProfile.partner_id)
        .join(ContactProfile, ContactProfile.person_id == Person.id)
        .where(ContactProfile.partner_id.is_not(None), Person.archived_at.is_(None))
    )).all()
    contact_only = {p.id for p, _ in contact_rows if str(p.id) not in people}
    profiles = ({wp.person_id: wp for wp in await db.scalars(
        select(WorkerProfile).where(WorkerProfile.person_id.in_(contact_only)))}
        if contact_only else {})
    for person, org_id in contact_rows:
        cand = people.get(str(person.id))
        if cand is None:
            cand = people[str(person.id)] = Candidate(
                person=person, profile=profiles.get(person.id), is_worker=False)
        cand.partner_contact_of.add(org_id)

    for cand in people.values():
        if cand.profile and cand.profile.partner_id:
            cand.partner_name = partner_names.get(cand.profile.partner_id)
        elif cand.partner_contact_of:
            cand.partner_name = min(
                partner_names.get(pid, "") for pid in cand.partner_contact_of) or None

    by_name: dict[str, list[str]] = {}
    by_email: dict[str, list[str]] = {}
    by_phone: dict[str, list[str]] = {}
    for pid, cand in people.items():
        p = cand.person
        for key in name_keys(p.first_name, p.last_name, p.preferred_name or ""):
            by_name.setdefault(key, []).append(pid)
        if email := lower_email(p.email or ""):
            by_email.setdefault(email, []).append(pid)
        if phone := normalize_phone(p.phone or ""):
            by_phone.setdefault(phone, []).append(pid)

    roles = {r.key: r for r in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == WORK_TYPE,
                                  StatusValue.is_active.is_(True))
        .order_by(StatusValue.sort_order))}
    role_index: dict[str, str] = {}
    for r in roles.values():
        role_index.setdefault(_squash(r.key), r.key)
        role_index.setdefault(_squash(r.label), r.key)

    team = {tp.person_id: tp for tp in await db.scalars(
        select(InitiativePerson).where(InitiativePerson.initiative_id == initiative_id))}
    # every person, archived included: the unique email index covers them all
    emails_all = {lower_email(email): str(pid) for pid, email in (await db.execute(
        select(Person.id, Person.email).where(Person.email.is_not(None)))).all()}
    site_names = dict((await db.execute(select(Site.id, Site.name))).all())
    return {
        "people": people, "by_name": by_name, "by_email": by_email, "by_phone": by_phone,
        "roles": roles, "role_index": role_index, "team": team, "emails_all": emails_all,
        "partner": await db.get(Partner, partner_id),
        "site_names": site_names, "partner_names": partner_names,
    }


# ── matching ────────────────────────────────────────────────────────

def _one(ids: list[str] | set[str] | None) -> str | None:
    unique = set(ids or ())
    return next(iter(unique)) if len(unique) == 1 else None


def match_row(ref: dict, cells: dict) -> tuple[str | None, str | None, str | None]:
    """(person_id, matched_by, matched_value): name first, then email, then
    phone. A key that finds two or more people is no match for that key and
    the search moves on. matched_value is the name as written (spaces
    squashed), the lowercased email, or the phone cell as written."""
    first, last = cells.get("first_name", ""), cells.get("last_name", "")
    preferred = cells.get("preferred_name", "")
    name_hits: set[str] = set()
    for key in name_keys(first, last, preferred):
        name_hits.update(ref["by_name"].get(key, []))
    if pid := _one(name_hits):
        last_k = _squash(last)
        p = ref["people"][pid].person
        on_file = name_keys(p.first_name, p.last_name, p.preferred_name or "")
        given = first if f"{_squash(first)} {last_k}" in on_file else preferred
        return pid, "name", " ".join(f"{given} {last}".split())

    if (email := lower_email(cells.get("email", ""))) and (
            pid := _one(ref["by_email"].get(email))):
        return pid, "email", email

    phone_cell = (cells.get("phone") or "").strip()
    if (phone := normalize_phone(phone_cell)) and (pid := _one(ref["by_phone"].get(phone))):
        return pid, "phone", phone_cell
    return None, None, None
