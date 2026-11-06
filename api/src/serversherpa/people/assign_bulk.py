"""Assign workers to an initiative from a template: parse (via imports/bulk)
→ match each row to a person by name, then email, then phone → preview with
flags and per-row decisions → commit.

A row carries a worker's contact details (first, last, preferred, phone,
email) and the role they work. The initiative, site and partner are picked
on the page. Rows match live workers (`bulk_import._worker_query`) and
partner contacts (non-archived people with a partner `contact_profiles`
row); nobody else. The match order is fixed: name first (first + last or
preferred + last, see `bulk_import.name_keys`), then email, then phone. A
key that finds two or more people counts as no match for that key.

The preview raises flags (see the spec's "Flags and decisions"); each is
settled by the row's decision, and nothing commits until every row is
settled."""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import can_touch_rank
from serversherpa.db.models import (
    ContactProfile,
    Initiative,
    InitiativePerson,
    Partner,
    Person,
    PersonRole,
    Role,
    Site,
    StatusValue,
    UserAccount,
    WorkerProfile,
)
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import BulkImportError
from serversherpa.learning import assign as learning_assign
from serversherpa.people.bulk_import import _worker_query, name_keys, normalize_phone
from serversherpa.people.contact_format import format_phone, lower_email
from serversherpa.services.audit import audit, diff, snapshot

COLUMNS = ["first_name", "last_name", "preferred_name", "phone", "email", "role"]
SHEET = "Workers"
DEFAULT_ROLE = "tech"
WORK_TYPE = "initiative_work_type"
DECISION_FIELDS = ("person", "role", "change", "acknowledged")
CHANGES = ("update", "ignore")
ACKNOWLEDGEABLE = ("name_differs", "status", "shared_contact", "no_contact", "phone_invalid")


def _squash(text: str) -> str:
    return " ".join((text or "").split()).casefold()


def _full_name(first: str | None, last: str | None) -> str:
    return " ".join(f"{first or ''} {last or ''}".split())


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

def _first_partner(partner_names: dict, ids: set[uuid.UUID]) -> uuid.UUID:
    """The alphabetically first of several partners (case-insensitive)."""
    return min(ids, key=lambda pid: (partner_names.get(pid, "").casefold(), str(pid)))


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
            cand.partner_name = partner_names.get(
                _first_partner(partner_names, cand.partner_contact_of))

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
    emails_all: dict[str, str] = {}
    email_owner_names: dict[str, str] = {}
    for pid, email, first, last in (await db.execute(
            select(Person.id, Person.email, Person.first_name, Person.last_name)
            .where(Person.email.is_not(None)))).all():
        emails_all[lower_email(email)] = str(pid)
        email_owner_names[str(pid)] = _full_name(first, last)
    site_names = dict((await db.execute(select(Site.id, Site.name))).all())
    role_labels = {r.key: r.label for r in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == WORK_TYPE))}
    status_labels = {r.key: r.label for r in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == "worker"))}
    # the workers import's rank guard: people who can log in, and their rank
    account_ids = {str(pid) for pid in await db.scalars(select(UserAccount.person_id))}
    max_rank = {str(pid): rank for pid, rank in (await db.execute(
        select(PersonRole.person_id, func.max(Role.rank))
        .join(Role, Role.name == PersonRole.role)
        .where(PersonRole.revoked_at.is_(None))
        .group_by(PersonRole.person_id))).all()}
    return {
        "people": people, "by_name": by_name, "by_email": by_email, "by_phone": by_phone,
        "roles": roles, "role_index": role_index, "team": team, "emails_all": emails_all,
        "partner": await db.get(Partner, partner_id),
        "site_names": site_names, "partner_names": partner_names,
        "email_owner_names": email_owner_names, "role_labels": role_labels,
        "status_labels": status_labels, "account_ids": account_ids, "max_rank": max_rank,
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


# ── preview ─────────────────────────────────────────────────────────

DASH = "—"
CHANGE_KINDS = ("contact", "partner", "assignment")
ACTIONS = ("assign", "create", "already_assigned", "attention", "error")


def _flag(kind: str, decided: bool, lines: list[dict] | None = None,
          other_person: str | None = None) -> dict:
    return {"kind": kind, "decided": decided, "lines": lines or [],
            "other_person": other_person}


def _line(label: str, value: str | None) -> dict:
    return {"label": label, "value": value or DASH}


def _person_name(ref: dict, pid: str) -> str:
    p = ref["people"][pid].person
    return _full_name(p.first_name, p.last_name)


def _resolve_role(ref: dict, cells: dict, decision: dict) -> tuple[str | None, dict | None]:
    """(role key or None, role_unknown flag or None). The decision wins over
    the sheet; a blank sheet role is tech."""
    picked = decision.get("role")
    picked = picked if picked in ref["roles"] else None
    raw = (cells.get("role") or "").strip()
    sheet = ref["role_index"].get(_squash(raw)) if raw else DEFAULT_ROLE
    if sheet is None:
        return picked, _flag("role_unknown", picked is not None,
                             [_line("Role in sheet", raw)])
    return picked or sheet, None


def _existing_flags(ref: dict, pid: str, cells: dict, matched_by: str | None,
                    phone_fmt: str | None, email: str, role_key: str | None,
                    partner_id: uuid.UUID, site_id: uuid.UUID, decided) -> list[dict]:
    cand = ref["people"][pid]
    p = cand.person
    flags: list[dict] = []

    if matched_by in ("email", "phone"):
        row_keys = name_keys(cells.get("first_name", ""), cells.get("last_name", ""),
                             cells.get("preferred_name", ""))
        if not row_keys & name_keys(p.first_name, p.last_name, p.preferred_name or ""):
            flags.append(_flag("name_differs", decided("name_differs"), [
                _line("Name in sheet", _full_name(cells.get("first_name"),
                                                  cells.get("last_name"))),
                _line("Name on file", _full_name(p.first_name, p.last_name))]))

    lines: list[dict] = []
    if phone_fmt and normalize_phone(phone_fmt) != normalize_phone(p.phone or ""):
        lines += [_line("Phone on file", format_phone(p.phone or "") or p.phone),
                  _line("Phone in sheet", phone_fmt)]
    if email and email != lower_email(p.email or ""):
        lines += [_line("Email on file", p.email), _line("Email in sheet", email)]
        owner = ref["emails_all"].get(email)
        if owner and owner != pid:
            lines.append(_line("Email", "Not updated: in use by "
                               + ref["email_owner_names"][owner]))
    if lines:
        flags.append(_flag("contact", decided("contact"), lines))

    profile = cand.profile
    on_file: uuid.UUID | None | bool = False      # False: nothing to compare
    if profile is not None:
        on_file = profile.partner_id
    elif cand.partner_contact_of and partner_id not in cand.partner_contact_of:
        on_file = _contact_partner(ref, cand)
    if on_file is not False and on_file != partner_id:
        flags.append(_flag("partner", decided("partner"), [
            _line("Partner on file", ref["partner_names"].get(on_file)),
            _line("Partner picked", ref["partner"].name if ref["partner"] else None)]))
    if profile is not None and profile.status and profile.status != "active":
        flags.append(_flag("status", decided("status"), [
            _line("Status on file", ref["status_labels"].get(profile.status, profile.status))]))

    tp = ref["team"].get(uuid.UUID(pid))
    if tp is not None:
        lines = []
        if tp.site_worked_id != site_id:
            lines += [_line("Site on file", ref["site_names"].get(tp.site_worked_id)),
                      _line("Site picked", ref["site_names"].get(site_id))]
        if role_key is not None and tp.work_type != role_key:
            lines += [_line("Role on file", ref["role_labels"].get(tp.work_type, tp.work_type)),
                      _line("Role picked", ref["role_labels"].get(role_key))]
        if lines:
            flags.append(_flag("assignment", decided("assignment"), lines))

    others = set(ref["by_email"].get(email, [])) if email else set()
    if digits := normalize_phone(cells.get("phone") or ""):
        others |= set(ref["by_phone"].get(digits, []))
    others.discard(pid)
    if others:
        flags.append(_flag("shared_contact", decided("shared_contact"),
                           other_person=min(_person_name(ref, o) for o in others)))
    return flags


async def preview_rows(db: AsyncSession, initiative_id: uuid.UUID, partner_id: uuid.UUID,
                       site_id: uuid.UUID, numbered: list[tuple[int, dict]], *,
                       actor_id: uuid.UUID, actor_rank: int,
                       decisions: dict[int, dict] | None = None,
                       ref: dict | None = None, internal: bool = False) -> dict:
    """Each row matched, flagged and settled against its decision. A row's
    action is `attention` while any flag is undecided; `can_commit` only
    when nothing needs attention or errors and something would be written.

    With `internal=True` (the commit), each row also carries `_writes`:
    `{"commits": bool, "profile_partner_id": UUID | None}`, where the
    partner id is set when the commit creates a worker profile (a new
    worker, or a matched person without one). It never goes on the wire."""
    ref = ref or await load_reference(db, initiative_id, partner_id)
    decisions = decisions or {}
    rows: list[dict] = []
    for n, cells in numbered:
        decision = decisions.get(n, {})
        acknowledged = set(decision.get("acknowledged") or ())
        change = decision.get("change")

        def decided(kind: str, change=change, acknowledged=acknowledged) -> bool:
            return change in CHANGES if kind in CHANGE_KINDS else kind in acknowledged

        errors: list[str] = []
        if not (cells.get("first_name") or "").strip():
            errors.append("First name is required.")
        if not (cells.get("last_name") or "").strip():
            errors.append("Last name is required.")

        auto_pid, matched_by, matched_value = match_row(ref, cells)
        pid, create = auto_pid, False
        picked = decision.get("person")
        if picked == "new":
            pid, create, matched_by, matched_value = None, True, None, None
        elif picked is not None:
            if picked not in ref["people"]:
                errors.append("The chosen person no longer exists. Pick again.")
                pid, matched_by, matched_value = None, None, None
            elif picked != auto_pid:
                pid, matched_by, matched_value = picked, "pick", None

        flags: list[dict] = []
        if pid is None and not create and picked is None:
            flags.append(_flag("needs_match", False))

        role_key, role_flag = _resolve_role(ref, cells, decision)
        if role_flag:
            flags.append(role_flag)

        phone_raw = (cells.get("phone") or "").strip()
        phone_fmt = format_phone(phone_raw)
        email = lower_email(cells.get("email") or "")
        if phone_raw and phone_fmt is None:
            flags.append(_flag("phone_invalid", decided("phone_invalid"),
                               [_line("Phone in sheet", phone_raw)]))
        if not phone_raw and not email:
            flags.append(_flag("no_contact", decided("no_contact")))

        if pid is not None:
            flags += _existing_flags(ref, pid, cells, matched_by, phone_fmt, email,
                                     role_key, partner_id, site_id, decided)
        elif create and email and (owner := ref["emails_all"].get(email)):
            name = ref["email_owner_names"][owner]
            flags.append(_flag("shared_contact", decided("shared_contact"),
                               [_line("Email", f"in use by {name}; created without it")],
                               other_person=name))

        kinds = {f["kind"] for f in flags}
        # person-field edits only, as the workers import guards them; moving
        # someone's site or role on the initiative is not guarded
        if (change == "update" and pid is not None and kinds & {"contact", "partner"}
                and pid != str(actor_id) and pid in ref["account_ids"]
                and not can_touch_rank(actor_rank, ref["max_rank"].get(pid, 0))):
            errors.append("Your rank is too low to update this person.")

        cand = ref["people"].get(pid) if pid else None
        rows.append({
            "row": n, "cells": dict(cells),
            "name": _full_name(cells.get("first_name"), cells.get("last_name")),
            "table": "matched" if auto_pid else "unmatched",
            "matched_by": matched_by, "matched_value": matched_value,
            "person_id": pid, "person_name": _person_name(ref, pid) if pid else None,
            "create": create, "becomes_worker": bool(cand and not cand.is_worker),
            "role_key": role_key,
            "role_label": ref["role_labels"].get(role_key) if role_key else None,
            "flags": flags, "errors": errors,
            "_on_team": pid is not None and uuid.UUID(pid) in ref["team"],
            "_change": change,
        })

    _duplicate_errors(rows)
    for r in rows:
        on_team, change = r.pop("_on_team"), r.pop("_change")
        kinds = {f["kind"] for f in r["flags"]}
        if r["errors"]:
            r["action"] = "error"
        elif any(not f["decided"] for f in r["flags"]):
            r["action"] = "attention"
        elif r["create"]:
            r["action"] = "create"
        elif on_team and ("assignment" not in kinds or change == "ignore"):
            r["action"] = "already_assigned"
        else:
            r["action"] = "assign"
        commits = r["action"] in ("assign", "create") or (
            r["action"] == "already_assigned" and change == "update"
            and bool(kinds & set(CHANGE_KINDS)))
        r["_writes"] = {"commits": commits,
                        "profile_partner_id": _profile_partner(ref, r, partner_id, change)}

    counts = {a: sum(r["action"] == a for r in rows) for a in ACTIONS}
    writes = [r["_writes"]["commits"] for r in rows]
    if not internal:
        for r in rows:
            del r["_writes"]
    people = sorted(
        ({"id": pid, "label": _person_name(ref, pid), "detail": cand.partner_name or ""}
         for pid, cand in ref["people"].items()),
        key=lambda p: (p["label"].casefold(), p["detail"].casefold(), p["id"]))
    return {
        "rows": rows, "counts": counts, "people": people,
        "roles": [{"key": r.key, "label": r.label} for r in ref["roles"].values()],
        "can_commit": bool(rows) and not counts["attention"] and not counts["error"]
        and any(writes),
    }


def _profile_partner(ref: dict, row: dict, partner_id: uuid.UUID,
                     change: str | None) -> uuid.UUID | None:
    """The partner a worker profile created at commit gets: None when the
    person already has a profile."""
    if row["create"]:
        return partner_id
    cand = ref["people"].get(row["person_id"]) if row["person_id"] else None
    if cand is None or cand.profile is not None:
        return None
    if (change == "ignore" and cand.partner_contact_of
            and partner_id not in cand.partner_contact_of):
        return _contact_partner(ref, cand)      # keep the partner on file
    return partner_id


def _contact_partner(ref: dict, cand: Candidate) -> uuid.UUID:
    """The partner a profile-less contact is on file with."""
    return _first_partner(ref["partner_names"], cand.partner_contact_of)


def _duplicate_errors(rows: list[dict]) -> None:
    """One person on two rows, or two new workers sharing an email, errors
    every row involved."""
    by_person: dict[str, list[dict]] = {}
    by_new_email: dict[str, list[dict]] = {}
    for r in rows:
        if r["person_id"]:
            by_person.setdefault(r["person_id"], []).append(r)
        elif r["create"] and (email := lower_email(r["cells"].get("email") or "")):
            by_new_email.setdefault(email, []).append(r)
    for group in by_person.values():
        if len(group) > 1:
            nums = ", ".join(str(r["row"]) for r in group)
            for r in group:
                r["errors"].append(
                    f"{r['person_name']} appears on more than one row ({nums}).")
    for email, group in by_new_email.items():
        if len(group) > 1:
            nums = ", ".join(str(r["row"]) for r in group)
            for r in group:
                r["errors"].append(
                    f"Email {email} appears on more than one new worker (rows {nums}).")


# ── commit ──────────────────────────────────────────────────────────

# the unique indexes a concurrent write can trip between preview and commit
RACE_REASONS = {"initiative_people_uniq": "duplicate_worker",
                "people_email_uniq": "email_taken"}


async def commit_rows(db: AsyncSession, actor_id: uuid.UUID, initiative_id: uuid.UUID,
                      partner_id: uuid.UUID, site_id: uuid.UUID,
                      numbered: list[tuple[int, dict]], *, actor_rank: int,
                      decisions: dict[int, dict], source_label: str) -> dict:
    """All-or-nothing: re-runs the preview with the same decisions, refuses
    (rows_invalid, nothing written) unless it can commit, then in one
    transaction creates new workers, writes the Updates chosen, makes
    matched non-workers workers, and assigns everyone to the initiative.
    Worker status is never changed.

    Counts are one per row: `created` (a new worker, assigned), `assigned`
    (an existing person added to the initiative), `updated` (already on it,
    with their details or assignment updated) and `already_assigned`
    (nothing written). Row actions use the BulkApplySummary words: created
    and assigned rows are "created", updated rows "updated", the rest
    "unchanged"."""
    job = await db.get(Initiative, initiative_id)
    if job is None:
        raise BulkImportError("initiative_not_found")

    ref = await load_reference(db, initiative_id, partner_id)
    preview = await preview_rows(db, initiative_id, partner_id, site_id, numbered,
                                 actor_id=actor_id, actor_rank=actor_rank,
                                 decisions=decisions, ref=ref, internal=True)
    if not preview["can_commit"]:
        for r in preview["rows"]:
            r.pop("_writes", None)
        raise BulkImportError("rows_invalid", rows=preview["rows"])

    now = datetime.now(UTC)
    counts = {"assigned": 0, "created": 0, "updated": 0, "already_assigned": 0}
    applied: list[dict] = []
    try:
        for r in preview["rows"]:
            writes = r.pop("_writes")
            changes: dict = {}
            if not writes["commits"]:
                result = "already_assigned"
            elif r["create"]:
                person = await _create_worker(db, actor_id, r, ref, partner_id, source_label)
                r["person_id"] = str(person.id)
                await _add_to_team(db, actor_id, initiative_id, person.id, site_id,
                                   r["role_key"])
                result = "created"
            else:
                person_id = uuid.UUID(r["person_id"])
                update = decisions.get(r["row"], {}).get("change") == "update"
                changes = await _update_person(db, actor_id, r, ref, partner_id,
                                               writes["profile_partner_id"], update, now)
                tp = ref["team"].get(person_id)
                if tp is None:
                    await _add_to_team(db, actor_id, initiative_id, person_id, site_id,
                                       r["role_key"])
                    result = "assigned"
                else:
                    if update and any(f["kind"] == "assignment" for f in r["flags"]):
                        changes |= _move_assignment(db, actor_id, initiative_id, tp,
                                                    site_id, r["role_key"], ref, now)
                    result = "updated"
            counts[result] += 1
            applied.append({
                "row": r["row"], "name": r["person_name"] or r["name"],
                "person_id": r["person_id"],
                "action": {"created": "created", "assigned": "created",
                           "updated": "updated"}.get(result, "unchanged"),
                "diff": {k: {"old": v["from"], "new": v["to"]} for k, v in changes.items()}
                or None})

        job.updated_at = now
        audit(db, actor_id=actor_id, entity_type="initiative", entity_id=str(initiative_id),
              action="bulk_import", changes={**counts, "source": source_label})
        await db.commit()
    except IntegrityError as exc:
        # autoflush can surface a concurrent write at any query, not only at
        # commit(); only the two unique indexes a race can trip are friendly
        # errors. The constraint name lives on asyncpg's own exception, which
        # SQLAlchemy chains on as `exc.orig.__cause__`.
        await db.rollback()
        cause = exc.orig.__cause__ if exc.orig is not None else None
        reason = RACE_REASONS.get(getattr(cause, "constraint_name", None))
        if reason is None:
            raise
        raise BulkImportError("rows_invalid", reason=reason) from None
    except BulkImportError:
        await db.rollback()
        raise
    return {**counts, "rows": applied}


async def _create_worker(db: AsyncSession, actor_id: uuid.UUID, r: dict, ref: dict,
                         partner_id: uuid.UUID, source_label: str) -> Person:
    """A new worker from the row, as the workers import writes one. A phone
    that can't be parsed is left off, and so is an email someone holds."""
    c = r["cells"]
    email = lower_email(c.get("email") or "")
    fields = {
        "first_name": (c.get("first_name") or "").strip(),
        "last_name": (c.get("last_name") or "").strip(),
        "preferred_name": (c.get("preferred_name") or "").strip() or None,
        "phone": format_phone((c.get("phone") or "").strip()),
        "email": email if email and email not in ref["emails_all"] else None,
    }
    fields = {k: v for k, v in fields.items() if v}
    person = Person(**fields, source="import", source_ref=source_label, created_by=actor_id)
    db.add(person)
    await db.flush()
    db.add(WorkerProfile(person_id=person.id, created_by=actor_id, partner_id=partner_id,
                         status="active"))
    db.add(PersonRole(person_id=person.id, role="worker", granted_by=actor_id))
    changes = {k: {"from": None, "to": v} for k, v in fields.items()}
    changes["status"] = {"from": None, "to": "active"}
    if ref["partner"] is not None:
        changes["partner"] = {"from": None, "to": ref["partner"].name}
    changes["worker_role"] = {"from": None, "to": "granted"}
    audit(db, actor_id=actor_id, entity_type="worker", entity_id=str(person.id),
          action="create", changes=changes)
    return person


async def _update_person(db: AsyncSession, actor_id: uuid.UUID, r: dict, ref: dict,
                         partner_id: uuid.UUID, profile_partner_id: uuid.UUID | None,
                         update: bool, now: datetime) -> dict:
    """The Updates chosen for a matched person, a profile when they have
    none, and the worker role when they aren't a worker; one `worker`
    `update` audit entry with what changed (from/to). Returns the changes."""
    cand = ref["people"][r["person_id"]]
    person, profile = cand.person, cand.profile
    kinds = {f["kind"] for f in r["flags"]}
    changes: dict = {}

    if update and "contact" in kinds:
        phone = format_phone((r["cells"].get("phone") or "").strip())
        if phone and normalize_phone(phone) != normalize_phone(person.phone or ""):
            changes["phone"] = {"from": person.phone, "to": phone}
            person.phone = phone
        email = lower_email(r["cells"].get("email") or "")
        owner = ref["emails_all"].get(email)
        if (email and email != lower_email(person.email or "")
                and owner in (None, r["person_id"])):
            changes["email"] = {"from": person.email, "to": email}
            person.email = email

    if profile is None:
        profile = cand.profile = WorkerProfile(
            person_id=person.id, created_by=actor_id, partner_id=profile_partner_id,
            status="active")
        db.add(profile)
        if profile_partner_id is not None:
            changes["partner"] = {"from": None,
                                  "to": ref["partner_names"].get(profile_partner_id)}
    elif update and "partner" in kinds and profile.partner_id != partner_id:
        changes["partner"] = {"from": ref["partner_names"].get(profile.partner_id),
                              "to": ref["partner_names"].get(partner_id)}
        profile.partner_id = partner_id
        profile.updated_at = now

    if not cand.is_worker:
        # a revoked role is history: grant a new one, as the workers import does
        db.add(PersonRole(person_id=person.id, role="worker", granted_by=actor_id))
        changes["worker_role"] = {"from": None, "to": "granted"}

    if changes:
        person.updated_at = now
        audit(db, actor_id=actor_id, entity_type="worker", entity_id=str(person.id),
              action="update", changes=changes)
    return changes


async def _add_to_team(db: AsyncSession, actor_id: uuid.UUID, initiative_id: uuid.UUID,
                       person_id: uuid.UUID, site_id: uuid.UUID, role_key: str) -> None:
    db.add(InitiativePerson(initiative_id=initiative_id, person_id=person_id,
                            site_worked_id=site_id, work_type=role_key))
    # flushed so the learning rules see the row; the assignments commit or
    # roll back with the whole import
    await db.flush()
    await learning_assign.assign_on_add(db, initiative_id, person_id, actor_id)
    audit(db, actor_id=actor_id, entity_type="initiative", entity_id=str(initiative_id),
          action="person_add", changes={"person_id": {"from": None, "to": str(person_id)}})


def _move_assignment(db: AsyncSession, actor_id: uuid.UUID, initiative_id: uuid.UUID,
                     tp: InitiativePerson, site_id: uuid.UUID, role_key: str, ref: dict,
                     now: datetime) -> dict:
    """Update on an `assignment` flag: the picked site and the row's role.
    Returns the change for the summary (names, not ids)."""
    fields = ["site_worked_id", "work_type"]
    before = snapshot(tp, fields)
    old_site, old_role = tp.site_worked_id, tp.work_type
    tp.site_worked_id, tp.work_type, tp.updated_at = site_id, role_key, now
    audit(db, actor_id=actor_id, entity_type="initiative", entity_id=str(initiative_id),
          action="person_update", changes=diff(before, snapshot(tp, fields)))
    out: dict = {}
    if old_site != site_id:
        out["site"] = {"from": ref["site_names"].get(old_site),
                       "to": ref["site_names"].get(site_id)}
    if old_role != role_key:
        out["role"] = {"from": ref["role_labels"].get(old_role, old_role),
                       "to": ref["role_labels"].get(role_key, role_key)}
    return out
