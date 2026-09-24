# Create a move in steps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Bulk Actions wizard at `/bulk/new-move` that collects a move, its From-To assets, crates and trucks over five screens, keeps everything in a server-side draft, and creates it all in one worker transaction.

**Architecture:** A draft is one `import_jobs` row (`kind="move_setup"`, `status="preview"`). New routes under `/bulk/move-setup` edit it. The asset step is an ordinary `move_assets` validate job that has no move. "Create move" queues the draft, and the import worker applies it in one transaction through `imports/move_setup.apply_job`. That transaction creates the initiative, runs `run_import(..., commit=False)`, calls `create_containers` and `create_trucks`, and writes the audits. Progress goes through a second session. Shared pieces are extracted without behavior change: the naming rule, the initiative create rules, container and truck batch creates, the portal's initiative fields, the import review, and the label-tag counter.

**Tech Stack:** FastAPI, SQLAlchemy async and PostgreSQL (JSONB, CITEXT), MinIO object storage, React 18 with TypeScript, react-router 6 (BrowserRouter), vitest and Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-24-move-setup-wizard-design.md`. Read it once. It is binding.

## Global Constraints

- **Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/move-setup` (branch `move-setup-wizard`). Never cd to the main checkout. `.env` and `portal/node_modules` are symlinks.
- **API tests:** `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/move-setup/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_move_setup /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest <files> -v`
  - Always FOREGROUND, as one continuous command with timeout 600000 ms.
  - Never background a run, never start a second pytest, and never end a turn waiting on one.
- **Lint:** `cd …/move-setup/api && /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/ruff check <files>`
- **Portal:** `cd …/move-setup/portal && npx vitest run <files>`, `npx tsc -b`, `npm run build`.
- No migration.
- **Naming:**
  - The convention has exactly one run of `x` (case-insensitive), and the number is zero-padded to the run length.
  - Crates: count 0–500. Trucks: count 0–100. Start ≥ 0.
  - Prefill `CRT-{origin code}-{destination code}-xxx` / `TRK-…`, falling back to `CRT-xxx` / `TRK-xxx` when a code is missing.
  - A code that itself contains an `x` also falls back, because it would add a second run.
- **Naming sentences** (API and portal, word for word):
  - `"Enter a naming convention, like CRT-xxx."`
  - `"Mark the number with a run of x's, like CRT-xxx."`
  - `"Use only one run of x's for the number."`
  - `"The count must be between 0 and {max}."`
  - `"The start number can't be below 0."`
  - Clash: `"These {noun} names already exist: A, B."`, listing the first ten names and then `", and N more"`.
- **Routes:**
  - Prefix `/bulk/move-setup`.
  - Access: `require_bulk_rank` + `initiatives:add` + `containers:add` + `trucks:add` + a global actor.
  - A draft is owner-only; anyone else gets 404 `draft_not_found`.
  - PATCH, DELETE, the uploads and create only while the draft's status is `preview` or `failed`. Anything else is 409 `draft_not_editable`.
- **Draft:**
  - `import_jobs.kind = "move_setup"`, status `preview`, `initiative_id = NULL`, `phase = "preview"`, `filename` = the move name.
  - The payload shape is exactly:

    ```
    {"move": {...}, "assets": {"check_job_id", "filename"} | null,
     "crates": {"convention", "count", "start", "container_type", "tags"} | null,
     "trucks": {"convention", "count", "start"} | null}
    ```

  - Payload is JSONB with no mutation tracking: always reassign `job.payload`.
  - "Untouched" means `COALESCE(progress_at, created_at)`. Every draft write sets `progress_at = now()`.
- **Asset check:**
  - A `move_assets` job with `initiative_id = NULL`, `options.move_setup_id = <draft id>`, phase `validate`.
  - The file is stored at `import-jobs/move-setup/{draft_id}/{job_id}{ext}`.
  - `GET /initiatives/assets/import-jobs/{id}` serves it to its uploader only.
  - `…/commit` and `…/reprocess` answer 409 `check_only`.
- **Create:**
  - One transaction; progress through a second session every 250 units (`move_setup.PROGRESS_EVERY`).
  - `payload = None` on success; the payload is kept on failure.
  - Failure codes, set as `job.error`: `name_taken`, `setup_invalid`, `apply_conflict`, `worker_error`. The sentences go in `job.results = {"reasons": [...]}`.
  - Units are the parsed asset rows plus the crates plus the trucks.
  - Crates are created at the move's origin site with status `available`. Trucks are attached to the move, start at the origin and end at the destination.
- **Sweep:**
  - Delete `move_setup` drafts in `preview`/`failed` that have been untouched for 24 h, along with their unreferenced, non-running check jobs.
  - Mark `asset_bulk_update` jobs still in `preview` after 24 h as `cancelled`, `error="expired"`, `payload=NULL`.
  - Runs at worker start and hourly.
- **Copy:** user-facing strings are sentences in American English. Ruff line length 100.
- **Portal layout:**
  - Header `WizardHeader`: "Bulk Actions" eyebrow, "Step x of 5 · Title", description, and the numbered steps row in the `rgm-steps` look.
  - Footer Back / Skip this step (steps 2–4) / Next.
  - Reuse existing idioms: `pf-form` fields, `ComboBox`, `DataTable`, `mini-btn`/buttons, `set-note`. Never use raw native selects.
- **Portal CSS:** new rules live in `styles/wizard.css` and `styles/moveSetup.css`. They must have no typography properties and no class names containing `row|cell|list|table|chip|mono|head`, which keeps them clear of the list-typography guardrail (`styles/listTypography.test.ts`).
- **Extracted shared components** must leave `InitiativeEditModal`, `ImportMoveAssets`, `BulkContainersModal` and `/containers/bulk` behaving and looking exactly as before, with their tests unchanged and passing.
- **Commits:** trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit `api/src/serversherpa/_dev_reload.py`.

## File map

| File | Responsibility |
|---|---|
| `api/src/serversherpa/imports/naming.py` (new) | The convention rule: parse, generate, sentences |
| `api/src/serversherpa/imports/move_assets.py` | `run_import(..., commit=True, progress_every=None)` |
| `api/src/serversherpa/services/initiatives.py` (new) | `next_color`, `ref_problem`, `create_initiative_row`, the field lists and palette |
| `api/src/serversherpa/logistics/bulk_create.py` (new) | `create_containers` and its checks (moved out of `POST /containers/bulk`) |
| `api/src/serversherpa/trucks/bulk_create.py` (new) | `create_trucks`, `find_clashes`, `TRUCK_FIELDS` |
| `api/src/serversherpa/imports/move_setup.py` (new) | Draft payload rules, previews, validation, check jobs, `prepare`/`apply_job` |
| `api/src/serversherpa/api/routes/move_setup.py` (new) | `/bulk/move-setup` routes |
| `api/src/serversherpa/imports/worker.py`, `imports/jobs.py` | `move_setup` dispatch, `sweep_stale`, hourly sweep |
| `portal/src/lib/namingConvention.ts` (new) | The portal mirror of the naming rule |
| `portal/src/lib/moveSetup.ts` (new) | Steps, request bodies, `MOVE_SETUP_ERRORS`, the finish summary |
| `portal/src/lib/useLeaveGuard.ts` (new) | Holds in-app link clicks and prompts on reload while a draft is open |
| `portal/src/components/common/WizardHeader.tsx`, `WizardFooter.tsx` (new) | The wizard's chrome |
| `portal/src/components/initiatives/InitiativeFields.tsx` (new) | The fields from `InitiativeEditModal` |
| `portal/src/components/imports/ImportUploadFields.tsx`, `ImportProgress.tsx`, `ImportReport.tsx` (new) | The review pieces from `ImportMoveAssets` |
| `portal/src/components/containers/LabelTagCounts.tsx` (new) | The label-tag steppers from `BulkContainersModal` |
| `portal/src/components/moveSetup/*` (new) | `MoveStep`, `AssetsStep`, `NamingConvention`, `CratesStep`, `TrucksStep`, `ReviewStep`, `MoveSetupFinish`, `DiscardDialog`, `useSkip` |
| `portal/src/pages/BulkNewMove.tsx` (new) | The page shell and its step state |

**Spec path adjustment:** the spec names `containers/bulk_create.py`. This repo has no `containers` package; container logic outside the route lives in `logistics/` (`logistics/bulk_import.py` is the container importer). The service therefore goes in `logistics/bulk_create.py`.

---

### Task 1: API building blocks — naming rule, `run_import(commit=False)`, initiative rules, container and truck batch creates

Five small parts, each with its own commit. Together they give Task 2 and Task 3 everything they call.

**Files:**
- Create: `api/src/serversherpa/imports/naming.py`, `api/tests/test_naming.py`
- Modify: `api/src/serversherpa/imports/move_assets.py` (`run_import`), `api/tests/test_move_asset_import_commit.py` (append two tests)
- Create: `api/src/serversherpa/services/initiatives.py`, `api/tests/test_initiative_service.py`
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (lines 47–74, 118–130, 382–436)
- Create: `api/src/serversherpa/logistics/bulk_create.py`, `api/tests/test_containers_bulk_create_service.py`
- Modify: `api/src/serversherpa/api/routes/containers.py` (lines 27–30, 257–312)
- Create: `api/src/serversherpa/trucks/bulk_create.py`, `api/tests/test_trucks_bulk_create_service.py`
- Modify: `api/src/serversherpa/api/routes/trucks.py` (lines 27–31)

**Interfaces:**
- Consumes: nothing new.
- Produces:

```python
# imports/naming.py
CRATE_MAX = 500
TRUCK_MAX = 100
class NamingError(Exception):  # .code: str, .message: str (sentence)
@dataclass(frozen=True)
class Convention: prefix: str; width: int; suffix: str
def parse_convention(text: str) -> Convention                     # raises NamingError
def generate_names(convention: str, count: int, start: int, *, max_count: int) -> list[str]
def clash_sentence(noun: str, names: list[str], limit: int = 10) -> str

# imports/move_assets.py
async def run_import(db, *, initiative_id, added_by, rows, make_model_mode="fuzzy", write,
                     source_label="", progress=None, is_cancelled=None,
                     commit: bool = True, progress_every: int | None = None) -> dict

# services/initiatives.py
PARTNER_FIELDS: tuple[str, ...]; SITE_FIELDS: tuple[str, ...]
INITIATIVE_FIELDS: list[str]; INITIATIVE_PALETTE: list[str]
async def next_color(db) -> str
async def ref_problem(db, data: dict) -> tuple[str, dict] | None   # typed values (UUIDs)
async def create_initiative_row(db, data: dict, actor_id: uuid.UUID | None) -> Initiative
    # color from next_color when absent; add, flush, audit "create"; never commits

# logistics/bulk_create.py
CONTAINER_FIELDS: list[str]
class ContainerBulkError(Exception):  # .code, .status (422), .extra dict
def check_tags(tags: dict[str, int], count: int) -> None           # bad_tag_key / tags_exceed_count
async def check_vocab(db, container_type: str, status: str | None) -> None  # bad_container_type / bad_status
async def find_clashes(db, names: list[str]) -> list[str]          # non-archived, case-insensitive
def tag_assignments(count: int, tags: dict[str, int]) -> list[str | None]
async def create_containers(db, *, names: list[str], container_type: str, status: str | None,
                            site_id, initiative_id, tags: dict[str, int],
                            actor_id) -> list[Container]            # flush + audits; never commits

# trucks/bulk_create.py
TRUCK_FIELDS: list[str]
class TruckBulkError(Exception):  # .code == "name_collision", .names: list[str]
async def find_clashes(db, names: list[str]) -> list[str]          # non-archived, case-insensitive
async def create_trucks(db, names, initiative_id, start_site_id, end_site_id, actor) -> list[Truck]
```

#### 1a — naming rule

- [ ] **Step 1: Write the failing test** `api/tests/test_naming.py`:

```python
"""The naming-convention rule shared by Create a move in steps' crates and
trucks (and mirrored by portal/src/lib/namingConvention.ts)."""

import pytest

from serversherpa.imports.naming import (
    CRATE_MAX, TRUCK_MAX, Convention, NamingError, clash_sentence, generate_names,
    parse_convention,
)


def test_parse_splits_prefix_run_and_suffix():
    assert parse_convention("CRT-SJC-DAL-xxx") == Convention("CRT-SJC-DAL-", 3, "")
    assert parse_convention("  A-XX-B ") == Convention("A-", 2, "-B")


@pytest.mark.parametrize(("text", "code", "message"), [
    ("", "convention_required", "Enter a naming convention, like CRT-xxx."),
    ("   ", "convention_required", "Enter a naming convention, like CRT-xxx."),
    ("CRT-001", "no_number", "Mark the number with a run of x's, like CRT-xxx."),
    ("BOX-xxx", "many_numbers", "Use only one run of x's for the number."),
    ("xx-XX", "many_numbers", "Use only one run of x's for the number."),
])
def test_parse_errors_are_sentences(text, code, message):
    with pytest.raises(NamingError) as exc:
        parse_convention(text)
    assert exc.value.code == code
    assert exc.value.message == message


def test_generate_pads_to_the_run_and_never_truncates():
    assert generate_names("CRT-xxx", 3, 1, max_count=CRATE_MAX) == [
        "CRT-001", "CRT-002", "CRT-003"]
    assert generate_names("T-x-B", 3, 9, max_count=TRUCK_MAX) == ["T-9-B", "T-10-B", "T-11-B"]
    assert generate_names("CRT-xx", 1, 1234, max_count=CRATE_MAX) == ["CRT-1234"]
    assert generate_names("CRT-xxx", 0, 1, max_count=CRATE_MAX) == []


@pytest.mark.parametrize(("count", "start", "max_count", "message"), [
    (501, 1, CRATE_MAX, "The count must be between 0 and 500."),
    (-1, 1, CRATE_MAX, "The count must be between 0 and 500."),
    (101, 1, TRUCK_MAX, "The count must be between 0 and 100."),
    (3, -1, CRATE_MAX, "The start number can't be below 0."),
])
def test_generate_range_errors(count, start, max_count, message):
    with pytest.raises(NamingError) as exc:
        generate_names("CRT-xxx", count, start, max_count=max_count)
    assert exc.value.message == message


def test_convention_is_checked_before_the_count():
    with pytest.raises(NamingError) as exc:
        generate_names("CRT", 999, -5, max_count=CRATE_MAX)
    assert exc.value.code == "no_number"


def test_clash_sentence_lists_ten_then_counts_the_rest():
    assert clash_sentence("crate", ["A", "B"]) == "These crate names already exist: A, B."
    names = [f"T-{n}" for n in range(12)]
    assert clash_sentence("truck", names) == (
        "These truck names already exist: T-0, T-1, T-2, T-3, T-4, T-5, T-6, T-7, T-8, T-9, "
        "and 2 more.")
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/move-setup/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_move_setup /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest tests/test_naming.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'serversherpa.imports.naming'`.

- [ ] **Step 3: Implement** `api/src/serversherpa/imports/naming.py`:

```python
"""Naming conventions for records created in numbered batches (Bulk Actions ›
Create a move in steps: crates and trucks).

A convention is literal text holding exactly one run of the letter x (either
case) that marks the number: `CRT-SJC-DAL-xxx` → CRT-SJC-DAL-001, 002, …
The run's length is the zero-padding; a longer number is never truncated.
Names are start + i for i in 0 … count-1. The portal mirrors this rule and
every sentence below in portal/src/lib/namingConvention.ts — change both."""

import re
from dataclasses import dataclass

X_RUN = re.compile(r"[xX]+")
CRATE_MAX = 500
TRUCK_MAX = 100


class NamingError(Exception):
    """A convention, count or start the rule rejects; `message` is the
    sentence shown to the user."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class Convention:
    prefix: str
    width: int
    suffix: str


def parse_convention(text: str) -> Convention:
    value = (text or "").strip()
    if not value:
        raise NamingError("convention_required", "Enter a naming convention, like CRT-xxx.")
    runs = list(X_RUN.finditer(value))
    if not runs:
        raise NamingError("no_number", "Mark the number with a run of x's, like CRT-xxx.")
    if len(runs) > 1:
        raise NamingError("many_numbers", "Use only one run of x's for the number.")
    run = runs[0]
    return Convention(prefix=value[:run.start()], width=run.end() - run.start(),
                      suffix=value[run.end():])


def generate_names(convention: str, count: int, start: int, *, max_count: int) -> list[str]:
    """Every name the batch would create, in creation order. Checks the
    convention first, then the count, then the start."""
    rule = parse_convention(convention)
    if count < 0 or count > max_count:
        raise NamingError("count_range", f"The count must be between 0 and {max_count}.")
    if start < 0:
        raise NamingError("start_negative", "The start number can't be below 0.")
    return [f"{rule.prefix}{str(start + i).zfill(rule.width)}{rule.suffix}"
            for i in range(count)]


def clash_sentence(noun: str, names: list[str], limit: int = 10) -> str:
    shown = ", ".join(names[:limit])
    more = f", and {len(names) - limit} more" if len(names) > limit else ""
    return f"These {noun} names already exist: {shown}{more}."
```

- [ ] **Step 4: Run the test and confirm it passes.** Same command. Expected: all PASS.
- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/imports/naming.py api/tests/test_naming.py
git commit -m "$(printf 'feat(api): naming-convention rule for numbered batches\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>')"
```

#### 1b — `run_import(commit=False, progress_every=…)`

- [ ] **Step 1: Write the failing tests.** Append to `api/tests/test_move_asset_import_commit.py`, which already imports `func`, `select`, `move_assets`, `run_import`, `Asset` and `InitiativeAsset`, and defines `_move` and `_row`:

```python
async def test_commit_false_never_commits_and_rolls_back_cleanly(db, monkeypatch):
    """The move-setup worker owns the transaction: with commit=False the
    pipeline flushes but never commits — not per batch, not at the end."""
    from serversherpa.db.engine import get_sessionmaker

    monkeypatch.setattr(move_assets, "BATCH_SIZE", 2)
    ini = await _move(db)
    await db.commit()
    commits = 0
    real_commit = db.commit

    async def counting_commit():
        nonlocal commits
        commits += 1
        await real_commit()

    monkeypatch.setattr(db, "commit", counting_commit)
    seen = []

    async def progress(processed, created, updated, errors):
        seen.append(processed)

    rows = [_row(n, serial_number=f"SN-{n}") for n in range(2, 7)]      # 5 rows
    result = await run_import(db, initiative_id=ini.id, added_by=None, rows=rows,
                              write=True, progress=progress, commit=False)
    assert commits == 0
    assert result["summary"]["created"] == 5
    assert seen == [2, 4, 5]                      # batch boundaries, then the final call
    assert await db.scalar(select(func.count()).select_from(InitiativeAsset)) == 5
    await db.rollback()
    async with get_sessionmaker()() as other:
        assert await other.scalar(select(func.count()).select_from(Asset)) == 0


async def test_progress_every_overrides_the_batch_size(db):
    ini = await _move(db)
    seen = []

    async def progress(processed, created, updated, errors):
        seen.append(processed)

    rows = [_row(n, serial_number=f"SN-{n}") for n in range(2, 8)]      # 6 rows
    await run_import(db, initiative_id=ini.id, added_by=None, rows=rows, write=True,
                     progress=progress, commit=False, progress_every=2)
    assert seen == [2, 4, 6, 6]
```

- [ ] **Step 2: Run the file and confirm the new tests fail** with `TypeError: run_import() got an unexpected keyword argument 'commit'`.
- [ ] **Step 3: Implement.** In `run_import`, add two keyword parameters after `is_cancelled`:

```python
    is_cancelled: CancelledFn | None = None,
    commit: bool = True,
    progress_every: int | None = None,
) -> dict:
```

Append to the docstring: `commit=False leaves every commit to the caller (the move-setup worker runs the whole create in one transaction); progress still fires at each boundary. progress_every overrides BATCH_SIZE as that boundary.`

Replace the row loop and the tail:

```python
    every = progress_every or BATCH_SIZE       # read at call time: tests patch BATCH_SIZE
    for r in rows:
        processed += 1
        await _one_row(r)
        if write and processed % every == 0:
            if progress is not None:
                await progress(processed, created, updated, errors)
            if commit:
                await db.commit()
            if is_cancelled is not None and await is_cancelled():
                cancelled = True
                break
```

```python
    if write:
        if progress is not None:
            await progress(processed, created, updated, errors)
        if commit:
            await db.commit()
    return {"summary": summary, "details": details, "cancelled": cancelled}
```

- [ ] **Step 4: Run the move-asset suites unchanged, plus the new tests:** `tests/test_move_asset_import_commit.py tests/test_move_asset_import_validate.py tests/test_move_asset_import_rows.py tests/test_import_worker.py tests/test_import_reprocess_pipeline.py`. Expected: all PASS.
- [ ] **Step 5: Commit** `feat(api): run_import can leave the commit to its caller` (same trailer).

#### 1c — initiative create rules move into `services/initiatives.py`

- [ ] **Step 1: Write the failing test** `api/tests/test_initiative_service.py`:

```python
"""services/initiatives — the create rules POST /initiatives and Create a
move in steps share."""

import uuid

from sqlalchemy import select

from serversherpa.db.models import AuditLog, Site
from serversherpa.services.initiatives import (
    INITIATIVE_PALETTE, create_initiative_row, next_color, ref_problem,
)


async def test_create_initiative_row_assigns_a_color_and_audits(db):
    ini = await create_initiative_row(
        db, {"name": "Move A", "initiative_type": "move"}, None)
    assert ini.color == INITIATIVE_PALETTE[0]
    assert ini.status == "planned"
    [row] = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "initiative", AuditLog.action == "create"))).all()
    assert row.entity_id == str(ini.id)
    assert row.changes["name"] == {"from": None, "to": "Move A"}
    assert await next_color(db) == INITIATIVE_PALETTE[1]


async def test_create_initiative_row_keeps_an_explicit_color(db):
    ini = await create_initiative_row(
        db, {"name": "B", "initiative_type": "move", "color": "#123456"}, None)
    assert ini.color == "#123456"


async def test_ref_problem_names_the_failing_field(db):
    site = Site(name="DC")
    db.add(site)
    await db.commit()
    assert await ref_problem(db, {"origin_site_id": site.id}) is None
    assert await ref_problem(db, {"destination_site_id": uuid.uuid4()}) == (
        "site_not_found", {"field": "destination_site_id"})
    assert await ref_problem(db, {"status": "nope"}) == ("unknown_status", {})
    assert await ref_problem(db, {"shipping_types": ["truck", "boat"]}) == (
        "unknown_shipping_type", {"values": ["boat"]})
```

- [ ] **Step 2: Run it and confirm it fails** with `ModuleNotFoundError: No module named 'serversherpa.services.initiatives'`.
- [ ] **Step 3: Implement.** Create `api/src/serversherpa/services/initiatives.py`:
  - Move `PARTNER_FIELDS`, `SITE_FIELDS`, `INITIATIVE_FIELDS` and `INITIATIVE_PALETTE` into it verbatim, with the palette's comment. They are at `routes/initiatives.py` lines 47–74.
  - Then add the functions below. `ref_problem` is `_check_refs` with `return` in place of `raise`, and `create_initiative_row` is the body of `create_initiative` from `Initiative(**data…)` through the audit.

```python
"""Initiative creation rules shared by POST /initiatives and Bulk Actions ›
Create a move in steps (its draft routes validate with ref_problem; the
import worker creates the move with create_initiative_row inside the job's
own transaction). Pure of HTTP: a problem comes back as (code, extra)."""

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Client, Initiative, Partner, Site, StatusValue
from serversherpa.services.audit import audit, snapshot

# PARTNER_FIELDS, SITE_FIELDS, INITIATIVE_FIELDS, INITIATIVE_PALETTE — moved
# verbatim from api/routes/initiatives.py (keep the palette's comment).


async def next_color(db: AsyncSession) -> str:
    """The palette color held by the fewest UNARCHIVED initiatives, ties
    broken by palette order (see INITIATIVE_PALETTE)."""
    counts = dict((await db.execute(
        select(Initiative.color, func.count())
        .where(Initiative.archived_at.is_(None),
               Initiative.color.in_(INITIATIVE_PALETTE))
        .group_by(Initiative.color)
    )).all())
    return min(INITIATIVE_PALETTE, key=lambda c: counts.get(c, 0))


async def ref_problem(db: AsyncSession, data: dict) -> tuple[str, dict] | None:
    """The first reference in `data` that does not resolve, as the same
    (code, extra) POST /initiatives answers 422 with; None when all do."""
    if data.get("client_id") is not None and \
            await db.get(Client, data["client_id"]) is None:
        return "client_not_found", {}
    for field in SITE_FIELDS:
        if data.get(field) is not None and await db.get(Site, data[field]) is None:
            return "site_not_found", {"field": field}
    for field in PARTNER_FIELDS:
        if data.get(field) is not None and await db.get(Partner, data[field]) is None:
            return "partner_not_found", {"field": field}
    for field, record_type, code in (
        ("status", "initiative", "unknown_status"),
        ("initiative_type", "initiative_type", "unknown_initiative_type"),
        ("sub_type", "initiative_sub_type", "unknown_sub_type"),
    ):
        if data.get(field) is not None and await db.scalar(
            select(StatusValue).where(StatusValue.record_type == record_type,
                                      StatusValue.key == data[field])) is None:
            return code, {}
    if data.get("shipping_types"):
        keys = set(await db.scalars(select(StatusValue.key).where(
            StatusValue.record_type == "shipping_type")))
        if unknown := [s for s in data["shipping_types"] if s not in keys]:
            return "unknown_shipping_type", {"values": unknown}
    return None


async def create_initiative_row(db: AsyncSession, data: dict,
                                actor_id: uuid.UUID | None) -> Initiative:
    """Insert one initiative from already-validated fields and write its
    create audit. An omitted color takes next_color ("auto select a unique
    color which can be changed"). Flushes; never commits."""
    data = dict(data)
    if not data.get("color"):
        data["color"] = await next_color(db)
    initiative = Initiative(**data, created_by=actor_id)
    db.add(initiative)
    await db.flush()
    initial = snapshot(initiative, INITIATIVE_FIELDS)
    changes = {field: {"from": None, "to": value}
               for field, value in initial.items() if value not in (None, "", [])}
    audit(db, actor_id=actor_id, entity_type="initiative",
          entity_id=str(initiative.id), action="create", changes=changes)
    return initiative
```

  In `api/routes/initiatives.py`:
  - Delete the four moved constants and `_next_color`.
  - Import `from serversherpa.services.initiatives import SITE_FIELDS, create_initiative_row, next_color, ref_problem` and, on its own line, `from serversherpa.services.initiatives import INITIATIVE_PALETTE  # noqa: F401  (tests import it from here)`.
  - `next_initiative_color` returns `InitiativeNextColorOut(color=await next_color(db))`.
  - `_check_refs` becomes:

```python
async def _check_refs(db: DbSession, data: dict) -> None:
    if problem := await ref_problem(db, data):
        code, extra = problem
        raise _err(422, code, **extra)
```

  `create_initiative` keeps its name check and `_check_refs`, then:

```python
    initiative = await create_initiative_row(db, data, actor.person.id)
    await db.commit()
    return await _detail(db, initiative, actor)
```

- [ ] **Step 4: Run the tests:** `tests/test_initiative_service.py tests/test_initiatives_api.py tests/test_initiatives_client_scope.py tests/test_initiative_links_api.py tests/test_initiative_people_api.py`. Expected: all PASS, with the existing files unchanged. Then run `ruff check src/serversherpa/services/initiatives.py src/serversherpa/api/routes/initiatives.py`.
- [ ] **Step 5: Commit** `refactor(api): initiative create rules move into services/initiatives`.

#### 1d — `create_containers` out of `POST /containers/bulk`

- [ ] **Step 1: Write the failing test** `api/tests/test_containers_bulk_create_service.py`:

```python
"""logistics/bulk_create — the numbered container batch behind POST
/containers/bulk and Create a move in steps' crates."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, Container, Initiative, Site
from serversherpa.logistics.bulk_create import (
    ContainerBulkError, check_tags, check_vocab, create_containers, find_clashes,
)


async def test_creates_tags_and_audits_without_committing(db):
    site = Site(name="DC-1")
    ini = Initiative(name="Move", initiative_type="move", status="planned")
    db.add_all([site, ini])
    await db.commit()
    made = await create_containers(
        db, names=["C-1", "C-2", "C-3"], container_type="pallet", status=None,
        site_id=site.id, initiative_id=ini.id, tags={"vendor": 1, "priority": 1},
        actor_id=None)
    assert [c.name for c in made] == ["C-1", "C-2", "C-3"]
    assert [c.label_tag for c in made] == ["priority", "vendor", None]
    assert {c.status for c in made} == {"available"}
    assert {(c.site_id, c.initiative_id) for c in made} == {(site.id, ini.id)}
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "container", AuditLog.action == "create"))).all()
    assert sorted(a.entity_id for a in audits) == sorted(str(c.id) for c in made)
    await db.rollback()
    assert await db.scalar(select(func.count()).select_from(Container)) == 0


async def test_clashes_are_case_insensitive_and_ignore_archived(db):
    db.add_all([Container(name="c-2"),
                Container(name="C-3", archived_at=datetime.now(UTC))])
    await db.commit()
    assert await find_clashes(db, ["C-1", "C-2", "C-3"]) == ["C-2"]
    with pytest.raises(ContainerBulkError) as exc:
        await create_containers(db, names=["C-1", "C-2"], container_type="pallet",
                                status=None, site_id=None, initiative_id=None,
                                tags={}, actor_id=None)
    assert (exc.value.code, exc.value.extra) == ("name_collision", {"names": ["C-2"]})


async def test_checks_keep_the_route_codes(db):
    with pytest.raises(ContainerBulkError) as exc:
        check_tags({"bogus": 1}, 3)
    assert exc.value.code == "bad_tag_key"
    assert exc.value.extra["allowed"][0] == "priority"
    with pytest.raises(ContainerBulkError) as exc:
        check_tags({"priority": 4}, 3)
    assert exc.value.code == "tags_exceed_count"
    with pytest.raises(ContainerBulkError) as exc:
        await check_vocab(db, "spaceship", None)
    assert exc.value.code == "bad_container_type"
    with pytest.raises(ContainerBulkError) as exc:
        await check_vocab(db, "pallet", "nope")
    assert exc.value.code == "bad_status"
```

- [ ] **Step 2: Run it and confirm it fails** with `ModuleNotFoundError`.
- [ ] **Step 3: Implement** `api/src/serversherpa/logistics/bulk_create.py`:

```python
"""Numbered container batches — the one create path behind POST
/containers/bulk and Create a move in steps' crates. Validates, inserts,
assigns label tags in LABEL_TAG_ASSIGNMENT_ORDER, and writes one create
audit per container (same shape as a single create). Never commits."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Container, StatusValue
from serversherpa.labels.tags import LABEL_TAG_ASSIGNMENT_ORDER, LABEL_TAG_KEYS
from serversherpa.services.audit import audit, snapshot

CONTAINER_FIELDS = [
    "name", "rfid_tag", "container_type", "status", "site_id",
    "initiative_id", "label_tag", "location_detail",
]


class ContainerBulkError(Exception):
    def __init__(self, code: str, status: int = 422, **extra) -> None:
        super().__init__(code)
        self.code = code
        self.status = status
        self.extra = extra


def check_tags(tags: dict[str, int], count: int) -> None:
    for key in tags:
        if key not in LABEL_TAG_KEYS:
            raise ContainerBulkError("bad_tag_key", allowed=list(LABEL_TAG_KEYS))
    if sum(tags.values()) > count:
        raise ContainerBulkError("tags_exceed_count")


async def check_vocab(db: AsyncSession, container_type: str, status: str | None) -> None:
    rows = (await db.execute(
        select(StatusValue.record_type, StatusValue.key).where(
            StatusValue.record_type.in_(("container", "container_type"))))).all()
    if container_type not in {k for rt, k in rows if rt == "container_type"}:
        raise ContainerBulkError("bad_container_type")
    if status is not None and status not in {k for rt, k in rows if rt == "container"}:
        raise ContainerBulkError("bad_status")


async def find_clashes(db: AsyncSession, names: list[str]) -> list[str]:
    """The names (as given) that a non-archived container already holds,
    compared case-insensitively."""
    if not names:
        return []
    existing = {n.lower() for n in await db.scalars(
        select(Container.name).where(Container.name.in_(names),
                                     Container.archived_at.is_(None)))}
    return [name for name in names if name.lower() in existing]


def tag_assignments(count: int, tags: dict[str, int]) -> list[str | None]:
    """Assign tags in LABEL_TAG_ASSIGNMENT_ORDER to the first N created
    rows (by name order); the rest are left untagged."""
    assignments: list[str | None] = [None] * count
    idx = 0
    for key in LABEL_TAG_ASSIGNMENT_ORDER:
        for _ in range(tags.get(key, 0)):
            if idx < count:
                assignments[idx] = key
            idx += 1
    return assignments


async def create_containers(
    db: AsyncSession, *, names: list[str], container_type: str, status: str | None,
    site_id: uuid.UUID | None, initiative_id: uuid.UUID | None, tags: dict[str, int],
    actor_id: uuid.UUID | None,
) -> list[Container]:
    check_tags(tags, len(names))
    await check_vocab(db, container_type, status)
    if clashes := await find_clashes(db, names):
        raise ContainerBulkError("name_collision", names=clashes)
    containers = [
        Container(name=name, container_type=container_type, status=status or "available",
                  site_id=site_id, initiative_id=initiative_id, label_tag=tag,
                  created_by=actor_id)
        for name, tag in zip(names, tag_assignments(len(names), tags), strict=True)]
    db.add_all(containers)
    await db.flush()
    for container in containers:
        initial = snapshot(container, CONTAINER_FIELDS)
        changes = {field: {"from": None, "to": value}
                   for field, value in initial.items() if value not in (None, "")}
        audit(db, actor_id=actor_id, entity_type="container",
              entity_id=str(container.id), action="create", changes=changes)
    return containers
```

  In `api/routes/containers.py`:
  - Delete `CONTAINER_FIELDS` and `_bulk_tag_assignments`.
  - Import `CONTAINER_FIELDS` and `bulk_create` from `serversherpa.logistics`.
  - Rewrite `create_containers_bulk` so the error order stays tags → refs → type/status → overflow → collision:

```python
@router.post("/bulk", response_model=ContainerBulkCreateOut, status_code=201)
async def create_containers_bulk(
    body: ContainerBulkCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("containers", "add"),
) -> ContainerBulkCreateOut:
    try:
        bulk_create.check_tags(body.tags, body.count)
    except bulk_create.ContainerBulkError as exc:
        raise _err(exc.status, exc.code, **exc.extra) from None
    await _check_refs(db, {"site_id": body.site_id, "initiative_id": body.initiative_id})
    try:
        await bulk_create.check_vocab(db, body.container_type, body.status)
    except bulk_create.ContainerBulkError as exc:
        raise _err(exc.status, exc.code, **exc.extra) from None
    if body.naming.start + body.count - 1 > BULK_MAX_NUMBER:
        raise _err(422, "number_overflow", max_number=BULK_MAX_NUMBER)
    try:
        containers = await bulk_create.create_containers(
            db, names=_bulk_names(body.naming, body.count),
            container_type=body.container_type, status=body.status,
            site_id=body.site_id, initiative_id=body.initiative_id,
            tags=body.tags, actor_id=actor.person.id)
    except bulk_create.ContainerBulkError as exc:
        raise _err(exc.status, exc.code, **exc.extra) from None
    await db.commit()

    statuses, types, sites, initiatives, counts = await _context(db, containers)
    return ContainerBulkCreateOut(created=[
        ContainerItem(**_item(c, statuses, types, sites, initiatives, counts))
        for c in containers])
```

- [ ] **Step 4: Run the tests:** `tests/test_containers_bulk_create_service.py tests/test_containers_bulk_create.py tests/test_containers_api.py tests/test_containers_bulk_import.py tests/test_container_label_tag.py`. Expected: all PASS, with `test_containers_bulk_create.py` unchanged. Then run ruff on the two source files.
- [ ] **Step 5: Commit** `refactor(api): POST /containers/bulk creates through logistics/bulk_create`.

#### 1e — `create_trucks`

- [ ] **Step 1: Write the failing test** `api/tests/test_trucks_bulk_create_service.py`:

```python
"""trucks/bulk_create — the numbered truck batch Create a move in steps
uses: attached to the move, origin → destination, one audit per truck."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from serversherpa.db.models import AuditLog, Initiative, Site, Truck
from serversherpa.trucks.bulk_create import TruckBulkError, create_trucks, find_clashes


async def test_create_trucks_attaches_the_move_and_sites(db):
    a, b = Site(name="A"), Site(name="B")
    ini = Initiative(name="Move", initiative_type="move", status="planned")
    db.add_all([a, b, ini])
    await db.commit()
    made = await create_trucks(db, ["T-1", "T-2"], ini.id, a.id, b.id, None)
    assert [(t.name, t.initiative_id, t.start_site_id, t.end_site_id, t.status)
            for t in made] == [("T-1", ini.id, a.id, b.id, "created"),
                               ("T-2", ini.id, a.id, b.id, "created")]
    audits = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "truck", AuditLog.action == "create"))).all()
    assert len(audits) == 2
    assert audits[0].changes["initiative_id"]["to"] == str(ini.id)
    await db.rollback()
    assert await db.scalar(select(func.count()).select_from(Truck)) == 0


async def test_truck_clashes_are_case_insensitive_and_ignore_archived(db):
    db.add_all([Truck(name="t-2"), Truck(name="T-3", archived_at=datetime.now(UTC))])
    await db.commit()
    assert await find_clashes(db, ["T-1", "T-2", "T-3"]) == ["T-2"]
    with pytest.raises(TruckBulkError) as exc:
        await create_trucks(db, ["T-1", "T-2"], None, None, None, None)
    assert exc.value.names == ["T-2"]
    assert await db.scalar(select(func.count()).select_from(Truck)) == 2
```

  `changes["initiative_id"]["to"]` is a string because `services/audit.py::snapshot` serializes UUIDs through `_jsonable`.

- [ ] **Step 2: Run it and confirm it fails** with `ModuleNotFoundError`.
- [ ] **Step 3: Implement** `api/src/serversherpa/trucks/bulk_create.py`:

```python
"""Numbered truck batches for Create a move in steps: every truck is
attached to the move and starts at its origin and ends at its destination;
drivers, loads and tracking are filled in per truck later. One create audit
per truck, the same shape POST /trucks writes. Never commits."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Truck
from serversherpa.services.audit import audit, snapshot

TRUCK_FIELDS = [
    "name", "driver_name", "co_driver_name", "team_drive", "contact_info",
    "status", "load_number", "seal_id", "tracking_type",
    "initiative_id", "start_site_id", "end_site_id",
]


class TruckBulkError(Exception):
    def __init__(self, code: str, names: list[str]) -> None:
        super().__init__(code)
        self.code = code
        self.names = names


async def find_clashes(db: AsyncSession, names: list[str]) -> list[str]:
    if not names:
        return []
    existing = {n.lower() for n in await db.scalars(
        select(Truck.name).where(Truck.name.in_(names), Truck.archived_at.is_(None)))}
    return [name for name in names if name.lower() in existing]


async def create_trucks(
    db: AsyncSession, names: list[str], initiative_id: uuid.UUID | None,
    start_site_id: uuid.UUID | None, end_site_id: uuid.UUID | None,
    actor: uuid.UUID | None,
) -> list[Truck]:
    if clashes := await find_clashes(db, names):
        raise TruckBulkError("name_collision", clashes)
    trucks = [Truck(name=name, status="created", contact_info="", team_drive=False,
                    tracking_type={}, initiative_id=initiative_id,
                    start_site_id=start_site_id, end_site_id=end_site_id, created_by=actor)
              for name in names]
    db.add_all(trucks)
    await db.flush()
    for truck in trucks:
        initial = snapshot(truck, TRUCK_FIELDS)
        changes = {field: {"from": None, "to": value}
                   for field, value in initial.items() if value not in (None, "", {}, False)}
        audit(db, actor_id=actor, entity_type="truck", entity_id=str(truck.id),
              action="create", changes=changes)
    return trucks
```

  In `api/routes/trucks.py`, delete the local `TRUCK_FIELDS` and add `from serversherpa.trucks.bulk_create import TRUCK_FIELDS`.
- [ ] **Step 4: Run the tests:** `tests/test_trucks_bulk_create_service.py tests/test_trucks_api.py tests/test_trucks_bulk_import_api.py`. Expected: all PASS. Then run ruff.
- [ ] **Step 5: Commit** `feat(api): create_trucks — numbered truck batches for a move`.

---

### Task 2: Move-setup service and `/bulk/move-setup` routes

**Files:**
- Create: `api/src/serversherpa/imports/move_setup.py` (the draft half; Task 3 adds the create half)
- Create: `api/src/serversherpa/api/routes/move_setup.py`
- Modify: `api/src/serversherpa/api/schemas.py` (new classes after `ImportJobOut`)
- Modify: `api/src/serversherpa/api/app.py` (import `move_setup` in the routes tuple and `app.include_router(move_setup.router)` after `initiatives.router`)
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (`_get_import_job`, `commit_move_asset_import_job`, `reprocess_move_asset_import_job`)
- Modify: `api/src/serversherpa/db/models.py`. Only the `ImportJob.kind` comment changes, to `'move_assets' | 'asset_bulk_update' | 'move_setup'`.
- Test: `api/tests/test_move_setup_api.py`

**Interfaces:**
- Consumes: everything Task 1 produced.
- Produces:

```python
# api/schemas.py
class MoveSetupMoveIn(InitiativeCreateIn): initiative_type: str = "move"
class MoveSetupCratesIn: convention (max 60), count: int, start: int = 1,
                         container_type: str | None = None, tags: dict[str, int>=0] = {}
class MoveSetupTrucksIn: convention (max 60), count: int, start: int = 1
class MoveSetupPatchIn: move | crates | trucks optional; skip: list[Literal["assets","crates","trucks"]] = []
class MoveSetupNamesOut: names: list[str]; clashes: list[str]; error: str | None
class MoveSetupPreviewsOut: crates: MoveSetupNamesOut | None; trucks: MoveSetupNamesOut | None
class MoveSetupOut: id, status, error, payload: dict | None, initiative_id, total_rows,
                    processed_rows, results: dict | None, created_at, previews: MoveSetupPreviewsOut | None

# imports/move_setup.py (draft half)
KIND = "move_setup"; CHECK_KIND = "move_assets"; EDITABLE = ("preview", "failed")
PROGRESS_EVERY = 250
MOVE_REF_SENTENCES: dict[str, str]; TAG_SENTENCES: dict[str, str]
WORKER_ERROR_MESSAGE: str; CONFLICT_MESSAGE: str; FILE_UNREADABLE: str
def empty_payload(move: dict) -> dict
def typed_move(move: dict) -> dict                    # JSON → typed (UUID/datetime), type "move"
def reopen(job: ImportJob) -> None                    # status preview, error/results None, progress_at now
def crate_names(crates: dict) -> list[str]            # raises NamingError
def truck_names(trucks: dict) -> list[str]            # raises NamingError
async def move_problems(db, move: dict) -> list[str]
async def crate_problems(db, crates: dict) -> list[str]
async def names_preview(db, section: dict | None, *, kind: str) -> dict | None
async def previews(db, payload: dict | None) -> dict
async def check_job(db, payload: dict | None) -> ImportJob | None
def asset_problems(check: ImportJob | None) -> list[str]
async def draft_problems(db, payload: dict) -> tuple[list[str], list[str]]   # (invalid, clashes)
async def new_check(db, draft, *, filename, options, file_key="") -> ImportJob
async def attach_check(db, draft, check) -> None
async def retire_check_jobs(db, draft_id, *, keep: uuid.UUID | None = None) -> None

# routes (JSON shapes the portal relies on — Task 4 types them)
POST   /bulk/move-setup                      body MoveSetupMoveIn → 201 MoveSetupOut
GET    /bulk/move-setup/{id}                                       → MoveSetupOut
PATCH  /bulk/move-setup/{id}                 body MoveSetupPatchIn → MoveSetupOut (with previews)
POST   /bulk/move-setup/{id}/assets          multipart file, make_model_mode, generate_serials → 201 ImportJobOut
POST   /bulk/move-setup/{id}/assets/recheck                        → 201 ImportJobOut
POST   /bulk/move-setup/{id}/create                                → MoveSetupOut (status "queued")
DELETE /bulk/move-setup/{id}                                       → 204
error codes: forbidden(403) draft_not_found(404) draft_not_editable(409) name_required
  origin_required destination_required <ref_problem codes> invalid_naming{message}
  bad_container_type bad_tag_key tags_exceed_count unsupported_file file_too_large empty_file
  invalid_make_model_mode (422) no_asset_file(409) setup_invalid{reasons}(422)
  check_only(409, on /initiatives/assets/import-jobs/{id}/commit|reprocess)
```

- [ ] **Step 1: Write the failing tests** `api/tests/test_move_setup_api.py`. The helpers at the top are imported by Task 3's tests.

```python
"""Bulk Actions › Create a move in steps — the draft routes: gating,
ownership, validation, previews and clashes, skip, the asset check that has
no move, create validation, delete."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, AuditLog, Container, ImportJob, Initiative, PermissionOverride, Person, PersonRole,
    Site, Truck,
)
from serversherpa.imports.worker import run_once
from serversherpa.services.storage import get_object
from tests.test_assets_api import login, make_login

BASE = "/bulk/move-setup"
FT_CSV = b"Serial Number,Asset Name\nSN-M1,web-01\nSN-M2,web-02\n"
CRATES = {"convention": "CRT-SJC-DAL-xxx", "count": 3, "start": 1,
          "container_type": "pallet", "tags": {"priority": 1}}
TRUCKS = {"convention": "TRK-SJC-DAL-xxx", "count": 2, "start": 1}


async def admin_login(db, client, email: str, first: str = "Ada") -> dict:
    person = Person(first_name=first, last_name="Admin", email=email)
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return await make_login(db, client, person, email)


async def make_sites(db) -> tuple[Site, Site]:
    origin = Site(name="San Jose DC", code="SJC")
    destination = Site(name="Dallas DC", code="DAL")
    db.add_all([origin, destination])
    await db.commit()
    return origin, destination


def move_body(origin, destination, **over) -> dict:
    return {"name": "SJC to DAL", "initiative_type": "move",
            "origin_site_id": str(origin.id), "destination_site_id": str(destination.id),
            **over}


async def new_draft(client, hdrs, origin, destination, **over) -> dict:
    resp = await client.post(BASE, headers=hdrs, json=move_body(origin, destination, **over))
    assert resp.status_code == 201, resp.text
    return resp.json()


async def upload_assets(client, hdrs, draft_id, content=FT_CSV, filename="ft.csv"):
    return await client.post(
        f"{BASE}/{draft_id}/assets", headers=hdrs,
        data={"make_model_mode": "fuzzy", "generate_serials": "false"},
        files={"file": (filename, content, "text/csv")})


async def reload(job_id):
    """The row as committed right now (a fresh session, never a stale map)."""
    async with get_sessionmaker()() as fresh:
        return await fresh.get(ImportJob, uuid.UUID(str(job_id)))


@pytest.fixture
async def admin_hdrs(db, client):
    return await admin_login(db, client, "ada@test.example.com")


@pytest.fixture
async def other_admin_hdrs(db, client):
    return await admin_login(db, client, "owen@test.example.com", first="Owen")


async def test_staff_are_forbidden_everywhere(client, db, seeded_user):
    hdrs = await login(client)
    origin, destination = await make_sites(db)
    some = uuid.uuid4()
    assert (await client.post(BASE, headers=hdrs,
                              json=move_body(origin, destination))).status_code == 403
    assert (await client.get(f"{BASE}/{some}", headers=hdrs)).status_code == 403
    assert (await client.patch(f"{BASE}/{some}", headers=hdrs, json={})).status_code == 403
    assert (await upload_assets(client, hdrs, some)).status_code == 403
    assert (await client.post(f"{BASE}/{some}/assets/recheck", headers=hdrs)).status_code == 403
    assert (await client.post(f"{BASE}/{some}/create", headers=hdrs)).status_code == 403
    assert (await client.delete(f"{BASE}/{some}", headers=hdrs)).status_code == 403


async def test_an_admin_without_trucks_add_is_forbidden(client, db):
    person = Person(first_name="Tia", last_name="NoTrucks", email="tia@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    db.add(PermissionOverride(person_id=person.id, resource="trucks", action="add",
                              allow=False))
    await db.commit()
    hdrs = await make_login(db, client, person, "tia@test.example.com")
    origin, destination = await make_sites(db)
    resp = await client.post(BASE, headers=hdrs, json=move_body(origin, destination))
    assert resp.status_code == 403
    assert resp.json()["detail"]["code"] == "forbidden"


async def test_create_draft_stores_the_move_and_writes_nothing_real(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    body = await new_draft(client, admin_hdrs, origin, destination,
                           initiative_type="project", scheduled_start="2026-10-01")
    assert body["status"] == "preview"
    assert body["initiative_id"] is None
    assert body["previews"] is None
    payload = body["payload"]
    assert (payload["assets"], payload["crates"], payload["trucks"]) == (None, None, None)
    assert payload["move"]["initiative_type"] == "move"        # always a move
    assert payload["move"]["name"] == "SJC to DAL"
    assert payload["move"]["origin_site_id"] == str(origin.id)
    job = await reload(body["id"])
    assert (job.kind, job.phase, job.initiative_id) == ("move_setup", "preview", None)
    assert job.progress_at is not None
    assert await db.scalar(select(func.count()).select_from(Initiative)) == 0
    assert await db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.action == "move_setup_draft_create")) == 1


@pytest.mark.parametrize(("over", "code"), [
    ({"name": "   "}, "name_required"),
    ({"origin_site_id": None}, "origin_required"),
    ({"destination_site_id": None}, "destination_required"),
])
async def test_create_draft_requires_a_name_and_both_sites(client, db, admin_hdrs, over, code):
    origin, destination = await make_sites(db)
    resp = await client.post(BASE, headers=admin_hdrs,
                             json=move_body(origin, destination, **over))
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == code


async def test_create_draft_checks_refs_like_a_new_initiative(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    resp = await client.post(BASE, headers=admin_hdrs, json=move_body(
        origin, destination, destination_site_id=str(uuid.uuid4())))
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "site_not_found", "field": "destination_site_id"}


async def test_another_admin_gets_draft_not_found(client, db, admin_hdrs, other_admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    url = f"{BASE}/{draft['id']}"
    for resp in (await client.get(url, headers=other_admin_hdrs),
                 await client.patch(url, headers=other_admin_hdrs, json={}),
                 await upload_assets(client, other_admin_hdrs, draft["id"]),
                 await client.post(f"{url}/create", headers=other_admin_hdrs),
                 await client.delete(url, headers=other_admin_hdrs)):
        assert resp.status_code == 404
        assert resp.json()["detail"]["code"] == "draft_not_found"


async def test_patch_previews_names_and_flags_clashes(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    db.add_all([Container(name="crt-sjc-dal-002"),
                Container(name="CRT-SJC-DAL-003", archived_at=datetime.now(UTC)),
                Truck(name="TRK-SJC-DAL-001"),
                Truck(name="TRK-SJC-DAL-002", archived_at=datetime.now(UTC))])
    await db.commit()
    resp = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                              json={"crates": CRATES, "trucks": TRUCKS})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["previews"]["crates"] == {
        "names": ["CRT-SJC-DAL-001", "CRT-SJC-DAL-002", "CRT-SJC-DAL-003"],
        "clashes": ["CRT-SJC-DAL-002"], "error": None}
    assert body["previews"]["trucks"]["clashes"] == ["TRK-SJC-DAL-001"]
    assert body["payload"]["crates"] == CRATES
    assert body["payload"]["trucks"] == TRUCKS


@pytest.mark.parametrize(("section", "value", "message"), [
    ("crates", {**CRATES, "convention": "CRT-001"},
     "Mark the number with a run of x's, like CRT-xxx."),
    ("crates", {**CRATES, "convention": "BOX-xxx"}, "Use only one run of x's for the number."),
    ("crates", {**CRATES, "count": 501}, "The count must be between 0 and 500."),
    ("crates", {**CRATES, "start": -1}, "The start number can't be below 0."),
    ("trucks", {**TRUCKS, "count": 101}, "The count must be between 0 and 100."),
])
async def test_patch_rejects_a_bad_convention_with_a_sentence(
        client, db, admin_hdrs, section, value, message):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    resp = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                              json={section: value})
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "invalid_naming", "message": message}


@pytest.mark.parametrize(("crates", "code"), [
    ({**CRATES, "container_type": "spaceship"}, "bad_container_type"),
    ({**CRATES, "tags": {"priority": 4}}, "tags_exceed_count"),
    ({**CRATES, "tags": {"gold": 1}}, "bad_tag_key"),
])
async def test_patch_checks_crate_type_and_tags(client, db, admin_hdrs, crates, code):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    resp = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                              json={"crates": crates})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == code


async def test_skip_clears_a_section(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    url = f"{BASE}/{draft['id']}"
    await client.patch(url, headers=admin_hdrs, json={"crates": CRATES})
    resp = await client.patch(url, headers=admin_hdrs, json={"skip": ["crates"]})
    assert resp.status_code == 200
    assert resp.json()["payload"]["crates"] is None
    assert resp.json()["previews"]["crates"] is None


async def test_asset_check_runs_without_a_move(client, db, admin_hdrs, other_admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    resp = await upload_assets(client, admin_hdrs, draft["id"])
    assert resp.status_code == 201, resp.text
    check = resp.json()
    assert (check["kind"], check["initiative_id"]) == ("move_assets", None)
    assert (check["phase"], check["status"]) == ("validate", "queued")
    assert check["options"] == {"make_model_mode": "fuzzy", "generate_serials": False,
                                "move_setup_id": draft["id"]}
    got = (await client.get(f"{BASE}/{draft['id']}", headers=admin_hdrs)).json()
    assert got["payload"]["assets"] == {"check_job_id": check["id"], "filename": "ft.csv"}
    row = await reload(check["id"])
    assert row.file_key.startswith(f"import-jobs/move-setup/{draft['id']}/")
    assert await get_object(row.file_key) == FT_CSV

    poll = f"/initiatives/assets/import-jobs/{check['id']}"
    assert (await client.get(poll, headers=other_admin_hdrs)).status_code == 404
    assert await run_once(get_sessionmaker()) is True
    done = await client.get(poll, headers=admin_hdrs)
    assert done.status_code == 200
    assert done.json()["status"] == "completed"
    assert done.json()["results"]["summary"]["created"] == 2
    for action in ("commit", "reprocess"):
        refused = await client.post(f"{poll}/{action}", headers=admin_hdrs)
        assert refused.status_code == 409
        assert refused.json()["detail"]["code"] == "check_only"
    assert await db.scalar(select(func.count()).select_from(Asset)) == 0


async def test_a_new_upload_replaces_the_previous_check(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    first = (await upload_assets(client, admin_hdrs, draft["id"])).json()
    second = (await upload_assets(client, admin_hdrs, draft["id"], filename="ft2.csv")).json()
    assert await reload(first["id"]) is None
    got = (await client.get(f"{BASE}/{draft['id']}", headers=admin_hdrs)).json()
    assert got["payload"]["assets"] == {"check_job_id": second["id"], "filename": "ft2.csv"}


async def test_recheck_queues_a_new_check_over_the_same_file(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    url = f"{BASE}/{draft['id']}/assets/recheck"
    none_yet = await client.post(url, headers=admin_hdrs)
    assert none_yet.status_code == 409
    assert none_yet.json()["detail"]["code"] == "no_asset_file"
    first = (await upload_assets(client, admin_hdrs, draft["id"])).json()
    assert await run_once(get_sessionmaker()) is True
    again = await client.post(url, headers=admin_hdrs)
    assert again.status_code == 201, again.text
    new = again.json()
    assert new["id"] != first["id"] and new["status"] == "queued"
    assert new["options"]["move_setup_id"] == draft["id"]
    assert await reload(first["id"]) is None
    assert await get_object((await reload(new["id"])).file_key) == FT_CSV


async def test_skipping_assets_removes_the_check(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    check = (await upload_assets(client, admin_hdrs, draft["id"])).json()
    resp = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                              json={"skip": ["assets"]})
    assert resp.json()["payload"]["assets"] is None
    assert await reload(check["id"]) is None


async def test_create_rejects_an_unfinished_asset_check(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    await upload_assets(client, admin_hdrs, draft["id"])               # queued, never run
    resp = await client.post(f"{BASE}/{draft['id']}/create", headers=admin_hdrs)
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "setup_invalid", "reasons": [
        "The From-To file is still being checked. Wait for it to finish, then create the move."]}


async def test_create_rejects_clashes_and_a_missing_crate_type(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    db.add(Truck(name="TRK-SJC-DAL-002"))
    await db.commit()
    await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs, json={
        "crates": {**CRATES, "container_type": None, "tags": {}}, "trucks": TRUCKS})
    resp = await client.post(f"{BASE}/{draft['id']}/create", headers=admin_hdrs)
    assert resp.status_code == 422
    assert resp.json()["detail"]["reasons"] == [
        "Pick a crate type.", "These truck names already exist: TRK-SJC-DAL-002."]


async def test_create_queues_the_draft_and_locks_it(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    url = f"{BASE}/{draft['id']}"
    await client.patch(url, headers=admin_hdrs, json={"crates": CRATES, "trucks": TRUCKS})
    resp = await client.post(f"{url}/create", headers=admin_hdrs)
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "queued"
    job = await reload(draft["id"])
    assert (job.phase, job.processed_rows, job.error) == ("commit", 0, None)
    for locked in (await client.patch(url, headers=admin_hdrs, json={}),
                   await client.delete(url, headers=admin_hdrs),
                   await client.post(f"{url}/create", headers=admin_hdrs)):
        assert locked.status_code == 409
        assert locked.json()["detail"]["code"] == "draft_not_editable"
    assert await db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.action == "move_setup_queued")) == 1


async def test_delete_removes_the_draft_and_its_check(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    check = (await upload_assets(client, admin_hdrs, draft["id"])).json()
    resp = await client.delete(f"{BASE}/{draft['id']}", headers=admin_hdrs)
    assert resp.status_code == 204
    assert await reload(draft["id"]) is None
    assert await reload(check["id"]) is None
    assert (await client.get(f"{BASE}/{draft['id']}", headers=admin_hdrs)).status_code == 404
```

- [ ] **Step 2: Run it and confirm it fails.** `tests/test_move_setup_api.py`. Expected: 404s on every route, because the router does not exist yet.
- [ ] **Step 3: Add the schemas** to `api/schemas.py`, directly after `ImportJobOut`:

```python
# ── bulk: create a move in steps ────────────────────────────────────

class MoveSetupMoveIn(InitiativeCreateIn):
    """Step 1 — every "New initiative" field; the type is always a move
    (the route overwrites whatever is sent)."""

    initiative_type: str = "move"


class MoveSetupCratesIn(BaseModel):
    # count/start ranges are the naming rule's, so they fail as sentences
    convention: str = Field(max_length=60)
    count: int
    start: int = 1
    container_type: str | None = None
    tags: dict[str, Annotated[int, Field(ge=0)]] = {}
    model_config = ConfigDict(extra="forbid")


class MoveSetupTrucksIn(BaseModel):
    convention: str = Field(max_length=60)
    count: int
    start: int = 1
    model_config = ConfigDict(extra="forbid")


class MoveSetupPatchIn(BaseModel):
    move: MoveSetupMoveIn | None = None
    crates: MoveSetupCratesIn | None = None
    trucks: MoveSetupTrucksIn | None = None
    skip: list[Literal["assets", "crates", "trucks"]] = []
    model_config = ConfigDict(extra="forbid")


class MoveSetupNamesOut(BaseModel):
    names: list[str]
    clashes: list[str]
    error: str | None = None


class MoveSetupPreviewsOut(BaseModel):
    crates: MoveSetupNamesOut | None = None
    trucks: MoveSetupNamesOut | None = None


class MoveSetupOut(BaseModel):
    id: uuid.UUID
    status: str
    error: str | None = None
    payload: dict | None = None
    initiative_id: uuid.UUID | None = None
    total_rows: int
    processed_rows: int
    results: dict | None = None
    created_at: datetime
    previews: MoveSetupPreviewsOut | None = None
```

- [ ] **Step 4: Implement the service's draft half** in `api/src/serversherpa/imports/move_setup.py`:

```python
"""Bulk Actions › Create a move in steps — the draft and its create.

A draft is ONE import_jobs row: kind "move_setup", status "preview",
initiative_id NULL until creation, owned by created_by. Its payload holds
every step:

    {"move":   {...InitiativeCreateIn fields, initiative_type "move"},
     "assets": {"check_job_id": uuid, "filename": str} | None,
     "crates": {"convention", "count", "start", "container_type",
                "tags": {tag: n}} | None,
     "trucks": {"convention", "count", "start"} | None}

The asset step is an ordinary move_assets job with no move
(options.move_setup_id = the draft id) that the import worker validates
like any other and that can never be committed on its own. Nothing reaches
the real tables until the worker applies the queued draft (apply_job) in one
transaction. payload is JSONB without mutation tracking: always reassign
job.payload, never edit it in place."""

import logging
import uuid
from datetime import UTC, datetime

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.schemas import MoveSetupMoveIn
from serversherpa.db.models import ImportJob
from serversherpa.imports.naming import (
    CRATE_MAX, TRUCK_MAX, NamingError, clash_sentence, generate_names,
)
from serversherpa.logistics.bulk_create import ContainerBulkError, check_tags, check_vocab
from serversherpa.logistics.bulk_create import find_clashes as container_clashes
from serversherpa.services.initiatives import ref_problem
from serversherpa.trucks.bulk_create import find_clashes as truck_clashes

logger = logging.getLogger(__name__)

KIND = "move_setup"
CHECK_KIND = "move_assets"
EDITABLE = ("preview", "failed")
PROGRESS_EVERY = 250

MOVE_REF_SENTENCES = {
    "client_not_found": "The client no longer exists. Pick another on the first step.",
    "site_not_found": "A site on the first step no longer exists. Pick another.",
    "partner_not_found": "A partner on the first step no longer exists. Pick another.",
    "unknown_status": "The move's status is no longer in the list. Pick another.",
    "unknown_initiative_type": "Moves can't be created because the Move type is missing.",
    "unknown_sub_type": "The move's sub-type is no longer in the list. Pick another.",
    "unknown_shipping_type": "A shipping type is no longer in the list. Pick others.",
}
TAG_SENTENCES = {
    "bad_tag_key": "Label tags must be Priority, Vendor, Accessories, Warehouse, or E-Waste.",
    "tags_exceed_count": "Label tag counts can't add up to more than the crate count.",
}
FILE_UNREADABLE = "The From-To file can't be read again. Upload it again, or skip the asset step."
WORKER_ERROR_MESSAGE = ("Something went wrong while creating the move. Nothing was created. "
                        "Try again.")
CONFLICT_MESSAGE = ("Another change landed while the move was being created. Nothing was "
                    "created. Try again.")


def empty_payload(move: dict) -> dict:
    return {"move": move, "assets": None, "crates": None, "trucks": None}


def typed_move(move: dict) -> dict:
    """The stored (JSON) move fields as typed values — UUIDs, datetimes —
    ready for ref_problem and the Initiative constructor."""
    data = MoveSetupMoveIn.model_validate(move).model_dump(exclude_none=True)
    data["initiative_type"] = "move"
    return data


def reopen(job: ImportJob) -> None:
    """Any edit puts a failed draft back to editable preview and counts as
    a touch for the 24-hour sweep."""
    job.status, job.error, job.results = "preview", None, None
    job.progress_at = datetime.now(UTC)


def crate_names(crates: dict) -> list[str]:
    return generate_names(crates["convention"], int(crates["count"]), int(crates["start"]),
                          max_count=CRATE_MAX)


def truck_names(trucks: dict) -> list[str]:
    return generate_names(trucks["convention"], int(trucks["count"]), int(trucks["start"]),
                          max_count=TRUCK_MAX)


async def move_problems(db: AsyncSession, move: dict) -> list[str]:
    try:
        data = typed_move(move)
    except ValidationError:
        return ["The move's details are no longer valid. Check the first step."]
    out: list[str] = []
    if not (data.get("name") or "").strip():
        out.append("The move needs a name.")
    if not data.get("origin_site_id"):
        out.append("Pick an origin site.")
    if not data.get("destination_site_id"):
        out.append("Pick a destination site.")
    if problem := await ref_problem(db, data):
        out.append(MOVE_REF_SENTENCES.get(problem[0],
                                          "Check the move's details on the first step."))
    return out


async def crate_problems(db: AsyncSession, crates: dict) -> list[str]:
    """Everything wrong with the crate step except name clashes."""
    try:
        names = crate_names(crates)
    except NamingError as exc:
        return [exc.message]
    if not names:
        return []
    out: list[str] = []
    if not crates.get("container_type"):
        out.append("Pick a crate type.")
    else:
        try:
            await check_vocab(db, crates["container_type"], None)
        except ContainerBulkError:
            out.append("Pick a crate type from the list.")
    try:
        check_tags(crates.get("tags") or {}, len(names))
    except ContainerBulkError as exc:
        out.append(TAG_SENTENCES[exc.code])
    return out


async def names_preview(db: AsyncSession, section: dict | None, *, kind: str) -> dict | None:
    if section is None:
        return None
    try:
        names = crate_names(section) if kind == "crates" else truck_names(section)
    except NamingError as exc:
        return {"names": [], "clashes": [], "error": exc.message}
    finder = container_clashes if kind == "crates" else truck_clashes
    return {"names": names, "clashes": await finder(db, names), "error": None}


async def previews(db: AsyncSession, payload: dict | None) -> dict:
    payload = payload or {}
    return {"crates": await names_preview(db, payload.get("crates"), kind="crates"),
            "trucks": await names_preview(db, payload.get("trucks"), kind="trucks")}


async def check_job(db: AsyncSession, payload: dict | None) -> ImportJob | None:
    assets = (payload or {}).get("assets")
    if not assets:
        return None
    return await db.get(ImportJob, uuid.UUID(assets["check_job_id"]))


def asset_problems(check: ImportJob | None) -> list[str]:
    if check is None:
        return ["The From-To file check is missing. Upload the file again, "
                "or skip the asset step."]
    if check.status in ("queued", "running"):
        return ["The From-To file is still being checked. Wait for it to finish, "
                "then create the move."]
    if check.status != "completed":
        return ["The From-To file check didn't finish. Upload the file again, "
                "or skip the asset step."]
    return []


async def draft_problems(db: AsyncSession, payload: dict) -> tuple[list[str], list[str]]:
    """(invalid, clashes) as sentences. The create route rejects either; the
    worker treats `invalid` as setup_invalid and re-checks clashes itself
    right before each create (a clash there is name_taken)."""
    invalid = await move_problems(db, payload.get("move") or {})
    if payload.get("assets") is not None:
        invalid += asset_problems(await check_job(db, payload))
    clashes: list[str] = []
    if (crates := payload.get("crates")) is not None:
        problems = await crate_problems(db, crates)
        invalid += problems
        if not problems and (found := await container_clashes(db, crate_names(crates))):
            clashes.append(clash_sentence("crate", found))
    if (trucks := payload.get("trucks")) is not None:
        try:
            names = truck_names(trucks)
        except NamingError as exc:
            invalid.append(exc.message)
        else:
            if found := await truck_clashes(db, names):
                clashes.append(clash_sentence("truck", found))
    return invalid, clashes


async def new_check(db: AsyncSession, draft: ImportJob, *, filename: str, options: dict,
                    file_key: str = "") -> ImportJob:
    check = ImportJob(kind=CHECK_KIND, initiative_id=None, created_by=draft.created_by,
                      filename=filename, file_key=file_key,
                      options={**options, "move_setup_id": str(draft.id)},
                      phase="validate", status="queued")
    db.add(check)
    await db.flush()
    return check


async def attach_check(db: AsyncSession, draft: ImportJob, check: ImportJob) -> None:
    """Point the draft at `check` and retire every other check it had."""
    await retire_check_jobs(db, draft.id, keep=check.id)
    draft.payload = {**(draft.payload or {}),
                     "assets": {"check_job_id": str(check.id), "filename": check.filename}}
    reopen(draft)


async def retire_check_jobs(db: AsyncSession, draft_id: uuid.UUID, *,
                            keep: uuid.UUID | None = None) -> None:
    """Delete the draft's check jobs (except `keep`). A running one is only
    flagged: the worker still holds it and writes its result, so deleting
    it would fail that write; the sweep removes it once finished."""
    for check in await db.scalars(select(ImportJob).where(
            ImportJob.kind == CHECK_KIND, ImportJob.initiative_id.is_(None),
            ImportJob.options["move_setup_id"].astext == str(draft_id))):
        if check.id == keep:
            continue
        if check.status == "running":
            check.cancel_requested = True
        else:
            await db.delete(check)
```

- [ ] **Step 5: Implement the routes** in `api/src/serversherpa/api/routes/move_setup.py`:

```python
"""Bulk Actions › Create a move in steps — /bulk/move-setup. The wizard's
state is one server-side draft (imports/move_setup.py); these routes edit it,
run the From-To check without a move, and queue the create, which the import
worker applies in one transaction. Admin bulk rank, a global actor, and
initiatives/containers/trucks add; a draft is visible only to its creator."""

import uuid
from datetime import UTC, datetime
from pathlib import PurePosixPath

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from serversherpa.api.bulk_routes import require_bulk_rank
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.routes.initiatives import IMPORT_EXTENSIONS, MAKE_MODEL_MODES
from serversherpa.api.schemas import (
    ImportJobOut, MoveSetupCratesIn, MoveSetupMoveIn, MoveSetupOut, MoveSetupPatchIn,
    MoveSetupTrucksIn,
)
from serversherpa.db.models import ImportJob
from serversherpa.imports import move_setup
from serversherpa.imports.naming import CRATE_MAX, TRUCK_MAX, NamingError, generate_names
from serversherpa.imports.parsing import MAX_BYTES
from serversherpa.logistics import bulk_create as container_create
from serversherpa.services.audit import audit
from serversherpa.services.initiatives import ref_problem
from serversherpa.services.storage import put_object

router = APIRouter(prefix="/bulk/move-setup", tags=["bulk"])


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _guard(actor: AuthContext) -> None:
    """Admin bulk rank + a global actor (require_bulk_rank), and every kind
    of record the create writes. Runs before anything is looked up."""
    require_bulk_rank(actor)
    if not (actor.access.can("containers", "add") and actor.access.can("trucks", "add")):
        raise _err(403, "forbidden")


async def _draft(db: DbSession, draft_id: uuid.UUID, actor: AuthContext, *,
                 lock: bool = False) -> ImportJob:
    """Only the creator's own draft; anyone else's id reads as missing. A
    mutating route locks the row so an edit and a create serialize."""
    job = await db.get(ImportJob, draft_id, with_for_update=lock or None,
                       populate_existing=lock)
    if job is None or job.kind != move_setup.KIND or job.created_by != actor.person.id:
        raise _err(404, "draft_not_found")
    return job


def _require_editable(job: ImportJob) -> None:
    if job.status not in move_setup.EDITABLE:
        raise _err(409, "draft_not_editable")


async def _move_data(db: DbSession, body: MoveSetupMoveIn) -> dict:
    typed = body.model_dump(exclude_none=True)
    typed["initiative_type"] = "move"
    if not (typed.get("name") or "").strip():
        raise _err(422, "name_required")
    if not typed.get("origin_site_id"):
        raise _err(422, "origin_required")
    if not typed.get("destination_site_id"):
        raise _err(422, "destination_required")
    if problem := await ref_problem(db, typed):
        code, extra = problem
        raise _err(422, code, **extra)
    stored = body.model_dump(mode="json", exclude_none=True)
    stored["initiative_type"] = "move"
    stored["name"] = stored["name"].strip()
    return stored


async def _crates_data(db: DbSession, body: MoveSetupCratesIn) -> dict:
    data = body.model_dump()
    data["convention"] = data["convention"].strip()
    try:
        generate_names(data["convention"], data["count"], data["start"], max_count=CRATE_MAX)
        container_create.check_tags(data["tags"], data["count"])
        if data["container_type"]:
            await container_create.check_vocab(db, data["container_type"], None)
    except NamingError as exc:
        raise _err(422, "invalid_naming", message=exc.message) from None
    except container_create.ContainerBulkError as exc:
        raise _err(exc.status, exc.code, **exc.extra) from None
    return data


def _trucks_data(body: MoveSetupTrucksIn) -> dict:
    data = body.model_dump()
    data["convention"] = data["convention"].strip()
    try:
        generate_names(data["convention"], data["count"], data["start"], max_count=TRUCK_MAX)
    except NamingError as exc:
        raise _err(422, "invalid_naming", message=exc.message) from None
    return data


async def _out(db: DbSession, job: ImportJob, *, with_previews: bool = False) -> MoveSetupOut:
    return MoveSetupOut(
        id=job.id, status=job.status, error=job.error, payload=job.payload,
        initiative_id=job.initiative_id, total_rows=job.total_rows,
        processed_rows=job.processed_rows, results=job.results, created_at=job.created_at,
        previews=(await move_setup.previews(db, job.payload)
                  if with_previews and job.payload else None))


@router.post("", response_model=MoveSetupOut, status_code=201)
async def create_draft(
    body: MoveSetupMoveIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> MoveSetupOut:
    _guard(actor)
    move = await _move_data(db, body)
    job = ImportJob(kind=move_setup.KIND, initiative_id=None, created_by=actor.person.id,
                    filename=move["name"], status="preview", phase="preview",
                    payload=move_setup.empty_payload(move))
    move_setup.reopen(job)
    db.add(job)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="initiative", entity_id=None,
          action="move_setup_draft_create",
          changes={"draft_id": {"from": None, "to": str(job.id)},
                   "name": {"from": None, "to": move["name"]}})
    await db.commit()
    return await _out(db, job)


@router.get("/{draft_id}", response_model=MoveSetupOut)
async def get_draft(
    draft_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> MoveSetupOut:
    _guard(actor)
    return await _out(db, await _draft(db, draft_id, actor))


@router.patch("/{draft_id}", response_model=MoveSetupOut)
async def update_draft(
    draft_id: uuid.UUID,
    body: MoveSetupPatchIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> MoveSetupOut:
    _guard(actor)
    job = await _draft(db, draft_id, actor, lock=True)
    _require_editable(job)
    payload = dict(job.payload or {})
    if body.move is not None:
        payload["move"] = await _move_data(db, body.move)
        job.filename = payload["move"]["name"]
    if body.crates is not None:
        payload["crates"] = await _crates_data(db, body.crates)
    if body.trucks is not None:
        payload["trucks"] = _trucks_data(body.trucks)
    for section in body.skip:
        payload[section] = None
        if section == "assets":
            await move_setup.retire_check_jobs(db, job.id)
    job.payload = payload
    move_setup.reopen(job)
    await db.commit()
    return await _out(db, job, with_previews=True)


@router.post("/{draft_id}/assets", response_model=ImportJobOut, status_code=201)
async def upload_draft_assets(
    draft_id: uuid.UUID,
    db: DbSession,
    file: UploadFile = File(...),
    make_model_mode: str = Form("fuzzy"),
    generate_serials: bool = Form(False),
    actor: AuthContext = require_permission("initiatives", "add"),
) -> ImportJob:
    _guard(actor)
    job = await _draft(db, draft_id, actor, lock=True)
    _require_editable(job)
    if make_model_mode not in MAKE_MODEL_MODES:
        raise _err(422, "invalid_make_model_mode")
    filename = file.filename or "upload.csv"
    if not filename.lower().endswith(IMPORT_EXTENSIONS):
        raise _err(422, "unsupported_file")
    content = await file.read()
    if len(content) > MAX_BYTES:
        raise _err(422, "file_too_large", limit=MAX_BYTES)
    if not content:
        raise _err(422, "empty_file")
    check = await move_setup.new_check(
        db, job, filename=filename,
        options={"make_model_mode": make_model_mode, "generate_serials": generate_serials})
    # our key, never the uploader's name (same rule as the move import)
    key = (f"import-jobs/move-setup/{job.id}/"
           f"{check.id}{PurePosixPath(filename).suffix.lower()}")
    await put_object(key, content, file.content_type or "application/octet-stream")
    check.file_key = key
    await move_setup.attach_check(db, job, check)
    await db.commit()
    return check


@router.post("/{draft_id}/assets/recheck", response_model=ImportJobOut, status_code=201)
async def recheck_draft_assets(
    draft_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> ImportJob:
    _guard(actor)
    job = await _draft(db, draft_id, actor, lock=True)
    _require_editable(job)
    old = await move_setup.check_job(db, job.payload)
    if old is None:
        raise _err(409, "no_asset_file")
    options = {k: v for k, v in (old.options or {}).items() if k != "move_setup_id"}
    check = await move_setup.new_check(db, job, filename=old.filename, options=options,
                                       file_key=old.file_key)
    await move_setup.attach_check(db, job, check)
    await db.commit()
    return check


@router.post("/{draft_id}/create", response_model=MoveSetupOut)
async def create_move_from_draft(
    draft_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> MoveSetupOut:
    _guard(actor)
    job = await _draft(db, draft_id, actor, lock=True)
    _require_editable(job)
    invalid, clashes = await move_setup.draft_problems(db, job.payload or {})
    if invalid or clashes:
        raise _err(422, "setup_invalid", reasons=invalid + clashes)
    job.status, job.phase, job.error, job.results = "queued", "commit", None, None
    job.processed_rows = job.total_rows = 0
    job.cancel_requested = False
    job.started_at = job.finished_at = None
    job.progress_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="initiative", entity_id=None,
          action="move_setup_queued", changes={"draft_id": {"from": None, "to": str(job.id)}})
    await db.commit()
    return await _out(db, job)


@router.delete("/{draft_id}", status_code=204)
async def delete_draft(
    draft_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> None:
    _guard(actor)
    job = await _draft(db, draft_id, actor, lock=True)
    _require_editable(job)
    await move_setup.retire_check_jobs(db, job.id)
    await db.delete(job)
    await db.commit()
```

  Register the router in `api/app.py`: add `move_setup` to the `from serversherpa.api.routes import (…)` tuple, keeping it alphabetical, and add `app.include_router(move_setup.router)` right after `app.include_router(initiatives.router)`.

- [ ] **Step 6: Serve a no-move check to its uploader, and refuse to commit it.** In `api/routes/initiatives.py`:

```python
async def _get_import_job(db: DbSession, job_id: uuid.UUID,
                          actor: AuthContext) -> ImportJob:
    job = await db.get(ImportJob, job_id)
    if job is None or job.kind != "move_assets":
        raise _err(404, "import_job_not_found")
    if job.initiative_id is None:
        # a Create-a-move-in-steps file check: there is no move to scope
        # it by, so it belongs to whoever uploaded it (like its draft)
        if job.created_by != actor.person.id:
            raise _err(404, "import_job_not_found")
        return job
    await _require_parent_in_scope(db, job.initiative_id, actor,
                                   "import_job_not_found")
    return job


def _require_move_job(job: ImportJob) -> None:
    """A move-setup file check has no move to import into — its rows are
    written only by the move setup's own create."""
    if job.initiative_id is None:
        raise _err(409, "check_only")
```

  Call `_require_move_job(job)` right after `_require_global(actor)` in `commit_move_asset_import_job`. In `reprocess_move_asset_import_job`, call it with `parent` right after `_require_global(actor)`.

- [ ] **Step 7: Run the tests:** `tests/test_move_setup_api.py tests/test_move_asset_import_api.py tests/test_import_reprocess_api.py tests/test_import_worker.py`. Expected: all PASS. Then run ruff on the new and changed files.
- [ ] **Step 8: Commit** `feat(api): /bulk/move-setup drafts — previews, clashes, skip, a From-To check with no move, create validation`.

---

### Task 3: Worker `move_setup` job — one transaction, progress, failure codes, sweep

**Files:**
- Modify: `api/src/serversherpa/imports/move_setup.py` (append the create half)
- Modify: `api/src/serversherpa/imports/worker.py` (dispatch, `_process_move_setup`, generic handler, hourly sweep in `run_forever`)
- Modify: `api/src/serversherpa/imports/jobs.py` (`sweep_stale`)
- Test: `api/tests/test_move_setup_worker.py`

**Interfaces:**
- Consumes: Task 1 (`run_import(commit=False, progress_every=…)`, `create_initiative_row`, `create_containers`, `create_trucks`, `ContainerBulkError`, `TruckBulkError`, `clash_sentence`) and Task 2 (`draft_problems`, `typed_move`, `crate_names`, `truck_names`, `check_job`, `retire_check_jobs`, the message constants).
- Produces:

```python
# imports/move_setup.py (create half)
class SetupFailed(Exception):  # .code: str, .reasons: list[str]
@dataclass
class Plan:
    move: dict; rows: list[dict] | None; make_model_mode: str; filename: str
    crates: dict | None; crate_names: list[str]; truck_names: list[str]
    @property total -> int                      # asset rows + crates + trucks
async def prepare(db, job) -> Plan              # read-only; raises SetupFailed("setup_invalid", …)
def mark_failed(job, code: str, reasons: list[str]) -> None
async def apply_job(db, job, plan, *, progress: Callable[[int], Awaitable[None]] | None = None) -> None
    # success: commits (job completed, payload None, initiative_id set, results)
    # failure: rolls back, re-reads the job, marks it failed; the CALLER commits

# imports/jobs.py
STALE_DRAFT_HOURS = 24
async def sweep_stale(db, *, now: datetime | None = None) -> dict[str, int]  # {"drafts","checks","previews"}

# job.results on success
{"move_id": str, "assets": {"summary": {...}, "details": [...]} | None, "crates": int, "trucks": int}
# job.results on failure
{"reasons": [sentence, ...]}
```

- [ ] **Step 1: Write the failing tests** `api/tests/test_move_setup_worker.py`:

```python
"""Create a move in steps — the worker's move_setup job: everything in one
transaction, progress through a second session, failures that leave nothing
behind and keep the draft for a retry, and the 24-hour sweep."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select, update

from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    Asset, AuditLog, Container, ImportJob, Initiative, InitiativeAsset, Truck,
)
from serversherpa.imports import move_setup
from serversherpa.imports.jobs import claim_next, sweep_stale
from serversherpa.imports.worker import run_once
from tests.test_move_setup_api import (
    BASE, CRATES, TRUCKS, admin_login, make_sites, move_body, new_draft, reload,
    upload_assets,
)


@pytest.fixture
async def admin_hdrs(db, client):
    return await admin_login(db, client, "ada@test.example.com")


async def count(db, model) -> int:
    return await db.scalar(select(func.count()).select_from(model))


async def full_draft(client, db, hdrs, *, crates=CRATES, trucks=TRUCKS):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, hdrs, origin, destination, scheduled_start="2026-10-01")
    assert (await upload_assets(client, hdrs, draft["id"])).status_code == 201
    assert await run_once(get_sessionmaker()) is True          # the From-To check
    resp = await client.patch(f"{BASE}/{draft['id']}", headers=hdrs,
                              json={"crates": crates, "trucks": trucks})
    assert resp.status_code == 200, resp.text
    return draft, origin, destination


async def queue(client, hdrs, draft_id) -> None:
    resp = await client.post(f"{BASE}/{draft_id}/create", headers=hdrs)
    assert resp.status_code == 200, resp.text


async def test_create_builds_the_move_assets_crates_and_trucks(client, db, admin_hdrs):
    draft, origin, destination = await full_draft(client, db, admin_hdrs)
    await queue(client, admin_hdrs, draft["id"])
    assert await run_once(get_sessionmaker()) is True
    done = await reload(draft["id"])
    assert (done.status, done.error, done.payload) == ("completed", None, None)
    ini = await db.get(Initiative, done.initiative_id)
    assert (ini.name, ini.initiative_type) == ("SJC to DAL", "move")
    assert (ini.origin_site_id, ini.destination_site_id) == (origin.id, destination.id)
    assert ini.color is not None
    # dates land exactly as POST /initiatives stores them
    ref = await client.post("/initiatives", headers=admin_hdrs,
                            json=move_body(origin, destination, name="ref",
                                           scheduled_start="2026-10-01"))
    assert ini.scheduled_start == (await db.get(
        Initiative, uuid.UUID(ref.json()["id"]))).scheduled_start
    assert await db.scalar(select(func.count()).select_from(InitiativeAsset).where(
        InitiativeAsset.initiative_id == ini.id)) == 2
    crates = (await db.scalars(select(Container).where(
        Container.initiative_id == ini.id).order_by(Container.name))).all()
    assert [c.name for c in crates] == ["CRT-SJC-DAL-001", "CRT-SJC-DAL-002",
                                        "CRT-SJC-DAL-003"]
    assert [c.label_tag for c in crates] == ["priority", None, None]
    assert {(c.site_id, c.container_type, c.status) for c in crates} == {
        (origin.id, "pallet", "available")}
    trucks = (await db.scalars(select(Truck).where(
        Truck.initiative_id == ini.id).order_by(Truck.name))).all()
    assert [t.name for t in trucks] == ["TRK-SJC-DAL-001", "TRK-SJC-DAL-002"]
    assert {(t.start_site_id, t.end_site_id) for t in trucks} == {(origin.id, destination.id)}
    assert done.results["move_id"] == str(ini.id)
    assert (done.results["crates"], done.results["trucks"]) == (3, 2)
    assert done.results["assets"]["summary"]["created"] == 2
    assert len(done.results["assets"]["details"]) == 2
    assert (done.processed_rows, done.total_rows) == (7, 7)
    actions = [(a.entity_type, a.action) for a in await db.scalars(select(AuditLog))]
    assert actions.count(("initiative", "create")) == 2           # this move + the ref
    assert actions.count(("container", "create")) == 3
    assert actions.count(("truck", "create")) == 2
    assert actions.count(("initiative", "asset_import")) == 1
    assert actions.count(("initiative", "bulk_import")) == 1
    assert await db.scalar(select(func.count()).select_from(ImportJob).where(
        ImportJob.kind == "move_assets")) == 0                      # the check is gone


async def test_create_with_every_optional_step_skipped(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                       json={"skip": ["assets", "crates", "trucks"]})
    await queue(client, admin_hdrs, draft["id"])
    assert await run_once(get_sessionmaker()) is True
    done = await reload(draft["id"])
    assert done.status == "completed"
    assert done.results == {"move_id": str(done.initiative_id), "assets": None,
                            "crates": 0, "trucks": 0}
    assert (done.processed_rows, done.total_rows) == (0, 0)
    assert (await count(db, Initiative), await count(db, Container),
            await count(db, Truck), await count(db, Asset)) == (1, 0, 0, 0)


async def test_a_clash_after_the_check_leaves_nothing_behind(client, db, admin_hdrs):
    draft, _, _ = await full_draft(client, db, admin_hdrs)
    await queue(client, admin_hdrs, draft["id"])
    db.add(Truck(name="trk-sjc-dal-002"))      # lands after validation, before the worker
    await db.commit()
    assert await run_once(get_sessionmaker()) is True
    failed = await reload(draft["id"])
    assert (failed.status, failed.error) == ("failed", "name_taken")
    assert failed.results == {"reasons": ["These truck names already exist: TRK-SJC-DAL-002."]}
    assert failed.payload["trucks"] == TRUCKS                     # kept for a retry
    assert (failed.processed_rows, failed.initiative_id) == (0, None)
    # the move, its assets and its crates were already flushed — all rolled back
    assert await count(db, Initiative) == 0
    assert await count(db, Asset) == 0
    assert await count(db, InitiativeAsset) == 0
    assert await count(db, Container) == 0
    assert await count(db, Truck) == 1                            # only the planted one
    assert await db.scalar(select(func.count()).select_from(AuditLog).where(
        AuditLog.action.in_(("create", "asset_import", "bulk_import")))) == 0
    assert await reload(failed.payload["assets"]["check_job_id"]) is not None


async def test_a_failed_draft_can_be_fixed_and_created(client, db, admin_hdrs):
    draft, _, _ = await full_draft(client, db, admin_hdrs)
    await queue(client, admin_hdrs, draft["id"])
    db.add(Truck(name="TRK-SJC-DAL-002"))
    await db.commit()
    await run_once(get_sessionmaker())
    fixed = await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                               json={"trucks": {**TRUCKS, "start": 10}})
    assert fixed.json()["status"] == "preview"
    await queue(client, admin_hdrs, draft["id"])
    assert await run_once(get_sessionmaker()) is True
    done = await reload(draft["id"])
    assert done.status == "completed"
    names = set(await db.scalars(select(Truck.name).where(
        Truck.initiative_id == done.initiative_id)))
    assert names == {"TRK-SJC-DAL-010", "TRK-SJC-DAL-011"}


async def test_an_unexpected_error_rolls_back_as_worker_error(
        client, db, admin_hdrs, monkeypatch):
    draft, _, _ = await full_draft(client, db, admin_hdrs)
    await queue(client, admin_hdrs, draft["id"])

    async def boom(*args, **kwargs):
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(move_setup, "create_trucks", boom)
    assert await run_once(get_sessionmaker()) is True
    failed = await reload(draft["id"])
    assert (failed.status, failed.error) == ("failed", "worker_error")
    assert failed.results == {"reasons": [move_setup.WORKER_ERROR_MESSAGE]}
    assert failed.payload is not None
    assert (await count(db, Initiative), await count(db, Asset),
            await count(db, Container)) == (0, 0, 0)


async def test_a_crash_before_the_apply_still_keeps_the_payload(
        client, db, admin_hdrs, monkeypatch):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                       json={"skip": ["assets", "crates", "trucks"]})
    await queue(client, admin_hdrs, draft["id"])

    async def boom(db, job):
        raise RuntimeError("storage down")

    monkeypatch.setattr(move_setup, "prepare", boom)
    assert await run_once(get_sessionmaker()) is True
    failed = await reload(draft["id"])
    assert (failed.status, failed.error) == ("failed", "worker_error")
    assert failed.results == {"reasons": [move_setup.WORKER_ERROR_MESSAGE]}
    assert failed.payload is not None


async def test_a_site_removed_after_queueing_is_setup_invalid(client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    draft = await new_draft(client, admin_hdrs, origin, destination)
    await client.patch(f"{BASE}/{draft['id']}", headers=admin_hdrs,
                       json={"skip": ["assets", "crates", "trucks"]})
    await queue(client, admin_hdrs, draft["id"])
    await db.delete(destination)
    await db.commit()
    assert await run_once(get_sessionmaker()) is True
    failed = await reload(draft["id"])
    assert (failed.status, failed.error) == ("failed", "setup_invalid")
    assert failed.results == {"reasons": [
        "A site on the first step no longer exists. Pick another."]}
    assert await count(db, Initiative) == 0


async def test_apply_reports_progress_by_units(client, db, admin_hdrs, monkeypatch):
    monkeypatch.setattr(move_setup, "PROGRESS_EVERY", 2)
    draft, _, _ = await full_draft(client, db, admin_hdrs)      # 2 assets, 3 crates, 2 trucks
    await queue(client, admin_hdrs, draft["id"])
    seen: list[int] = []

    async def progress(n: int) -> None:
        seen.append(n)

    async with get_sessionmaker()() as work:
        job = await claim_next(work)
        plan = await move_setup.prepare(work, job)
        assert plan.total == 7
        await work.commit()
        await move_setup.apply_job(work, job, plan, progress=progress)
    assert seen == [2, 2, 5, 7]           # asset boundary, asset tail, +crates, +trucks
    assert (await reload(draft["id"])).status == "completed"


async def test_progress_is_visible_while_the_create_is_still_open(
        client, db, admin_hdrs, monkeypatch):
    """The create's own transaction stays open to the end; progress goes
    through a second session, so another reader sees it mid-run."""
    monkeypatch.setattr(move_setup, "PROGRESS_EVERY", 2)
    draft, _, _ = await full_draft(client, db, admin_hdrs)
    await queue(client, admin_hdrs, draft["id"])
    real = move_setup.create_containers
    observed: list[int] = []

    async def spy(*args, **kwargs):
        async with get_sessionmaker()() as other:
            observed.append(await other.scalar(select(ImportJob.processed_rows).where(
                ImportJob.id == uuid.UUID(draft["id"]))))
            assert await other.scalar(select(func.count()).select_from(Initiative)) == 0
        return await real(*args, **kwargs)

    monkeypatch.setattr(move_setup, "create_containers", spy)
    assert await run_once(get_sessionmaker()) is True
    assert observed == [2]
    done = await reload(draft["id"])
    assert (done.processed_rows, done.total_rows) == (7, 7)


async def test_sweep_removes_stale_drafts_their_checks_and_old_previews(
        client, db, admin_hdrs):
    origin, destination = await make_sites(db)
    stale = await new_draft(client, admin_hdrs, origin, destination)
    stale_check = (await upload_assets(client, admin_hdrs, stale["id"])).json()
    fresh = await new_draft(client, admin_hdrs, origin, destination)
    fresh_check = (await upload_assets(client, admin_hdrs, fresh["id"])).json()
    queued = await new_draft(client, admin_hdrs, origin, destination)
    await client.patch(f"{BASE}/{queued['id']}", headers=admin_hdrs,
                       json={"skip": ["assets", "crates", "trucks"]})
    await queue(client, admin_hdrs, queued["id"])
    preview = ImportJob(kind="asset_bulk_update", initiative_id=None, filename="a.csv",
                        status="preview", phase="preview", payload=[{"row": 2, "cells": {}}])
    db.add(preview)
    await db.flush()
    old = datetime.now(UTC) - timedelta(hours=25)
    await db.execute(update(ImportJob).where(ImportJob.id.in_([
        uuid.UUID(stale["id"]), uuid.UUID(queued["id"]), preview.id,
    ])).values(progress_at=old, created_at=old))
    await db.commit()

    assert await sweep_stale(db) == {"drafts": 1, "checks": 1, "previews": 1}
    assert await reload(stale["id"]) is None
    assert await reload(stale_check["id"]) is None
    assert (await reload(fresh["id"])).status == "preview"
    assert await reload(fresh_check["id"]) is not None            # still referenced
    assert (await reload(queued["id"])).status == "queued"          # never swept
    swept = await reload(preview.id)
    assert (swept.status, swept.error, swept.payload) == ("cancelled", "expired", None)
```

- [ ] **Step 2: Run it and confirm it fails.** `tests/test_move_setup_worker.py`. Expected: FAIL with `ImportError: cannot import name 'sweep_stale'`.
- [ ] **Step 3: Append the create half to `imports/move_setup.py`**, and extend its imports with `dataclass`/`field`, `Awaitable`/`Callable`, `IntegrityError`, `parse_row`/`run_import`, `ImportFileError`/`parse_upload`, `create_containers`, `TruckBulkError`/`create_trucks`, `create_initiative_row`, `audit` and `get_object`:

```python
class SetupFailed(Exception):
    def __init__(self, code: str, reasons: list[str]) -> None:
        super().__init__(code)
        self.code = code
        self.reasons = reasons


@dataclass
class Plan:
    move: dict
    rows: list[dict] | None
    make_model_mode: str
    filename: str
    crates: dict | None
    crate_names: list[str] = field(default_factory=list)
    truck_names: list[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return len(self.rows or []) + len(self.crate_names) + len(self.truck_names)


async def prepare(db: AsyncSession, job: ImportJob) -> Plan:
    """Re-validate the draft and re-read its From-To file. Read-only; the
    worker commits the job's totals before apply_job opens the write."""
    payload = job.payload or {}
    invalid, _ = await draft_problems(db, payload)     # clashes: re-checked at each create
    if invalid:
        raise SetupFailed("setup_invalid", invalid)
    rows, mode, filename = None, "fuzzy", ""
    if payload.get("assets") is not None:
        check = await check_job(db, payload)
        try:
            content = await get_object(check.file_key)
            numbered = parse_upload(check.filename, content)
        except ImportFileError:
            raise SetupFailed("setup_invalid", [FILE_UNREADABLE]) from None
        except Exception:
            logger.exception("move setup %s: stored From-To file unreadable", job.id)
            raise SetupFailed("setup_invalid", [FILE_UNREADABLE]) from None
        opts = check.options or {}
        rows = [parse_row(n, canonical, raw,
                          generate_serials=bool(opts.get("generate_serials")))
                for n, canonical, raw in numbered]
        mode = str(opts.get("make_model_mode") or "fuzzy")
        filename = check.filename
    crates, trucks = payload.get("crates"), payload.get("trucks")
    return Plan(move=typed_move(payload["move"]), rows=rows, make_model_mode=mode,
                filename=filename, crates=crates,
                crate_names=crate_names(crates) if crates else [],
                truck_names=truck_names(trucks) if trucks else [])


def mark_failed(job: ImportJob, code: str, reasons: list[str]) -> None:
    """A failed draft stays editable: payload is kept for the retry."""
    job.status, job.error = "failed", code
    job.results = {"reasons": reasons}
    job.processed_rows = 0
    job.finished_at = datetime.now(UTC)


async def _fail(db: AsyncSession, job: ImportJob, code: str, reasons: list[str]) -> None:
    await db.rollback()
    await db.refresh(job)          # the rollback expired it; the committed row is the truth
    mark_failed(job, code, reasons)


async def apply_job(db: AsyncSession, job: ImportJob, plan: Plan, *,
                    progress: Callable[[int], Awaitable[None]] | None = None) -> None:
    """Create everything in ONE transaction: the move (and its create
    audit), the From-To rows (run_import with commit=False — rows needing
    review are left out, as always), the crates at the origin, the trucks
    origin → destination, and one bulk_import audit. Commits on success.
    Any failure rolls all of it back and marks the job failed with a
    sentence code; the caller commits that. Nothing here touches the job
    row until the end, so `progress` (its own session) never waits on us."""
    owner = job.created_by

    async def report(done: int) -> None:
        if progress is not None:
            await progress(done)

    try:
        initiative = await create_initiative_row(db, plan.move, owner)
        n_assets = len(plan.rows or [])
        imported = None
        if plan.rows is not None:
            async def asset_progress(processed, created, updated, errors) -> None:
                await report(processed)

            imported = await run_import(
                db, initiative_id=initiative.id, added_by=owner, rows=plan.rows,
                make_model_mode=plan.make_model_mode, write=True,
                source_label=f"move-setup {job.id} ({plan.filename})",
                progress=asset_progress, commit=False, progress_every=PROGRESS_EVERY)
        crates: list = []
        if plan.crate_names:
            try:
                crates = await create_containers(
                    db, names=plan.crate_names, container_type=plan.crates["container_type"],
                    status=None, site_id=initiative.origin_site_id,
                    initiative_id=initiative.id, tags=plan.crates.get("tags") or {},
                    actor_id=owner)
            except ContainerBulkError as exc:
                if exc.code == "name_collision":
                    raise SetupFailed("name_taken",
                                      [clash_sentence("crate", exc.extra["names"])]) from None
                raise SetupFailed("setup_invalid", [TAG_SENTENCES.get(
                    exc.code, "Pick a crate type from the list.")]) from None
            await report(n_assets + len(crates))
        trucks: list = []
        if plan.truck_names:
            try:
                trucks = await create_trucks(
                    db, plan.truck_names, initiative.id, initiative.origin_site_id,
                    initiative.destination_site_id, owner)
            except TruckBulkError as exc:
                raise SetupFailed("name_taken", [clash_sentence("truck", exc.names)]) from None
            await report(plan.total)
        await retire_check_jobs(db, job.id)
        summary = (imported or {}).get("summary") or {}
        audit(db, actor_id=owner, entity_type="initiative", entity_id=str(initiative.id),
              action="bulk_import",
              changes={"source": "move_setup", "draft_id": str(job.id),
                       "assets_created": summary.get("created", 0),
                       "assets_updated": summary.get("updated", 0),
                       "assets_left_out": summary.get("review", 0) + summary.get("errors", 0),
                       "crates": len(crates), "trucks": len(trucks)})
        finished = datetime.now(UTC)
        job.status, job.error = "completed", None
        job.initiative_id = initiative.id
        job.processed_rows = plan.total
        job.results = {
            "move_id": str(initiative.id),
            "assets": ({"summary": imported["summary"], "details": imported["details"]}
                       if imported else None),
            "crates": len(crates), "trucks": len(trucks)}
        job.payload = None
        job.progress_at = job.finished_at = finished
        await db.commit()
    except SetupFailed as exc:
        await _fail(db, job, exc.code, exc.reasons)
    except IntegrityError:
        await _fail(db, job, "apply_conflict", [CONFLICT_MESSAGE])
    except Exception:
        logger.exception("move setup %s failed while creating", job.id)
        await _fail(db, job, "worker_error", [WORKER_ERROR_MESSAGE])
```

  `PROGRESS_EVERY` is read at call time, which lets the test monkeypatch it. `create_containers`, `create_trucks` and `prepare` are module-level names so the tests can monkeypatch them. Always call them unqualified inside this module. The worker calls `move_setup.prepare`.

- [ ] **Step 4: Worker.** In `imports/worker.py`:
  - Add `from serversherpa.imports import move_setup`.
  - Update the module docstring's "Two kinds share the queue" paragraph to name `move_setup` as well.
  - Add:

```python
async def _process_move_setup(db: AsyncSession, job: ImportJob) -> None:
    """Create a move from a queued Create-a-move-in-steps draft. The create
    runs in one transaction (move_setup.apply_job); progress goes through a
    second, short-lived session, exactly like the bulk asset update."""
    job_id = job.id
    try:
        plan = await move_setup.prepare(db, job)
    except move_setup.SetupFailed as exc:
        move_setup.mark_failed(job, exc.code, exc.reasons)
        await db.commit()
        return
    job.total_rows = plan.total
    job.processed_rows = 0
    job.progress_at = datetime.now(UTC)
    await db.commit()

    async def _progress(processed: int) -> None:
        async with get_sessionmaker()() as side:
            await side.execute(
                update(ImportJob).where(ImportJob.id == job_id)
                .values(processed_rows=processed, progress_at=func.now()))
            await side.commit()

    await move_setup.apply_job(db, job, plan, progress=_progress)
    await db.commit()
```

  In `process_job`, after the `ASSET_BULK_UPDATE` branch:

```python
    if job.kind == move_setup.KIND:
        await _process_move_setup(db, job)
        return
```

  In `run_once`'s `except Exception` block, replace the `_finish(...)` line:

```python
            await db.rollback()
            if kind == move_setup.KIND:
                # the draft stays editable: payload kept, a sentence code
                move_setup.mark_failed(job, "worker_error", [move_setup.WORKER_ERROR_MESSAGE])
            else:
                _finish(job, "failed", f"worker_error: {exc}")
            if kind == ASSET_BULK_UPDATE:
                job.payload = None       # the parsed file is never read again
            await db.commit()
```

  Hourly sweep in `run_forever`:
  - Import `time` and `from serversherpa.imports.jobs import sweep_stale`, and add `SWEEP_SECONDS = 3600`.
  - Before the loop, set `last_sweep = -SWEEP_SECONDS`.
  - Inside the loop, after the pause branch and before `run_once`, add:

```python
            if time.monotonic() - last_sweep >= SWEEP_SECONDS:
                async with maker() as db:
                    swept = await sweep_stale(db)
                last_sweep = time.monotonic()
                if any(swept.values()):
                    logger.info("swept %d draft(s), %d check(s), %d preview(s)",
                                swept["drafts"], swept["checks"], swept["previews"])
```

- [ ] **Step 5: Sweep.** Add to `imports/jobs.py`, importing `func`, `delete`, `update`, `cast`, `String` from sqlalchemy and `aliased` from `sqlalchemy.orm`:

```python
STALE_DRAFT_HOURS = 24


async def sweep_stale(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """Housekeeping for rows nobody will come back to:
    - Create-a-move-in-steps drafts still in preview/failed and untouched
      (progress_at, else created_at) for 24 hours — deleted;
    - move-setup file checks no live draft points at any more (replaced,
      skipped, or their draft is gone), unless the worker is still on one —
      deleted;
    - bulk asset update previews abandoned for 24 hours — cancelled, their
      parsed file dropped (error "expired")."""
    cutoff = (now or datetime.now(UTC)) - timedelta(hours=STALE_DRAFT_HOURS)
    touched = func.coalesce(ImportJob.progress_at, ImportJob.created_at)
    drafts = (await db.execute(
        delete(ImportJob).where(ImportJob.kind == "move_setup",
                                ImportJob.status.in_(("preview", "failed")),
                                touched < cutoff)
        .returning(ImportJob.id))).scalars().all()
    live = aliased(ImportJob)
    referenced = select(live.id).where(
        live.kind == "move_setup",
        live.payload["assets"]["check_job_id"].astext == cast(ImportJob.id, String))
    checks = (await db.execute(
        delete(ImportJob).where(ImportJob.kind == "move_assets",
                                ImportJob.initiative_id.is_(None),
                                ImportJob.options["move_setup_id"].astext.is_not(None),
                                ImportJob.status != "running",
                                ~referenced.exists())
        .returning(ImportJob.id))).scalars().all()
    previews = (await db.execute(
        update(ImportJob).where(ImportJob.kind == "asset_bulk_update",
                                ImportJob.status == "preview", touched < cutoff)
        .values(status="cancelled", error="expired", payload=None, finished_at=func.now())
        .returning(ImportJob.id))).scalars().all()
    await db.commit()
    return {"drafts": len(drafts), "checks": len(checks), "previews": len(previews)}
```

  The `EXISTS` must correlate to the outer `import_jobs`. If SQLAlchemy does not auto-correlate inside the DELETE, add `.correlate(ImportJob)` to `referenced`. The test's `fresh_check` assertion catches the uncorrelated form, which deletes nothing.

- [ ] **Step 6: Run the tests:** `tests/test_move_setup_worker.py tests/test_move_setup_api.py tests/test_import_worker.py tests/test_asset_bulk_update_apply.py tests/test_asset_bulk_update_api.py tests/test_cli_import_worker.py tests/test_move_asset_import_commit.py`. Expected: all PASS. Then run ruff on the changed files.
- [ ] **Step 7: Commit** `feat(api): the import worker creates a move from its draft in one transaction — progress, failure codes, 24-hour sweep`.

---

### Task 4: Portal foundation — client, naming rule, errors, header and footer, page shell, card, route, `InitiativeFields`, `MoveStep`

**Files:**
- Modify: `portal/src/lib/api.ts` (move-setup types and calls; `ImportJobOut.options.move_setup_id?`)
- Modify: `portal/src/lib/moveAssetImport.ts` (`IMPORT_ERRORS.check_only`)
- Create: `portal/src/lib/namingConvention.ts` and `.test.ts`
- Create: `portal/src/lib/moveSetup.ts` and `.test.ts`
- Create: `portal/src/lib/useLeaveGuard.ts`
- Create: `portal/src/components/common/WizardHeader.tsx`, `WizardHeader.test.tsx`, `WizardFooter.tsx`
- Create: `portal/src/styles/wizard.css`, `portal/src/styles/moveSetup.css`
- Create: `portal/src/components/initiatives/InitiativeFields.tsx`; modify `InitiativeEditModal.tsx`
- Create: `portal/src/components/moveSetup/MoveStep.tsx`, `DiscardDialog.tsx`, `useSkip.ts`
- Create stubs, which Tasks 5–6 replace: `components/moveSetup/AssetsStep.tsx`, `CratesStep.tsx`, `TrucksStep.tsx`, `ReviewStep.tsx`
- Create: `portal/src/pages/BulkNewMove.tsx` and `.test.tsx`
- Modify: `portal/src/pages/BulkActions.tsx` (card), `pages/BulkActions.test.tsx` (one assertion), `portal/src/App.tsx` (route)

**Interfaces:**
- Consumes: the Task 2 route shapes.
- Produces:

```ts
// lib/api.ts
interface MoveSetupCrates { convention: string; count: number; start: number; container_type: string | null; tags: Record<string, number> }
interface MoveSetupTrucks { convention: string; count: number; start: number }
interface MoveSetupPayload { move: Record<string, unknown>; assets: { check_job_id: string; filename: string } | null; crates: MoveSetupCrates | null; trucks: MoveSetupTrucks | null }
interface MoveSetupNamesPreview { names: string[]; clashes: string[]; error: string | null }
interface MoveSetupResults { move_id?: string; assets?: ImportJobResults | null; crates?: number; trucks?: number; reasons?: string[] }
type MoveSetupStatus = 'preview' | 'queued' | 'running' | 'completed' | 'failed'
interface MoveSetupDraft { id; status: MoveSetupStatus; error: string | null; payload: MoveSetupPayload | null; initiative_id: string | null; total_rows: number; processed_rows: number; results: MoveSetupResults | null; created_at: string; previews: { crates: MoveSetupNamesPreview | null; trucks: MoveSetupNamesPreview | null } | null }
interface MoveSetupPatch { move?: Record<string, unknown>; crates?: MoveSetupCrates; trucks?: MoveSetupTrucks; skip?: SkippableSection[] }
createMoveSetup(move) / getMoveSetup(id) / patchMoveSetup(id, body) → Promise<MoveSetupDraft>
uploadMoveSetupAssets(id, file, { makeModelMode, generateSerials }) / recheckMoveSetupAssets(id) → Promise<ImportJobOut>
createMoveFromSetup(id) → Promise<MoveSetupDraft>
deleteMoveSetup(id, { keepalive? }) → Promise<void>     // a 404 counts as done

// lib/namingConvention.ts
CRATE_MAX = 500; TRUCK_MAX = 100
interface Convention { prefix; width; suffix }; interface NamingValue { convention: string; count: string; start: string }
NAMING_MESSAGES; countMessage(max): string
parseConvention(text): Convention | { error: string }
toWhole(text): number | null
generateNames(convention, count, start, max): { names: string[]; error: string | null }
namingResult(value: NamingValue, max): { names: string[]; error: string | null }
defaultConvention(kind: 'CRT' | 'TRK', originCode?, destinationCode?): string
namesPreview(names): string
clashSentence(noun, names, limit = 10): string

// lib/moveSetup.ts
MOVE_SETUP_STEPS: readonly { key; label; title; description }[]   // 5 steps
type SkippableSection = 'assets' | 'crates' | 'trucks'
interface CratesValue extends NamingValue { container_type: string; tags: TagCounts }; type TrucksValue = NamingValue
interface MoveSetupLookups { statuses; types; subTypes; shippingTypes; sites; clients; partners; containerTypes }
EMPTY_LOOKUPS
movePayload(form): Record<string, unknown>
missingMoveFields(form): string | null
initialCrates(origin?, destination?): CratesValue; initialTrucks(origin?, destination?): TrucksValue
cratesBody(value): MoveSetupCrates; trucksBody(value): MoveSetupTrucks
MOVE_SETUP_ERRORS; moveSetupError(err): string; setupReasons(err): string[]
interface MoveAssetSummaryRow extends BulkSummaryRow { asset_id: string | null; message: string }
assetSummary(results: ImportJobResults): BulkSummaryResult<MoveAssetSummaryRow>
createdCount(n, noun): string
moveSummaryRows(form, lookups): [string, string][]

// lib/useLeaveGuard.ts
useLeaveGuard(active: boolean, onAttempt: (to: string) => void): void

// components
WizardHeader({ steps, current, title, description, allDone?, eyebrow? = 'Bulk Actions' })
WizardFooter({ onBack?, onSkip?, onNext, nextLabel? = 'Next', nextDisabled?, busy?, error?, note? })
InitiativeFields(props: InitiativeFieldsProps); FALLBACK_COLOR; useNextColorSeed(active, setForm)
MoveStep({ form, setForm, lookups, draft, onDraft, onNext })
DiscardDialog({ busy, onDiscard, onKeep })
useSkip(onSkip: () => Promise<void>, setError): { skipping: boolean; skip: () => void }
```

- [ ] **Step 1: API client.** Append to `lib/api.ts`, after the move-assets import block:

```ts
// ── Bulk Actions › Create a move in steps ───────────────────────────
// One server-side draft holds every step; nothing real is created until
// createMoveFromSetup, which the import worker runs as one transaction.

export interface MoveSetupCrates {
  convention: string; count: number; start: number;
  container_type: string | null; tags: Record<string, number>;
}
export interface MoveSetupTrucks { convention: string; count: number; start: number }
export interface MoveSetupPayload {
  move: Record<string, unknown>;
  assets: { check_job_id: string; filename: string } | null;
  crates: MoveSetupCrates | null;
  trucks: MoveSetupTrucks | null;
}
export interface MoveSetupNamesPreview { names: string[]; clashes: string[]; error: string | null }
/** Success carries move_id…trucks; a failure carries only `reasons`. */
export interface MoveSetupResults {
  move_id?: string; assets?: ImportJobResults | null; crates?: number; trucks?: number;
  reasons?: string[];
}
export type MoveSetupStatus = 'preview' | 'queued' | 'running' | 'completed' | 'failed';
export interface MoveSetupDraft {
  id: string; status: MoveSetupStatus; error: string | null;
  payload: MoveSetupPayload | null; initiative_id: string | null;
  total_rows: number; processed_rows: number;
  results: MoveSetupResults | null; created_at: string;
  previews: { crates: MoveSetupNamesPreview | null; trucks: MoveSetupNamesPreview | null } | null;
}
export interface MoveSetupPatch {
  move?: Record<string, unknown>; crates?: MoveSetupCrates; trucks?: MoveSetupTrucks;
  skip?: ('assets' | 'crates' | 'trucks')[];
}

async function moveSetupCall<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await apiFetch(`/bulk/move-setup${path}`, init);
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
const jsonInit = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

export const createMoveSetup = (move: Record<string, unknown>) =>
  moveSetupCall<MoveSetupDraft>('', jsonInit('POST', move));
export const getMoveSetup = (id: string) => moveSetupCall<MoveSetupDraft>(`/${id}`);
export const patchMoveSetup = (id: string, body: MoveSetupPatch) =>
  moveSetupCall<MoveSetupDraft>(`/${id}`, jsonInit('PATCH', body));
export async function uploadMoveSetupAssets(
  id: string, file: File, opts: { makeModelMode: string; generateSerials: boolean },
): Promise<ImportJobOut> {
  const form = new FormData();
  form.append('file', file);
  form.append('make_model_mode', opts.makeModelMode);
  form.append('generate_serials', String(opts.generateSerials));
  return moveSetupCall<ImportJobOut>(`/${id}/assets`, { method: 'POST', body: form });
}
export const recheckMoveSetupAssets = (id: string) =>
  moveSetupCall<ImportJobOut>(`/${id}/assets/recheck`, { method: 'POST' });
export const createMoveFromSetup = (id: string) =>
  moveSetupCall<MoveSetupDraft>(`/${id}/create`, { method: 'POST' });
/** A 404 means it is already gone — the goal either way. `keepalive` lets
 *  the request outlive the page (the wizard's unmount cleanup). */
export async function deleteMoveSetup(id: string, opts: { keepalive?: boolean } = {}): Promise<void> {
  const resp = await apiFetch(`/bulk/move-setup/${id}`,
    { method: 'DELETE', keepalive: opts.keepalive });
  if (!resp.ok && resp.status !== 404) throw await errorFrom(resp);
}
```

  Add `move_setup_id?: string;` to `ImportJobOut.options`. Add `check_only: "This file check belongs to a move setup. Its rows are imported when the move is created."` to `IMPORT_ERRORS` in `lib/moveAssetImport.ts`.

- [ ] **Step 2: Write the failing test** `lib/namingConvention.test.ts`. It mirrors the API test's cases word for word:

```ts
import { describe, expect, it } from 'vitest';

import {
  CRATE_MAX, TRUCK_MAX, clashSentence, defaultConvention, generateNames, namesPreview,
  namingResult, parseConvention,
} from './namingConvention';

describe('parseConvention', () => {
  it('splits prefix, run and suffix', () => {
    expect(parseConvention('CRT-SJC-DAL-xxx')).toEqual({ prefix: 'CRT-SJC-DAL-', width: 3, suffix: '' });
    expect(parseConvention('  A-XX-B ')).toEqual({ prefix: 'A-', width: 2, suffix: '-B' });
  });
  it.each([
    ['', 'Enter a naming convention, like CRT-xxx.'],
    ['CRT-001', "Mark the number with a run of x's, like CRT-xxx."],
    ['BOX-xxx', "Use only one run of x's for the number."],
    ['xx-XX', "Use only one run of x's for the number."],
  ])('%j → %s', (text, message) => {
    expect(parseConvention(text)).toEqual({ error: message });
  });
});

describe('generateNames', () => {
  it('pads to the run and never truncates', () => {
    expect(generateNames('CRT-xxx', 3, 1, CRATE_MAX).names).toEqual(['CRT-001', 'CRT-002', 'CRT-003']);
    expect(generateNames('T-x-B', 3, 9, TRUCK_MAX).names).toEqual(['T-9-B', 'T-10-B', 'T-11-B']);
    expect(generateNames('CRT-xx', 1, 1234, CRATE_MAX).names).toEqual(['CRT-1234']);
    expect(generateNames('CRT-xxx', 0, 1, CRATE_MAX)).toEqual({ names: [], error: null });
  });
  it.each([
    [501, 1, CRATE_MAX, 'The count must be between 0 and 500.'],
    [101, 1, TRUCK_MAX, 'The count must be between 0 and 100.'],
    [3, -1, CRATE_MAX, "The start number can't be below 0."],
  ])('count %i start %i → %s', (count, start, max, message) => {
    expect(generateNames('CRT-xxx', count, start, max)).toEqual({ names: [], error: message });
  });
  it('checks the convention before the count', () => {
    expect(generateNames('CRT', 999, -5, CRATE_MAX).error).toBe("Mark the number with a run of x's, like CRT-xxx.");
  });
});

describe('namingResult', () => {
  it('reads typed text and reports a blank count or start', () => {
    expect(namingResult({ convention: 'CRT-xxx', count: '2', start: '5' }, CRATE_MAX).names).toEqual(['CRT-005', 'CRT-006']);
    expect(namingResult({ convention: 'CRT-xxx', count: '', start: '1' }, CRATE_MAX).error).toBe('The count must be between 0 and 500.');
    expect(namingResult({ convention: 'CRT-xxx', count: '2', start: '' }, CRATE_MAX).error).toBe('Enter a start number.');
    expect(namingResult({ convention: 'CRT', count: '', start: '' }, CRATE_MAX).error).toBe("Mark the number with a run of x's, like CRT-xxx.");
  });
});

describe('defaultConvention', () => {
  it('uses both site codes, else falls back', () => {
    expect(defaultConvention('CRT', 'SJC', 'DAL')).toBe('CRT-SJC-DAL-xxx');
    expect(defaultConvention('TRK', 'SJC', 'DAL')).toBe('TRK-SJC-DAL-xxx');
    expect(defaultConvention('CRT', 'SJC', null)).toBe('CRT-xxx');
    expect(defaultConvention('TRK', '  ', 'DAL')).toBe('TRK-xxx');
    expect(defaultConvention('CRT', 'XYZ', 'DAL')).toBe('CRT-xxx');   // an x would add a second run
  });
});

it('namesPreview and clashSentence', () => {
  expect(namesPreview(['A', 'B', 'C', 'D'])).toBe('A, B, C, D');
  expect(namesPreview(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C … E');
  expect(clashSentence('crate', ['A', 'B'])).toBe('These crate names already exist: A, B.');
  const many = Array.from({ length: 12 }, (_, i) => `T-${i}`);
  expect(clashSentence('truck', many)).toBe(
    'These truck names already exist: T-0, T-1, T-2, T-3, T-4, T-5, T-6, T-7, T-8, T-9, and 2 more.');
});
```

- [ ] **Step 3: Run it and confirm it fails** (`npx vitest run src/lib/namingConvention.test.ts`: cannot resolve `./namingConvention`). Then implement `lib/namingConvention.ts`:

```ts
/**
 * The naming-convention rule for Create a move in steps (crates and
 * trucks). Mirrors api/src/serversherpa/imports/naming.py exactly — every
 * sentence too — so the live preview never disagrees with the server. A
 * convention is literal text with exactly one run of x's (either case); the
 * run's length is the zero-padding and a longer number is never truncated.
 */
export const CRATE_MAX = 500;
export const TRUCK_MAX = 100;

export interface Convention { prefix: string; width: number; suffix: string }
/** The step's fields as typed text, so a field can be emptied mid-edit. */
export interface NamingValue { convention: string; count: string; start: string }

export const NAMING_MESSAGES = {
  convention_required: 'Enter a naming convention, like CRT-xxx.',
  no_number: "Mark the number with a run of x's, like CRT-xxx.",
  many_numbers: "Use only one run of x's for the number.",
  start_negative: "The start number can't be below 0.",
  start_blank: 'Enter a start number.',
} as const;

export const countMessage = (max: number) => `The count must be between 0 and ${max}.`;

export function parseConvention(text: string): Convention | { error: string } {
  const value = text.trim();
  if (!value) return { error: NAMING_MESSAGES.convention_required };
  const runs = [...value.matchAll(/[xX]+/g)];
  if (runs.length === 0) return { error: NAMING_MESSAGES.no_number };
  if (runs.length > 1) return { error: NAMING_MESSAGES.many_numbers };
  const run = runs[0]!;
  const at = run.index ?? 0;
  return { prefix: value.slice(0, at), width: run[0].length, suffix: value.slice(at + run[0].length) };
}

/** A whole number typed into a field, or null for blank / anything else. */
export function toWhole(text: string): number | null {
  return /^\s*-?\d+\s*$/.test(text) ? Number(text.trim()) : null;
}

export function generateNames(
  convention: string, count: number, start: number, max: number,
): { names: string[]; error: string | null } {
  const rule = parseConvention(convention);
  if ('error' in rule) return { names: [], error: rule.error };
  if (count < 0 || count > max) return { names: [], error: countMessage(max) };
  if (start < 0) return { names: [], error: NAMING_MESSAGES.start_negative };
  const names = Array.from({ length: count },
    (_, i) => `${rule.prefix}${String(start + i).padStart(rule.width, '0')}${rule.suffix}`);
  return { names, error: null };
}

/** generateNames over typed text: convention first, then count, then start. */
export function namingResult(value: NamingValue, max: number): { names: string[]; error: string | null } {
  const rule = parseConvention(value.convention);
  if ('error' in rule) return { names: [], error: rule.error };
  const count = toWhole(value.count);
  if (count === null) return { names: [], error: countMessage(max) };
  const start = toWhole(value.start);
  if (start === null) return { names: [], error: NAMING_MESSAGES.start_blank };
  return generateNames(value.convention, count, start, max);
}

/** The prefill: KIND-{origin code}-{destination code}-xxx, or KIND-xxx when a
 *  code is missing — or contains an x, which would add a second run. */
export function defaultConvention(
  kind: 'CRT' | 'TRK', originCode?: string | null, destinationCode?: string | null,
): string {
  const codes = [(originCode ?? '').trim(), (destinationCode ?? '').trim()];
  if (codes.every((c) => c !== '' && !/x/i.test(c))) return `${kind}-${codes[0]}-${codes[1]}-xxx`;
  return `${kind}-xxx`;
}

/** First three names, an ellipsis, and the last; every name when there are four or fewer. */
export function namesPreview(names: string[]): string {
  if (names.length <= 4) return names.join(', ');
  return `${names.slice(0, 3).join(', ')} … ${names[names.length - 1]}`;
}

/** The API's clash_sentence, word for word. */
export function clashSentence(noun: string, names: string[], limit = 10): string {
  const more = names.length > limit ? `, and ${names.length - limit} more` : '';
  return `These ${noun} names already exist: ${names.slice(0, limit).join(', ')}${more}.`;
}
```

  Run the test again and confirm it passes.

- [ ] **Step 4: `lib/moveSetup.ts`.** Write `lib/moveSetup.test.ts` first:

```ts
import { describe, expect, it } from 'vitest';

import { ApiError, type ImportJobResults } from './api';
import { formFromInitiative } from './initiatives';
import {
  assetSummary, cratesBody, createdCount, initialCrates, missingMoveFields, MOVE_SETUP_ERRORS,
  MOVE_SETUP_STEPS, moveSetupError, movePayload, setupReasons,
} from './moveSetup';

const form = () => ({ ...formFromInitiative(null), initiative_type: 'move' });

it('has five steps in order', () => {
  expect(MOVE_SETUP_STEPS.map((s) => s.title)).toEqual(
    ['The move', 'From-To assets', 'Crates', 'Trucks', 'Review and create']);
});

it('always posts a move', () => {
  expect(movePayload({ ...form(), initiative_type: 'project', name: ' A ' })).toMatchObject(
    { initiative_type: 'move', name: 'A' });
});

it('names what the move is missing as one sentence', () => {
  expect(missingMoveFields(form())).toBe(
    'The move needs a name, an origin site, and a destination site.');
  expect(missingMoveFields({ ...form(), name: 'A', origin_site_id: 's1' })).toBe(
    'The move needs a destination site.');
  expect(missingMoveFields({ ...form(), name: 'A', origin_site_id: 's1', destination_site_id: 's2' })).toBeNull();
});

it('prefills crates from the site codes and builds the request body', () => {
  const value = initialCrates({ code: 'SJC' } as never, { code: 'DAL' } as never);
  expect(value).toEqual({ convention: 'CRT-SJC-DAL-xxx', count: '0', start: '1', container_type: '', tags: {} });
  expect(cratesBody({ ...value, count: '3', container_type: 'pallet', tags: { priority: 1 } })).toEqual({
    convention: 'CRT-SJC-DAL-xxx', count: 3, start: 1, container_type: 'pallet',
    tags: { priority: 1, vendor: 0, accessories: 0, warehouse: 0, ewaste: 0 },
  });
});

describe('errors', () => {
  it('covers every code the routes and the worker return', () => {
    for (const code of ['draft_not_found', 'draft_not_editable', 'setup_invalid', 'name_taken',
      'apply_conflict', 'worker_error', 'forbidden', 'origin_required', 'destination_required',
      'no_asset_file', 'bad_container_type', 'bad_tag_key', 'tags_exceed_count']) {
      expect(MOVE_SETUP_ERRORS[code], code).toMatch(/\.$/);
    }
  });
  it('prefers the naming sentence, then the maps', () => {
    expect(moveSetupError(new ApiError(422, 'invalid_naming', { code: 'invalid_naming', message: "Use only one run of x's for the number." })))
      .toBe("Use only one run of x's for the number.");
    expect(moveSetupError(new ApiError(422, 'site_not_found'))).toBe('Pick a site from the list.');
    expect(moveSetupError(new ApiError(422, 'unsupported_file'))).toMatch(/csv/);
    expect(setupReasons(new ApiError(422, 'setup_invalid', { code: 'setup_invalid', reasons: ['Pick a crate type.'] })))
      .toEqual(['Pick a crate type.']);
  });
});

it('turns the import details into the per-row summary', () => {
  const results: ImportJobResults = { summary: {}, details: [
    { row: 2, serial_number: 'sn-1', status: 'created', message: 'Asset added to move', asset_id: 'a1' },
    { row: 3, serial_number: 'sn-2', status: 'review', message: "Make/Model 'X' not found — needs review" },
  ] };
  const out = assetSummary(results);
  expect([out.created, out.updated, out.skipped, out.unchanged]).toEqual([1, 0, 1, 0]);
  expect(out.rows[1]).toMatchObject({ row: 3, name: 'sn-2', action: 'skipped', asset_id: null });
  expect(createdCount(1, 'crate')).toBe('1 crate created');
  expect(createdCount(3, 'truck')).toBe('3 trucks created');
});
```

  Implement `lib/moveSetup.ts`:

```ts
/**
 * Create a move in steps — the wizard's pure helpers: the five steps, the
 * request bodies, the error sentences, and the finish screen's per-row
 * asset summary. Kept out of the components so they unit-test without jsdom.
 */
import type { BulkSummaryResult, BulkSummaryRow } from '../components/bulk/BulkApplySummary';
import {
  ApiError, type ImportJobResults, type MoveSetupCrates, type MoveSetupTrucks, type OrgRef,
  type SiteItem, type StatusValue,
} from './api';
import { TAG_ASSIGNMENT_ORDER, type TagCounts } from './bulkContainers';
import { INITIATIVE_ERRORS, initiativePayload, type InitiativeFormState } from './initiatives';
import { IMPORT_ERRORS } from './moveAssetImport';
import { defaultConvention, toWhole, type NamingValue } from './namingConvention';

export const MOVE_SETUP_STEPS = [
  { key: 'move', label: 'Move', title: 'The move',
    description: 'Name the move and pick where it starts and ends. Nothing is created until the last step.' },
  { key: 'assets', label: 'Assets', title: 'From-To assets',
    description: 'Upload the From-To file. It is checked now and imported when the move is created.' },
  { key: 'crates', label: 'Crates', title: 'Crates',
    description: "Name and count the crates for this move. The x's mark the number." },
  { key: 'trucks', label: 'Trucks', title: 'Trucks',
    description: 'Name and count the trucks. Each one runs from the origin to the destination.' },
  { key: 'review', label: 'Review', title: 'Review and create',
    description: 'Check everything, then create the move with its assets, crates, and trucks.' },
] as const;

export type SkippableSection = 'assets' | 'crates' | 'trucks';
export interface CratesValue extends NamingValue { container_type: string; tags: TagCounts }
export type TrucksValue = NamingValue;

export interface MoveSetupLookups {
  statuses: StatusValue[]; types: StatusValue[]; subTypes: StatusValue[];
  shippingTypes: StatusValue[]; sites: SiteItem[]; clients: OrgRef[]; partners: OrgRef[];
  containerTypes: StatusValue[];
}
export const EMPTY_LOOKUPS: MoveSetupLookups = {
  statuses: [], types: [], subTypes: [], shippingTypes: [], sites: [], clients: [],
  partners: [], containerTypes: [],
};

export function movePayload(form: InitiativeFormState): Record<string, unknown> {
  return { ...initiativePayload(form), initiative_type: 'move' };
}

export function missingMoveFields(form: InitiativeFormState): string | null {
  const missing = [
    !form.name.trim() ? 'a name' : null,
    !form.origin_site_id ? 'an origin site' : null,
    !form.destination_site_id ? 'a destination site' : null,
  ].filter((m): m is string => m !== null);
  if (missing.length === 0) return null;
  const list = missing.length === 1 ? missing[0]
    : missing.length === 2 ? `${missing[0]} and ${missing[1]}`
    : `${missing.slice(0, -1).join(', ')}, and ${missing[missing.length - 1]}`;
  return `The move needs ${list}.`;
}

export function initialCrates(origin?: SiteItem | null, destination?: SiteItem | null): CratesValue {
  return { convention: defaultConvention('CRT', origin?.code, destination?.code),
           count: '0', start: '1', container_type: '', tags: {} };
}
export function initialTrucks(origin?: SiteItem | null, destination?: SiteItem | null): TrucksValue {
  return { convention: defaultConvention('TRK', origin?.code, destination?.code), count: '0', start: '1' };
}

export function cratesBody(value: CratesValue): MoveSetupCrates {
  return {
    convention: value.convention.trim(),
    count: toWhole(value.count) ?? 0,
    start: toWhole(value.start) ?? 0,
    container_type: value.container_type || null,
    tags: Object.fromEntries(TAG_ASSIGNMENT_ORDER.map((key) => [key, value.tags[key] ?? 0])),
  };
}
export function trucksBody(value: TrucksValue): MoveSetupTrucks {
  return { convention: value.convention.trim(), count: toWhole(value.count) ?? 0,
           start: toWhole(value.start) ?? 0 };
}

export const MOVE_SETUP_ERRORS: Record<string, string> = {
  draft_not_found: 'This move setup is gone. It may have expired after a day without changes. Start again.',
  draft_not_editable: 'This move is already being created.',
  setup_invalid: 'Some steps need attention before the move can be created.',
  name_taken: 'Some crate or truck names were taken while the move was being created. Nothing was created. Change the names and try again.',
  apply_conflict: 'Another change landed while the move was being created. Nothing was created. Try again.',
  worker_error: 'Something went wrong while creating the move. Nothing was created. Try again.',
  forbidden: 'You need permission to add moves, containers, and trucks to use this tool.',
  name_required: 'The move needs a name.',
  origin_required: 'Pick an origin site.',
  destination_required: 'Pick a destination site.',
  invalid_naming: 'Check the naming convention.',
  bad_container_type: 'Pick a crate type from the list.',
  bad_tag_key: 'Pick label tags from the list.',
  tags_exceed_count: "Label tag counts can't add up to more than the crate count.",
  no_asset_file: 'Upload a From-To file first.',
};

export function moveSetupError(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Network error. Try again.';
  if (err.code === 'invalid_naming') {
    const message = (err.detail as { message?: string } | undefined)?.message;
    if (message) return message;
  }
  return MOVE_SETUP_ERRORS[err.code] ?? INITIATIVE_ERRORS[err.code] ?? IMPORT_ERRORS[err.code]
    ?? 'Something went wrong. Try again.';
}

/** The reasons a 422 setup_invalid lists, as sentences. */
export function setupReasons(err: unknown): string[] {
  if (!(err instanceof ApiError) || err.code !== 'setup_invalid') return [];
  return (err.detail as { reasons?: string[] } | undefined)?.reasons ?? [];
}

export interface MoveAssetSummaryRow extends BulkSummaryRow { asset_id: string | null; message: string }

/** The From-To import's details as BulkApplySummary rows: created → Added,
 *  updated → Updated, review/error → Skipped (they were not imported). */
export function assetSummary(results: ImportJobResults): BulkSummaryResult<MoveAssetSummaryRow> {
  const rows = results.details.map((d): MoveAssetSummaryRow => ({
    row: d.row, name: d.serial_number || null,
    action: d.status === 'created' ? 'created' : d.status === 'updated' ? 'updated' : 'skipped',
    diff: null, asset_id: d.asset_id ?? null, message: d.message,
  }));
  const n = (action: MoveAssetSummaryRow['action']) => rows.filter((r) => r.action === action).length;
  return { created: n('created'), updated: n('updated'), skipped: n('skipped'), unchanged: 0, rows };
}

export const createdCount = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'} created`;

export function moveSummaryRows(form: InitiativeFormState, lookups: MoveSetupLookups): [string, string][] {
  const named = (list: { id: string; name: string }[], id: string) =>
    list.find((x) => x.id === id)?.name ?? '';
  const label = (list: StatusValue[], key: string) => list.find((s) => s.key === key)?.label ?? key;
  const dates = [form.scheduled_start, form.scheduled_end].filter(Boolean).join(' to ');
  return [
    ['Name', form.name.trim()],
    ['Status', label(lookups.statuses, form.status)],
    ['Client', named(lookups.clients, form.client_id) || '—'],
    ['Scheduled', dates || '—'],
    ['Origin', named(lookups.sites, form.origin_site_id) || '—'],
    ['Destination', named(lookups.sites, form.destination_site_id) || '—'],
    ['Shipping types', form.shipping_types.map((k) => label(lookups.shippingTypes, k)).join(', ') || '—'],
  ];
}
```

  Run `npx vitest run src/lib/moveSetup.test.ts src/lib/namingConvention.test.ts`. Expected: PASS.

- [ ] **Step 5: Header, footer and CSS.** Write `components/common/WizardHeader.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import { MOVE_SETUP_STEPS } from '../../lib/moveSetup';
import WizardHeader from './WizardHeader';

afterEach(cleanup);

it('shows the eyebrow, "Step x of 5 · title", the description, and done/current/upcoming steps', () => {
  const { container } = render(<WizardHeader steps={MOVE_SETUP_STEPS} current={2}
    title="Crates" description="Name and count the crates." />);
  expect(screen.getByText('Bulk Actions')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Step 3 of 5 · Crates' })).toBeTruthy();
  expect(screen.getByText('Name and count the crates.')).toBeTruthy();
  const items = [...container.querySelectorAll('.rgm-step')];
  expect(items.map((i) => i.classList.contains('done'))).toEqual([true, true, false, false, false]);
  expect(items[2]!.classList.contains('on')).toBe(true);
  expect(items[2]!.getAttribute('aria-current')).toBe('step');
  expect(items.map((i) => i.textContent)).toEqual(['1Move', '2Assets', '3Crates', '4Trucks', '5Review']);
});

it('marks every step done once the wizard has finished', () => {
  const { container } = render(<WizardHeader steps={MOVE_SETUP_STEPS} current={4}
    title="Review and create" description="d" allDone />);
  expect([...container.querySelectorAll('.rgm-step.done')]).toHaveLength(5);
});
```

  Implement `WizardHeader.tsx`:

```tsx
/**
 * WizardHeader — the page-level header every multi-screen tool shares: an
 * eyebrow, "Step x of N · Title", a one-line description, and the numbered
 * step row in Generate Report's `rgm-steps` look (done / current / upcoming).
 */
import { Fragment } from 'react';

import '../../styles/reports.css';   // rgm-steps / rgm-step
import '../../styles/wizard.css';

export interface WizardStep { key: string; label: string }

interface Props {
  steps: readonly WizardStep[];
  current: number;            // 0-based
  title: string;
  description: string;
  allDone?: boolean;
  eyebrow?: string;
}

export default function WizardHeader({
  steps, current, title, description, allDone = false, eyebrow = 'Bulk Actions',
}: Props) {
  return (
    <div className="wiz-top">
      <div className="eyebrow">{eyebrow}</div>
      <h1 className="page-title">Step {current + 1} of {steps.length} · {title}</h1>
      <p className="page-hint">{description}</p>
      <div className="rgm-steps wiz-steps">
        {steps.map((s, i) => (
          <Fragment key={s.key}>
            {i > 0 && <span className="rgm-step-sep" />}
            <span className={`rgm-step ${i === current && !allDone ? 'on' : ''} ${
              i < current || allDone ? 'done' : ''}`}
                  aria-current={i === current ? 'step' : undefined}>
              <span className="rgm-step-num">{i + 1}</span>
              <span className="rgm-step-label">{s.label}</span>
            </span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
```

  `WizardFooter.tsx`:

```tsx
/** WizardFooter — Back, Skip this step (only when the step can be skipped),
 *  an optional hint, the error line, and the primary Next on the right. */
import type { ReactNode } from 'react';

import '../../styles/wizard.css';

interface Props {
  onBack?: () => void;
  onSkip?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  busy?: boolean;
  error?: string;
  note?: ReactNode;
}

export default function WizardFooter({
  onBack, onSkip, onNext, nextLabel = 'Next', nextDisabled = false, busy = false, error, note,
}: Props) {
  return (
    <div className="wiz-foot">
      {onBack && <button className="mini-btn" type="button" disabled={busy} onClick={onBack}>Back</button>}
      {onSkip && <button className="mini-btn" type="button" disabled={busy} onClick={onSkip}>Skip this step</button>}
      {note && <span className="page-hint">{note}</span>}
      {error && <span className="pf-error">{error}</span>}
      <button className="btn-solid wiz-next" type="button" disabled={busy || nextDisabled}
              onClick={onNext}>
        {nextLabel}
      </button>
    </div>
  );
}
```

  `styles/wizard.css`:

```css
/* WizardHeader / WizardFooter — page-level wizard chrome. The step row
   borrows Generate Report's rgm-steps (reports.css); these rules only seat
   it on a page instead of a modal. No typography here: list typography is
   directory.css's alone (styles/listTypography.test.ts). */
.wiz-top { display: flex; flex-direction: column; gap: 6px; }
.wiz-steps { margin-top: 10px; border: 1px solid var(--paper-line); border-radius: 12px; flex-wrap: wrap; }
.wiz-body { margin-top: 18px; display: flex; flex-direction: column; gap: 16px; }
.wiz-foot {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin-top: 8px; padding-top: 14px; border-top: 1px solid var(--paper-line);
}
.wiz-foot .wiz-next { margin-left: auto; }
```

  `styles/moveSetup.css`:

```css
/* Create a move in steps — layout only (see wizard.css on typography). */
.ms-naming { grid-template-columns: repeat(2, minmax(0, 220px)); }
.ms-names { display: flex; flex-direction: column; gap: 4px; }
.ms-type { grid-template-columns: minmax(0, 320px); }
.ms-reasons { margin: 4px 0 0; padding-left: 18px; }
.ms-discard-card { width: min(460px, 92vw); }
```

  Run the header test and `npx vitest run src/styles/listTypography.test.ts`. Expected: PASS.

- [ ] **Step 6: Extract `InitiativeFields`.** Create `components/initiatives/InitiativeFields.tsx`:

```tsx
/**
 * InitiativeFields — every "New initiative" field, shared by
 * InitiativeEditModal and Create a move in steps' first screen. Renders the
 * modal-section headings and pf-form grids only (no modal chrome, no
 * buttons); the caller owns the form state and the save.
 */
import { useEffect, type Dispatch, type SetStateAction } from 'react';

import {
  getNextInitiativeColor, type InitiativeItem, type OrgRef, type SiteItem, type StatusValue,
} from '../../lib/api';
import {
  partnerOptionsForRole, sectionsForType, siteOptionsForClient, type InitiativeFormState,
} from '../../lib/initiatives';
import ColorWheel from '../ColorWheel';
import ComboBox from '../ComboBox';

/** What the wheel opens on while the next-color lookup is in flight or
 *  after it failed (the server assigns a color on create anyway). */
export const FALLBACK_COLOR = '#1668a7';

/** Create mode opens the wheel on the color a create would assign; a user
 *  who spins first keeps their own choice. */
export function useNextColorSeed(
  active: boolean, setForm: Dispatch<SetStateAction<InitiativeFormState>>,
): void {
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    const seed = (hex: string) =>
      alive && setForm((f) => (f.color ? f : { ...f, color: hex }));
    void getNextInitiativeColor().then(seed).catch(() => seed(FALLBACK_COLOR));
    return () => { alive = false; };
  }, [active, setForm]);
}

export interface InitiativeFieldsProps {
  form: InitiativeFormState;
  setForm: Dispatch<SetStateAction<InitiativeFormState>>;
  initiative: InitiativeItem | null;       // seeds retired vocab values back in
  statuses: StatusValue[]; types: StatusValue[]; subTypes: StatusValue[];
  shippingTypes: StatusValue[];
  sites: SiteItem[]; clients: OrgRef[]; partners: OrgRef[];
  locked: boolean;
  typeLocked: boolean;
  typeHint?: string;
  colorHint?: string;
  wheelColor: string;
}

export default function InitiativeFields({
  form, setForm, initiative, statuses, types, subTypes, shippingTypes, sites, clients,
  partners, locked, typeLocked, typeHint, colorHint, wheelColor,
}: InitiativeFieldsProps) {
  const sections = sectionsForType(form.initiative_type);
  // setField / setFlag / toggleShipping / seedOption / statusOptions /
  // typeOptions / subTypeOptions / siteOptions / orgOptions / partnerCombo:
  // moved verbatim from InitiativeEditModal.tsx lines 92–126 and 163–176.
  return (
    <>
      {/* InitiativeEditModal.tsx lines 197–395 (everything inside
          <div className="modal-body">), moved verbatim, with exactly two
          substitutions:
          - the Type hint `{!isCreateMode && !isAdmin && (<span …>Only admins can
            change the type.</span>)}` → `{typeHint && <span className="page-hint">{typeHint}</span>}`
          - the Color hint `{isCreateMode && (<span …>Assigned automatically — spin
            the wheel to choose your own.</span>)}` → `{colorHint && <span className="page-hint">{colorHint}</span>}` */}
    </>
  );
}
```

  Then slim `InitiativeEditModal.tsx`:
  - Replace its seeding `useEffect` with `useNextColorSeed(isCreateMode, setForm)`.
  - Drop the moved helpers and the local `FALLBACK_COLOR`; import both from `./InitiativeFields`.
  - Replace the body of `<div className="modal-body">` with:

```tsx
          <div className="modal-body">
            <InitiativeFields
              form={form} setForm={setForm} initiative={initiative}
              statuses={statuses} types={types} subTypes={subTypes}
              shippingTypes={shippingTypes} sites={sites} clients={clients} partners={partners}
              locked={locked} typeLocked={typeLocked} wheelColor={wheelColor}
              typeHint={!isCreateMode && !isAdmin ? 'Only admins can change the type.' : undefined}
              colorHint={isCreateMode
                ? 'Assigned automatically — spin the wheel to choose your own.' : undefined}
            />
          </div>
```

  Run `npx vitest run src/components/initiatives/InitiativeEditModal.test.tsx` **unchanged**. Expected: PASS.

- [ ] **Step 7: `useLeaveGuard`, `DiscardDialog`, `useSkip`, `MoveStep`.** Create `lib/useLeaveGuard.ts`:

```ts
import { useEffect, useRef } from 'react';

/**
 * While `active`, a click on any in-app link is held and handed to
 * `onAttempt(to)` instead of navigating (the page asks first), and a reload
 * or tab close gets the browser's own "Leave site?" prompt. The app runs on
 * BrowserRouter, which has no navigation blocker, so links are caught in
 * the document's capture phase — before react-router's own handler. The
 * back button cannot be held; the page cleans up on unmount instead.
 */
export function useLeaveGuard(active: boolean, onAttempt: (to: string) => void): void {
  const attempt = useRef(onAttempt);
  attempt.current = onAttempt;
  useEffect(() => {
    if (!active) return undefined;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor || anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      attempt.current(`${url.pathname}${url.search}${url.hash}`);
    };
    const onUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    document.addEventListener('click', onClick, true);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('beforeunload', onUnload);
    };
  }, [active]);
}
```

  `components/moveSetup/DiscardDialog.tsx` follows the modal header pattern and sizes to its content:

```tsx
import '../../styles/reports.css';
import '../../styles/moveSetup.css';

interface Props { busy: boolean; onDiscard: () => void; onKeep: () => void }

export default function DiscardDialog({ busy, onDiscard, onKeep }: Props) {
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onKeep(); }}>
      <div className="modal-card ms-discard-card" role="dialog" aria-modal="true"
           aria-labelledby="ms-discard-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Bulk Actions</div>
            <h3 id="ms-discard-title">Discard this move setup?</h3>
            <p className="page-hint">Nothing has been created yet. Discarding deletes what you entered on every step.</p>
          </div>
        </div>
        <div className="modal-foot">
          <button className="mini-btn danger" type="button" disabled={busy} onClick={onDiscard}>
            {busy ? 'Discarding…' : 'Discard'}
          </button>
          <button className="btn-solid" type="button" disabled={busy} onClick={onKeep}>Keep editing</button>
        </div>
      </div>
    </div>
  );
}
```

  `components/moveSetup/useSkip.ts`:

```ts
import { useState } from 'react';

import { moveSetupError } from '../../lib/moveSetup';

/** Skip this step: the page PATCHes skip and advances; a failure stays here. */
export function useSkip(onSkip: () => Promise<void>, setError: (message: string) => void) {
  const [skipping, setSkipping] = useState(false);
  const skip = () => {
    setSkipping(true);
    setError('');
    onSkip().catch((err) => { setError(moveSetupError(err)); setSkipping(false); });
  };
  return { skipping, skip };
}
```

  `components/moveSetup/MoveStep.tsx`:

```tsx
/** Step 1 — the full "New initiative" form for a move (type fixed). Next
 *  validates name + both sites, then creates the draft (or updates it after
 *  Back). Nothing else is written. */
import { useState, type Dispatch, type SetStateAction } from 'react';

import { createMoveSetup, patchMoveSetup, type MoveSetupDraft } from '../../lib/api';
import type { InitiativeFormState } from '../../lib/initiatives';
import {
  missingMoveFields, moveSetupError, movePayload, type MoveSetupLookups,
} from '../../lib/moveSetup';
import WizardFooter from '../common/WizardFooter';
import InitiativeFields, { FALLBACK_COLOR, useNextColorSeed } from '../initiatives/InitiativeFields';

interface Props {
  form: InitiativeFormState;
  setForm: Dispatch<SetStateAction<InitiativeFormState>>;
  lookups: MoveSetupLookups;
  draft: MoveSetupDraft | null;
  onDraft: (draft: MoveSetupDraft) => void;
  onNext: () => void;
}

export default function MoveStep({ form, setForm, lookups, draft, onDraft, onNext }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useNextColorSeed(true, setForm);

  const next = async () => {
    const missing = missingMoveFields(form);
    if (missing) { setError(missing); return; }
    setBusy(true);
    setError('');
    try {
      const body = movePayload(form);
      onDraft(draft ? await patchMoveSetup(draft.id, { move: body }) : await createMoveSetup(body));
      onNext();
    } catch (err) {
      setError(moveSetupError(err));
      setBusy(false);
    }
  };

  return (
    <>
      <section className="bulk-section">
        <InitiativeFields
          form={form} setForm={setForm} initiative={null}
          statuses={lookups.statuses} types={lookups.types} subTypes={lookups.subTypes}
          shippingTypes={lookups.shippingTypes} sites={lookups.sites}
          clients={lookups.clients} partners={lookups.partners}
          locked={busy} typeLocked typeHint="This tool always creates a move."
          colorHint="Assigned automatically — spin the wheel to choose your own."
          wheelColor={form.color || FALLBACK_COLOR}
        />
      </section>
      <WizardFooter onNext={() => void next()} busy={busy} error={error}
                    nextLabel={busy ? 'Saving…' : 'Next'} />
    </>
  );
}
```

- [ ] **Step 8: The page shell, card and route.** Write `pages/BulkNewMove.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { MoveSetupDraft, SiteItem, StatusValue } from '../lib/api';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 60, godMode: false,
    can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
const api = vi.hoisted(() => ({
  listSites: vi.fn(), listClients: vi.fn(), listPartners: vi.fn(),
  listInitiativeStatuses: vi.fn(), listInitiativeTypes: vi.fn(), listInitiativeSubTypes: vi.fn(),
  listShippingTypes: vi.fn(), listContainerTypes: vi.fn(),
  getNextInitiativeColor: vi.fn(), createMoveSetup: vi.fn(), patchMoveSetup: vi.fn(),
  getMoveSetup: vi.fn(), deleteMoveSetup: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
const { default: BulkNewMove } = await import('./BulkNewMove');

const SITES = [
  { id: 's-sjc', name: 'San Jose DC', code: 'SJC', archived_at: null, clients: [] },
  { id: 's-dal', name: 'Dallas DC', code: 'DAL', archived_at: null, clients: [] },
] as unknown as SiteItem[];

function draft(over: Partial<MoveSetupDraft> = {}): MoveSetupDraft {
  return {
    id: 'd1', status: 'preview', error: null, initiative_id: null, total_rows: 0,
    processed_rows: 0, results: null, created_at: '2026-09-24T00:00:00Z', previews: null,
    payload: { move: { name: 'SJC to DAL' }, assets: null, crates: null, trucks: null },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listSites.mockResolvedValue(SITES);
  for (const fn of [api.listClients, api.listPartners, api.listInitiativeStatuses,
    api.listInitiativeSubTypes, api.listShippingTypes, api.listContainerTypes]) {
    fn.mockResolvedValue([]);
  }
  api.listInitiativeTypes.mockResolvedValue([{ key: 'move', label: 'Move' }] as StatusValue[]);
  api.getNextInitiativeColor.mockResolvedValue('#8b3fb8');
  api.createMoveSetup.mockResolvedValue(draft());
  api.patchMoveSetup.mockResolvedValue(draft());
  api.deleteMoveSetup.mockResolvedValue(undefined);
});
afterEach(cleanup);

function mount() {
  return render(
    <MemoryRouter initialEntries={['/bulk/new-move']}>
      <Routes>
        <Route path="/bulk/new-move" element={<><Link to="/initiatives">Elsewhere</Link><BulkNewMove /></>} />
        <Route path="/initiatives" element={<p>Initiatives page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

const heading = (text: string) => screen.findByRole('heading', { name: text });

async function fillMove(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getAllByRole('textbox')[0]!, 'SJC to DAL');
  const [origin, destination] = screen.getAllByPlaceholderText('Type to search sites…');
  await user.click(origin!);
  await user.click(await screen.findByText('San Jose DC'));
  await user.click(destination!);
  await user.click(await screen.findByText('Dallas DC'));
}

it('step 1 names what is missing, then creates the draft as a move', async () => {
  const user = userEvent.setup();
  mount();
  await heading('Step 1 of 5 · The move');
  expect(screen.queryByRole('button', { name: 'Skip this step' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Next' }));
  expect(await screen.findByText('The move needs a name, an origin site, and a destination site.')).toBeTruthy();
  expect(api.createMoveSetup).not.toHaveBeenCalled();

  await fillMove(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await heading('Step 2 of 5 · From-To assets');
  expect(api.createMoveSetup).toHaveBeenCalledWith(expect.objectContaining({
    initiative_type: 'move', name: 'SJC to DAL',
    origin_site_id: 's-sjc', destination_site_id: 's-dal',
  }));
});

it('Back keeps what was entered and Next then updates the same draft', async () => {
  const user = userEvent.setup();
  mount();
  await heading('Step 1 of 5 · The move');
  await fillMove(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await heading('Step 2 of 5 · From-To assets');
  await user.click(screen.getByRole('button', { name: 'Back' }));
  await heading('Step 1 of 5 · The move');
  expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('SJC to DAL');
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await heading('Step 2 of 5 · From-To assets');
  expect(api.createMoveSetup).toHaveBeenCalledTimes(1);
  expect(api.patchMoveSetup).toHaveBeenCalledWith('d1', { move: expect.objectContaining({ name: 'SJC to DAL' }) });
});

it('Skip this step saves the skip and moves on, with crates prefilled from the site codes', async () => {
  const user = userEvent.setup();
  mount();
  await heading('Step 1 of 5 · The move');
  await fillMove(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await heading('Step 2 of 5 · From-To assets');
  await user.click(screen.getByRole('button', { name: 'Skip this step' }));
  await heading('Step 3 of 5 · Crates');
  expect(api.patchMoveSetup).toHaveBeenCalledWith('d1', { skip: ['assets'] });
  expect((screen.getByLabelText('Naming convention') as HTMLInputElement).value).toBe('CRT-SJC-DAL-xxx');
});

it('leaving with a draft open asks first, and Discard deletes the draft', async () => {
  const user = userEvent.setup();
  mount();
  await heading('Step 1 of 5 · The move');
  await user.click(screen.getByText('Elsewhere'));              // no draft yet: just leaves
  expect(await screen.findByText('Initiatives page')).toBeTruthy();
  cleanup();

  mount();
  await heading('Step 1 of 5 · The move');
  await fillMove(user);
  await user.click(screen.getByRole('button', { name: 'Next' }));
  await heading('Step 2 of 5 · From-To assets');
  await user.click(screen.getByText('Elsewhere'));
  expect(await screen.findByRole('heading', { name: 'Discard this move setup?' })).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.queryByText('Discard this move setup?')).toBeNull();
  await user.click(screen.getByText('Elsewhere'));
  await user.click(await screen.findByRole('button', { name: 'Discard' }));
  expect(await screen.findByText('Initiatives page')).toBeTruthy();
  await waitFor(() => expect(api.deleteMoveSetup).toHaveBeenCalledWith('d1'));
});
```

  Steps 2–5 are stubs in this task, each with its **final** Props interface (from Tasks 5 and 6), so the page never changes when they are replaced:
  - `AssetsStep` renders `<WizardFooter onBack={onBack} onSkip={() => void onSkip()} onNext={onNext} />`.
  - `CratesStep` and `TrucksStep` render the same footer, plus `<section className="bulk-section"><label htmlFor="crates-convention">Naming convention</label><input id="crates-convention" value={value.convention} readOnly /></section>` (and the `trucks-` equivalent).
  - `ReviewStep` renders `<WizardFooter onBack={onBack} onNext={() => undefined} nextLabel="Create move" />`.

  Implement `pages/BulkNewMove.tsx`:

```tsx
/**
 * BulkNewMove — /bulk/new-move, Bulk Actions › Create a move in steps.
 * Five screens share one WizardHeader and one footer idiom. The wizard's
 * state lives in a server-side draft (created on step 1's Next); nothing
 * real is created until Review › Create move. Leaving with a draft open
 * asks "Discard this move setup?" and deletes the draft on confirm; any
 * other unmount (the back button) deletes it without asking — a draft can
 * never be resumed, and the worker's 24-hour sweep is only the backstop.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import WizardHeader from '../components/common/WizardHeader';
import AssetsStep from '../components/moveSetup/AssetsStep';
import CratesStep from '../components/moveSetup/CratesStep';
import DiscardDialog from '../components/moveSetup/DiscardDialog';
import MoveStep from '../components/moveSetup/MoveStep';
import ReviewStep from '../components/moveSetup/ReviewStep';
import TrucksStep from '../components/moveSetup/TrucksStep';
import {
  deleteMoveSetup, listClients, listContainerTypes, listInitiativeStatuses,
  listInitiativeSubTypes, listInitiativeTypes, listPartners, listShippingTypes, listSites,
  patchMoveSetup, type ImportJobOut, type MoveSetupDraft,
} from '../lib/api';
import { formFromInitiative, type InitiativeFormState } from '../lib/initiatives';
import {
  EMPTY_LOOKUPS, initialCrates, initialTrucks, MOVE_SETUP_STEPS, type CratesValue,
  type MoveSetupLookups, type SkippableSection, type TrucksValue,
} from '../lib/moveSetup';
import { useLeaveGuard } from '../lib/useLeaveGuard';
import '../styles/bulk.css';
import '../styles/directory.css';
import '../styles/initiatives.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/wizard.css';
import '../styles/moveSetup.css';

export default function BulkNewMove() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<MoveSetupDraft | null>(null);
  const [form, setForm] = useState<InitiativeFormState>(
    () => ({ ...formFromInitiative(null), initiative_type: 'move' }));
  const [assetJob, setAssetJob] = useState<ImportJobOut | null>(null);
  const [crates, setCrates] = useState<CratesValue | null>(null);
  const [trucks, setTrucks] = useState<TrucksValue | null>(null);
  const [lookups, setLookups] = useState<MoveSetupLookups>(EMPTY_LOOKUPS);
  const [finished, setFinished] = useState(false);
  const [leaveTo, setLeaveTo] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);

  useEffect(() => {
    const put = <K extends keyof MoveSetupLookups>(key: K) => (value: MoveSetupLookups[K]) =>
      setLookups((l) => ({ ...l, [key]: value }));
    void listInitiativeStatuses().then(put('statuses')).catch(() => {});
    void listInitiativeTypes().then(put('types')).catch(() => {});
    void listInitiativeSubTypes().then(put('subTypes')).catch(() => {});
    void listShippingTypes().then(put('shippingTypes')).catch(() => {});
    void listSites().then(put('sites')).catch(() => {});
    void listClients().then(put('clients')).catch(() => {});
    void listPartners().then(put('partners')).catch(() => {});
    void listContainerTypes().then(put('containerTypes')).catch(() => {});
  }, []);

  const origin = lookups.sites.find((s) => s.id === form.origin_site_id) ?? null;
  const destination = lookups.sites.find((s) => s.id === form.destination_site_id) ?? null;
  // the crate/truck steps open prefilled from the site codes, once; Back keeps edits
  useEffect(() => {
    if (step === 2 && crates === null) setCrates(initialCrates(origin, destination));
    if (step === 3 && trucks === null) setTrucks(initialTrucks(origin, destination));
  }, [step]);   // eslint-disable-line react-hooks/exhaustive-deps

  const live = draft !== null && !finished;
  const liveId = useRef<string | null>(null);
  liveId.current = live ? draft.id : null;
  const discarded = useRef(false);             // Discard already deleted it
  useEffect(() => () => {
    if (liveId.current && !discarded.current) {
      void deleteMoveSetup(liveId.current, { keepalive: true }).catch(() => undefined);
    }
  }, []);
  useLeaveGuard(live, setLeaveTo);

  const discard = async () => {
    if (leaveTo === null || draft === null) return;
    setDiscarding(true);
    discarded.current = true;                  // the unmount cleanup must not delete twice
    await deleteMoveSetup(draft.id).catch(() => undefined);
    navigate(leaveTo);
  };

  const back = useCallback(() => setStep((s) => Math.max(0, s - 1)), []);
  const next = useCallback(() => setStep((s) => Math.min(MOVE_SETUP_STEPS.length - 1, s + 1)), []);
  const finish = useCallback(() => setFinished(true), []);
  const skip = (section: SkippableSection) => async () => {
    if (!draft) return;
    const saved = await patchMoveSetup(draft.id, { skip: [section] });
    setDraft(saved);
    if (section === 'assets') setAssetJob(null);
    next();
  };

  const meta = MOVE_SETUP_STEPS[step]!;
  return (
    <div className="portal-page">
      <WizardHeader steps={MOVE_SETUP_STEPS} current={step} title={meta.title}
                    description={meta.description} allDone={finished} />
      <div className="wiz-body">
        {step === 0 && (
          <MoveStep form={form} setForm={setForm} lookups={lookups} draft={draft}
                    onDraft={setDraft} onNext={next} />
        )}
        {step === 1 && draft && (
          <AssetsStep draft={draft} job={assetJob} setJob={setAssetJob}
                      onBack={back} onSkip={skip('assets')} onNext={next} />
        )}
        {step === 2 && draft && crates && (
          <CratesStep draft={draft} value={crates} setValue={setCrates}
                      containerTypes={lookups.containerTypes} onDraft={setDraft}
                      onBack={back} onSkip={skip('crates')} onNext={next} />
        )}
        {step === 3 && draft && trucks && (
          <TrucksStep draft={draft} value={trucks} setValue={setTrucks}
                      origin={origin} destination={destination} onDraft={setDraft}
                      onBack={back} onSkip={skip('trucks')} onNext={next} />
        )}
        {step === 4 && draft && (
          <ReviewStep draft={draft} onDraft={setDraft} form={form} lookups={lookups}
                      assetJob={assetJob} onBack={back} onFinished={finish} />
        )}
      </div>
      {leaveTo !== null && (
        <DiscardDialog busy={discarding} onDiscard={() => void discard()}
                       onKeep={() => setLeaveTo(null)} />
      )}
    </div>
  );
}
```

  Card in `pages/BulkActions.tsx`: append to `BULK_TOOLS`:

```ts
  {
    key: 'new-move', title: 'Create a move in steps',
    description: 'The move, its From-To assets, crates, and trucks — reviewed, then created together.',
    resource: 'initiatives', action: 'add', to: '/bulk/new-move', button: 'Open',
  },
```

  In `pages/BulkActions.test.tsx`, add a test asserting that the card with that title and description renders and that its Open button navigates to `/bulk/new-move`, following the file's existing card tests. Route in `App.tsx`, next to the other `/bulk/*` routes, with `import BulkNewMove from './pages/BulkNewMove';` in alphabetical position:

```tsx
                <Route path="/bulk/new-move" element={
                  <ProtectedRoute resource="initiatives" minRank={ADMIN_RANK}><BulkNewMove /></ProtectedRoute>
                } />
```

- [ ] **Step 9: Run everything touched:** `npx vitest run src/lib/namingConvention.test.ts src/lib/moveSetup.test.ts src/components/common src/pages/BulkNewMove.test.tsx src/pages/BulkActions.test.tsx src/components/initiatives/InitiativeEditModal.test.tsx src/styles/listTypography.test.ts`, then `npx tsc -b`. Expected: PASS and a clean build.
- [ ] **Step 10: Commit** in two parts:
  - `refactor(portal): InitiativeFields shared by the initiative modal`, containing `InitiativeFields.tsx` and `InitiativeEditModal.tsx`.
  - `feat(portal): Create a move in steps — client, naming rule, wizard header, page shell, move step, Bulk Actions card`, containing the rest.

---

### Task 5: Portal assets step — shared import review pieces and `AssetsStep`

**Files:**
- Create: `portal/src/components/imports/ImportUploadFields.tsx`, `ImportProgress.tsx`, `ImportReport.tsx`, `ImportReport.test.tsx`
- Modify: `portal/src/pages/ImportMoveAssets.tsx` (use the three; behavior and DOM unchanged)
- Replace the Task 4 stub: `portal/src/components/moveSetup/AssetsStep.tsx`; add `AssetsStep.test.tsx`

**Interfaces:**
- Consumes: `uploadMoveSetupAssets`, `recheckMoveSetupAssets`, `getImportJob`, `ImportJobOut`, `moveSetupError`, `WizardFooter`, `useSkip`, `FixMakeModelDialog`, and the helpers in `lib/moveAssetImport` (`jobIsActive`, `countDetails`, `IMPORT_ERRORS`).
- Produces:

```ts
// components/imports/ImportUploadFields.tsx
MODE_OPTIONS; formatBytes(bytes): string
ImportTemplateLinks({ busy }): JSX
default ImportUploadFields({ file, onFile, mode, onMode, generateSerials, onGenerateSerials, busy, inputRef })
// components/imports/ImportProgress.tsx
default ImportProgress({ job, speed, eta })
// components/imports/ImportReport.tsx
interface FixTarget { text: string; make: string; model: string }
PAGE_SIZE = 500; STATUS_CHIP; PHASE_LABELS
default ImportReport({ job, fixedTexts, onFix, canAddModels, canChangeModels, readOnly?, readyLabel? })
// components/moveSetup/AssetsStep.tsx
default AssetsStep({ draft, job, setJob, onBack, onSkip: () => Promise<void>, onNext })
```

- [ ] **Step 1: Extract, test-first.** Write `components/imports/ImportReport.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { ImportJobOut } from '../../lib/api';
import ImportReport from './ImportReport';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
afterEach(cleanup);

const job = {
  id: 'j1', initiative_id: null, kind: 'move_assets', filename: 'ft.csv', options: {},
  phase: 'validate', status: 'completed', total_rows: 2, processed_rows: 2, created_count: 1,
  updated_count: 0, error_count: 0, error: null, created_at: '', started_at: null, finished_at: null,
  results: { summary: {}, details: [
    { row: 2, serial_number: 'sn-1', status: 'created', message: 'Asset added to move' },
    { row: 3, serial_number: 'sn-2', status: 'review', message: "Make/Model 'Ghost GX' not found — needs review", make_model: 'Ghost GX' },
  ] },
} as ImportJobOut;

it('shows the chips, the missing make/models card and a Fix button', () => {
  render(<ImportReport job={job} fixedTexts={new Set()} onFix={vi.fn()} canAddModels canChangeModels />);
  expect(screen.getByText(/1 will create/)).toBeTruthy();
  expect(screen.getByText('1 missing make/model')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Fix…' })).toBeTruthy();
});

it('readOnly drops every fix action', () => {
  render(<ImportReport job={job} fixedTexts={new Set()} onFix={vi.fn()} canAddModels canChangeModels readOnly />);
  expect(screen.queryByText('1 missing make/model')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Fix…' })).toBeNull();
  expect(screen.getByText('sn-2')).toBeTruthy();
});

it('says what a fixed group needs next', () => {
  render(<ImportReport job={job} fixedTexts={new Set(['ghost gx'])} onFix={vi.fn()} canAddModels
                       canChangeModels readyLabel="Ready — check again to apply" />);
  expect(screen.getByText('Ready — check again to apply')).toBeTruthy();
});
```

  Create the three components by moving code out of `pages/ImportMoveAssets.tsx`:
  - **`ImportUploadFields.tsx`:**
    - Move `MODE_OPTIONS` (lines 56–67) and `formatBytes` (107–112) here, exported.
    - `ImportTemplateLinks({ busy })` renders lines 273–284 (`<div className="imp-template-links">…`).
    - The default export owns `dragOver` state and renders lines 287–375 (the dropzone `<label>` and the `imp-options` block) verbatim, with `setFile`→`onFile`, `setMode`→`onMode`, `setGenerateSerials`→`onGenerateSerials`, `fileInputRef`→`inputRef`, and `removeFile()`→`remove()`, where `const remove = () => { onFile(null); if (inputRef.current) inputRef.current.value = ''; };`.
    - Props: `{ file: File | null; onFile: (f: File | null) => void; mode: string; onMode: (m: string) => void; generateSerials: boolean; onGenerateSerials: (v: boolean) => void; busy: boolean; inputRef: MutableRefObject<HTMLInputElement | null> }`.
  - **`ImportProgress.tsx`:** `({ job, speed, eta }: { job: ImportJobOut; speed: number; eta: number | null })` renders lines 397–415 verbatim (the progress track, the "{processed} of {total} rows" hint and the rows/s line).
  - **`ImportReport.tsx`:**
    - Move `REPORT_COLUMNS` (lines 37–54, with its comments), `STATUS_CHIP` and `PHASE_LABELS` here.
    - Compute the grid inside: `const { preferences } = useAuth(); const reportGrid = listGridStyle(REPORT_COLUMNS, [], undefined, listScale(preferences?.list_size));`.
    - Own `page` state, reset by `useEffect(() => { setPage(0); }, [job.id, job.phase]);`.
    - Compute `missing` with `useMemo(() => missingMakeModels(details), [details])`.
    - Render lines 472–597 verbatim (chips, missing card, `dir-list` report list, pagination), with three substitutions:
      - `setFixTarget(...)` → `onFix(...)`.
      - The "Ready — reprocess to apply" text → `{readyLabel}` (default `'Ready — reprocess to apply'`).
      - The missing card and the inline Fix… button are wrapped in `!readOnly`.
    - It keeps `listGridStyle`, `ColHead` and `list-scroll`, which satisfies guardrail (h).

  In `ImportMoveAssets.tsx`:
  - Delete the moved code, the `page`/`dragOver` state, `removeFile`, `reviewDetails`/`missing`, and the `setPage(0)` calls in `run` and `resetImport`.
  - Render `<ImportTemplateLinks busy={busy} />`, `<ImportUploadFields … />` and `<ImportProgress job={job} speed={speed} eta={eta} />` where those blocks were.
  - In the completed card, keep the `imp-card-head`, the headline and both footers exactly as they are, and replace the chips-through-pagination block with:

```tsx
                    <ImportReport job={job} fixedTexts={fixedTexts} onFix={setFixTarget}
                                  canAddModels={canAddModels} canChangeModels={canChangeModels} />
```

  The page keeps `const counts = countDetails(job.results.details)` for its headline and footers. Drop imports it no longer uses.

- [ ] **Step 2: Run** `npx vitest run src/pages/ImportMoveAssets.test.tsx src/components/imports src/styles/listTypography.test.ts`. `ImportMoveAssets.test.tsx` stays **unchanged**. Expected: PASS. Run `npx tsc -b`. Commit `refactor(portal): import review pieces shared out of ImportMoveAssets`.

- [ ] **Step 3: Write the failing `AssetsStep` test** `components/moveSetup/AssetsStep.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ImportJobOut, MoveSetupDraft } from '../../lib/api';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const api = vi.hoisted(() => ({
  uploadMoveSetupAssets: vi.fn(), recheckMoveSetupAssets: vi.fn(), getImportJob: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: AssetsStep } = await import('./AssetsStep');

const DRAFT = { id: 'd1' } as MoveSetupDraft;
const job = (over: Partial<ImportJobOut>): ImportJobOut => ({
  id: 'c1', initiative_id: null, kind: 'move_assets', filename: 'ft.csv', options: {},
  phase: 'validate', status: 'queued', total_rows: 2, processed_rows: 0, created_count: 0,
  updated_count: 0, error_count: 0, results: null, error: null, created_at: '',
  started_at: null, finished_at: null, ...over,
});
const DONE = job({ status: 'completed', processed_rows: 2, results: { summary: {}, details: [
  { row: 2, serial_number: 'sn-1', status: 'created', message: 'Asset added to move' },
  { row: 3, serial_number: 'sn-2', status: 'created', message: 'Asset added to move' },
] } });

function Harness({ onNext = vi.fn(), onSkip = vi.fn(async () => {}) }) {
  const [current, setJob] = useState<ImportJobOut | null>(null);
  return (
    <MemoryRouter>
      <AssetsStep draft={DRAFT} job={current} setJob={setJob} onBack={vi.fn()}
                  onSkip={onSkip} onNext={onNext} />
    </MemoryRouter>
  );
}

beforeEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
afterEach(cleanup);

it('uploads, polls the check every 1.5 s, and unlocks Next once it completes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  api.uploadMoveSetupAssets.mockResolvedValue(job({ status: 'queued' }));
  api.getImportJob.mockResolvedValueOnce(job({ status: 'running', processed_rows: 1 }))
    .mockResolvedValueOnce(DONE);
  const onNext = vi.fn();
  render(<Harness onNext={onNext} />);
  const next = () => screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
  expect(next().disabled).toBe(true);
  expect(screen.getByText('Upload a From-To file, or skip this step.')).toBeTruthy();

  const file = new File(['Serial Number\nSN-1\n'], 'ft.csv', { type: 'text/csv' });
  await user.upload(document.querySelector('input[type=file]') as HTMLInputElement, file);
  await user.click(screen.getByRole('button', { name: 'Check file' }));
  await waitFor(() => expect(api.uploadMoveSetupAssets).toHaveBeenCalledWith(
    'd1', file, { makeModelMode: 'fuzzy', generateSerials: false }));
  expect(await screen.findByText('Checking the file…')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(await screen.findByText('1 of 2 rows')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(await screen.findByText('2 rows will be imported when the move is created')).toBeTruthy();
  expect(api.getImportJob).toHaveBeenCalledTimes(2);
  await user.click(next());
  expect(onNext).toHaveBeenCalled();
});

it('Check again queues a new check over the same file', async () => {
  const user = userEvent.setup();
  api.uploadMoveSetupAssets.mockResolvedValue(DONE);
  api.recheckMoveSetupAssets.mockResolvedValue(job({ id: 'c2', status: 'queued' }));
  api.getImportJob.mockResolvedValue(job({ id: 'c2', status: 'running' }));
  render(<Harness />);
  await user.upload(document.querySelector('input[type=file]') as HTMLInputElement,
    new File(['x'], 'ft.csv', { type: 'text/csv' }));
  await user.click(screen.getByRole('button', { name: 'Check file' }));
  await user.click(await screen.findByRole('button', { name: 'Check again' }));
  expect(api.recheckMoveSetupAssets).toHaveBeenCalledWith('d1');
  expect(await screen.findByText('Checking the file…')).toBeTruthy();
});

it('Skip this step hands off to the page', async () => {
  const user = userEvent.setup();
  const onSkip = vi.fn(async () => {});
  render(<Harness onSkip={onSkip} />);
  await user.click(screen.getByRole('button', { name: 'Skip this step' }));
  expect(onSkip).toHaveBeenCalled();
});
```

- [ ] **Step 4: Implement `AssetsStep.tsx`**, replacing the stub:

```tsx
/** Step 2 — the From-To file. Upload runs the same background check the
 *  move import page runs (no move yet); the review matches that page —
 *  counts, per-row list, Fix make/model — and Check again re-checks the
 *  whole file. Rows that still need review are not imported. */
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '../../auth/AuthContext';
import {
  ApiError, getImportJob, recheckMoveSetupAssets, uploadMoveSetupAssets,
  type ImportJobOut, type MoveSetupDraft,
} from '../../lib/api';
import { countDetails, IMPORT_ERRORS, jobIsActive } from '../../lib/moveAssetImport';
import { moveSetupError } from '../../lib/moveSetup';
import WizardFooter from '../common/WizardFooter';
import ImportProgress from '../imports/ImportProgress';
import ImportReport, { type FixTarget } from '../imports/ImportReport';
import ImportUploadFields, { ImportTemplateLinks } from '../imports/ImportUploadFields';
import FixMakeModelDialog from '../initiatives/FixMakeModelDialog';
import { useSkip } from './useSkip';

const POLL_MS = 1500;

interface Props {
  draft: MoveSetupDraft;
  job: ImportJobOut | null;
  setJob: (job: ImportJobOut | null) => void;
  onBack: () => void;
  onSkip: () => Promise<void>;
  onNext: () => void;
}

export default function AssetsStep({ draft, job, setJob, onBack, onSkip, onNext }: Props) {
  const { can } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [mode, setMode] = useState('fuzzy');
  const [generateSerials, setGenerateSerials] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fixedTexts, setFixedTexts] = useState<Set<string>>(new Set());
  const [fixTarget, setFixTarget] = useState<FixTarget | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { skipping, skip } = useSkip(onSkip, setError);
  useEffect(() => { setFixedTexts(new Set()); }, [job?.id]);

  // poll the running check: one request at a time, stopped on unmount; a
  // network blip keeps polling, an API error (the check is gone) stops
  const activeId = job && jobIsActive(job) ? job.id : null;
  useEffect(() => {
    if (!activeId) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await getImportJob(activeId);
        if (stopped) return;
        setJob(next);
        if (!jobIsActive(next)) return;
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError) { setError(moveSetupError(err)); return; }
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [activeId, setJob]);

  const run = async (fn: () => Promise<ImportJobOut>) => {
    setBusy(true);
    setError('');
    try {
      setJob(await fn());
      setReplacing(false);
      setFile(null);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      setError(moveSetupError(err));
    } finally {
      setBusy(false);
    }
  };

  const active = job !== null && jobIsActive(job);
  const showUpload = !active && (job === null || replacing || job.status !== 'completed');
  const checked = job?.status === 'completed' && !!job.results && !replacing;
  const counts = checked ? countDetails(job.results!.details) : null;
  const importable = counts ? counts.created + counts.updated : 0;

  return (
    <>
      {showUpload && (
        <section className="init-panel imp-card">
          <div className="imp-card-head">
            <p className="eyebrow-sm">Upload</p>
            <ImportTemplateLinks busy={busy} />
          </div>
          {job && (job.status === 'failed' || job.status === 'cancelled') && !replacing && (
            <div className="dir-empty">
              <b>The check did not finish</b>
              {IMPORT_ERRORS[job.error ?? ''] ?? 'Something went wrong. Upload the file again.'}
            </div>
          )}
          <ImportUploadFields file={file} onFile={setFile} mode={mode} onMode={setMode}
                              generateSerials={generateSerials}
                              onGenerateSerials={setGenerateSerials}
                              busy={busy} inputRef={inputRef} />
          <div className="imp-card-foot">
            <button className="btn-solid" type="button" disabled={busy || !file}
                    onClick={() => file && void run(() => uploadMoveSetupAssets(
                      draft.id, file, { makeModelMode: mode, generateSerials }))}>
              {busy ? 'Uploading…' : 'Check file'}
            </button>
            {replacing && (
              <button className="mini-btn" type="button" disabled={busy}
                      onClick={() => setReplacing(false)}>
                Keep the current file
              </button>
            )}
          </div>
        </section>
      )}

      {job && active && (
        <section className="init-panel imp-card">
          <p className="eyebrow-sm">Checking the file…</p>
          <ImportProgress job={job} speed={0} eta={null} />
        </section>
      )}

      {checked && counts && job && (
        <section className="init-panel imp-card">
          <div className="imp-card-head">
            <p className="eyebrow-sm">Review · {job.filename}</p>
            <button type="button" className="imp-link-btn" onClick={() => setReplacing(true)}>
              Upload a different file
            </button>
          </div>
          <h2 className="imp-report-headline">
            {importable > 0
              ? `${importable} rows will be imported when the move is created`
              : 'Nothing in this file will be imported'}
          </h2>
          <ImportReport job={job} fixedTexts={fixedTexts} onFix={setFixTarget}
                        canAddModels={can('asset_models', 'add')}
                        canChangeModels={can('asset_models', 'change')}
                        readyLabel="Ready — check again to apply" />
          <div className="imp-card-foot">
            <button className="mini-btn" type="button" disabled={busy}
                    onClick={() => void run(() => recheckMoveSetupAssets(draft.id))}>
              {busy ? 'Checking…' : 'Check again'}
            </button>
            {counts.review + counts.error > 0 && (
              <span className="page-hint">
                Rows that need review or have errors are not imported. Fix a make/model, then check again.
              </span>
            )}
          </div>
        </section>
      )}

      <WizardFooter onBack={onBack} onSkip={skip} onNext={onNext} nextDisabled={!checked}
                    busy={busy || skipping} error={error}
                    note={job === null ? 'Upload a From-To file, or skip this step.' : undefined} />

      {fixTarget && (
        <FixMakeModelDialog text={fixTarget.text} make={fixTarget.make} model={fixTarget.model}
                            onClose={() => setFixTarget(null)}
                            onFixed={(text) => {
                              setFixedTexts((s) => new Set(s).add(text.toLowerCase()));
                              setFixTarget(null);
                            }} />
      )}
    </>
  );
}
```

- [ ] **Step 5: Run** `npx vitest run src/components/moveSetup/AssetsStep.test.tsx src/pages/BulkNewMove.test.tsx src/pages/ImportMoveAssets.test.tsx src/styles/listTypography.test.ts` and `npx tsc -b`. Expected: PASS. Commit `feat(portal): move setup assets step — upload, check, review, fix make/model, check again`.

---

### Task 6: Portal crates, trucks, review and finish

**Files:**
- Create: `portal/src/components/containers/LabelTagCounts.tsx`. Modify `BulkContainersModal.tsx` so its tag section uses it, with the same DOM.
- Modify: `portal/src/lib/bulkContainers.ts`, where `summaryText(count, tags, noun = 'container')` gets a defaulted third parameter.
- Create: `portal/src/components/moveSetup/NamingConvention.tsx`, `MoveSetupFinish.tsx`
- Replace the Task 4 stubs: `CratesStep.tsx`, `TrucksStep.tsx`, `ReviewStep.tsx`
- Tests: `components/moveSetup/CratesStep.test.tsx`, `ReviewStep.test.tsx`

**Interfaces:**
- Consumes: `namingResult`, `namesPreview`, `clashSentence`, `CRATE_MAX`, `TRUCK_MAX`, `generateNames`, `cratesBody`, `trucksBody`, `CratesValue`, `TrucksValue`, `moveSetupError`, `setupReasons`, `MOVE_SETUP_ERRORS`, `assetSummary`, `createdCount` and `moveSummaryRows`; `patchMoveSetup`, `createMoveFromSetup` and `getMoveSetup`; `clampTags`, `tagTotal`, `assignTags` and `TAG_ASSIGNMENT_ORDER`; `ImportReport`, `BulkApplySummary`, `DataTable`, `ComboBox`, `WizardFooter` and `useSkip`.
- Produces:

```ts
LabelTagCounts({ count, tags, onChange, disabled, notice, noun? = 'container' })
NamingConvention({ idPrefix, noun, max, value: NamingValue, onChange, onCountBlur?, names, error, clashes, checking, disabled? })
CratesStep({ draft, value: CratesValue, setValue, containerTypes, onDraft, onBack, onSkip, onNext })
TrucksStep({ draft, value: TrucksValue, setValue, origin, destination, onDraft, onBack, onSkip, onNext })
ReviewStep({ draft, onDraft, form, lookups, assetJob, onBack, onFinished })
MoveSetupFinish({ draft, moveName })
```

- [ ] **Step 1: Extract `LabelTagCounts`.**
  - In `lib/bulkContainers.ts`, change `summaryText` to `(count: number, tags: TagCounts, noun = 'container')`, with the first part built as `` `${count} ${noun}${count === 1 ? '' : 's'}` ``. `lib/bulkContainers.test.ts` passes unchanged.
  - Create `components/containers/LabelTagCounts.tsx`, which renders `BulkContainersModal.tsx` lines 318–342 (the `bc-tags` rows and the `bc-summary` block) verbatim:

```tsx
/** The per-tag steppers + summary from "Add in bulk", shared with Create a
 *  move in steps' crates. Tags fill in LABEL_TAG_ASSIGNMENT_ORDER; the + is
 *  disabled once the tags cover the count. */
import type { CSSProperties } from 'react';

import { TAG_TYPES } from '../../labels/tagTypes';
import { summaryText, tagTotal, TAG_ASSIGNMENT_ORDER, type TagCounts } from '../../lib/bulkContainers';
import '../../styles/bulkContainers.css';

interface Props {
  count: number;
  tags: TagCounts;
  onChange: (tags: TagCounts) => void;
  disabled: boolean;
  notice: string;
  noun?: string;
}

export default function LabelTagCounts({ count, tags, onChange, disabled, notice, noun = 'container' }: Props) {
  const total = tagTotal(tags);
  const inc = (key: (typeof TAG_ASSIGNMENT_ORDER)[number]) => {
    if (total >= count) return;
    onChange({ ...tags, [key]: (tags[key] ?? 0) + 1 });
  };
  const dec = (key: (typeof TAG_ASSIGNMENT_ORDER)[number]) => {
    if (tags[key]) onChange({ ...tags, [key]: tags[key]! - 1 });
  };
  return (
    <>
      {/* BulkContainersModal.tsx lines 318–342 verbatim, with `saving` →
          `disabled`, `summaryText(count, tags)` → `summaryText(count, tags, noun)`,
          and `clampNotice` → `notice` */}
    </>
  );
}
```

  - In the modal, replace those lines with:

```tsx
<LabelTagCounts count={count} tags={tags} disabled={saving} notice={clampNotice}
                onChange={(next) => { setClampNotice(''); setTags(next); }} />
```

    Then drop the modal's now-unused `inc`, `dec` and `total` (keep `tagTotal` only if still used).
  - Run `npx vitest run src/components/containers/BulkContainersModal.test.tsx src/lib/bulkContainers.test.ts`, both **unchanged**. Expected: PASS. Commit `refactor(portal): LabelTagCounts shared out of BulkContainersModal`.

- [ ] **Step 2: Write the failing `CratesStep` test** `components/moveSetup/CratesStep.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { MoveSetupDraft, StatusValue } from '../../lib/api';
import type { CratesValue } from '../../lib/moveSetup';

const api = vi.hoisted(() => ({ patchMoveSetup: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
const { default: CratesStep } = await import('./CratesStep');

const TYPES = [{ key: 'pallet', label: 'Pallet' }] as StatusValue[];
const START: CratesValue = { convention: 'CRT-SJC-DAL-xxx', count: '0', start: '1', container_type: '', tags: {} };
const withClashes = (clashes: string[]) => ({
  id: 'd1', previews: { crates: { names: [], clashes, error: null }, trucks: null },
}) as unknown as MoveSetupDraft;

function Harness({ onNext = vi.fn() }) {
  const [value, setValue] = useState<CratesValue>(START);
  return <CratesStep draft={{ id: 'd1' } as MoveSetupDraft} value={value} setValue={setValue}
                     containerTypes={TYPES} onDraft={vi.fn()} onBack={vi.fn()}
                     onSkip={vi.fn(async () => {})} onNext={onNext} />;
}

beforeEach(() => { vi.clearAllMocks(); api.patchMoveSetup.mockResolvedValue(withClashes([])); });
afterEach(cleanup);

it('previews names live and shows the rule error as a sentence', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  const count = screen.getByLabelText('Count');
  await user.clear(count);
  await user.type(count, '5');
  expect(screen.getByText('5 crates: CRT-SJC-DAL-001, CRT-SJC-DAL-002, CRT-SJC-DAL-003 … CRT-SJC-DAL-005')).toBeTruthy();
  const convention = screen.getByLabelText('Naming convention');
  await user.clear(convention);
  await user.type(convention, 'BOX-xxx');
  expect(screen.getByText("Use only one run of x's for the number.")).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
});

it('needs a crate type once the count is above zero', async () => {
  const user = userEvent.setup();
  render(<Harness />);
  await user.clear(screen.getByLabelText('Count'));
  await user.type(screen.getByLabelText('Count'), '2');
  expect(screen.getByText('Pick a crate type to create crates.')).toBeTruthy();
  await user.click(screen.getByPlaceholderText('Type to search types…'));
  await user.click(await screen.findByText('Pallet'));
  expect(screen.queryByText('Pick a crate type to create crates.')).toBeNull();
});

it('flags clashes from the server and blocks Next while there are any', async () => {
  const user = userEvent.setup();
  api.patchMoveSetup.mockResolvedValue(withClashes(['CRT-SJC-DAL-002']));
  const onNext = vi.fn();
  render(<Harness onNext={onNext} />);
  await user.clear(screen.getByLabelText('Count'));
  await user.type(screen.getByLabelText('Count'), '3');
  await user.click(screen.getByPlaceholderText('Type to search types…'));
  await user.click(await screen.findByText('Pallet'));
  expect(await screen.findByText('These crate names already exist: CRT-SJC-DAL-002.')).toBeTruthy();
  expect(api.patchMoveSetup).toHaveBeenLastCalledWith('d1', { crates: expect.objectContaining({
    convention: 'CRT-SJC-DAL-xxx', count: 3, start: 1, container_type: 'pallet' }) });
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  expect(onNext).not.toHaveBeenCalled();
});

it('Next saves the crates and moves on when nothing clashes', async () => {
  const user = userEvent.setup();
  const onNext = vi.fn();
  render(<Harness onNext={onNext} />);
  const next = () => screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
  await waitFor(() => expect(next().disabled).toBe(false));      // count 0: the live save settled
  await user.click(next());
  await waitFor(() => expect(onNext).toHaveBeenCalled());
});
```

- [ ] **Step 3: Implement `NamingConvention.tsx`:**

```tsx
/** The convention, count and start fields plus the live preview and clash
 *  line — shared by the crate and truck steps. Pure presentation: the step
 *  owns the value, the generated names, and the server's clashes. */
import type { ChangeEvent } from 'react';

import { clashSentence, namesPreview, type NamingValue } from '../../lib/namingConvention';

interface Props {
  idPrefix: string;
  noun: string;
  max: number;
  value: NamingValue;
  onChange: (value: NamingValue) => void;
  onCountBlur?: () => void;
  names: string[];
  error: string | null;
  clashes: string[];
  checking: boolean;
  disabled?: boolean;
}

export default function NamingConvention({
  idPrefix, noun, max, value, onChange, onCountBlur, names, error, clashes, checking,
  disabled = false,
}: Props) {
  const set = (key: keyof NamingValue) => (e: ChangeEvent<HTMLInputElement>) =>
    onChange({ ...value, [key]: e.target.value });
  const plural = `${noun}${names.length === 1 ? '' : 's'}`;
  return (
    <>
      <div className="pf-form ms-naming">
        <div style={{ gridColumn: '1 / -1' }}>
          <label htmlFor={`${idPrefix}-convention`}>Naming convention</label>
          <input id={`${idPrefix}-convention`} value={value.convention} maxLength={60}
                 spellCheck={false} disabled={disabled} onChange={set('convention')} />
          <span className="page-hint">The x&apos;s mark the number and set its padding: xxx gives 001, 002, 003.</span>
        </div>
        <div>
          <label htmlFor={`${idPrefix}-count`}>Count</label>
          <input id={`${idPrefix}-count`} type="number" min={0} max={max} value={value.count}
                 disabled={disabled} onChange={set('count')} onBlur={onCountBlur} />
        </div>
        <div>
          <label htmlFor={`${idPrefix}-start`}>Start number</label>
          <input id={`${idPrefix}-start`} type="number" min={0} value={value.start}
                 disabled={disabled} onChange={set('start')} />
        </div>
      </div>
      <div className="ms-names" aria-live="polite">
        <span className="eyebrow">Preview</span>
        {error ? <p className="pf-error">{error}</p>
          : names.length === 0
            ? <p className="page-hint">No {noun}s. Set a count to create some, or skip this step.</p>
            : <p className="page-hint">{names.length} {plural}: {namesPreview(names)}</p>}
        {checking && !error && names.length > 0 && (
          <p className="set-note">Checking for names already in use…</p>
        )}
        {clashes.length > 0 && <p className="pf-error">{clashSentence(noun, clashes)}</p>}
      </div>
    </>
  );
}
```

- [ ] **Step 4: Implement `CratesStep.tsx`:**

```tsx
/** Step 3 — crates: the convention (prefilled from the site codes), count
 *  0–500, start, crate type (required above 0), and label-tag counts as in
 *  "Add in bulk". Once the rule is happy the step saves itself (debounced)
 *  so the server can flag names already held by non-archived crates; Next
 *  is blocked while any clash. */
import { useEffect, useMemo, useRef, useState } from 'react';

import { patchMoveSetup, type MoveSetupDraft, type StatusValue } from '../../lib/api';
import { clampTags, tagTotal, TAG_ASSIGNMENT_ORDER, type TagCounts } from '../../lib/bulkContainers';
import { TAG_TYPES } from '../../labels/tagTypes';
import { cratesBody, moveSetupError, type CratesValue } from '../../lib/moveSetup';
import { CRATE_MAX, namingResult } from '../../lib/namingConvention';
import ComboBox from '../ComboBox';
import WizardFooter from '../common/WizardFooter';
import LabelTagCounts from '../containers/LabelTagCounts';
import NamingConvention from './NamingConvention';
import { useSkip } from './useSkip';

const SAVE_MS = 400;

interface Props {
  draft: MoveSetupDraft;
  value: CratesValue;
  setValue: (value: CratesValue) => void;
  containerTypes: StatusValue[];
  onDraft: (draft: MoveSetupDraft) => void;
  onBack: () => void;
  onSkip: () => Promise<void>;
  onNext: () => void;
}

function trimmedNotice(trimmed: TagCounts): string {
  const parts = TAG_ASSIGNMENT_ORDER.filter((k) => (trimmed[k] ?? 0) > 0)
    .map((k) => `${trimmed[k]} ${TAG_TYPES[k].label}`);
  return `Count dropped below the tag total — trimmed ${parts.join(', ')} to fit.`;
}

export default function CratesStep({
  draft, value, setValue, containerTypes, onDraft, onBack, onSkip, onNext,
}: Props) {
  const { names, error: namingError } = useMemo(() => namingResult(value, CRATE_MAX), [value]);
  const count = names.length;
  const [clashes, setClashes] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const { skipping, skip } = useSkip(onSkip, setError);
  const seq = useRef(0);
  // held in a ref so a caller's inline callback never re-triggers the save
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const typeMissing = count > 0 && !value.container_type;
  const tagsFit = tagTotal(value.tags) <= count;
  const bodyKey = JSON.stringify(cratesBody(value));

  // live clash check: save the section once the rule is happy (debounced)
  useEffect(() => {
    if (namingError || !tagsFit) { setChecking(false); setClashes([]); return undefined; }
    const mine = ++seq.current;
    setChecking(true);
    const timer = setTimeout(() => {
      void patchMoveSetup(draft.id, { crates: JSON.parse(bodyKey) }).then((saved) => {
        if (mine !== seq.current) return;
        onDraftRef.current(saved);
        setClashes(saved.previews?.crates?.clashes ?? []);
        setChecking(false);
      }).catch((err) => {
        if (mine !== seq.current) return;
        setChecking(false);
        setError(moveSetupError(err));
      });
    }, SAVE_MS);
    return () => clearTimeout(timer);
  }, [bodyKey, namingError, tagsFit, draft.id]);

  const clampToCount = (): CratesValue => {
    const { tags, trimmed } = clampTags(value.tags, count);
    if (Object.keys(trimmed).length === 0) return value;
    const next = { ...value, tags };
    setValue(next);
    setNotice(trimmedNotice(trimmed));
    return next;
  };

  const next = async () => {
    if (namingError || typeMissing) return;
    const safe = clampToCount();
    const mine = ++seq.current;              // supersede any debounced save in flight
    setBusy(true);
    setError('');
    try {
      const saved = await patchMoveSetup(draft.id, { crates: cratesBody(safe) });
      onDraft(saved);
      const found = saved.previews?.crates?.clashes ?? [];
      if (mine === seq.current) { setClashes(found); setChecking(false); }
      if (found.length === 0) onNext();
    } catch (err) {
      setError(moveSetupError(err));
    } finally {
      setBusy(false);
    }
  };

  const typeOptions = useMemo(
    () => containerTypes.map((t) => ({ value: t.key, label: t.label })), [containerTypes]);

  return (
    <>
      <section className="bulk-section">
        <p className="eyebrow-sm">Naming</p>
        <NamingConvention idPrefix="crates" noun="crate" max={CRATE_MAX} value={value}
                          onChange={(v) => setValue({ ...value, ...v })}
                          onCountBlur={() => void clampToCount()}
                          names={names} error={namingError} clashes={clashes}
                          checking={checking} disabled={busy} />
      </section>
      <section className="bulk-section">
        <p className="eyebrow-sm">Crate type and label tags</p>
        <div className="pf-form ms-type">
          <div><label>Crate type</label>
            <ComboBox placeholder="Type to search types…" value={value.container_type}
                      disabled={busy} options={typeOptions}
                      onChange={(t) => setValue({ ...value, container_type: t })} /></div>
        </div>
        {typeMissing && <p className="set-note">Pick a crate type to create crates.</p>}
        <p className="page-hint">
          Assigned in order — the first crates get Priority, then Vendor, Accessories, Warehouse, and E-Waste.
        </p>
        <LabelTagCounts count={count} tags={value.tags} disabled={busy} notice={notice}
                        noun="crate"
                        onChange={(tags) => { setNotice(''); setValue({ ...value, tags }); }} />
      </section>
      <WizardFooter onBack={onBack} onSkip={skip} onNext={() => void next()}
                    nextDisabled={!!namingError || typeMissing || clashes.length > 0 || checking}
                    busy={busy || skipping} error={error} />
    </>
  );
}
```

  `onDraft` is read through a ref, so an inline callback (as in the tests' harness) can never re-run the save effect. Only a real change to the section, the rule's verdict or the draft id triggers a save.

- [ ] **Step 5: Implement `TrucksStep.tsx`.** It uses the same live-save pattern, trimmed to trucks:

```tsx
/** Step 4 — trucks: the convention (prefilled), count 0–100, start, preview
 *  and clashes against non-archived trucks. Every truck is attached to the
 *  move and runs origin → destination; other truck fields come later. */
import { useEffect, useMemo, useRef, useState } from 'react';

import { patchMoveSetup, type MoveSetupDraft, type SiteItem } from '../../lib/api';
import { moveSetupError, trucksBody, type TrucksValue } from '../../lib/moveSetup';
import { namingResult, TRUCK_MAX } from '../../lib/namingConvention';
import WizardFooter from '../common/WizardFooter';
import NamingConvention from './NamingConvention';
import { useSkip } from './useSkip';

const SAVE_MS = 400;

interface Props {
  draft: MoveSetupDraft;
  value: TrucksValue;
  setValue: (value: TrucksValue) => void;
  origin: SiteItem | null;
  destination: SiteItem | null;
  onDraft: (draft: MoveSetupDraft) => void;
  onBack: () => void;
  onSkip: () => Promise<void>;
  onNext: () => void;
}

export default function TrucksStep({
  draft, value, setValue, origin, destination, onDraft, onBack, onSkip, onNext,
}: Props) {
  const { names, error: namingError } = useMemo(() => namingResult(value, TRUCK_MAX), [value]);
  const [clashes, setClashes] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { skipping, skip } = useSkip(onSkip, setError);
  const seq = useRef(0);
  const onDraftRef = useRef(onDraft);
  onDraftRef.current = onDraft;
  const bodyKey = JSON.stringify(trucksBody(value));

  useEffect(() => {
    if (namingError) { setChecking(false); setClashes([]); return undefined; }
    const mine = ++seq.current;
    setChecking(true);
    const timer = setTimeout(() => {
      void patchMoveSetup(draft.id, { trucks: JSON.parse(bodyKey) }).then((saved) => {
        if (mine !== seq.current) return;
        onDraftRef.current(saved);
        setClashes(saved.previews?.trucks?.clashes ?? []);
        setChecking(false);
      }).catch((err) => {
        if (mine !== seq.current) return;
        setChecking(false);
        setError(moveSetupError(err));
      });
    }, SAVE_MS);
    return () => clearTimeout(timer);
  }, [bodyKey, namingError, draft.id]);

  const next = async () => {
    if (namingError) return;
    const mine = ++seq.current;
    setBusy(true);
    setError('');
    try {
      const saved = await patchMoveSetup(draft.id, { trucks: trucksBody(value) });
      onDraft(saved);
      const found = saved.previews?.trucks?.clashes ?? [];
      if (mine === seq.current) { setClashes(found); setChecking(false); }
      if (found.length === 0) onNext();
    } catch (err) {
      setError(moveSetupError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="bulk-section">
        <p className="eyebrow-sm">Naming</p>
        <NamingConvention idPrefix="trucks" noun="truck" max={TRUCK_MAX} value={value}
                          onChange={setValue} names={names} error={namingError}
                          clashes={clashes} checking={checking} disabled={busy} />
        <p className="set-note">
          Every truck is attached to this move and runs from {origin?.name ?? 'the origin'} to{' '}
          {destination?.name ?? 'the destination'}. Drivers, loads, and tracking are filled in on each truck later.
        </p>
      </section>
      <WizardFooter onBack={onBack} onSkip={skip} onNext={() => void next()}
                    nextDisabled={!!namingError || clashes.length > 0 || checking}
                    busy={busy || skipping} error={error} />
    </>
  );
}
```

- [ ] **Step 6: Write the failing `ReviewStep` test** `components/moveSetup/ReviewStep.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { MoveSetupDraft, SiteItem, StatusValue } from '../../lib/api';
import { formFromInitiative } from '../../lib/initiatives';
import { EMPTY_LOOKUPS } from '../../lib/moveSetup';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true, preferences: { list_prefs: {} } }),
}));
const api = vi.hoisted(() => ({ createMoveFromSetup: vi.fn(), getMoveSetup: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { ApiError } = await import('../../lib/api');
const { default: ReviewStep } = await import('./ReviewStep');

const LOOKUPS = {
  ...EMPTY_LOOKUPS,
  sites: [{ id: 's1', name: 'San Jose DC' }, { id: 's2', name: 'Dallas DC' }] as SiteItem[],
  containerTypes: [{ key: 'pallet', label: 'Pallet' }] as StatusValue[],
};
const FORM = { ...formFromInitiative(null), initiative_type: 'move', name: 'SJC to DAL',
               origin_site_id: 's1', destination_site_id: 's2' };
const base = (over: Partial<MoveSetupDraft> = {}): MoveSetupDraft => ({
  id: 'd1', status: 'preview', error: null, initiative_id: null, total_rows: 0, processed_rows: 0,
  results: null, created_at: '', previews: null,
  payload: { move: {}, assets: null,
             crates: { convention: 'CRT-xxx', count: 2, start: 1, container_type: 'pallet', tags: { priority: 1 } },
             trucks: null },
  ...over,
});

function Harness({ initial }: { initial: MoveSetupDraft }) {
  const [draft, setDraft] = useState(initial);
  return (
    <MemoryRouter>
      <ReviewStep draft={draft} onDraft={setDraft} form={FORM} lookups={LOOKUPS} assetJob={null}
                  onBack={vi.fn()} onFinished={vi.fn()} />
    </MemoryRouter>
  );
}

beforeEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
afterEach(cleanup);

it('summarizes every step, with Skipped for skipped ones', async () => {
  api.getMoveSetup.mockResolvedValue(base());
  render(<Harness initial={base()} />);
  expect(screen.getByText('SJC to DAL')).toBeTruthy();
  expect(screen.getByText('San Jose DC')).toBeTruthy();
  expect(screen.getByText('CRT-001')).toBeTruthy();
  expect(screen.getByText('2 crates · Pallet · 1 Priority · 1 untagged')).toBeTruthy();
  expect(screen.getAllByText('Skipped')).toHaveLength(2);           // assets and trucks
});

it('creates, shows progress, then the finish screen', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  api.getMoveSetup.mockResolvedValueOnce(base())
    .mockResolvedValueOnce(base({ status: 'running', processed_rows: 1, total_rows: 2 }))
    .mockResolvedValueOnce(base({ status: 'completed', initiative_id: 'm1', payload: null,
      results: { move_id: 'm1', assets: null, crates: 2, trucks: 0 } }));
  api.createMoveFromSetup.mockResolvedValue(base({ status: 'queued' }));
  render(<Harness initial={base()} />);
  await user.click(screen.getByRole('button', { name: 'Create move' }));
  expect(await screen.findByText('Creating the move…')).toBeTruthy();   // queued, no total yet
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(await screen.findByText('Creating… 1 of 2')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(await screen.findByText('Move created')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open the move' }).getAttribute('href')).toBe('/initiatives/m1');
  expect(screen.getByText('2 crates created · 0 trucks created')).toBeTruthy();
});

it('a 422 lists the reasons; a failed job says why and stays editable', async () => {
  const user = userEvent.setup();
  api.getMoveSetup.mockResolvedValue(base());
  api.createMoveFromSetup.mockRejectedValueOnce(new ApiError(422, 'setup_invalid',
    { code: 'setup_invalid', reasons: ['Pick a crate type.'] }));
  const { unmount } = render(<Harness initial={base()} />);
  await user.click(screen.getByRole('button', { name: 'Create move' }));
  expect(await screen.findByText('Pick a crate type.')).toBeTruthy();
  unmount();

  const failed = base({ status: 'failed', error: 'name_taken',
    results: { reasons: ['These truck names already exist: TRK-002.'] } });
  api.getMoveSetup.mockResolvedValue(failed);
  render(<Harness initial={failed} />);
  expect(screen.getByText('These truck names already exist: TRK-002.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: 'Create move' }) as HTMLButtonElement).disabled).toBe(false);
});
```

- [ ] **Step 7: Implement `MoveSetupFinish.tsx` and `ReviewStep.tsx`:**

```tsx
// MoveSetupFinish.tsx
/** The finish screen: Open the move, the crate/truck counts, and the From-To
 *  import's per-row summary with its CSV download (BulkApplySummary). */
import { Link } from 'react-router-dom';

import type { MoveSetupDraft } from '../../lib/api';
import { assetSummary, createdCount } from '../../lib/moveSetup';
import BulkApplySummary from '../bulk/BulkApplySummary';

export default function MoveSetupFinish({ draft, moveName }: { draft: MoveSetupDraft; moveName: string }) {
  const results = draft.results ?? {};
  const moveId = results.move_id ?? draft.initiative_id ?? '';
  const assets = results.assets ? assetSummary(results.assets) : null;
  return (
    <section className="bulk-section">
      <p className="eyebrow-sm">Move created</p>
      <div className="bulk-actions">
        <b>{moveName} was created.</b>
        <Link className="btn-solid" to={`/initiatives/${moveId}`}>Open the move</Link>
      </div>
      <p className="set-note">
        {createdCount(results.crates ?? 0, 'crate')} · {createdCount(results.trucks ?? 0, 'truck')}
      </p>
      {assets ? (
        <BulkApplySummary result={assets} entityLabel="Serial"
                          linkFor={(r) => (r.asset_id ? `/assets/${r.asset_id}` : null)}
                          filename="move-setup-assets-summary" openTo={`/initiatives/${moveId}`}
                          openLabel="Open the move" pageSize={200}
                          extraColumn={{ label: 'Message', value: (r) => r.message }} />
      ) : <p className="page-hint">No From-To file was imported.</p>}
    </section>
  );
}
```

```tsx
// ReviewStep.tsx
/** Step 5 — review and create. A summary of every step ("Skipped" for a
 *  skipped one), then Create move: queue the draft, poll it every 1.5 s
 *  ("Creating… N of M"), and show the finish screen. A failure shows its
 *  reason as sentences and the draft stays editable (Back, then Create again). */
import { useEffect, useState } from 'react';

import {
  ApiError, createMoveFromSetup, getMoveSetup, type ImportJobOut, type MoveSetupDraft,
} from '../../lib/api';
import { assignTags, summaryText } from '../../lib/bulkContainers';
import { TAG_TYPES } from '../../labels/tagTypes';
import type { InitiativeFormState } from '../../lib/initiatives';
import {
  MOVE_SETUP_ERRORS, moveSetupError, moveSummaryRows, setupReasons, type MoveSetupLookups,
} from '../../lib/moveSetup';
import { CRATE_MAX, generateNames, TRUCK_MAX } from '../../lib/namingConvention';
import DataTable from '../DataTable';
import WizardFooter from '../common/WizardFooter';
import ImportReport from '../imports/ImportReport';
import MoveSetupFinish from './MoveSetupFinish';

const POLL_MS = 1500;
const LIST_LIMIT = 100;
const NO_FIXES: ReadonlySet<string> = new Set();

interface Props {
  draft: MoveSetupDraft;
  onDraft: (draft: MoveSetupDraft) => void;
  form: InitiativeFormState;
  lookups: MoveSetupLookups;
  assetJob: ImportJobOut | null;
  onBack: () => void;
  onFinished: () => void;
}

function NamesTable({ label, names, tags }: { label: string; names: string[]; tags?: (string | null)[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? names : names.slice(0, LIST_LIMIT);
  return (
    <>
      <DataTable ariaLabel={label}
                 columns={[{ key: 'name', label: 'Name', mono: true },
                           ...(tags ? [{ key: 'tag', label: 'Label tag' }] : [])]}
                 rows={shown.map((name, i) => ({
                   key: name,
                   cells: [name, ...(tags ? [tags[i] ? TAG_TYPES[tags[i] as keyof typeof TAG_TYPES].label : '—'] : [])],
                 }))} />
      {names.length > shown.length && (
        <div className="bulk-actions">
          <button className="mini-btn" type="button" onClick={() => setAll(true)}>Show all {names.length}</button>
        </div>
      )}
    </>
  );
}

export default function ReviewStep({ draft, onDraft, form, lookups, assetJob, onBack, onFinished }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reasons, setReasons] = useState<string[]>([]);
  const running = draft.status === 'queued' || draft.status === 'running';

  // the payload as the server holds it now (the live-saved crate/truck edits included)
  useEffect(() => { void getMoveSetup(draft.id).then(onDraft).catch(() => undefined); }, [draft.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!running) return undefined;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const next = await getMoveSetup(draft.id);
        if (stopped) return;
        onDraft(next);
        if (next.status !== 'queued' && next.status !== 'running') return;
      } catch (err) {
        if (stopped) return;
        if (err instanceof ApiError) { setError(moveSetupError(err)); return; }
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    timer = setTimeout(() => void tick(), POLL_MS);
    return () => { stopped = true; clearTimeout(timer); };
  }, [running, draft.id, onDraft]);

  useEffect(() => { if (draft.status === 'completed') onFinished(); }, [draft.status, onFinished]);

  if (draft.status === 'completed') return <MoveSetupFinish draft={draft} moveName={form.name.trim()} />;

  const create = async () => {
    setBusy(true);
    setError('');
    setReasons([]);
    try {
      onDraft(await createMoveFromSetup(draft.id));
    } catch (err) {
      setError(moveSetupError(err));
      setReasons(setupReasons(err));
    } finally {
      setBusy(false);
    }
  };

  const payload = draft.payload;
  const crates = payload?.crates ?? null;
  const trucks = payload?.trucks ?? null;
  const crateNames = crates ? generateNames(crates.convention, crates.count, crates.start, CRATE_MAX).names : [];
  const truckNames = trucks ? generateNames(trucks.convention, trucks.count, trucks.start, TRUCK_MAX).names : [];
  const typeLabel = lookups.containerTypes.find((t) => t.key === crates?.container_type)?.label
    ?? crates?.container_type ?? '';
  const failedReasons = draft.status === 'failed' ? draft.results?.reasons ?? [] : [];
  const progress = draft.total_rows > 0
    ? `Creating… ${draft.processed_rows} of ${draft.total_rows}` : 'Creating the move…';

  return (
    <>
      <section className="bulk-section">
        <p className="eyebrow-sm">The move</p>
        <DataTable ariaLabel="The move" columns={[{ key: 'field', label: 'Field' }, { key: 'value', label: 'Value' }]}
                   rows={moveSummaryRows(form, lookups).map(([k, v]) => ({ key: k, cells: [k, v] }))} />
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">From-To assets</p>
        {!payload?.assets ? <p className="page-hint">Skipped</p>
          : assetJob?.results
            ? <ImportReport job={assetJob} fixedTexts={NO_FIXES} onFix={() => undefined}
                            canAddModels={false} canChangeModels={false} readOnly />
            : <p className="page-hint">{payload.assets.filename}</p>}
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Crates</p>
        {!crates ? <p className="page-hint">Skipped</p>
          : crateNames.length === 0 ? <p className="page-hint">No crates</p>
          : (<>
              <p className="page-hint">
                {summaryText(crateNames.length, crates.tags, 'crate').replace(
                  /^(\d+ crates?)/, `$1 · ${typeLabel}`)}
              </p>
              <NamesTable label="Crates" names={crateNames} tags={assignTags(crateNames.length, crates.tags)} />
            </>)}
      </section>

      <section className="bulk-section">
        <p className="eyebrow-sm">Trucks</p>
        {!trucks ? <p className="page-hint">Skipped</p>
          : truckNames.length === 0 ? <p className="page-hint">No trucks</p>
          : <NamesTable label="Trucks" names={truckNames} />}
      </section>

      {draft.status === 'failed' && (
        <div className="dir-empty">
          <b>The move was not created</b>
          {MOVE_SETUP_ERRORS[draft.error ?? ''] ?? MOVE_SETUP_ERRORS.worker_error}
          {failedReasons.length > 0 && (
            <ul className="ms-reasons">{failedReasons.map((r) => <li key={r}>{r}</li>)}</ul>
          )}
        </div>
      )}
      {reasons.length > 0 && <ul className="ms-reasons">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
      {running && <p className="set-note">{progress}</p>}

      <WizardFooter onBack={running ? undefined : onBack} onNext={() => void create()}
                    nextLabel={running ? 'Creating…' : 'Create move'} busy={busy || running}
                    error={reasons.length > 0 ? '' : error} />
    </>
  );
}
```

  `onFinished` must be stable; `BulkNewMove.tsx` already passes the `useCallback` `finish`. `ImportReport` renders a `list-head`; guardrail (h) is satisfied inside `ImportReport.tsx` itself, so `ReviewStep` needs nothing extra.

- [ ] **Step 8: Run** `npx vitest run src/components/moveSetup src/components/containers src/components/imports src/pages/BulkNewMove.test.tsx src/lib src/styles/listTypography.test.ts`, then `npx tsc -b` and `npm run build`. Expected: PASS and clean.
- [ ] **Step 9: Commit** `feat(portal): move setup crates, trucks, review and create — live clash checks, progress, finish summary with CSV`.

---

### Task 7 (controller): full suites plus live verify

- [ ] Whole-branch review of Tasks 1–6 against the spec, especially the payload shape, the failure codes, every sentence in American English, and the no-migration rule.
- [ ] Full API suite, foreground, one run: `cd …/move-setup/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_move_setup /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest -q` (timeout 600000 ms). Then `ruff check src tests`.
- [ ] Full portal suite: `npx vitest run`, `npx tsc -b`, `npm run build`.
- [ ] **Live verify** on the dev stack, with the import worker running:
  1. As an admin, open Bulk Actions and use the "Create a move in steps" card to reach `/bulk/new-move`.
  2. Step 1: fill in the move with two sites that have codes.
  3. Step 2: upload a real From-To file. Watch the check progress, fix one make/model, then Check again.
  4. Step 3: confirm the crates prefill `CRT-{o}-{d}-xxx`. Set the count, the type and a tag.
  5. Plant a clashing crate name in another tab, confirm it is flagged, then change the start.
  6. Step 4: set the trucks.
  7. Review, then Create move. Confirm the progress count and the finish screen: the CSV downloads, and Open the move works.
  8. Confirm the move page shows the assets, the containers list shows the crates with the move and the origin site, and the trucks list shows the trucks from origin to destination.
- [ ] **Live verify**, second run: skip every optional step and create. Only the move exists.
- [ ] **Live verify**, leave guard: with a draft open, click a sidebar link. Check the prompt, then Keep editing, then Discard. The draft row is gone.
- [ ] Unchanged surfaces: "New initiative", the move's own From-To import page, and Containers › Add in bulk look and behave exactly as before.
- [ ] Parity: mark To-Do #6 "One-shot move creation" done in the parity workbook and markdown, if they are tracked on this branch. Update the memory index.
