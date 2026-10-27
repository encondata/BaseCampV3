# Project plans: an MS Project-style schedule for each initiative

Date: 2026-10-27 · Branch: `project-plans` (worktree `.claude/worktrees/project-plans`, off main 453da1b5) · Migration: 0110

## Why

Moves are planned today in Excel sheets and email threads. The plan is built
and reworked in the weeks before a move; once the move starts the crew works
from it and it mostly stops changing. The thing that keeps going wrong
(Jimmy, 2026-10-27): *"difficult to manage when a cell needs to be shifted —
we miss dependencies and dates don't get updated."*

This feature gives every initiative a **Project plan** tab on its detail page:
a real schedule with linked tasks that move together, milestones, due dates
with reminders, and progress tracking. It should feel immediately familiar to
anyone who has used Microsoft Project — same vocabulary, same columns, same
keyboard habits — so the team can pick it up without training. It is a new
practice for everyone; there is no existing plan format to copy.

Success: a planner builds a move plan in BaseCamp instead of Excel; when one
task slips, every dependent date updates on its own; assignees get reminded
before things are due (by email, even without a portal login); at move time
the admins running the move work from the plan and mark progress.

## Who

Internal users of **admin rank or higher** only (Jimmy). No client, vendor or
worker view. The admins build the plan and also mark progress during the move;
there is no crew-facing progress surface (expect one or a few admins editing
at once). Assignees who are not admins still receive reminders (email, plus an
inbox row when they have a portal account) but cannot open the plan unless an
admin grants them access.

## Decided by Jimmy

- A new tab on each initiative's full detail page to build that initiative's
  project timeline. Full featured, comprehensive, MS Project style.
- Tasks, milestones, "checks" and "progress points".
- **Checks** = due dates with notification reminders.
- **Progress points** = marking a task or step complete, with a check that its
  children and dependencies are complete.
- Admin rank and above; internal only.
- "You choose, make it configurable" — every behavior that could reasonably go
  more than one way is a setting (system default + per-plan override).

Everything else below is my call unless marked otherwise. The list of calls is
repeated at the end.

## Goals

1. Linked scheduling that never leaves a stale date: Finish-to-Start,
   Start-to-Start, Finish-to-Finish, Start-to-Finish links with lag/lead,
   recalculated automatically on every edit.
2. MS Project familiarity: Gantt Chart view (task sheet + bar chart), the
   standard columns (ID, Mode, Task Name, Duration, Start, Finish,
   Predecessors, Resource Names, % Complete, Deadline…), outline
   indent/outdent with summary tasks, milestones as diamonds, duration entry
   like `5d`/`4h`/`2w`, predecessor entry like `3FS+2d`, MS Project keyboard
   shortcuts, a Task Information dialog, critical path, a baseline, a
   Timeline strip, and MS Project XML import/export so plans can move in and
   out of MS Project itself.
3. Due dates (MS Project "Deadline") with reminder notifications and overdue
   notices through the existing notification system.
4. Completion checks: marking complete respects subtasks and predecessors per
   configurable rules.
5. A plan can be locked once the move starts (progress updates only).
6. Templates so a plan doesn't start from nothing each move.
7. Milestones appear on the existing all-initiatives Timeline page.

## Non-goals (v1)

Resource leveling, costs, work/effort-driven scheduling, resource sheets with
rates; multiple baselines (one only); schedule-from-project-finish and ALAP
constraints; split tasks; per-task calendars; recurring tasks; master
projects / cross-initiative links; network diagram view; earned value; real-
time co-editing (optimistic version check instead); reading `.mpp` binaries
(MS Project saves `.xml`, which we read); kiosk / Android / iOS surfaces;
changing the initiative's own scheduled dates from the plan.

## Anti-goals (would make it a failure even if it "works")

- A date that should have moved and didn't. The engine is the product; it must
  be exhaustively tested.
- A grid that behaves like a web form instead of a spreadsheet (click, type,
  Enter, next row). Planners coming from Excel and MS Project will abandon it.
- Reminder spam: bursts after downtime, duplicate reminders, reminders for
  finished tasks or dead initiatives.
- Raw native controls or one-off styling. House idioms only: `.dir-search`,
  `.org-select`, `.segmented`, `ComboBox`, `.pf-form`, `RowActionsMenu`,
  `components/Switch.tsx`, the report-style modal header, rounded modal
  corners, dropdowns portaled out of modal cards.
- New reader-facing widgets elsewhere in the portal that nobody asked for.
  The only surface outside the tab is milestone diamonds on the Timeline page
  (explicitly part of "enhancing the timeline feature"), behind a toggle.

## Constraints

- Stack: FastAPI + SQLAlchemy async + Alembic (api/), React 18 + Vite portal
  (portal/). Migration head is 0109; this adds **0110**.
- American English in all copy, comments and docs.
- Permissions: new resource `project_plans` ("Project plans"), visible_to
  `{"global"}`, no routes (it's a tab). Default grants FULL to developer,
  founder, super_admin, admin; nothing to staff or below. Add it to `_ALL` in
  `access/defaults.py`, to `DEFAULT_GRANTS`, the resource registry, and seed
  grants in the migration (follow how `learning` was added in 0109 — the
  pinned-resource tests need the new id too). Every plan route also checks the
  actor can see the initiative (`scope_conditions("initiatives", …)`) — 404
  otherwise, never 403, so a hidden initiative's existence isn't confirmed.
- Actions: `view` = see the tab and plans; `add` = create a plan, save a
  template, import; `change` = edit tasks, progress, settings, lock, baseline;
  `delete` = delete a plan or a template.

## The tab at a glance

Detail page tab key `plan`, label **Project plan**, placed after "Full
Picture". Shown only with `project_plans:view`. URL state: `?tab=plan`
plus `&view=gantt|calendar|board` and `&task=<uuid>` (selects and scrolls to
a task — reminder links use it). The tab uses the full page width and has a
**Full screen** toggle (fills the viewport above the portal chrome; Esc
exits).

**Empty state** (no plan yet): "No project plan yet" with three choice cards
— *Blank plan*, *From a template*, *Import from MS Project or Excel*. Only
users with `project_plans:add` see the buttons; others see the message only.
Creating opens a modal (house modal header: eyebrow "Project plan", title,
one-line description): project start date (default today in the plan's zone),
owner (default the creator), calendar (copied from the system default), and
the template picker when relevant.

**Views** (a `.segmented` switcher at the left of the toolbar):

1. **Gantt** (default) — task sheet on the left, bar chart on the right, a
   draggable splitter between them, rows aligned and scrolled together.
   Optional **Timeline** strip above (MS Project's Timeline view): a single
   band showing the project span and every task flagged *Show on timeline*.
2. **Calendar** — month grid with tasks as spanning bars and milestones as
   diamonds (reuse `calendarWeeks()` from `lib/timeline.ts`).
3. **Board** — three columns Not started / In progress / Complete; cards show
   name, dates, assignees, late badge; dragging a card between columns sets
   0% / 50% / 100% (100% goes through the completion rules). This is the "work
   off the plan during the move" view. Leaf tasks only; summary tasks appear
   as a group label on each card.

All three share the filter bar: **Filter** (All tasks, Incomplete, Late,
Critical, Milestones, Due this week, Assigned to me, Summary tasks) as an
`.org-select`, a `.dir-search` box (task name/notes/assignee), and in the
Gantt **Group by** (None, Assignee, Status). Filters keep the outline: a
matching subtask keeps its ancestors visible (dimmed), like the initiatives
tree's context rows.

### Toolbar ("ribbon-lite")

Grouped and labeled like MS Project's Task ribbon so the muscle memory
transfers. Icon buttons with text tooltips that include the shortcut.

- **Undo / Redo**
- **Schedule:** 0% · 25% · 50% · 75% · 100% · *Mark on Track* · Link ·
  Unlink · Indent · Outdent
- **Tasks:** Auto Schedule / Manually Schedule
- **Insert:** Task · Summary · Milestone
- **Properties:** Information · Notes · Add to Timeline
- **Display:** Critical path · Baseline · Timeline strip · Zoom − / + / Fit
  project · Scroll to task
- **More ▾** (`RowActionsMenu`-style menu): Set baseline… · Clear baseline ·
  Update project… · Lock schedule / Unlock · Plan settings… · Save as
  template… · Import… · Export ▸ (MS Project XML, Excel) · Print… · Keyboard
  shortcuts · Delete plan…

Read-only users see the views, filters and Display group only.

## Data model (migration 0110)

All plan times are **floating local wall-clock times** in the plan's zone:
`timestamp without time zone`. The engine works in naive datetimes (MS Project
has no time zones; DST cannot shift a 08:00 start). `project_plans.timezone`
(IANA name) is used only to turn "now" into plan-local time and to send
reminders at the right instant. Default = the initiative's zone
(`learning.codes.initiative_zone`), editable in plan settings.

- **`project_plans`** — `id`, `initiative_id` (unique, FK cascade),
  `timezone`, `project_start` (timestamp), `status_date` (timestamp, null =
  "now"), `calendar` (jsonb, see Calendar), `settings` (jsonb — per-plan
  overrides, null keys inherit the system section), `owner_id` (people),
  `locked_at`, `locked_by`, `baseline_set_at`, `baseline_set_by`, `version`
  (int, bumped on every write), `created_by/at`, `updated_by/at`.
- **`plan_tasks`** — `id`, `plan_id` (FK cascade), `parent_id` (self FK,
  cascade), `position` (int; whole-plan order; display ID = index + 1 in
  outline order, renumbered on insert/move like MS Project), `name`,
  `is_milestone`, `mode` (`auto`|`manual`), `duration_minutes` (int ≥ 0),
  `duration_unit` (`m`|`h`|`d`|`w`|`mo` — display unit the user typed),
  `elapsed` (bool — `ed`/`eh` durations ignore the calendar), `start`,
  `finish` (computed for auto tasks, user-set for manual), `constraint_type`
  (`asap`|`snet`|`snlt`|`fnet`|`fnlt`|`mso`|`mfo`), `constraint_date`,
  `deadline`, `percent_complete` (0–100), `actual_start`, `actual_finish`,
  `notes` (text), `show_on_timeline` (default true for milestones),
  `total_slack_minutes`, `is_critical`, `conflict` (null | `constraint` |
  `link` — see Engine), `baseline_start`, `baseline_finish`,
  `baseline_duration_minutes`, `completed_at`, `completed_by`,
  `created_*/updated_*`. Summary-ness is derived (has children), never stored.
- **`plan_links`** — `id`, `plan_id`, `predecessor_id`, `successor_id` (both FK
  cascade), `link_type` (`FS`|`SS`|`FF`|`SF`), `lag_minutes` (signed),
  `lag_unit`, `lag_elapsed`. Unique `(predecessor_id, successor_id)`; check
  predecessor ≠ successor.
- **`plan_assignments`** — `task_id` (FK cascade), `person_id` (nullable FK),
  `partner_id` (nullable FK); exactly one set; unique per task+resource.
- **`plan_reminder_log`** — `task_id` (FK cascade), `person_id`, `stage`
  (`d<N>` / `due` / `overdue:<YYYY-MM-DD>`), `due_at`, `sent_at`; unique
  `(task_id, person_id, stage, due_at)`. Keying on `due_at` means moving a due
  date re-arms its reminders.
- **`plan_templates`** — `id`, `name` (unique, CITEXT), `description`, `data`
  (jsonb: calendar, the settings overrides, tasks and links with times as
  minute offsets from project start), `created_by/at`, `updated_by/at`.

## Calendar and durations

A plan calendar is MS Project's **Standard** calendar by default: Mon–Fri
08:00–12:00 and 13:00–17:00, Sat/Sun nonworking; 1 day = 8 h, 1 week = 40 h,
1 month = 20 days; default start time 08:00, default end time 17:00.
(These are MS Project's own defaults, not new policy.) Stored as:

```json
{"week": {"mon": [["08:00","12:00"],["13:00","17:00"]], …, "sat": [], "sun": []},
 "exceptions": [{"date": "2026-11-26", "name": "Thanksgiving", "hours": []},
                {"date": "2026-11-14", "name": "Move weekend", "hours": [["06:00","22:00"]]}],
 "hours_per_day": 8, "hours_per_week": 40, "days_per_month": 20,
 "default_start": "08:00", "default_end": "17:00"}
```

Exceptions make a day nonworking (empty `hours`) or give it custom hours (moves
often run on weekends). Plan settings › Calendar edits the week pattern and the
exception list.

Duration text, parsed and formatted on both sides identically (shared test
vectors): `30m`, `4h`, `2d`, `1w`, `1mo`; long forms `days`, `hrs`, `wks`…;
decimals (`0.5d`); `e` prefix on the unit for elapsed (`3ed`, `12eh`); a bare
number uses the default unit (days); `0` (or `0d`) makes a milestone (MS Project
behavior; the user can also flag a non-zero task as a milestone). Display
uses the unit the user typed: `5 days`, `4 hrs`, `0 days`, `3 edays`.

Predecessor text: comma-separated `<ID><type?><±lag?>`, e.g. `3`, `3FS+2d`,
`5SS`, `7FF-4h`, `9SF+1ed`; type defaults to FS; IDs are display IDs. The
Successors column formats the same way and is read-only.

## Scheduling engine

Pure Python module `serversherpa/plans/engine.py`, no I/O: input = calendar,
project start, status date, settings, tasks (outline), links; output = per task
`start`, `finish`, early/late dates, `total_slack_minutes`, `is_critical`,
`conflict`. The API is the **single scheduler**: every write runs the engine on
the whole plan in the same transaction and persists changed rows. The portal
never computes dates itself (it renders what the API returns), so there is one
implementation to test. Plans are small (target: 2,000 tasks / 3,000 links
recalculated in < 200 ms — add a perf test).

**Work-time arithmetic** (`plans/calendar.py`): `add_work(t, minutes)`,
`sub_work(t, minutes)`, `work_between(a, b)`, `next_work_start(t)`. Rules that
match MS Project and must be tested at every boundary:
- A task finishing exactly at the end of a working period finishes *there*
  (Mon 17:00), not at the next period's start.
- A successor's start snaps forward to the next working moment (Tue 08:00).
- A zero-duration milestone does not snap: after a predecessor finishing Mon
  17:00 it sits at Mon 17:00.
- Elapsed durations and elapsed lags add wall-clock minutes, no snapping.

**Links** (successor S, predecessor P, lag L in working time unless elapsed;
negative = lead):
- FS: S.start ≥ P.finish + L · SS: S.start ≥ P.start + L
- FF: S.finish ≥ P.finish + L · SF: S.finish ≥ P.start + L

**Summary tasks** are linkable, like in MS Project. Model each summary as two
graph nodes: an *entry gate* (the earliest its subtasks may start, from links
into the summary and from its own ancestors' gates) and a *rollup* (start =
min, finish = max of its descendants). Leaves depend on every ancestor's entry
gate; a rollup depends on its descendants; links *from* a summary read its
rollup. Reject (422 `link_to_outline`) any link between a task and its own
ancestor or descendant. Topologically sort; a cycle is rejected (422
`link_cycle` with the task IDs on the cycle) and the batch rolls back.

**Forward pass** (leaves in topological order): start = max(project start
snapped, link-driven dates, ancestor gates, constraint floor). Constraints:
SNET/FNET set floors; MSO/MFO pin the date; SNLT/FNLT set ceilings. When a link
and a constraint disagree, the **Honor constraints** setting decides (MS
Project's "Tasks will always honor their constraint dates", default on): on →
the constraint wins and the task gets `conflict = 'link'` (shown as a red
indicator; slack goes negative); off → links win and the task gets
`conflict = 'constraint'`.

- **Manual tasks** keep the start/finish the user typed (the engine never moves
  them) but still drive their successors.
- **Actuals**: an `actual_start` pins start; an `actual_finish` pins finish.
- Not-started tasks are never moved for being in the past; they show as Late.

**Backward pass** → late dates; deadlines and SNLT/FNLT/MSO/MFO cap late
finish/start (MS Project behavior: a deadline affects slack, not dates).
`total_slack_minutes` = working minutes from early start to late start
(negative allowed). `is_critical` = slack ≤ *critical slack* setting (default
0 days). The project finish is the latest leaf finish.

**Summary rollups**: dates from descendants; duration = `work_between`; %
complete = duration-weighted average of leaf descendants (count-weighted if
every leaf is a zero-duration milestone).

**Editing rules that touch the engine** (MS Project behavior; each shows a
small toast with Undo, no blocking wizard):
- Typing a Start on an auto task sets an SNET constraint at that date
  (date-only input → the calendar's default start time). Typing a Finish sets
  FNET (date-only → default end time). Typing both sets SNET and the duration
  between them.
- Dragging a bar sets SNET. Dragging a bar's right edge sets the duration.
- Typing a date on a manual task sets it directly.
- Switching a task manual → auto lets the engine move it.

## Progress and completion checks

- `percent_complete` 0–100. Setting it above 0 sets `actual_start` to the
  scheduled start if empty; 100 sets `actual_finish` to the scheduled finish if
  empty, plus `completed_at/by`. Dropping below 100 clears `actual_finish`,
  `completed_*`. Summary % is derived and not directly editable except by
  marking it complete (below).
- **Mark on Track** (MS Project): sets each selected task's % to the share of
  its duration scheduled before the status date.
- **Update project…**: status date picker (default now) + "Update work as
  complete through" that date: every task finishing before it → 100%, every
  task spanning it → Mark on Track. Goes through the completion rules with the
  same confirmation.

**Completion rules** — two settings, each with a system default and a per-plan
override. Applied whenever a task reaches 100% (button, % cell, Board drag,
Update project, import does *not* apply them):

| Setting | Options | Default |
|---|---|---|
| **Subtasks** — when completing a summary task | *Complete them too* (confirm dialog lists the open subtasks that will be completed) · *Must be complete first* (blocked, dialog lists them) · *Don't check* | Complete them too |
| **Predecessors** — when completing any task | *Must be complete first* (blocked, dialog lists open predecessors) · *Warn* (confirm dialog lists them) · *Don't check* | Must be complete first |

Defaults are my call: *Complete them too* matches how MS Project treats a
summary at 100%; *Must be complete first* for predecessors is the "check"
Jimmy described. Predecessors here means every task linked into it (any link
type) and the predecessors of its ancestors. The blocked dialog offers "Go to
task" for each blocker.

API shape: a completion that needs confirmation returns 409
`completion_confirm` with the lists; the client shows the dialog and resends
with `confirm: true`. A blocked completion returns 409 `completion_blocked`
with the blockers. Both name each task (ID + name + reason
`subtask|predecessor`).

## Due dates and reminders ("checks")

- Each task can have a **Deadline** (column name kept from MS Project; the
  Task Information field reads "Deadline (due date)"). Shown on the Gantt as a
  down-arrow marker; a task whose finish is after its deadline gets a
  missed-deadline indicator.
- The **due moment** of a task = its deadline; when the setting *Remind on
  finish dates when there is no deadline* is on, tasks without a deadline use
  their finish. Default **off** (my call — avoids reminder floods on large
  plans; due dates stay a deliberate act).
- Reminder **stages**, sent at the plan-local *send time*:
  `d<N>` for each offset N days before the due day, `due` on the due day, then
  `overdue` (cadence *daily* / *once* / *off*) while incomplete.
- Defaults (configurable): offsets **[3, 1]**, due-day on, overdue **daily**,
  send time **08:00**, overdue also to the plan **owner** on, a notice when
  someone is **assigned** to a task on (one notice per person per edit batch,
  "You were assigned 4 tasks in <initiative>").
- Recipients: person assignees (partners never get reminders). A task with no
  person assignee sends nothing except the owner's overdue copy.
- **Delivery** (copies the learning feature, which reaches workers the same
  way — `learning/emails.py`): a reminder is personal, so it does **not** go
  through notification-group email subscriptions (a new category starts with
  no subscribed groups, and most of the move team have no portal login).
  - Every reminder, overdue notice and assignment notice is a **direct email**
    to the person's contact email through the mail outbox (`mail.outbox.enqueue`,
    a new `plan_reminder` mail template), when they have one.
  - People with a portal account also get the **inbox row**: call `notify()`
    with the plan kinds registered `email=False`, so `notify()` never sends a
    second, group-driven email.
  - The person's own /me choice for the "Project plans" category is honored
    for account holders: *Off* → nothing, *Inbox* → inbox only, *Email* (the
    default) → inbox + direct email.
  - Setting `reminders.email_assignees` (default on) turns the direct email
    off system-wide or per plan.
  - The Resource Names picker marks a person with no email and no account
    "won't get reminders", and Task Information shows the same note.
  - Migration 0110 adds `plans` to the `ck_notification_groups_categories`
    check (so groups *may* subscribe for the owner-style copies later) but
    subscribes no group.
- Sweep: `run_plan_reminders_once(maker)` in `plans/reminders.py`, called by
  the notification-worker loop next to `run_learning_once` (every 60 s). Copy
  the learning sweep's rules: of the stages whose time has passed, only the
  **latest** is sent (no burst after downtime or a late edit); each stage goes
  once per (task, person, due_at); reminders run whether or not the plan is
  locked; nothing for completed tasks, nothing for archived or inactive initiatives
  (`INACTIVE_STATUSES`), nothing when reminders are disabled. One initiative
  per transaction; failures counted and logged once per outage.
- Notification kinds in `notifications/kinds.py`, new category `plans` →
  "Project plans" (mirror in `portal/src/lib/notificationKinds.ts` and the /me
  category table): `plan_task_assigned`, `plan_task_due` ("Due in 3 days:
  Order crates — NAP11 Hall Migration"), `plan_task_overdue`. Link:
  `/initiatives/<id>?tab=plan&task=<task_id>`.

## Lock, baseline, status date

- **Lock schedule** (their process: the plan freezes once the move starts):
  when locked, only progress edits are accepted — % complete, actuals, mark
  complete, notes. Everything else returns 409 `plan_locked`. A banner on the
  tab: "Schedule locked by <name> on <date> — progress updates only" with an
  Unlock button for `change` holders. Manual toggle only (my call); no
  auto-lock.
- **Baseline** (one): *Set baseline* copies start/finish/duration into the
  baseline columns for every task (confirm when replacing: "Replace the
  baseline set on <date>?"); *Clear baseline* empties them. Gantt draws a thin
  gray baseline bar under each task (Display › Baseline). Columns: Baseline
  Start, Baseline Finish, Baseline Duration, Start Variance, Finish Variance
  (working days).
- **Status date**: null = now. Drawn as a line on the Gantt next to the today
  line; used by Mark on Track, Update project, and the Late filter.

## The task sheet (grid)

A spreadsheet, not a directory list (so it does **not** use `.list-head` /
`.dir-list` classes — the list-floors guardrail would otherwise apply), but it
reuses the list typography tokens and honors the user's `list_size` scale.
Virtualized rows (`@tanstack/react-virtual`), row height shared with the Gantt.

- **Default columns**: indicators · ID · Mode · Task Name · Duration · Start ·
  Finish · Predecessors · Resource Names · % Complete · Deadline.
- **Optional** (column chooser, MS Project names): WBS, Successors, Total
  Slack, Critical, Status, Constraint Type, Constraint Date, Actual Start,
  Actual Finish, Baseline Start/Finish/Duration, Start/Finish Variance, Notes,
  Created, Updated. Visible set, order and widths persist per user (local
  storage is fine).
- **Indicators column**: note, constraint (icon + tooltip with type/date),
  missed deadline, link/constraint conflict, complete check, locked.
- Task Name indents by outline level; summaries are bold with a collapse
  chevron; collapse state persists per user per plan.
- Date cells show `Mon 11/3/26` (MS Project's default style); plan setting
  *Show times* adds `8:00 AM`. Floating times: the portal parses and formats
  them as UTC-naive (never `new Date(localString)`), via one helper module.
- A blank row at the bottom: typing a name there adds a task (MS Project).
- Editing: click selects a cell; typing starts editing; **F2** edits; Enter
  commits and moves down; Tab / Shift+Tab move across; Esc cancels; arrows
  move. Cell editors: text for name/duration/predecessors; date picker for
  dates (typing accepted); a ComboBox multi-select with type-to-filter for
  Resource Names; select for Mode / Constraint Type. Invalid input shows an
  inline error and keeps the editor open.
- Selection: click row ID to select rows; Shift/Ctrl(⌘) extend; bulk ops apply
  to the selection.
- Rows drag-reorder by the ID cell (moves the subtree).
- **Paste from Excel**: a multi-line tab-separated paste fills cells from the
  active cell across the visible columns (Excel behavior) and creates tasks
  for extra rows. Ctrl/⌘ C/X/V copy/move tasks within the plan.

**Keyboard map** (MS Project; ⌘ for Ctrl and ⌥ for Alt on Mac): Insert (new
task above), Delete (delete tasks, confirm if any has subtasks), Alt+Shift+→ /
← indent / outdent, Ctrl+F2 link selected (in selection order, FS), Ctrl+Shift+F2
unlink, Shift+F2 Task Information, Ctrl+Z / Ctrl+Y undo/redo, Ctrl+Shift+F5
scroll to task, Alt+Shift+− / + collapse / expand, Ctrl+F focus search, `?`
opens the shortcuts dialog. Shortcuts are inactive while a cell editor is open
(except Esc/Enter/Tab).

**Undo/redo**: every API write returns the inverse ops; the client keeps a
20-step stack (MS Project's default undo levels), session-only, cleared on
reload or on a version conflict.

## The Gantt chart

- Two-tier timescale like MS Project (e.g. months over days). Zoom levels:
  Hours, Days, Weeks, Months, Quarters; − / + / **Fit project**; Ctrl+wheel
  zooms. Nonworking time shaded at Hours/Days zoom.
- Bars: tasks (accent color), progress fill inside the bar, summaries as a
  bracket bar, milestones as a diamond with the date label, critical tasks in
  the danger color when Display › Critical path is on, baseline bar under,
  deadline marker, resource names to the right of the bar (MS Project
  default). Today line, status-date line, and a faint band for the
  initiative's own scheduled window ("Scheduled: Nov 14–16").
- Link arrows drawn in an SVG overlay with right-angle routing.
- Interactions (disabled when locked except progress drag): drag a bar to move
  (SNET), drag its right edge for duration, drag the progress handle for %,
  drag from one bar onto another to link (FS), double-click a bar for Task
  Information, click a link arrow for the **Task Dependency** dialog (type,
  lag, Delete).
- Hover card (reuse the pointer-tracking approach of `InitiativeHoverCard`,
  its own `pln-` class prefix): name, start, finish, duration, %, assignees,
  deadline, slack.

## Dialogs

All use the house modal header (eyebrow, title, one-line description), size to
content, portaled dropdowns, rounded corners.

- **Task Information** (Shift+F2 / double-click), tabs like MS Project:
  *General* (name, %, duration, start, finish, mode, milestone, show on
  timeline, deadline), *Predecessors* (table: ID, name, type, lag; add/remove),
  *Resources* (assignees), *Advanced* (constraint type + date, elapsed), *Notes*.
- **Task Dependency** (from a link arrow).
- **Plan settings**: General (project start, owner, timezone, status date,
  show times, default task mode, default duration, honor constraints, critical
  slack), Calendar (week pattern + exceptions table), Completion rules,
  Reminders (each with "Use system default").
- **Update project**, **Set baseline** confirm, **Import**, **Save as
  template**, **Templates** (list/rename/delete), **Keyboard shortcuts**,
  **Print**, **Delete plan** (type the initiative name to confirm).

## Resources (assignees)

The Resource Names picker offers: the initiative's team (`initiative.people`),
internal users with a portal account (global anchor), and the partners linked
on the initiative (shipping/tech/cable/logistics partner fields) — partners are
display-only resources with no reminders. Typed names resolve
case-insensitively against that list; an unknown name is an inline error (we
never create people from the plan).

## Templates

- *Save as template…* (`add`): name + description; stores the structure,
  durations, links, constraints and deadlines as offsets from project start,
  calendar and settings overrides; never assignees, progress or baseline.
- *From a template*: pick one, choose the project start; dates shift.
- *Templates* dialog: rename, edit description, delete (`delete`).
- No templates ship with the feature (my call — content is the team's).

## Import, export, print

Every import is **dry-run → per-row summary → apply** (house rule for bulk
actions): the preview lists each task with what will happen and every problem
(unmatched resources, unsupported constraint mapped to ASAP, bad predecessor
reference); apply shows the final summary. Imports either fill an empty plan /
create the plan, or **append** to an existing one (choice in the modal;
replacing a non-empty plan is not offered — delete the plan first).

- **MS Project XML (MSPDI)** — the format MS Project saves with *Save As › XML*.
  Read: tasks (UID, Name, OutlineLevel, Duration ISO-8601, Start, Finish,
  Milestone, Manual, ConstraintType 0–7 (ALAP → ASAP with a note), ConstraintDate,
  Deadline, PercentComplete, ActualStart/Finish, Notes), PredecessorLink
  (Type 0=FF 1=FS 2=SF 3=SS, LinkLag in tenths of minutes, LagFormat → elapsed),
  the project calendar's week days and exceptions when they map cleanly
  (otherwise the plan keeps its calendar, noted in the summary), Resources +
  Assignments matched by name or email to people/partners (unmatched listed,
  not created). Summary rows come from outline levels. MS Project's computed
  dates are not imported for auto tasks: the engine reschedules them from
  links, constraints and the calendar (manual tasks keep their file dates).
  The preview flags every task whose start differs from the file by more
  than one working day, so a calendar mismatch is visible before apply.
- **Excel (.xlsx / .csv)** — first sheet, header row matched case-insensitively
  to MS Project's own Excel export names (Name/Task Name, Duration, Start,
  Finish, Predecessors, Resource Names, % Complete, Deadline, Outline Level,
  WBS, Notes, Milestone, ID). Indentation from Outline Level or WBS; flat when
  neither. Predecessors refer to the sheet's ID column, else row order.
- **Export**: MS Project XML (round-trips through our own importer — test it)
  and Excel (.xlsx of the visible columns plus Outline Level, names indented).
  Both built in the API (openpyxl + lxml/ElementTree); downloads named
  `<initiative code or name> - Project plan.<ext>`.
- **Print…**: options for columns (current / default), date range (project /
  custom), and timescale; opens a print window (the rack-diagram print-window
  pattern) with the sheet + Gantt, landscape, header repeated per page, fit to
  page width. The browser's Save as PDF covers PDF.

## All-initiatives Timeline page

For users with `project_plans:view` only: a **Milestones** toggle in the
`/initiatives/timeline` toolbar (persisted like the other view prefs, default
on). Each initiative row in the Gantt view shows diamonds for its plan's tasks
flagged *Show on timeline*; the calendar view shows them as diamond chips on
their day. Diamond hover: name, date, Complete / Late. Click → that initiative's
plan tab with the task selected. The existing initiative hover card gains one
line, "Plan: 42% complete · next: Move day Nov 14". Data from
`GET /plans/timeline?from&to` (scope-filtered, same range as the page).

## Settings

**System settings › Project plans** (`/settings/project-plans`, new tab next to
the others; readable and writable by `settings` holders like the learning
section). System config section `project_plans` (defaults in
`config_store.DEFAULTS`, frozen view in `plans/settings.py`, written only by
`routes/system.py`):

```
calendar: <Standard calendar above>
honor_constraints: true        critical_slack_days: 0
default_task_mode: "auto"      default_duration: "1d"
completion: {subtasks: "cascade", predecessors: "block"}
reminders: {enabled: true, offsets_days: [3, 1], on_due_day: true,
            overdue: "daily", send_time: "08:00",
            use_finish_without_deadline: false,
            notify_on_assign: true, overdue_to_owner: true,
            email_assignees: true}
```

A new plan copies the calendar; every other key is inherited live unless the
plan overrides it (Plan settings shows "Use system default" per group).

## API

New router `api/routes/plans.py` (+ `plans/` service package: `engine.py`,
`calendar.py`, `durations.py`, `ops.py`, `completion.py`, `reminders.py`,
`mspdi.py`, `excel.py`, `templates.py`, `settings.py`, `schemas.py`).

- `GET /initiatives/{id}/plan` → plan + tasks + links + assignments +
  computed fields + `permissions` (can_change etc.); 404 `no_plan`.
- `POST /initiatives/{id}/plan` `{project_start, owner_id?, template_id?}`.
- `PATCH /plans/{plan_id}` settings/calendar/owner/timezone/status date
  (`base_version` required).
- `POST /plans/{plan_id}/ops` `{base_version, ops: [...]}` →
  `{version, tasks: [changed rows], links: [changed], deleted: {tasks, links},
  inverse: [...], notices: [...]}`. Ops: `add_task` (client `temp_id`,
  `after_id`, `parent_id`, fields), `update_task`, `delete_tasks` (subtrees),
  `move_tasks`, `indent`, `outdent`, `add_link`, `update_link`,
  `delete_link`, `set_assignees`, `set_percent`, `complete` (with `confirm`),
  `mark_on_track`. One transaction per batch; any error rolls back everything.
  **Concurrency:** structural and date ops require `base_version` to match
  (else 409 `plan_changed`). A batch made only of *progress ops*
  (`set_percent`, `complete`, `mark_on_track`, and `update_task` touching only
  `percent_complete` / actuals / notes) applies against the current state
  without a version match, so two admins marking progress never collide; the
  response still carries the new version. The tab checks
  `GET /plans/{id}/version` every 30 s while visible and refreshes when
  someone else changed the plan (deferred while a cell editor or dialog is
  open, with a "Plan updated by <name> — refresh" bar instead); a refresh
  clears the undo stack.
  Errors: 409 `plan_changed` (with current version), 409 `plan_locked`, 422
  `link_cycle` / `link_to_outline` / `bad_duration` / `bad_predecessor` /
  `bad_field`, 409 `completion_blocked` / `completion_confirm`.
- `POST /plans/{id}/update-project` `{status_date, complete_through?, confirm?}`.
- `POST /plans/{id}/baseline` / `DELETE /plans/{id}/baseline`.
- `POST /plans/{id}/lock` / `DELETE /plans/{id}/lock`.
- `DELETE /initiatives/{id}/plan`.
- `POST /plans/{id}/import?dry_run=1` (multipart; `mode=append|fill`) and
  `POST /initiatives/{id}/plan/import` (create from file).
- `GET /plans/{id}/export.xml`, `GET /plans/{id}/export.xlsx`.
- `GET /plan-templates`, `POST /plans/{id}/save-as-template`,
  `PATCH /plan-templates/{id}`, `DELETE /plan-templates/{id}`.
- `GET /plans/timeline?from&to`.
- `GET|PUT /system/project-plans`.
- Audit (`services/audit.py::audit`): one row per ops batch (`plan_update`,
  with op counts), plus create/delete/lock/unlock/baseline/import/template
  actions.

## Portal structure

`portal/src/components/plans/` — `PlanTab.tsx` (data, version, undo stack,
view switch, URL state), `PlanToolbar.tsx`, `PlanSheet.tsx`, `PlanGantt.tsx`,
`PlanTimelineStrip.tsx`, `PlanCalendar.tsx`, `PlanBoard.tsx`, dialogs
(`TaskInfoModal`, `TaskDependencyModal`, `PlanSettingsModal`,
`PlanCreateModal`, `PlanImportModal`, `TemplatesModal`, `UpdateProjectModal`,
`ShortcutsModal`, `PrintPlanModal`, `CompletionDialog`). `portal/src/lib/plans/`
— `durations.ts`, `predecessors.ts`, `floatingTime.ts`, `ganttGeometry.ts`
(pure: scale, bar/diamond positions, arrow routes), `undo.ts`, `api.ts`,
`filters.ts`. Styles in `styles/plans.css`, class prefix `pln-`. Settings page
tab in `pages/Settings.tsx`. Timeline additions in `InitiativeTimeline.tsx`.

## Testing

- **Engine**: calendar arithmetic at every boundary (end of day, lunch, Friday →
  Monday, exceptions, custom-hours days, elapsed); each link type with lag,
  lead and elapsed lag; summaries as predecessors and successors; nested
  summaries; cycles and outline links rejected; constraints with honor on/off
  and the conflict flag; manual tasks; actuals; milestones at day end;
  slack/critical incl. negative slack and deadlines; rollups; a 2,000-task perf
  test. Fixtures pick lexically-misleading dates (see the hierarchy lesson).
- **API**: every op; version conflict; lock; completion rules in every mode;
  permissions (staff → 403 `forbidden`, admin allowed, an initiative outside
  the actor's scope → 404); assignment notices; reminder sweep (stages, latest-only after downtime,
  re-arm on moved due date, inactive/archived initiatives, disabled setting,
  owner overdue copy); MSPDI and Excel import dry-run/apply; export→import round
  trip; template save/apply date shift.
- **Shared vectors**: one JSON file of duration and predecessor strings with
  expected parse/format results, read by both pytest and vitest.
- **Portal**: parsers, floating time, Gantt geometry, undo stack, sheet
  keyboard behavior, paste, completion dialog flows, tab gating, timeline
  milestones gating.
- **Live verify** in the browser with screenshots at 1512px and a smaller
  laptop width before calling any UI done.

## Build order

1. Migration 0110, resource/grants, settings section, engine + calendar +
   durations (pure, test-first), core API (create/get/ops/settings).
2. Tab, empty state, create modal, sheet editing, Gantt rendering, toolbar,
   Task Information, keyboard map, undo/redo.
3. Gantt interactions, critical path, completion rules + dialogs, Mark on
   Track / Update project, lock, baseline, status date.
4. Reminders + notification kinds + System settings tab + Plan settings
   dialog.
5. Calendar view, Board, Timeline strip, all-initiatives Timeline milestones.
6. Templates, import (MSPDI, Excel), export, paste, print.

## Calls I made (Jimmy to check)

1. Tab name **Project plan**; resource `project_plans`; admin+ by default,
   adjustable in Access.
2. API-side single scheduling engine; floating local times per plan.
3. MS Project's Standard calendar and unit conversions as defaults.
4. Completion defaults: summaries *complete their subtasks* (with confirm);
   predecessors *must be complete first*. Both configurable.
5. Reminders key off Deadline; finish-date reminders off by default. Offsets
   3 and 1 days, on the due day, overdue daily at 08:00; owner gets overdue
   copies; assignment notices on. All configurable. Delivered as a direct
   email to the assignee (like learning) plus an inbox row for account
   holders — not through notification-group subscriptions.
5a. Progress edits never hit a version conflict; the tab polls every 30 s
    for other admins' changes.
6. Lock is a manual toggle (no auto-lock when the move starts).
7. One baseline; no schedule-from-finish, ALAP, costs, leveling (non-goals).
8. Partners can be listed as resources, without reminders.
9. No starter templates shipped.
10. Milestones on the all-initiatives Timeline behind a default-on toggle, for
    plan viewers only; one "Plan:" line in its hover card.
11. Undo depth 20 (MS Project's default).

## Left to the builder

Exact component boundaries, CSS details within the house idioms, how the sheet
stores column widths, MSPDI parser library choice, print pagination math, the
toast component used for engine-side notices, and the exact op payload field
names beyond those listed.
