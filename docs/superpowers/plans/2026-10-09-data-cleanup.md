# Data Cleanup Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer-only Cleanup tab on `/dev/database` that previews and purges sign-in leftovers, old history rows and deleted files (with their storage objects), and lists likely duplicate assets and people.

**Architecture:** A category registry in `api/src/serversherpa/devtools/cleanup.py` — each category knows how to count and purge itself for a cutoff — exposed by a new router `api/routes/cleanup.py` mounted at `/devtools/cleanup` (`preview`, `run`, `duplicates`). Purges run in committed 5,000-row chunks; storage objects are deleted after their chunk commits. The portal adds a fourth tab component `components/dev/CleanupTab.tsx`.

**Tech Stack:** FastAPI, SQLAlchemy async, pytest; React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-09-data-cleanup-design.md` — binding; its category tables define exactly which rows go.

## Global Constraints

- Groups and categories, exactly (keys and labels):
  - `signin` "Sign-in leftovers": `sessions` "Expired sessions", `reset_links` "Used or expired password-reset links", `trusted_browsers` "Expired or revoked trusted browsers".
  - `history` "Old history": `mail` "Sent, failed and skipped mail", `notifications` "Read or hidden notifications", `imports` "Finished import jobs", `reports` "Report runs", `label_runs` "Label generation runs", `spec_lookups` "Finished spec lookups", `rule_logs` "Status rule run logs".
  - `deleted` "Deleted files": `attachments` "Deleted files", `notes` "Deleted notes", `label_fonts` "Deleted label fonts".
- `older_than_days`: integer 1–3650, required for `history` and `deleted`, ignored for `signin`; UI default 90. Bad value → 422 `invalid_age`. Unknown group/category → 422 `unknown_category`.
- Never touch `audit_log`, `raw_scans`, `generated_labels` (only null `run_id`), `spec_suggestions` (FK sets `job_id` NULL), rotated/revoked sessions still inside their lifetime, approval-card notifications whose `payload->>'state'` is `pending` or `open`, any non-terminal job/run.
- Storage object deleted only when no kept row uses the same key (rules per category in the spec). Object deletes happen after the rows' chunk commits; failures counted as `files_failed`, never abort the run.
- Chunk size 5,000 rows per committed statement (a module constant tests can lower).
- Permissions: `devtools:view` for preview/duplicates, `devtools:change` for run (use the same dependency style as `api/routes/devtools.py`).
- One audit row per run: `entity_type="system"`, `action="cleanup.run"`, `changes={"group", "older_than_days", "categories": {key: {rows_deleted, files_deleted, files_kept, files_failed}}}`.
- Duplicate lists capped at 200 groups each.
- Portal: house idioms only (`.sysconf-tab` tab bar, `init-panel sysconf-card`, `eyebrow-sm`, `page-hint`, `mini-btn`, `btn-solid`, `dir-list` rows, the existing toggle/Switch component, `pf-error`). American English. No raw native checkboxes/selects.
- Never commit `api/src/serversherpa/_dev_reload.py`. Never `git stash`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## How to run things (worktree `.claude/worktrees/data-cleanup`)

- API tests (foreground, one at a time): `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_cleanup DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/pytest -q <files>`. Never the dev DB.
- Storage in tests: follow how existing tests fake `serversherpa.services.storage` (e.g. `tests/test_db_backups.py`, `tests/test_attachments.py`) — never hit real S3.
- Lint changed files: `cd api && .venv/bin/ruff check <files>`; add no new findings.
- Portal: `cd portal && npx vitest run <files>`; before committing portal work run the full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: Cleanup framework, sign-in group and the routes

**Files:**
- Create: `api/src/serversherpa/devtools/cleanup.py`
- Create: `api/src/serversherpa/api/routes/cleanup.py` (router prefix `/devtools/cleanup`; register it in `api/app.py` next to the devtools router)
- Modify: `api/src/serversherpa/api/schemas.py` (request/response models)
- Test: `api/tests/test_cleanup_api.py`

**Interfaces — Produces (later tasks add categories to the same registry):**

```python
CHUNK_SIZE = 5000

@dataclass
class CategoryResult:
    key: str
    rows_deleted: int = 0
    files_deleted: int = 0
    files_kept: int = 0
    files_failed: int = 0

@dataclass(frozen=True)
class Category:
    key: str
    label: str
    description: str
    count: Callable[[AsyncSession, datetime | None], Awaitable[tuple[int, int]]]   # (rows, files)
    purge: Callable[[async_sessionmaker, datetime | None], Awaitable[CategoryResult]]

@dataclass(frozen=True)
class Group:
    key: str
    label: str
    description: str
    needs_age: bool
    categories: tuple[Category, ...]

GROUPS: dict[str, Group]      # ordered: signin, history, deleted
async def cutoff_for(db, older_than_days: int | None) -> datetime | None   # DB clock: now() - interval
async def preview(db, older_than_days: int) -> list[dict]
async def run(maker, group_key: str, category_keys: list[str], older_than_days: int | None) -> list[CategoryResult]
async def delete_objects(keys: Iterable[str], result: CategoryResult) -> None   # after commit; counts deleted/failed
```

`purge` receives the sessionmaker (not a session) so it can commit each chunk in its own transaction. Chunk pattern: select up to `CHUNK_SIZE` ids matching the condition (`FOR UPDATE SKIP LOCKED` is not needed), delete those ids, commit, repeat until fewer than `CHUNK_SIZE` came back.

Routes:
- `GET /devtools/cleanup/preview?older_than_days=90` → `{"groups": [{key, label, description, needs_age, categories: [{key, label, description, rows, files}]}]}`. `older_than_days` defaults to 90 and is validated (1–3650).
- `POST /devtools/cleanup/run` body `{group, categories, older_than_days?}` → `{"group", "older_than_days", "categories": [CategoryResult...]}`; writes the audit row (commit it).

- [ ] **Step 1: Failing tests** (`test_cleanup_api.py`): use the developer fixture style from `tests/test_devtools.py` / `tests/test_db_backups.py` for a developer login, and a staff/admin login for 403s.
  1. Preview returns the three groups in order with all keys/labels (signin categories present now; history/deleted may be empty lists until Tasks 2–3 — assert by key for signin only).
  2. Sessions: seed an expired session, a live one, a rotated-but-unexpired one, a revoked-but-unexpired one, and a live row whose `replaced_by` points at the expired one → run `signin/sessions` deletes only the expired one and nulls that `replaced_by`.
  3. Reset links: used, expired, fresh → only used+expired deleted.
  4. Trusted browsers: revoked, expired, live → only revoked+expired deleted.
  5. Preview counts equal the run's `rows_deleted`.
  6. Chunking: monkeypatch `CHUNK_SIZE = 2`, seed 5 expired sessions → all 5 deleted.
  7. Validation: unknown group/category → 422 `unknown_category`; `history` with no/0/3651 age → 422 `invalid_age` (add the history group key now with an empty category tuple so validation is testable).
  8. Permissions: non-developer → 403 on all three routes; a developer override of `devtools:view` only → preview OK, run 403 (if the access test helpers make that easy; otherwise developer vs non-developer is enough).
  9. Audit row: action `cleanup.run`, `changes` carries group, age and per-category counts.
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement** the framework, the three signin categories, and the routes (preview/run; leave `duplicates` to Task 4).
- [ ] **Step 4: Run the new file + `tests/test_devtools.py tests/test_auth_refresh*.py` (or whichever files cover refresh-token rotation/reuse — find them) — pass. Ruff clean on new files.**
- [ ] **Step 5: Commit** — `feat(devtools): data cleanup framework and sign-in leftovers purge (/devtools/cleanup)`.

---

### Task 2: Old history categories

**Files:**
- Modify: `api/src/serversherpa/devtools/cleanup.py`
- Test: `api/tests/test_cleanup_history.py`

**Interfaces — Consumes:** Task 1 registry, `delete_objects`, `CHUNK_SIZE`.
**Produces:** the seven `history` categories, and `async def keys_in_use(db, keys: set[str]) -> set[str]` — returns which of the given storage keys are still referenced by a kept row: non-deleted `attachments.storage_key`, `report_runs.storage_key`, `import_jobs.file_key`, `people.avatar_key`, `clients.logo_key`, `partners.logo_key`, non-deleted `label_fonts.storage_key` (check the actual column names in `db/models.py`). The caller passes the keys of rows it is about to delete, and calls it *after* deleting those rows in the same transaction (so the rows being deleted don't count as "in use").

- [ ] **Step 1: Failing tests**, one per category, each seeding rows on both sides of every condition in the spec table:
  - mail: sent/failed/skipped old → deleted; queued/sending old → kept; sent recent → kept.
  - notifications: read old / dismissed old → deleted; unread old → kept; read old approval card with `payload.state` pending or open → kept; read recent → kept.
  - imports: terminal old → deleted with its file object deleted; non-terminal old → kept; two old terminal jobs sharing a key where only one qualifies → object kept (`files_kept`).
  - reports: terminal old → deleted, object deleted; a run whose `storage_key` equals a non-deleted attachment's key → row deleted, object kept.
  - label_runs: terminal old run with generated labels → run deleted, labels kept with `run_id` NULL; running run → kept.
  - spec_lookups: finished old job with suggestions → job deleted, suggestions kept with `job_id` NULL; queued/running → kept.
  - rule_logs: old → deleted, recent → kept.
  - Storage failure: fake `delete_object` raising for one key → `files_failed == 1`, rows still deleted, run completes.
  - "Terminal status" per table: read the CHECK constraints / code (`imports/jobs.py`, `reports/worker.py`, `labels/generate/runner.py`, spec lookup worker) and assert the exact set used.
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement.** Before writing `imports`, grep for any non-FK reader of old `import_jobs` rows (e.g. the From-To import report download, generated-serial reuse) and note what deleting them removes in the category `description` (for example "Their result reports go too.").
- [ ] **Step 4: Run** both cleanup test files + `tests/test_import_worker.py tests/test_report_worker.py tests/test_notifications_inbox.py tests/test_mail_delivery.py` — pass. Ruff clean.
- [ ] **Step 5: Commit** — `feat(devtools): old history cleanup (mail, notifications, finished jobs and runs, rule logs)`.

---

### Task 3: Deleted files categories

**Files:**
- Modify: `api/src/serversherpa/devtools/cleanup.py`
- Test: `api/tests/test_cleanup_deleted.py`

**Interfaces — Consumes:** `keys_in_use`, `delete_objects`, registry.

- [ ] **Step 1: Failing tests:**
  - attachments: deleted before cutoff → row + object deleted; deleted after cutoff → kept; not deleted → kept; a deleted attachment referenced by `report_runs.attachment_id` → link nulled, row deleted; key shared with a live attachment / a report run / a person `avatar_key` → object kept (`files_kept`).
  - notes: deleted before cutoff → deleted; others kept.
  - label_fonts: deleted before cutoff → row + object deleted; shared key → kept.
  - Preview `files` counts objects that would actually be deleted (excludes shared keys).
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the three cleanup test files + `tests/test_attachments.py tests/test_notes_api.py` — pass. Ruff clean.
- [ ] **Step 5: Commit** — `feat(devtools): purge deleted files, notes and label fonts with their storage objects`.

---

### Task 4: Duplicate finder

**Files:**
- Create: `api/src/serversherpa/devtools/duplicates.py`
- Modify: `api/src/serversherpa/api/routes/cleanup.py`, `api/src/serversherpa/api/schemas.py`
- Test: `api/tests/test_cleanup_duplicates.py`

**Interfaces — Produces:** `GET /devtools/cleanup/duplicates` (`devtools:view`) → `{"assets": [{"serial", "items": [{id, name, serial_number, site_name, status_label, href}]}], "people": [{"name", "items": [{id, display_name, email, has_login, is_worker, href}]}]}` — groups of 2+, largest first, ≤ 200 groups each; `href` per the spec (`/assets?open=<id>`; `/people/users/<id>` if a login, else `/people/workers/<id>` if a worker profile, else null).

- [ ] **Step 1: Failing tests:** serial match ignores case and surrounding spaces; empty/null serials ignored; archived assets excluded; singletons excluded; people grouped by trimmed lowercase first+last; archived people and hidden kiosk move identities (`Person.source == KIOSK_MOVE_SOURCE` — find the constant) excluded; href rules; group cap (monkeypatch the cap to 1); non-developer 403.
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement** with two grouped SQL queries (no per-row queries). Check the real column names (`serial_number`? `serial`?) in `db/models.py`.
- [ ] **Step 4: Run** the four cleanup test files — pass. Ruff clean.
- [ ] **Step 5: Commit** — `feat(devtools): duplicate finder for assets by serial and people by name`.

---

### Task 5: Portal Cleanup tab

**Files:**
- Create: `portal/src/components/dev/CleanupTab.tsx` (+ `CleanupTab.test.tsx`)
- Modify: `portal/src/pages/DevDatabase.tsx` (fourth tab "Cleanup"), `portal/src/lib/api.ts` (types + `getCleanupPreview`, `runCleanup`, `getCleanupDuplicates`), `portal/src/pages/DevDatabase.test.tsx` (tab presence)
- CSS only if needed, next to the existing dev/database styles; reuse classes first.

**Interfaces — Consumes:** the three routes from Tasks 1–4.

- [ ] **Step 1: Failing tests** (mock the API functions):
  - The page shows tabs Reconcile, Backups, Testing, Cleanup; clicking Cleanup renders the tab.
  - Intro text and a link/button that switches to the Backups tab.
  - Three group cards with their category rows and toggles (all on); History and Deleted cards have an "Older than" days field prefilled 90; Sign-in has none.
  - Preview calls `getCleanupPreview(90)` (or the edited age) and shows counts like "1,204 rows · 38 files" (rows only when files is 0 and the category has no files).
  - Delete is disabled until a preview with a non-zero selected count; turning a category off removes it from the request; Delete confirms (mock `window.confirm`) naming the totals, calls `runCleanup({group, categories, older_than_days})`, shows the per-category results, then re-previews.
  - Age outside 1–3650 shows an inline `pf-error` and blocks Preview/Delete.
  - Duplicates card: "Find duplicates" → two lists with links (`href`), and "No duplicates found." when both are empty; items without `href` render as text.
  - API errors show in the card's `pf-error`.
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement** with house idioms (look at `BackupsTab` in `DevDatabase.tsx` and `components/dev/DbTestingTab.tsx` for the card/list/confirm patterns, and use the shared `Switch` component for toggles).
- [ ] **Step 4: Run** the full `npx vitest run`, `npx tsc -b`, `npm run build` — all pass (guardrails included).
- [ ] **Step 5: Commit** — `feat(portal): Cleanup tab on /dev/database`.
