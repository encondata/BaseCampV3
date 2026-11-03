# Notifications Phase 2, Slice 4 (Status Rules) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A status rule can send a notification: to chosen people, to groups, and optionally to whoever watches the rule's initiative or the scan's site. Off-move sightings can run rules that ask for them.

**Architecture:**

- **Off-move:** `scan.off_move` becomes a condition field. The scan worker runs off-move sightings through only the rules that ask for them, with the station's move as the rule's initiative.
- **The Notify action:**
  - It checks a per rule-and-thing hourly repeat guard (`status_rule_notified`, an atomic upsert).
  - It collects its matches per transaction (`AsyncSession.info` plus a `before_commit` hook).
  - It announces one `status_rule_matched` event per rule and initiative.
- **The sweep:** it groups rule events per person per rule, checks access per matched thing (assets, containers and workers join `notifications/access.py`), and logs rule names.
- **Portal:**
  - The rule editor's native selects become the house ComboBox. People and group pickers and a watchers Switch are added.
  - The rules list summary reads "Notify …".
  - Executions can be opened for one rule.
  - Status rules joins the grid.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic, PostgreSQL 16, pytest; React 18 + TypeScript, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-02-notifications-phase2-design.md` (Build order, slice 4; sections 4, 5 "Status rule matched", 6 and 8).

## Global Constraints

- **American English.** Grep the changed files for `-ise|-isation|colour|enrol\b|enrolment|behaviour|centre|licence`.
- **Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/notif-phase2`, branch `notif-phase2`.
- **API tests:** `cd api && SS_TEST_DB=serversherpa_test_notif2 PYTHONPATH=src .venv/bin/pytest <files> -q -p no:cacheprovider`. Don't run the whole API suite.
- **Portal checks:** `npx vitest run <files>`, `npx tsc -p .`, `npx vitest run src/styles` and `npm run build`. Run the whole portal suite once before a portal commit.
- **Run every test command in the FOREGROUND** (600000 ms timeout). Never background a suite and end your turn waiting.
- **Git hygiene:**
  - Plain single git commands as `git -C <worktree> …`.
  - Never use bare `git stash`, and never commit `api/src/serversherpa/_dev_reload.py`.
  - Trailer exactly `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Session discipline:** actions, `announce()` and `notify()` never commit. The rule engine's callers commit.
- **Migration** `"0115"` (down_revision `"0114"`). No other migration in this slice.
- **No new policy numbers:** the repeat window is the station alarm's one hour, the rule cache stays 60 s, and the cap stays `MAX_RECIPIENTS`.
- **Copy** is exactly as quoted in the spec, in this plan and in "Calls". The approved mockup supplies:
  - "People", "Groups";
  - "Also people watching the initiative or site";
  - "Pick people, groups or watchers.";
  - "Search people…", "Search groups…";
  - "Notify {parts}".
- **No `state` key** in a new notification payload.
- **Portal controls:** `ComboBox`, `ChipPicker`, `Switch` and `RowActionsMenu`. No raw `<select>` left in the rule editor (house rule for touched UI; the mockup says "The editor's dropdowns become the portal's searchable picker").

## Calls this plan makes (beyond the spec)

1. **Batching keeps one notice per rule.** A rule batch's subject is the rule's initiative. A match with no initiative (a container with no move, or a person) is its own event, and its subject is the matched thing.
2. **Off-move rules ask with `scan.off_move` "equals" `true`.** The editor shows bool values as "Yes" / "No" (stored `"true"` / `"false"`), as the spec and the mockup write it. That relabels `asset.has_rails` the same way.
3. **The repeat guard is checked and set atomically:**
   ```sql
   INSERT … ON CONFLICT (rule_id, subject_type, subject_id)
   DO UPDATE SET notified_at = :now WHERE status_rule_notified.notified_at <= :now - interval '1 hour'
   RETURNING 1
   ```
   No row back means "within the hour". `:now` comes from Python (Postgres `now()` is frozen per transaction).
4. **Watchers reach the rule's initiative and its parents, and the scan's site.** Manual status edits have no scan site, so they reach the initiative only.
5. **Links:**
   - an asset → `/assets?open={id}`;
   - a container → `/logistics/containers?open={id}`;
   - a worker → `/people/workers/{id}`;
   - a grouped or batch notice → `/admin/status-rules?tab=executions&rule={rule id}`.
   - The Status rules page learns those two query keys.
6. **Error copy:**
   - `notify_no_recipients` → "Pick people, groups or watchers." (mockup);
   - `unknown_person` → "A chosen person no longer exists.";
   - `unknown_group` → "A chosen group no longer exists.";
   - the executions reason `notified_within_hour` reads "Notified within the hour".
7. **Batch text:**
   - One match: title "{rule name}: {matched thing}", line "{initiative} · {scan site}" (missing parts left out).
   - Several matches, in one event or grouped in a sweep: title "{rule name} ({count})", one line per initiative "{initiative} · {count}", and "{count}" alone for matches with no initiative.
8. **Named people and groups:**
   - People named by the rule get the route `rule:<id>`.
   - Members of named groups get both `group:<id>` and `rule:<id>`.
   - The actor (the scan's operator or the editor) is never notified, unless they're named as a person.

## Review Focus

- **A 15,000-row bulk update.** Every row matches one rule on one initiative. The result is one event with the count and the ids, and one notification per recipient, "{rule} (15000)". The `item` JSON is written once at commit, not on every flush (Task 2: `test_bulk_update_is_one_event`, using 500 rows).
- **A re-read storm.** A station re-reads the same tag every few seconds for an hour. The rule notifies once, then logs `notified_within_hour` until the hour passes. Two scan workers at once still notify once (Task 2: `test_repeat_guard`, `test_concurrent_workers_notify_once`).
- **Rollback.** A later action in the same rule fails, so the scan's transaction rolls back. No event and no `status_rule_notified` row survive. A reused session (bulk update after a rule failure) starts with an empty batch (Task 2: `test_rollback_leaves_nothing`).
- **Off-move rules only.** An off-move sighting runs exactly the rules with the condition. Every other rule still writes no execution for it. The rule's initiative is the station's move (Task 1: `test_off_move_sightings_run_only_rules_that_ask`).
- **Partial access.** A client user watching the initiative hears only the matched assets their client owns, counted (Task 3: `test_access_per_matched_thing`).

---

### Task 1: Off-move sightings can run rules (API)

**Files:**
- Modify: `api/src/serversherpa/status_rules/catalog.py` (the condition field), `api/src/serversherpa/status_rules/engine.py`, `api/src/serversherpa/status_rules/context.py`, `api/src/serversherpa/scans/worker.py`
- Test: `api/tests/test_status_rules_off_move.py` (new). Keep `tests/test_scan_worker.py` (its off-move test at :151-179) and `tests/test_status_rules_engine.py` green.

**Interfaces:**
- `ConditionField("scan.off_move", "Off-move sighting", "bool")`, appended after the scan fields.
- **`apply_rules`:** `apply_rules(db, scan, *, initiative_asset=None, off_move_initiative_id: uuid.UUID | None = None) -> int`.
  - When `scan.off_move` is true, only rules with a condition `("scan.off_move", "equals", v)` where `str(v).lower() == "true"` are evaluated.
  - The context's initiative is `off_move_initiative_id` (the station's move), and the in-progress guess isn't used.
  - Scans that aren't off-move behave exactly as today.
- **`Context`** gains `rule_id: uuid.UUID | None` and `rule_name: str | None`, set by the engine before each rule's actions run. Task 2's action reads them.
- **`scans/worker.process_raw_scan`** always calls `apply_rules` and passes `off_move_initiative_id=raw.initiative_id`. The skip at :87-88 goes.

- [ ] **Step 1: Write the failing tests:**
  - `test_off_move_sightings_run_only_rules_that_ask` (Review Focus):
    - Setup: three enabled rules on the station's checkpoint — one with "Off-move sighting equals true", one without the condition, and one with "equals false".
    - Result: an off-move sighting writes an execution for the first only, with conditions met, and `ctx.initiative` is the station's move.
    - The same sighting not off-move: the first rule is unmet, and the other two behave as today.
  - `test_existing_rules_still_skip_off_move`: no rule has the condition, so there are no executions (the old pin).
  - `test_context_carries_the_rule`: an action spy sees `rule_id` and `rule_name`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step-1 file plus `tests/test_scan_worker.py tests/test_status_rules_engine.py tests/test_status_rules_catalog.py tests/test_status_rules_api.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(status-rules): off-move sightings run the rules that ask for them`.

### Task 2: The Notify action (API)

**Files:**
- Create: `api/migrations/versions/0115_status_rule_notified.py`, `api/src/serversherpa/status_rules/notify.py`
- Modify: `api/src/serversherpa/db/models.py` (`StatusRuleNotified`), `status_rules/catalog.py` (param types, the action, `validate_action`), `api/routes/status_rules.py` (`_validate`: unknown people and groups)
- Modify: `notifications/kinds.py`, `company.py`, `config_store.py`
- Test: `api/tests/test_status_rule_notify.py` (new), `api/tests/test_migration_0115_status_rule_notified.py` (new); update the kind, category and catalog pins

**Interfaces:**
- **Table** `status_rule_notified`:
  - `rule_id` → status_rules, CASCADE;
  - `subject_type` text, `subject_id` uuid, `notified_at` timestamptz NOT NULL;
  - the PK is the first three.
  - It is purged with its rule.
- **Kinds:**
  - `CATEGORIES` gains `"status_rules": "Status rules"` after devices and before bulk_actions.
  - `KINDS` gains `"status_rule_matched": KindInfo("status_rules", "Status rule matched", reaches=("initiative", "site"))` (not everywhere), after `device_offline`.
  - `CONFIGURABLE_CATEGORIES` and the defaults gain it (on/on). `LIST_PAGES["status_rule_matched"] = None`, because the link comes from the rule (call 5).
- **Catalog:**
  - `ParamField` types gain `"people"` and `"groups"` (lists of id strings).
  - Append `ActionDef("notify", "Send a notification", (ParamField("people", "people"), ParamField("groups", "groups"), ParamField("watchers", "bool")), notify.apply)`.
  - `validate_action` takes lists of UUID strings for people and groups, and `bad_param` otherwise. All three empty or false → `notify_no_recipients`.
  - `_validate` in the route: an id that's no person → 422 `bad_action` with `reason` `unknown_person`; no notification group → `unknown_group`.
- **In `status_rules/notify.py`:**
  - `async def apply(db: AsyncSession, ctx: Context, params: dict) -> ActionOutcome`.
  - **Subject:** the matched asset, container or person (`ctx`).
  - **The initiative:** `ctx.initiative`, else a matched container's own `initiative_id`.
  - **Repeat guard:** per call 3, for `(ctx.rule_id, subject)`; a repeat → `ActionOutcome(False, "notified_within_hour")`.
  - **Batching:**
    - It adds the match to `db.info["rule_notices"]`, keyed `(rule_id, initiative_id or the subject)` and holding the ids, the matched kind, the count and the first match's details.
    - A session `before_commit` listener, registered once at import on the sync `Session` class, turns each batch into one `announce(db, "status_rule_matched", subject=…, item=…, reaches=…, actor_id=…, person_ids=…, group_ids=…, watchers=…, rule_id=…)`.
    - The item carries `count`, `matched_type` and `matched_ids` (strings), plus call 7's single-match title and line and call 5's link.
    - `after_rollback` / `after_soft_rollback` clear the batches.
  - **Actor:** `scan.operator_id`.
  - **Reaches** (only when `watchers`): the initiative, its ancestors and the scan's site.
  - **Named:** the param ids as UUIDs. Group ids that no longer exist are passed as given; the sweep drops them.
  - The action never commits, and the rule's params dict (shared with the cache) is never mutated.

- [ ] **Step 1: Write the failing tests:**
  - `test_validation`:
    - none chosen → 422 `bad_action` `notify_no_recipients`;
    - an unknown person or group id → `unknown_person` or `unknown_group`;
    - a valid save round-trips.
  - `test_one_match_is_one_event`: subject, item, reaches (with watchers on and off), actor, named, and `rule_id`.
  - `test_bulk_update_is_one_event` (Review Focus): 500 rows through `apply_job` → one event with `count` 500. The `item` JSON is written once. Spy on `announce`, or count UPDATEs on `notification_events`.
  - `test_two_initiatives_two_events`.
  - `test_repeat_guard` (Review Focus):
    - a second match within the hour → not applied, `notified_within_hour`, no event;
    - after more than an hour → applied.
  - `test_concurrent_workers_notify_once` (Review Focus): two transactions racing the same rule and thing → one event.
  - `test_rollback_leaves_nothing` (Review Focus):
    - a later failing action → no event and no guard row;
    - the reused session's next batch is clean.
  - `test_migration_0115` (throwaway DB): the table, PK and cascade; the downgrade.
  - Update the kind, category and catalog pins. The registration scan finds `status_rule_matched`.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step-1 files plus `tests/test_status_rules_engine.py tests/test_status_rules_catalog.py tests/test_status_rules_api.py tests/test_asset_bulk_update_apply.py tests/test_scans_manual.py tests/test_notification_kinds.py tests/test_notification_settings_api.py tests/test_notification_log_api.py tests/test_notification_events.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(status-rules): a Send a notification action, once an hour per thing`.

### Task 3: The sweep sends rule notices (API)

**Files:**
- Modify: `api/src/serversherpa/notifications/access.py` (asset, container and person things), `api/src/serversherpa/notifications/event_sweep.py` (per-rule grouping, per-thing access, rule names), `notifications/event_sweep.watch_recheck` (subjects)
- Test: `api/tests/test_rule_notice_sweep.py` (new); `tests/test_notification_access.py` (equivalence cases)

**Interfaces:**
- **`access._PAGES`** gains three things, each pinned by a page-equivalence test like slice 1's:
  - `"asset"`: assets:view, with the client scope probe on `Asset`, as `GET /assets/{id}` does;
  - `"container"`: containers:view, global only;
  - `"person"`: workers:view, plus a worker role and the `scope_conditions("workers", …)` probe on `WorkerProfile`, as `GET /workers/{id}` does.
- **The sweep, for `status_rule_matched`:**
  - **Grouping:** the key is `(person, rule_id)`, not `(person, kind)`.
  - **Access:** each candidate is checked per matched thing (`matched_ids`, batched by `viewers` per id). They hear the things they can see, counted, and are dropped (`no_access`) when they can see none.
  - **Compose:** per call 7, with call 5's link.
  - **Names:** `names["rule:<id>"]` (the rule's name) joins the log detail beside group names.
  - **Payload:** `subjects` lists the matched things the person can see, so the send-time re-check judges those.

- [ ] **Step 1: Write the failing tests:**
  - `test_rule_notice_reaches_named_people_groups_and_watchers`, with `via` routes and `names` per call 8.
  - `test_access_per_matched_thing` (Review Focus): a batch of three assets where the client user owns two → their notification reads "{rule} (2)".
  - `test_grouped_per_rule`: two rules matching in one sweep → two notifications; one rule across two initiatives → one notification with two lines.
  - `test_the_actor_is_not_notified`.
  - The three access equivalence tests (the asset, container and worker pages).
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the step-1 files plus `tests/test_notification_event_sweep.py tests/test_watch_recheck.py tests/test_notification_access.py tests/test_status_rule_notify.py`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(notifications): status rule notices, grouped per rule and checked per thing`.

### Task 4: Portal: the rule editor

**Files:**
- Modify: `portal/src/components/statusRules/RuleEditorModal.tsx` (and its test), `portal/src/lib/statusRules.ts` (and its test), `portal/src/lib/api.ts` (the `RuleSchemaParam` types)

**Interfaces:**
- **Controls:**
  - Every native `<select>` in the editor becomes a `ComboBox`: trigger status, match type, condition field, operator, value, action type, and status and choice params.
  - Bool values read "Yes" / "No" (call 2).
  - A new condition on a bool field starts at `"true"`.
- **Params:**
  - `people` → `ChipPicker` ("People", placeholder "Search people…", options from `listNotificationRecipients()`).
  - `groups` → `ChipPicker` ("Groups", "Search groups…", from `listNotificationGroups()`).
  - `watchers` → `Switch` ("Also people watching the initiative or site").
  - The defaults are `[]`, `[]` and `false`.
- **Errors:** a 422 `bad_action` shows call 6's copy for its `reason`.
- **Summary:** `summarizeAction` for `notify` reads "Notify {parts}" — the people's and groups' names, plus "watchers", joined as "A, B and watchers". Names are looked up from the loaded options, with the id as the fallback.

- [ ] **Step 1: Write the failing tests:**
  - No `<select>` remains in the editor.
  - Picking people, groups and watchers saves `{people: [...], groups: [...], watchers: true}`.
  - With none picked, the save error is "Pick people, groups or watchers."
  - "Off-move sighting" appears with Yes/No.
  - The summary reads "Notify Person A, Group A and watchers".
  - Update the existing tests that drove the native selects.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run src/components/statusRules src/pages/StatusRules.test.tsx src/lib src/styles`, then `npx tsc -p .`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): the rule editor sends notifications and uses the house pickers`.

### Task 5: Portal: executions per rule, and the category

**Files:**
- Modify: `portal/src/pages/StatusRules.tsx`, `portal/src/components/statusRules/ExecutionsTab.tsx` (and tests), `portal/src/lib/notificationKinds.ts`, `portal/src/lib/notificationSwitches.ts` (Status rules, with the description "Notifications from status rules"), and the `NotificationCategory` union
- Test: the category pins (as with Devices and Bulk actions)

**Interfaces:**
- **`/admin/status-rules?tab=executions&rule=<id>`:** this opens the Executions tab filtered to that rule, using the tab's existing filter mechanism. The tab and rule switch with the URL.
- **Reasons:** the executions reason `notified_within_hour` reads "Notified within the hour" wherever reasons are shown.
- **Categories:** Status rules goes between Devices and Bulk actions.

- [ ] **Step 1: Write the failing tests:** the deep link opens the filtered tab; the reason label; the category pins.
- [ ] **Step 2: Run them to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole portal suite, `npx tsc -p .` and `npm run build`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(portal): status rule executions per rule; Status rules joins the grid`.
