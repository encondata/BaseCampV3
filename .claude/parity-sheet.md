# V2-to-V3 parity sheet — how to read and update it

The **living** parity tracker is the Google Sheet **"Server Sherpa V3 Parity to V2"**.
- Drive id: `1MJSn3KhOF78cLErgQrEYsP9gOPCPoNnD3p0TRD7a3dU`
- URL: https://docs.google.com/spreadsheets/d/1MJSn3KhOF78cLErgQrEYsP9gOPCPoNnD3p0TRD7a3dU/edit

`docs/BaseCamp-V2-to-V3-Feature-Parity.xlsx` and `docs/feature-parity-v2-v3.md` are the original 2026-09-21 deliverable. **Never edit them**; all updates go to the Google Sheet.

## When to update it

- **After a feature merges to main.** Jimmy asks to "update the sheet". Record the merge commit sha in the notes.
- **When Jimmy retires or defers an item.** Use his wording.
- **On request, the Weekly Summary tab.**

## How to read it

Use the Google Drive connector's `read_file_content` with the Drive id above.
- The result is too large to show inline, so it is saved to a file. Extract it with `jq -r .fileContent <file> > sheet.txt`, then `grep` it.
- The export is markdown tables in tab order: Summary, Feature Parity, Gaps, New in V3, To-Do, Future Features.
- **Export line numbers are not sheet row numbers.** Use them only to estimate a row, then confirm it in the sheet.

## How to write it

The connector can't write cells, so write through **Claude in Chrome**, in the tab that has the sheet open.
- Load the tools in one ToolSearch call: `tabs_context_mcp`, `computer`, `browser_batch`, `find`.
- **Always address a cell by the name box.** Click the name box (top-left, about (45, 102) in a 1512×784 frame), type the reference (e.g. `G305`), press Return, type the value, press Return.
- **Never press a bare Return to step over a cell.** It once opened a cell for editing and scrambled the Summary.
- **Confirm a row before writing.** Name-box to `B<row>` and read the formula bar with a `zoom` on the region (0, 90, 1512, 115). Row estimates drift.
- A percentage in the Summary is **text**: type it with a leading apostrophe (`'84%`).
- Status cells are dropdown chips. Type the exact label and press Return.
- **Line breaks inside one cell:** cmd+Return only works on every other press. Instead, enter `=JOIN(CHAR(10), {"• line one", "• line two"})`, then copy the cell and paste values only (cmd+shift+v) so it becomes plain text.
- **Switch tabs by clicking the tab name at the bottom.** Take a screenshot first; tab positions shift when tabs are added.
- Batch several actions per `browser_batch`, then verify with a zoom or screenshot.

## Tabs and columns

### Summary
- **Headline** (column B):
  - B5: V2 features carried forward
  - B6: built in V3
  - B7: partially built
  - B8: not built yet
  - B9: deliberately retired
  - B10: new capabilities in V3
  - B11: parity, as text
- **By area table:** the header is row 15 and areas start at row 16. Columns: A Area, B Complete, C Partial, D Not built, E Retired, F New in V3, G Parity (text).
  - Known rows: 23 Time tracking, 29 Bulk imports.
  - Confirm any other area's row with the name box.
- **Math:**
  - carried forward = built + partial + not built
  - parity = (built + partial / 2) / carried forward, rounded half-up
  - Area parity uses the same formula on that area's Complete, Partial and Not built. Retired and New in V3 are excluded.
- **When one row changes:**
  - Not built → Complete: built +1, not built −1.
  - Partial → Complete: built +1, partial −1.
  - Anything → Retired: carried forward −1, retired +1, and take 1 off the old status count.
  - Adjust the area row the same way, then recompute both percentages.

### Weekly Summary
One row per week:

| Column | What goes in it |
|---|---|
| A — Week of | `DDMONYY to DDMONYY`, Monday to Sunday. Example: `21SEP26 to 27SEP26`. |
| B — What was done | One bullet per work item, each ending with its own estimate `(~N h)`, all in one cell (see line breaks above). |
| C — Estimated time | The total, e.g. `~55 hours (estimated from commit times plus design and review time)`. |

- Rows are top-aligned and wrapped. Add each new week as the next row.
- To build the bullets, run `git log main --first-parent --since=<Monday>` and, for each merge `m`, check `git log --reverse $m^1..$m^2`. The first commit through the merge time gives the span; add design and review time. Include branches pushed but not merged, and say so in the bullet. Write in plain language, not commit jargon.

### Feature Parity
- Columns: A Area, B Feature, C What it does, D In V2, E V3 status, F Where it lives in V3 (a route like `/bulk/time`), G Notes / gap.
- One row per feature.
- On completion, set E to `Complete`, fill F with the route, and write G in the note formats below.
- Known rows (confirm them):
  - 284: Bulk actions hub
  - 291: Per-row outcome report
  - 297, 298: retired importers
  - 299: Bulk update existing assets
  - 305: One-shot move creation
  - 156: Bulk approve
  - 166: Bulk import of time punches

### Gaps
- Columns: A Area, B Feature, C What it does, D In V2, E V3 status, F Notes / gap.
- It lists only some features, so check whether a feature is listed before writing.
- When a feature's status changes, keep its Gaps row in sync with Feature Parity.
- Known rows:
  - 7: Bulk actions hub
  - 9: Bulk update existing assets
  - 15: One-shot move creation
  - 60: Bulk approve
  - 61: Bulk import of time punches

### To-Do
- Columns: A #, B Priority, C Time estimate, D Area, E What to build, F Why it matters, G Features it closes, H Rows, I Status.
- **Row map:** items #1–#12 sit on row N+1. From #14 on, the row equals N (there is no #13).
- **Status (column I) is free text:**
  - `Done — YYYY-MM-DD (merged to main <sha>): …`
  - `In progress — …`
  - `Deferred — YYYY-MM-DD (not scheduled yet)`
  - `Not started`
- #39 (the Bulk actions hub, row 39) lists the live Bulk Actions tools. Add each new bulk tool to it.

### New in V3, Future Features
Reference tabs. They rarely change.

## Note formats (Feature Parity column G, Gaps column F)

- `COMPLETE YYYY-MM-DD (merged to main <sha>): <what shipped, where, and anything from V2 not carried over>.`
- `PARTIAL YYYY-MM-DD (merged to main <sha>): <what exists and what is missing>.`
- `RETIRED YYYY-MM-DD: <why, and which V3 tool covers it>.`
- **The Bulk actions hub notes** (Feature Parity G284 and Gaps F7) list every live Bulk Actions card and every merge sha under "later tools". Update both whenever a bulk tool ships.
- Write in American English, in plain sentences, and include the route.

## Checklist after a merge

1. Feature Parity: set E, F and G for each feature the work closes.
2. Gaps: update the matching row, if one exists.
3. The hub notes, if it's a Bulk Actions tool.
4. To-Do: set the item's status (plus #39 for bulk tools).
5. Summary: update the headline counts, the area row, and both percentages.
6. Zoom on the Summary to verify, then tell Jimmy exactly which rows changed.
