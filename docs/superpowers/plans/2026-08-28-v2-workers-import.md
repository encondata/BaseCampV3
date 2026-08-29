# V2 Workers Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One-shot CLI importer that seeds V3 people + worker profiles (and, best-effort, their avatar photos) from the legacy BaseCamp V2 pg_dump.

**Architecture:** A new `serversherpa/people/v2_import.py` module mirroring the existing `sites/v2_import.py` importer: pure parsing/mapping functions on top of the shared `insert_rows`/`parse_values_tuple` INSERT-statement parser, an async `import_workers(db, dump_path, limit)` orchestrator, a best-effort `attach_photos(...)` stage, and a `serversherpa import-v2-workers` Typer command. Additive only: re-runs skip already-imported source_refs and existing emails; the importer never updates or deletes existing rows.

**Tech Stack:** Python 3.12, SQLAlchemy async, Typer CLI, pytest (+ real-Postgres `db` fixture from `api/tests/conftest.py`), boto3 via `serversherpa.services.storage` for V3 object storage.

## Global Constraints

- Dump identity string (source_ref prefix): `backup_20260825_193157` — same constant style as `sites/v2_import.py` `_SOURCE`.
- `Person.source` = `"import"` (the `people_source_check` constraint from migration 0001 only allows `manual`/`import`/`api` — unlike sites, so the sites importer's `"v2_import"` value is NOT legal here; dump provenance lives in `source_ref`), `Person.source_ref` = `f"backup_20260825_193157:people/{v2_id}"` (sites precedent: `.../sites/{v2_id}`).
- **No deletions, no updates to pre-existing rows.** The importer only INSERTs (and sets `avatar_key` on people *it created in the same run*).
- Anything that doesn't map cleanly onto V3 is appended to the person's `notes`, never silently dropped (house rule from `sites/v2_import.py` docstring).
- Workers = dump `people` rows whose `user_type` JSON has `"worker": true` (109 pure workers + 3 user+worker = 112 rows; `"worker": false` and absent are excluded).
- No `UserAccount` rows are created — imported workers must not become portal logins.
- Photos are best-effort: any failure to resolve/fetch/store a photo is counted in stats and never fails the import.
- All commands run from `api/` with the project venv: `../api/.venv` does not exist in the worktree — use `uv run --project .` if configured, else `python -m pytest`. The dev DB for the final run is the MAIN checkout's; unit tests use the docker-compose test Postgres via the existing `db` fixture (conftest refuses to touch DBs not named `serversherpa_test*` — never weaken that).
- V2 dump facts (verified against the real backup): `people` has 124 rows / 56 columns (column list below); `people_status` ∈ {27 Active ×122, 30 Blacklisted ×1, 31 Deleted ×1}; `worker_level` is NULL on all rows (do NOT build a level mapping — YAGNI); `w_work_type` is a JSON dict of boolean flags; `w_resource_partner` is an int FK into the dump's `partners` table `(id, partner_name, partner_services, partner_region, parent_partner)`; `people_work_association` is `(id, person_id, entity_type, entity_id, work_type, site_worked, rating, created_at, updated_at, metadata)`; photos live in `images` `(id, s3_bucket, s3_key, original_filename, file_size, mime_type, width, height, alt_text, created_at, uploaded_by, storage_type, local_path, filename, storage_url, description, updated_at)` joined through `image_associations` `(id, image_id, entity_type, entity_id, association_type, display_order, created_at, is_primary, metadata, updated_at)` with `entity_type = 'people'`.

---

### Task 1: Pure mapping layer (`people/v2_import.py` part 1)

**Files:**
- Create: `api/src/serversherpa/people/__init__.py` (empty)
- Create: `api/src/serversherpa/people/v2_import.py`
- Test: `api/tests/test_people_v2_import.py`

**Interfaces:**
- Consumes: `serversherpa.sites.v2_import.insert_rows(dump_path: str, table: str) -> Iterator[list]` (streams one table's parsed value-lists out of the dump).
- Produces (used by Tasks 2–4):
  - `PEOPLE_COLS: tuple[str, ...]` — the 56 dump column names, in dump order.
  - `people_rows(dump_path: str) -> Iterator[dict]` — people rows as `{col: value}` dicts (rows whose length ≠ len(PEOPLE_COLS) are skipped).
  - `is_worker(row: dict) -> bool`
  - `trade_of(row: dict) -> str | None` — normalized trade string from `w_work_type`.
  - `worker_status(row: dict) -> tuple[str, str | None, bool]` — `(profile_status, status_note, archived)`.
  - `worker_notes(row: dict, work_assocs: list[dict], partner_note: str | None) -> str | None`
  - `SOURCE_REF_PREFIX = "backup_20260825_193157"`

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_people_v2_import.py
"""Pure parsing/mapping helpers of the V2 workers-dump importer."""

from serversherpa.people.v2_import import (
    is_worker, people_rows, trade_of, worker_notes, worker_status,
)


def _row(**over):
    base = {
        "id": 42, "first_name": "Ada", "last_name": "Lovelace",
        "display_name": "", "email_address": "ada@example.com",
        "phone_number": "+1 555 0100", "user_type": '{"worker": true}',
        "people_status": 27, "w_rating": None, "w_locations_available": None,
        "w_resource_partner": None, "w_work_type": None,
        "w_available_to_travel": None, "w_available_international_travel": None,
    }
    base.update(over)
    return base


# ── is_worker ───────────────────────────────────────────────────────

def test_is_worker_true_flag():
    assert is_worker(_row()) is True


def test_is_worker_user_plus_worker():
    assert is_worker(_row(user_type='{"user": true, "worker": true}')) is True


def test_is_worker_false_flag_and_non_worker_types():
    assert is_worker(_row(user_type='{"user": true, "worker": false}')) is False
    assert is_worker(_row(user_type='{"client": true}')) is False
    assert is_worker(_row(user_type=None)) is False
    assert is_worker(_row(user_type="not json")) is False


# ── trade_of ────────────────────────────────────────────────────────

def test_trade_of_normalizes_and_dedupes_flag_keys():
    row = _row(w_work_type='{"cable": true, "Cable": true, '
                           '"project_manager": true, "Hardware": false}')
    assert trade_of(row) == "Cable, Project Manager"


def test_trade_of_empty_and_null():
    assert trade_of(_row(w_work_type="{}")) is None
    assert trade_of(_row(w_work_type=None)) is None
    assert trade_of(_row(w_work_type="broken{")) is None


# ── worker_status ───────────────────────────────────────────────────

def test_worker_status_active():
    assert worker_status(_row(people_status=27)) == ("active", None, False)


def test_worker_status_blacklisted():
    assert worker_status(_row(people_status=30)) == (
        "blacklist", "V2 status: Blacklisted", False)


def test_worker_status_deleted_imports_archived():
    assert worker_status(_row(people_status=31)) == (
        "standby", "V2 status: Deleted", True)


def test_worker_status_unknown_defaults_active_with_note():
    assert worker_status(_row(people_status=99)) == (
        "active", "V2 status: unknown (99)", False)
    assert worker_status(_row(people_status=None)) == ("active", None, False)


# ── worker_notes ────────────────────────────────────────────────────

def test_worker_notes_collects_leftovers_and_history():
    row = _row(w_rating=3.5, w_locations_available="Vegas",
               w_available_to_travel=1, w_available_international_travel=None)
    assocs = [{"entity_type": "Project", "entity_id": 3,
               "work_type": "Project Manager",
               "site_worked": "NAP11 - Switch", "rating": 4}]
    notes = worker_notes(row, assocs, partner_note="V2 partner #9 not in dump")
    assert "V2 rating: 3.5" in notes
    assert "V2 locations available: Vegas" in notes
    assert "V2 available to travel: yes" in notes
    assert "V2 partner #9 not in dump" in notes
    assert "V2 work: Project #3 — Project Manager @ NAP11 - Switch (rating 4)" \
        in notes


def test_worker_notes_empty_when_nothing_to_say():
    assert worker_notes(_row(), [], None) is None


# ── people_rows (uses a tiny synthetic dump) ────────────────────────

def test_people_rows_yields_dicts_and_skips_malformed(tmp_path):
    from serversherpa.people.v2_import import PEOPLE_COLS
    good = ", ".join(["1", "'A'", "'B'"] + ["NULL"] * (len(PEOPLE_COLS) - 3))
    dump = tmp_path / "d.sql"
    dump.write_text(
        f"INSERT INTO people ({', '.join(PEOPLE_COLS)}) VALUES ({good});\n"
        "INSERT INTO people (id) VALUES (2);\n"          # malformed: too short
        "INSERT INTO people_timeclock (id) VALUES (3);\n"  # other table
    )
    rows = list(people_rows(str(dump)))
    assert len(rows) == 1
    assert rows[0]["id"] == 1
    assert rows[0]["first_name"] == "A"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && python -m pytest tests/test_people_v2_import.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'serversherpa.people'`

- [ ] **Step 3: Write the implementation**

```python
# api/src/serversherpa/people/__init__.py
```
(empty file)

```python
# api/src/serversherpa/people/v2_import.py
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
from typing import Iterator

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && python -m pytest tests/test_people_v2_import.py -v`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/people api/tests/test_people_v2_import.py
git commit -m "feat(api): V2 workers dump — pure row parsing and mapping"
```

---

### Task 2: DB import orchestrator `import_workers`

**Files:**
- Modify: `api/src/serversherpa/people/v2_import.py` (append)
- Test: `api/tests/test_people_v2_import_orchestration.py`

**Interfaces:**
- Consumes: Task 1 functions; `serversherpa.db.models.Person`, `WorkerProfile`, `Partner`; `insert_rows` for `partners` / `people_work_association` tables.
- Produces:
  - `import_workers(db: AsyncSession, dump_path: str, limit: int) -> dict` — stats dict `{"imported": int, "skipped_existing": int, "skipped_non_worker": int, "malformed": int, "id_map": {v2_id: str(person_uuid)}}`. `id_map` is consumed by Task 3's photo stage (and stripped before audit/stat printing in Task 4).

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_people_v2_import_orchestration.py
"""Orchestration coverage for `import_workers`: DB inserts, partner
matching, idempotent re-runs, and non-worker filtering. Each test writes
its own tiny synthetic dump to tmp_path (sites importer test pattern)."""

from sqlalchemy import select

from serversherpa.db.models import Partner, Person, WorkerProfile
from serversherpa.people.v2_import import PEOPLE_COLS, import_workers


def _person_values(v2_id: int, first: str, last: str, email: str, *,
                   user_type: str = '{"worker": true}', status: int = 27,
                   partner: str = "NULL",
                   work_type: str = "NULL") -> str:
    by_col = {
        "id": str(v2_id), "first_name": f"'{first}'", "last_name": f"'{last}'",
        "display_name": "''", "email_address": f"'{email}'",
        "phone_number": "'+1 555 0100'", "user_type": f"'{user_type}'",
        "people_status": str(status), "w_resource_partner": partner,
        "w_work_type": work_type,
    }
    return ", ".join(by_col.get(c, "NULL") for c in PEOPLE_COLS)


def _dump_text(*people_rows_sql: str, extra: str = "") -> str:
    cols = ", ".join(PEOPLE_COLS)
    body = "".join(
        f"INSERT INTO people ({cols}) VALUES ({row});\n"
        for row in people_rows_sql)
    return body + extra


async def test_imports_worker_with_profile_and_source_ref(tmp_path, db):
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(_person_values(
        7, "Ada", "Lovelace", "ada@example.com",
        work_type="'{\"hardware\": true}'")))
    stats = await import_workers(db, str(dump), limit=10)
    assert stats["imported"] == 1
    person = await db.scalar(select(Person).where(
        Person.source_ref == "backup_20260825_193157:people/7"))
    assert person is not None
    assert person.first_name == "Ada"
    assert person.email == "ada@example.com"
    assert person.source == "import"
    profile = await db.get(WorkerProfile, person.id)
    assert profile is not None
    assert profile.status == "active"
    assert profile.trade == "Hardware"
    assert stats["id_map"] == {7: str(person.id)}


async def test_non_workers_are_skipped(tmp_path, db):
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(1, "Cli", "Ent", "c@example.com",
                       user_type='{"client": true}'),
        _person_values(2, "Off", "Worker", "o@example.com",
                       user_type='{"user": true, "worker": false}'),
    ))
    stats = await import_workers(db, str(dump), limit=10)
    assert stats["imported"] == 0
    assert stats["skipped_non_worker"] == 2


async def test_rerun_and_existing_email_skip(tmp_path, db):
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(7, "Ada", "Lovelace", "ada@example.com")))
    first = await import_workers(db, str(dump), limit=10)
    assert first["imported"] == 1
    again = await import_workers(db, str(dump), limit=10)
    assert again["imported"] == 0
    assert again["skipped_existing"] == 1
    # same email under a different v2 id also skips — no duplicate people
    dump.write_text(_dump_text(
        _person_values(8, "Ada", "L", "ADA@example.com")))
    other = await import_workers(db, str(dump), limit=10)
    assert other["imported"] == 0
    assert other["skipped_existing"] == 1


async def test_partner_match_and_partner_miss_note(tmp_path, db):
    db.add(Partner(name="Capitol North American"))
    await db.flush()
    extra = (
        "INSERT INTO partners (id, partner_name, partner_services, "
        "partner_region, parent_partner) VALUES "
        "(5, 'Capitol North American', NULL, NULL, NULL);\n")
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(1, "Match", "Ed", "m@example.com", partner="5"),
        _person_values(2, "Miss", "Ing", "x@example.com", partner="99"),
        extra=extra,
    ))
    stats = await import_workers(db, str(dump), limit=10)
    assert stats["imported"] == 2
    matched = await db.scalar(select(Person).where(Person.email == "m@example.com"))
    profile = await db.get(WorkerProfile, matched.id)
    partner = await db.scalar(select(Partner))
    assert profile.partner_id == partner.id
    missed = await db.scalar(select(Person).where(Person.email == "x@example.com"))
    assert "V2 partner #99 not in dump" in (missed.notes or "")


async def test_deleted_status_imports_archived(tmp_path, db):
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(3, "Gone", "Person", "g@example.com", status=31)))
    stats = await import_workers(db, str(dump), limit=10)
    assert stats["imported"] == 1
    person = await db.scalar(select(Person).where(Person.email == "g@example.com"))
    assert person.archived_at is not None
    profile = await db.get(WorkerProfile, person.id)
    assert profile.status == "standby"
    assert profile.status_note == "V2 status: Deleted"


async def test_work_associations_land_in_notes(tmp_path, db):
    extra = (
        "INSERT INTO people_work_association (id, person_id, entity_type, "
        "entity_id, work_type, site_worked, rating, created_at, updated_at, "
        "metadata) VALUES (16, 13, 'Project', 3, 'Project Manager', "
        "'NAP11 - Switch', NULL, NULL, NULL, NULL);\n")
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(13, "Hist", "Oric", "h@example.com"), extra=extra))
    await import_workers(db, str(dump), limit=10)
    person = await db.scalar(select(Person).where(Person.email == "h@example.com"))
    assert "V2 work: Project #3 — Project Manager @ NAP11 - Switch" \
        in person.notes


async def test_limit_caps_inserts(tmp_path, db):
    dump = tmp_path / "d.sql"
    dump.write_text(_dump_text(
        _person_values(1, "A", "A", "a@example.com"),
        _person_values(2, "B", "B", "b@example.com"),
    ))
    stats = await import_workers(db, str(dump), limit=1)
    assert stats["imported"] == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && python -m pytest tests/test_people_v2_import_orchestration.py -v`
Expected: FAIL — `ImportError: cannot import name 'import_workers'`

- [ ] **Step 3: Write the implementation (append to `people/v2_import.py`)**

```python
# append to imports at top of api/src/serversherpa/people/v2_import.py
from collections import defaultdict
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Partner, Person, WorkerProfile

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
    raw_count = sum(1 for _ in insert_rows(dump_path, "people"))
    parsed_count = 0

    for row in people_rows(dump_path):
        parsed_count += 1
        if stats["imported"] >= limit:
            break
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

    stats["malformed"] = raw_count - parsed_count if raw_count > parsed_count \
        else 0
    return stats
```

Note: `Person.last_name` is non-nullable but empty string is fine; the
`first`/`last` fallbacks only guard the fully-nameless case.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && python -m pytest tests/test_people_v2_import_orchestration.py tests/test_people_v2_import.py -v`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/people/v2_import.py api/tests/test_people_v2_import_orchestration.py
git commit -m "feat(api): import V2 worker people + profiles from dump"
```

---

### Task 3: Best-effort photo attachment

**Files:**
- Modify: `api/src/serversherpa/people/v2_import.py` (append)
- Test: `api/tests/test_people_v2_import_photos.py`

**Interfaces:**
- Consumes: Task 2's `id_map` (`{v2_person_id: str(uuid)}`); `serversherpa.services.storage.put_object`; dump tables `images` / `image_associations`.
- Produces:
  - `choose_avatars(dump_path: str) -> dict[int, dict]` — v2 person id → the single chosen `images` row (joined dict), preferring `is_primary`, then lowest `display_order`, then highest image id.
  - `attach_photos(db, dump_path, id_map, local_dirs: list[str], s3_get: Callable[[str], bytes | None] | None) -> dict` — stats `{"photos_attached": int, "photos_unresolved": int}`. Never raises for a single photo; failures count as unresolved.
  - `spaces_getter_from_env(env_path: str) -> Callable[[str], bytes | None] | None` — builds a boto3 download callable from a V2 `.env` file's `DO_SPACES_*` keys; returns None when the file/keys are missing. (Task 4 wires it to the CLI.)

- [ ] **Step 1: Write the failing tests**

```python
# api/tests/test_people_v2_import_photos.py
"""Photo stage of the V2 workers importer: avatar choice, byte
resolution (local dir, injected S3 getter), storage + Attachment writes.
Object storage is monkeypatched — no MinIO round-trips."""

from sqlalchemy import select

from serversherpa.db.models import Attachment, Person
import serversherpa.people.v2_import as v2i
from serversherpa.people.v2_import import attach_photos, choose_avatars

_IMG_COLS = ("id, s3_bucket, s3_key, original_filename, file_size, "
             "mime_type, width, height, alt_text, created_at, uploaded_by, "
             "storage_type, local_path, filename, storage_url, description, "
             "updated_at")
_ASSOC_COLS = ("id, image_id, entity_type, entity_id, association_type, "
               "display_order, created_at, is_primary, metadata, updated_at")


def _dump(tmp_path, images: list[str], assocs: list[str]) -> str:
    text = "".join(
        f"INSERT INTO images ({_IMG_COLS}) VALUES ({v});\n" for v in images
    ) + "".join(
        f"INSERT INTO image_associations ({_ASSOC_COLS}) VALUES ({v});\n"
        for v in assocs)
    p = tmp_path / "d.sql"
    p.write_text(text)
    return str(p)


def _img(id_, *, storage="local", filename="'a.jpg'", s3_key="NULL",
         mime="'image/jpeg'") -> str:
    return (f"{id_}, NULL, {s3_key}, 'orig.jpg', 100, {mime}, NULL, NULL, "
            f"NULL, NULL, NULL, '{storage}', NULL, {filename}, NULL, NULL, "
            "NULL")


def _assoc(id_, image_id, person_id, *, primary="FALSE", order=0) -> str:
    return (f"{id_}, {image_id}, 'people', {person_id}, 'default', {order}, "
            f"NULL, {primary}, NULL, NULL")


def test_choose_avatars_prefers_primary_then_order(tmp_path):
    dump = _dump(
        tmp_path,
        images=[_img(1), _img(2), _img(3)],
        assocs=[_assoc(10, 1, 5, order=1),
                _assoc(11, 2, 5, primary="TRUE", order=9),
                _assoc(12, 3, 6, order=0)],
    )
    chosen = choose_avatars(dump)
    assert chosen[5]["id"] == 2      # primary wins over order
    assert chosen[6]["id"] == 3


async def test_attach_photos_local_dir_and_missing(tmp_path, db, monkeypatch):
    person = Person(first_name="Ada", last_name="L")
    db.add(person)
    await db.flush()
    (tmp_path / "imgs").mkdir()
    (tmp_path / "imgs" / "a.jpg").write_bytes(b"\xff\xd8\xffjpegbytes")
    dump = _dump(
        tmp_path,
        images=[_img(1, filename="'a.jpg'"),
                _img(2, filename="'missing.jpg'")],
        assocs=[_assoc(10, 1, 5), _assoc(11, 2, 6)],
    )
    stored: dict[str, bytes] = {}

    async def fake_put(key, data, content_type):
        stored[key] = data

    monkeypatch.setattr(v2i, "put_object", fake_put)
    stats = await attach_photos(
        db, dump, {5: str(person.id), 6: str(person.id)},
        local_dirs=[str(tmp_path / "imgs")], s3_get=None)
    assert stats == {"photos_attached": 1, "photos_unresolved": 1}
    await db.flush()
    att = await db.scalar(select(Attachment).where(
        Attachment.entity_id == person.id))
    assert att.kind == "avatar"
    assert att.content_type == "image/jpeg"
    refreshed = await db.get(Person, person.id)
    assert refreshed.avatar_key == att.storage_key
    assert stored[att.storage_key] == b"\xff\xd8\xffjpegbytes"


async def test_attach_photos_s3_getter_and_failure(tmp_path, db, monkeypatch):
    person = Person(first_name="Bo", last_name="B")
    db.add(person)
    await db.flush()
    dump = _dump(
        tmp_path,
        images=[_img(1, storage="s3", s3_key="'images/x.jpg'",
                     filename="'x.jpg'"),
                _img(2, storage="s3", s3_key="'images/broken.jpg'",
                     filename="'broken.jpg'")],
        assocs=[_assoc(10, 1, 5), _assoc(11, 2, 6)],
    )

    async def fake_put(key, data, content_type):
        pass

    monkeypatch.setattr(v2i, "put_object", fake_put)

    def s3_get(key):
        return b"bytes" if key == "images/x.jpg" else None

    stats = await attach_photos(
        db, dump, {5: str(person.id), 6: str(person.id)},
        local_dirs=[], s3_get=s3_get)
    assert stats == {"photos_attached": 1, "photos_unresolved": 1}


async def test_attach_photos_skips_people_not_in_id_map(tmp_path, db):
    dump = _dump(tmp_path, images=[_img(1)], assocs=[_assoc(10, 1, 5)])
    stats = await attach_photos(db, dump, {}, local_dirs=[], s3_get=None)
    assert stats == {"photos_attached": 0, "photos_unresolved": 0}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd api && python -m pytest tests/test_people_v2_import_photos.py -v`
Expected: FAIL — `ImportError: cannot import name 'attach_photos'`

- [ ] **Step 3: Write the implementation (append to `people/v2_import.py`)**

```python
# append to imports at top of api/src/serversherpa/people/v2_import.py
import uuid
from pathlib import Path
from typing import Callable

from serversherpa.db.models import Attachment
from serversherpa.services.storage import put_object

_IMAGE_COLS = ("id", "s3_bucket", "s3_key", "original_filename", "file_size",
               "mime_type", "width", "height", "alt_text", "created_at",
               "uploaded_by", "storage_type", "local_path", "filename",
               "storage_url", "description", "updated_at")
_IMG_ASSOC_COLS = ("id", "image_id", "entity_type", "entity_id",
                   "association_type", "display_order", "created_at",
                   "is_primary", "metadata", "updated_at")
_EXT = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
        "image/gif": ".gif"}


def choose_avatars(dump_path: str) -> dict[int, dict]:
    """One chosen `images` row per V2 person id: is_primary first, then
    lowest display_order, then highest image id (newest upload)."""
    images = {r["id"]: r
              for r in _table_rows(dump_path, "images", _IMAGE_COLS)
              if r.get("id") is not None}
    best: dict[int, tuple] = {}
    chosen: dict[int, dict] = {}
    for a in _table_rows(dump_path, "image_associations", _IMG_ASSOC_COLS):
        if a.get("entity_type") != "people":
            continue
        img = images.get(a.get("image_id"))
        person = a.get("entity_id")
        if img is None or person is None:
            continue
        primary = str(a.get("is_primary")).upper() == "TRUE" \
            or a.get("is_primary") is True
        order = a.get("display_order")
        rank = (0 if primary else 1,
                order if isinstance(order, (int, float)) else 999,
                -img["id"])
        if person not in best or rank < best[person]:
            best[person] = rank
            chosen[person] = img
    return chosen


def _resolve_bytes(img: dict, local_dirs: list[str],
                   s3_get: Callable[[str], bytes | None] | None,
                   ) -> bytes | None:
    """Best-effort photo bytes: any local dir by filename first, then the
    V2 object store by s3_key. None = unresolved (caller counts it)."""
    for name in (img.get("filename"), img.get("local_path")):
        if not name:
            continue
        base = Path(str(name)).name
        for d in local_dirs:
            candidate = Path(d) / base
            try:
                if candidate.is_file():
                    return candidate.read_bytes()
            except OSError:
                continue
    if s3_get is not None and img.get("s3_key"):
        try:
            return s3_get(str(img["s3_key"]))
        except Exception:       # noqa: BLE001 — best-effort by contract
            return None
    return None


async def attach_photos(
    db: AsyncSession, dump_path: str, id_map: dict[int, str],
    local_dirs: list[str],
    s3_get: Callable[[str], bytes | None] | None,
) -> dict:
    """Store one avatar per just-imported person (id_map keys). Only
    touches people created this run — never replaces an existing avatar."""
    stats = {"photos_attached": 0, "photos_unresolved": 0}
    chosen = choose_avatars(dump_path)
    for v2_id, img in chosen.items():
        person_uuid = id_map.get(v2_id)
        if person_uuid is None:
            continue
        data = _resolve_bytes(img, local_dirs, s3_get)
        if not data:
            stats["photos_unresolved"] += 1
            continue
        content_type = img.get("mime_type") or "image/jpeg"
        ext = _EXT.get(content_type, ".jpg")
        key = f"attachments/person/{person_uuid}/avatar/{uuid.uuid4()}{ext}"
        try:
            await put_object(key, data, content_type)
        except Exception:       # noqa: BLE001 — best-effort by contract
            stats["photos_unresolved"] += 1
            continue
        person = await db.get(Person, uuid.UUID(person_uuid))
        person.avatar_key = key
        db.add(Attachment(
            entity_type="person", entity_id=person.id, kind="avatar",
            storage_key=key,
            filename=str(img.get("original_filename")
                         or img.get("filename") or f"avatar{ext}"),
            content_type=content_type, size_bytes=len(data)))
        stats["photos_attached"] += 1
    return stats


def spaces_getter_from_env(env_path: str,
                           ) -> Callable[[str], bytes | None] | None:
    """Build a download callable for the V2 DigitalOcean Space from a V2
    `.env` file (DO_SPACES_ENDPOINT/REGION/KEY/SECRET/BUCKET). Returns
    None when the file or any key is missing — photos then fall back to
    local dirs only."""
    try:
        text = Path(env_path).read_text()
    except OSError:
        return None
    vals = {}
    for line in text.splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, _, v = line.partition("=")
            vals[k.strip()] = v.strip()
    needed = ("DO_SPACES_ENDPOINT", "DO_SPACES_REGION", "DO_SPACES_KEY",
              "DO_SPACES_SECRET", "DO_SPACES_BUCKET")
    if any(not vals.get(k) for k in needed):
        return None
    import boto3

    client = boto3.client(
        "s3", endpoint_url=vals["DO_SPACES_ENDPOINT"],
        region_name=vals["DO_SPACES_REGION"],
        aws_access_key_id=vals["DO_SPACES_KEY"],
        aws_secret_access_key=vals["DO_SPACES_SECRET"])
    bucket = vals["DO_SPACES_BUCKET"]

    def _get(key: str) -> bytes | None:
        try:
            return client.get_object(Bucket=bucket, Key=key)["Body"].read()
        except Exception:       # noqa: BLE001 — best-effort by contract
            return None

    return _get
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd api && python -m pytest tests/test_people_v2_import_photos.py -v`
Expected: PASS (all)

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/people/v2_import.py api/tests/test_people_v2_import_photos.py
git commit -m "feat(api): best-effort V2 worker avatar import"
```

---

### Task 4: CLI command `import-v2-workers`

**Files:**
- Modify: `api/src/serversherpa/cli.py` (add command after `import_v2_sites`)

**Interfaces:**
- Consumes: `import_workers`, `attach_photos`, `spaces_getter_from_env` from Task 2/3; `audit` from `serversherpa.services.audit`.
- Produces: `serversherpa import-v2-workers --dump PATH [--limit N] [--dry-run] [--photos/--no-photos] [--photos-dir PATH ...] [--spaces-env PATH]`.

- [ ] **Step 1: Add the command (mirror `import_v2_sites` directly above it)**

```python
@app.command()
def import_v2_workers(
    dump: str = typer.Option(..., help="Path to the V2 pg_dump .sql file"),
    limit: int = typer.Option(200, help="Max workers to import this run"),
    dry_run: bool = typer.Option(False, help="Parse and report; write nothing"),
    photos: bool = typer.Option(True, help="Also fetch and attach avatars"),
    photos_dir: list[str] = typer.Option(
        [], help="Local dir(s) searched for photo files by filename"),
    spaces_env: str = typer.Option(
        "", help="V2 .env with DO_SPACES_* creds for S3-stored photos"),
) -> None:
    """Seed worker people (+ profiles, work-history notes, best-effort
    avatars) from a legacy BaseCamp V2 dump. Additive: re-runs skip
    already-imported source_refs and existing emails; never deletes."""

    async def _run() -> None:
        from serversherpa.people.v2_import import (
            attach_photos, import_workers, spaces_getter_from_env)
        from serversherpa.services.audit import audit

        async with get_sessionmaker()() as db:
            stats = await import_workers(db, dump, limit)
            id_map = stats.pop("id_map")
            if photos and not dry_run:
                s3_get = spaces_getter_from_env(spaces_env) \
                    if spaces_env else None
                stats |= await attach_photos(
                    db, dump, id_map, list(photos_dir), s3_get)
            if dry_run:
                await db.rollback()
                typer.secho(f"[dry-run] would import: {stats}", fg="yellow")
            else:
                audit(db, actor_id=None, entity_type="person", entity_id=None,
                      action="import", changes=stats)
                await db.commit()
                typer.secho(f"Imported: {stats}", fg="green")
        await dispose_engine()

    asyncio.run(_run())
```

- [ ] **Step 2: Run the full people-import test files plus a CLI smoke check**

Run: `cd api && python -m pytest tests/test_people_v2_import.py tests/test_people_v2_import_orchestration.py tests/test_people_v2_import_photos.py -v`
Expected: PASS (all)

Run: `cd api && python -c "from serversherpa.cli import app" && python -m serversherpa.cli --help 2>/dev/null | grep -q import-v2-workers && echo OK || python -c "import typer, serversherpa.cli as c; print([cmd.name or cmd.callback.__name__ for cmd in c.app.registered_commands])"`
Expected: `OK` (or the command list containing `import_v2_workers`)

- [ ] **Step 3: Commit**

```bash
git add api/src/serversherpa/cli.py
git commit -m "feat(cli): import-v2-workers command"
```

---

### Task 5: Full-suite verification + real migration run

**Files:** none created — verification/execution only.

- [ ] **Step 1: Run the full API suite (FOREGROUND, one continuous run, timeout 600000ms — never background it)**

Run: `cd api && python -m pytest -x -q`
Expected: all tests pass (≈700; ~5 min against docker-compose test Postgres)

- [ ] **Step 2: Dry-run against the real backup (main checkout's dev DB via the main checkout's venv/.env)**

```bash
/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/serversherpa import-v2-workers \
  --dump /Users/jrh1812/Downloads/backup_20260825_193157.sql --dry-run
```
Expected: `[dry-run] would import: {'imported': ~112, 'skipped_existing': <small>, 'skipped_non_worker': 12, 'malformed': 0}` — investigate any malformed > 0 before the real run. NOTE: the main venv must contain this branch's code — if the main checkout hasn't merged this work, run the worktree code against the dev DB instead (from the worktree: `cd api && SS_ENV hookup per main .env` or simply wait for merge; do not modify the main checkout).

- [ ] **Step 3: Real run with photos**

```bash
/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/serversherpa import-v2-workers \
  --dump /Users/jrh1812/Downloads/backup_20260825_193157.sql \
  --photos-dir "/Users/jrh1812/Developer/BaseCampV2-reference/media/images" \
  --photos-dir "/Users/jrh1812/Developer/BaseCampV2-reference/prod-api-download/uploads" \
  --spaces-env /Users/jrh1812/Developer/BaseCampV2-reference/.env
```
Expected: `Imported: {'imported': ~112, ..., 'photos_attached': <up to 59>, 'photos_unresolved': <rest>}`

- [ ] **Step 4: Verify in the portal**

Open the Workers page (`/people/workers`) in the browser, confirm imported workers appear with trades/partners/notes and (for resolved photos) avatars.

## Self-Review Notes

- All 5 statuses in `_STATUS_MAP` mapped to the V3 worker vocabulary (`active`/`standby`/`blacklist` from migration 0012); Deleted imports as archived person + standby profile — satisfies "no deletions" while not surfacing V2-deleted workers as active.
- `worker_level` mapping deliberately omitted (all 124 rows NULL — YAGNI, noted in Global Constraints).
- Type check: `import_workers` returns `id_map` keyed by the dump's int ids with `str(uuid)` values; `attach_photos` consumes exactly that; the CLI pops `id_map` before printing/auditing stats.
- Photos never block: `_resolve_bytes`/`put_object` failures count as `photos_unresolved`; `spaces_getter_from_env` degrades to None.
- No deletions anywhere: only INSERTs plus `avatar_key` set on same-run people.
