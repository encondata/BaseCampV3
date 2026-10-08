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
- `read_file_content` sometimes returns only a few sample rows. For a full, cell-exact copy use `download_file_content` with `exportMimeType` `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`, then `jq -r .content <file> | base64 -d > sheet.xlsx` and read it with openpyxl (`api/.venv/bin/python`). Recount the Summary from it, and re-download after writing to verify every cell.
- **Jimmy edits the sheet too, often on the Gaps tab** (retiring items or marking them Complete without touching Feature Parity). Before recounting, diff Gaps status against Feature Parity by (Area, Feature) and carry his changes into Feature Parity column E, so the Summary counts include them.

## How to write it

The connector can't write cells, so write through **Claude in Chrome**, in the tab that has the sheet open.
- Load the tools in one ToolSearch call: `tabs_context_mcp`, `computer`, `browser_batch`, `find`.
- **Always address a cell by the name box.** Click the name box (top-left, about (45, 102) in a 1512×784 frame), type the reference (e.g. `G305`), press Return, type the value, press Return.
- **Never press a bare Return to step over a cell.** It once opened a cell for editing and scrambled the Summary.
- **Confirm a row before writing.** Name-box to `B<row>` and read the formula bar with a `zoom` on the region (0, 90, 1512, 115). Row estimates drift.
- A percentage in the Summary is **text**: type it with a leading apostrophe (`'84%`).
- Status cells are dropdown chips. Type the exact label and press Return.
- **Line breaks inside one cell:** cmd+Return only works on every other press. Instead, enter `=JOIN(CHAR(10), {"• line one", "• line two"})`, then copy the cell and paste values only (cmd+shift+v) so it becomes plain text.
  - **Check the paste before committing it.** Load the formula with `LANG=en_US.UTF-8 pbcopy`, open the cell (Return), paste, then zoom on the formula bar. It must start with `=JOIN(`, and only then press Return.
  - **Why:** in a freshly opened tab the first paste can come up empty. The copy-to-values step's cmd+c then copies the blank cell, overwriting the clipboard. Both happened on 2026-10-08 and blanked the Weekly Summary cell until it was re-pasted.
  - **After converting,** zoom again: the formula bar must show text starting with `•`.
- **Switch tabs by clicking the tab name at the bottom.** Take a screenshot first; tab positions shift when tabs are added.
- Batch several actions per `browser_batch`, then verify with a zoom or screenshot.

## Tabs and columns

### Summary
- **Headline** (column B), refactored 2026-09-29:
  - B5: V2 features carried forward
  - B6: built in V3
  - B7: partially built
  - B8: not built yet
  - B9: pending (testing, a later phase, or a decision)
  - B10: deliberately retired
  - B11: new capabilities in V3
  - B12: parity, as text
- **By area table:** the header is row 16 and areas run from row 17 (Dashboards) to row 38 (Legacy). Columns: A Area, B Complete, C Partial, D Not built, E Retired, F Pending, G New in V3, H Parity (text), I Priority, J Expected Date, K Notes.
  - **Columns I to K are Jimmy's.** He fills them in and edits them live; never write to them.
  - A zero count is a blank cell (select it and press Delete), not `0`.
  - G (New in V3) is counted from the **New In V3 tab**, not from Feature Parity rows.
- **Legend** rows 42 to 52 explain every status, including how each one counts.
- **Status buckets** (count from Feature Parity column E):
  - Complete → B. Partial → C. Not built → D.
  - Retired and Abandoned → E.
  - Pending Testing, Pending Future Testing, Pending Future and Pending CSG Decision → F.
  - New in V3 and Future Enhancement Beyond V2 are not counted in this table.
- **Math:**
  - carried forward = built + partial + not built + pending
  - parity = (built + (partial + Pending Testing + Pending Future Testing) / 2) / carried forward, rounded half-up
  - Pending Future and Pending CSG Decision count as zero toward parity.
  - Area parity uses the same formula on that area's row.
- **When one row changes,** move 1 between the buckets above in the headline and the area row, then recompute both percentages. Easiest is to recount everything from a fresh xlsx download.

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

### Status dropdown (Feature Parity and Gaps column E)
- Both tabs share one validation rule (Feature Parity E5:E449, Gaps E2:E106) with these options: Complete, Partial, Not built, Retired, New in V3, Abandoned, Pending Testing, Pending Future Testing, Pending Future, Pending CSG Decision, Future Enhancement Beyond V2. The Pending chips are orange and Future Enhancement is purple.
- To add a status, edit the Feature Parity rule (Data › Data validation), then copy a Feature Parity status cell and paste it onto Gaps E2:E106 with Edit › Paste special › Data validation only.
- **Typing a status that is a prefix of another autocompletes.** "Pending Future" becomes "Pending Future Testing" in a plain cell. Press Delete before Return, then read the cell back.

### Gaps
- Columns: A Area, B Feature, C What it does, D In V2, E V3 status, F Notes / gap.
- It lists only some features, so check whether a feature is listed before writing.
- When a feature's status changes, keep its Gaps row in sync with Feature Parity.
- **Sorted by Area, A to Z** (Jimmy, 2026-10-08). Inside an area the rows keep their existing order.
  - **To add a row:** insert it at the end of its area's block (right-click a row number › Insert 1 row below), or append it after the last row. Then select `A2:F<last>` and run Data › Sort range › Sort range by column A (A to Z). The sort is stable, so each area keeps its order.
  - **Never sort row 1** (the header). Keep the status dropdown's range (`E2:E<last>`) covering any new rows.
- **Find rows by Area + Feature, not by a remembered number.** Every new row or re-sort shifts the numbers. Name-box to the row, then read `B<row>` before writing.
- **Elsewhere in the sheet,** refer to a Gaps item by its feature name ("Gaps: Timesheet report"), never "Gaps row N". The Weekly Summary bullets follow this rule.
- Rows as of 2026-10-08 (confirm before use):
  - 9: Bulk actions hub
  - 11: Bulk update existing assets
  - 17: One-shot move creation
  - 19: Spreadsheet reformatting tool
  - 30: Bulk edit of the assigned team
  - 62: Timesheet report
  - 97: Bulk approve
  - 98: Bulk import of time punches

### To-Do
- Columns: A #, B Priority, C Time estimate, D Area, E What to build, F Why it matters, G Features it closes, H Rows, I Status.
- **Row map:** items #1–#12 sit on row N+1. #14–#39 sit on row N (there is no #13). There is no #40 or #44, so #41–#43 sit on rows 40–42 and #45–#50 on rows 43–48. Always confirm by reading column A.
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
- **The Bulk actions hub notes** (Feature Parity G284 and the Gaps "Bulk actions hub" row's column F, row 9 as of 2026-10-08) list every live Bulk Actions card and every merge sha under "later tools". Update both whenever a bulk tool ships.
- Write in American English, in plain sentences, and include the route.

## Checklist after a merge

1. Feature Parity: set E, F and G for each feature the work closes.
2. Gaps: update the matching row, if one exists.
3. The hub notes, if it's a Bulk Actions tool.
4. To-Do: set the item's status (plus #39 for bulk tools).
5. Summary: update the headline counts, the area row, and both percentages.
6. Zoom on the Summary to verify, then tell Jimmy exactly which rows changed.
