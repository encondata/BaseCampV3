"""Workers bulk import: parse (via imports/bulk) → match → preview/commit.

A worker is three records — a people row, an active `worker` role grant,
and a worker_profiles row — and every create writes all three. Rows match
an existing (non-archived) person by person_id (strongest; an unknown one
is ignored with a note), email, phone (digits only) or name (first + last,
or preferred + last); keys that disagree are a row error. JSON rows may
also carry `certifications`, which are only ever added, never edited.

Blank-cell rule: on create rows a blank status/country takes the default
(active/US); on update rows a blank cell means "no change", never a clear.
The original blankness is tracked out-of-band (`blank`) because `data` has
already had defaults applied by diff time. Each preview row also carries
`cells` (the uploaded cells before defaults) — the commit replays those.
"""

import json
import re
import uuid
from datetime import UTC, date, datetime
from typing import Any

from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import can_touch_rank
from serversherpa.access.role_mix import (
    CONFLICT_ROW_ERROR, assert_no_client_worker_mix, client_contact_ids,
)
from serversherpa.db.models import (
    AuthSession, Partner, Person, PersonRole, Role, StatusValue, UserAccount,
    WorkerCertification, WorkerLevel, WorkerProfile,
)
from serversherpa.db.ordering import natural
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import MAX_BYTES, MAX_ROWS, BulkImportError
from serversherpa.services import biometric, push_registrations
from serversherpa.services.audit import audit
from serversherpa.services.move_password import KIOSK_MOVE_SOURCE

__all__ = ["BulkImportError", "MAX_BYTES", "MAX_ROWS"]

COLUMNS = [
    "person_id", "first_name", "last_name", "preferred_name", "email", "phone",
    "job_title", "employee_number", "rfid_tag", "address_line1",
    "address_line2", "city", "region", "postal_code", "country",
    "partner", "trade", "level", "status", "status_note", "notes",
    "will_travel", "travel_region", "travel_restrictions",
]
# Columns the full export writes that an upload accepts and ignores (the
# export is re-uploadable). JSON uploads may also carry `certifications`.
EXPORT_ONLY_COLUMNS = [
    "badge_uid", "has_photo", "source", "source_ref", "has_login",
    "login_email", "login_disabled", "last_login_at", "roles", "created_at",
    "updated_at", "profile_updated_at", "certifications",
]
EXPORT_COLUMNS = COLUMNS + EXPORT_ONLY_COLUMNS
SHEET = "Workers"
# template column → Person attribute
PERSON_ATTR = {
    "first_name": "first_name", "last_name": "last_name",
    "preferred_name": "preferred_name", "email": "email", "phone": "phone",
    "job_title": "job_title", "employee_number": "external_id",
    "rfid_tag": "rfid_tag", "address_line1": "address_line1",
    "address_line2": "address_line2", "city": "city", "region": "region",
    "postal_code": "postal_code", "country": "country", "notes": "notes",
}
PROFILE_COLUMNS = ("trade", "level", "status", "status_note",
                   "travel_region", "travel_restrictions")

SAMPLE_ROWS: list[dict] = [
    {"person_id": "", "first_name": "Robert", "last_name": "Smith", "preferred_name": "Bob",
     "email": "bob.smith@example.com", "phone": "555-123-4567",
     "job_title": "Lead Technician", "employee_number": "E1042",
     "rfid_tag": "", "address_line1": "12 Rack Row", "address_line2": "",
     "city": "Reno", "region": "NV", "postal_code": "89501", "country": "US",
     "partner": "", "trade": "Cable, Rack & Stack", "level": "L4",
     "status": "active", "status_note": "", "notes": "Sample row — replace me",
     "will_travel": "yes", "travel_region": "", "travel_restrictions": ""},
    {"person_id": "", "first_name": "Maria", "last_name": "Lopez", "preferred_name": "",
     "email": "", "phone": "(555) 987-6543", "job_title": "",
     "employee_number": "", "rfid_tag": "", "address_line1": "",
     "address_line2": "", "city": "", "region": "", "postal_code": "",
     "country": "", "partner": "Example Staffing", "trade": "Cable",
     "level": "L2", "status": "standby", "status_note": "", "notes": "",
     "will_travel": "", "travel_region": "", "travel_restrictions": ""},
]

_EMAIL = TypeAdapter(EmailStr)
_COUNTRY = re.compile(r"^[A-Za-z]{2}$")
_ISO_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_TRAVEL = {"": None, "yes": True, "true": True, "no": False, "false": False}


# ── keys ────────────────────────────────────────────────────────────

def normalize_phone(text: str) -> str:
    """Match key for phone: digits only; an 11-digit number starting with 1
    drops the US country code. Fewer than 7 digits is no key at all."""
    digits = re.sub(r"\D", "", text or "")
    if len(digits) == 11 and digits[0] == "1":
        digits = digits[1:]
    return digits if len(digits) >= 7 else ""


def _squash(text: str) -> str:
    return " ".join((text or "").split()).casefold()


def cert_key(name: str, issuer: str | None) -> str:
    """Match key for a certification: name + issuer, case-insensitive,
    whitespace squashed."""
    return _squash(name) + "|" + _squash(issuer or "")


def parse_will_travel(text: str) -> bool | None:
    """blank → None (not set); yes/no/true/false in any case → bool."""
    key = (text or "").strip().casefold()
    if key not in _TRAVEL:
        raise ValueError(f"will_travel {text!r} is not yes or no")
    return _TRAVEL[key]


def _travel_text(value: bool | None) -> str | None:
    return None if value is None else ("yes" if value else "no")


def name_keys(first: str, last: str, preferred: str) -> set[str]:
    """Both spellings a person may go by: first + last and preferred + last."""
    keys: set[str] = set()
    last_k = _squash(last)
    if not last_k:
        return keys
    for given in (first, preferred):
        given_k = _squash(given)
        if given_k:
            keys.add(f"{given_k} {last_k}")
    return keys


# ── parsing / templates (thin wrappers over the shared core) ────────

def _drop_export_only(row: dict) -> dict:
    return {k: v for k, v in row.items() if k not in EXPORT_ONLY_COLUMNS}


def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    if isinstance(rows, dict):
        rows = [rows]          # mirrors the core: a bare object is one row
    # Certifications are structured, so lift them out of the raw rows by
    # index before the core flattens every cell to text. JSON row n = index + 1.
    certs: dict[int, Any] = {}
    if isinstance(rows, list):
        for i, raw in enumerate(rows):
            if isinstance(raw, dict) and raw.get("certifications") is not None:
                certs[i + 1] = raw["certifications"]
    out: list[tuple[int, dict]] = []
    for n, row in core.number_json_rows(rows, EXPORT_COLUMNS):
        row = _drop_export_only(row)
        if n in certs:
            row["certifications"] = certs[n]
        out.append((n, row))
    return out


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    if filename.lower().endswith(".json"):
        if len(content) > MAX_BYTES:
            raise BulkImportError("file_too_large", limit=MAX_BYTES)
        try:
            data = json.loads(content.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise BulkImportError("invalid_json") from None
        return number_json_rows(data)
    return [(n, _drop_export_only(row)) for n, row in
            core.parse_upload(filename, content, EXPORT_COLUMNS, SHEET)]


def build_rows_csv(rows: list[dict]) -> str:
    return core.build_rows_csv(rows, COLUMNS)


def build_rows_xlsx(rows: list[dict], levels: list[str], statuses: list[str],
                    partners: list[str]) -> bytes:
    return core.build_rows_xlsx(rows, COLUMNS, SHEET, [
        ("Valid levels", levels), ("Valid statuses", statuses),
        ("Partner names", partners)])


def build_template_csv() -> str:
    return build_rows_csv(SAMPLE_ROWS)


def build_template_xlsx(levels: list[str], statuses: list[str],
                        partners: list[str]) -> bytes:
    return build_rows_xlsx(SAMPLE_ROWS, levels, statuses, partners)


async def reference_lists(db: AsyncSession) -> tuple[list[str], list[str], list[str]]:
    """What the xlsx Reference sheet lists: levels by rank, worker status
    keys by sort order, partner names alphabetically."""
    levels = list(await db.scalars(
        select(WorkerLevel.level).order_by(WorkerLevel.rank)))
    statuses = list(await db.scalars(
        select(StatusValue.key).where(StatusValue.record_type == "worker")
        .order_by(StatusValue.sort_order)))
    partners = list(await db.scalars(
        select(Partner.name).where(Partner.archived_at.is_(None))
        .order_by(natural(Partner.name))))
    return levels, statuses, partners


# ── export ──────────────────────────────────────────────────────────

def _worker_query():
    return (
        select(Person, WorkerProfile)
        .join(PersonRole, (PersonRole.person_id == Person.id)
              & (PersonRole.role == "worker")
              & (PersonRole.revoked_at.is_(None)))
        .outerjoin(WorkerProfile, WorkerProfile.person_id == Person.id)
        .where(Person.archived_at.is_(None),
               Person.source != KIOSK_MOVE_SOURCE)   # a move's hidden kiosk identity
        .order_by(natural(Person.last_name), natural(Person.first_name))
    )


def _text(value: str | None) -> str | None:
    """Empty strings export as None."""
    return value or None


def _utc(value: datetime | None) -> str | None:
    return value.astimezone(UTC).isoformat() if value else None


def _day(value: date | None) -> str | None:
    return value.isoformat() if value else None


async def export_rows(db: AsyncSession) -> list[dict]:
    """Every live worker with every EXPORT_COLUMNS key, typed: str, bool or
    None, except `certifications` (a list of dicts). Accounts, active roles
    and certifications load in one query each, keyed by person. Secrets
    (password hash, TOTP, last login IP, ui prefs, avatar key) are never
    read into a row."""
    partner_names = dict((await db.execute(select(Partner.id, Partner.name))).all())
    pairs = (await db.execute(_worker_query())).all()
    # only the columns the row needs: never the password hash or TOTP secret
    accounts = {
        a.person_id: a for a in (await db.execute(select(
            UserAccount.person_id, UserAccount.email, UserAccount.disabled_at,
            UserAccount.last_login_at))).all()}
    roles: dict[uuid.UUID, list[str]] = {}
    for pid, role in (await db.execute(
            select(PersonRole.person_id, PersonRole.role)
            .where(PersonRole.revoked_at.is_(None))
            .order_by(natural(PersonRole.role)))).all():
        roles.setdefault(pid, []).append(role)
    certs: dict[uuid.UUID, list[dict]] = {}
    for c in await db.scalars(
            select(WorkerCertification)
            .order_by(WorkerCertification.expires_on.asc().nulls_last(),
                      natural(WorkerCertification.name))):
        certs.setdefault(c.person_id, []).append({
            "name": c.name, "issuer": _text(c.issuer),
            "issued_on": _day(c.issued_on), "expires_on": _day(c.expires_on),
            "source": c.source})
    out = []
    for person, profile in pairs:
        row: dict[str, Any] = {
            col: _text(getattr(person, attr)) for col, attr in PERSON_ATTR.items()}
        row["person_id"] = str(person.id)
        row["partner"] = (_text(partner_names.get(profile.partner_id))
                          if profile and profile.partner_id else None)
        row["trade"] = _text(profile.trade) if profile else None
        row["level"] = _text(profile.level) if profile else None
        row["status"] = (profile.status if profile else None) or "active"
        row["status_note"] = _text(profile.status_note) if profile else None
        row["will_travel"] = profile.will_travel if profile else None
        row["travel_region"] = _text(profile.travel_region) if profile else None
        row["travel_restrictions"] = (
            _text(profile.travel_restrictions) if profile else None)
        account = accounts.get(person.id)
        row.update(
            badge_uid=str(person.badge_uid),
            has_photo=person.avatar_key is not None,
            source=_text(person.source),
            source_ref=_text(person.source_ref),
            has_login=account is not None,
            login_email=account.email if account else None,
            login_disabled=(account.disabled_at is not None) if account else None,
            last_login_at=_utc(account.last_login_at) if account else None,
            roles=", ".join(roles[person.id]) if roles.get(person.id) else None,
            created_at=_utc(person.created_at),
            updated_at=_utc(person.updated_at),
            profile_updated_at=_utc(profile.updated_at) if profile else None,
            certifications=certs.get(person.id, []),
        )
        out.append({col: row[col] for col in EXPORT_COLUMNS})
    return out


def _cert_cell(cert: dict) -> str:
    text = cert["name"]
    if cert.get("issuer"):
        text += f" ({cert['issuer']})"
    issued, expires = cert.get("issued_on"), cert.get("expires_on")
    if issued or expires:
        text += " " + f"{issued or ''} → {expires or ''}".strip()
    return text


def flatten_row(row: dict) -> dict[str, str]:
    """A typed export row as CSV/xlsx cells: None → blank, bool → yes/no,
    certifications → one "; "-joined cell."""
    out: dict[str, str] = {}
    for col, value in row.items():
        if col == "certifications":
            out[col] = "; ".join(_cert_cell(c) for c in value or [])
        elif value is None:
            out[col] = ""
        elif isinstance(value, bool):
            out[col] = "yes" if value else "no"
        else:
            out[col] = str(value)
    return out


def build_export_json(rows: list[dict]) -> str:
    return json.dumps(rows, indent=2, ensure_ascii=False)


def build_export_csv(rows: list[dict]) -> str:
    return core.build_rows_csv([flatten_row(r) for r in rows], EXPORT_COLUMNS)


def build_export_xlsx(rows: list[dict], levels: list[str], statuses: list[str],
                      partners: list[str]) -> bytes:
    return core.build_rows_xlsx(
        [flatten_row(r) for r in rows], EXPORT_COLUMNS, SHEET, [
            ("Valid levels", levels), ("Valid statuses", statuses),
            ("Partner names", partners)])


def build_template_json() -> str:
    rows = [{k: (v or None) for k, v in r.items()} for r in SAMPLE_ROWS]
    rows[0]["will_travel"] = True
    rows[0]["certifications"] = [{
        "name": "OSHA 10", "issuer": "OSHA", "issued_on": "2025-03-01",
        "expires_on": None}]
    rows[1]["certifications"] = []
    return json.dumps(rows, indent=2, ensure_ascii=False)


# ── validation + preview ────────────────────────────────────────────

async def _reference_data(db: AsyncSession) -> dict:
    levels = set(await db.scalars(select(WorkerLevel.level)))
    statuses = set(await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == "worker")))
    partners: dict[str, list[Partner]] = {}
    partner_names: dict[uuid.UUID, str] = {}
    for p in await db.scalars(select(Partner)):
        partners.setdefault(p.name.lower(), []).append(p)
        partner_names[p.id] = p.name

    people = list(await db.scalars(select(Person).where(Person.archived_at.is_(None))))
    by_email: dict[str, list[Person]] = {}
    by_phone: dict[str, list[Person]] = {}
    by_name: dict[str, list[Person]] = {}
    by_rfid: dict[str, Person] = {}
    by_id: dict[uuid.UUID, Person] = {}
    for p in people:
        by_id[p.id] = p
        if p.email:
            by_email.setdefault(p.email.casefold(), []).append(p)
        phone_key = normalize_phone(p.phone or "")
        if phone_key:
            by_phone.setdefault(phone_key, []).append(p)
        for key in name_keys(p.first_name, p.last_name, p.preferred_name or ""):
            by_name.setdefault(key, []).append(p)
        # rfid keys compare case-insensitively on purpose — stricter than the
        # case-sensitive people_rfid_uniq index, so a near-miss errs safe.
        if p.rfid_tag:
            by_rfid[p.rfid_tag.lower()] = p

    archived = list(await db.scalars(select(Person).where(Person.archived_at.is_not(None))))
    archived_emails = {p.email.casefold() for p in archived if p.email}
    archived_rfids = {p.rfid_tag.lower() for p in archived if p.rfid_tag}

    profiles = {pr.person_id: pr for pr in await db.scalars(select(WorkerProfile))}
    cert_keys: dict[uuid.UUID, set[str]] = {}
    for pid, name, issuer in (await db.execute(select(
            WorkerCertification.person_id, WorkerCertification.name,
            WorkerCertification.issuer))).all():
        cert_keys.setdefault(pid, set()).add(cert_key(name, issuer))
    worker_ids = set(await db.scalars(select(PersonRole.person_id).where(
        PersonRole.role == "worker", PersonRole.revoked_at.is_(None))))
    # people who can log in: the rank guard on person fields applies to them
    # only, exactly as PATCH /workers/{person_id}/person does it
    account_ids = set(await db.scalars(select(UserAccount.person_id)))
    max_rank = dict((await db.execute(
        select(PersonRole.person_id, func.max(Role.rank))
        .join(Role, Role.name == PersonRole.role)
        .where(PersonRole.revoked_at.is_(None))
        .group_by(PersonRole.person_id))).all())
    return {"levels": levels, "statuses": statuses, "partners": partners,
            "partner_names": partner_names, "by_email": by_email,
            "by_phone": by_phone, "by_name": by_name, "by_rfid": by_rfid,
            "by_id": by_id, "cert_keys": cert_keys,
            "archived_emails": archived_emails, "archived_rfids": archived_rfids,
            "profiles": profiles, "worker_ids": worker_ids, "max_rank": max_rank,
            "account_ids": account_ids,
            # a client contact can't also be a worker (access/role_mix.py)
            "client_contact_ids": await client_contact_ids(db)}


def _row_display_name(row: dict) -> str:
    return f"{row['preferred_name'] or row['first_name']} {row['last_name']}".strip()


def _valid_email(text: str) -> bool:
    try:
        _EMAIL.validate_python(text)
        return True
    except ValidationError:
        return False


def _parse_uuid(text: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(text)
    except ValueError:
        return None


def _cert_text(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return str(value)
    return ""


def _check_certifications(value: Any) -> tuple[list[dict], list[str]]:
    """A JSON row's raw `certifications` → (normalized list, errors). Only
    name/issuer/issued_on/expires_on are read; `source`, ids and any other
    key are ignored. Repeats of a name + issuer collapse to the first."""
    if not isinstance(value, list) or not all(isinstance(c, dict) for c in value):
        return [], ["certifications must be a list"]
    out: list[dict] = []
    errors: list[str] = []
    seen: set[str] = set()
    for i, raw in enumerate(value, start=1):
        name = _cert_text(raw.get("name"))
        if not name:
            errors.append(f"certification {i}: name is required")
        issuer = raw.get("issuer")
        if isinstance(issuer, (list, dict, bool)):
            errors.append(f"certification {i}: issuer must be text")
        cert = {"name": name, "issuer": _cert_text(issuer) or None}
        for field in ("issued_on", "expires_on"):
            day = raw.get(field)
            cert[field] = None
            if day is None or (isinstance(day, str) and not day.strip()):
                continue        # blank reads as null
            try:
                if not (isinstance(day, str) and _ISO_DAY.match(day)):
                    raise ValueError
                date.fromisoformat(day)
                cert[field] = day
            except ValueError:
                errors.append(f"certification {i}: {field} '{day}' "
                              "is not a date (YYYY-MM-DD)")
        if not name:
            continue
        key = cert_key(cert["name"], cert["issuer"])
        if key not in seen:
            seen.add(key)
            out.append(cert)
    return out, errors


def _cert_label(cert: dict) -> str:
    return f"{cert['name']} ({cert['issuer']})" if cert["issuer"] else cert["name"]


async def preview_rows(db: AsyncSession, numbered: list[tuple[int, dict]], *,
                       actor_id: uuid.UUID, actor_rank: int) -> dict:
    ref = await _reference_data(db)

    # in-upload duplicate keys → both rows are errors
    emails_seen: dict[str, list[int]] = {}
    phones_seen: dict[str, list[int]] = {}
    names_seen: dict[str, list[int]] = {}
    rfids_seen: dict[str, list[int]] = {}
    pids_seen: dict[uuid.UUID, list[int]] = {}
    for n, row in numbered:
        pid = _parse_uuid(row["person_id"]) if row["person_id"] else None
        if pid is not None:
            pids_seen.setdefault(pid, []).append(n)
        if row["email"]:
            emails_seen.setdefault(row["email"].casefold(), []).append(n)
        phone_key = normalize_phone(row["phone"])
        if phone_key:
            phones_seen.setdefault(phone_key, []).append(n)
        for key in name_keys(row["first_name"], row["last_name"], row["preferred_name"]):
            names_seen.setdefault(key, []).append(n)
        if row["rfid_tag"]:
            rfids_seen.setdefault(row["rfid_tag"].lower(), []).append(n)

    pending: list[dict] = []
    for n, row in numbered:
        errors: list[str] = []
        notes: list[str] = []
        if not row["first_name"]:
            errors.append("first_name is required")
        if not row["last_name"]:
            errors.append("last_name is required")

        # person_id is the strongest key; one from another environment's
        # export (or an archived person) is ignored with a note
        pid_person: Person | None = None
        if row["person_id"]:
            pid = _parse_uuid(row["person_id"])
            if pid is None:
                errors.append(f"person_id '{row['person_id']}' is not valid")
            elif len(pids_seen[pid]) > 1:
                errors.append("duplicate person_id within the import")
            else:
                pid_person = ref["by_id"].get(pid)
                if pid_person is None:
                    notes.append("person_id not found here")

        # a row whose person_id resolves here is exempt from the in-upload
        # email/phone duplicate checks, as it is for names: the id decides it.
        # For email only when it is that person's own: people.email is unique,
        # so two rows setting one new email would fail at commit.
        email_key = row["email"].casefold()
        own_email = pid_person is not None and (
            (pid_person.email or "").casefold() == email_key)
        if row["email"] and not _valid_email(row["email"]):
            errors.append(f"email '{row['email']}' is not valid")
        elif row["email"] and len(emails_seen[email_key]) > 1 and not own_email:
            errors.append(f"duplicate email '{email_key}' within the import")
        elif email_key in ref["archived_emails"]:
            errors.append(f"email '{row['email']}' belongs to an archived person")

        phone_key = normalize_phone(row["phone"])
        if row["phone"] and not phone_key:
            errors.append("phone needs at least 7 digits")
        elif phone_key and len(phones_seen[phone_key]) > 1 and pid_person is None:
            errors.append("duplicate phone within the import")

        row_names = name_keys(row["first_name"], row["last_name"], row["preferred_name"])
        # a shared name only blocks rows with no stronger key: a person_id,
        # an email or a phone disambiguates the row and carries its own
        # duplicate check
        dup_name = any(len(names_seen[k]) > 1 for k in row_names)
        if dup_name and not row["email"] and not phone_key and pid_person is None:
            errors.append(f"duplicate name '{_row_display_name(row)}' within the import")

        rfid_key = row["rfid_tag"].lower()
        if rfid_key and len(rfids_seen[rfid_key]) > 1:
            errors.append(f"duplicate rfid_tag '{rfid_key}' within the import")
        elif rfid_key in ref["archived_rfids"]:
            errors.append(f"rfid_tag '{row['rfid_tag']}' belongs to an archived person")

        if row["country"] and not _COUNTRY.match(row["country"]):
            errors.append("country must be a two-letter code")

        partner_obj: Partner | None = None
        if row["partner"]:
            matches = ref["partners"].get(row["partner"].lower(), [])
            if len(matches) == 0:
                errors.append(f"unknown partner '{row['partner']}'")
            elif len(matches) > 1:
                errors.append(f"ambiguous partner '{row['partner']}'")
            else:
                partner_obj = matches[0]
        if row["level"] and row["level"] not in ref["levels"]:
            errors.append(f"unknown level '{row['level']}'")
        if row["status"] and row["status"] not in ref["statuses"]:
            errors.append(f"unknown status '{row['status']}'")
        try:
            travel = parse_will_travel(row["will_travel"])
        except ValueError:
            errors.append("will_travel must be yes or no")
            travel = None
        certs: list[dict] | None = None
        if "certifications" in row:
            certs, cert_errors = _check_certifications(row["certifications"])
            errors.extend(cert_errors)

        blank = {"status": row["status"] == "", "country": row["country"] == ""}
        data = dict(row)
        if blank["status"]:
            data["status"] = "active"
        data["country"] = "US" if blank["country"] else row["country"].upper()
        if partner_obj is not None:
            data["partner"] = partner_obj.name
        data["will_travel"] = _travel_text(travel) or ""
        if certs is not None:
            data["certifications"] = certs

        # resolve the target — only for rows that are otherwise clean
        target: Person | None = None
        matched_by: str | None = None
        if not errors:
            hits: dict[str, list[Person]] = {}
            if pid_person is not None:
                hits["person_id"] = [pid_person]
            if row["email"]:
                hits["email"] = ref["by_email"].get(email_key, [])
            if phone_key:
                hits["phone"] = ref["by_phone"].get(phone_key, [])
            if row_names:
                seen: dict[uuid.UUID, Person] = {}
                for k in row_names:
                    for p in ref["by_name"].get(k, []):
                        seen[p.id] = p
                hits["name"] = list(seen.values())
            if pid_person is not None:
                # a key the person_id's person shares with others neither
                # errors nor counts as disagreement: the id decides the row
                for key in ("email", "phone", "name"):
                    people = hits.get(key, [])
                    if len(people) > 1 and any(p.id == pid_person.id for p in people):
                        hits.pop(key)
            shown = {"person_id": row["person_id"], "email": row["email"],
                     "phone": row["phone"],
                     "name": _row_display_name(row)}
            # a name shared by two people is not fatal when the row carries a
            # stronger key that lands on exactly one person: that key decides
            strong = [hits[k] for k in ("person_id", "email", "phone") if hits.get(k)]
            if len(hits.get("name", [])) > 1 and strong and all(
                    len(people) == 1 for people in strong) and len(
                    {people[0].id for people in strong}) == 1:
                hits.pop("name")
            for key, people in hits.items():
                if len(people) > 1:
                    errors.append(f"two people share the {key} '{shown[key]}'")
            if not errors:
                distinct = {p.id: p for people in hits.values() for p in people}
                if len(distinct) > 1:
                    errors.append(", ".join(
                        f"{key} matches {people[0].display_name}"
                        for key, people in hits.items() if people))
                elif distinct:
                    target = next(iter(distinct.values()))
                    matched_by = ", ".join(k for k in ("person_id", "email", "phone", "name")
                                           if hits.get(k))

        if not errors and rfid_key:
            holder = ref["by_rfid"].get(rfid_key)
            if holder is not None and (target is None or holder.id != target.id):
                errors.append(f"rfid_tag '{row['rfid_tag']}' belongs to {holder.display_name}")

        changes: dict | None = None
        if not errors:
            profile = ref["profiles"].get(target.id) if target is not None else None
            if data["status"] == "blacklist" and not (
                    row["status_note"] or (profile.status_note if profile else None)):
                errors.append("blacklist requires a status_note")
            if target is not None:
                if certs is not None:
                    # a certification the person already holds is left alone
                    held = ref["cert_keys"].get(target.id, set())
                    data["certifications"] = [
                        c for c in certs if cert_key(c["name"], c["issuer"]) not in held]
                changes = _diff_row(
                    target, profile, target.id in ref["worker_ids"], data, blank,
                    partner_obj, ref["partner_names"])
                if "worker_role" in changes and target.id in ref["client_contact_ids"]:
                    errors.append(CONFLICT_ROW_ERROR)
                # the guards the single-record endpoints apply: a status change
                # is guarded on anyone (PUT /workers/{id}/profile), every other
                # edit only on people who can log in (PATCH …/person, which
                # also lets you edit yourself). Adding certifications is not
                # guarded, as POST /workers/{id}/certifications is not.
                guard_changes = {k: v for k, v in changes.items() if k != "certifications"}
                guarded = "status" in guard_changes or (
                    target.id != actor_id and target.id in ref["account_ids"])
                if "status" in guard_changes and target.id == actor_id:
                    errors.append("cannot change your own status")
                elif guard_changes and guarded and not can_touch_rank(
                        actor_rank, ref["max_rank"].get(target.id, 0)):
                    errors.append("rank too low to edit this person")

        pending.append({"row": n, "cells": dict(row), "name": _row_display_name(row),
                        "errors": errors, "notes": notes, "data": data, "blank": blank,
                        "target": target, "matched_by": matched_by,
                        "partner_obj": partner_obj, "changes": changes})

    # two upload rows resolving to the same person would apply twice, last
    # write winning silently — both rows are errors instead
    same_target: dict[uuid.UUID, list[dict]] = {}
    for p in pending:
        if p["target"] is not None:
            same_target.setdefault(p["target"].id, []).append(p)
    for group in same_target.values():
        if len(group) > 1:
            for p in group:
                p["errors"].append("two rows match the same existing person "
                                   f"'{p['target'].display_name}'")

    results = []
    for p in pending:
        errors, target = p["errors"], p["target"]
        action, diff_out, person_id = "create", None, None
        if errors:
            action = "error"
        elif target is not None:
            person_id = str(target.id)
            changes = p["changes"] or {}       # computed with the rank guard above
            action = "update" if changes else "unchanged"
            diff_out = changes or None
        results.append({"row": p["row"], "name": p["name"] or None,
                        "action": action,
                        "matched_by": p["matched_by"] if action != "error" else None,
                        "matched_name": (target.display_name
                                         if target is not None and action != "error" else None),
                        "errors": errors, "notes": p["notes"],
                        "diff": diff_out, "person_id": person_id,
                        "cells": p["cells"],
                        "data": p["data"] if action != "error" else None})

    can_commit = bool(results) and all(r["action"] != "error" for r in results)
    return {"rows": results, "can_commit": can_commit}


def _diff_row(person: Person, profile: WorkerProfile | None, is_worker: bool,
              data: dict, blank: dict, partner_obj: Partner | None,
              partner_names: dict) -> dict:
    """Changed fields only; blank in the row = no change. `blank` remembers
    the create-only status/country defaults so they never read as edits."""
    out: dict = {}
    for col, attr in PERSON_ATTR.items():
        raw = data[col]
        if col == "country" and blank["country"]:
            continue
        if raw == "":
            continue
        old = getattr(person, attr)
        if col == "email" and (old or "").casefold() == raw.casefold():
            continue
        if col == "phone" and old and normalize_phone(old) == normalize_phone(raw):
            continue
        if (old or "") != raw:
            out[col] = {"old": old, "new": raw}
    for col in PROFILE_COLUMNS:
        raw = data[col]
        if col == "status" and blank["status"]:
            continue
        if raw == "":
            continue
        if profile is not None:
            old = getattr(profile, col)
        else:
            old = "active" if col == "status" else None
        if (old or "") != raw:
            out[col] = {"old": old, "new": raw}
    if data["will_travel"]:
        old = _travel_text(profile.will_travel if profile is not None else None)
        if old != data["will_travel"]:
            out["will_travel"] = {"old": old, "new": data["will_travel"]}
    if data["partner"] and partner_obj is not None:
        old_pid = profile.partner_id if profile is not None else None
        if old_pid != partner_obj.id:
            out["partner"] = {"old": partner_names.get(old_pid) if old_pid else None,
                              "new": partner_obj.name}
    if not is_worker:
        out["worker_role"] = {"old": None, "new": "granted"}
    if data.get("certifications"):
        # already filtered to the ones the person doesn't hold
        out["certifications"] = {"add": [_cert_label(c) for c in data["certifications"]]}
    return out


# ── commit ──────────────────────────────────────────────────────────

async def commit_rows(db: AsyncSession, numbered: list[tuple[int, dict]], *,
                      actor_id: uuid.UUID, actor_rank: int,
                      approved_updates: set[str], source_label: str) -> dict:
    """All-or-nothing: re-validates everything, then writes creates plus
    APPROVED updates in one transaction; unapproved updates are skipped.
    Raises rows_invalid (carrying the full preview payload) if any row
    errors — nothing is written.

    `numbered` must be the ORIGINAL uploaded cells (the preview's `cells`),
    never its normalized `data`."""
    preview = await preview_rows(db, numbered, actor_id=actor_id, actor_rank=actor_rank)
    if not preview["rows"] or any(r["action"] == "error" for r in preview["rows"]):
        raise BulkImportError("rows_invalid", rows=preview["rows"])

    ref = await _reference_data(db)
    counts = {"created": 0, "updated": 0, "skipped": 0, "unchanged": 0}
    applied: list[dict] = []
    for r in preview["rows"]:
        if r["action"] == "unchanged":
            action = "unchanged"
        elif r["action"] == "create":
            person = await _create_worker(db, actor_id, r["data"], ref, source_label)
            r["person_id"] = str(person.id)
            action = "created"
        elif r["person_id"] in approved_updates:
            await _apply_update(db, actor_id, r, ref)
            action = "updated"
        else:
            action = "skipped"
        counts[action] += 1
        applied.append({"row": r["row"], "name": r["name"],
                        "person_id": r["person_id"], "action": action,
                        "diff": r["diff"] if action in ("updated", "skipped") else None})
    audit(db, actor_id=actor_id, entity_type="worker", entity_id=None,
          action="bulk_import", changes={**counts, "source": source_label})
    await db.commit()
    return {**counts, "rows": applied}


def _resolve_partner(ref: dict, name: str) -> Partner | None:
    matches = ref["partners"].get(name.lower(), []) if name else []
    return matches[0] if len(matches) == 1 else None


def _audit_value(value: Any) -> Any:
    return str(value) if isinstance(value, uuid.UUID) else value


async def _create_worker(db: AsyncSession, actor_id: uuid.UUID, data: dict,
                         ref: dict, source_label: str) -> Person:
    fields = {attr: data[col] for col, attr in PERSON_ATTR.items()
              if data[col] not in ("", None)}
    person = Person(**fields, source="import", source_ref=source_label,
                    created_by=actor_id)
    db.add(person)
    await db.flush()
    partner = _resolve_partner(ref, data["partner"])
    profile = WorkerProfile(
        person_id=person.id, created_by=actor_id,
        partner_id=partner.id if partner else None,
        trade=data["trade"] or None, level=data["level"] or None,
        status=data["status"], status_note=data["status_note"] or None,
        will_travel=parse_will_travel(data["will_travel"]),
        travel_region=data["travel_region"] or None,
        travel_restrictions=data["travel_restrictions"] or None)
    db.add(profile)
    db.add(PersonRole(person_id=person.id, role="worker", granted_by=actor_id))
    changes = {key: {"from": None, "to": _audit_value(value)}
               for key, value in fields.items()}
    for col in PROFILE_COLUMNS:
        if data[col]:
            changes[col] = {"from": None, "to": data[col]}
    if data["will_travel"]:
        changes["will_travel"] = {"from": None, "to": data["will_travel"]}
    if partner is not None:
        changes["partner"] = {"from": None, "to": partner.name}
    changes["worker_role"] = {"from": None, "to": "granted"}
    audit(db, actor_id=actor_id, entity_type="worker",
          entity_id=str(person.id), action="create", changes=changes)
    _add_certifications(db, actor_id, person.id, data.get("certifications") or [])
    return person


def _add_certifications(db: AsyncSession, actor_id: uuid.UUID,
                        person_id: uuid.UUID, certs: list[dict]) -> None:
    """Each one exactly as POST /workers/{id}/certifications writes it."""
    for c in certs:
        db.add(WorkerCertification(
            person_id=person_id, name=c["name"], issuer=c["issuer"],
            issued_on=date.fromisoformat(c["issued_on"]) if c["issued_on"] else None,
            expires_on=date.fromisoformat(c["expires_on"]) if c["expires_on"] else None,
            created_by=actor_id))
        audit(db, actor_id=actor_id, entity_type="worker",
              entity_id=str(person_id), action="certification.add",
              changes={"name": {"from": None, "to": c["name"]}})


async def _apply_update(db: AsyncSession, actor_id: uuid.UUID, r: dict,
                        ref: dict) -> None:
    person = await db.get(Person, uuid.UUID(r["person_id"]))
    diff = dict(r["diff"] or {})
    if diff.pop("certifications", None) is not None:
        _add_certifications(db, actor_id, person.id, r["data"]["certifications"])
    if not diff:
        return      # certifications only: no field edits, no "update" audit
    profile = await db.get(WorkerProfile, person.id)
    had_profile = profile is not None
    if profile is None:
        # the kiosk sync keys "is a worker" off the profile row, so every
        # matched worker leaves the import with one
        profile = WorkerProfile(person_id=person.id, created_by=actor_id)
        db.add(profile)
    now = datetime.now(UTC)
    old_status = profile.status if had_profile else "active"
    changes: dict = {}
    for col, change in diff.items():
        if col in PERSON_ATTR:
            setattr(person, PERSON_ATTR[col], change["new"])
        elif col == "partner":
            partner = _resolve_partner(ref, change["new"])
            if partner is None:
                # auditing a change we did not apply would be a lie — roll back
                raise ValueError(
                    f"partner '{change['new']}' vanished between preview and commit")
            profile.partner_id = partner.id
        elif col == "worker_role":
            # the preview refuses this row; a contact added since it ran is refused here
            await assert_no_client_worker_mix(db, person.id, "worker")
            db.add(PersonRole(person_id=person.id, role="worker", granted_by=actor_id))
        elif col == "will_travel":
            profile.will_travel = parse_will_travel(change["new"])
        else:
            setattr(profile, col, change["new"])
        changes[col] = {"from": change["old"], "to": change["new"]}
    # No status_note re-assignment here: the diff loop above already applied
    # any status_note change (the equivalent line in PUT /workers/{id}/profile
    # is a no-op for the same reason).
    new_status = profile.status or "active"

    # blacklist ⇄ login access coupling, exactly as PUT /workers/{id}/profile
    account = await db.get(UserAccount, person.id)
    if account is not None:
        if new_status == "blacklist" and old_status != "blacklist":
            account.disabled_at = now
            account.updated_at = now
            await db.execute(
                update(AuthSession)
                .where(AuthSession.person_id == person.id,
                       AuthSession.revoked_at.is_(None))
                .values(revoked_at=now, revoke_reason="account_disabled"))
            await biometric.revoke_keys(db, person_id=person.id, reason="blacklist",
                                        actor_id=actor_id)
            await push_registrations.drop_for_person(db, person.id, reason="blacklist")
        elif old_status == "blacklist" and new_status != "blacklist":
            account.disabled_at = None
            account.failed_login_count = 0
            account.locked_until = None
            account.updated_at = now
    person.updated_at = now
    profile.updated_at = now
    audit(db, actor_id=actor_id, entity_type="worker",
          entity_id=str(person.id), action="update", changes=changes)
