# Convert Raw F-T — rename, collapsed columns, three steps

Date: 2026-10-06. Branch `raw-ft-steps`. Revises the tool built on
2026-10-05 (`docs/superpowers/specs/2026-10-05-convert-customer-from-to-design.md`).
That spec's reading, suggestion, conversion and output rules stay as they
are; only the name, route and page flow change.

## Name and route

- Card title and page name **Convert Raw F-T**. Card description: **Upload
  a customer's raw F-T, match its columns to ours, and download a file
  ready for the From-To import.** Button **Open**. Card key `convert-raw-ft`.
- Route `/bulk/convert-raw-ft` (the old `/bulk/from-to-convert` is removed,
  no redirect; it shipped a day earlier). Gating unchanged: card
  `resource: 'initiatives', action: 'change'`; route
  `<ProtectedRoute resource="initiatives" minRank={ADMIN_RANK}>`.

## Three steps

Same chrome as Create a move in steps: `WizardHeader` (eyebrow Bulk
Actions, "Step x of 3 · Title", description, numbered step row) and
`WizardFooter` (Back on the left, the solid primary on the right).

| # | key | label | title | description |
|---|---|---|---|---|
| 1 | upload | Upload | Upload the raw F-T | Drop in the customer's file. It's read in this browser and never uploaded. |
| 2 | match | Match | Match columns | Pick which of our columns each of theirs fills. Suggestions are filled in; change any of them. |
| 3 | download | Download | Preview and download | Check the converted rows, then download a file ready for the From-To import. |

1. **Upload:** the drop zone; "Reading the file…" while parsing; read
   errors; once read, the Sheet ComboBox (2+ sheets with data) and Header row
   input. Below them the template downloads **Template (.xlsx)** and
   **Template (.csv)** (mini buttons) and the note **The converted file is
   built in your browser. The From-To import accepts files up to 20 MB.**
   Then a **CollapsePanel** titled **Our template columns** with a
   `badge-count` badge of the column count, **always starting collapsed**
   (uncontrolled, not tied to the List view preference), holding the
   Column / Required / Accepts / Example table (`ariaLabel="Template
   columns"`). Footer: **Next**, disabled until a sheet with data is loaded
   (and while reading).
2. **Match:** the "{n} of {m} columns matched" line with **Clear all** /
   **Use suggestions**, the Serial Number note when unmatched, and the
   Column matches table. Footer: **Back**, **Next** disabled until at least
   one column is matched.
3. **Download:** the Converted preview table (first 10 rows), the counts
   line, a **Start over** mini button (clears the file and returns to step
   1), and the hint **Import it from a move's Import assets page or in Create
   a move in steps.** Footer: **Back**, primary **Download converted file**.

State lives on the page for the whole session, so Back keeps everything.
Choosing a different file, sheet or header row on step 1 starts the matches
over from the suggestions (as today). Nothing is saved or uploaded, so
there is no draft and no leave prompt.

While the template columns load or fail, the body shows the existing
loading / 403 / error lines in place of the steps.

## Structure

- `useRawFtConvert(template)` hook (state + derived values + actions,
  moved out of today's pane) in `portal/src/components/bulk/rawFt/`.
- One presentational component per step in the same folder, plus
  `RAW_FT_STEPS` (the table above).
- `pages/BulkConvertRawFt.tsx` replaces `pages/BulkFromToConvert.tsx`;
  `components/bulk/FromToConvert.tsx` is removed. `lib/ftConvert.ts` is
  unchanged.
