# Import assets — review, fix, and reprocess flagged rows

**Date:** 2026-09-02
**Branch:** `labels`
**Status:** Approved design

## Purpose

Close the dead end in the move-asset import: rows flagged `review`
(unmatched make/model) are currently dropped with no way to see what was
unmatched, fix the catalog, or re-run them. Add: structured review data on
the results, a "Missing make/models" fix surface (create the model, or map
the CSV string to an existing model — both via aliases so the fix is
durable), and a **Reprocess flagged** action that re-runs ONLY the flagged
rows as a child job through the normal validate→commit loop.

## Background facts (from the pipeline as-built)

- Per-row outcomes live only in `import_jobs.results` JSONB
  (`{"summary", "details"}`); review rows keep only
  `row/serial_number/status/message/match_method/serial_generated` — the
  make/model text survives only inside `message`.
- The uploaded file persists at `job.file_key` forever; `job.options`
  (`make_model_mode`, `generate_serials`) is retained. Reprocessing =
  re-parse the stored file.
- Matching: catalog key = `f"{make} {model}".strip().lower()`; aliases
  match at the same tier (`alias.lower()`, `match_method="fuzzy"`); a
  second-chance lookup runs the resolved
  `resolve_make_model_for_creation` split (strips doubled make prefixes).
- Commit gate 409s any job whose `phase != "validate"` — a finished
  commit job cannot be re-run today.

## API changes

### 1. Structured review details (`imports/move_assets.py`)

Review detail rows gain three fields (non-breaking; other statuses
unchanged):

```json
{ "row": 5, "status": "review", "message": "...", "match_method": "review",
  "serial_number": "96dxf2s", "serial_generated": false,
  "make_model": "Dell Dell PowerEdge R720",
  "suggested_make": "Dell", "suggested_model": "PowerEdge R720" }
```

`make_model` = the raw `make_model_str`; `suggested_make`/`suggested_model`
= the output of the existing `resolve_make_model_for_creation` heuristic.
Existing jobs keep their old shape — the portal falls back to parsing the
message string (`Make/Model '<x>' not found`).

### 2. Reprocess endpoint

`POST /initiatives/assets/import-jobs/{job_id}/reprocess`
(gate `initiatives:change`, same section as the other job routes):

- Parent must be `kind="move_assets"`, `status="completed"`, and its
  `results.summary.review > 0` — else 409 `no_review_rows` (missing/wrong
  kind stays 404 `import_job_not_found`; not-completed → 409
  `job_not_ready`). Any phase qualifies (a validate-phase parent with
  review rows may be reprocessed too).
- Creates a NEW `ImportJob`: same `kind`, `initiative_id`, `filename`,
  `file_key`; `phase="validate"`, `status="queued"`, `created_by` = actor;
  `options` = parent options + `{"only_rows": [<review row numbers from
  parent results, ascending>], "reprocess_of": "<parent id>"}`.
- Returns the child `ImportJobOut` (201). The parent is not mutated.

### 3. Worker row filter (`imports/worker.py` / `move_assets.py`)

When `job.options.only_rows` is present, after parsing the file keep only
rows whose `row` number is in that set (set membership, before
`run_import`). Everything downstream (validate/commit phases, counts,
details, collision flagging) behaves normally over the filtered set.
`total_rows` for the child = the filtered count.

## Portal changes (`ImportMoveAssets.tsx` + helpers)

### Review data extraction (`lib/moveAssetImport.ts`)

- `reviewMakeModel(detail): string | null` — `detail.make_model` when
  present, else parse `/Make\/Model '(.+)' not found/` from `message`.
- `missingMakeModels(details): { text: string; rows: number[]; suggested_make: string; suggested_model: string }[]`
  — distinct (case-insensitive) unmatched strings across review rows with
  their row numbers, suggested split from detail fields when present else
  a TS port of the doubled-make-prefix heuristic (strip a leading
  repeated first token up to twice; first remaining token = make, rest =
  model; single token → make = token, model = token).

### Missing make/models card

Rendered when the loaded job has review rows (any phase, completed):
one row per distinct missing string — the string (mono), "N rows", and
two `mini-btn` actions:

- **Create model…** — opens the existing `ModelEditModal` in create mode
  prefilled (`initial` prop added: `{ make: suggested_make, model:
  suggested_model }`). On save, if the CSV string ≠ the created model's
  `"make model"` display (case-insensitive), append the CSV string to the
  model's aliases (`setAssetModelAliases` with fetched-current + new).
- **Map to existing…** — a small dialog with a type-to-filter ComboBox
  over `listAssetModels()` (display "Make Model"); confirming appends the
  CSV string as an alias on the chosen model.

After either action the card row flips to a resolved state (green chip
"Ready — reprocess to apply") client-side; the reprocess run is what
actually consumes it. Both actions need `can('asset_models','add'/'change')`
respectively (alias mapping = change); users lacking those see the card
read-only with a hint ("Ask an admin to add these models.").

### Per-row Fix button

Review rows in the results table get a `Fix…` `mini-btn` (same permission
gating) opening the same fix dialog scoped to that row's string —
identical actions, shared implementation with the card.

### Reprocess flagged

Footer button next to the existing commit button, visible when the job is
`completed` with `review > 0` (validate or commit phase), gated
`can('initiatives','change')`: calls the new endpoint, then swaps the
page's job state to the returned child job (same page, polling resumes,
step indicator returns to Review). The user then uses the EXISTING Import
button to commit the child. A note above the table on a child job:
"Reprocessing N flagged rows from the earlier run." (derived from
`options.only_rows.length` / `reprocess_of`).

## Error handling

- Reprocess on a still-running parent → 409 `job_not_ready` surfaced via
  the existing `importErrorMessage` map (new entries: `no_review_rows`
  "Nothing is flagged for review.", `job_not_ready` reused).
- Alias append is read-modify-write via the existing PUT; a 409/404 shows
  the dialog's `pf-error`.
- Old-shape jobs (no `make_model` field) fully supported via the message
  parser; rows whose message doesn't match the pattern render without a
  Fix button (nothing to extract).

## Testing

- API: reprocess endpoint (child fields incl. only_rows content + order,
  parent untouched, 409s, 404, gate), worker filter (only filtered rows
  parsed/processed in both phases; counts reflect the subset), review
  detail structure (new fields present; non-review rows unchanged).
  End-to-end: import file with 1 matched + 2 unmatched rows → commit →
  create the missing model + alias → reprocess → child validate shows
  created; commit child → assets exist; re-reprocess parent still allowed
  (idempotent creation of another child).
- Portal: helpers (extraction incl. message fallback + suggested split
  port), card grouping/actions (modal prefill, alias append calls),
  per-row Fix, reprocess button swaps to child job and shows the banner,
  permission gating.
- Live: run against the REAL dev job `6a915416…` (78 review rows) — fix
  the distinct missing Dell/etc. models via the card, reprocess, commit,
  and confirm the roster gains the rows.

## Out of scope

Persisting a per-row import table (future shape); editing serials/other
CSV fields in-app (error rows still require a corrected re-upload);
auto-creating models without human confirmation (that's `force` mode,
which already exists).
