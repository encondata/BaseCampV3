# Project Plans — Plan C: Reminders, Views, Timeline, Templates, Import/Export, PDF export

> **Amended 2026-10-28.** Task 10 is now the server-rendered PDF export, not browser printing, as Jimmy asked. Plan B's carried items are folded into Tasks 1, 2, 3, 4, 6, 7 and 8.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Everything around the core editor: due-date reminders and assignment notices, the System settings › Project plans screen, the Calendar and Board views and the Timeline strip, milestones on the all-initiatives Timeline page, templates, MS Project XML and Excel import/export, and a PDF export with the task table and the Gantt chart on separate pages.

**Architecture:** API additions live in the `serversherpa.plans` package (`reminders.py`, `templates.py`, `mspdi.py`, `excel.py`, `timeline.py`) and `api/routes/plans.py`; the reminder sweep runs inside the existing notification-worker loop. Portal additions live in `components/plans/` and `lib/plans/`, plus small edits to `pages/Settings.tsx`, `pages/InitiativeTimeline.tsx` and the notification-category mirror.

**Tech Stack:** as Plans A and B; openpyxl (installed) for Excel; stdlib `xml.etree.ElementTree` for MSPDI, using `defusedxml.ElementTree` when importable (the pattern in `reports/site_move_survey/standards.py:17-20`) — add `defusedxml>=0.7` to `api/pyproject.toml` and install it into the shared venv (`api/.venv/bin/pip install defusedxml`) because the importer parses user uploads.

**Spec:** `docs/superpowers/specs/2026-10-27-project-plans-design.md`. **Depends on:** Plans A and B on this branch.

## Global Constraints

Everything in Plans A and B's Global Constraints, plus:
- Reminder delivery follows the spec's *Delivery* bullet exactly: plan kinds are registered `email=False`; the direct email goes through `mail.outbox.enqueue` with the plan templates; the person's own category choice is honored for account holders; `email_assignees` turns the direct email off.
- Every import is dry-run → per-row summary → apply (house rule for bulk actions); never creates people or partners.
- No starter templates ship (spec call 9).

## Review Focus

1. **Reminder burst after downtime** — a worker that was down for three days must send one reminder per task/person (the latest stage), not three. (Task 2)
2. **Moved deadline** — moving a task's deadline later must re-arm its reminders; moving it earlier past a stage must not send the skipped stage. (Task 2)
3. **Hostile or odd XML** — an MSPDI file with an external entity, a 50 MB file, a task with OutlineLevel jumping from 1 to 3, or a predecessor UID that doesn't exist must produce a clear error or a per-row problem, never a crash or a half-applied import. (Task 7)
4. **Round trip** — export to MS Project XML and re-import into an empty plan reproduces names, outline, durations, link types and lags, constraints, deadlines and milestones exactly. (Task 7)
5. **Category added to /me** — existing users' stored preferences without a `plans` key must read as `email`, and the /me table must show the new row. (Task 1)

---

### Task 1: Notification category, kinds, mail templates, portal mirror

**Files:**
- Modify: `api/src/serversherpa/notifications/kinds.py`; `api/tests/test_notification_kinds.py`; `api/tests/test_preferences.py`
- Create: `api/src/serversherpa/mail/templates/plan_reminder.{subject.txt,html,txt}`, `plan_assigned.{…}`, `plan_overdue_digest.{…}`
- Modify: `portal/src/lib/notificationKinds.ts`, `portal/src/lib/api.ts` (`NotificationCategory` union), `portal/src/lib/settings.ts` (defaults), every portal test fixture that spells out a full `categories` object (grep `learning: 'email'` and `learning: "email"`)
- Test: `api/tests/test_plans_mail.py`

**Interfaces:**
- Produces: `CATEGORIES` gains `"plans": "Project plans"` between `learning` and `security`; `KINDS` gains `plan_task_assigned` ("Assigned to a plan task"), `plan_task_due` ("Plan task due"), `plan_task_overdue` ("Plan task overdue"), `plan_overdue_digest` ("Overdue plan tasks") — all `KindInfo("plans", …, email=False)`. Templates (Jinja, StrictUndefined, extend `_base.html` like `learning_invite.html`) and their context keys:
  - `plan_reminder`: `person_name, task_name, initiative_name, due_label` ("Thursday, November 5" / "today" / "since Tuesday, November 3"), `stage` (`upcoming|due|overdue`), `link`. Subjects: `Due {{ due_label }}: {{ task_name }} — {{ initiative_name }}`, `Due today: …`, `Overdue: …`.
  - `plan_assigned`: `person_name, initiative_name, tasks: [{name, start_label, finish_label, deadline_label|None}], link, assigned_by`. Subject `You were assigned {{ tasks|length }} task(s) in {{ initiative_name }}` (singular/plural handled in the template).
  - `plan_overdue_digest`: `person_name, initiative_name, tasks: [{name, due_label, assignees}], link`. Subject `{{ tasks|length }} overdue task(s) in {{ initiative_name }}`.
- [ ] **Step 0 (carried from Plan B; own commit `fix(plans): 0110 indexes`):** amend `0110_project_plans.py` in place, since it is unreleased:
  - Add an index on `plan_assignments(partner_id)`.
  - Add indexes for every `ON DELETE SET NULL` person FK on `plan_tasks` (`completed_by`, `created_by`, `updated_by`, …) that lacks one.
  - Fix the `FULL ={` spacing in `api/tests/test_plans_migration.py:39`.
  - The migration round-trip test lists the new indexes.
  - Re-migrate the test DBs with `remigrate_0110.py`. The clone dev DB gets the same `CREATE INDEX` statements by hand.
- [ ] **Step 1: Failing tests** — update `test_categories_order_and_labels` and `test_kind_table_matches_the_spec` expectations; `test_preferences.py`: a stored preference without `plans` reads `plans == "email"` (Review Focus 5); `test_plans_mail.py`: each template renders through `mail.render` with a complete context, and rendering with a missing key raises. Portal: `lib/notificationKinds` lists "Project plans" before "Account security"; the /me `CategoryDelivery` test shows the row.
- [ ] **Step 2: Run** API `… pytest tests/test_notification_kinds.py tests/test_preferences.py tests/test_plans_mail.py -q` and portal `npx vitest run src/lib src/pages/me` → FAIL.
- [ ] **Step 3: Implement**, including every fixture update.
- [ ] **Step 4: Run** → PASS; then the full portal suite (fixtures are scattered).
- [ ] **Step 5: Commit** `feat(plans): project plans notification category and mail templates`.

### Task 2: Reminder sweep and assignment notices

**Files:**
- Create: `api/src/serversherpa/plans/reminders.py`, `api/src/serversherpa/plans/notices.py`
- Modify: `api/src/serversherpa/notifications/worker.py` (a `run_plans(maker, state)` wrapper and a `PLANS_INTERVAL_SECONDS = 60` cadence, copying `run_learning` at lines 72-87 and its loop wiring at 100/115/144-146), `api/src/serversherpa/api/routes/plans.py` (ops route calls `notices.assignment_notices` before commit), `api/tests/test_notification_worker.py`
- Test: `api/tests/test_plans_reminders.py`, `api/tests/test_plans_notices.py`

**Interfaces:**
- Consumes: `OpResult.newly_assigned` (Plan A Task 10), `effective`/`PlanSettings.reminders` (Plan A Task 1), `plan_now`, `notify`, `enqueue`, `learning.emails.address_for`, `notifications.email.load_contact` + the personal-choice helper `notify()` itself uses, `learning.stats.INACTIVE_STATUSES`.
- Produces:
  - `reminders.py`: `def _now() -> datetime` (UTC, monkeypatch seam); `def stages_for(due_at: datetime, r: Reminders, now_local: datetime) -> list[tuple[str, datetime]]` (pure: `d<N>` at `(due_day − N) send_time` for each offset; `due` at `due_day send_time` when `on_due_day`; `overdue:<YYYY-MM-DD>` at `(due_day + k) send_time` for each k ≥ 1 up to today when `overdue == "daily"`, only k = 1 as stage `overdue` when `"once"`, none when `"off"`); `def latest_due_stage(stages, now_local) -> tuple[str, datetime] | None` (the latest whose time ≤ now); `async def run_plan_reminders_once(maker) -> dict` → `{"reminders": int, "digests": int, "errors": int}`.
  - Sweep rules: plans whose initiative is not archived and not in `INACTIVE_STATUSES`; effective `reminders.enabled`; incomplete tasks with a due moment (deadline, or finish when `use_finish_without_deadline`); for each person assignee, the latest due stage only (Review Focus 1), sent once per `(task, person, stage, due_at)` through `plan_reminder_log` (`INSERT … ON CONFLICT DO NOTHING RETURNING`, so two workers can't double-send); the message's `due_label` is computed from the real due day, never from the stage name. Delivery: `notify(db, person, "plan_task_due"|"plan_task_overdue", title, body, link)`; when it returns `None` (category off) send nothing else; else when the person's choice is `email` (or they have no account), `email_assignees` is on and `address_for` returns an address → `enqueue("plan_reminder", …, person_id=…, kind=…)`. Overdue owner copies (`overdue_to_owner`): one `plan_overdue_digest` per plan per local day listing every task that newly entered an overdue stage that day, logged per task as stage `owner:<YYYY-MM-DD>` for the owner. One plan per transaction; errors counted and logged once per outage (copy `learning/scheduler.py`'s `_each`).
  - Carried from Plan B:
    - Reminders go only to assignees who are still among the plan's current `resources`. An undo can restore an assignee who has since left the initiative; that person gets nothing.
    - A plan with no owner set treats its creator as the owner for `overdue_to_owner`.
    - Tests: `test_departed_assignee_skipped`, `test_creator_is_default_owner`.
  - `notices.py`: `async def assignment_notices(db, state: PlanState, newly_assigned: dict[UUID, list[UUID]], actor, settings: PlanSettings) -> int` — when `notify_on_assign`, one `plan_task_assigned` inbox row + one `plan_assigned` email per person (never the actor), with the same delivery rules.
  - Link format everywhere: `/initiatives/<initiative_id>?tab=plan&task=<task_id>` (digest: no `task`).
- [ ] **Step 1: Failing tests** (`_now` monkeypatched; plan timezone America/Chicago; send time 08:00; offsets [3,1]):
  - `stages_for` unit tests: deadline Thu 11-05 17:00 → `d3` Mon 11-02 08:00, `d1` Wed 08:00, `due` Thu 08:00; daily overdue on Sat 11-07 10:00 yields `overdue:2026-11-06` and `overdue:2026-11-07`.
  - `test_sends_latest_stage_only` — now = Wed 11-04 09:00 local → one `plan_task_due` with due_label "Thursday, November 5", log stage `d1`; a second run sends nothing.
  - `test_downtime_no_burst` — first run ever at Sat 11-07 09:00 → exactly one overdue reminder (Review Focus 1).
  - `test_moved_deadline_rearms` — after `d1` was sent, move the deadline to Thu 11-12 → at Mon 11-09 09:00 a `d3` goes out for the new due_at; moving it earlier so `d1` and `due` are both past sends only the latest (Review Focus 2).
  - `test_completed_and_inactive_skipped` — 100% task, archived initiative, `completed` initiative, `reminders.enabled = False` → nothing.
  - `test_category_off` — account holder with `plans: "off"` → no inbox row, no email; `inbox` → inbox only; worker without account but with an email → email only (no crash on the inbox row).
  - `test_email_assignees_off` → inbox rows only.
  - `test_owner_digest` — two overdue tasks → one digest to the owner listing both; next day with `daily` → one new digest.
  - `test_assignment_notice` — ops `set_assignees` with two people (one is the actor) → one inbox row + one email for the other person; `notify_on_assign = False` → none.
  - `test_notification_worker.py`: the loop calls `run_plan_reminders_once` on its cadence (monkeypatch like the learning case).
- [ ] **Step 2: Run** `… pytest tests/test_plans_reminders.py tests/test_plans_notices.py tests/test_notification_worker.py -q` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plans): due-date reminders, overdue digests and assignment notices`.

### Task 3: System settings › Project plans (portal)

**Files:**
- Create: `portal/src/pages/settings/ProjectPlanSettings.tsx`, `portal/src/lib/plans/systemSettings.ts`
- Modify: `portal/src/pages/Settings.tsx` (`TABS` gains `{ key: 'project-plans', label: 'Project plans', to: '/settings/project-plans' }` before About; `settingsTabFor`), `portal/src/App.tsx` (route `<Route path="/settings/project-plans" element={<ProtectedRoute resource="settings"><Settings/></ProtectedRoute>}/>`), `portal/src/lib/plans/api.ts` (`getProjectPlanSettings`, `putProjectPlanSettings`)
- Test: `portal/src/pages/settings/ProjectPlanSettings.test.tsx`, `portal/src/lib/plans/systemSettings.test.ts`

**Interfaces:**
- Produces: a draft-and-Save form in the `pages/learning/LearningSettings.tsx` pattern (`toDraft`, `evaluate`, `isDirty`, `isValid`, `patch` of changed keys only, Save + Discard, `toast('Project plan settings saved')`), sections as `.set-section` blocks: Scheduling (honor constraints Switch, critical slack days (fractional values allowed, e.g. 0.5), default task mode `.segmented`, default duration text validated with `parseDuration`, show times Switch), Default calendar (`CalendarEditor` from Plan B Task 10), Completion rules (two `.segmented` groups with the spec's option labels), Reminders (enabled Switch, offsets chip input of 1–5 day numbers, on the due day Switch, overdue `.segmented` Daily / Once / Off, send time `<input type="time">`, remind on finish when no deadline Switch, assignment notices Switch, overdue digest to owner Switch, email assignees Switch). Read-only for users without `settings:change`. A one-line `page-hint` under the Default calendar heading: "New plans start with this calendar; existing plans keep their own."
- [ ] **Step 1: Failing tests** — renders defaults; changing offsets to "7, 2" and Save sends `{reminders: {..., offsets_days: [7, 2]}}` (the whole `reminders` object, since the API replaces nested objects); an invalid duration "abc" disables Save with an inline error; read-only user sees no Save.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Live check** + screenshot.
- [ ] **Step 5: Commit** `feat(plans-portal): system settings for project plans`.

### Task 4: Calendar view, Board view, Timeline strip

**Files:**
- Create: `portal/src/components/plans/PlanCalendar.tsx`, `PlanBoard.tsx`, `PlanTimelineStrip.tsx`, `portal/src/lib/plans/board.ts`
- Modify: `PlanTab.tsx` (view switcher `.segmented` Gantt / Calendar / Board bound to `?view=`; Display › Timeline strip toggle persisted in localStorage `plans.strip.<planId>`), `PlanToolbar.tsx`, `styles/plans.css`
- Test: `PlanCalendar.test.tsx`, `PlanBoard.test.tsx`, `PlanTimelineStrip.test.tsx`, `portal/src/lib/plans/board.test.ts`

**Interfaces:**
- Produces:
  - `PlanCalendar` — month grid from `monthGrid()` + `calendarWeeks()` (`lib/timeline.ts`), adapting each leaf task to a `TimelineItem` with `scheduled_start/end` = its floating start/finish day strings; milestones render as diamond chips on their day; prev/next/today navigation; clicking a task selects it and opens Task Information on double-click. Filters (Plan B Task 11) apply.
  - `board.ts` — `columnOf(task): 'not_started'|'in_progress'|'complete'`, `percentForColumn(col): 0|50|100`, `boardCards(rows, tasksById) -> Record<col, PlanTask[]>` (leaves only, outline order; each card carries its ancestor path label "Prep › Crating").
  - `PlanBoard` — three columns with counts; cards show name, path label, start → finish, assignees, Late badge (`chip` `c-red`), deadline; drag a card to another column → `set_percent` via `useCompletion` (Plan B Task 10) so completion checks apply; keyboard: a card's `RowActionsMenu` offers Move to Not started / In progress / Complete. Read-only or `!change` → no dragging.
  - Carried from Plan B Task 10b: the Gantt layout control (Beside / Below / Hidden) applies only to the Gantt view. Calendar and Board take the full width and disable it with the note "Switch to the Gantt view to use this".
  - `PlanTimelineStrip` — a single band above the Gantt: project span bar with start/finish labels, today marker, and every task with `show_on_timeline` (milestones as diamonds, tasks as labeled bars stacked into up to three lanes); click selects the task in the sheet.
- [ ] **Step 1: Failing tests** — calendar: a 2-day task spanning a week boundary renders two segments; a milestone renders a diamond chip; board: `boardCards` puts a 40% task in In progress; dropping a card in Complete calls the completion runner with `set_percent 100`; strip: only `show_on_timeline` tasks appear; three overlapping bars use three lanes.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Live check** all three; screenshots.
- [ ] **Step 5: Commit** `feat(plans-portal): calendar and board views, timeline strip`.

### Task 5: Milestones on the all-initiatives Timeline page

**Files:**
- Create: `api/src/serversherpa/plans/timeline.py`
- Modify: `api/src/serversherpa/api/routes/plans.py` (`GET /plans/timeline`), `portal/src/lib/plans/api.ts` (`getTimelineMilestones(from, to)`), `portal/src/pages/InitiativeTimeline.tsx`, `portal/src/components/initiatives/InitiativeHoverCard.tsx`, `portal/src/styles/initiative-timeline.css`
- Test: `api/tests/test_plans_timeline.py`, `portal/src/pages/InitiativeTimeline.milestones.test.tsx`

**Interfaces:**
- Produces:
  - `GET /plans/timeline?from=YYYY-MM-DD&to=YYYY-MM-DD` (`project_plans:view`; initiatives filtered by `scope_conditions` like `GET /initiatives`) → `{ milestones: [{initiative_id, plan_id, task_id, name, at, complete, late}], summaries: {<initiative_id>: {percent_complete, next: {name, at} | null}} }` — milestones = tasks with `show_on_timeline` whose finish day falls in the range; `percent_complete` = the plan's top-level rollup (duration-weighted over leaves); `next` = the earliest incomplete `show_on_timeline` task finishing on or after now. Floating `at`.
  - Portal: a `pill-check` toggle "Milestones" in the toolbar next to "Show cancelled", shown only with `can('project_plans','view')`, persisted through `savePref('milestones', …)` (default on). Gantt view: diamonds (`itl-milestone`, layout-only CSS) positioned by day on each initiative's row; Calendar view: diamond chips on their day. Diamond hover: a small card (reuse `InitiativeHoverCard`'s pointer-tracking approach) with name, date, Complete / Late; click → `/initiatives/<id>?tab=plan&task=<task_id>`. The initiative hover card gains one line "Plan: 42% complete · next: Move day Nov 14" when a summary exists (prop `planLine?: string`).
- [ ] **Step 1: Failing tests** — API: a milestone inside the range is returned, one outside is not; a staff user → 403; percent and next are right for a 3-task plan. Portal: without the permission the toggle and diamonds are absent and the endpoint is never called; with it, two diamonds render on the right row; toggling off hides them and persists; the hover card shows the plan line.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (including `npx vitest run src/styles`). **Live check** + screenshot.
- [ ] **Step 5: Commit** `feat(plans): milestones on the initiatives timeline`.

### Task 6: Templates

**Files:**
- Create: `api/src/serversherpa/plans/templates.py`, `portal/src/components/plans/SaveTemplateModal.tsx`, `TemplatesModal.tsx`
- Modify: `api/src/serversherpa/api/routes/plans.py`, `api/src/serversherpa/plans/service.py` (`create_plan` honors `template_id`), `portal/src/lib/plans/api.ts`, `PlanCreateModal.tsx`, `PlanEmptyState.tsx` (enable *From a template*), `PlanToolbar.tsx` (More › Save as template…, Templates…)
- Test: `api/tests/test_plans_templates.py`, `portal/src/components/plans/TemplatesModal.test.tsx`

**Interfaces:**
- Produces:
  - `templates.py`: `def snapshot(state: PlanState) -> dict` → `{"version": 1, "calendar", "settings": plan.settings, "tasks": [{"key": str, "parent_key": str|None, "name", "duration_minutes", "duration_unit", "elapsed", "mode", "is_milestone", "constraint_type", "constraint_offset": int|None, "deadline_offset": int|None, "start_offset": int|None, "finish_offset": int|None, "notes", "show_on_timeline", "color"}], "links": [{"from", "to", "link_type", "lag_minutes", "lag_unit", "lag_elapsed"}]}` (offsets = wall-clock minutes from project start; `start/finish_offset` only for manual tasks; never assignees, progress, actuals or baselines); `def instantiate(db, plan: ProjectPlan, data: dict) -> None` (creates tasks/links shifted to `plan.project_start`, then the caller recalcs).
  - Routes: `GET /plan-templates` (`view`) → `[{id, name, description, task_count, created_by_name, updated_at}]`; `POST /plans/{plan_id}/save-as-template` (`add`) `{name, description}` → 201 (409 `template_exists` on a duplicate name); `PATCH /plan-templates/{id}` (`change`) `{name?, description?}`; `DELETE /plan-templates/{id}` (`delete`) → 204; `POST /initiatives/{id}/plan` with `template_id` → plan created from it (404 `template_not_found`). Audit each.
  - Portal: SaveTemplateModal (name, description); TemplatesModal (list with rename/description edit inline and Delete through `RowActionsMenu`); PlanCreateModal gains a template `ComboBox` (when opened from *From a template* it's required).
- [ ] **Step 1: Failing tests** — save a 4-task plan with a summary, an SS+1d link, a deadline 3 working days after start and an SNET → create a plan for another initiative from it with a project start one week later → same names/outline/links, deadline and SNET shifted by exactly 7 days, task colors kept, no assignees, 0% everywhere; duplicate name → 409; staff → 403; portal: TemplatesModal rename posts PATCH; delete asks first.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Live check** + screenshot.
- [ ] **Step 5: Commit** `feat(plans): plan templates`.

### Task 7: MS Project XML (MSPDI) export and import

**Files:**
- Create: `api/src/serversherpa/plans/mspdi.py`, `api/src/serversherpa/plans/importer.py`, `api/tests/fixtures/plans/sample_mspdi.xml`
- Modify: `api/src/serversherpa/api/routes/plans.py`, `api/pyproject.toml` (`defusedxml>=0.7`)
- Test: `api/tests/test_plans_mspdi.py`

**Interfaces:**
- Produces:
  - `mspdi.py`: `def export_xml(state: PlanState, initiative_name: str, units: Units) -> bytes` (namespace `http://schemas.microsoft.com/project`; `Project/Name`, `StartDate`, `MinutesPerDay`, `MinutesPerWeek`, `DaysPerMonth`, one base `Calendar` (UID 1) with `WeekDays` and `Exceptions`, `Tasks/Task` with `UID`, `ID`, `Name`, `OutlineLevel`, `Duration` ISO-8601 (`PT16H0M0S`), `DurationFormat` (MSPDI codes: 3 m, 4 em, 5 h, 6 eh, 7 d, 8 ed, 9 w, 10 ew, 11 mo, 12 emo; on import, the "estimated" codes 35–44 map to the same units), `Start`, `Finish`, `Milestone`, `Manual`, `ConstraintType` (0 ASAP, 4 SNET, 5 SNLT, 6 FNET, 7 FNLT, 2 MSO, 3 MFO), `ConstraintDate`, `Deadline`, `PercentComplete`, `ActualStart`, `ActualFinish`, `Notes`, `Summary`, `PredecessorLink` (`PredecessorUID`, `Type` 0 FF 1 FS 2 SF 3 SS, `LinkLag` in tenths of minutes, `LagFormat`); `Resources` (people and partners used) and `Assignments`; task color is not exported, because MSPDI keeps bar styles in the view, not on the task); `def parse_xml(content: bytes) -> ParsedPlan` (`@dataclass ParsedPlan: calendar: dict | None; tasks: list[ParsedTask]; links: list[ParsedLink]; resources: list[ParsedResource]; problems: list[str]`) — `defusedxml` parser, reject DTDs/entities (422 `bad_file`), reject files over 20 MB (413 `file_too_large`).
  - `importer.py` (shared by Task 8): `@dataclass class ImportRow: index: int; name: str; action: str ("create"); problems: list[str]; moved_days: float | None`; `async def preview(db, state: PlanState | None, parsed: ParsedPlan, mode: str) -> list[ImportRow]` and `async def apply(db, state, parsed, mode) -> list[ImportRow]` — `mode` ∈ `fill` (empty or new plan) | `append` (after the last task); outline from `OutlineLevel` (a jump of more than one level attaches to the nearest valid parent and records a problem — Review Focus 3); unknown predecessor UIDs dropped with a problem; ALAP → ASAP with a problem; resources matched by name (case-insensitive) or email against the plan's `resources`, unmatched listed as problems; calendar imported only in `fill` mode and only if it maps cleanly to the week/exception model (else a problem "Kept this plan's calendar"); after a recalc, each auto task whose start differs from the file's start by more than one working day carries `moved_days`. Preview writes nothing (run inside a SAVEPOINT that's rolled back so the recalc can be measured).
  - Routes: `GET /plans/{plan_id}/export.xml` (`view`) with `Content-Disposition: attachment; filename="<code or name> - Project plan.xml"`; `POST /plans/{plan_id}/import?dry_run=1|0&mode=append|fill` (`add`, multipart `file`) → `{rows: [ImportRow], summary: {created, problems}}`; `POST /initiatives/{id}/plan/import?dry_run=…` (`add`) creates the plan (project start = the file's `StartDate`) and imports in `fill` mode. Applying is one transaction; audit `plan_import` with counts. Locked plans refuse imports (409 `plan_locked`).
- [ ] **Step 1: Failing tests** — `sample_mspdi.xml` (hand-written to the MSPDI schema: 2 summaries, 6 tasks, one milestone, FS/SS/FF links with a 2-day lag, an SNET, a deadline, one ALAP, one resource "Pat Lee" and one unknown resource) → preview rows with the ALAP and unknown-resource problems and no DB writes; apply → the expected outline, link types and lags; `test_round_trip` (Review Focus 4): export a plan built through ops, import into a new initiative, compare every input field and link; `test_xxe_rejected` (a DOCTYPE with an ENTITY → 422 `bad_file`); `test_outline_jump` (1 → 3 → problem, still imported); `test_unknown_pred_uid` → problem, link skipped; `test_append_mode` keeps existing tasks first; `test_locked` → 409.
- [ ] **Step 2: Run** `… pytest tests/test_plans_mspdi.py -q` → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plans): MS Project XML export and import`.

### Task 8: Excel export and import

**Files:**
- Create: `api/src/serversherpa/plans/excel.py`
- Modify: `api/src/serversherpa/api/routes/plans.py`
- Test: `api/tests/test_plans_excel.py`

**Interfaces:**
- Produces: `def export_xlsx(state: PlanState, outline, units, columns: list[str]) -> bytes` — one sheet "Project plan": header row with MS Project column names for the requested column keys (the portal sends its visible columns as `?columns=id,name,duration,…`; default = the sheet's default set) plus `Outline Level`, and a `Color` column (`#rrggbb` or blank) whenever any task has a color (import reads it back; a bad value is a problem row, not a failure); names indented with `ws.cell().alignment = Alignment(indent=level-1)`; summaries bold; dates as Excel datetimes. `def parse_xlsx(content: bytes, filename: str) -> ParsedPlan` (also `.csv`) — first sheet, header row matched case-insensitively to: `ID`, `Name`/`Task Name`, `Duration`, `Start`, `Finish`, `Predecessors`, `Resource Names`, `% Complete`, `Deadline`, `Outline Level`, `WBS`, `Notes`, `Milestone`; indentation from Outline Level, else WBS depth, else flat; predecessors refer to the sheet's `ID` column, else 1-based row order; Start on an auto task becomes SNET only when there are no predecessors (otherwise it's dropped with a problem "Start ignored — set by links"); unparseable durations → problem and default duration. Reuses Task 7's `importer.preview/apply`. Routes: `GET /plans/{plan_id}/export.xlsx?columns=…`; the Task 7 import routes accept `.xlsx`/`.csv` by extension/content type.
- [ ] **Step 1: Failing tests** — export opens with openpyxl, header row and indentation right; import of a sheet with Name/Duration/Predecessors/Outline Level builds the outline and links; WBS-only sheet nests correctly; a bad duration cell is a problem row, not a failure; a CSV works; round trip of names/durations/links through export → import.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plans): Excel export and import`.

### Task 9: Import and export in the portal

**Files:**
- Create: `portal/src/components/plans/PlanImportModal.tsx`
- Modify: `portal/src/lib/plans/api.ts` (`importPlanFile`, `importIntoNewPlan`, `exportUrl`), `PlanEmptyState.tsx` (enable *Import from MS Project or Excel*; drop the "Coming soon" hints), `PlanToolbar.tsx` (More › Import…, Export ▸ MS Project XML / Excel)
- Test: `portal/src/components/plans/PlanImportModal.test.tsx`

**Interfaces:**
- Produces: `PlanImportModal` (size `xwide`, `.rgm-steps` Choose file → Review → Done): file input accepting `.xml,.xlsx,.csv`; mode `.segmented` Add to the end / Fill this empty plan (only offered when the plan is empty; a new plan always fills); Review step = a CSS-grid table of rows (#, Task Name, Action, Problems, "Moves N days" badge) with a summary line "18 tasks will be created · 3 problems"; Apply → Done step with the final summary and Close. Exports download through an authenticated fetch → blob → object URL (bearer token; a bare `<a href>` would not carry it), filename from `Content-Disposition`.
- [ ] **Step 1: Failing tests** — choosing a file posts with `dry_run=1` and renders the rows and problems; Apply posts `dry_run=0`; append/fill choice is sent as `mode`; an API 422 `bad_file` shows its message on the first step; Export › Excel requests `export.xlsx?columns=` with the visible column keys.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Live check**: export a plan to XML and Excel, re-import each into a new initiative; screenshot the Review step.
- [ ] **Step 5: Commit** `feat(plans-portal): import and export`.

### Task 10: Project plan PDF export

> Amended 2026-10-28. This task replaces the browser Print task. Jimmy asked for "an export project plan (pdf) that will show columns and gnatt on seperate pages". It is built on the report framework, the house way to make a PDF (Move Report, Timesheet).

**Files:**
- Create:
  - `api/src/serversherpa/reports/project_plan/__init__.py`: `report_type = "project_plan"`, `default_options`, `validate_options`, `validate_run_options` and `build`, shaped like `reports/timesheet/__init__.py`.
  - `reports/project_plan/gather.py`, `gantt.py`, `pdf.py` and `templates/project_plan.html`.
  - `api/tests/fixtures/plans/gantt.json`.
  - `portal/src/components/reports/ProjectPlanOptions.tsx`.
- Modify:
  - `api/migrations/versions/0110_project_plans.py`: seed a system definition named "Project plan" with the module-level `INSERT_DEFINITION_SQL` pattern of `0090_timesheet_report.py`. Downgrade deletes it. 0110 is unreleased, so amend it in place.
  - `reports/registry.py`.
  - `reports/move_report/render.py`: `render_pdf_async(html, *, url_fetcher=None)`, an optional argument passed through to WeasyPrint.
  - `api/routes/reports.py`:
    - `create_run`: a `project_plan` run needs `project_plans:view` (403 `project_plans_view_required`) and an initiative that has a plan (404 `plan_not_found`).
    - `_visible_runs`: hides `project_plan` runs from actors without `project_plans:view`, the way timesheet runs are hidden.
  - `portal/src/components/reports/GenerateReportModal.tsx`: a `project_plan` branch, plus an optional `initialInitiative` prop that skips the pick step.
  - `portal/src/pages/Reports.tsx`: Generate on this definition needs `project_plans:view`, mirroring the Timesheet's `time:view` rule.
  - The plan's More › Export submenu, from Task 9.
- Test:
  - `api/tests/test_project_plan_report.py`, `api/tests/test_plans_gantt_vectors.py`.
  - `portal/src/lib/plans/ganttGeometry.vectors.test.ts`, `portal/src/components/reports/ProjectPlanOptions.test.tsx`.
  - The More menu test.

**Interfaces:**
- Consumes:
  - The plan loaders the `GET` plan route uses (state, outline, computed fields, IDs, resources, calendar, status date, baseline, lock). Reuse them; don't write new queries.
  - `lib/plans/columns.ts` column keys.
  - `lib/plans/ganttGeometry.ts` and `ganttView.ts` zoom ids.
  - The Move Scan History footer: Page N of M, generated stamp, tracking id, PDF417.
- Produces:
  - **Run options:**
    - `columns: list[str]`: column keys. Omitted means the sheet's default set. Unknown keys are a problem.
    - `from` / `to` as `YYYY-MM-DD`: give both or neither. Omitted means the whole project.
    - `zoom`: one of the portal's zoom ids. Omitted means "fit", the same choice the portal's Fit makes for the range at one page's chart width.
    - `paper`: `letter` | `a4`, default `letter`. If `move_report` already has a house page-size setting, reuse it instead.
    - `include_completed`: default true.
    - `show_critical` and `show_baseline`: default false. The modal sends the user's current Display toggles.
    - Validation errors are `OptionsError` problems, giving 422 `invalid_options`.
  - **`gantt.py`:** a Python port of only what the PDF needs from `ganttGeometry.ts`:
    - minutes→px per zoom;
    - the fit zoom;
    - the two timescale tiers and their labels for a span;
    - bar x and width from floating start/finish;
    - milestone x;
    - the orthogonal link path the portal draws for FS/SS/FF/SF, including backward links.
    - It is pinned by `gantt.json`, an array of `{fn, args, expected}` covering every zoom, tiers across a month and a year boundary, partial-day bars and all four link types. The portal module is the reference: a vitest run with `REGEN_GANTT_VECTORS=1` writes the file. Both suites assert against it.
  - **The PDF:** landscape, 10 mm margins.
    1. **Title block:** plan name; initiative (client, code); project start → finish; status date; owner; generated at (report timezone) and by whom; Locked; "Baseline saved <date>" when there is one.
    2. **Task table section:** the chosen columns. The header repeats on every page (`thead { display: table-header-group }`), rows have `break-inside: avoid`, names are indented by outline level, summaries are bold, and IDs match the sheet.
    3. **Gantt section**, starting on a new page (`break-before: page`):
       - Each page has a names column (ID + indented Task Name) and a chart tile. The two-tier timescale repeats on every page.
       - The chart draws bars, summary brackets, milestones, progress, task colors (as the portal draws them, including the critical red with the color stripe), the baseline in gray when on, deadline markers, the today and status-date lines, nonworking shading at day and week zooms, and link paths.
       - A wide range tiles left→right, then top→bottom. Each tile is an SVG whose viewBox is that tile's window onto the full chart, so shapes and links crossing the edge are clipped, not dropped.
       - Each Gantt page's header names the tile's date span and row range.
  - **Filename:** `<initiative code or name> - Project plan - YYYY-MM-DD HHMM.pdf`, made safe with timesheet's `_safe`.
  - **Security:**
    - Jinja autoescape.
    - `render_pdf_async(html, url_fetcher=…)` with a fetcher that refuses everything but `data:` URIs.
    - Task text reaches CSS strings only through `cssstr`.
  - **Size:** there is no new cap. The worker's existing `RUN_TIMEOUT_SECONDS` is the guard. The options step shows an estimate, "About N pages (T table, G Gantt)", computed with the same geometry, so a very long PDF is visible before Generate.
  - **Portal:**
    - More › Export ▸ **PDF…**, with a Tip desc "Make a PDF of the task table and the Gantt chart on separate pages."
    - It finds the `project_plan` definition by report_type, as `TimeManagement.tsx` finds the Timesheet's (missing: the same not-set-up message).
    - It opens `GenerateReportModal` with `initialInitiative` set to this plan's initiative, plus initial options: the visible columns, the current zoom and the Display toggles.
    - `ProjectPlanOptions` uses `ReportOptionsLayout` groups:
      - Columns: `.segmented` Current view / Default / Choose…, where Choose… is a `ChipPicker` of the columns.
      - Date range: Whole project / Custom, with two date inputs.
      - Timescale: `.segmented` Fit / Days / Weeks / Months / Quarters, using the portal's zoom ids.
      - Paper: Letter / A4.
      - Include completed tasks, Show critical path and Show baseline, each a `Switch`.
      - The estimate line.
    - From the Reports page, the pick step lists initiatives. A 404 `plan_not_found` shows "This initiative has no project plan yet."
- [ ] **Step 1: Failing tests:**
  - **API options:**
    - A bad zoom, `from` after `to`, only one of from/to, or an unknown column → 422 with problems.
  - **API runs:**
    - A run without `project_plans:view` → 403.
    - An initiative with no plan → 404 `plan_not_found`.
    - History hides `project_plan` runs from a user without view.
  - **API build:** on a 12-task plan with a summary, a milestone, FS and SS links, a colored task, a baseline and a task named `<script>alert(1)</script>`:
    - The PDF bytes start with `%PDF`.
    - `render_html` has the table section before the page-broken Gantt section.
    - The name is escaped in both sections.
    - Every Gantt page repeats the names column and the timescale.
    - The colored bar uses its fill, and `show_critical` adds the critical class.
    - `include_completed=False` drops a 100% task.
    - A one-year custom range at the days zoom tiles into at least 2 pages across, with "Page" footers.
    - The url_fetcher refuses `http://` and `file://`.
  - **Vectors:** pytest and vitest both pass on `gantt.json` (at least 20 rows).
  - **Portal:**
    - More › Export ▸ PDF… opens the modal on the options step with the plan's initiative.
    - Generate posts `{definition_id, initiative_id, options: {columns, zoom, paper, include_completed, show_critical, show_baseline}}`.
    - Custom range adds `from` and `to`.
    - The estimate changes with the zoom.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS (API report and plans tests; portal `src/components/reports`, `src/components/plans`, `src/lib/plans`, `src/styles`).
- [ ] **Live check:**
  - Seed the definition on the clone DB with the migration's INSERT (don't re-run 0110).
  - Export the 40-task NAP11 plan and the 25-task Contoso plan, on Letter and A4, at Fit and at Days.
  - Render pages to PNG (`pdftoppm -r 80`). Look at the title page, a table page and two Gantt tiles, and save them to `.devlogs/shots/plan-c-10-*.png`.
- [ ] **Step 5: Commit** `feat(plans): project plan PDF export`.

### Task 11: Final verification

- [ ] **Step 1:** Full API suite (`… pytest -q`, foreground 600000 ms) and full portal suite + build (`npx vitest run`, `npm run build`). Expected: green except failures that also fail on the branch's baseline (record them).
- [ ] **Step 2:** End-to-end live pass on the worktree servers: create a plan from scratch for the NAP11 demo, a plan from a template, an imported MSPDI and an imported Excel file; run the reminder sweep against a scratch copy of the dev DB (the notification-email live-verify recipe: `pg_dump` into a scratch DB, point `SS_DATABASE_URL` at it, call `run_plan_reminders_once`, check Mailpit at `localhost:8025/api/v1/messages`, drop the scratch DB); check the Timeline page milestones; export each of those four plans as a PDF and look at every page of one of them; screenshots of every view at 1512px and 1280px; the physical-keyboard ⌘C/⌘V check in real Chrome and Safari (carried from Plan B).
- [ ] **Step 3: Commit** any fixes from the pass with their own messages.
