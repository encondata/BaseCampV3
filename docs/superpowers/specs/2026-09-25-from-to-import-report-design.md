# From-To import report (.xlsx) — design

**Date:** 2026-09-25
**Branch:** `import-report-xlsx` (worktree `.claude/worktrees/import-report`)
**Parity:** To-Do #8, the last open piece: the "Per-row outcome report" feature. The container importer and the general asset importer were retired on 2026-09-25, because parallel V3 tools cover them.

## Decisions

| Question | Decision |
|---|---|
| Format | `.xlsx`, for this report only. The bulk tools and the move wizard keep their CSV summaries. |
| When | The report can be downloaded after the check (showing what will happen) and after the import (showing what happened). |
| Approach | The browser builds the file with SheetJS (`xlsx`, already a portal dependency) from the job results the page has already loaded. No API change. |

## Where

On the From-To import page (`/initiatives/:id/import-assets`, `pages/ImportMoveAssets.tsx`), a **Download report (.xlsx)** `mini-btn` sits in the results header next to the counts.

- **Shown:** once the check job has completed (the validate phase), and again once the import has completed (the commit phase).
- **Hidden:** while a job is queued or running, and when a job failed or was cancelled.
- **Not shown elsewhere:** the move wizard also uses the shared `ImportReport`, but it does not get the button. The button belongs to the page, or it is a prop the wizard leaves unset.

## The workbook

It is built by `lib/importReport.ts::buildImportReport(input) → { filename, workbook }`, which is pure and unit-tested, plus a small download helper.

**Sheet "Rows"**: one line per detail row, covering every row in `job.results.details`, not only the 500 shown on screen.

| Column | Source |
|---|---|
| Row | `row` |
| Serial | `serial_number` |
| Result | `status`, shown as a label: created → Created, updated → Updated, review → Needs review, error → Error |
| Message | `message` |
| Make / model | `make_model_final`, blank when absent |
| Matched by | `match_method`, blank when absent |
| New asset | `asset_created` → Yes / No, blank when absent |
| Serial generated | `serial_generated` → Yes / No, blank when absent |

- The header row is bold and frozen, and the column widths fit the content, capped at 60 characters.
- Rows are sorted by row number.

**Sheet "Summary"**: label and value pairs:
- the move name;
- the file name the user uploaded;
- the report type, "Check (nothing imported yet)" or "Import";
- the time it was generated, as a local date and time;
- who generated it: the current user's name;
- the counts for Created, Updated, Needs review and Errors, taken from `results.summary` (with `created`, `updated`, `review` and `errors`);
- for an import, also Collisions flagged and Orphan nodes flagged, when they are present in the summary.

**File name**: `{move-slug}-from-to-{check|import}-{YYYY-MM-DD}.xlsx`.
- The move slug is the move name, lower-cased, with every run of characters other than letters and digits turned into `-` and dashes trimmed from both ends. It is capped at 40 characters, and falls back to `move` when empty.
- The date is local.

## Testing

- **`lib/importReport.test.ts`** covers:
  - the sheet names and headers;
  - one row per detail, including more than 500 rows;
  - the Result labels and the Yes/No values;
  - the summary values for check and import;
  - the file name, including the slug rules and the fallback.
- **`ImportMoveAssets.test.tsx`** gains tests showing that:
  - the button appears after a completed check and after a completed import;
  - the button is absent while a job is running and on a failed job;
  - clicking the button calls the download with the expected file name.

  The existing tests stay unchanged and passing.
- **The move wizard's AssetsStep tests** show no report button.

## Out of scope

- Switching the other bulk summaries to `.xlsx`.
- Server-side report generation.
- Emailing the report.
- Including the original spreadsheet columns in the report.
