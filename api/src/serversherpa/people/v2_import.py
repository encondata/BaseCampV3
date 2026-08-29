"""Import worker people (+ worker profiles, work history, avatars) from a
legacy BaseCamp V2 pg_dump.

One-shot seeding helper behind `serversherpa import-v2-workers` — like
`sites/v2_import.py`, NOT the designed bulk-import feature. The dump is
INSERT-statement format; row streaming/literal parsing is reused from the
sites importer. Anything that doesn't map cleanly onto the V3 schema is
left visible (appended to the person's notes) rather than silently
dropped. Additive only: no updates or deletions of pre-existing rows.
"""

import json
from collections import defaultdict
from datetime import UTC, datetime
from typing import Iterator

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Partner, Person, WorkerProfile
from serversherpa.sites.v2_import import insert_rows

# Identifies this dump for source_ref traceability; see Global Constraints.
SOURCE_REF_PREFIX = "backup_20260825_193157"

# The dump's `people` column list, in INSERT order (56 columns).
PEOPLE_COLS: tuple[str, ...] = (
    "id", "first_name", "last_name", "display_name", "email_address",
    "phone_number", "username", "password", "allow_password_login",
    "qr_code", "allow_qr_login", "rfid_tracker", "permissions", "user_type",
    "user_role", "people_status", "w_rating", "w_locations_available",
    "w_resource_partner", "w_work_type", "w_available_to_travel",
    "w_available_international_travel", "g_google_id", "g_email",
    "g_display_name", "g_avatar_url", "g_created_at", "g_updated_at",
    "g_last_login_at", "g_locale", "g_email_verified", "g_refresh_token",
    "g_access_token", "g_allow_oauth_login", "easter_egg", "2fa_enabled",
    "2fa_reduired", "has_photo", "has_notes", "clocked_in",
    "last_password_change", "password_change_required", "permission_groups",
    "totp_secret", "totp_enabled_at", "totp_grace_deadline",
    "totp_backup_codes", "totp_backup_codes_count", "totp_snooze_remaining",
    "twofa_required", "twofa_enabled", "worker_level", "client_id",
    "client_roles", "partner_id", "partner_roles",
)

# v2 status_options id -> (V3 worker-profile status, status note, archived).
# 27 Active / 28 In-Active / 29 2nd Choice / 30 Blacklisted / 31 Deleted.
_STATUS_MAP = {
    27: ("active", None, False),
    28: ("standby", "V2 status: In-Active", False),
    29: ("standby", "V2 status: 2nd Choice", False),
    30: ("blacklist", "V2 status: Blacklisted", False),
    31: ("standby", "V2 status: Deleted", True),   # import archived, not dropped
}


def _flags(raw: object) -> dict:
    """A dump JSON flag-dict column ('{"worker": true}') as a dict; any
    NULL/garbage collapses to {} so callers never branch on parse state."""
    if not isinstance(raw, str):
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def people_rows(dump_path: str) -> Iterator[dict]:
    """Stream the dump's people rows as {column: value} dicts. Rows whose
    value count doesn't match PEOPLE_COLS are skipped (malformed)."""
    for values in insert_rows(dump_path, "people"):
        if len(values) != len(PEOPLE_COLS):
            continue
        yield dict(zip(PEOPLE_COLS, values))


def is_worker(row: dict) -> bool:
    return _flags(row.get("user_type")).get("worker") is True


def trade_of(row: dict) -> str | None:
    """w_work_type flag-dict -> 'Cable, Project Manager' style trade
    string: truthy keys only, normalized (lower, _ -> space, Title Case),
    case-insensitively deduped, sorted for determinism."""
    truthy = [k for k, v in _flags(row.get("w_work_type")).items() if v]
    seen: dict[str, str] = {}
    for key in truthy:
        pretty = key.replace("_", " ").strip().lower().title()
        seen.setdefault(pretty.casefold(), pretty)
    return ", ".join(sorted(seen.values())) or None


def worker_status(row: dict) -> tuple[str, str | None, bool]:
    """(profile status, status note, import-as-archived) for a row."""
    raw = row.get("people_status")
    if raw is None:
        return ("active", None, False)
    if raw in _STATUS_MAP:
        return _STATUS_MAP[raw]
    return ("active", f"V2 status: unknown ({raw})", False)


def _yes_no(v: object) -> str:
    return "yes" if v else "no"


def worker_notes(
    row: dict, work_assocs: list[dict], partner_note: str | None,
) -> str | None:
    """Everything V3 has no column for, as visible note lines."""
    lines: list[str] = []
    if row.get("w_rating") is not None:
        # ints stay ints; 4.0000000000000000 from the dump prints as 4.0 —
        # trim a trailing '.0' so ratings read naturally
        rating = str(row["w_rating"]).rstrip("0").rstrip(".") \
            if "." in str(row["w_rating"]) else str(row["w_rating"])
        lines.append(f"V2 rating: {rating}")
    if row.get("w_locations_available"):
        lines.append(f"V2 locations available: {row['w_locations_available']}")
    if row.get("w_available_to_travel") is not None:
        lines.append(
            f"V2 available to travel: {_yes_no(row['w_available_to_travel'])}")
    if row.get("w_available_international_travel") is not None:
        lines.append("V2 available for international travel: "
                     f"{_yes_no(row['w_available_international_travel'])}")
    if partner_note:
        lines.append(partner_note)
    for a in work_assocs:
        entry = f"V2 work: {a.get('entity_type')} #{a.get('entity_id')}"
        if a.get("work_type"):
            entry += f" — {a['work_type']}"
        if a.get("site_worked"):
            entry += f" @ {a['site_worked']}"
        if a.get("rating") is not None:
            entry += f" (rating {a['rating']})"
        lines.append(entry)
    return "\n".join(lines) or None


# dump table column lists the orchestrator needs (INSERT order)
_PARTNER_COLS = ("id", "partner_name", "partner_services", "partner_region",
                 "parent_partner")
_WORK_ASSOC_COLS = ("id", "person_id", "entity_type", "entity_id",
                    "work_type", "site_worked", "rating", "created_at",
                    "updated_at", "metadata")


def _table_rows(dump_path: str, table: str,
                cols: tuple[str, ...]) -> Iterator[dict]:
    for values in insert_rows(dump_path, table):
        if len(values) != len(cols):
            continue
        yield dict(zip(cols, values))


async def import_workers(db: AsyncSession, dump_path: str, limit: int) -> dict:
    """Insert up to `limit` V2 worker people (+ profiles). Additive: rows
    whose source_ref or email already exist in V3 are skipped; nothing
    pre-existing is updated or deleted."""
    stats = {"imported": 0, "skipped_existing": 0, "skipped_non_worker": 0,
             "malformed": 0, "id_map": {}}

    existing_refs = set(await db.scalars(
        select(Person.source_ref).where(Person.source_ref.is_not(None))))
    existing_emails = {e.casefold() for e in await db.scalars(
        select(Person.email).where(Person.email.is_not(None)))}
    partners_v3 = {p.name.casefold(): p for p in await db.scalars(select(Partner))}

    v2_partner_names = {
        r["id"]: r["partner_name"]
        for r in _table_rows(dump_path, "partners", _PARTNER_COLS)
        if r.get("id") is not None and r.get("partner_name")}
    work_assocs: dict[object, list[dict]] = defaultdict(list)
    for r in _table_rows(dump_path, "people_work_association",
                         _WORK_ASSOC_COLS):
        work_assocs[r.get("person_id")].append(r)

    seen_this_run: set[str] = set()

    for values in insert_rows(dump_path, "people"):
        if stats["imported"] >= limit:
            break
        if len(values) != len(PEOPLE_COLS):
            stats["malformed"] += 1
            continue
        row = dict(zip(PEOPLE_COLS, values))
        if not is_worker(row):
            stats["skipped_non_worker"] += 1
            continue
        v2_id = row["id"]
        source_ref = f"{SOURCE_REF_PREFIX}:people/{v2_id}"
        email = row.get("email_address") or None
        email_cf = email.casefold() if email else None
        if (source_ref in existing_refs
                or (email_cf and email_cf in existing_emails)
                or (email_cf and email_cf in seen_this_run)):
            stats["skipped_existing"] += 1
            continue

        partner_note = None
        partner_id = None
        v2_partner = row.get("w_resource_partner")
        if v2_partner is not None:
            name = v2_partner_names.get(v2_partner)
            if name is None:
                partner_note = f"V2 partner #{v2_partner} not in dump"
            else:
                matched = partners_v3.get(name.casefold())
                if matched is None:
                    partner_note = f"V2 partner not in V3: {name}"
                else:
                    partner_id = matched.id

        status, status_note, archived = worker_status(row)
        first = (row.get("first_name") or "").strip()
        last = (row.get("last_name") or "").strip()
        display = (row.get("display_name") or "").strip()
        if not first and not last:
            first = display or f"V2 person {v2_id}"
        person = Person(
            first_name=first or display or "—",
            last_name=last,
            preferred_name=display if display and display != first else None,
            email=email,
            phone=row.get("phone_number") or None,
            rfid_tag=row.get("rfid_tracker") or None,
            notes=worker_notes(row, work_assocs.get(v2_id, []), partner_note),
            source="import",
            source_ref=source_ref,
            archived_at=datetime.now(UTC) if archived else None,
        )
        db.add(person)
        await db.flush()          # person.id for the profile row
        db.add(WorkerProfile(
            person_id=person.id, partner_id=partner_id,
            trade=trade_of(row), status=status, status_note=status_note))
        if email_cf:
            seen_this_run.add(email_cf)
        stats["id_map"][v2_id] = str(person.id)
        stats["imported"] += 1

    return stats
