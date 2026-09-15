# Row actions in one Actions menu — outcome

Plan: `docs/superpowers/plans/2026-09-15-row-actions-menu.md`. Branch
`row-actions` off `reports` @ e9e49f2, five commits.

Jimmy asked for this while looking at the list-overlap bug: "one fix would be to
move any of the edit, delete or other action items into a single Actions
dropdown button."

## What landed

| Commit | |
|---|---|
| `0ec5162` | `RowAction` gains `disabled?: boolean`; a disabled item stays in the menu and leaves it open, so a trigger never vanishes mid-action |
| `4ae0cff` | Initiative move-assets and people rows |
| `8c39f8d` | Notification group members, timesheet, status rules |
| `626e404` | Dev database backups and pending deletes, font library, notification requests, warehouse container stock |

Ten lists converted. Each row's buttons became one `RowActionsMenu` trigger,
destructive items marked `destructive`, busy rows passing `disabled` rather than
dropping items, and every permission gate preserved by building the item array
(an empty array still renders no trigger at all).

Action tracks reclaimed: `250px`, `210px`, `200px`, `190px`, `170px`, `150px`
and two `132px` all became `88px` — the width the "Actions ▾" trigger actually
measures (85px live, confirmed in the browser, not guessed).

## Deliberately not converted

- **Single-action cells** — `FixedReaders`, `Routers`, `MembersTab`'s Overrides,
  `OfflineCacheModal`'s Remove, `InstallFontsModal`'s printer-objects Remove,
  `Warehouse`'s asset mini-row. A dropdown turns one click into two and buys
  ≤90px.
- **`StakeholderDetail`'s workers cell**, which is a navigation link, not an
  action.
- **Every flex-row list** (`NotesFilesPanel`, `GroupsTab`, `ContainerEditModal`,
  `External`, `OrgDirectory`, …). They reserve no grid track, so they return no
  width.

## How much of the overlap bug this fixes: some, not all

Overflowing headers on the initiative move-asset list (of 12), measured with the
same probe that diagnosed the bug, before and after:

| List width | Before | After |
|---|---|---|
| 895px | 4 | 3 |
| 1000px | 3 | 2 |
| 1105px | 2 | 2 |
| 1200px | 2 | 1 |
| 1300px | 0 | 0 |

44px per list, spread across ten flexible tracks, removes roughly one
overflowing column. The clean threshold is still ~1300px of table width, so at
Jimmy's 1440px viewport "Destination Rack" and "Destination RU" still collide.

**The remaining fix is column floors.** Those tracks are bare `fr` values with
`min-width: 0` cells, `overflow: visible` and no horizontal scroll, so a track
shrinks below its content and the text paints over its neighbor. `Notifications.tsx`
already solves exactly this with `minmax(<px>, <fr>)` widths plus
`.dir-list.ngd-notif-grid { overflow-x: auto; }`, and the comment at
`portal/src/styles/directory.css:196-205` explains why. Generalizing that is the
next job and is not on this branch.

## Verification

- Full portal suite **1748 passed** across 173 files; `npm run build` and
  `npx tsc -b` clean.
- Live, before the dev database went down: the initiative list's trigger
  measures 85px and is not clipped in its 88px track, the menu opens with Edit
  and a red Remove, and it portals to `document.body` rather than being clipped
  by the list's rounded corners.
- **Not live-verified:** the lists from commits `8c39f8d` and `626e404`. The
  host's disk filled to 100%, Postgres stopped accepting connections, and every
  API route began returning 500, so no signed-in page would load. Unit coverage
  for those lists is green; a live pass is still owed on the members list, the
  timesheet, status rules, both dev-database lists, the fonts modal, the
  notification requests row and warehouse stock.

## Follow-ups

- Column floors plus horizontal scroll, per above. This is the actual fix for
  the reported bug.
- `ACTIONS_TRACK = '88px'` is now a private constant in both
  `InitiativeDetail.tsx` and `DevDatabase.tsx`, with two further literals
  elsewhere. Worth one exported constant.
- The members list is a `DataTable` with `table-layout: auto`, so its `88px` is
  a preference rather than a cap and the uppercase "ACTIONS" header may hold the
  column slightly wider. Same caveat for the notification requests column: if
  anyone adds `table-layout: fixed`, the requests column needs a conditional
  width for its rejecting state.
