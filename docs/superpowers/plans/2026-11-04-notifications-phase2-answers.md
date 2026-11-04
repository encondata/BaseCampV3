# Notifications Phase 2 answers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the four changes Jimmy approved on 2026-11-04 for the Phase 2 open questions: your own watches are audited (answer 2), a From-To notice reaches whoever committed the import and its uploader (answer 7), the rule editor shows a rule's recipients by name to people who can't list them (answer 9), and `GET /wiki/nodes/{id}` hides never-published pages from view-only readers (answer 10).

**Architecture:** Four independent fixes in the existing code. The API is FastAPI + async SQLAlchemy with Alembic. The portal is React/TS (vitest), and the wiki front end is `wiki/web` (vitest). One new migration, 0118, adds `import_jobs.committed_by`.

**Tech Stack:** Python 3 / FastAPI / SQLAlchemy async / Alembic / pytest on real Postgres; React + TypeScript + vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-notifications-phase2-as-built.md`, section "Answers (2026-11-04)". Answers 1, 3, 4, 5, 6, 8 and 11 change nothing.

## Global Constraints

- American English in all copy, comments and docs.
- The only new user-facing copy is Task 3's two notes. Copy them exactly, and list them in the as-built doc's "Wording added (please check)". Any other text a task shows already exists in the code or the API.
- The system has 25 users at most. Add no caps, batching or logging for large audiences.
- Do only what your task names. Report anything else you notice as a concern; don't change it.
- Never commit `api/src/serversherpa/_dev_reload.py`. If a run changes it, restore it with `git checkout -- api/src/serversherpa/_dev_reload.py`. Never use bare `git stash`.
- Every commit message ends with this trailer line: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- API tests run from `api/`: `SS_TEST_DB=serversherpa_test_notif_answers PYTHONPATH=src .venv/bin/pytest -q -p no:cacheprovider <files>`. Run only your files; the controller runs the full suite.
- Portal checks run from `portal/`: `npx vitest run <files>` and `npx tsc -b`. Wiki checks run from `wiki/`: `npx vitest run <files>`, `npx tsc -p tsconfig.json --noEmit` and `npx tsc -p tsconfig.test.json`.
- Lint changed Python files with `.venv/bin/ruff check <files>` from `api/`. Don't fix issues on lines you didn't touch.

## Review Focus

1. **One person did both:** when the uploader also commits, exactly one notice goes out, not two (Task 2: `test_same_person_gets_one_notice`).
2. **Jobs from before 0118:** a job with no `committed_by` (queued before the deploy, or a move setup) still tells its uploader (Task 2: `test_recipients_before_0118_is_the_uploader`).
3. **Wiki watches:** a wiki watch started or stopped from /me writes only the wiki's own audit row, never a second `watch.*` row (Task 1: `test_own_wiki_watch_writes_only_the_wikis_audit`).
4. **Editors and folders:** someone who can edit a never-published page, and a view-only reader opening a folder, still get the node (Task 4: `test_editor_reads_a_never_published_page_node`, `test_view_only_reader_reads_a_folder_node`).
5. **Gone recipients:** a rule naming a person or group id that no longer exists still loads, and that id is simply missing from `names` (Task 3: `test_rule_names_leave_out_unknown_ids`). The rules list shows names from `names` to a viewer who can't list people (Task 3: `rules list names notify recipients from the rule for a viewer`).

---

### Task 1: Your own watches are audited (answer 2)

**Files:**
- Modify: `api/src/serversherpa/notifications/watches.py` (add `watch_target`)
- Modify: `api/src/serversherpa/api/routes/notifications.py:282-288` (`_watch_target` moves out; its three uses call `watch_target`)
- Modify: `api/src/serversherpa/api/routes/me.py:402-450` (create, update and delete of your own watches)
- Modify: `docs/superpowers/specs/2026-11-02-notifications-phase2-as-built.md` ("Where it differs" bullet about /me and the wiki's audit)
- Test: `api/tests/test_watches_api.py`

**Interfaces:**
- Produces: `watch_target(watch: NotificationWatch) -> dict` in `serversherpa.notifications.watches`, the same body and docstring as today's `_watch_target`: `{"thing": <type>, "thing_id": <str id>}`, or `{"thing": EVERYTHING, "thing_id": None}`.

- [ ] **Step 1: Write the failing tests** in `api/tests/test_watches_api.py`, asserting audit rows the way `test_group_watches_api.py` asserts `watch.add`:
  - `test_own_watch_add_is_audited_on_the_account`: POST `/auth/me/watches` for an initiative with explicit kinds → exactly one audit row with `entity_type == "user_account"`, `entity_id == str(person.id)`, `action == "watch.add"`, `changes == {"thing": "initiative", "thing_id": str(initiative.id), "kinds": [<the kinds>]}`, `actor_id == person.id`.
  - `test_own_everything_watch_add_is_audited`: an Everything watch → `changes["thing"] == EVERYTHING` and `changes["thing_id"] is None`.
  - `test_own_watch_kind_change_is_audited_once`: PATCH to new kinds → one `watch.update` row with `changes["kinds"] == {"from": <old>, "to": <new>}` plus the target. PATCH again with the same kinds → no new row.
  - `test_own_watch_remove_is_audited`: DELETE → one `watch.remove` row whose `changes` is the target.
  - `test_own_wiki_watch_writes_only_the_wikis_audit`: a wiki page watch added and then deleted through `/auth/me/watches` → the wiki's `wiki_watch` rows (`watch`, `unwatch`) as today, and no `user_account` `watch.*` row.
- [ ] **Step 2: Run them and see them fail** (no `watch.*` rows on `user_account`).
- [ ] **Step 3: Implement.** Move `_watch_target` to `notifications/watches.py` as `watch_target`. In `me.py`, for a watch that is not on the wiki (`_on_the_wiki` is false), call `audit(db, actor_id=user.person.id, entity_type="user_account", entity_id=str(user.person.id), action=..., changes=...)` before the commit:
  - create: `"watch.add"`, `{**watch_target(watch), "kinds": list(watch.kinds)}`;
  - update: only when the kinds changed, `"watch.update"`, `{**watch_target(watch), "kinds": {"from": before, "to": list(watch.kinds)}}`;
  - delete: `"watch.remove"`, `watch_target(watch)`, read before the delete.
  `user_account` plus the person's id is how `PUT /auth/me/preferences` audits (`api/routes/auth.py:408`). Update `delete_my_watch`'s docstring ("watches on portal things go unaudited") and the comment above the watch routes to say what is audited now.
- [ ] **Step 4: Run** `tests/test_watches_api.py tests/test_group_watches_api.py tests/test_wiki_watches_api.py` (the last only if it exists) and ruff on the changed files. Expect all to pass.
- [ ] **Step 5: Update the as-built doc.** In "Where it differs from the design", replace the sentence "Watches on portal things stay unaudited, as designed." with "Your own watches on portal things are audited too, since answer 2 (`watch.add`, `watch.update` and `watch.remove` on your account)."
- [ ] **Step 6: Commit** `feat(notifications): audit your own watches on portal things (answer 2)`.

### Task 2: A From-To notice reaches the committer and the uploader (answer 7)

**Files:**
- Create: `api/migrations/versions/0118_import_job_committed_by.py` (revision `"0118"`, down_revision `"0117"`)
- Modify: `api/src/serversherpa/db/models.py:1522` (`ImportJob.committed_by` after `created_by`)
- Modify: `api/src/serversherpa/api/routes/initiatives.py:1285` (From-To commit) and `api/src/serversherpa/api/routes/assets.py:242` (Bulk update assets commit)
- Modify: `api/src/serversherpa/imports/notices.py`
- Modify: `api/src/serversherpa/imports/worker.py:182-199` (`_tell_the_owner`)
- Modify: `docs/superpowers/specs/2026-11-02-notifications-phase2-as-built.md` ("What was built" item 3, and one line under "Deploy")
- Test: `api/tests/test_bulk_action_notices.py`, `api/tests/test_move_asset_import_api.py` (or `test_move_asset_import_commit.py`, whichever holds the commit-route tests), `api/tests/test_asset_bulk_update_api.py`, and a new `api/tests/test_migration_0118_import_job_committed_by.py` patterned on `test_migration_0116_wiki_watches_join.py`

**Interfaces:**
- Produces: `ImportJob.committed_by: Mapped[uuid.UUID | None]`, an FK to `people.id` declared like `created_by`. It is set when a job is queued for commit. It stays null for a job never committed, and for a move setup, whose job starts in phase "commit" and is committed by its creator.
- Produces: `JobDone.committed_by: uuid.UUID | None = None`, and `recipients(done: JobDone) -> list[uuid.UUID]` in `imports/notices.py`: the committer first, then the uploader (`created_by`) when that's someone else, with None left out.

- [ ] **Step 1: Write the failing tests:**
  - In `test_bulk_action_notices.py`:
    - `test_recipients_committer_first_then_uploader`: `recipients(JobDone(..., created_by=A, committed_by=B)) == [B, A]`.
    - `test_same_person_gets_one_notice`: A uploads and commits, so `recipients` is `[A]`, and `notify_job_done` leaves A exactly one `bulk_action_finished` notification.
    - `test_recipients_before_0118_is_the_uploader`: `committed_by=None` → `[A]`.
    - `test_recipients_none_is_silent`: both None → `[]`, and no notification is written.
    - `test_from_to_finished_tells_committer_and_uploader`: A ≠ B, kind `move_assets`, status `completed` → A and B each get one notification of kind `bulk_action_finished`, titled "From-To import finished", with the same body and link.
    - `test_failed_job_tells_committer_and_uploader`: the same with status `failed` → each gets one `bulk_action_failed`.
    - At the worker level, beside the existing tests of `_tell_the_owner` or `run_once`: `test_worker_tells_the_committer`. A job whose `committed_by` differs from `created_by` finishes, and both people are notified.
  - In the From-To commit-route tests: `test_commit_records_who_committed`. B commits A's validated job, so `committed_by == B` and `created_by == A`.
  - In `test_asset_bulk_update_api.py`: `test_bulk_update_commit_records_who_committed`.
  - In the new migration test: upgrade to 0118 adds a nullable `committed_by` column to `import_jobs`, with an FK to `people.id`; downgrade to 0117 removes it.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - The migration and the model column, with a comment on the column saying when it is null.
  - Both commit routes set `job.committed_by = actor.person.id` where they set `job.phase = "commit"`.
  - In `_tell_the_owner`, read `ImportJob.committed_by` with the job's final state and pass it into `JobDone`. Drop the early return on `created_by is None`, but keep the one on `writes_data`: "nobody to tell" is now decided by `recipients`.
  - `notify_job_done` sends the same notice (title, body, link and payload as today) to each of `recipients(done)`, and returns when the list is empty.
  - Update the module docstring and comments that say "owner" / "the person who started it" to say who is told now.
- [ ] **Step 4: Run** the four test files above plus `tests/test_import_jobs_model.py tests/test_move_asset_import_commit.py tests/test_asset_bulk_update_apply.py`, ruff on the changed files, and `PYTHONPATH=src .venv/bin/alembic heads`, which must show the single head 0118. Expect all to pass.
- [ ] **Step 5: Update the as-built doc.**
  - In "What was built" item 3, change "The person who started a background bulk action" to "The person who committed a background bulk action, and the uploader when that's someone else,".
  - Under "Deploy", add one line: "Answer 7's migration 0118 only adds a nullable column, so an old slot keeps working on it."
- [ ] **Step 6: Commit** `feat(imports): bulk action notices reach whoever committed the job and its uploader (answer 7)`.

### Task 3: A rule's recipients by name for people who can't list them (answer 9)

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py:3335` (`StatusRuleOut.names`)
- Modify: `api/src/serversherpa/api/routes/status_rules.py` (every route answering `StatusRuleOut`: list, create, get, PUT, PATCH)
- Modify: `portal/src/lib/api.ts:5001` (`StatusRule.names`)
- Modify: `portal/src/components/statusRules/useNotifyTargets.ts`
- Modify: `portal/src/components/statusRules/RuleEditorModal.tsx:228-252` (`ParamControl`) and where the editor renders it
- Modify: `portal/src/components/statusRules/RulesTab.tsx:124-135` (`actionNames`)
- Modify: `docs/superpowers/specs/2026-11-02-notifications-phase2-as-built.md` ("Wording added (please check)")
- Test: `api/tests/test_status_rules_api.py`, `portal/src/components/statusRules/useNotifyTargets.test.ts`, `portal/src/components/statusRules/RuleEditorModal.test.tsx`, and the test file that renders `RulesTab` (find it with `grep -rl RulesTab portal/src --include=*.test.tsx`)

**Interfaces:**
- Produces: `StatusRuleOut.names: dict[str, str]`, defaulting to empty. It holds the display name of each person (`Person.display_name`) and the name of each notification group (`NotificationGroup.name`) that the rule's `notify` action names in its `people` and `groups` params, keyed by the id as a string. Ids that don't resolve are left out. A rule without a notify action has `{}`. Look the names up in one query per kind for the whole response, not one per rule.
- Produces: `StatusRule.names: Record<string, string>` in `portal/src/lib/api.ts`.
- Produces: `TargetStatus = 'loading' | 'ready' | 'failed' | 'unavailable'`. `'unavailable'` means the viewer may not ask for that list (people need notifications:change, groups notifications:view), so nothing was asked. `'failed'` keeps meaning a load that failed.

- [ ] **Step 1: Write the failing tests:**
  - API, in `test_status_rules_api.py`:
    - `test_rule_names_its_notify_people_and_groups`: a rule whose notify action names person P and group G. `GET /status-rules/{id}` and `GET /status-rules` both carry `names == {str(P.id): P.display_name, str(G.id): G.name}`.
    - `test_rule_names_on_save`: the POST, PUT and PATCH responses carry the same `names`.
    - `test_rule_without_notify_has_no_names`: `names == {}`.
    - `test_rule_names_leave_out_unknown_ids`: a rule naming a random UUID as a person and another as a group still answers 200, and `names` has neither.
    - `test_rule_names_for_a_status_rules_viewer`: a caller with `status_rules:view` and no notifications permissions gets the names.
  - `useNotifyTargets.test.ts`:
    - without `notifications:change`, people come back with status `'unavailable'` and no call is made;
    - without `notifications:view`, groups come back `'unavailable'`;
    - a rejected load is still `'failed'`.
  - `RuleEditorModal.test.tsx`: replace "a viewer without notification permissions asks for no list, and each picker says it has none" with `a viewer without notification permissions sees the rule's recipients by name, read-only`. Edit a rule whose notify action names `p1` and `g1`, with `names: {p1: 'Pat Doe', g1: 'Group A'}`, while `auth.can` allows only `status_rules`. Then:
    - the chips read "Pat Doe" and "Group A";
    - both pickers are disabled;
    - "Picking people needs permission to change notifications." and "Picking groups needs permission to view notifications." are shown;
    - neither "Could not load the recipient list." nor "Could not load the group list." is shown;
    - neither list is fetched;
    - saving sends `people: ['p1']` and `groups: ['g1']` unchanged.
    Keep the two existing "does not load" tests as they are: a failed load still shows its error, and its picker stays usable.
  - The RulesTab test: `rules list names notify recipients from the rule for a viewer`. For a viewer who may not list people or groups, a rule's notify summary shows "Pat Doe" and "Group A", not the ids.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - **API:** fill `names` as described in Interfaces.
  - **Hook:** return `'unavailable'` instead of `'failed'` for a list the viewer may not ask for, and update its doc comment.
  - **`ParamControl`, when its list is `'unavailable'`:**
    - give the ChipPicker options built from the rule's `names` for the selected ids (label falls back to the id);
    - disable it;
    - render below it `<span className="set-note">` with exactly "Picking people needs permission to change notifications." (people) or "Picking groups needs permission to view notifications." (groups).
    - The editor passes `rule?.names ?? {}` down.
  - **`RulesTab`:** a list that is `'unavailable'` takes its names from the rules' `names`, merged across rules.
  - **API type:** add `names` to `StatusRule`. Update any `StatusRule` fixtures that `tsc -b` then flags.
- [ ] **Step 4: Run** the API file and ruff; then `npx vitest run src/components/statusRules` plus the RulesTab test file, and `npx tsc -b`. Expect all to pass.
- [ ] **Step 5: Update the as-built doc.** Add both notes to "Wording added (please check)" as one bullet: "Picking people needs permission to change notifications." and "Picking groups needs permission to view notifications." (answer 9).
- [ ] **Step 6: Commit** `fix(status-rules): show a rule's recipients by name, read-only, to people who can't list them (answer 9)`.

### Task 4: Never-published wiki pages stay hidden from view-only readers (answer 10)

**Files:**
- Modify: `api/src/serversherpa/api/routes/wiki/nodes.py:157-181` (`get_node`)
- Modify: `wiki/web/src/pages/NodePage.tsx`
- Test: `api/tests/test_wiki_nodes_api.py` (or `test_wiki_node_permissions_api.py`, wherever node reads by level are tested), `wiki/web/src/pages/NodePage.test.tsx`

**Interfaces:**
- Consumes: the wiki's own rule, as `pages.page_for` applies it: a caller without edit on a page (`node.kind == "page"`) whose `WikiPage.published_version_id` is null gets `err(404, "not_published", "This page hasn't been published yet.")`. `visible_nodes(ctx, [node])` applies the same rule and may be reused.

- [ ] **Step 1: Write the failing tests:**
  - API:
    - `test_view_only_reader_gets_not_published_for_a_never_published_page`: 404, `code == "not_published"`, and the body doesn't carry the page's title.
    - `test_view_only_reader_reads_a_published_page_node`: 200.
    - `test_editor_reads_a_never_published_page_node`: 200.
    - `test_view_only_reader_reads_a_folder_node`: 200.
  - Wiki: in `NodePage.test.tsx`, `a never-published page says it hasn't been published`. `getNode` rejects with `ApiError` 404, code `not_published` and message "This page hasn't been published yet.", so that text shows and the NotFound page doesn't. Keep or add a test that a plain 404 still shows NotFound.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - **`get_node`:** apply the rule above right after `require_node_level`, before anything about the node is read or returned. Update the routes module docstring if it describes node reads.
  - **`NodePage`:** a 404 whose code is `not_published` gets its own state. It renders the API's message (`errorMessage(err, "This page hasn't been published yet.")`) as `<p className="page-hint">` inside the frame the error branch uses (`<div className="portal-page wiki-page">`).
- [ ] **Step 4: Run** the API test file and ruff; then, from `wiki/`, `npx vitest run web/src/pages/NodePage.test.tsx web/src/pages/PageView.test.tsx` and both tsc commands. Expect all to pass.
- [ ] **Step 5: Commit** `fix(wiki): a never-published page's node is not found for view-only readers, as its content isn't (answer 10)`.
