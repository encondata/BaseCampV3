# Notifications Phase 2, Slice 3 (Bulk Actions) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the import worker finishes or fails a job that writes data (Bulk update assets, the From-To import, Move setup), the person who started it hears, through their Bulk actions switches.

**Architecture:**

- **Registry:** two kinds sent directly with `notify()`, in a new Bulk actions category on the Phase 1 grid.
- **Sending:** `imports/notices.py` builds the notice from a snapshot of the job. `imports/worker.run_once` calls it after the job's final state is committed, in its own session. This is the reports worker's pattern: a failure to notify is logged and never changes the job.
- **Portal:** the new category in the grids, and nothing else (these kinds can't be watched).

**Tech Stack:** FastAPI, SQLAlchemy 2 async, PostgreSQL 16, pytest (real Postgres); React 18 + TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-notifications-phase2-design.md` (Build order, slice 3; section 5 "Bulk action finished or failed" and "The grid").

## Global Constraints

- **American English** everywhere. Grep the changed files for `-ise|-isation|colour|enrol\b|enrolment|behaviour|centre|licence` before committing.
- **Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/notif-phase2`, branch `notif-phase2`.
- **API tests:** `cd api && SS_TEST_DB=serversherpa_test_notif2 PYTHONPATH=src .venv/bin/pytest <files> -q -p no:cacheprovider`. Don't run the whole API suite.
- **Portal checks:** `cd portal && npx vitest run <files>`, `npx tsc -p .`, `npx vitest run src/styles`, `npm run build`. Before committing a portal change, run the whole portal suite once (category pins are scattered).
- **Run every test command in the FOREGROUND** with a 600000 ms timeout. Never background a suite and end your turn waiting.
- **Git hygiene:**
  - Plain single git commands as `git -C <worktree> …`.
  - Never use bare `git stash`, and never commit `api/src/serversherpa/_dev_reload.py`.
  - Trailer exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Session discipline:** `notify()` never commits; the caller does.
- **No new migration.** No new policy numbers.
- **Copy** exactly as quoted here. No `state` key in a notification payload.

## Calls this plan makes (beyond the spec)

1. **A cancelled job sends nothing.** The person cancelled it themselves.
2. **A job whose `created_by` is null sends nothing.** There is nobody to tell.
3. **A From-To import that finishes with row errors is still "finished".** It is listed as such, and its link opens the assets.
4. **A failed move setup links to `/bulk/new-move`, which opens a new wizard.** The portal has no way to reopen a kept draft from a link today, and this slice adds no job pages (spec).
5. **The notice is sent after the job's final state is committed, in a new session.** A failure to notify is logged once, and the job stays as it is. This is the `reports/worker.py` pattern.

## Review Focus

- **The validate pass is silent.** Uploading a From-To file runs a validate job that writes nothing. It sends no notice, nor does the move setup wizard's file check (Task 1: `test_validation_passes_are_silent`).
- **A worker error after the job's own commit.** Nothing in the notice path can turn a completed job into a failed one (Task 1: `test_a_notify_failure_leaves_the_job_alone`).
- **The switch decides.** With Bulk actions Inbox off, the person gets no inbox row (`inbox_suppressed` `category_off`), and the job is unaffected (Task 1: `test_the_category_switch_applies`).

---

### Task 1: Bulk action notices (API)

**Files:**
- Modify: `api/src/serversherpa/notifications/kinds.py`, `api/src/serversherpa/notifications/company.py`, `api/src/serversherpa/system/config_store.py` (defaults)
- Create: `api/src/serversherpa/imports/notices.py`
- Modify: `api/src/serversherpa/imports/worker.py` (`run_once`)
- Test: `api/tests/test_bulk_action_notices.py` (new). Update `tests/test_notification_kinds.py`, `tests/test_notification_settings_api.py` and `tests/test_notification_log_api.py` (kind rows).

**Interfaces:**
- **Kinds:**
  - `CATEGORIES` gains `"bulk_actions": "Bulk actions"` after devices.
  - `KINDS` gains, after `device_offline`:
    - `"bulk_action_finished": KindInfo("bulk_actions", "Bulk action finished")`
    - `"bulk_action_failed": KindInfo("bulk_actions", "Bulk action failed")`
  - Neither is watchable. `CONFIGURABLE_CATEGORIES` gains `"bulk_actions"`, with default on/on.
- **In `imports/notices.py`:**
  - `ACTIONS = {"asset_bulk_update": "Bulk update assets", "move_assets": "From-To import", "move_setup": "Move setup"}`.
  - `@dataclass(frozen=True) class JobDone: job_id: uuid.UUID; kind: str; phase: str; status: str; created_by: uuid.UUID | None; initiative_id: uuid.UUID | None`.
  - `def writes_data(kind: str, phase: str) -> bool`: `asset_bulk_update` and `move_setup` always; `move_assets` only for `phase == "commit"`.
  - `async def notify_job_done(db: AsyncSession, done: JobDone) -> None`:
    - It sends nothing unless `writes_data`, `created_by` is set and `status` is `"completed"` or `"failed"`.
    - **Finished:** `notify(db, created_by, "bulk_action_finished", f"{action} finished", body=<initiative name or "">, link=<finished link>, payload={"job_id": …, "job_kind": …})`. The finished links are:
      - move setup → `/initiatives/{initiative_id}` (the new move);
      - From-To import → `/initiatives/{initiative_id}?tab=assets`;
      - Bulk update assets → `/assets`.
    - **Failed:** `notify(db, created_by, "bulk_action_failed", f"{action} failed", link=<tool link>, payload=…)`, title and link only (no body). The tool links are:
      - `/bulk/assets`;
      - `/initiatives/{initiative_id}/import-assets`;
      - `/bulk/new-move`.
    - Both calls pass the kind as the third positional string literal, so the registration scan finds them.
- **`run_once`:**
  - It reads the job's id, kind, phase, created_by and initiative_id before the `try`. A rollback expires the row.
  - After the job's terminal commit (both the success path and the `except` path), it opens a new session from the same maker. There it calls `notify_job_done` with the final status (re-read from the row) and the job's initiative id. Move setup sets its id only at the end.
  - Then it commits, all inside `try/except Exception`, which logs one warning with the exception class only.
  - `notify` is imported at module level in `imports/notices.py`, so tests can monkeypatch it.

- [ ] **Step 1: Write the failing tests** in `test_bulk_action_notices.py`. Use the existing helpers:
  - `tests/test_asset_bulk_update_apply.py` `mk_person` / `mk_job`;
  - `tests/test_import_worker.py` `_job` (set `created_by` on the row);
  - `tests/test_move_setup_worker.py` `full_draft` / `queue`.
  - Drive each with `run_once(get_sessionmaker())`. The tests:
  - `test_bulk_update_finished_and_failed`:
    - Completed: title "Bulk update assets finished", body "", link `/assets`.
    - `rule_failed`: title "Bulk update assets failed", body "", link `/bulk/assets`.
  - `test_from_to_import_finished_and_failed`:
    - A commit job: title "From-To import finished", body = the initiative's name, link `/initiatives/{id}?tab=assets`.
    - `file_unreadable`: "From-To import failed", link `/initiatives/{id}/import-assets`.
  - `test_move_setup_finished_and_failed`:
    - Success: "Move setup finished", body = the new move's name, link `/initiatives/{new id}`.
    - `name_taken`: "Move setup failed", link `/bulk/new-move`.
  - `test_validation_passes_are_silent` (Review Focus): a `move_assets` validate job, and a wizard file check, send no notification.
  - `test_cancelled_and_ownerless_jobs_are_silent`.
  - `test_a_notify_failure_leaves_the_job_alone` (Review Focus): monkeypatch `notices.notify` to raise. The job stays `completed`, one warning line is logged, and the worker returns normally.
  - `test_the_category_switch_applies` (Review Focus): `inbox_suppressed` with `category_off`.
  - Update the kind and category pins. The registration scan must find both kinds.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step-1 files plus `tests/test_import_worker.py tests/test_asset_bulk_update_apply.py tests/test_move_setup_worker.py tests/test_notification_kinds.py tests/test_notification_settings_api.py tests/test_notification_log_api.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): tell people when their bulk action finishes or fails`.

### Task 2: Portal: the Bulk actions category

**Files:**
- Modify: `portal/src/lib/notificationKinds.ts` (Bulk actions after Devices, before Account security) and `portal/src/lib/notificationSwitches.ts` (`CONFIGURABLE`, plus `CATEGORY_DESCRIPTIONS.bulk_actions = 'Background bulk actions, finished or failed'`), and the `NotificationCategory` union in `portal/src/lib/api.ts`
- Test: update every pin the new row moves (the same files slice 2's Devices row touched)

- [ ] **Step 1: Update the pins first** (they fail).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole portal suite, `npx tsc -p .` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): Bulk actions joins the notification grid`.
