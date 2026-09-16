# Row actions into a single Actions menu — plan

Jimmy, 2026-09-15, on the list-overlap bug: "one fix would be to move any of
the edit, delete or other action items into a single Actions dropdown button."

Branch `row-actions`, worktree `.claude/worktrees/row-actions`, off `reports` @
e9e49f2.

## Why

Lists build `grid-template-columns` from bare `fr` values, so a track can shrink
below its content and paint over its neighbor (measured: the initiative move-
asset list has 10 of 12 headers overflowing at a 1024px viewport). Every row of
action buttons costs a fixed px track that the flexible columns never get back.
Folding those buttons into the existing `RowActionsMenu` returns that width and
makes every list consistent with the nine that already use it.

This is step one, not the whole fix: the worst list reclaims ~130px against a
~400px shortfall at 1024px. Column floors (`minmax(<px>, <fr>)`) plus horizontal
scroll — the pattern `Notifications.tsx` already proves — is the follow-up, and
stays out of this branch.

## The component

`portal/src/components/hardware/RowActionsMenu.tsx` — `RowAction` is
`{ key, label, onSelect, destructive? }`; the trigger is a `mini-btn` reading
"Actions ▾"; an empty `actions` array renders nothing, so **items are passed
pre-gated** (`...(canX ? [{…}] : [])`). The open menu is portaled to
`document.body`, so **tests must query menu items via `screen`, not
`within(row)`** — see the note at `portal/src/pages/KioskDevices.test.tsx:178`.
A module-scoped bus keeps one menu open page-wide.

## Scope

**Convert** the lists whose action cell holds two or more actions — those are
the width wins and the consistency wins:

| # | List | File | Actions | Track today |
|---|---|---|---|---|
| 1 | Initiative → move assets | `pages/InitiativeDetail.tsx:821` | Edit, Remove | `132px` + a separate `30px` chevron |
| 2 | Initiative → people | `pages/InitiativeDetail.tsx:1013` | Edit, Remove | `132px` |
| 3 | Notification group members | `components/notifications/MembersPanel.tsx:196` | Edit, Remove (+ inline "Really remove?" confirm) | `250px` |
| 4 | Timesheet | `pages/TimeManagement.tsx:577` | Approve, Reject, Edit | `210px` |
| 5 | Status rules | `components/statusRules/RulesTab.tsx:341` | Edit, Duplicate, Delete | `200px` |
| 6 | Font library (modal) | `components/printers/InstallFontsModal.tsx:176` | Install/Reinstall, Remove | `190px` |
| 7 | Dev → backups | `pages/DevDatabase.tsx:533` | Download, Delete | `170px` |
| 8 | Dev → pending deletes | `pages/DevDatabase.tsx:298` | Undo, Delete | `150px` |
| 9 | Notification requests | `pages/Notifications.tsx:310` | Approve, Reject (+ inline reject-reason input) | implicit |
| 10 | Warehouse container stock | `pages/Warehouse.tsx:646` | Edit, Move | `auto` |

**Leave alone**, with a one-line comment where it is not obvious:
single-action cells (`FixedReaders`, `Routers`, `MembersTab`'s Overrides,
`OfflineCacheModal`'s Remove, `InstallFontsModal`'s printer-objects Remove) —
a dropdown turns one click into two and buys ≤90px; `StakeholderDetail`'s
workers cell, which is a navigation link, not an action; and every section-B
flex row (`NotesFilesPanel`, `GroupsTab`, `ContainerEditModal`, …), which
reserves no grid track and so returns no width.

## Global constraints

- Portal only — no API, no migration.
- Portal commands from the worktree's `portal/`: `npx vitest run <paths>` then
  `npx tsc -b`. Foreground; never background a suite and end your turn waiting.
- TDD where behavior changes. Never weaken an existing assertion. Tests that
  reach into a converted row must open the menu first and query items via
  `screen` (the portal), not `within(row)`.
- Never `git add -A`. Never `git stash` (the stack is shared). Leave the
  `portal/node_modules` and `api/.venv` symlinks alone. If `git status` shows
  `api/src/serversherpa/_dev_reload.py` modified, `git checkout --` it.
- The list-typography guardrail (`portal/src/styles/listTypography.test.ts`)
  forbids font-size / font-family / font-weight / line-height / min-height in a
  page stylesheet on a list-ish selector, and inline `fontSize` and friends via
  the `style` prop. Run it with every task.
- American English. Every commit ends with the trailer line exactly:
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Task 1 — `RowAction.disabled`, and keep the trigger honest

Several lists disable a button while that row is in flight (`rowBusy`,
`assetsBusy`, `peopleBusy`, `busyId`, `downloading`). `RowAction` has no
`disabled`, and dropping the item instead would make the trigger vanish
mid-action on a single-action row.

- [ ] **Step 1: failing tests** in `portal/src/components/hardware/RowActionsMenu.test.tsx`
      (create if absent): a `disabled` item renders as a disabled menu item, does
      not fire `onSelect` on click, and does not close the menu; a list whose
      items are all disabled still renders its trigger.
- [ ] **Step 2:** add `disabled?: boolean` to `RowAction`; render `disabled` on
      the item button and skip `onSelect`/close. Style it in
      `portal/src/styles/hardware.css` beside the existing `.pop-item.danger`
      rule — color and cursor only, no typography (guardrail).
- [ ] **Step 3:** `npx vitest run src/components/hardware src/styles/listTypography`,
      `npx tsc -b`; commit `feat(portal): RowActionsMenu items can be disabled`.

## Task 2 — Initiative detail: move assets and people

The page from Jimmy's screenshot. Both lists, one commit.

- [ ] **Step 1: failing tests** in `portal/src/pages/InitiativeDetail.test.tsx`
      (check whether it exists; extend or create): the assets row shows an
      "Actions" trigger instead of inline Edit/Remove; opening it and choosing
      Edit opens the edit dialog; Remove still confirms before removing; with
      `can('initiatives','change')` false there is no trigger at all.
- [ ] **Step 2:** replace both action cells with `RowActionsMenu`. Drop the
      `132px` track from both grid templates (`:525-526` people, `:558-559`
      assets) in favor of a narrower fixed track sized to the trigger — measure
      the trigger in the browser rather than guessing, and keep the assets
      list's separate `30px` chevron. Keep the row-click `stopPropagation`
      wrapper the other call sites use. Preserve the existing `confirm()` on
      Remove and the busy-state disabling via Task 1's `disabled`.
- [ ] **Step 3:** `npx vitest run src/pages/InitiativeDetail src/styles/listTypography`,
      `npx tsc -b`; commit `feat(portal): initiative asset and people rows use the Actions menu`.

## Task 3 — The three widest: members, timesheet, status rules

- [ ] **Step 1: failing tests** per list, in whichever test files already cover
      them (search first; `MembersPanel`, `TimeManagement`, `RulesTab`).
      `MembersPanel`'s 250px exists only so its inline "Really remove?" confirm
      does not reflow the row (`portal/src/styles/notifications.css:117`) —
      moving Remove into the menu removes that reason, so the confirm becomes a
      `confirm()` and the width goes. Assert the row no longer reflows.
- [ ] **Step 2:** convert all three; drop `250px`, `210px`, `200px` to a
      trigger-sized track. `TimeManagement` only renders Approve/Reject for a
      pending entry — keep that conditional by building the item list, not by
      disabling. `RulesTab` gates each of Edit/Duplicate/Delete on a different
      permission; keep them independent.
- [ ] **Step 3:** targeted vitest + guardrail + `npx tsc -b`; commit
      `feat(portal): group members, timesheet and status rules rows use the Actions menu`.

## Task 4 — The rest: dev database, font library, requests, warehouse stock

- [ ] **Step 1: failing tests** where those lists already have coverage
      (`DevDatabase`, `InstallFontsModal`, `Notifications`, `Warehouse`).
      `Notifications`' reject flow swaps the row into a reason input — keep that
      behavior, triggered from the menu item rather than an inline button, and
      test that Cancel restores the row.
- [ ] **Step 2:** convert the four; drop `170px`, `150px`, `190px` (library
      table only — leave the printer-objects table's single Remove) and the
      implicit requests cell. `DevDatabase`'s Download disables while
      downloading: use Task 1's `disabled`.
- [ ] **Step 3:** targeted vitest + guardrail + `npx tsc -b`; commit
      `feat(portal): dev database, font library, requests and warehouse rows use the Actions menu`.

## Task 5 — Verification and measurement

- [ ] Full portal suite + `npm run build` + `npx tsc -b` in the worktree.
- [ ] Live-verify in the browser against this branch. Every converted list:
      open the menu, run one action, confirm it still works and that the menu
      closes. Confirm a permission-less persona sees no trigger on at least one
      list.
- [ ] **Measure the width actually reclaimed.** For the initiative asset list,
      record the overflowing-header count at 1024, 1280 and 1440 before and
      after, with the same probe used to diagnose the bug:
      `[...document.querySelectorAll('.list-head')].map(h => [...h.children].filter(c => c.scrollWidth > Math.ceil(c.getBoundingClientRect().width) + 1).length)`
- [ ] Write `docs/superpowers/specs/2026-09-15-row-actions-menu.md`: what was
      converted, what was deliberately left, the before/after measurements, and
      an explicit statement of how much of the overlap bug this does and does
      not fix.
