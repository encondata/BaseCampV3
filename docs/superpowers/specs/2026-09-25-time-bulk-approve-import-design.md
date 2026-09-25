# Bulk time approval and punch import — design

**Date:** 2026-09-25
**Branch:** `time-bulk` (worktree `.claude/worktrees/time-bulk`)
**Parity:** To-Do #17 "Add bulk approval and bulk punch import". V3 approves one time entry at a time, which does not scale to a payroll run. V2 could also load punches from another timekeeping system or from a spreadsheet.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Bulk approval | Checkboxes on pending rows with **Approve selected** and **Reject selected**, plus **Approve all pending in this view**, which uses the current filters and so also reaches rows not loaded on screen. |
| Approval API | New bulk endpoints that apply the same per-entry rules as single-row approval. The portal does not loop over the per-row calls. |
| Import shape | **One row per shift**: worker, clock in, clock out, break, job, site, notes. |
| Imported status | **Pending**, with source `import`. Imported shifts go through normal approval. |
| Overlaps | A shift that overlaps the worker's existing time, or another row in the file, is a row **error**. An exact repeat is skipped as "already there". |
| Time zone | A time without an offset is read in the row's **site time zone**, falling back to America/New_York. An explicit offset is taken as written. |
| Where the import lives | A seventh Bulk Actions tool, **Add time punches in bulk** (`/bulk/time`), built on the same layout as the others. |

## Part 1 — Bulk approval (`/people/time`, Timesheet list)

### Portal (`pages/TimeManagement.tsx`)

**Selection**
- A checkbox column comes first. Only pending rows have a checkbox; other rows get an empty cell so the columns stay aligned.
- The header checkbox selects every pending row currently shown. It goes indeterminate when only some are selected.
- Follow the Print Labels picker pattern (`components/labels/PrintAssetList.tsx`): a `Set` of ids, `toggleOne` and `toggleAll`, and a header `indeterminate` ref.

**Toolbar**
- "N selected" appears with **Approve selected** and **Reject selected**, shown only when something is selected.
- **Approve all pending in this view** shows whenever the current filters match any pending rows.
  - It first calls the API with `dry_run`, then confirms: "Approve 214 pending entries that match these filters?"
  - It then sends the filter, not the loaded ids.
- **Reject selected** opens a small dialog with a required reason. That one reason applies to every selected entry. The dialog uses the modal header pattern.

**Access:** all of this requires `time:change`, the same permission as single-row approval. Users without it see no checkboxes and no bulk buttons.

**After a run**
- A `set-note` line reports the result, for example: "Approved 212 entries. Skipped 2: your own entry (1), no longer pending (1)."
- A **Show skipped** toggle lists the skipped entries by person, date and reason.
- The list refreshes and the selection clears.

### API (`api/routes/time.py`)

| Method / path | Body | Returns |
|---|---|---|
| `POST /time/entries/approve` | `{entry_ids: [uuid…]}` or `{filter: {person_id?, initiative_id?, site_id?, from?, to?}}`, exactly one of the two. `?dry_run=1` counts without writing. | `{approved: n, skipped: [{entry_id, person, date, reason}]}`. With `dry_run`, `{count: n}` is the number that would be approved. |
| `POST /time/entries/reject` | `{entry_ids: [uuid…], reason: str}`. The reason is required and non-blank. | `{rejected: n, skipped: [...]}` |

- **Gate:** `require_permission("time", "change")`, the same as the single-row routes.
- **Filter:** the same person, job, site and date semantics the Timesheet list uses. Read `GET /time/entries` and reuse its filter code rather than duplicating it. A filter always means pending entries only.
- **Per-entry rules, identical to single-row approve and reject:**
  - the entry must be `pending`; otherwise it is skipped with "no longer pending";
  - it must not be the actor's own entry; otherwise "your own entry";
  - it must be visible to the actor; otherwise "not found".
- **Transaction:** the qualifying entries are updated in one transaction. Approve sets `status`, `approved_by`, `approved_at` and `updated_at`. Reject sets `status`, `reject_reason` and `updated_at`.
- **Audit:** one audit row per entry, the same audit shape as the single-row route.
- **Limit:** at most 5,000 entries per call, whether given as ids or matched by the filter. Above that the route returns 422 `too_many`, and the portal says: "More than 5,000 entries match. Narrow the filters and try again."
- **Concurrency:** entries are locked `FOR UPDATE` before their status is checked, so a concurrent single-row action cannot race the bulk run.

## Part 2 — Punch import (Bulk Actions, `/bulk/time`)

**Access:** admin bulk rank (`require_bulk_rank`) plus `time:add`, with a global actor. The card is titled "Add time punches in bulk", with the description "Load shifts from a spreadsheet or another timekeeping system. Workers, jobs, and sites are matched by name; review every shift before adding."

### Page

The page follows the other Bulk Actions tools exactly: hint, then Columns, then Download, then Upload. The preview table has the columns Row / Name / Matched by / Action / Details with `bulk-row-*` tinting, and per-line match dropdowns and Skip sit inside Details, as in the job-team tool. It offers **Skip all unmatched** and **Add N shifts**, and ends with `BulkApplySummary` and its CSV. See memory: bulk tools match the existing layout.

**Downloads:** Template (.xlsx) and Template (.csv). There is no "Current …" download, because this tool only adds.

**Limit:** 5,000 rows and 5 MB.

### Columns

| Column | Required | Accepts |
|---|---|---|
| `worker` | yes | Email, phone, or full name, matched like the workers tool. Email wins, then phone, then name via `name_keys`, among live workers. |
| `clock_in` | yes | A date and time, e.g. `9/24/2026 7:00 AM`, `2026-09-24 07:00`, an Excel date-time cell, or ISO 8601 with an offset. |
| `clock_out` | yes | The same formats. |
| `break_minutes` | | A whole number, 0 or more. Blank means 0. |
| `job` | | An existing, non-archived initiative, matched by name, case-insensitive. |
| `site` | | An existing, non-archived site, matched by name or code, case-insensitive. |
| `notes` | | Free text. |

### Time zone

- A clock-in or clock-out with an explicit offset is taken as written.
- Otherwise the time is local to the row's site `timezone`. That site is the one matched or picked for the row, or the job's site when the row gives none. When no site applies, or the site has no timezone, the time is local to `DEFAULT_TIMEZONE` (America/New_York).
- Daylight-saving gaps and overlaps resolve by the standard rule: `zoneinfo`, `fold=0`.
- The preview shows each shift in the zone it was read in, for example "Sep 24, 7:00 AM – 3:30 PM PDT", along with the shift length.

### Row outcomes (preview)

| Action | Meaning |
|---|---|
| `add` | The shift is valid and new. |
| `duplicate` | An exact repeat of an existing entry for that worker, with the same clock-in and clock-out to the minute. It shows as "Already there" and is skipped at apply. |
| `attention` | The worker, job or site is unknown or matches more than one record. The Details cell carries a dropdown per issue plus Skip. The dropdowns are portaled `ComboBox`es, with the candidates listed first. |
| `error` | A sentence describing the problem (listed below). |
| `skipped` | The user skipped the row. |

**Errors, as sentences:**
- a missing worker, clock-in or clock-out;
- a time that cannot be read;
- clock-out not after clock-in;
- a shift longer than 24 hours;
- a clock-in in the future;
- a break at least as long as the shift;
- a negative or non-number break;
- an overlap with the worker's existing time entry, naming its date and times;
- an overlap with another row in this file, naming that row.

**Overlap rules:**
- Two spans overlap when `a.in < b.out and b.in < a.out`.
- An existing entry that is still open (`clock_out` null) overlaps anything after its clock-in.
- Rejected entries are ignored for overlap purposes.

**Re-preview:** picks and skips re-preview with `{overrides, skip}` keyed by spreadsheet row, as in the job-team tool. JSON re-posts carry `row_numbers`.

`can_commit` is true when there are no `attention` or `error` rows and at least one `add` row.

### API (`api/routes/time.py` or a new `routes/time_bulk.py`)

| Method / path | Body | Returns |
|---|---|---|
| `GET /time/bulk/template?format=csv\|xlsx` | – | the template file |
| `POST /time/bulk/preview` | multipart `file`, or JSON `{rows, row_numbers, overrides, skip}` | the preview |
| `POST /time/bulk/commit` | the same body as preview | `{summary: {added, skipped}, rows: [{row, name, entry_id, action, detail}]}`; 422 `rows_invalid` when the file cannot be committed |

### Apply

The commit runs the preview again and refuses with `rows_invalid` unless the result is committable. It then works in one transaction:

1. Each `add` row becomes a `time_entries` row with:
   - `source = "import"` and `status = "pending"`;
   - `person_id`, `initiative_id` and `site_id` from the match;
   - `clock_in_at` and `clock_out_at` in UTC;
   - `break_minutes` and `notes`;
   - `created_by` set to the actor, and `adjusted = false`.
2. Each entry gets one audit row (`entity_type="time_entry"`, `action="import"`).
3. The run writes one `bulk_import` audit row with the counts and the source filename.
4. Overlaps are checked again inside the transaction, with the workers' entries locked. A shift that now overlaps, for example one punched at a kiosk in the meantime, refuses the whole run with `rows_invalid`, naming the row.
5. Commit.

**No migration:** `time_entries.source` is plain text with no check constraint. The portal's source label map gains "Import", wherever source is displayed.

## Testing

**API**

Bulk approve and reject:
- by ids and by filter;
- `dry_run` counts;
- skip reasons: not pending, own entry, invisible;
- the 5,000 cap;
- one audit row per entry;
- a reject reason is required;
- `time:change` is required, and staff get 403.

Import:
- the template;
- each worker, job and site matching path, plus unknown and ambiguous values, with picks and skips;
- time parsing: formats, Excel serials, explicit offsets, site timezone, the default timezone, and a DST edge;
- every error sentence;
- overlap against existing entries, including open ones, and ignoring rejected ones;
- overlap within the file;
- exact duplicates;
- an all-or-nothing commit;
- the overlap re-check at commit refusing the run;
- rank and permission gating.

**Portal**

Timesheet:
- checkboxes appear on pending rows only;
- select-all, including the indeterminate state;
- Approve selected and Reject selected (with the reason dialog);
- "Approve all pending in this view" with `dry_run`, then the confirm;
- the skipped note and toggle;
- no checkboxes without `time:change`.

The import page:
- the layout matches the other tools;
- per-line matching;
- Skip all unmatched;
- the Add N shifts button text;
- the summary.

**Live:** import a small file on the dev stack, check that the shifts appear as pending in the Timesheet, then approve them with "Approve all pending in this view".

## Out of scope

- Punch-per-row (event) files.
- Replacing or updating existing entries from a file.
- Importing shifts as approved.
- A time-zone picker.
- Exporting existing time in the template layout.
- Un-approving in bulk.
