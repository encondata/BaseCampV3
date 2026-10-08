# Note and File Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every note and file in a record's Notes & files panel carries a visibility level (Everyone / Internal / Admin) that filters who can read it.

**Architecture:** A `visibility` text column on `notes` and `attachments` (migration 0091, backfilled so nobody gains or loses access). One helper, `access/visibility.py`, maps an actor to the levels they may see and set; one shared host rule, `access/hosts.py::authorize_host_view`, opens non-global reads on every panel host. The notes and attachments routers filter by level, and the portal panel gets a segmented "Visible to" picker plus chips.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, pytest; React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-note-file-visibility-design.md`

## Global Constraints

- Levels are exactly `everyone`, `internal`, `admin`; labels "Everyone", "Internal", "Admin". Default `everyone`.
- `everyone` = anyone who can see the record (clients included); `internal` = actors with `access.is_global`; `admin` = global actors with `access.max_rank >= GATE_BYPASS_RANK` (60, from `serversherpa.access.defaults`).
- Hidden items behave as missing: PATCH/DELETE on an item whose level the actor can't see → 404 `note_not_found` / `attachment_not_found`.
- Setting a level the actor can't see → 403 `visibility_not_allowed`.
- Avatars are always `everyone`; any other level with `kind=avatar` → 422 `visibility_not_supported`.
- Who may write at all is unchanged: host change permission + a global role.
- Migration number **0091**, file `api/migrations/versions/0091_note_file_visibility.py`, `down_revision = "0090"`.
- Backfill: notes on `initiative`/`person`/`client`/`partner` → `internal`; attachments on those four hosts with `kind <> 'avatar'` → `internal`; everything else `everyone`.
- Report-run files saved to an initiative are created `internal`.
- American English in all copy, comments and docs. Never commit `api/src/serversherpa/_dev_reload.py`. Never `git stash`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Reuse portal idioms: `segmented` control (`role="group"`, buttons with `aria-pressed` and class `on`), `chip tag`, `mini-btn`, `page-hint`, `pf-error`.

## How to run things (worktree `.claude/worktrees/note-visibility`)

- API tests (foreground only, one run at a time):
  `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_notevis DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/pytest -q <files>`
- Lint: `cd api && .venv/bin/ruff check src tests`
- Portal: `cd portal && npx vitest run <files>`, `npx tsc -b`, `npm run build`.
- Never point tests at the dev database.

---

### Task 1: Visibility column, models and the level helper

**Files:**
- Create: `api/migrations/versions/0091_note_file_visibility.py`
- Create: `api/src/serversherpa/access/visibility.py`
- Modify: `api/src/serversherpa/db/models.py` (`Attachment` ~L345, `Note` ~L1444)
- Modify: `api/src/serversherpa/api/schemas.py` (`AttachmentOut` ~L413, `NoteOut` ~L1673)
- Test: `api/tests/test_migration_0091_visibility.py`, `api/tests/test_visibility_levels.py`

**Interfaces:**
- Produces: `VISIBILITY_LEVELS: tuple[str, ...]`, `visible_levels(access: AccessInfo) -> tuple[str, ...]`, `can_set_visibility(access: AccessInfo, level: str) -> bool` in `serversherpa.access.visibility`; `Note.visibility`, `Attachment.visibility` (`Mapped[str]`); `NoteOut.visibility: str`, `AttachmentOut.visibility: str`; migration function `backfill_visibility(conn)`.

- [ ] **Step 1: Write the failing tests**

`api/tests/test_visibility_levels.py`:

```python
from serversherpa.access.resolver import AccessInfo
from serversherpa.access.visibility import (
    VISIBILITY_LEVELS, can_set_visibility, visible_levels,
)


def _acc(is_global: bool, rank: int) -> AccessInfo:
    return AccessInfo(is_global=is_global, max_rank=rank,
                      anchors={"global"} if is_global else {"client"})


def test_levels_constant():
    assert VISIBILITY_LEVELS == ("everyone", "internal", "admin")


def test_non_global_sees_everyone_only():
    assert visible_levels(_acc(False, 30)) == ("everyone",)


def test_staff_sees_everyone_and_internal():
    assert visible_levels(_acc(True, 40)) == ("everyone", "internal")


def test_admin_and_up_see_all():
    for rank in (60, 80, 100):
        assert visible_levels(_acc(True, rank)) == VISIBILITY_LEVELS


def test_can_set_matches_visible_levels():
    assert can_set_visibility(_acc(True, 40), "internal")
    assert not can_set_visibility(_acc(True, 40), "admin")
    assert can_set_visibility(_acc(True, 60), "admin")
    assert not can_set_visibility(_acc(True, 60), "secret")
```

`api/tests/test_migration_0091_visibility.py` (same loader pattern as `tests/test_migration_0068_form_factor.py`):

```python
"""Migration 0091: notes/attachments visibility + backfill that keeps
today's effective access (non-physical hosts → internal, avatars stay
everyone)."""

import importlib.util
import uuid
from pathlib import Path

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

MIGRATION_PATH = (Path(__file__).resolve().parents[1] / "migrations" / "versions"
                  / "0091_note_file_visibility.py")


def _load():
    spec = importlib.util.spec_from_file_location("_migration_0091_under_test", MIGRATION_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


async def _note(db, entity_type):
    return await db.scalar(text(
        "INSERT INTO notes (entity_type, entity_id, body) VALUES (:t, :i, 'x') RETURNING id"),
        {"t": entity_type, "i": uuid.uuid4()})


async def _att(db, entity_type, kind):
    return await db.scalar(text(
        "INSERT INTO attachments (entity_type, entity_id, kind, storage_key, filename, "
        "content_type, size_bytes) VALUES (:t, :i, :k, 'k', 'f', 'text/plain', 1) RETURNING id"),
        {"t": entity_type, "i": uuid.uuid4(), "k": kind})


async def test_columns_default_everyone_and_are_checked(db):
    nid = await _note(db, "asset")
    assert await db.scalar(text("SELECT visibility FROM notes WHERE id=:i"), {"i": nid}) == "everyone"
    with pytest.raises(DBAPIError):
        await db.execute(text("UPDATE notes SET visibility='secret' WHERE id=:i"), {"i": nid})
    await db.rollback()
    aid = await _att(db, "asset", "photo")
    with pytest.raises(DBAPIError):
        await db.execute(text("UPDATE attachments SET visibility='nope' WHERE id=:i"), {"i": aid})
    await db.rollback()


async def test_backfill_keeps_todays_access(db):
    m = _load()
    notes = {t: await _note(db, t) for t in
             ("asset", "container", "truck", "site", "initiative", "person", "client", "partner")}
    atts = {
        "asset_photo": await _att(db, "asset", "photo"),
        "site_doc": await _att(db, "site", "document"),
        "initiative_doc": await _att(db, "initiative", "document"),
        "person_doc": await _att(db, "person", "document"),
        "person_avatar": await _att(db, "person", "avatar"),
        "client_logo": await _att(db, "client", "avatar"),
        "partner_doc": await _att(db, "partner", "document"),
        "report_def": await _att(db, "report_definition", "survey_template"),
    }
    await db.commit()
    await db.run_sync(lambda s: m.backfill_visibility(s.connection()))
    await db.commit()

    async def nv(i):
        return await db.scalar(text("SELECT visibility FROM notes WHERE id=:i"), {"i": i})

    async def av(i):
        return await db.scalar(text("SELECT visibility FROM attachments WHERE id=:i"), {"i": i})

    for t in ("asset", "container", "truck", "site"):
        assert await nv(notes[t]) == "everyone"
    for t in ("initiative", "person", "client", "partner"):
        assert await nv(notes[t]) == "internal"
    assert await av(atts["asset_photo"]) == "everyone"
    assert await av(atts["site_doc"]) == "everyone"
    assert await av(atts["initiative_doc"]) == "internal"
    assert await av(atts["person_doc"]) == "internal"
    assert await av(atts["partner_doc"]) == "internal"
    assert await av(atts["person_avatar"]) == "everyone"
    assert await av(atts["client_logo"]) == "everyone"
    assert await av(atts["report_def"]) == "everyone"
```

- [ ] **Step 2: Run them to verify they fail** (module not found / column missing).

- [ ] **Step 3: Write the migration**

```python
"""Note and file visibility — Everyone / Internal / Admin.

Adds `visibility` to notes and attachments (see
docs/superpowers/specs/2026-10-08-note-file-visibility-design.md) and
backfills it so nobody gains or loses access: notes and non-avatar files
on initiatives, people, clients and partners were staff-only before, so
they become `internal`; everything else stays `everyone`.

Revision ID: 0091
Revises: 0090
Create Date: 2026-10-08
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0091"
down_revision: str | None = "0090"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

LEVELS_CHECK = "visibility IN ('everyone', 'internal', 'admin')"
INTERNAL_HOSTS = "('initiative', 'person', 'client', 'partner')"


def backfill_visibility(conn) -> None:
    """Plain function on a raw connection so the test suite can re-run it
    (same convention as 0068's backfill_form_factor)."""
    conn.execute(sa.text(
        f"UPDATE notes SET visibility = 'internal' WHERE entity_type IN {INTERNAL_HOSTS}"))
    conn.execute(sa.text(
        f"UPDATE attachments SET visibility = 'internal' "
        f"WHERE entity_type IN {INTERNAL_HOSTS} AND kind <> 'avatar'"))


def upgrade() -> None:
    for table in ("notes", "attachments"):
        op.add_column(table, sa.Column(
            "visibility", sa.Text(), nullable=False, server_default="everyone"))
        op.create_check_constraint(f"ck_{table}_visibility", table, LEVELS_CHECK)
    backfill_visibility(op.get_bind())


def downgrade() -> None:
    for table in ("notes", "attachments"):
        op.drop_constraint(f"ck_{table}_visibility", table, type_="check")
        op.drop_column(table, "visibility")
```

Check how the test database gets its schema (look at `api/tests/conftest.py`: alembic upgrade vs `Base.metadata.create_all`). If it is built from the models, also declare the check constraint on the models via `__table_args__` (`sa.CheckConstraint(LEVELS_CHECK, name="ck_notes_visibility")`) so the test DB matches; follow whatever existing models with check constraints do (e.g. `AssetModel.form_factor` from 0068).

- [ ] **Step 4: Models, schemas and helper**

In `db/models.py`, add to both `Attachment` and `Note` (after `deleted_at` on Attachment, after `body` on Note):

```python
    # who may read it: everyone / internal / admin (access/visibility.py)
    visibility: Mapped[str] = mapped_column(server_default="everyone")
```

Update the `Note` docstring (it still says only `asset` is wired). In `api/schemas.py` add `visibility: str = "everyone"` to `AttachmentOut` (after `size_bytes`) and `visibility: str` to `NoteOut` (after `body`).

`api/src/serversherpa/access/visibility.py`:

```python
"""Per-item visibility for notes and Notes & files attachments.

    everyone  anyone who can see the host record (clients included)
    internal  global (staff) actors only
    admin     global actors at Admin rank (60) or higher

Spec: docs/superpowers/specs/2026-10-08-note-file-visibility-design.md
"""

from serversherpa.access.defaults import GATE_BYPASS_RANK
from serversherpa.access.resolver import AccessInfo

VISIBILITY_LEVELS: tuple[str, ...] = ("everyone", "internal", "admin")


def visible_levels(access: AccessInfo) -> tuple[str, ...]:
    """The levels this actor may read (and therefore set)."""
    if not access.is_global:
        return ("everyone",)
    if access.max_rank >= GATE_BYPASS_RANK:
        return VISIBILITY_LEVELS
    return ("everyone", "internal")


def can_set_visibility(access: AccessInfo, level: str) -> bool:
    return level in visible_levels(access)
```

Check for an import cycle (`access.resolver` importing `access.defaults` is fine; make sure `defaults` does not import this module).

- [ ] **Step 5: Run the two new test files plus `tests/test_notes_api.py tests/test_attachments.py`** — all pass (existing responses simply gain a field).

- [ ] **Step 6: Commit** — `feat(notes): visibility column on notes and attachments (migration 0091) + level helper`.

---

### Task 2: Shared host rule and notes API visibility

**Files:**
- Create: `api/src/serversherpa/access/hosts.py`
- Modify: `api/src/serversherpa/api/routes/notes.py`
- Modify: `api/src/serversherpa/api/schemas.py` (`NoteCreateIn`, `NoteUpdateIn`)
- Test: `api/tests/test_notes_api.py`, `api/tests/test_initiatives_client_scope.py`, new `api/tests/test_notes_visibility.py`

**Interfaces:**
- Consumes: `visible_levels`, `can_set_visibility`, `VISIBILITY_LEVELS` (Task 1); `Note.visibility`.
- Produces: `serversherpa.access.hosts.NOTE_HOSTS: dict[str, tuple[str, type]]`, `SCOPE_PROBES`, and `async def authorize_host_view(db, actor: AuthContext, entity_type: str, entity_id: uuid.UUID) -> None` (raises `HTTPException` 422 `unknown_entity_type`, 403 `forbidden`, 404 `entity_not_found`; detail shape `{"code": ...}`). Task 3 imports it.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_notes_visibility.py`. Build fixtures with the existing helpers: `login`/`make_login` from `tests/test_assets_api.py`, `client_login`, `partner_login` and `_two_clients_with_initiatives` from `tests/test_initiatives_client_scope.py`, `seeded_user` (staff alice, rank 40). Make an admin with a fresh `Person` + `PersonRole(role="admin")` + `make_login`. Cover:

  1. `POST /notes` without visibility → response `visibility == "everyone"`; audit row `note.add` has `changes["visibility"] == "everyone"`.
  2. Staff `POST` with `"visibility": "admin"` → 403 `visibility_not_allowed`; `"internal"` → 201; `"bogus"` → 422.
  3. Admin creates an Admin note on an initiative; staff `GET /notes` doesn't include it; admin's does; staff `PATCH` and `DELETE` on it → 404 `note_not_found`.
  4. `PATCH` with only `{"visibility": "internal"}` keeps the body and writes a `note.update` audit row with `changes["visibility"] == {"from": "everyone", "to": "internal"}`; `PATCH {}` → 422 `nothing_to_update`; staff `PATCH {"visibility": "admin"}` → 403.
  5. Client user (`client_login` on client A) reads `/notes?entity_type=initiative&entity_id=<A's initiative>` → 200 with only the Everyone note (staff also created an Internal one); B's initiative → 404; `POST` → 403.
  6. Client user reads notes on their own client record (`entity_type=client`, A's id) → 200 Everyone only. Use a role that has `clients:view` (check `access/defaults.py`; `client_owner` does if the old test `test_client_owner_cannot_read_own_org_notes` reached the hard deny).
  7. Asset notes for a client: Internal asset note hidden, Everyone shown.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Create `access/hosts.py`** by moving `NOTE_HOSTS` and `SCOPE_PROBES` out of `routes/notes.py`:

```python
"""The record types that host notes and Notes & files attachments, and the
one read rule both routers share: host resource `view` + the host row
inside the actor's scope (404 outside it)."""

import uuid

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.scope import scope_conditions
from serversherpa.db.models import (
    Asset, Client, Container, Initiative, Partner, Person, Site, Truck,
    WorkerProfile,
)

# entity_type -> (resource id, model) — the permission/scope anchor
NOTE_HOSTS: dict[str, tuple[str, type]] = {  # moved verbatim from routes/notes.py
    ...
}

# (move SCOPE_PROBES and its comment verbatim)


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def authorize_host_view(db: AsyncSession, actor, entity_type: str,
                              entity_id: uuid.UUID) -> None:
    host = NOTE_HOSTS.get(entity_type)
    if host is None:
        raise _err(422, "unknown_entity_type")
    resource, model = host
    if not actor.access.can(resource, "view"):
        raise _err(403, "forbidden")
    row = await db.get(model, entity_id)
    if row is None:
        raise _err(404, "entity_not_found")
    cond = scope_conditions(resource, actor.access, actor.person.id)
    if cond is not None:
        probe = SCOPE_PROBES.get(entity_type)
        query = (probe(entity_id, cond) if probe
                 else select(model.id).where(model.id == entity_id, cond))
        if await db.scalar(query) is None:
            raise _err(404, "entity_not_found")
```

(Keep `actor` untyped or import `AuthContext` under `TYPE_CHECKING` if importing `api.deps` from `access` creates a cycle.)

- [ ] **Step 4: Rework `routes/notes.py`**

- Import `NOTE_HOSTS` and `authorize_host_view` from `access.hosts`; `visible_levels`, `can_set_visibility` from `access.visibility`.
- `_authorize_host(..., action)`: for `"view"` call `authorize_host_view`; for writes keep today's checks (unknown type 422, `can(resource, "change")`, `is_global`, row exists, scope). **Delete** the non-global initiative/person/client/partner deny and rewrite the module docstring to describe the visibility levels instead of that exception.
- `list_notes`: add `Note.visibility.in_(visible_levels(actor.access))`.
- `_get_live_note(db, note_id, actor)`: also 404 `note_not_found` when `note.visibility not in visible_levels(actor.access)`.
- `create_note`: if not `can_set_visibility(...)` → 403 `visibility_not_allowed` (after host authorization); store it; audit `changes={"note_id": ..., "visibility": body.visibility}`.
- `update_note`: `nothing_to_update` 422 when both fields are None; reject a disallowed new level with 403; apply body change and/or visibility change; one `note.update` audit row whose `changes` has `note_id` plus `visibility: {"from", "to"}` when it changed; only touch `updated_by`/`updated_at` when something changed.
- `_out` includes `visibility`.

Schemas:

```python
VisibilityLevel = Literal["everyone", "internal", "admin"]


class NoteCreateIn(BaseModel):
    entity_type: str
    entity_id: uuid.UUID
    body: str = Field(min_length=1)
    visibility: VisibilityLevel = "everyone"
    model_config = ConfigDict(extra="forbid")


class NoteUpdateIn(BaseModel):
    body: str | None = Field(default=None, min_length=1)
    visibility: VisibilityLevel | None = None
    model_config = ConfigDict(extra="forbid")
```

- [ ] **Step 5: Rewrite the old deny tests to the new rule.** In `tests/test_notes_api.py`: `test_client_owner_cannot_read_own_org_notes`, `test_worker_cannot_read_notes_on_own_person`, `test_vendor_admin_cannot_read_own_partner_notes` become "reads only Everyone notes on own record; another org's record still 404/403; still cannot write" (rename them accordingly; if the role lacks the host resource's `view` grant, assert the 403 and say so in the docstring). In `tests/test_initiatives_client_scope.py` replace `test_initiative_notes_internal_only` with `test_initiative_notes_everyone_only` (200, Internal note absent). Keep each test's foreign-org assertion.

- [ ] **Step 6: Run** `tests/test_notes_visibility.py tests/test_notes_api.py tests/test_initiatives_client_scope.py tests/test_visibility_levels.py` and ruff — pass.

- [ ] **Step 7: Commit** — `feat(notes): Everyone / Internal / Admin note visibility; clients read Everyone notes on records they can see`.

---

### Task 3: Attachments API visibility

**Files:**
- Modify: `api/src/serversherpa/api/routes/attachments.py`
- Modify: `api/src/serversherpa/api/schemas.py` (new `AttachmentUpdateIn`)
- Test: new `api/tests/test_attachments_visibility.py`; adjust `api/tests/test_attachments.py` / `api/tests/test_notes_api.py` only where they asserted the old non-global deny.

**Interfaces:**
- Consumes: `authorize_host_view`, `NOTE_HOSTS` (Task 2), `visible_levels`, `can_set_visibility` (Task 1), `VisibilityLevel` Literal from schemas (Task 2).
- Produces: `PATCH /attachments/{attachment_id}` body `{"visibility": level}` → `AttachmentOut`; upload form field `visibility`.

- [ ] **Step 1: Failing tests** (`tests/test_attachments_visibility.py`; storage is already faked in the existing attachment tests — reuse their upload helper/fixtures, check `tests/test_attachments.py` and `tests/test_notes_api.py::test_asset_attachment_upload_and_scoped_view`):

  1. Upload without `visibility` → `everyone`; with `visibility=internal` → `internal`; staff with `admin` → 403 `visibility_not_allowed`; `kind=avatar` with `internal` → 422 `visibility_not_supported`.
  2. List filtering: on one initiative, Everyone + Internal + Admin documents. Admin sees 3, staff 2, client user of that initiative's client sees 1 (previously 403), client of another client → 404.
  3. Asset files: client sees Everyone only.
  4. `PATCH` by staff `everyone → internal` → 200, audit `attachment.update` with `changes == {"filename": <name>, "visibility": {"from": "everyone", "to": "internal"}}`; same level again → 200 and no new audit row; staff `PATCH` to `admin` → 403; staff `PATCH`/`DELETE` of an Admin file → 404 `attachment_not_found`; client `PATCH` → 403 (or 404 if hidden); avatar `PATCH` → 422 `visibility_not_supported`; extra field → 422.
  5. `report_definition` files still need `reports:view` and are listed for staff.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**

- `_authorize`: keep the not-found check, own-avatar bypass and `report_definition` branch first. Then, for `action == "view"` and **non-global** actors: `await authorize_host_view(db, actor, entity_type, entity_id)` and return (this replaces the asset-only branch for non-global actors). For global actors with `action == "view"` on `asset`, keep the `assets:view` rule (no `attachments` grant needed); everything else keeps `attachments:<action>` + the non-global hard deny for writes. Update the comments so they describe the new rule.
- `upload_attachment`: new `visibility: Annotated[VisibilityLevel, Form()] = "everyone"`; after authorization: avatar + not everyone → 422 `visibility_not_supported`; `not can_set_visibility` → 403 `visibility_not_allowed`; store on the row.
- `list_attachments`: add `Attachment.visibility.in_(visible_levels(user.access))`.
- A `_get_live_attachment(db, attachment_id, user)` helper used by DELETE and PATCH: 404 `attachment_not_found` when missing, deleted, or its level is not visible to the actor.
- New route:

```python
@router.patch("/{attachment_id}", response_model=AttachmentOut)
async def update_attachment(
    attachment_id: uuid.UUID, body: AttachmentUpdateIn, user: CurrentUser, db: DbSession,
) -> AttachmentOut:
    att = await _get_live_attachment(db, attachment_id, user)
    await _authorize(db, user, att.entity_type, att.entity_id, "change", att.kind)
    if att.kind == "avatar":
        raise _err(422, "visibility_not_supported")
    if not can_set_visibility(user.access, body.visibility):
        raise _err(403, "visibility_not_allowed")
    if body.visibility != att.visibility:
        audit(db, actor_id=user.person.id, entity_type=att.entity_type,
              entity_id=str(att.entity_id), action="attachment.update",
              changes={"filename": att.filename,
                       "visibility": {"from": att.visibility, "to": body.visibility}})
        att.visibility = body.visibility
        await db.commit()
    return _out(att)
```

Check `attachments` grants include `change` for staff in `access/defaults.py` (FULL); if the action name differs, use the one the matrix defines. Schema:

```python
class AttachmentUpdateIn(BaseModel):
    visibility: VisibilityLevel
    model_config = ConfigDict(extra="forbid")
```

- Update the module docstring with the visibility rule.

- [ ] **Step 4: Run** `tests/test_attachments_visibility.py tests/test_attachments.py tests/test_notes_api.py tests/test_notes_visibility.py tests/test_reports_api.py` + ruff — pass.

- [ ] **Step 5: Commit** — `feat(attachments): per-file visibility, PATCH /attachments/{id}, clients read Everyone files on records they can see`.

---

### Task 4: Report worker and Site Survey photos

**Files:**
- Modify: `api/src/serversherpa/reports/worker.py` (~L130)
- Modify: `api/src/serversherpa/reports/site_move_survey/gather.py` (`_site_photos` ~L105, its call ~L260)
- Test: `api/tests/test_report_worker.py`, `api/tests/test_site_move_survey_gather.py`

**Interfaces:**
- Consumes: `Attachment.visibility` (Task 1), `GATE_BYPASS_RANK`, `ReportRun.requested_rank`.

- [ ] **Step 1: Failing tests**
  - In `test_report_worker.py`, next to the existing `run.attachment_id` assertion: the saved attachment's `visibility == "internal"`.
  - In `test_site_move_survey_gather.py`: a site with one `everyone`, one `internal` and one `admin` photo; a run with `requested_rank=40` gathers 2 photos; `requested_rank=60` gathers 3. Follow how the existing gather tests seed photos and fake `get_object`.

- [ ] **Step 2: Run to verify they fail.**

- [ ] **Step 3: Implement**
  - Worker: pass `visibility="internal"` to the `Attachment(...)` and extend the comment: report files may hold internal data, so they start staff-only; staff can switch one to Everyone in the panel.
  - Gather: `_site_photos(db, site, requested_rank: int)` adds `Attachment.visibility.in_(levels)` where `levels = ("everyone", "internal", "admin") if requested_rank >= GATE_BYPASS_RANK else ("everyone", "internal")` (reports are staff-only, so the requester is always global). Pass `run.requested_rank` at the call site.

- [ ] **Step 4: Run** both test files + `tests/test_site_move_survey_build.py` + ruff — pass.

- [ ] **Step 5: Commit** — `feat(reports): report files start Internal; survey photos respect visibility`.

---

### Task 5: Portal — picker, chips and API client

**Files:**
- Create: `portal/src/lib/visibility.ts`, `portal/src/lib/visibility.test.ts`
- Modify: `portal/src/lib/api.ts` (`AttachmentOut` ~L115, `uploadAttachmentRequest` ~L432, `NoteOut` ~L1971, note/attachment functions ~L2131-2179)
- Modify: `portal/src/components/NotesFilesPanel.tsx`
- Modify: the panel's stylesheet only if the new row needs spacing (find where `.nf-composer` is styled; reuse existing classes first)
- Test: `portal/src/components/NotesFilesPanel.test.tsx`; fix any host-page tests that break because the panel now calls `useAuth` (`pages/InitiativeDetail.test.tsx`, `pages/Initiatives.test.tsx`, others found by running the full suite)

**Interfaces:**
- Consumes: API fields/routes from Tasks 2-3.
- Produces: `Visibility`, `VISIBILITY_LABEL`, `visibilityOptions(isGlobal: boolean, maxRank: number): Visibility[]`; `createNote(entityType, entityId, body, visibility?: Visibility)`; `updateNote(id, patch: { body?: string; visibility?: Visibility })`; `updateAttachment(id, patch: { visibility: Visibility })`; `uploadAttachmentRequest({... , visibility?: Visibility})`.

- [ ] **Step 1: `lib/visibility.ts` + test**

```ts
import { ADMIN_RANK } from './access';

/** Who can read a note or a Notes & files attachment (api access/visibility.py). */
export type Visibility = 'everyone' | 'internal' | 'admin';

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  everyone: 'Everyone', internal: 'Internal', admin: 'Admin',
};

/** The levels this user may choose (and can see): clients only ever see
 *  Everyone; staff add Internal; Admin rank and up add Admin. */
export function visibilityOptions(isGlobal: boolean, maxRank: number): Visibility[] {
  if (!isGlobal) return ['everyone'];
  return maxRank >= ADMIN_RANK ? ['everyone', 'internal', 'admin'] : ['everyone', 'internal'];
}
```

Test the three tiers (non-global, 40, 60, 80).

- [ ] **Step 2: `lib/api.ts`**
  - `visibility: Visibility` on `AttachmentOut` and `NoteOut` (import the type from `./visibility`).
  - `createNote(entityType, entityId, body, visibility: Visibility = 'everyone')` sends `visibility`.
  - `updateNote(id: string, patch: { body?: string; visibility?: Visibility })` sends the patch object. Update every caller (`grep -rn "updateNote(" portal/src`).
  - `uploadAttachmentRequest` accepts optional `visibility` and sets the form field only when given.
  - New:

```ts
export async function updateAttachment(
  id: string, patch: { visibility: Visibility },
): Promise<AttachmentOut> {
  const resp = await apiFetch(`/attachments/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

  - Fix any test fixtures that build `NoteOut`/`AttachmentOut` objects so `tsc -b` passes (add `visibility: 'everyone'`).

- [ ] **Step 3: Panel tests first** (extend `NotesFilesPanel.test.tsx`; mock `../auth/AuthContext` with a mutable `auth = { maxRank, scope }` object, the way `components/HelpButton.test.tsx` mocks `useAuth`; mock `createNote`, `updateNote`, `updateAttachment` alongside the existing mocks):
  1. Writer at rank 40: "Visible to" group shows Everyone (pressed) and Internal, no Admin; the hint "Everyone includes client and partner users who can see this record." is shown.
  2. Writer at rank 60: Admin is offered; choosing Internal then Add note calls `createNote(type, id, body, 'internal')`; Attach file calls `uploadAttachmentRequest` with `visibility: 'internal'`.
  3. Reader (`canWrite=false`): no picker.
  4. Chips: an `internal` note, an `admin` document row and an `internal` image thumbnail show "Internal"/"Admin" chips; an `everyone` item shows none.
  5. Edit note: the edit form's group is preset to the note's level; switching to Internal and Save calls `updateNote(id, { body, visibility: 'internal' })`.
  6. File row "Visibility" button opens the group in that row; clicking Internal calls `updateAttachment(id, { visibility: 'internal' })` and reloads; avatar rows have no "Visibility" button.
  7. A 403 with code `visibility_not_allowed` shows "You can't choose that visibility." (check how `ApiError` exposes the code in `lib/api.ts`).

- [ ] **Step 4: Implement the panel**
  - `const { maxRank, scope } = useAuth();` → `options = visibilityOptions(scope?.global ?? true, maxRank ?? 0)` (matches `AppShell`'s `scope?.global ?? true`).
  - State: `draftVisibility` (default `'everyone'`), `editVisibility`, `visibilityFileId: string | null`.
  - A small local component `VisibilityPicker({ value, options, onChange, label, disabled })` rendering `<div className="segmented" role="group" aria-label={label}>` with one `<button type="button" aria-pressed className={on ? 'on' : ''}>` per option labeled from `VISIBILITY_LABEL`.
  - Composer: a row above the actions with a `Visible to` label + picker (`aria-label="Visible to"`), then `<p className="page-hint">Everyone includes client and partner users who can see this record.</p>`. `addNote` and `upload` pass `draftVisibility`. Keep the chosen level after a save (don't reset it).
  - Chip helper: `const visibilityChip = (v: Visibility) => v === 'everyone' ? null : <span className="chip tag">{VISIBILITY_LABEL[v]}</span>;` placed in the note meta row, in the file row next to the kind chip, and in the thumbnail caption.
  - Note edit: picker preset from the note (`aria-label="Note visibility"`), Save calls `updateNote(id, { body: editBody.trim(), visibility: editVisibility })`.
  - Files (rows and thumbnails, `canWrite` and `kind !== 'avatar'`): a `mini-btn` "Visibility" before Delete toggles `visibilityFileId`; when open, render the picker (`aria-label="File visibility"`) in that row; clicking a level calls `updateAttachment`, closes it and reloads (no call when the level is unchanged).
  - Errors: map `visibility_not_allowed` to "You can't choose that visibility."; otherwise keep the existing messages.
  - Update the component docstring (mention visibility levels).

- [ ] **Step 5: Run** `npx vitest run` (full suite — the panel now needs `useAuth`, so fix host-page tests that render it without an auth mock/provider), `npx tsc -b`, `npm run build`. All pass, including the guardrail tests.

- [ ] **Step 6: Commit** — `feat(portal): Notes & files visibility picker, chips and per-file visibility`.
