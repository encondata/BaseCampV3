# From-To Client of Record Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The From-To import gives every imported asset its move's client. A serial that belongs to a different client is flagged at the check, and staff must choose per row: Continue (reassign) or Skip. A one-time fix-up covers already-imported assets. The check summary links unmatched Owner values to the client's Groups › Review.

**Architecture:**
- **Pipeline.** `run_import` loads the move's client and, per existing asset, sets its client or flags a conflict (validate) / applies the stored choice (commit).
- **Choices** travel as `job.options["client_choices"]` (`{serial_lower: "continue"|"skip"}`), set by the commit endpoint, which refuses until every flagged serial has one. The wizard does the same through its draft check job.
- **Portal.** The shared `ImportReport` gets a conflicts panel with Continue/Skip.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic, Postgres; React + TypeScript + Vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-from-to-client-of-record-design.md`. Read it first; its "Rules decided while planning" are binding.

## Global Constraints

- **Migration.** The migration is `0129_asset_client_backfill.py`, `down_revision = "0128"`. Its downgrade is a no-op (the backfilled values stay), with a comment saying so.
- **New detail statuses:**
  - `"conflict"` appears only at the check.
  - `"skipped"` appears only at commit.
  - Updated or created rows whose client changed carry `client_moved_from: {"id", "name"}`.
  - Conflict and skipped rows carry `current_client: {"id", "name"}`.
- **Summary keys:**
  - `conflicts` (check), `moved` and `skipped` (commit);
  - `owner_unmatched`, an int, present only when the move has a client;
  - `client_id` (the client the check used).
- **Error codes:** 422 `client_choices_required` (with `detail.serials`), 422 `invalid_client_choice`, 409 `check_stale_client` (wizard).
- **Copy, verbatim:**
  - "Belongs to {client}"
  - "Continue — move it to {client}"
  - "Skip"
  - "Continue all"
  - "Skip all"
  - "Choose Continue or Skip for every flagged row before importing."
  - Owner line: "{N} Owner value(s) don't match a group" plus a link "Review groups".
  - Report results: "Moved from {client}" and "Skipped — belongs to {client}".
- **Audit.** Each reassignment writes `audit(entity_type="asset", action="update", changes=diff(...client_id...) + {"source": {"from": None, "to": "from_to_import"}, "job_id": …})`, using `services/audit.py` snapshot/diff, as in assets/bulk_update.py:597-606.
- **Running tests in this worktree.** Run API tests as `cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_ftclient .venv/bin/python -m pytest …`, in the FOREGROUND, never backgrounded. Run portal tests as `cd portal && npx vitest run …` plus `npx tsc -p tsconfig.json --noEmit`. Never `npm install`.
- **Portal rules.** American English. StandardModal for any modal. Rounded corners. Buttons never below a scroll. Light/dark tokens. No widgets beyond those named here.
- **Unchanged behavior.**
  - Moves without a client import exactly as today.
  - Rows whose asset already has this client, or no client, never conflict.

## Review Focus

1. **A file with the same conflicting serial twice.** One choice applies to both rows. Pinned in Task 1 (`test_duplicate_conflict_serial_one_choice`).
2. **Continue on an asset that is on another client's move.** That roster row stays put. The asset's `client_id` changes and it is audited. Pinned in Task 1 (`test_continue_reassigns_and_audits`).
3. **A commit with a stale or partial choice map.** 422 lists the missing serials, and nothing is written. Pinned in Task 2 (`test_commit_requires_every_choice`).
4. **A new conflict at commit time without a choice.** The row is skipped and nothing moves. Pinned in Task 1 (`test_new_conflict_at_commit_is_skipped`).
5. **The wizard's client changes after the check.** Create is refused with `check_stale_client`. Pinned in Task 3 (`test_wizard_client_change_needs_recheck`).

---

### Task 1: Pipeline — client of record, conflicts, choices, fix-up migration

**Files:**
- Modify: `api/src/serversherpa/imports/move_assets.py`
  - `run_import` (~300-543) gains `client_choices: dict[str, str] | None = None` and `client_id: uuid.UUID | None = None`. When `client_id` is None and `initiative_id` is set, load `Initiative.client_id`.
  - Existing-asset branch (~457-467).
  - `Asset(...)` (~442-448) gets `client_id`.
  - `_SimAsset` gets `client_id`.
  - Summary (~524-532).
- Modify: `api/src/serversherpa/imports/worker.py` (~153-164): pass `client_choices=job.options.get("client_choices")`. Wizard checks (`initiative_id` None plus `options.move_setup_id`) pass the draft's `payload["move"]["client_id"]`.
- Modify: `api/src/serversherpa/imports/notices.py` `count_left_out` (~101-108): add `skipped`.
- Create: `api/migrations/versions/0129_asset_client_backfill.py` with `backfill_asset_clients(conn)`, following 0091's pattern. It sets `assets.client_id` from the newest roster row on a client move, for assets whose `client_id` is NULL.
- Create: `api/src/serversherpa/imports/owner_check.py` with `async def unmatched_owner_count(db, client_id, owners: list[str|None]) -> int`. It uses `clientgroups.keys.group_key`, `clientgroups.service._taken_keys` and `ClientGroupDismissal`.
- Test: `api/tests/test_ft_client_of_record.py`, `api/tests/test_migration_0129_asset_client.py`

**Interfaces:**
- Produces `run_import(..., client_choices=None, client_id=None)`. Details and summary are as in Global Constraints.
- A row's conflict = an existing asset (archived or not) with a non-null `client_id` that differs from the move's client.
  - Validate: status `conflict`.
  - Commit + `"continue"`: reassign, audit, then process the row as usual; status `updated`, with `client_moved_from`.
  - Commit + `"skip"` or a missing choice: status `skipped`. Nothing is written for that row, and no roster row is added.
- Produces `summary.owner_unmatched` on validate when the move has a client.

- [ ] **Step 1: Write failing tests**:
  - `test_new_asset_gets_move_client`
  - `test_existing_null_client_asset_gets_move_client`
  - `test_same_client_no_conflict`
  - `test_validate_flags_conflict_with_current_client`: status `conflict`, `current_client.name` equals the other client's name, and `summary.conflicts == 1`.
  - `test_continue_reassigns_and_audits`: the asset gets the new client, one `AuditLog` row has action update with a `client_id` from/to, the roster row is added, and `client_moved_from` is set.
  - `test_skip_leaves_asset_and_adds_no_roster_row`
  - `test_new_conflict_at_commit_is_skipped`
  - `test_duplicate_conflict_serial_one_choice`
  - `test_archived_asset_conflicts_too`
  - `test_move_without_client_unchanged`: no `client_id` is set and there are no conflicts.
  - `test_owner_unmatched_count`: blank Owners are ignored, names and aliases match, dismissed values aren't counted.
  - `test_skipped_counts_as_left_out`
  - Migration tests:
    - `test_backfill_sets_client_from_move`
    - `test_backfill_newest_client_wins`
    - `test_backfill_leaves_existing_clients`
- [ ] **Step 2: Run them, and expect them to FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, and expect PASS.** Also run `tests/test_move_asset_import_commit.py`, `_validate.py`, `test_import_reprocess_pipeline.py`, `test_import_worker.py`, `test_generated_serials.py` and `test_client_groups_*.py`.
- [ ] **Step 5: Commit** with the message `feat(api): From-To import sets the client of record and flags other clients' serials (SS-526, SS-527)`.

### Task 2: Import endpoints — commit with choices and gate

**Files:**
- Modify: `api/src/serversherpa/api/routes/initiatives.py`:
  - Commit (~1397-1424) accepts an optional body `{client_choices: {serial: "continue"|"skip"}}` (schema `ImportCommitIn` in schemas.py).
  - Collect the conflict serials from the validate job's `results.details` where status is `conflict`.
  - Any serial missing a choice → 422 `client_choices_required` with `detail.serials` (sorted).
  - Values other than continue/skip → 422 `invalid_client_choice`.
  - Store the choices, lower-cased, in `job.options`, reassigning the dict, then queue as today.
  - Choices for serials that aren't conflicts are ignored.
- Reprocess (~1446-1482): child jobs inherit options as today, so stored choices carry over; nothing to change, but add a test.
- Test: `api/tests/test_ft_client_commit_api.py`

- [ ] **Step 1: Write failing tests**:
  - `test_commit_requires_every_choice`: 422 lists the missing serials, and the job stays in validate/completed.
  - `test_commit_with_choices_runs_and_moves`: drive the worker with `run_once`.
  - `test_commit_without_conflicts_needs_no_body`: today's behavior.
  - `test_invalid_choice_value_422`
- [ ] **Step 2: Run them, and expect them to FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, and expect PASS.** Also run `tests/test_move_asset_import_api.py` and `tests/test_import_reprocess_api.py`.
- [ ] **Step 5: Commit** with the message `feat(api): import commit takes Continue/Skip choices for flagged serials`.

### Task 3: New-move wizard — client from the draft, choices, stale check

**Files:**
- Modify: `api/src/serversherpa/imports/move_setup.py`:
  - `new_check` stores `options.client_id` from the draft.
  - `asset_problems` (~179-189) reports `check_stale_client` when the draft's client differs from the check's `options.client_id`, and `client_choices_required` when a conflict serial has no choice.
  - `apply_job` (~328-407) passes `client_choices` and the draft client to `run_import`.
- Modify: `api/src/serversherpa/api/routes/move_setup.py`: new `PUT /bulk/move-setup/{draft_id}/assets/choices` with body `{client_choices}`. It validates against the check's conflict serials, using the same codes as Task 2, and stores the choices on the check job's options.
- Test: `api/tests/test_move_setup_client_choices.py`

- [ ] **Step 1: Write failing tests**:
  - `test_wizard_check_flags_conflict_using_draft_client`
  - `test_wizard_create_blocked_until_choices`
  - `test_wizard_create_applies_continue_and_skip`
  - `test_wizard_client_change_needs_recheck`
- [ ] **Step 2: Run them, and expect them to FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, and expect PASS.** Also run `tests/test_move_setup_api.py` and `tests/test_move_setup_worker.py`.
- [ ] **Step 5: Commit** with the message `feat(api): move setup wizard flags other clients' serials and applies choices`.

### Task 4: Portal — conflicts panel, commit choices, report, Owner line

**Files:**
- Modify: `portal/src/lib/api.ts`:
  - widen `ImportRowDetail.status` with `'conflict' | 'skipped'`;
  - add the `current_client` / `client_moved_from` fields;
  - add summary keys;
  - `commitImportJob(jobId, clientChoices?)`;
  - `putMoveSetupChoices(draftId, choices)`.
- Modify: `portal/src/lib/moveAssetImport.ts`: `countDetails` handles the new statuses; `IMPORT_ERRORS` adds `client_choices_required`, `invalid_client_choice` and `check_stale_client`.
- Modify: `portal/src/components/imports/ImportReport.tsx`:
  - `STATUS_CHIP` and `PHASE_LABELS` cover the new statuses;
  - a new "Belongs to another client" card lists the conflict rows, each with Continue/Skip (segmented), plus Continue all / Skip all;
  - the card reports choices through a new `onChoicesChange(choices)` prop and accepts `choices`;
  - the Owner line shows when `summary.owner_unmatched > 0`, linking to `/stakeholders/clients/{client_id}?groups=review`.
- Modify: `portal/src/pages/ImportMoveAssets.tsx`: hold the choices in state. **Import N rows** is disabled with the copy hint until every conflict serial has a choice, and it sends them through `commitImportJob`.
- Modify: `portal/src/components/moveSetup/AssetsStep.tsx`: the same card, saved through `putMoveSetupChoices`. Next is blocked until every conflict has a choice.
- Modify: `portal/src/components/clients/ClientGroupsPanel.tsx`: read `?groups=review` to open the Review tab.
- Modify: `portal/src/lib/importReport.ts`: `RESULT_LABELS` add Conflict and Skipped. The Result/Message cells use the report copy from Global Constraints. The Summary sheet adds Conflicts, Moved and Skipped.
- Test: `portal/src/components/imports/ImportReport.conflicts.test.tsx`, `portal/src/pages/ImportMoveAssets.choices.test.tsx`, `portal/src/components/moveSetup/AssetsStep.choices.test.tsx`, an update to `portal/src/lib/importReport.test.ts`, and a deep-link test for ClientGroupsPanel.

- [ ] **Step 1: Write failing tests**:
  - the conflict card renders the client names;
  - Continue all and Skip all set every choice;
  - Import is disabled until all rows are chosen, then sends the exact map;
  - the wizard Next is gated, and choices are saved;
  - the report rows read "Moved from Initech" and "Skipped — belongs to Initech", and the summary counts are right;
  - the Owner line and link render only when N > 0;
  - `?groups=review` opens Review.
- [ ] **Step 2: Run them, and expect them to FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, and expect PASS.** Also run the existing ImportMoveAssets, ImportReport, AssetsStep, BulkNewMove, importReport, moveAssetImport and ClientGroupsPanel tests, `tsc`, and the src/styles guardrails.
- [ ] **Step 5: Commit** with the message `feat(portal): Continue/Skip for other clients' serials, report labels, Owner line`.

### Task 5: Full suites and live check

The controller runs this task:
- the full API suite (in the background, judged by its log);
- the full portal suite;
- a dev DB upgrade to 0129, checking how many assets the backfill touched;
- a live import on dev with a conflicting serial: check, choose Continue for one and Skip for another, commit, then confirm the asset's client, the audit row, the roster and the report.
