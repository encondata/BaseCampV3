"""Add time punches in bulk: parse (via imports/bulk) → match worker / job /
site → read the times → preview with per-row overrides and skips → commit.

One row is one shift. Workers match live workers (an active `worker` grant,
not archived) the way the workers tool matches people: an email wins, then
a phone number (digits only), then a name via people/bulk_import.name_keys.
Jobs match non-archived initiatives by name, and sites match non-archived
sites by name or code, case-insensitively. Unknown or ambiguous values leave
the row in `attention` with candidates, until the admin picks one (an
override) or skips the row.

Times are read by people/time_parse in the row's zone: the matched or picked
site's timezone, else the job's site's, else DEFAULT_TIMEZONE. A shift that
overlaps the worker's existing time is an error. An open entry overlaps
everything after its clock-in, and rejected entries are ignored. A shift
that overlaps another row of the file is an error too. An exact repeat of an
existing entry (same worker, same clock-in and clock-out to the minute, any
status) is `duplicate` and is skipped on commit. Imported shifts are added
as pending, source "import"."""

import re
import uuid
from bisect import bisect_left, bisect_right
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import insert, or_, select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import AuditLog, Initiative, Person, Site, TimeEntry
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import BulkImportError
from serversherpa.people import time_parse as tp
from serversherpa.people.bulk_import import _worker_query, name_keys, normalize_phone
from serversherpa.services.timezone import stored_day

COLUMNS = ["worker", "clock_in", "clock_out", "break_minutes", "job", "site", "notes"]
SHEET = "Time"
FIELDS = ("worker", "job", "site")
MAX_ROWS = 5000
MAX_BYTES = 5 * 1024 * 1024
MAX_SHIFT = timedelta(hours=24)
# How long the commit waits for the time_entries table lock before it gives
# up with TimeImportBusy. A literal for SET LOCAL (it takes no bind params).
LOCK_TIMEOUT = "5s"
# A row names at most this many other rows of the file it overlaps.
OVERLAP_NAMES = 3
NOTHING_TO_ADD = "Every shift in this file is already there or was skipped."
# The preview lists problems first.
ACTION_ORDER = ("attention", "error", "add", "duplicate", "skipped")
SAMPLE_ROWS: list[dict] = [
    {"worker": "Marcus Reyes", "clock_in": "9/24/2026 7:00 AM",
     "clock_out": "9/24/2026 3:30 PM", "break_minutes": "30", "job": "Example Move",
     "site": "Example DC West", "notes": "Sample row — replace me"},
    {"worker": "dana.whitfield@example.com", "clock_in": "2026-09-24T22:00:00-05:00",
     "clock_out": "2026-09-25T06:00:00-05:00", "break_minutes": "", "job": "", "site": "",
     "notes": ""},
]
_PHONEISH = re.compile(r"^[\d\s()+.\-]+$")


# ── parsing ─────────────────────────────────────────────────────────

def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    return core.number_json_rows(rows, COLUMNS, max_rows=MAX_ROWS)


def number_posted_rows(rows: Any, row_numbers: Any) -> list[tuple[int, dict]]:
    return core.renumber(number_json_rows(rows), row_numbers)


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    return core.parse_upload(filename, content, COLUMNS, SHEET,
                             max_rows=MAX_ROWS, max_bytes=MAX_BYTES)


def parse_overrides(raw: Any) -> dict[int, dict[str, str]]:
    return core.parse_overrides(raw, FIELDS)


def parse_row_list(raw: Any, code: str) -> set[int]:
    return core.parse_row_list(raw, code)


# ── reference data ──────────────────────────────────────────────────

def _squash(value: str) -> str:
    return " ".join((value or "").split()).casefold()


def _worker_label(p: Person) -> str:
    return f"{p.first_name} {p.last_name}"


def _index(index: dict, key: str, obj) -> None:
    if key:
        index.setdefault(key, []).append(obj)


async def _reference(db: AsyncSession) -> dict:
    workers = list({p.id: p for p, _ in (await db.execute(_worker_query())).all()}.values())
    email: dict[str, list[Person]] = {}
    phone: dict[str, list[Person]] = {}
    name: dict[str, list[Person]] = {}
    for p in workers:
        _index(email, (p.email or "").casefold(), p)
        _index(phone, normalize_phone(p.phone or ""), p)
        for key in name_keys(p.first_name, p.last_name, p.preferred_name or ""):
            _index(name, key, p)
    jobs = list(await db.scalars(
        select(Initiative).where(Initiative.archived_at.is_(None)).order_by(Initiative.name)))
    job_index: dict[str, list[Initiative]] = {}
    for j in jobs:
        _index(job_index, _squash(j.name), j)
    sites = list(await db.scalars(
        select(Site).where(Site.archived_at.is_(None)).order_by(Site.name)))
    site_index: dict[str, list[Site]] = {}
    for s in sites:
        for key in {_squash(s.name), _squash(s.code or "")}:
            _index(site_index, key, s)
    return {
        "email": email, "phone": phone, "name": name, "job": job_index, "site": site_index,
        "by_id": {"worker": {str(p.id): p for p in workers},
                  "job": {str(j.id): j for j in jobs},
                  "site": {str(s.id): s for s in sites}},
        # every site, archived too: a job's site can be archived and still
        # say which wall clock the job worked on
        "zones": dict((await db.execute(select(Site.id, Site.timezone))).all()),
    }


def _candidate(field: str, obj) -> dict:
    if field == "worker":
        return {"id": str(obj.id), "label": _worker_label(obj),
                "detail": obj.email or obj.phone or ""}
    if field == "job":
        day = stored_day(obj.scheduled_start) if obj.scheduled_start else None
        return {"id": str(obj.id), "label": obj.name,
                "detail": f"Starts {day:%b} {day.day}, {day.year}" if day else ""}
    return {"id": str(obj.id), "label": obj.name, "detail": obj.code or ""}


def _matches(ref: dict, field: str, cell: str) -> tuple[list, str]:
    """Every record this cell names, and how it matched. A worker cell with
    an @ is an email; a phone-looking one matches by phone and falls back to
    name when no phone matches; anything else is a name."""
    value = cell.strip()
    if field != "worker":
        return ref[field].get(_squash(value), []), "name"
    if "@" in value:
        return ref["email"].get(value.casefold(), []), "email"
    key = normalize_phone(value) if _PHONEISH.match(value) else ""
    if key and ref["phone"].get(key):
        return ref["phone"][key], "phone"
    return ref["name"].get(_squash(value), []), "name"


def _resolve(ref: dict, field: str, cell: str, picked: str | None,
             issues: list[dict], errors: list[str]) -> tuple[Any, str | None]:
    """(record, matched_by). The admin's pick wins; otherwise exactly one
    match. Unknown or ambiguous → an issue with candidates; a pick that
    points at nothing → an error. (None, None) when blank or unresolved."""
    if picked:
        obj = ref["by_id"][field].get(picked)
        if obj is None:
            errors.append(f"The chosen {field} no longer exists. Pick again.")
            return None, None
        return obj, "your pick"
    if not cell:
        return None, None
    found, how = _matches(ref, field, cell)
    unique = list({m.id: m for m in found}.values())
    if len(unique) == 1:
        return unique[0], how
    issues.append({"field": field, "kind": "ambiguous" if unique else "unknown",
                   "value": cell, "candidates": [_candidate(field, m) for m in unique]})
    return None, None


def _zone(ref: dict, site: Site | None, job: Initiative | None) -> ZoneInfo:
    """The row's wall clock: its own site's zone; with no site, the job's
    site's; otherwise (or when that zone is blank or unknown) the default."""
    if site is not None:
        return tp.zone_for(site.timezone)
    if job is not None and job.site_id is not None:
        return tp.zone_for(ref["zones"].get(job.site_id))
    return tp.zone_for(None)


# ── times ───────────────────────────────────────────────────────────

def _read_times(cells: dict, zone: ZoneInfo, now: datetime, errors: list[str],
                ) -> tuple[datetime | None, datetime | None, int | None]:
    """(clock-in, clock-out, break). The two times come back only when they
    form a usable span (clock-out after clock-in, at most 24 hours); each
    problem is appended to `errors` as a sentence."""
    times: dict[str, datetime | None] = {}
    for key, label in (("clock_in", "Clock-in"), ("clock_out", "Clock-out")):
        raw = cells[key]
        times[key] = None
        if not raw:
            errors.append(f"{label} is required.")
            continue
        times[key] = tp.parse_clock(raw, zone)
        if times[key] is None:
            errors.append(f"{label} '{raw}' is not a date and time this import can read.")
    start, end = times["clock_in"], times["clock_out"]
    brk = tp.parse_break(cells["break_minutes"])
    if brk is None:
        errors.append("The break must be a whole number of minutes, 0 or more.")
    if start is not None and start > now:
        errors.append("Clock-in is in the future.")
    if start is None or end is None:
        return None, None, brk
    if end <= start:
        errors.append("Clock-out must be after clock-in.")
        return None, None, brk
    if end - start > MAX_SHIFT:
        errors.append("The shift is longer than 24 hours.")
        return None, None, brk
    if brk is not None and brk >= int((end - start).total_seconds() // 60):
        errors.append("The break is as long as the shift or longer.")
    return start, end, brk


def _minute(at: datetime) -> datetime:
    return at.astimezone(UTC).replace(second=0, microsecond=0)


def _same_shift(e: TimeEntry, start: datetime, end: datetime) -> bool:
    return (e.clock_out_at is not None and _minute(e.clock_in_at) == _minute(start)
            and _minute(e.clock_out_at) == _minute(end))


async def _check_existing(db: AsyncSession, rows: list[dict],
                          spans: dict[int, tuple[datetime, datetime, ZoneInfo]]) -> None:
    """Against the database: an exact repeat becomes `duplicate` (and leaves
    `spans`, so it cannot clash with another row); anything else that meets
    the worker's non-rejected time is an error naming that entry.

    Only rows with a resolved worker reach here (a span needs one). A row
    with errors is never a duplicate, but an unresolved job or site does not
    stop one: the shift is already there, so there is nothing to pick."""
    if not spans:
        return
    by_row = {r["row"]: r for r in rows}
    people = {uuid.UUID(by_row[n]["person_id"]) for n in spans}
    lo = min(s for s, _, _ in spans.values())
    hi = max(e for _, e, _ in spans.values())
    existing: dict[str, list[TimeEntry]] = {}
    for e in await db.scalars(
            select(TimeEntry).where(
                TimeEntry.person_id.in_(people), TimeEntry.clock_in_at < hi,
                or_(TimeEntry.clock_out_at.is_(None), TimeEntry.clock_out_at > lo))
            .order_by(TimeEntry.clock_in_at)):
        existing.setdefault(str(e.person_id), []).append(e)
    for n in list(spans):
        row = by_row[n]
        start, end, zone = spans[n]
        mine = existing.get(row["person_id"], [])
        if not row["errors"] and any(_same_shift(e, start, end) for e in mine):
            row["action"] = "duplicate"
            row["detail"] = "Already there."
            row["issues"] = []
            del spans[n]
            continue
        who = row["person_name"]
        for e in mine:
            if e.status == "rejected":
                continue
            if e.clock_out_at is None:
                if e.clock_in_at < end:
                    row["errors"].append(f"Overlaps {who}'s open entry that started "
                                         f"{tp.clock_text(e.clock_in_at, zone)}.")
            elif e.clock_in_at < end and start < e.clock_out_at:
                row["errors"].append(f"Overlaps {who}'s existing entry on "
                                     f"{tp.shift_text(e.clock_in_at, e.clock_out_at, zone)}.")


def _check_file(rows: list[dict], spans: dict[int, tuple[datetime, datetime, ZoneInfo]]) -> None:
    """Within the file: two of one worker's rows whose spans overlap are
    both errors. Each row names the first OVERLAP_NAMES rows it overlaps (in
    clock-in order), then says how many more there are.

    Bounded work per row, even on a file where every row is one worker:
    the count comes from two bisects (rows starting before this one ends,
    minus rows ending by the time it starts, minus itself); the names come
    from a scan that stops at OVERLAP_NAMES. The backward part of that scan
    starts MAX_SHIFT before the row's clock-in, since no span is longer."""
    by_row = {r["row"]: r for r in rows}
    groups: dict[str, list[int]] = {}
    for n in spans:
        groups.setdefault(by_row[n]["person_id"], []).append(n)
    for ns in groups.values():
        if len(ns) < 2:
            continue
        ns.sort(key=lambda n: (spans[n][0], n))
        starts = [spans[n][0] for n in ns]
        ends = sorted(spans[n][1] for n in ns)
        for i, a in enumerate(ns):
            start, end, _ = spans[a]
            count = bisect_left(starts, end) - bisect_right(ends, start) - 1
            if count <= 0:
                continue
            names: list[int] = []
            for j in range(bisect_left(starts, start - MAX_SHIFT), i):
                if spans[ns[j]][1] > start:
                    names.append(ns[j])
                    if len(names) == OVERLAP_NAMES:
                        break
            j = i + 1
            while len(names) < OVERLAP_NAMES and j < len(ns) and starts[j] < end:
                names.append(ns[j])
                j += 1
            errors = by_row[a]["errors"]
            errors.extend(f"Overlaps row {b} in this file." for b in names)
            more = count - len(names)
            if more:
                errors.append(f"Also overlaps {more} more row{'s' if more > 1 else ''} "
                              "in this file.")


# ── preview ─────────────────────────────────────────────────────────

def _blank_row(n: int, cells: dict) -> dict:
    return {"row": n, "name": cells["worker"] or None, "person_id": None,
            "person_name": None, "matched_by": None, "job_id": None, "job_name": None,
            "site_id": None, "site_name": None, "zone": None, "clock_in_at": None,
            "clock_out_at": None, "break_minutes": None, "minutes": None, "shift": None,
            "notes": cells["notes"], "action": None, "errors": [], "issues": [],
            "detail": None, "cells": cells}


async def preview_rows(db: AsyncSession, numbered: list[tuple[int, dict]], *,
                       overrides: dict[int, dict[str, str]] | None = None,
                       skip: set[int] | None = None, now: datetime | None = None) -> dict:
    """The preview: every row with its action, problems first. `now` is
    injectable so tests can pin what "in the future" means."""
    ref = await _reference(db)
    overrides = overrides or {}
    skip = skip or set()
    now = now or datetime.now(UTC)
    out: list[dict] = []
    spans: dict[int, tuple[datetime, datetime, ZoneInfo]] = {}
    for n, cells in numbered:
        row = _blank_row(n, cells)
        out.append(row)
        if n in skip:
            row["action"] = "skipped"
            continue
        picks = overrides.get(n, {})
        errors, issues = row["errors"], row["issues"]
        if not cells["worker"] and not picks.get("worker"):
            errors.append("Worker is required.")
            person, how = None, None
        else:
            person, how = _resolve(ref, "worker", cells["worker"], picks.get("worker"),
                                   issues, errors)
        job, _ = _resolve(ref, "job", cells["job"], picks.get("job"), issues, errors)
        site, _ = _resolve(ref, "site", cells["site"], picks.get("site"), issues, errors)
        zone = _zone(ref, site, job)
        start, end, brk = _read_times(cells, zone, now, errors)
        row.update(zone=zone.key, break_minutes=brk, matched_by=how,
                   job_id=str(job.id) if job else None, job_name=job.name if job else None,
                   site_id=str(site.id) if site else None,
                   site_name=site.name if site else None)
        if person is not None:
            row.update(person_id=str(person.id), person_name=_worker_label(person),
                       name=_worker_label(person))
        if start is not None and end is not None:
            span = int((end - start).total_seconds() // 60)
            row.update(clock_in_at=start.isoformat(), clock_out_at=end.isoformat(),
                       shift=tp.shift_text(start, end, zone),
                       minutes=max(0, span - (brk or 0)))
            if person is not None:
                spans[n] = (start, end, zone)
    await _check_existing(db, out, spans)
    _check_file(out, spans)
    counts = dict.fromkeys(ACTION_ORDER, 0)
    for row in out:
        if row["action"] is None:
            row["action"] = ("error" if row["errors"]
                             else "attention" if row["issues"] else "add")
        counts[row["action"]] += 1
    out.sort(key=lambda r: (ACTION_ORDER.index(r["action"]), r["row"]))
    return {"rows": out, "counts": counts,
            "can_commit": counts["add"] > 0 and counts["attention"] == 0
            and counts["error"] == 0}


# ── commit ──────────────────────────────────────────────────────────

class TimeImportBusy(Exception):
    """The commit could not get the time_entries lock within LOCK_TIMEOUT."""


_LOCK_NOT_AVAILABLE = "55P03"   # SQLSTATE lock_not_available


async def _lock_time_entries(db: AsyncSession) -> None:
    """LOCK TABLE, waiting at most LOCK_TIMEOUT. asyncpg's
    LockNotAvailableError reaches us as a plain DBAPIError whose `orig`
    carries the SQLSTATE; on it the transaction is rolled back and
    TimeImportBusy raised. The timeout is SET LOCAL and reset once the lock
    is held, so it covers only the wait for this lock."""
    await db.execute(text(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'"))
    try:
        await db.execute(text("LOCK TABLE time_entries IN SHARE ROW EXCLUSIVE MODE"))
    except DBAPIError as exc:
        await db.rollback()
        if getattr(exc.orig, "sqlstate", None) == _LOCK_NOT_AVAILABLE:
            raise TimeImportBusy from None
        raise
    await db.execute(text("SET LOCAL lock_timeout TO DEFAULT"))


def _audit_row(actor_id: uuid.UUID, entity_id: str | None, action: str,
               changes: dict) -> dict:
    return {"actor_person_id": actor_id, "entity_type": "time_entry",
            "entity_id": entity_id, "action": action, "changes": changes}


async def commit_rows(db: AsyncSession, actor_id: uuid.UUID,
                      numbered: list[tuple[int, dict]], *,
                      overrides: dict[int, dict[str, str]], skip: set[int],
                      source_label: str, now: datetime | None = None) -> dict:
    """All-or-nothing. First takes a SHARE ROW EXCLUSIVE lock on
    time_entries. That lock conflicts with the ROW EXCLUSIVE lock every
    INSERT / UPDATE takes (a kiosk clock-in, a clock-out, an edit, an
    approval) and with itself. So no other write to time_entries can commit
    between the overlap re-check below and this commit, and two imports run
    one after the other; plain reads are not blocked. A row lock would not
    do: SELECT … FOR UPDATE on the workers' entries cannot stop a concurrent
    INSERT of a new, overlapping one.

    It waits at most LOCK_TIMEOUT for that lock. A writer that holds on
    longer (a long edit, another import) makes the commit give up with
    TimeImportBusy, nothing written, rather than queue behind it while every
    kiosk punch queues behind the commit.

    Then it re-runs the preview with the same picks and skips, and refuses
    (nothing written) unless the result can be committed: rows_invalid with
    the attention and error rows, or nothing_to_add when every row is a
    duplicate or skipped. This is where a shift punched at a kiosk since the
    preview becomes an overlap error naming its row. Each `add` row becomes
    one pending `import` entry with its own audit row, plus one bulk_import
    summary row."""
    await _lock_time_entries(db)
    preview = await preview_rows(db, numbered, overrides=overrides, skip=skip, now=now)
    if not preview["can_commit"]:
        await db.rollback()
        problems = [r for r in preview["rows"] if r["action"] in ("attention", "error")]
        if not problems:
            raise BulkImportError("nothing_to_add", message=NOTHING_TO_ADD)
        raise BulkImportError("rows_invalid", rows=problems)
    # Rows go in as two ORM bulk INSERTs (batched by insertmanyvalues)
    # rather than 2 × N session objects, so the table lock is held for less
    # time. The ids are made here, so each row still reports its entry's id.
    # The audit rows are the ones services.audit.audit() would add.
    applied: list[dict] = []
    entries: list[dict] = []
    audits: list[dict] = []
    added = skipped = 0
    for r in sorted(preview["rows"], key=lambda r: r["row"]):
        if r["action"] != "add":
            skipped += 1
            applied.append({"row": r["row"], "name": r["name"], "entry_id": None,
                            "action": "skipped", "detail": r["detail"] or "Skipped."})
            continue
        entry_id = uuid.uuid4()
        entries.append({
            "id": entry_id, "person_id": uuid.UUID(r["person_id"]),
            "initiative_id": uuid.UUID(r["job_id"]) if r["job_id"] else None,
            "site_id": uuid.UUID(r["site_id"]) if r["site_id"] else None,
            "clock_in_at": datetime.fromisoformat(r["clock_in_at"]),
            "clock_out_at": datetime.fromisoformat(r["clock_out_at"]),
            "break_minutes": r["break_minutes"], "notes": r["notes"], "status": "pending",
            "source": "import", "created_by": actor_id, "adjusted": False})
        audits.append(_audit_row(actor_id, str(entry_id), "import",
                                 {"status": {"from": None, "to": "pending"}}))
        added += 1
        applied.append({"row": r["row"], "name": r["name"], "entry_id": str(entry_id),
                        "action": "created", "detail": r["shift"]})
    audits.append(_audit_row(actor_id, None, "bulk_import",
                             {"added": added, "skipped": skipped, "source": source_label}))
    await db.execute(insert(TimeEntry), entries)
    await db.execute(insert(AuditLog), audits)
    await db.commit()
    return {"summary": {"added": added, "skipped": skipped}, "rows": applied}


# ── template ────────────────────────────────────────────────────────

def build_template_csv() -> str:
    return core.build_rows_csv(SAMPLE_ROWS, COLUMNS)


async def build_template_xlsx(db: AsyncSession) -> bytes:
    workers = [_worker_label(p) for p, _ in (await db.execute(_worker_query())).all()]
    jobs = list(await db.scalars(select(Initiative.name).where(
        Initiative.archived_at.is_(None)).order_by(Initiative.name)))
    sites = list(await db.scalars(select(Site.name).where(
        Site.archived_at.is_(None)).order_by(Site.name)))
    return core.build_rows_xlsx(SAMPLE_ROWS, COLUMNS, SHEET, [
        ("Workers", workers), ("Jobs", jobs), ("Sites", sites)])
