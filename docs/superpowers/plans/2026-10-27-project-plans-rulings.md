# Project plans: rulings digest

The decisions the builder made for you while building the project-plans feature, in plain words. Same numbers and order as `2026-10-27-project-plans-rulings-verbatim.md` (next to this file), where the exact original lines are. Each entry ends with what it costs if the call was wrong. "Not stated" means the ledger gave no cost.

## Counts

| Plan | Rulings |
|---|---|
| A: core plan tab (sheet, scheduling engine, links, Gantt) | 41 |
| B: views, progress, reminders, import and export, and more | 64 |
| C: extras (calendar, board, templates, MS Project and Excel import, PDF export, Timeline, final fixes) | 66 |
| M: the merge with Notifications Phases 0-2 | 6 |
| Total | 177 |

## Worth your look

These are the ones most likely to matter to you as a user: a chosen number or limit, a difference from MS Project, something you would notice on screen, or a real cost if wrong.

- **A19**: durations and lags are capped at 10 years of working time.
- **A29**: Update Project never lowers a task's recorded progress.
- **A30**: changing a system scheduling setting recalculates locked plans too, so dates can move with no one editing.
- **B30**: you can't drag a task that has already started; you get a message instead.
- **B38**: the Gantt layout choices (Beside, Below, Hidden) and no automatic switching on narrow screens.
- **B58**: Cut only marks rows (dashed) until you paste; they don't vanish at once as in MS Project.
- **C32**: a template does not carry over holidays or other dated non-working days.
- **C36**: importing into an existing plan now needs the "change" permission, not just "add".
- **C37**: a plan's outline is limited to 10 levels. The builder asks you to confirm this number.
- **C42**: the unpacked-size limit for Excel imports is 20 MB. The builder asks you to confirm this number.
- **C48**: a PDF can print at most 10 years of a plan.
- **C58**: summary tasks no longer get finish-based reminders.
- **M2**: Project plans is a row in the notification switch grid now, so an admin's company default can turn plan notices off for everyone who hasn't chosen.
- **M3**: plan email doesn't wait for a person's quiet hours or days off.

## Plan A: core plan tab

**A1.** On a summary task, setting percent complete to 100 works like "complete" (completion rules apply); any other value is refused, because a summary's percent is calculated from its subtasks. — *if wrong:* a planner can't set 50% on a summary (MS Project also calculates it).

**A2.** The test file for float (slack) rules is named in the project's usual flat test-file style. — *if wrong:* trivial (naming only).

**A3.** A plan's time zone is its initiative site's time zone. If no site zone is known, it uses the system default zone instead of guessing from a UTC setting. — *if wrong:* none beyond a default.

**A4.** While building, each task's tests run only the plan test files and any other files the change touches, not the whole API suite (it takes over an hour). The full suite runs at Task 12 and in the final review. — *if wrong:* a regression in an unrelated area is caught at Task 12 instead of earlier.

**A5.** Builders and reviewers each use their own test database, and a third is kept for full-suite runs, because parallel runs on one database wipe each other's data. — *if wrong:* none.

**A6.** The text pattern for durations and predecessors is treated as a hint: input is trimmed, trailing blanks are dropped, and it is capped at 64 characters, accepting exactly the same inputs. This keeps matching fast on untrusted text. — *if wrong:* none (the accepted inputs don't change).

**A7.** "24:00" is allowed as the end of a working-hours interval (midnight at the day's end). Move weekends run 24 hours, and 23:59 would lose a minute at each midnight. — *if wrong:* a slightly looser check on hours.

**A8.** The calendar's default end time still rejects 24:00, since it is a same-day time used when someone types a finish as a date only. — *if wrong:* a date-only finish on a 24-hour calendar lands at the configured end time, not midnight.

**A9.** A manual task with both start and finish keeps its span. Entering an actual start shifts the finish by that span, and the duration shows that span. The engine never moves manual dates. — *if wrong:* a manual task whose duration field disagrees with its dates shows the dates, not the duration.

**A10.** When indenting or moving turns a task into a summary, any constraint other than As Soon As Possible or Start No Earlier Than resets to As Soon As Possible, with a notice. A Finish-to-Finish or Start-to-Finish link into it is not dropped; the change fails with an error naming the link. — *if wrong:* one extra step for the planner.

**A11.** A test the brief called for (a "Finish No Later Than" date before project start, no links, slack −480) was wrong: with no link the engine moves the task, so slack is 0. The test now uses a linked case, and another pins the no-link behavior. — *if wrong:* if MS Project instead clamps to the project start, an unlinked deadline before the start would show 0 slack rather than negative.

**A12.** In the late-dates pass, a summary takes its subtasks' late starts and rolls them up. Limits (a summary deadline, links leaving it) are passed down to subtasks. The brief's wording can't work in that order. — *if wrong:* slack on summary-linked tasks slightly off.

**A13.** For Start-to-Start and Start-to-Finish links out of a summary, each subtask's late start keeps its offset from the summary start. The strict rule marked ordered subtasks critical on feasible schedules. (A16 replaces this.) — *if wrong:* slightly more slack shown on subtasks of a summary with such links out.

**A14.** Parked: a deadline before the only working day of a degenerate calendar (no regular working week) raises an error in the late-dates pass. The early-dates pass has the same limit. Real, and deferred. — *if wrong:* not stated.

**A15.** Parked: when two separate dependency loops are reported together, one member of a loop can be hidden. Cosmetic; the error still names a member of each loop. — *if wrong:* not stated.

**A16.** Replaces A13. Start-to-Start and Start-to-Finish links out of a summary limit only the subtasks that start on the summary's start date (all of them on a tie). Finish-based links are unchanged. Other subtasks can slip freely. — *if wrong:* on ties both starting subtasks show critical though either alone could slip.

**A17.** Refines A3: the plan time zone is the site's zone, falling back to the system default zone, then UTC. — *if wrong:* not stated.

**A18.** A locked plan can still be deleted. Deleting needs the delete permission, and the screen makes you type the initiative name. — *if wrong:* a locked plan can be deleted by someone who holds the delete permission.

**A19.** Durations and lags over 10 years of working time are refused with a "bad duration" error. The parser had no cap, and absurd values only caused overflow errors. — *if wrong:* a plan longer than 10 years can't be entered.

**A20.** A constraint date typed as a date only takes the calendar's default end time for finish-type constraints and the default start time for start-type ones. A finish typed as a date means the end of that day. — *if wrong:* none.

**A21.** Typing only a Start on a manual task moves the task and keeps its duration (MS Project behavior). — *if wrong:* the finish moves with the start.

**A22.** The task table's parent link is checked at commit time instead of per statement, so any insert or update order inside one batch works. — *if wrong:* a parent loop or missing parent is caught at commit instead of statement time (still inside the batch).

**A23.** Every undo the server hands back is digitally signed. A restore without a valid signature is refused. This closes two security gaps without losing undo of archived assignees or stamps. — *if wrong:* rotating the login secret invalidates undo history in open tabs (clients reload).

**A24.** A signed progress-only undo can be replayed later with no version check. It only rewrites values the server itself recorded, and a version check would break undo after another admin's progress edit. — *if wrong:* an old undo of a % edit can be re-applied by the same client.

**A25.** Restore accepts any person or partner who still exists as an assignee (looser than before). The signature already limits restored assignees to server snapshots, and the strict rule broke undo after an assignee left the initiative. — *if wrong:* the second safety layer is thinner if signing ever breaks.

**A26.** A re-saved Predecessors entry keeps the stored lag when the typed lag shows the same sign and text, including on type-only edits. This prevents silent drift like 160 to 158 minutes. — *if wrong:* a lag typed more precisely than the cell shows is ignored there (the link edit command still sets exact values).

**A27.** Undoing an actual-date edit that moved a manual task counts as a structural change (refused while the plan is locked). Percent edits on manual tasks don't move dates and stay progress-only. — *if wrong:* unlocking is needed to undo such an actual-date edit.

**A28.** Actual-date fills are queued and settled once from the end-of-batch schedule. Mark on Track and Update Project work from one schedule per operation. This keeps pasting fast. — *if wrong:* none expected (fills never move dates).

**A29.** Product call: Update Project never lowers recorded progress (it keeps the higher of current and on-track). Mark on Track still overwrites. A bulk "complete through" should only move progress forward. — *if wrong:* a task recorded ahead of schedule keeps its higher % after Update Project.

**A30.** Saving a system change to "honor constraints" or "critical slack days" recalculates every plan that inherits it, locked plans included, and bumps each plan's version. The spec says plans recalculate on every edit anyway. — *if wrong:* a system setting change can move dates on a locked plan without anyone editing it.

**A31.** Calendar exception (holiday) names use the task-name length limit, reject control characters, and exception lists cap at 20,000 (the existing list cap). Reused technical bounds, not new policy. (A32 drops the length limit.) — *if wrong:* none expected.

**A32.** Calendar exception names get no length cap, because task names have none and inventing a number is policy. — *if wrong:* an admin can store a very long holiday name (admin-only, limited by request size).

**A33.** On a system settings save, a plan whose recalculation fails keeps its dates but still gets a version bump, since the new setting applies to it. — *if wrong:* open tabs reload a plan whose dates didn't move.

**A34.** One fix pass takes: database indexes (added to the unreleased 0110 migration in place; the dev database never ran it), minor items M1 to M4, M7 (MS Project parity), M8, and M10 (a one-line row lock). Each is cheap and closes a visible or data-integrity gap. — *if wrong:* none expected.

**A35.** M5 (slow predecessor and duplicate-link scans on every operation) moves to Plan B's paste task, where the 2,000-row case first exists. — *if wrong:* a large paste takes seconds inside the plan lock until then.

**A36.** M6 (NaN or Infinity in JSON causes a 500 error) already exists on main for every route. It leaves this branch as a separate follow-up on main. — *if wrong:* plan routes other than the plan update and the system settings save answer with a server error (500) instead of a normal refusal (422) to such input.

**A37.** M9 (the system settings save locks too broadly while recalculating plans) is left alone. It is admin-only and rare, about 50 ms per 3,000-task plan. — *if wrong:* a system settings save briefly stalls in-flight plan edits.

**A38.** M10 first-save race (a second simultaneous save gets a database error; nothing is lost) is left alone. It is admin-only and happens once per install. — *if wrong:* one admin sees an error and saves again.

**A39.** The index on plan assignments by partner is carried to Plan C Task 1 (edit migration 0110 while unreleased). — *if wrong:* deleting a partner scans the plan assignments table.

**A40.** A calendar with only exceptions and no working week is refused. It would break any plan with more work than its exception hours, and the system default is copied into every new plan. — *if wrong:* a bounded-window calendar can't be defined purely by exceptions.

**A41.** The link IDs in "link into summary" errors may name a link added in the failing, rolled-back batch. This matches the existing summary case, and the client shows it. — *if wrong:* a "remove link" button points at a link that doesn't exist.

## Plan B: views, progress, reminders, import and export

**B1.** The selection type lives in one shared file created in Task 5 with the full shape Task 6 describes. Task 6 only extends behavior. — *if wrong:* none.

**B2.** Task 10 also changes the toolbar (0 to 100% buttons, Mark on Track) so every 100% path goes through the completion logic. The plan's file list had left it out. — *if wrong:* none.

**B3.** A paste that creates rows with Predecessors or Resource Names runs as two batches (add rows, then set values), undone as two entries grouped under one label. The API can't point at rows created in the same batch. (B7 and B23 later make it one undo step.) — *if wrong:* undoing a paste takes two steps unless grouped.

**B4.** The portal's error-message table covers every error code the Plan A API can return, not just the plan's list. — *if wrong:* generic messages for any missed codes.

**B5.** Keep the test that scans the API source for error codes. It keeps the portal's messages in sync with the API. — *if wrong:* a portal test fails when the API adds a code (intended).

**B6.** Plan edits are sent one at a time through a queue, each carrying the version the last one returned. Two quick edits must never collide into a self-inflicted "plan changed" conflict that reloads and clears undo. — *if wrong:* none expected.

**B7.** Each undo entry holds an ordered list of inverse batches, so the two-batch paste from B3 undoes in one step. — *if wrong:* none expected.

**B8.** Edits queued behind a "plan changed" conflict are dropped, not sent, because they were made against the stale plan. — *if wrong:* an edit typed at the same instant as someone else's change must be retyped.

**B9.** Editing "holds" are keyed by owner, so the sheet editor and an open dialog can edit at once. — *if wrong:* none expected.

**B10.** On a "plan changed" conflict, pending writes fail with a recognizable error, and callers close quietly because the toast already explained. — *if wrong:* a dialog closes without its change applied (the toast says why).

**B11.** Creating a plan with no owner sent makes the creator the owner (the spec's default). Small API change. — *if wrong:* none expected.

**B12.** A creator who isn't staff gets no owner instead of an error, since they never sent the field. An explicit non-staff owner is still refused. — *if wrong:* a plan made by a non-staff role holder starts without an owner.

**B13.** Calendar exceptions use the API's real shape (date, name, hours), not the brief's start/end ranges. The API is the authority. — *if wrong:* none.

**B14.** A link's detour runs above the predecessor row when the successor row is above it (the spec says "below"), since a downward detour would cross the successor's own row. — *if wrong:* a detour shape differs from MS Project's in that case.

**B15.** "Fit" zoom compares the unpadded project span to the pane width, because counting four bottom-tier units of padding makes coarse zooms balloon (a 2-month plan fit to quarters in 1,000px). (B16 refines this.) — *if wrong:* the fitted chart may scroll a little to reach the padding.

**B16.** "Fit" compares the raw span against pane width minus a margin (two link stubs plus a milestone half-width). The lead-in padding isn't counted, and the chart scrolls to the project start minus half the margin. — *if wrong:* a fitted chart opens scrolled to the project start, with the padding off-screen to the left.

**B17.** A back-to-back Finish-to-Start link turns at the earlier of stub or edge and drops straight onto the successor. This is MS Project's look, with no detour for zero-lag handoffs. — *if wrong:* departs from the brief's literal stub wording.

**B18.** Finish-to-Finish and Start-to-Finish forward links use 3 line runs where possible. The scale-drawing code takes an optional window, and the link path returns nothing on invalid input. — *if wrong:* none.

**B19.** Variance and created date come from the API (start and finish variance in minutes, using the plan calendar). The portal never computes schedule values. — *if wrong:* none expected.

**B20.** The blank new-task row needs add and change permission and an unlocked plan, since the edit route requires change. — *if wrong:* none.

**B21.** A note with a line break doesn't open for editing in the cell; multi-line notes are edited in Task Information (Task 10). An in-cell edit would silently drop the breaks. — *if wrong:* until Task 10, a multi-line note can't be edited.

**B22.** Dropdown cell editors commit and move down on Enter like every other editor. — *if wrong:* none.

**B23.** A two-batch paste runs as one queued job, so nothing can land between the batches and the second joins the paste's undo entry. Any confirm, block or error is reported as the paste's outcome ("Rows were added, but … couldn't be set: reason — Undo removes the paste"). — *if wrong:* none expected.

**B24.** A copy counts as a task copy (pasting re-creates tasks) only when rows were picked by row number or the active column is ID or Task Name. Copying any other single cell copies its text, so Duration to Duration works like Excel. — *if wrong:* copying a whole task needs a row-number or name click first.

**B25.** On paste: blank rows past the end are skipped; a Resource Names cell first matches whole names (so "Acme, Inc." works) before splitting on commas and semicolons; cells dropped for read-only or off-screen columns get one toast with the count. — *if wrong:* none.

**B26.** A link draws when at least one end is in the rendered rows. A link to an off-screen task runs off the edge, as in MS Project. The earlier "both ends" rule was too strict. — *if wrong:* slightly more paths drawn per frame.

**B27.** The CSS class for link paths keeps its name, because the global constraints name it and the style check only blocks table-cell tag names. — *if wrong:* none.

**B28.** Non-passive wheel listeners stay on the panes (needed for sideways swipes). — *if wrong:* wheel handling runs on the main thread.

**B29.** Pending review: resizing a bar computes the new duration in working time in the portal, because a finish on an auto task means "Finish No Earlier Than" in the API. Kept only with shared test vectors. — *if wrong:* the portal and API disagree on a resized duration.

**B30.** Pending review: dragging a task that has an actual start is refused with a message: "This task has started — change its Actual Start instead." A drag that only adds a constraint the engine ignores looks broken. — *if wrong:* started tasks can't be dragged.

**B31.** After review: keep the portal's working-minutes calculation (the live tooltip needs it), with shared test vectors read by both the API and portal tests. — *if wrong:* not stated.

**B32.** A drag released outside the window commits. Letting go commits and Esc cancels, as in MS Project. — *if wrong:* a drag dropped off-window lands where it was let go.

**B33.** At whole-day snaps, a move snaps the change, not the absolute time, so the task keeps its clock time. — *if wrong:* none.

**B34.** The plan data gains the inherited system values (for "Use system default (...)") and people gain a staff flag (for the owner picker). Small API change in its own commit. — *if wrong:* none expected.

**B35.** Snap the drag change at every zoom, not only whole-day snaps. A drop at the origin must never send a change. — *if wrong:* none.

**B36.** Your 2026-10-28 requests (hover tips, hide the Gantt) become Task 10b, run after Task 10 and before Task 11 so the final live pass covers it. — *if wrong:* none.

**B37.** Hover tips use the house Tip component (label, keycaps, note) plus a new one-sentence description per command, all copy kept in one table. — *if wrong:* none.

**B38.** Gantt layout is Beside (default), Below or Hidden, remembered per browser, not per plan (it's about the monitor). Below puts the sheet over the chart at full width, with task names on bars. Hidden disables chart-only commands with a note. No automatic switching by width. — *if wrong:* people on narrow screens pick Below once.

**B39.** Task colors added as Task 10c: an optional color per task from the house palette plus color wheel. Cosmetic, so allowed on a locked plan. Critical red wins, with a color stripe. — *if wrong:* colors can change on a locked plan.

**B40.** The Task 10 browser Print is replaced by a server-made Project plan PDF on the report framework (table pages, then Gantt pages with names on each page, tiled for wide ranges). — *if wrong:* no browser print of the live view.

**B41.** The Gantt layout control becomes one compact icon button opening a checked menu (Beside, Below, Hidden), not a 3-option segmented control, so the toolbar stays on one line at 1512 px with the nav expanded. — *if wrong:* one extra click to switch layout.

**B42.** A toolbar command with nothing selected must not select row 1 or scroll the sheet. Switching Beside and Below keeps the chart's sideways scroll. More's accessible name is "More". — *if wrong:* none.

**B43.** Below's cramped panes outside full screen are handled with copy (the Below option says full screen gives it the most room), not by resizing the view. — *if wrong:* Below without full screen shows few rows on short screens.

**B44.** Round 2: the shared row-actions menu gets the standard menu-button keyboard pattern by default (arrows, Home/End, Enter/Space pick, Esc closes and returns focus, Tab closes). It helps all ~40 callers. — *if wrong:* a caller that relied on focus staying on the trigger after a keyboard open.

**B45.** The task color picker uses the portal's existing preset colors (the palette the color wheel already uses), not a copy of the API's 12-color initiative palette. One palette. — *if wrong:* seven presets plus Custom.

**B46.** When the toolbar can't fit one line (classic scrollbars, narrow windows), whole groups wrap to a second line. This is the designed fallback; there is no overflow menu. — *if wrong:* a second toolbar line on some setups.

**B47.** Raise the test library's wait timeout to 3,000 ms and fix the fragile waits in the plans tests. The flakes were load-sensitive waits, not product bugs. — *if wrong:* a truly failing wait takes 3 s to report.

**B48.** A filter applies when picked, as in MS Project. A task you edit or add stays shown until the filter changes. — *if wrong:* an edited task that no longer matches stays on screen until the filter is re-picked.

**B49.** Late and Due This Week compare against the status date, or now when there isn't one (the spec's rule). — *if wrong:* none.

**B50.** While grouped, outline-changing commands are off (links, blank row, Insert, Indent, Outdent, row-adding pastes) with the note "Turn off Group by to change the outline". — *if wrong:* one extra click to ungroup before restructuring.

**B51.** The Group by option is labeled "Resource" (MS Project's word), and filter names use MS Project's title case. — *if wrong:* none.

**B52.** While grouped, a multi-row cell paste fills the visible task rows downward from the active row (skipping a task already filled), so it lands where you see it. — *if wrong:* none.

**B53.** While grouped, Link, Unlink and the link-drag dot are off too, with the grouped note. Link lines are hidden then, so a link made there would be invisible. — *if wrong:* one click to ungroup before linking.

**B54.** The filter count counts leaf tasks in both grouped and ungrouped views. — *if wrong:* summaries aren't counted.

**B55.** The Late filter uses each task's already-computed "late" status instead of re-implementing the API rule. — *if wrong:* none.

**B56.** While grouped, links typed into the Predecessors column or Task Information still apply, because those edits name the task explicitly. — *if wrong:* a link made that way isn't drawn until Group by is off.

**B57.** Build drag-to-reorder by the ID cell now in Plan B (one move batch, subtrees move, off while grouped, locked or read-only). It's the spec's way to move a task, and your core pain is moves that lose dependencies. — *if wrong:* none.

**B58.** Cut marks rows with a dashed outline (Excel style) and deletes nothing. Pasting a pending cut in the same plan is one move that keeps ids, links, progress and baseline; Esc, a new copy or a reload cancels. A cut pasted into another plan pastes copies. — *if wrong:* an MS Project user expecting cut rows to vanish at once sees them marked until they paste.

**B59.** Fix minor items M1 to M7 and one small nit now, as the review proposes. The review's other "leave it" verdicts are accepted. — *if wrong:* not stated.

**B60.** Accept the fix's calls: "Only summary tasks match" wording; a cut pasted into another plan ends the cut; any plan reload ends a pending cut; a locked-plan drag shows the lock toast; no drop line where a drop changes nothing; undo label "Move Row(s)"; no tip for ID drag. — *if wrong:* copy tweaks only.

**B61.** Fix now: a long auto-scrolled row drag must survive its pressed row scrolling out of view (it was cancelling silently). It's load-bearing for large plans. — *if wrong:* none.

**B62.** Cut then Paste onto the cut rows themselves clears the cut marks and sends nothing (Excel parity). Releasing a drag outside the sheet's scroll box cancels like Esc. — *if wrong:* a drop just outside the sheet edge cancels instead of landing.

**B63.** Leave a small counter nit alone; a stale cut can't land because moves are version-checked. — *if wrong:* a pending cut can survive leaving and returning to the tab.

**B64.** In Beside layout, the drag area is the shared scroller, so releasing over the chart's rows drops at that row's gap. — *if wrong:* none.

## Plan C: extras

**C1.** The importer's parsed-task record gains an optional color (MS Project files never set it), so the Excel importer's Color column flows through the shared importer. — *if wrong:* none.

**C2.** A temporary list of notification kinds still awaiting a sender stays until Task 2 adds the sending, and Task 2 deletes it. — *if wrong:* none.

**C3.** Carried to Task 2: the reminder sweep and assignment notices check the person's own category choice before sending, because the notify call only honors "off" for email kinds and the spec says Off means nothing. — *if wrong:* none.

**C4.** The /me "Email from" cell for Project plans must not say "No group — inbox only" (plan mail goes straight to the person). Groups can't subscribe to Project plans, since the option would promise mail that never comes. — *if wrong:* none.

**C5.** The "you were assigned" email lists every assigned task with no cap, so no limit is invented. — *if wrong:* a very large assignment makes a long email.

**C6.** The /me row for Project plans shows "Sent to your contact email" ("—" when the choice isn't email), and the group picker hides direct-delivery categories (display only; the API and save stay permissive). — *if wrong:* copy tweak.

**C7.** Drop the unrequested line "Reminders stop once the task is marked complete." from the reminder email, since nobody asked for that copy. The overdue digest takes assignees as a list only. — *if wrong:* none.

**C8.** Turning off "email assignees" turns off every direct plan email, including the owner's digest email (the owner keeps the inbox row), per the spec's Delivery bullet. — *if wrong:* an owner who wanted digest email loses it on a plan with assignee email off.

**C9.** Accept: one digest per plan per local day; a stage not sent by the end of its day is replaced by the next; inbox titles copy the email subject; the year shows only when it isn't the current year. — *if wrong:* copy tweaks.

**C10.** No owner digest goes out before the plan's reminder send time. This fixes a drift where the digest slid to about 12:01 a.m. local time. A midnight-sweep test covers it. — *if wrong:* none.

**C11.** Daily overdue reminders send only on their own day, the same replaced-at-end-of-day rule as the other stages. — *if wrong:* a reopened task's first overdue reminder waits for the send time.

**C12.** Assignment notices are sent in a protected step: a failure is logged and never fails the user's schedule edit. Edits matter more than notices. — *if wrong:* a failed notice is dropped (logged).

**C13.** Reminders are de-duplicated by the due day, not the exact due moment, so a time-only deadline change or a recalculation nudging a finish time doesn't re-send. The spec is amended. — *if wrong:* moving a deadline to another time on the same day doesn't re-send.

**C14.** Check the sent-log before loading resources (skip when every candidate is already logged), remove an unreachable branch, and load the contact once if trivial. — *if wrong:* none.

**C15.** Accept the own-day rule for "due in N days" stages too: a missed one isn't sent late, so no "Due today" at 1 a.m. followed by another at 8 a.m. Also accept the process-wide notice-failure log flag. — *if wrong:* a "due in N days" reminder missed during downtime is skipped.

**C16.** The reminder offsets picker offers the API's 1 to 365 day range. — *if wrong:* none.

**C17.** Small round of fixes: a hint by Save naming the first invalid setting with a link that scrolls to it; cap the settings rows' width so controls sit near their labels; comment the blank-slack placeholder; check 1280 and 1024 px widths. You notice layout. — *if wrong:* none.

**C18.** No unsaved-changes guard on the reminder settings (no Settings tab has one), and no version check on the system settings save (admin-only, rare edits). — *if wrong:* a tab click drops a draft; two admins saving reminders at once, last one wins.

**C19.** The toolbar must stay on one line at 1512 px with the nav open (Plan B's rule), so the view switcher becomes one compact dropdown showing the current view ("Gantt ▾") with checked items. — *if wrong:* one extra click to switch views.

**C20.** Milestones are never folded into "+N more" in the Calendar (they sort first in a day). Escape that closes a calendar week popover doesn't also leave full screen. — *if wrong:* none.

**C21.** Accept: Undo, Redo, Task Information, Find and Help keys work in Calendar and Board; collapsing doesn't hide tasks there; touch moves go through the card menu. — *if wrong:* none.

**C22.** Fix all four Important review findings. Make the strip compact so the view keeps its minimum height. Outside the Gantt, selection settles to drawn tasks, and Shift+F2 prefers the focused bar or card. — *if wrong:* none.

**C23.** Minor fixes: one finish-day rule for every Calendar, Board and strip label; strip marks at least 24 px; milestones offer only Not started and Complete on the Board; switching back to the Gantt reveals a task under a collapsed summary; Board scrolls its column, not the page; "+N more" gets a proper name and kept focus. — *if wrong:* none.

**C24.** Accept Full screen as an icon-only button (keeps its tip, Esc keycap and name), and the strip as the view area's top band. The sheet and chart get the rest, and the page never scrolls. — *if wrong:* Full screen is less discoverable.

**C25.** Fix three more items in round 2: a grouped selection settles to its drawn task, selection also settles after a deep link or Go to task, and Escape in an editable field is left to the field. — *if wrong:* none.

**C26.** The Timeline's milestone day follows the plan tab's finish-day rule (a 00:00 finish counts as the previous day, unless the task is zero-length). The API computes it, so portal and API agree. — *if wrong:* none.

**C27.** The Timeline's Milestones toggle hides diamonds and chips only. The hover card's Plan line stays. — *if wrong:* plan viewers who turn it off still see the Plan line.

**C28.** Accept: an initiative row stays when one of its milestones is in range, and same-day diamonds sit 12 px apart. Several internal naming and structure choices are accepted too. — *if wrong:* not stated.

**C29.** Fix the pre-existing Timeline row-label styling (browser-default blue links, subtitle running into the name) on this branch as its own commit, since it's the page this task touches. — *if wrong:* an unrelated fix rides this branch.

**C30.** On the all-initiatives calendar, a milestone chip past the 4-lane cap folds into that day's "+N more". Archived initiatives are skipped. Diamonds within about 14 px on a row merge into one at coarse zoom (hover lists them). — *if wrong:* a milestone on a crowded day needs a click on "+N more".

**C31.** Accept: the day field also on "next"; a cluster click opens the leftmost milestone; long row labels ellipsize like the Initiatives list. — *if wrong:* none.

**C32.** A template keeps the working week and units but not dated calendar exceptions, since holidays belong to dates, not to the project. A plan made from a template takes the system default calendar's exceptions. — *if wrong:* a source plan's one-off non-working days aren't carried over.

**C33.** Accept: creating from a template runs in the background; "Templates…" shows with change or delete permission; everyone who can view plans sees all templates (company-owned, like report templates); name and description limits are 120 and 1,000 characters (copied from report definitions). — *if wrong:* none.

**C34.** Template fix round: a template must list each parent before its children, and unknown link types and duplicate links are refused as a "bad template". Creating from one caps tasks and links at the existing restore-row cap. "From a template" disables Create until templates load and offers Try again. — *if wrong:* none.

**C35.** Accept: an import applies as a single change through the normal edit path (no assignment emails; imported progress skips completion rules, since an import reflects the file). Fill mode takes the file's project start and status date. Color, timeline flag, baseline and summary mode don't round-trip. — *if wrong:* baselines are lost through MS Project.

**C36.** Fix both security findings: a running budget for exception days is checked before memory is allocated, and importing into an existing plan requires the change permission (a new-plan import stays "add"). — *if wrong:* an add-only user can no longer import into an existing plan.

**C37.** A plan's outline is capped at 10 levels, copying Microsoft's limit for Project for the web and Project Operations (desktop Project allows 65,535). Imports flatten deeper tasks with a per-row problem, and indent refuses past 10. The builder says you should confirm this number. — *if wrong:* a desktop MS Project file nested deeper than 10 levels imports flattened at level 10.

**C38.** Fix round: both security findings, a faster moved-days calculation, parsing in a worker thread, an optional base version on apply (refused as "plan changed" if the plan moved), level-0 tasks becoming level 1 with a problem note, the test gaps, and DaysPerMonth rounding noted in docs. — *if wrong:* none.

**C39.** Accept: a plan already deeper than 10 levels stays editable, and undo isn't capped. The cap only stops new structure. — *if wrong:* none.

**C40.** Accept the streaming Excel reader instead of the usual Excel library's loader (which used 1.4 to 2.7 GB on 25 to 35 KB zip bombs), subject to review as a hand-written parser. — *if wrong:* a reader to maintain.

**C41.** Fix the same memory leak in the MS Project XML importer, with a memory test. A file's Start becomes Start No Earlier Than only when it is later than where the task would schedule anyway. A date with no time uses the calendar's default start or finish time. — *if wrong:* none.

**C42.** The unpacked-size cap for Excel imports reuses the existing 20 MB import limit (you are asked to confirm). Also accepted: Mode read-back, header-row detection, .xls and .mpp messages, comma-split resource names, no Milestone column round trip. — *if wrong:* a notes-heavy export over 20 MB unpacked can't be re-imported.

**C43.** Fix all review findings: refuse zip members that use anything but the two standard compression kinds and limit total bytes read; faster, bounded parsing of resource and predecessor cells; cut cell text at Excel's 32,767-character limit; unknown columns give a "bad field" error; export header is "Task Mode" (MS Project's name). — *if wrong:* none.

**C44.** Accept: one XML element with a huge attribute still costs about 446 MB within the 20 MB budget (expected overhead). A sheet drops a linked task's constraint only when the links already place it there and the column isn't exported. — *if wrong:* one pathological upload can still spike memory by about 0.4 GB.

**C45.** Round 2: cut text at both number fallbacks; a task under a linked summary counts as linked (MS Project: the summary's link drives it); a milestone's day-only Finish takes its resolved Start; 00:00 is a day alone only when the cell format has no time part; decoded shared strings are charged to the size budget. — *if wrong:* none.

**C46.** Accept: an all-bad-predecessors 20 MB file costs about 8 s of CPU (same as CSV at the cap; lower would need a new limit). Date-only export formats are used when a plan hides times. — *if wrong:* an 8 s worker-thread parse for a pathological file.

**C47.** Accept: the file-name header is exposed for cross-origin downloads; Export is a titled group in More (no flyouts); Fill is the default on an empty plan. — *if wrong:* none.

**C48.** Revises the earlier "no new cap" rule for PDF: a custom range is clamped to the plan's own span (wholly outside is refused); the printed span is at most 10 years, longer is refused with a clear message; PDF building runs in a child process killed at the 300 s report timeout; no page cap. — *if wrong:* a plan spanning more than 10 years can't be printed in one PDF.

**C49.** Accept: 20 mm bottom margin for the footer; the PDF's own scale; Weeks shading; no Hours zoom (it opens on Fit); PDFs stay on the run, not in Files; the table estimate counts one-line rows; a 1 to 2 s child start; a custom range can only narrow; the 0110 downgrade deletes project-plan runs first. — *if wrong:* none.

**C50.** "PDF…" shows disabled with the note "Needs access to Reports" for viewers without the reports add permission, instead of a toast after the click (the house rule for disabled commands). — *if wrong:* none.

**C51.** Fix round: drop the pre-clamp 10-year check so a wide custom range clamps instead of being refused; a dead child reports "renderer stopped"; the child sets its own deadline (no memory cap, which would need a new number); Gantt labels 7 pt in darker gray for print; "PDF…" disabled with "Needs access to Reports". — *if wrong:* none.

**C52.** The re-review of fix round 1 folds into Plan C's final whole-branch review, since the diff is small and the final review reads it anyway. — *if wrong:* none.

**C53.** Run the final whole-branch review and its fixes before Task 11 (final verification), so the full suites and live end-to-end pass check the fixed branch. — *if wrong:* none.

**C54.** Fix the one Important finding (a 24:00 finish read as "due Friday" in reminders but Thursday elsewhere) and minors M-1 to M-7, plus the deferred "fix now" items (Timeline typography, template-load copy, a dropped-summary-link test, import dialog keeps its previewed mode). Leave the rest as the review says. — *if wrong:* none.

**C55.** Accept: the curly apostrophe (house style in plans code), no mode line for a new plan, the real-dates bar moved down on noted rows, the sweep's filter uses <= for midnight finishes, and blank shared strings charged nothing. — *if wrong:* not stated.

**C56.** Residual items fold into Task 11's first step: a CPU-time bound on the names/predecessors speed test; Plan A's wall-clock "< 0.1 s" bounds become CPU-time or generous bounds; Timeline bar labels and "Unscheduled" divider get list typography tokens; the Timeline scroller gets the house slim themed scrollbar. — *if wrong:* none.

**C57.** The controller runs the full API suite in the background after Task 11's fixes land (it takes 1h45m, too long for one tool call). The implementer runs the portal suite, build and live end-to-end pass. The physical Cmd+C and Cmd+V check in real Chrome and Safari is yours, since agent keystrokes are synthetic. — *if wrong:* none.

**C58.** Summary tasks get no finish-based reminders. With "use finish when there's no deadline", a summary without its own deadline is skipped by the sweep and the owner digest (its children are reminded on their own finishes), since a summary's finish double-counted its last child's. A summary with a deadline is reminded as today. — *if wrong:* a summary's own finish never reminds; setting a deadline on it restores that.

**C59.** The PDF Gantt's tick header runs each tile's full drawn width. Plan span, print range and page estimate stay as they are. A deadline past the printed range draws nothing. — *if wrong:* none.

**C60.** Leave the milestone date label that a link elbow can cross. A white backing would hide link starts instead. — *if wrong:* a crossed digit in rare layouts.

**C61.** The portal main area's default light scrollbar is shared page chrome, the same on main, so it is not fixed on this branch. Proposed as its own session. — *if wrong:* none (it stays as on main until that lands).

**C62.** The dev clone keeps the 111 test-account sign-in session rows and the last-login time, because a link from a pre-snapshot session blocks the delete. Dev clone only. — *if wrong:* none.

**C63.** Fold all four review minors into fix round 1. They are cheap, and one timing bound is a load-flake risk in the full suite. — *if wrong:* none.

**C64.** Accept "their own Deadline" capitalized (it matches the field names in the sentence), a deadline before the chart's left edge also drawing nothing (symmetry), the two-line pointer comment, and 3 more test-account sign-in session rows on the clone. — *if wrong:* one-word copy change.

**C65.** Leave two small review notes: the PDF test only covers a one-page-wide chart (the reviewer checked wider charts by hand), and no live reminder run re-checked the summary fix (tests and a code read cover it). — *if wrong:* a later change that breaks the date header on wide charts is caught only for one-page-wide charts.

**C66.** The three label-image test failures in a full API run are not fixed on this branch: main has the same problem (a wiki PDF test loads the PDF library during test collection, which makes the image library accept broken pictures for the whole run). This branch's own copy of that problem is fixed, and the rest went to its own session. — *if wrong:* the full API suite shows 3 known label-image failures on main and on this branch until that session lands.

## The merge with Notifications Phases 0-2 (2026-11-03)

The branch was built before the notification rework, and main gained Phases 0, 1 and 2 while it was built: personal Inbox/Email switches over company defaults, held email and a summary, and groups that no longer carry categories.

**M1.** The plan migration is renumbered from 0110 to **0117**, on top of 0116. Its step that let notification groups subscribe to `plans` is gone, because Phase 2's migration 0113 dropped group categories. — *if wrong:* none; the step had nothing left to act on.

**M2.** `plans` joins the configurable categories (after Initiatives), so it gets a row on /me › Notifications and on the company Defaults tab, on/on out of the box. Plan messages follow those switches for account holders: Inbox off means nothing, Email off means the inbox row only. This replaces the old three-way choice (Inbox + Email / Inbox only / Off) with the same outcomes. — *if wrong:* an admin who turns the Project plans default off silences plan notices for everyone who never set their own.

**M3.** Plan email still goes straight to the person through the mail outbox with its own templates, and the person's schedule (quiet hours, days off, the summary) does not hold it. Reminders go at the plan's send time, and assignment notices when the assignment is made, the same as learning's direct mail. — *if wrong:* someone with quiet hours can get an assignment email during them; routing plan email through the summary would mean rebuilding its templates as notification email.

**M4.** An email to someone without a portal account is queued without a notification kind, as learning's is. Phase 0's send-time re-check drops a kind's email when its inbox row is gone, and these emails never had one, so with the kind every one of them would have been dropped. An account holder's copy keeps its kind and is re-checked like any notification email. — *if wrong:* the delivery log shows these emails by template name (`plan_assigned`, `plan_reminder`) instead of under the Project plans category.

**M5.** The Defaults tab's note under Critical notifications now also says why plan notices aren't listed (they send their own email under each plan's settings). — *if wrong:* one sentence of copy.

**M6.** Check delivery is not taught about plans. For a plan kind it says the inbox row is always written and the email is never sent, when really Inbox-off sends nothing and the email goes direct. — *if wrong:* a super admin troubleshooting a missed plan reminder gets a wrong answer from that tool until it is fixed (a separate follow-up). *Fixed right after the merge (branch `check-delivery-plans`): Check delivery now answers a plan kind with the sender's own rule (`plans/notices.py` `delivery`), "Sent directly" plus a note on when, and says why there is no inbox item (no portal account, category off, person archived).*
