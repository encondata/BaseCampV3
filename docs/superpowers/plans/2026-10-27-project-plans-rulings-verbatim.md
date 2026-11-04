# Project plans: rulings, verbatim

Every line that contains "Ruling" in the three ledgers, copied exactly as written, in source order. Numbers (A1, B1, C1 ...) are added in front; nothing else is changed. Some viewers hide text inside angle brackets (for example `<day>`); the file itself has it.

## Plan A: core plan tab (sheet, scheduling engine, links, Gantt)

Source: `plan-a-rulings.md`

**A1.** Ruling 1: `set_percent`/`update_task.percent_complete` on a summary task: 100 behaves exactly like `complete [summary]` (completion rules apply); any other value → 422 `summary_field` — spec says summary % is derived and editable only by marking it complete — cost if wrong: a planner can't set 50% on a summary (MS Project also derives it).

**A2.** Ruling 2: the test file is `api/tests/test_plans_floating.py` (flat `test_plans_*` convention) — naming only — trivial.

**A3.** Ruling 3: plan timezone = the initiative site's `Site.timezone` via `services.timeclock.site_zone(db, initiative_site_id(initiative), fallback=None)`; when that is None use `services.timezone.DEFAULT_TIMEZONE` — avoids guessing from a UTC ZoneInfo — cost if wrong: none beyond a default.

**A4.** Ruling 4: implementers run the focused files plus all `tests/test_plans_*.py` plus existing test files their change touches, not the whole API suite, per task; the full API suite runs at Task 12 Step 5 and in the final review — the suite takes over an hour — cost if wrong: a regression in an unrelated area is caught at Task 12 instead of earlier.

**A5.** Ruling 5: implementers use `SS_TEST_DB=serversherpa_test_plans_impl`, reviewers `serversherpa_test_plans_review`; `serversherpa_test_project_plans` is for full-suite runs — parallel runs on one DB truncate each other — cost if wrong: none.

**A6.** Task 2: Ruling: the plan regex is a hint — strip + drop trailing \s* + 64-char cap accepted with the same accepted set — linear matching on untrusted text — cost if wrong: none (accepted set unchanged)

**A7.** Task 3: Ruling: allow "24:00" as an interval end (next-day midnight) — move weekends run 24h and 23:59 loses a minute per midnight — cost if wrong: a slightly looser validator

**A8.** Task 3: Ruling: default_end also rejects 24:00 — it is a same-day time used for date-only finish input — cost if wrong: a date-only finish on a 24h calendar lands at the configured end, not midnight

**A9.** Task 4: Ruling: manual task with start+finish stored keeps its span; actual_start shifts the finish by that span (elapsed: wall clock); TaskOut.duration = span — spec says the engine never moves manual dates — cost if wrong: a manual task whose duration field disagrees with its dates shows the dates, not the duration

**A10.** Ruling (for Task 9): when indent/move turns a task into a summary, a constraint other than asap/snet on it is reset to asap with a notice {"code":"constraint_cleared"}; an FF/SF link into it is NOT dropped — the batch fails 422 bad_summary_link naming the link — silently deleting a dependency is worse than asking — cost if wrong: one extra step for the planner

**A11.** Task 6: Ruling: the brief row test_fnlt_caps_late_finish (honor off, no links → slack −480) was mis-specified — Task 4 lets a ceiling before the project start move the task when no link is involved, so slack is 0; the test now uses X 960 → A (A and X slack −960) and a separate test pins the no-link behavior — cost if wrong: if MS Project instead clamps to the project start, an unlinked FNLT before the start would show 0 slack rather than negative

**A12.** Task 6: Ruling: backward pass — the gate rolls up its subtasks late starts; the rollup passes caps (summary deadline, links out; SS/SF conservative) down — the brief wording ("gate passes its late start down") cannot work in reverse order — cost if wrong: slack on summary-linked tasks slightly off

**A13.** Task 6: Ruling: SS/SF from a summary use an offset-preserving cap (each subtask late start ≤ add_work(R, offset from summary start)) instead of capping every subtask at R — the conservative rule flagged sequenced subtasks critical with negative slack on feasible schedules — cost if wrong: slightly more slack shown on subtasks of a summary with SS/SF links out

**A14.** Task 6: parked — deadline before the only working day of a degenerate calendar raises CalendarError in the backward pass — Ruling: degenerate calendars (no regular working week) are an edge the forward pass already shares; real and deferred

**A15.** Task 6: parked — cycle folding can hide one partner of a separate loop when both loops are reported — Ruling: cosmetic, error still names a member of each loop

**A16.** Task 6: Ruling (supersedes the offset ruling): SS/SF from a summary cap only the leaf descendants whose scheduled start equals the summary start (all on a tie); FS/FF unchanged (exact) — the summary start is the min of subtask starts, so other subtasks can slip freely — cost if wrong: on ties both starting subtasks show critical though either alone could slip

**A17.** Note for Task 8 (refines Ruling 3): plan timezone = (await site_zone(db, initiative_site_id(initiative), fallback=DEFAULT_TIMEZONE)).key — services.timeclock.site_zone already falls back to the given name, then UTC.

**A18.** Task 8: Ruling: DELETE of a locked plan is allowed — deleting needs project_plans:delete and the UI requires typing the initiative name — cost if wrong: a locked plan can be deleted by a delete-holder

**A19.** Task 9: Ruling: durations/lags above 10 years of working time (minutes_per_day × 260 × 10) → 422 bad_duration — the parser has no magnitude cap and an absurd value only produces overflow errors — cost if wrong: a plan longer than 10 years can't be entered

**A20.** Task 9: Ruling (accepting the implementer's reading over controller Ruling 1): date-only FNET/FNLT/MFO constraint dates take the calendar default END time; SNET/SNLT/MSO take default start — a finish-type constraint typed as a date means the end of that day, matching a typed Finish — cost if wrong: none

**A21.** Task 9: Ruling: a Start typed alone on a manual task moves the task and keeps its duration (MS Project behavior) — cost if wrong: the finish moves with the start

**A22.** Task 9: Ruling: plan_tasks.parent_id FK becomes DEFERRABLE INITIALLY DEFERRED in 0110 — any in-batch insert/update order works — cost if wrong: a parent-loop/dangling parent is caught at commit instead of statement time (still inside the batch transaction)

**A23.** Task 9: Ruling: every inverse the server emits is HMAC-signed (plan_id + canonical JSON, key derived from jwt_secret with context "plan-restore-v1"); a restore without a valid signature → 422 bad_restore — closes S1 and S2 without losing undo of archived assignees or stamps — cost if wrong: rotating jwt_secret invalidates in-flight undo stacks (clients reload)

**A24.** Task 9: Ruling: a signed progress-only inverse may be replayed later (no version binding) — it only rewrites values the server itself recorded, and binding to versions would break undo after any other admin's progress edit — cost if wrong: an old undo of a % edit can be re-applied by the same client

**A25.** Task 9: Ruling: restore's content-level resource check accepts any still-existing person/partner (looser than before) — the HMAC signature already limits restored assignees to server snapshots, and the strict rule broke undo after an assignee left the initiative — cost if wrong: defense-in-depth layer is thinner if signing ever breaks

**A26.** Task 10: Ruling: a re-saved Predecessors entry keeps the stored lag when its typed lag shows the same sign and format_lag text (also on type-only edits/re-spellings) — prevents silent 160→158 drift — cost if wrong: a lag typed more precisely than the cell shows is ignored there (update_link still sets exact values)

**A27.** Task 9 carry: Ruling: undoing an actual-date edit that moved a manual task is a structural batch (refused while locked) — the edit moved scheduled dates; % edits on manual tasks don't move them and stay progress-only — cost if wrong: unlocking needed to undo such an actual edit

**A28.** Task 11: Ruling: actual-date fills are queued and resolved once from the end-of-batch schedule; mark_on_track/update-project compute targets from one schedule per op — keeps Task 9's recalc-at-end model and makes paste linear — cost if wrong: none expected (fills never move dates)

**A29.** Task 11: Ruling (product): update-project never lowers recorded progress (max(current, on_track)); Mark on Track still overwrites — a bulk "complete through" should only move progress forward — cost if wrong: a task recorded ahead of schedule keeps its higher % after Update project

**A30.** Task 12: Ruling: a system PUT that changes honor_constraints or critical_slack_days recalculates every plan that inherits the changed key (locked plans included), bumping each version — the spec says plans recalc on every edit and the next write would move them anyway — cost if wrong: a system setting change can move dates on a locked plan without anyone editing it

**A31.** Task 12: Ruling: calendar exception names use the task-name length limit and reject control characters; exception lists cap at 20,000 (the existing list cap) — technical bounds reused, not new policy — cost if wrong: none expected

**A32.** Task 12: Ruling: calendar exception names get no length cap — task names have none either, and inventing a number is policy — cost if wrong: an admin can store a very long holiday name (admin-only, request-size bound)

**A33.** Task 12: Ruling: on a system PUT, an inheriting plan whose recalc fails keeps its dates but still gets a version bump (the new setting applies to it) — cost if wrong: open tabs refetch a plan whose dates didn't move

**A34.** Plan A: Ruling: one fix dispatch takes I1 (indexes added to 0110 in place — unreleased, dev DB never migrated to it), M1, M2, M3, M4, M7 (MS Project parity), M8, M10 (one-line row lock) — cheap and each closes a user-visible or data-integrity gap — cost if wrong: none expected

**A35.** Plan A: Ruling: M5 (O(links) predecessor/duplicate scans per op) moves to Plan B Task 7 (paste), where the 2k-row case first exists — cost if wrong: a large paste takes seconds inside the plan lock until then

**A36.** Plan A: Ruling: M6 NaN/Infinity → 500 is pre-existing on main for every route; it leaves this branch as a separate follow-up on main (global RequestValidationError handler, then drop JsonSafeBody) — cost if wrong: plan routes other than PATCH/system PUT answer 500 instead of 422 to non-finite JSON

**A37.** Plan A: Ruling: M9 (recalc_inheriting lock breadth) left — admin-only rare write, ~50 ms per 3k-task plan — cost if wrong: a system PUT briefly stalls in-flight plan edits

**A38.** Plan A: Ruling: M10 first-save race (row missing → second concurrent PUT gets a DB error, nothing lost) left — admin-only, once per install — cost if wrong: one admin sees an error and saves again

**A39.** Plan A: Ruling: plan_assignments(partner_id) index carried to Plan C Task 1 (amend 0110 while unreleased) — cost if wrong: a partner delete scans plan_assignments

**A40.** Plan A: Ruling: an exceptions-only calendar (empty week) is refused by clean_calendar — such a calendar breaks any plan with more work than its exception hours and the system default is copied into every new plan — cost if wrong: a bounded-window calendar can't be defined purely by exceptions

**A41.** Plan A: Ruling: link_ids in link_to_outline/bad_summary_link errors may name a link added in the failing (rolled-back) batch — consistent with the existing summary case; client shows it — cost if wrong: a 'remove link' affordance points at a link that doesn't exist

## Plan B: views, progress, reminders, import and export, and more

Source: `plan-b-ledger.md`

**B1.** Ruling B1: `Selection` (and `moveActive`) live in `portal/src/lib/plans/selection.ts`, created in B5 with the full shape B6 describes; B6 extends behavior only — B5 consumes a type B6 would otherwise define — cost if wrong: none.

**B2.** Ruling B2: B10 also modifies `PlanToolbar.tsx` (0–100% buttons, Mark on Track) and `PlanBoard`-free paths to route through `useCompletion` — the plan's file list omitted it — cost if wrong: none.

**B3.** Ruling B3: paste that creates rows with Predecessors/Resource Names values runs two batches (adds first, then updates keyed by returned temp_ids), undone as two undo entries grouped under one label — the API can't reference same-batch temp ids — cost if wrong: undoing a paste takes two steps unless grouped.

**B4.** Ruling B4: B1's `PLAN_ERRORS` covers every code the Plan A API can return (read from the API source), not just the plan's list — cost if wrong: generic messages for missed codes.

**B5.** Task 1: Ruling: keep errors.test.ts scanning api/src for error codes — it keeps PLAN_ERRORS in sync with the API (Ruling B4), same cross-tree coupling as the vectors files — cost if wrong: a portal test fails when the API adds a code (intended)

**B6.** Task 2: Ruling: PlanController.apply calls are serialized through one queue — each batch sends the version returned by the previous one — two quick edits must never collide into a self-inflicted 409 plan_changed that reloads and clears undo — cost if wrong: none expected

**B7.** Task 2: Ruling: UndoStack entries hold an ordered list of inverse batches and apply(…, {joinUndo: true}) folds a batch into the top entry, so Ruling B3's two-batch paste undoes in one step (later batch's inverse posts first) — cost if wrong: none expected

**B8.** Task 2: Ruling: writes queued behind a plan_changed conflict are dropped, not posted — they were composed against the stale plan (Review Focus 2) — cost if wrong: an edit typed in the same instant as someone else's change must be retyped

**B9.** Task 2: Ruling: setEditing becomes owner-keyed (beginEditing(owner) returns a release function; setEditing(on) kept as a default-owner shim) — the sheet editor and an open dialog can edit at once — cost if wrong: none expected

**B10.** Task 2: Ruling: on plan_changed the void writes reject with an error recognizable through isPlanChanged(err); callers close quietly because the toast already explained — cost if wrong: a dialog closes without its change applied (the toast says why)

**B11.** Task 3: Ruling: the API's create_plan defaults owner_id to the creating user's person when no owner is sent (spec: owner defaults to the creator) — small API change folded into Task 3's fix round — cost if wrong: none expected

**B12.** Task 3: Ruling: a creator who fails the staff check gets no owner instead of a 422 — the default is best-effort on a field the user never sent; an explicit owner still 422s — cost if wrong: a plan made by a non-staff role holder starts ownerless

**B13.** Task 4: Ruling: calendar exceptions use the real {date, name, hours} shape, not the brief's date/start/end ranges — the API is the authority — cost if wrong: none

**B14.** Task 4: Ruling: a link detour runs above the predecessor row when the successor row is above it (spec says "below") — a downward detour would cross the successor's own row — cost if wrong: a detour shape differs from MS Project's in that case

**B15.** Task 4: Ruling: fitZoom compares the unpadded project span to the pane width — counting four bottom-tier units of padding makes coarse zooms balloon (a 2-month plan fit to quarters in 1,000px) — cost if wrong: the fitted chart may scroll a little to reach the padding

**B16.** Task 4: Ruling: fitZoom compares the raw span (finish − start) × px/day against widthPx − margin (margin = 2 × link stub + milestone half-width); the lead-in padding is not counted; Task 8 scrolls to xOf(projectStart) − margin/2 when it applies a fit — cost if wrong: a fitted chart opens scrolled to the project start, padding off-screen left

**B17.** Task 4: Ruling: a back-to-back FS link (successor edge within the stub) turns at min(x + stub, edge) and drops straight onto the successor — MS Project's look, no S-detour for zero-lag handoffs — cost if wrong: departs from the brief's literal stub wording

**B18.** Task 4: Ruling: FF/SF forward links use 3 runs where possible; tiers takes an optional [fromX, toX] window; linkPath returns '' on non-finite input — cost if wrong: none

**B19.** Task 5: Ruling: variance and created_at come from the API (PlanTaskOut gains start_variance_minutes, finish_variance_minutes via the plan calendar's work_between, and created_at) — the portal never computes schedule values — cost if wrong: none expected

**B20.** Task 6: Ruling: the blank new-task row needs add + change + unlocked — the ops route requires change — cost if wrong: none

**B21.** Task 6: Ruling: a note containing a line break doesn't open in the cell (multi-line notes are edited in Task Information, Task 10) — an in-cell edit would silently drop the breaks — cost if wrong: until Task 10, a multi-line note can't be edited

**B22.** Task 6: Ruling: select editors commit and move down on Enter like every other editor — cost if wrong: none

**B23.** Task 7: Ruling: a two-batch paste runs inside one queue job — usePlan gains applyThen(ops, label, then: (result) => Op[] | null) so no other write can land between the batches and the second always joins the paste's own undo entry; a confirm/blocked/error on either batch is reported as the paste's outcome ("Rows were added, but … couldn't be set: reason — Undo removes the paste"); completing ops move into the last batch so "Complete anyway" resends that batch with its join — cost if wrong: none expected

**B24.** Task 7: Ruling: a copy is a task copy (internal paste re-creates tasks) only when rows were picked by their row numbers or the active column is ID or Task Name; a copy from any other single cell copies that cell's text and clears the internal copy, so ⌘C on a Duration then ⌘V on another Duration sets the value like Excel — cost if wrong: copying a whole task needs a row-number or name click first

**B25.** Task 7: Ruling: pasted rows past the end that are entirely blank are skipped; a Resource Names cell first matches whole names (so "Acme, Inc." works) before splitting on , and ;; cells dropped because their column is read-only or off-screen get one toast with the count; the copy listener leaves ordinary text selections alone — cost if wrong: none

**B26.** Task 8: Ruling: a link draws when at least one end is in the rendered rows ± overscan, the far end placed by its row index (a link to an off-screen task runs off the edge, as in MS Project) — carry-forward 2 was too strict — cost if wrong: slightly more paths per frame

**B27.** Task 8: Ruling: pln-link-path keeps its name (global-constraints names it; the enforced guardrail word-bounds th/td/tr) — cost if wrong: none

**B28.** Task 8: Ruling: non-passive wheel listeners on the panes stay (needed for sideways swipes) — cost if wrong: wheel handling runs on the main thread

**B29.** Task 9: Ruling (pending review): resize computes the new duration in working time on the portal (a portal work_between) because a finish on an auto task means FNET in the API — keep it only with shared API/portal test vectors (api/tests/fixtures/plans/work_between.json read by both sides) — cost if wrong: portal and API disagree on a resized duration

**B30.** Task 9: Ruling (pending review): dragging a task that has an actual start is refused with a toast ("This task has started — change its Actual Start instead.") — a drag that only adds an SNET the engine then ignores looks broken — cost if wrong: started tasks can't be dragged

**B31.** Task 9: Ruling: R1 kept — portal workMinutes stays (the live tooltip needs it) with shared vectors api/tests/fixtures/plans/work_between.json read by pytest and vitest

**B32.** Task 9: Ruling: a drag released outside the window commits (pointer capture delivers the pointerup) — letting go commits, Esc cancels, as in MS Project — cost if wrong: a drag dropped off-window lands where it was let go

**B33.** Task 9: Ruling: at whole-day snaps a move snaps the delta, not the absolute time, so the task keeps its clock time — cost if wrong: none

**B34.** Task 10: Ruling: PlanOut gains system_settings (the inherited system values for 'Use system default (<value>)') and ResourceOut gains is_staff (owner picker) — small API change in its own commit — cost if wrong: none expected

**B35.** Task 9: Ruling: snap the drag delta at every zoom (from + snapMs(moved)), not only whole-day snaps — a drop at the origin must never send a change — cost if wrong: none

**B36.** Task 10b: Ruling: added as Task 10b (brief task-10b-brief.md), run after Task 10 and before Task 11 so the final live pass covers it — cost if wrong: none

**B37.** Task 10b: Ruling: tips use the house Tip component (label + keycaps + note) plus a new optional desc line with a one-sentence description per command, all copy in one table — cost if wrong: none

**B38.** Task 10b: Ruling: Gantt layout Beside (default) / Below / Hidden as a Display-group segmented control, remembered per browser (plans.layout.v1, not per plan — it's about the monitor); Below = full-width sheet over full-width chart, vertical scroll synced, task names drawn on bars; Hidden disables chart-only commands with a note; no automatic switching by width (no invented breakpoint) — cost if wrong: people on narrow screens pick Below once

**B39.** Task 10c: Ruling: task colors as Task 10c (brief task-10c-brief.md) after 10b, before Task 11 — optional #rrggbb per task, house palette + ColorWheel, cosmetic (progress-only set, so allowed while locked), critical red wins with a color stripe — cost if wrong: colors can change on a locked plan

**B40.** Plan C: Ruling: Task 10 Print is replaced by a server-rendered Project plan PDF on the report framework (table pages, then Gantt pages with names on each page, tiled for wide ranges) — details in plan-c-carry.md — cost if wrong: no browser print of the live view

**B41.** Task 10b: Ruling: the Gantt layout control becomes one compact icon button opening a checkmarked menu (Beside / Below / Hidden) instead of a 3-option segmented, so the toolbar stays on one line at 1512 with the nav expanded — cost if wrong: one extra click to switch layout

**B42.** Task 10b: Ruling (fix now): a toolbar command with nothing selected must not select row 1 or scroll the sheet (focusing the sheet keeps the scroll position and selects nothing); Beside↔Below keeps the chart's sideways scroll; More's accessible name is 'More' (▾ aria-hidden) — cost if wrong: none

**B43.** Task 10b: Ruling: Below's cramped panes outside full screen are handled with copy — the Below option says full screen gives it the most room — not by resizing the view — cost if wrong: Below without full screen shows few rows on short screens

**B44.** Task 10b: Ruling: fix both in round 2 — wrap name+caret in one span; RowActionsMenu gets the standard menu-button keyboard pattern by default (keyboard-opened menu focuses the checked or first item; ArrowUp/Down, Home/End, Enter/Space pick, Escape closes and returns focus, Tab closes) — it helps all ~40 callers — cost if wrong: a caller that relied on focus staying on the trigger after a keyboard open

**B45.** Task 10c: Ruling: the picker uses the portal's existing PRESET_COLORS (the palette ColorWheel already uses), not a copy of the API's unnamed 12-color initiative palette — one palette — cost if wrong: seven presets plus Custom

**B46.** Toolbar: Ruling: when the toolbar can't fit one line (classic scrollbars, narrow windows) it wraps whole groups to a second line — the designed fallback, no overflow menu — cost if wrong: a second toolbar line on some setups

**B47.** Flakes: Ruling: raise Testing Library's asyncUtilTimeout to 3000 ms in the portal's vitest setup and fix the sync-query-after-findByRole patterns in the plans tests — the flakes are load-sensitive waits, not product bugs — cost if wrong: a truly failing wait takes 3 s to report

**B48.** Task 11: Ruling: a filter applies when picked, as in MS Project — a task you edit or add stays shown until the filter changes — cost if wrong: an edited task that no longer matches stays on screen until the filter is re-picked

**B49.** Task 11: Ruling: Late and Due This Week compare against the status date, or now when there isn't one (the spec's rule) — cost if wrong: none

**B50.** Task 11: Ruling: while grouped, outline-changing commands are off (links, blank row, Insert, Indent, Outdent, row-adding pastes) with the note "Turn off Group by to change the outline" — a grouped view has no single outline to edit — cost if wrong: one extra click to ungroup before restructuring

**B51.** Task 11: Ruling: the Group by option is labeled "Resource" (MS Project's word), and filter names use MS Project's title case — cost if wrong: none

**B52.** Task 11: Ruling: while grouped, a multi-row cell paste fills the visible task rows downward from the active row (skipping a task already filled), so it lands where the user sees it — cost if wrong: none

**B53.** Task 11: Ruling: while grouped, Link / Unlink and the link-drag dot are off too, with the grouped note — link lines are hidden then, so a link made there would be invisible — cost if wrong: one click to ungroup before linking

**B54.** Task 11: Ruling: the filter count counts leaf tasks in both grouped and ungrouped views — cost if wrong: summaries aren't counted

**B55.** Task 11: Ruling: the Late filter reads task.status === 'late' (already computed against the status date or now) instead of re-implementing the API rule — cost if wrong: none

**B56.** Task 11: Ruling: while grouped, links typed into the Predecessors column or Task Information still apply — those edits name the task explicitly, unlike Link Tasks on a selection — cost if wrong: a link made that way isn't drawn until Group by is off

**B57.** Plan B: Ruling: build the ID-cell drag-reorder now in Plan B (one move_tasks batch, subtree moves, off while grouped/locked/read-only) — it's the spec'd way to move a task and Jimmy's core pain is moves that lose dependencies — cost if wrong: none

**B58.** Plan B: Ruling: Cut marks rows (dashed, Excel style) and deletes nothing; Paste of a pending cut in the same plan is one move_tasks batch that keeps ids, links, progress and baseline; Esc / new copy / reload cancels; a cut pasted into another plan pastes copies — cost if wrong: an MS Project user expecting cut rows to vanish at once sees them marked until they paste

**B59.** Plan B: Ruling: M1–M7 and the withPlan nit all fixed now as the review proposes; the review's other deferred-minor 'leave' verdicts accepted

**B60.** Plan B: Ruling: accept the fix's calls — 'Only summary tasks match' wording; a cut pasted into another plan ends the cut; any plan reload (incl. Update Project read-back) ends a pending cut; a locked-plan drag shows the lock toast; no drop line where a drop changes nothing; undo labels 'Move Row(s)'; no ID-drag tip — cost if wrong: copy tweaks only

**B61.** Plan B: Ruling (residual adjudication): fix the Important now — a drag must survive its pressed row unmounting — load-bearing for large plans — cost if wrong: none

**B62.** Plan B: Ruling: Cut then Paste onto the cut rows themselves clears the cut marks and sends nothing (Excel parity); a release outside the sheet scroller's box cancels like Esc (the edge auto-scroll band sits inside the box) — cost if wrong: a drop just outside the sheet edge cancels instead of landing

**B63.** Plan B: Ruling: the loads-counter nit is left (a stale cut can't land: move_tasks is version-checked) — cost if wrong: a pending cut can survive leaving and returning to the tab

**B64.** Plan B: Ruling: in Beside the drag's 'box' is the shared scroller, so a release over the chart's rows drops at that row's gap — cost if wrong: none

## Plan C: extras (calendar, board, templates, MS Project and Excel import, PDF export, Timeline page, final fixes)

Source: `progress.md`

**C1.** Ruling: T7's ParsedTask gains `color: str | None = None` (MSPDI never sets it) so T8's Color column flows through the shared importer — cost if wrong: none

**C2.** Task 1: Ruling: the AWAITING_SENDER set in test_notification_kinds stays until Task 2 adds the notify() calls, and Task 2 deletes it — cost if wrong: none

**C3.** Task 1: Ruling (carry to Task 2): the sweep and assignment notices check the person's category choice themselves before notify() — notify() only honors 'off' for email=True kinds, and the spec says Off → nothing — cost if wrong: none

**C4.** Task 1: Ruling: fix in Task 1's fix round — the /me 'Email from' cell for Project plans must not say 'No group — inbox only' (plan mail goes to the person directly), and groups can't subscribe to Project plans (its kinds don't use group email, so the option would promise mail that never comes) — cost if wrong: none

**C5.** Task 1: Ruling: plan_assigned lists every assigned task with no cap — no invented limit — cost if wrong: a very large assignment makes a long email

**C6.** Task 1: Ruling: the /me row for Project plans shows 'Sent to your contact email' (a direct-delivery category flag, '—' when the choice isn't email) and the group picker hides direct categories (render-only filter; the API and save path stay permissive) — cost if wrong: copy tweak

**C7.** Task 1: Ruling: drop the unrequested 'Reminders stop once the task is marked complete.' line from plan_reminder (reader-facing copy nobody asked for); plan_overdue_digest takes assignees as a list only — cost if wrong: none

**C8.** Task 2: Ruling: email_assignees off turns off every direct plan email including the owner's digest email (the owner keeps the inbox row) — the spec's Delivery bullet says it turns 'the direct email' off — cost if wrong: an owner who wanted digest email loses it on a plan with assignee email off

**C9.** Task 2: Ruling: accept — one digest per plan per local day; a stage not sent by the end of its day is superseded by the next; inbox titles copy the email subject; the year shows only when not the current year — cost if wrong: copy tweaks

**C10.** Task 2: Ruling: fix the digest drift with a send-time gate (no digest before the plan's send time) plus a midnight-sweep test — cost if wrong: none

**C11.** Task 2: Ruling: daily overdue:<day> stages send only on <day> (the same superseded-at-end-of-day rule as d<N>/due) — cost if wrong: a reopened task's first overdue reminder waits for the send time

**C12.** Task 2: Ruling: assignment notices run in a savepoint and a failure is logged, never failing the user's schedule edit — edits matter more than notices — cost if wrong: a failed notice is dropped (logged)

**C13.** Task 2: Ruling: reminders are de-duplicated by the due DAY, not the exact due_at, so a time-only deadline change or a recalc nudging a finish time doesn't re-send the same reminder; spec amended — cost if wrong: moving a deadline to another time the same day doesn't re-send

**C14.** Task 2: Ruling: check the log before loading resources (skip resources_of when every candidate is logged); remove the unreachable notify-None branch; load_contact once if trivial — cost if wrong: none

**C15.** Task 2: Ruling: accept the own-day rule for d<N> stages too (a missed d<N> isn't sent late, so no 'Due today' at 01:00 followed by another at 08:00) and the process-wide notice-failure log flag — cost if wrong: a d<N> missed during downtime is skipped

**C16.** Task 3: Ruling: offsets picker offers the API's 1–365 range — cost if wrong: none

**C17.** Task 3: Ruling: fix Minors 1, 2, 4 and check narrow widths (6) in a small round — a hint by Save naming the first invalid setting with a link that scrolls to it; cap the settings rows' width so controls sit near their labels; comment the blank-slack placeholder; check 1280/1024 — Jimmy notices layout — cost if wrong: none

**C18.** Task 3: Ruling: no unsaved-changes guard (no Settings tab has one) and no version check on the system settings PUT (admin-only, rare edits) — cost if wrong: a tab click drops a draft; two admins saving reminders at once, last wins

**C19.** Task 4: Ruling: the toolbar must stay on one line at 1512 with the nav open (Plan B's rule) — the view switcher becomes one compact dropdown showing the current view ("Gantt ▾") with checked items, like 10b's layout control — cost if wrong: one extra click to switch views

**C20.** Task 4: Ruling: milestones are never folded into '+N more' in the Calendar (they sort first in a day's lanes); Escape that closes a calendar week popover doesn't also leave full screen — cost if wrong: none

**C21.** Task 4: Ruling: accept — boardCards returns {task, path}; Undo/Redo/Task Information/Find/Help keys work in Calendar and Board; collapse doesn't hide tasks in Calendar/Board; touch moves via the card menu — cost if wrong: none

**C22.** Task 4: Ruling: fix all four Importants; make the strip compact so the view keeps its floor; outside the Gantt the selection settles to drawn tasks and Shift+F2 prefers the focused bar/card — cost if wrong: none

**C23.** Task 4: Ruling (Minors): one finish-day rule (lastDay) for every Calendar/Board/strip label; strip ends labeled with the band's own dates; strip marks at least 24px; card drag uses a custom data type; milestones offer only Not started/Complete on the Board; switching back to the Gantt reveals a task under a collapsed summary; Board scrolls its column, not the page; '+N more' gets a matching name, aria-expanded and kept focus — cost if wrong: none

**C24.** Task 4: Ruling: accept Full screen as an icon-only button (keeps its Tip, Esc keycap and name) and the strip as the view area's top band (sheet + chart get the rest; the page never scrolls) — cost if wrong: Full screen is less discoverable

**C25.** Task 4: Ruling: fix all three in round 2 (firstRow maps a drawn task to itself; settle also on selection changes from deep link/Go to task; Escape ignores editable fields like PlanTab's) — queued until Task 5's implementer finishes (one implementer in the worktree at a time) — cost if wrong: none

**C26.** Task 5: Ruling: the milestone day follows the plan tab's finish-day rule (a 00:00 finish counts as the previous day unless the task is zero-length), computed by the API as a day field so portal and API agree — cost if wrong: none

**C27.** Task 5: Ruling: the Milestones toggle hides diamonds and chips only; the hover card's Plan line stays — the toggle is literally about milestones — cost if wrong: plan viewers who turn it off still see the Plan line

**C28.** Task 5: Ruling: accept — an initiative row stays when one of its milestones is in range; same-day diamonds sit 12px apart; schemas in plans/schemas.py, engine.rollup_percent, the bad_range sentence, PointerHoverCard

**C29.** Task 5: Ruling: fix the pre-existing Timeline row-label styling (browser-default blue links, subtitle running into the name) on this branch as its own commit — it's the page this task touches — cost if wrong: an unrelated fix rides this branch

**C30.** Task 5: Ruling (fix round with the two earlier rulings): on the all-initiatives calendar a milestone chip past the 4-lane cap folds into that day's '+N more' (the page's lane cap stays); _visible_plan_ids skips archived initiatives; diamonds within ~14px on a row cluster into one at coarse zoom (hover lists them); the 'Scheduled outside this range' text doesn't sit under diamonds — cost if wrong: a milestone on a crowded day needs a click on '+N more'

**C31.** Task 5: Ruling: accept day on next too, cluster click opens the leftmost milestone, long row labels ellipsize like the Initiatives list — cost if wrong: none

**C32.** Task 6: Ruling: a template keeps the working week and units but not dated calendar exceptions — holidays belong to dates, not to the project; a plan made from a template takes the system default calendar's exceptions — cost if wrong: a source plan's one-off nonworking days aren't carried over

**C33.** Task 6: Ruling: accept — async instantiate; Templates… shows with change or delete and every view-holder sees all templates (company-owned, like report templates); name/description limits copy the report definitions' 120/1,000; the template picker is optional in Blank plan — cost if wrong: none

**C34.** Task 6: Ruling: fix round = the calendar-exceptions ruling + all Minors: _rows requires each parent_key to name an earlier task and rejects unknown link types and duplicate pairs (and recalc ValueError → 422 bad_template); instantiate caps tasks and links at the existing MAX_RESTORE_ROWS; From a template disables Create until templates load and offers Try again; the Save dialog says notes are kept; the missing tests (missing parent, elapsed lag, out-of-scope initiative, a literal no-delete tip) — cost if wrong: none

**C35.** Task 7: Ruling: accept — apply runs as one signed restore op through ops.run_batch (no assignment notices on import, imported progress skips completion rules: an import reflects the file); fill mode takes the file's project start and status date; preview/apply take actor and a savepointed new plan; top-level file problems; resources exported by name only; XML nesting depth 32 and 1,440 working times/day are parser bounds, not policy; color, timeline flag, baseline, summary mode don't round-trip — cost if wrong: baselines are lost through MS Project

**C36.** Task 7: Ruling: both fixed in the fix round — a running exception budget checked before allocating (DayType 0 days and Exceptions both); import into an existing plan requires project_plans:change (new-plan import stays add) — cost if wrong: an add-only user can no longer import into an existing plan

**C37.** Task 7: Ruling: a plan's outline is capped at 10 levels (MAX_OUTLINE_LEVEL in plans/limits.py), copying Microsoft's own limit for Project for the web and Project Operations (10 hierarchy levels; desktop Project documents 65,535) — imports clamp deeper tasks with a per-row problem and indent refuses past it — not a number I invented, but Jimmy should confirm it — cost if wrong: a desktop MS Project file nested deeper than 10 levels imports flattened at level 10

**C38.** Task 7: Ruling: fix round = both security findings + moved_days in one sweep (prefix sums) + parse in a worker thread + optional base_version on apply (409 plan_changed) + level-0 tasks become level 1 with a problem (and the UID 0 link message) + the test gaps; DaysPerMonth rounding noted in docs — cost if wrong: none

**C39.** Task 7: Ruling: accept — a plan already deeper than 10 stays editable and undo isn't capped (the cap only stops new structure) — cost if wrong: none

**C40.** Task 8: Ruling: accept the streaming xlsx reader instead of openpyxl's loader (openpyxl cost 1.4–2.7 GB on 25–35 KB zip bombs) — subject to review as a hand-written parser — cost if wrong: a reader to maintain

**C41.** Task 8: Ruling (fix round): fix Task 7's MSPDI iterparse memory leak the same way (with a memory test); a file's Start becomes SNET only when later than where the task would schedule anyway, and 'Start ignored — set by links' only when the scheduled start differs from the file's; a date with no time uses the plan calendar's default start/finish times (fill mode: the system default calendar's) — cost if wrong: none

**C42.** Task 8: Ruling: the unpacked-size cap reuses the existing 20 MB import limit (Jimmy to confirm); accept Mode read-back, header-row detection, .xls/.mpp messages, comma-split resource names, no Milestone column round trip — cost if wrong: a notes-heavy export over 20 MB unpacked can't be re-imported

**C43.** Task 8: Ruling: fix all — refuse members other than stored/deflate (bad_file) plus a bytes-actually-read budget across the package; set-based dedupe, rpartition instead of the regex, bounded split (count commas before splitting), cut cell text at Excel's 32,767-char limit; unknown columns → 422 bad_field (indicators skipped); ;/tab CSV says comma-separated; error cells are problems; the Start rule counts only surviving links; export header 'Task Mode' (MS Project's name) — plus the earlier rulings (MSPDI leak, SNET/Start noise, plan default times) — cost if wrong: none

**C44.** Task 8: Ruling: accept — one huge-attribute element still costs ~446 MB within the 20 MB budget (expat builds the dict; the review called it expected overhead); a sheet drops a linked task's constraint only when the links already place it there and the column isn't exported (Excel carries what's in the view); ops.run_batch gains an optional settle hook; a new plan from a file uses the system calendar's default times — cost if wrong: one pathological upload can still spike memory by ~0.4 GB

**C45.** Task 8: Ruling (round 2): cut at both number fallbacks; a task under a linked summary counts as linked (MS Project: the summary's link drives it); a milestone's day-alone Finish takes its resolved Start; 00:00 is a day alone only when the cell's number format has no time part; charge each decoded shared-string reference to the package budget so a workbook yields no more text than a CSV at the cap; docstring warning on ops.run_batch settle — cost if wrong: none

**C46.** Task 8: Ruling: accept — an all-bad-predecessors 20 MB file costs ~8 s CPU (parity with CSV at the cap; lower needs a new limit); date-only export formats when a plan hides times (a true 00:00 re-imports at default time) — cost if wrong: an 8 s worker-thread parse for a pathological file

**C47.** Task 9: Ruling: accept — Content-Disposition added to the API's CORS expose_headers (cross-origin downloads can't read the name otherwise); Export is a titled group in More (RowActionsMenu gains a group option, no flyouts); Fill is the default on an empty plan — cost if wrong: none

**C48.** Task 10: Ruling (revises the plan-c-carry 'no new cap' ruling): (1) a custom range is clamped to the plan's own span, and a range wholly outside it is 422; (2) the printed span may be at most MAX_YEARS (10, the plan feature's existing duration bound) — longer is 422 with a clear message, checked in validate_run_options and again in build; (3) HTML building and the PDF render run in a child process killed at RUN_TIMEOUT_SECONDS (or, if that proves impractical, render_html in to_thread plus the existing threaded render, noted as a concern); (4) the geometry loops are sized arithmetically before they run — no new page cap — cost if wrong: a plan spanning more than 10 years can't be printed in one PDF

**C49.** Task 10: Ruling: accept — 20 mm bottom margin for the footer; the PDF's own scale; Weeks shading; Hours zoom not offered (opens on Fit); PDFs stay on the run, not Files; table estimate counts one-line rows; ~1–2 s child start; custom range only narrows; 0110 downgrade deletes project_plan runs first — cost if wrong: none

**C50.** Task 10: Ruling (fix round): PDF… shows disabled with the note 'Needs access to Reports' for viewers without reports:add, instead of a toast after the click (house disabled-command rule) — cost if wrong: none

**C51.** Task 10: Ruling (fix round): drop the pre-clamp 10-year check so a wide custom range clamps instead of 422; catch EOFError so a dead child is 'renderer stopped'; the child sets alarm(RUN_TIMEOUT_SECONDS) as its own deadline (no RLIMIT_AS — that would need a new memory number); start the child off the event loop; raise the WeasyPrint floor to the version the code needs and pass url_fetcher only when given; remove the unused render_pdf alias; tests for the 0110 downgrade run deletion, milestone link ends and a dead child; Gantt labels 7 pt in a darker gray for print; PDF… disabled with 'Needs access to Reports' for users without reports:add — cost if wrong: none

**C52.** Task 10: Ruling: the scoped re-review of fix round 1 folds into Plan C's final whole-branch review (it names the nine items) — the diff is small and the final review reads it anyway — cost if wrong: none

**C53.** Plan C: Ruling: run the final whole-branch review and its fix dispatch BEFORE Task 11 (final verification), so the full suites and the live e2e pass verify the fixed branch — cost if wrong: none

**C54.** Plan C: Ruling: fix I-1 and Minors M-1, M-2, M-3, M-4, M-5, M-6, M-7, plus the deferred 'fix now' verdicts (Timeline typography own commit, template-load copy, dropped-summary-link test, import dialog keeps its previewed mode); leave the rest as the review recommends; check the Below-splitter carry live at Task 11 before coding — cost if wrong: none

**C55.** Plan C: Ruling: accept the curly apostrophe (house style in plans code), no mode line for a new plan, the real-dates bar moved down on noted rows, the sweep filter <= for midnight finishes, blank shared strings charged nothing

**C56.** Plan C: Ruling (residual adjudication): the M-4 guard and the review's small out-of-scope items fold into Task 11's first step — thread_time bound; _blank tests decoded == '' instead of strip(); Plan A's < 0.1 s bounds (test_plans_predecessors.py:306/312, test_plans_durations.py:227) become thread_time or generous bounds; worker test sleeps → _until; Timeline bar labels + 'Unscheduled' divider get list tokens; .itl-scroll gets the house themed slim scrollbar — cost if wrong: none

**C57.** Task 11: Ruling: the controller runs the full API suite in the background after Task 11's fixes land (1h45m exceeds a foreground tool call), then the label-image and system-heartbeat files serially; the Task 11 implementer runs the portal suite, build and the live e2e; the physical ⌘C/⌘V check in real Chrome and Safari is Jimmy's (agent keystrokes are synthetic) — cost if wrong: none

**C58.** Task 11: Ruling: summary tasks get no finish-based reminders — with use_finish_without_deadline, a summary without its own deadline is skipped by the sweep and the owner digest (its children are reminded on their own finishes); a summary with a deadline is reminded as today — why: a summary's finish is its last child's, so it double-counts (NAP11's 'Planning & prep' in the digest) — cost if wrong: a summary's own finish never reminds; setting a deadline on it restores that

**C59.** Task 11: Ruling: the PDF Gantt's tick header runs each tile's full drawn width (tiers() with the tile window); plan_span, print range and the page estimate stay as they are (the portal estimates from the same span); a deadline past the printed range draws nothing — cost if wrong: none

**C60.** Task 11: Ruling: leave the milestone date label that a link elbow can cross — a white backing would hide link starts instead — cost if wrong: a crossed digit in rare layouts

**C61.** Task 11: Ruling: .portal-main's default light scrollbar is shared shell chrome, the same on main — not this branch; proposed as its own session — cost if wrong: none (it stays as on main until that lands)

**C62.** Task 11: Ruling: the clone keeps the 111 test-account auth_sessions rows and the last-login time (an FK from a pre-snapshot session blocks the delete; dev clone only) — cost if wrong: none

**C63.** Task 11: Ruling: fold all four review minors into fix round 1 (sent to a7dbdfb120540d8f1) — cheap; the slack bound is a load-flake risk in the full suite — cost if wrong: none

**C64.** Task 11: Ruling: accept 'their own Deadline' capitalized (matches the field names in the sentence it joins), a deadline before the chart's left edge also draws nothing (symmetry), the two-line excel.py pointer, and 3 more test-account auth_sessions rows on the clone — cost if wrong: one-word copy change

**C65.** Task 11: Ruling (residual adjudication): park both minors — the every-tile property holds by construction (the reviewer swept 400 tier-tiles over letter/A4, 5 zooms, 0–400 days) and the summary rule is pinned red-to-green plus a SQL read — cost if wrong: a later change that rebuilds a tile's timescale from the print scale is only caught for one-tile charts

**C66.** Ruling: the label-image full-suite failures are pre-existing on main (main's wiki PDF test imports WeasyPrint at collection) — not fixed on this branch; proposed as its own session (make the label tests and image prep independent of PIL's global flag) — cost if wrong: main and this branch's full API suite keep 3 known label-image failures until that lands

## Not numbered: lines that only point at a ruling

These lines contain the word "Ruling" but are table rows that point at a ruling written further down; they do not make a decision themselves. Listed here so nothing is lost.

- `plan-a-rulings.md` line 1: | T9 ↔ T11 | T9 rejects `percent_complete` on a summary (`summary_field`); T11 routes `percent_complete`/`set_percent` through completion | ambiguity → Ruling 1 |

- `plan-a-rulings.md` line 2: | T8 | Files names `test_plans_floating.py`, Step 1 bullet says `test_floating.py` | Ruling 2 |

- `plan-a-rulings.md` line 3: | T8 | timezone fallback "when initiative_zone yields UTC because no site zone is known" can't distinguish a site explicitly in UTC | Ruling 3 |

- `plan-a-rulings.md` line 4: | Global | full API suite takes >1 h (baseline run still going) | Ruling 4 |

- `plan-a-rulings.md` line 5: | Global | baseline suite occupies `serversherpa_test_project_plans` | Ruling 5 |

- `plan-b-ledger.md` line 26: | B5 ↔ B6 | PlanSheet props use `Selection`, which B6 defines | conflict → Ruling B1 |

- `plan-b-ledger.md` line 29: | B10 | "every 100% path routes through useCompletion" incl. toolbar 100%, but B10's file list omits PlanToolbar.tsx | gap → Ruling B2 |

- `plan-b-ledger.md` line 30: | B7 paste | new rows + predecessors/resources in one batch impossible (temp ids) | gap → Ruling B3 |

- `plan-b-ledger.md` line 31: | B1 errors | code list incomplete vs Plan A | Ruling B4 |
