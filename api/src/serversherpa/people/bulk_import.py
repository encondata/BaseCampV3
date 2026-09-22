"""Workers bulk import: parse (via imports/bulk) → match → preview/commit.

A worker is three records — a people row, an active `worker` role grant,
and a worker_profiles row — and every create writes all three. Rows match
an existing (non-archived) person by email, phone (digits only) or name
(first + last, or preferred + last); keys that disagree are a row error.

Blank-cell rule: on create rows a blank status/country takes the default
(active/US); on update rows a blank cell means "no change", never a clear.
The original blankness is tracked out-of-band (`blank`) because `data` has
already had defaults applied by diff time. Each preview row also carries
`cells` (the uploaded cells before defaults) — the commit replays those.
"""

import re
import uuid
from datetime import UTC, datetime
from typing import Any

from pydantic import EmailStr, TypeAdapter, ValidationError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import can_touch_rank
from serversherpa.db.models import (
    AuthSession, Partner, Person, PersonRole, Role, StatusValue, UserAccount,
    WorkerLevel, WorkerProfile,
)
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import MAX_BYTES, MAX_ROWS, BulkImportError
from serversherpa.services.audit import audit

__all__ = ["BulkImportError", "MAX_BYTES", "MAX_ROWS"]

COLUMNS = [
    "first_name", "last_name", "preferred_name", "email", "phone",
    "job_title", "employee_number", "rfid_tag", "address_line1",
    "address_line2", "city", "region", "postal_code", "country",
    "partner", "trade", "level", "status", "status_note", "notes",
]
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
PROFILE_COLUMNS = ("trade", "level", "status", "status_note")

SAMPLE_ROWS: list[dict] = [
    {"first_name": "Robert", "last_name": "Smith", "preferred_name": "Bob",
     "email": "bob.smith@example.com", "phone": "555-123-4567",
     "job_title": "Lead Technician", "employee_number": "E1042",
     "rfid_tag": "", "address_line1": "12 Rack Row", "address_line2": "",
     "city": "Reno", "region": "NV", "postal_code": "89501", "country": "US",
     "partner": "", "trade": "Cable, Rack & Stack", "level": "L4",
     "status": "active", "status_note": "", "notes": "Sample row — replace me"},
    {"first_name": "Maria", "last_name": "Lopez", "preferred_name": "",
     "email": "", "phone": "(555) 987-6543", "job_title": "",
     "employee_number": "", "rfid_tag": "", "address_line1": "",
     "address_line2": "", "city": "", "region": "", "postal_code": "",
     "country": "", "partner": "Example Staffing", "trade": "Cable",
     "level": "L2", "status": "standby", "status_note": "", "notes": ""},
]

_EMAIL = TypeAdapter(EmailStr)
_COUNTRY = re.compile(r"^[A-Za-z]{2}$")


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

def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    return core.number_json_rows(rows, COLUMNS)


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    return core.parse_upload(filename, content, COLUMNS, SHEET)


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
        .order_by(Partner.name)))
    return levels, statuses, partners


# ── export ──────────────────────────────────────────────────────────

def _worker_query():
    return (
        select(Person, WorkerProfile)
        .join(PersonRole, (PersonRole.person_id == Person.id)
              & (PersonRole.role == "worker")
              & (PersonRole.revoked_at.is_(None)))
        .outerjoin(WorkerProfile, WorkerProfile.person_id == Person.id)
        .where(Person.archived_at.is_(None))
        .order_by(Person.last_name, Person.first_name)
    )


async def export_rows(db: AsyncSession) -> list[dict]:
    """Every live worker in template shape, so an export re-uploads clean."""
    partner_names = dict((await db.execute(select(Partner.id, Partner.name))).all())
    out = []
    for person, profile in (await db.execute(_worker_query())).all():
        row = {col: (getattr(person, attr) or "") for col, attr in PERSON_ATTR.items()}
        row["partner"] = (partner_names.get(profile.partner_id, "")
                          if profile and profile.partner_id else "")
        row["trade"] = (profile.trade if profile else None) or ""
        row["level"] = (profile.level if profile else None) or ""
        row["status"] = (profile.status if profile else None) or "active"
        row["status_note"] = (profile.status_note if profile else None) or ""
        out.append(row)
    return out
