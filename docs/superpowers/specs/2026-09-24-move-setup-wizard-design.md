# Create a move in steps — design

**Date:** 2026-09-24
**Branch:** `move-setup-wizard` (worktree `.claude/worktrees/move-setup`)
**Parity:** To-Do #6, feature "One-shot move creation". In V2, one workbook with tabs for assets, crates, trucks and crew created a whole move in a single action. V3 replaces that with a guided wizard. Nothing is saved until the last step, and then everything is created together.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Shape | A wizard with one screen per step. The header reads "Step x of 5". Steps: the move → From-To assets → crates → trucks → review and create. |
| Saving | **Nothing is saved until the last step.** The wizard's state is a server-side draft. "Create move" builds the move, the assets, the crates and the trucks in one transaction; a failure creates nothing. |
| Optional steps | Assets, crates and trucks can each be skipped, or given a count of 0. The move itself is always required. |
| Step 1 | The full move form, as "New initiative" shows it for a move. The type is fixed to Move. Name, origin site and destination site are required. |
| Crates | A naming convention prompt prefilled from the site codes, e.g. `CRT-SJC-DAL-xxx`. The x's mark the number and set its padding. Also count, start number, a live preview, crate type, and label-tag counts. |
| Trucks | The same convention prompt, e.g. `TRK-SJC-DAL-xxx`, with count, start number and a live preview. Every truck is attached to the move and starts at the origin and ends at the destination. Other truck fields are filled in per truck later. |
| End | Step 5 "Review and create" shows a summary. "Create move" runs as a background job with progress. The finish screen shows the per-row asset summary with CSV, the counts, and "Open the move". |
| Entry | **Admins only:** a Bulk Actions card leading to `/bulk/new-move`. It is its own route, so a button elsewhere can link to it later. |
| Approach | A server-side draft job applied by the import worker. The alternatives were a browser-held draft and a hidden draft move; both were rejected. |

## Screens

Every screen shares one header, `WizardHeader`:
- a "Bulk Actions" eyebrow;
- "Step x of 5 · {title}";
- a one-line description;
- the numbered step row, showing done, current and upcoming steps (the `rgm-steps` look from Generate Report and printer setup).

The footer has **Back**, **Skip this step** (steps 2–4 only), and **Next**. Back keeps what was entered.

1. **Step 1 of 5 · The move.**
   - The move fields: name, client, status, color, dates, origin and destination sites, shipping types, and partners.
   - Next validates them and creates the draft. Nothing else is written.
2. **Step 2 of 5 · From-To assets.**
   - Upload a From-To file (csv / xlsx / xls). The background check runs with a progress bar.
   - The review matches the import page: counts for new, updated, needing review and errors, the per-row table, and "Fix make/model" per unknown group, followed by **Check again**, which re-checks the whole file.
   - Rows still needing review are not imported, just as today.
   - A new upload replaces the previous file and check.
3. **Step 3 of 5 · Crates.**
   - The convention, prefilled as `CRT-{origin code}-{destination code}-xxx`, or `CRT-xxx` when a site has no code.
   - Count (0–500), start number (default 1), crate type (required when the count is above 0), and label-tag counts, as in "Add in bulk".
   - A live preview of the names, with any clash against existing non-archived crates flagged. Next is blocked while there is a clash.
4. **Step 4 of 5 · Trucks.**
   - The convention, prefilled as `TRK-{origin code}-{destination code}-xxx`.
   - Count (0–100), start number, a live preview, and clashes flagged against existing trucks.
5. **Step 5 of 5 · Review and create.**
   - A summary: the move's details; the asset counts, with the per-row list; the crate names and type; the truck names; and "Skipped" for any skipped step.
   - **Create move** queues the job and polls every 1.5 s, showing "Creating… N of M".
   - The finish screen shows:
     - "Move created" with **Open the move** (`/initiatives/{id}`);
     - the asset import's per-row summary with a CSV download;
     - "N crates created" and "N trucks created".
   - On failure it shows the reason as a sentence, and the draft stays editable so the user can fix it and press Create again.

**Leaving the page** with a draft open asks "Discard this move setup?". Confirming deletes the draft.

## Naming convention rule (shared by the API and the portal)

- The convention holds exactly one run of the letter x, case-insensitive. The number replaces that run.
- The number is padded with zeros to the run's length, e.g. `xxx` gives 001. A number longer than the run is not truncated.
- Everything else in the convention is literal text.
- Names are `start + i` for `i` in `0 … count-1`.
- These are errors, each shown as a sentence:
  - no run of x's;
  - more than one run;
  - a count out of range;
  - a start number below 0;
  - a clash with an existing name.
- Names are compared case-insensitively. Crates follow the existing `/containers/bulk` rule; trucks are checked against non-archived trucks.

## Data

**No migration.** A draft is one `import_jobs` row:
- `kind = "move_setup"`, `status = "preview"`, `initiative_id = NULL` until creation, owned by `created_by`;
- `payload`:
  ```
  {
    "move":   { …InitiativeCreateIn fields, initiative_type "move" },
    "assets": { "check_job_id": uuid, "filename": str } | null,
    "crates": { "convention", "count", "start", "container_type", "tags": {tag: n} } | null,
    "trucks": { "convention", "count", "start" } | null
  }
  ```
- The asset check is an ordinary `move_assets` job:
  - `initiative_id` is NULL and `options.move_setup_id` holds the draft id;
  - its `phase` is `validate`, and its file is stored as today's import stores it.
  - The worker's validate pass runs with `initiative_id = None`, which works because a new move's roster is empty.
  - Such a job can never be committed on its own: the existing commit route rejects a job with no move.

## API (`api/routes/move_setup.py`, prefix `/bulk/move-setup`)

Every route requires admin bulk rank (`require_bulk_rank`), `initiatives:add`, `containers:add`, `trucks:add`, and a global actor. A draft belongs to its creator; anyone else gets 404 `draft_not_found`.

| Method / path | Body | Returns |
|---|---|---|
| `POST /bulk/move-setup` | the move fields | the draft (201). Validated with the same `_check_refs` rules as creating a move, plus name, origin and destination required |
| `GET /bulk/move-setup/{id}` | – | the draft: payload, status, progress, results, error |
| `PATCH /bulk/move-setup/{id}` | `{move?, crates?, trucks?, skip?: ["assets"\|"crates"\|"trucks"]}` | the draft plus `previews: {crates: {names, clashes}, trucks: {names, clashes}}`; only while status is `preview` or `failed` |
| `POST /bulk/move-setup/{id}/assets` | multipart `file`, `make_model_mode`, `generate_serials` | the queued check job; replaces any previous check |
| `POST /bulk/move-setup/{id}/assets/recheck` | – | a new check job over the same stored file |
| `POST /bulk/move-setup/{id}/create` | – | the draft, now `queued`. Re-validates first. 422 `setup_invalid` with the reasons as sentences when the move fields are invalid, a name clashes, or the asset check isn't `completed` |
| `DELETE /bulk/move-setup/{id}` | – | 204; only while status is `preview` or `failed` |

Check jobs are polled through the existing `GET /initiatives/assets/import-jobs/{job_id}`. It is ownership-checked; its handling of jobs with no move must be verified.

## Create (worker, kind `move_setup`)

Everything below runs in one transaction on the job's session:

1. Create the `Initiative` from `payload.move`, with a color from `_next_color` when none was given, and write its create audit.
2. If assets are included, re-read the stored file, re-parse it, and call `run_import(..., write=True, commit=False)`. The new `commit` flag (default True) suppresses the per-batch commits so the caller owns the transaction. Rows needing review are excluded. The import's own recheck and audit run.
3. If crates are included, create them through `containers/bulk_create.py::create_containers(db, …)`. That code moves out of `POST /containers/bulk` so both use the same logic, and that route behaves the same.
4. If trucks are included, create them through `trucks/bulk_create.py::create_trucks(db, names, initiative_id, start_site_id, end_site_id, actor)`, one audit row per truck.
5. Write a `bulk_import` audit (entity `initiative`), set the job `completed` with `initiative_id` and `results = {move_id, assets: {summary, details}, crates: n, trucks: n}`, set `payload = None`, and commit.

**Progress:** `processed_rows` / `total_rows` count the asset rows plus the crates plus the trucks. They are written through a second session every 250 units, the same pattern as the asset bulk update.

**Failure:** any exception, including a unique-name race, rolls back. The job becomes `failed` with a sentence code: `name_taken`, `setup_invalid`, `apply_conflict`, or `worker_error`. The draft's payload is kept so the user can retry.

**Sweep:** the import worker deletes `move_setup` drafts in `preview` or `failed` that have been untouched for 24 hours, along with their check jobs. The same sweep clears abandoned `asset_bulk_update` previews older than 24 hours.

## Portal

- **Page and card:**
  - `pages/BulkNewMove.tsx` at `/bulk/new-move` (admin rank). It holds the draft id and the current step.
  - A `BULK_TOOLS` card titled "Create a move in steps": "The move, its From-To assets, crates, and trucks — reviewed, then created together."
- **Shared header:** `components/common/WizardHeader.tsx`.
- **Steps** live in `components/moveSetup/`: `MoveStep`, `AssetsStep`, `CratesStep`, `TrucksStep` and `ReviewStep`.
- **Shared pieces pulled out, with no visual change** to the existing pages:
  - `InitiativeFields`, from `InitiativeEditModal`. The modal keeps working as today.
  - The import review (progress bar, counts, per-row table, Fix make/model flow), from `ImportMoveAssets.tsx`. The import page keeps working as today.
  - `NamingConvention`: the convention, count, start, preview and clashes, with the rule mirrored in `lib/namingConvention.ts`.
- **Finish screen:** the asset summary uses the existing per-row summary plus CSV.
- **Errors:** a `MOVE_SETUP_ERRORS` map, written as sentences in American English.

## Testing

- **API:**
  - drafts: creation, validation, ownership, PATCH with previews and clashes, and skip;
  - the naming rule;
  - an asset check with no move;
  - create: everything appears, with the counts and audits;
  - create with every optional step skipped;
  - a failure partway through (a clash that appears after the check) leaves no move, no assets, no crates and no trucks;
  - progress; the payload cleared once created; the sweep;
  - `POST /containers/bulk` unchanged after the extraction;
  - the existing move-asset import tests pass with `commit=True`.
- **Portal:**
  - the header, and Back / Skip / Next through each step;
  - the discard prompt;
  - the preview, clash and review screens;
  - progress, then the finish screen;
  - the existing `InitiativeEditModal`, `ImportMoveAssets` and `BulkContainersModal` tests still pass.
- **Live:**
  - create a move from a real From-To file, with crates and trucks;
  - check that the move page, the containers list and the trucks list show them;
  - one run with every optional step skipped.

## Out of scope

- V2's one-workbook upload (tabs for assets, crates, trucks and crew).
- Crew or team assignment; the job-team bulk tool covers it.
- Editing individual trucks inside the wizard.
- Entry points outside Bulk Actions.
- Resuming a draft after leaving the page.
