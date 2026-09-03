# Import Review + Reprocess Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flagged import rows become fixable — structured review details, a missing-make/models fix surface (create model or map-to-existing, both alias-backed), and a Reprocess-flagged action that re-runs only review rows as a child job through the normal validate→commit loop.

**Architecture:** Review detail rows gain `make_model`/`suggested_make`/`suggested_model` (old jobs supported via message-parsing fallback in the portal). `POST /initiatives/assets/import-jobs/{id}/reprocess` clones the job (same stored file + options) with `options.only_rows` = the parent's review row numbers; the worker filters parsed rows by that set. Portal: fix dialog shared by a distinct-missing card and per-row Fix buttons; fixes write through existing asset-model + alias endpoints so they're durable for all future imports.

**Tech Stack:** FastAPI/SQLAlchemy async/pytest (real Postgres + object storage as existing import tests use it); React/TS/vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-02-import-review-reprocess-design.md`

## Global Constraints

- All suites FOREGROUND, one continuous run, `timeout: 600000` ms — NEVER background a run, never use Monitor, never end a turn "waiting". API: `cd api && .venv/bin/pytest` (1002 at branch HEAD `db0be9d`). Portal: `cd portal && npm test` (768) + `npm run build`.
- `git checkout -- api/src/serversherpa/_dev_reload.py` if dirty; never commit it.
- Reprocess contract: parent must be `kind="move_assets"` + `status="completed"` + `summary.review > 0`; wrong/missing id → 404 `import_job_not_found`; not completed → 409 `job_not_ready`; zero review rows → 409 `no_review_rows`. Child: `phase="validate"`, `status="queued"`, same file_key/filename/initiative/kind, `created_by`=actor, `options` = parent options + `{"only_rows": [ascending review row numbers], "reprocess_of": "<parent id>"}`. Parent never mutated. Gate `initiatives:change`.
- Worker filter: when `options.only_rows` present and non-empty, keep only parsed rows whose `row` number is in the set — BEFORE run_import; both phases; `total_rows` = filtered count.
- Review details gain `make_model` (raw make_model_str), `suggested_make`, `suggested_model` (from `resolve_make_model_for_creation`); non-review rows unchanged; old-shape jobs must keep working end to end in the portal (message-string fallback `/Make\/Model '(.+)' not found/`).
- Alias-backed fixes: creating a model from a review string also appends the CSV string as an alias when it differs (case-insensitively) from `"make model"`; mapping to an existing model always appends the alias. Aliases are append (read-modify-write over the existing PUT), never clobber.
- Permissions: card/Fix actions need `asset_models:add` (create) / `asset_models:change` (map); reprocess button `initiatives:change`; read-only users see the card with the hint "Ask an admin to add these models."
- API errors `{"detail": {"code": ...}}`; portal error copy via `importErrorMessage` (new entry `no_review_rows`: "Nothing is flagged for review.").

---

### Task 1: Structured review details + worker `only_rows` filter

**Files:**
- Modify: `api/src/serversherpa/imports/move_assets.py` (review detail fields)
- Modify: `api/src/serversherpa/imports/worker.py` (row filter after parse)
- Test: `api/tests/test_import_reprocess_pipeline.py`

**Interfaces:**
- Consumes: existing `parse_row` output (`r["row"]`, `r["asset_make"]`, `r["asset_model"]`, `r["make_model_str"]`), `resolve_make_model_for_creation(make, model) -> tuple[str, str]`, `run_import`, worker `process_job` flow (parse at worker.py:39-55).
- Produces: review detail rows shaped `{row, serial_number, status:"review", message, match_method:"review", serial_generated, make_model: str, suggested_make: str, suggested_model: str}`; worker honors `job.options["only_rows"]` (list of ints) in both phases.

- [ ] **Step 1: Write the failing tests `api/tests/test_import_reprocess_pipeline.py`**

Model the fixture/driving mechanics on the EXISTING `api/tests/test_import_worker.py` and `test_move_asset_import_validate.py` (read them first — reuse their helpers for building a CSV upload, creating a job, and running `run_once`/`process_job`; do not invent a parallel harness). The tests to add, expressed against that harness:

```python
"""Reprocess pipeline: structured review details + only_rows filtering."""

# Reuse the existing import-test helpers (CSV builder, job factory, worker
# runner) from tests/test_import_worker.py — import or copy per that
# file's own conventions.

CSV_ROWS = [
    # header per the import template; then:
    # row 2: serial S1, make "Cisco", model "Nexus 9336C"  -> matches seeded/created model
    # row 3: serial S2, make "Dell",  model "Dell PowerEdge R720" -> unmatched -> review
    # row 4: serial S3, make "HPE",   model "DL380"        -> unmatched -> review
]


async def test_review_details_carry_make_model_fields(db, ...):
    # create AssetModel make="Cisco" model="Nexus 9336C" first
    # upload CSV, run worker (validate phase)
    details = job.results["details"]
    review = [d for d in details if d["status"] == "review"]
    assert {d["make_model"] for d in review} == {
        "Dell Dell PowerEdge R720", "HPE DL380"}
    dell = next(d for d in review if d["make_model"].startswith("Dell"))
    assert dell["suggested_make"] == "Dell"
    assert dell["suggested_model"] == "PowerEdge R720"   # doubled-make stripped
    created = [d for d in details if d["status"] == "created"]
    assert all("make_model" not in d or d.get("match_method") != "review"
               for d in created)   # non-review rows unchanged shape-wise


async def test_only_rows_filters_both_phases(db, ...):
    # upload the same CSV; set job.options["only_rows"] = [3] (the Dell row)
    # (write options directly on the job row before the worker claims it)
    # run validate: total_rows == 1, summary counts only that row (review 1)
    # flip to commit the way the commit endpoint does; run again:
    # still only row 3 processed; rows 2 and 4 untouched (no asset S1/S3)
```

Write these as REAL tests against the real harness — the sketch above fixes the assertions; the arrange code mirrors the existing files. Row numbers: confirm how `parse_row` numbers rows (header offset) by reading `parsing.py`, and use the actual numbers.

- [ ] **Step 2: Run → FAIL** (`cd api && .venv/bin/pytest tests/test_import_reprocess_pipeline.py -v`) — the make_model-fields assertions fail (KeyError).

- [ ] **Step 3: Implement**

`move_assets.py` — in the review branch (the `else:` that appends the review detail, ~lines 295-307), `mk`/`md` from `resolve_make_model_for_creation` are already in scope (computed in the `matched is None` block that review necessarily passed through). Extend the appended dict:

```python
        details.append({
            "row": r["row"], "serial_number": serial,
            "status": "review",
            "message": message,
            "match_method": "review",
            "serial_generated": r["serial_generated"],
            "make_model": r["make_model_str"],
            "suggested_make": mk,
            "suggested_model": md})
```

(Verify `mk`/`md` scope; if the code path can reach the review append without them, compute them right there with the same call.)

`worker.py` — after the parse step produces the row list (worker.py:39-55) and before `run_import`:

```python
    only_rows = set(job.options.get("only_rows") or [])
    if only_rows:
        rows = [r for r in rows if r["row"] in only_rows]
```

(adapting the variable name; ensure `total_rows` is computed AFTER the filter — read where the worker sets it and move/confirm accordingly.)

- [ ] **Step 4: Run focused → PASS, FULL API suite foreground → green (existing import tests must be untouched by the added fields), commit**

```bash
git add -A api && git commit -m "feat(api): structured review details + only_rows import filter"
```

---

### Task 2: Reprocess endpoint

**Files:**
- Modify: `api/src/serversherpa/api/routes/initiatives.py` (import-jobs section, ~lines 823-953)
- Test: `api/tests/test_import_reprocess_api.py`

**Interfaces:**
- Consumes: `_get_import_job(db, job_id)` (404 pattern at initiatives.py:832), `ImportJob` model, Task 1's worker filter, existing upload/commit flow + `ImportJobOut`.
- Produces: `POST /initiatives/assets/import-jobs/{job_id}/reprocess` → 201 `ImportJobOut` (the child) per the Global Constraints contract.

- [ ] **Step 1: Write the failing tests `api/tests/test_import_reprocess_api.py`**

Mirror `api/tests/test_move_asset_import_api.py`'s upload+worker+commit driving (read it first; reuse its helpers/fixtures). Cover:

```python
async def test_reprocess_creates_filtered_child(client, db, ...):
    # upload 3-row CSV (1 match, 2 review) -> worker validate -> commit
    # -> worker commit (review rows dropped, summary.review == 2)
    resp = await client.post(
        f"/initiatives/assets/import-jobs/{job_id}/reprocess", headers=hdrs)
    assert resp.status_code == 201, resp.text
    child = resp.json()
    assert child["id"] != str(job_id)
    assert child["phase"] == "validate" and child["status"] == "queued"
    assert child["filename"] == parent_filename
    # child options carry the filter + provenance
    child_row = await db.get(ImportJob, uuid.UUID(child["id"]))
    assert child_row.options["only_rows"] == sorted(review_row_numbers)
    assert child_row.options["reprocess_of"] == str(job_id)
    assert child_row.options["make_model_mode"] == "fuzzy"  # inherited
    assert child_row.file_key == parent.file_key
    # parent untouched
    await db.refresh(parent)
    assert parent.results["summary"]["review"] == 2


async def test_reprocess_child_runs_only_flagged(client, db, ...):
    # continue from the flow above: create the missing AssetModel(s)
    # (+ alias when the csv string differs), run the worker on the child
    # -> child validate results: total 2, created 2, review 0
    # commit the child via the EXISTING commit endpoint -> worker ->
    # assets for the two serials now exist


async def test_reprocess_gates_and_409s(client, db, ...):
    # running parent -> 409 job_not_ready
    # completed with review == 0 -> 409 no_review_rows
    # ghost id -> 404 import_job_not_found
    # actor without initiatives:change -> 403
```

(Real arrange code per the existing harness; the asserts above are the contract.)

- [ ] **Step 2: Run → FAIL (404 route)**

- [ ] **Step 3: Implement in `routes/initiatives.py`** (import-jobs section, after the cancel endpoint):

```python
@router.post("/assets/import-jobs/{job_id}/reprocess",
             response_model=ImportJobOut, status_code=201)
async def reprocess_move_asset_import_job(
    job_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> ImportJob:
    """Re-run ONLY the rows the parent flagged for review, as a fresh
    child job over the same stored file — full validate -> commit loop.
    The parent is never mutated; reprocessing twice makes two children.
    """
    parent = await _get_import_job(db, job_id)
    if parent.status != "completed":
        raise _err(409, "job_not_ready")
    details = (parent.results or {}).get("details") or []
    review_rows = sorted(d["row"] for d in details
                         if d.get("status") == "review")
    if not review_rows:
        raise _err(409, "no_review_rows")
    child = ImportJob(
        kind=parent.kind, initiative_id=parent.initiative_id,
        created_by=actor.person.id, filename=parent.filename,
        file_key=parent.file_key,
        options={**(parent.options or {}),
                 "only_rows": review_rows,
                 "reprocess_of": str(parent.id)},
        phase="validate", status="queued")
    db.add(child)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="import_job",
          entity_id=str(child.id), action="reprocess",
          changes={"reprocess_of": str(parent.id),
                   "only_rows": len(review_rows)})
    await db.commit()
    return child
```

(Match the section's existing style: `_err`, audit import if the sibling endpoints audit — check; if they don't audit, drop the audit call to stay consistent with the section. Verify `_get_import_job`'s exact signature/return.)

- [ ] **Step 4: Run focused → PASS, FULL API suite foreground → green, commit**

```bash
git add -A api && git commit -m "feat(api): reprocess-flagged import jobs as filtered child runs"
```

---

### Task 3: Portal helpers + wrapper + error copy

**Files:**
- Modify: `portal/src/lib/moveAssetImport.ts` (+ its test `portal/src/lib/moveAssetImport.test.ts` — extend)
- Modify: `portal/src/lib/api.ts` (reprocess wrapper; extend the import detail type)

**Interfaces:**
- Consumes: the portal's existing import detail type (api.ts ~1978-1988 — extend with optional `make_model?: string; suggested_make?: string; suggested_model?: string`), `ImportJobOut` wrapper type.
- Produces (Task 4 imports verbatim):
  - `reprocessImportJob(jobId: string): Promise<ImportJobRow>` (POST `/initiatives/assets/import-jobs/${jobId}/reprocess`; verify the actual job type name in api.ts and use it).
  - moveAssetImport.ts: `reviewMakeModel(d: ImportRowDetail): string | null` (field first, else message regex `/Make\/Model '(.+)' not found/`, else null); `suggestSplit(text: string): { make: string; model: string }` (TS port of the doubled-make heuristic: tokens = text.split(/\s+/); while first token repeats at position 1 (case-insensitive) and tokens.length > 2, drop the duplicate (max twice); make = first token, model = rest joined; single token → both = token); `missingMakeModels(details: ImportRowDetail[]): { text: string; rows: number[]; make: string; model: string }[]` (distinct case-insensitive over review rows' reviewMakeModel, rows ascending, split from detail fields when present else suggestSplit, ordered by first appearance); new `IMPORT_ERRORS` entry `no_review_rows: 'Nothing is flagged for review.'`.

- [ ] **Step 1: Extend `portal/src/lib/moveAssetImport.test.ts` (failing)**

```ts
import { missingMakeModels, reviewMakeModel, suggestSplit } from './moveAssetImport';

const R = (over: Record<string, unknown>) => ({
  row: 1, serial_number: 's', status: 'review',
  message: "Make/Model 'X' not found — needs review",
  match_method: 'review', serial_generated: false, ...over,
});

it('reviewMakeModel prefers the field, falls back to the message', () => {
  expect(reviewMakeModel(R({ make_model: 'HPE DL380' }) as never)).toBe('HPE DL380');
  expect(reviewMakeModel(R({
    message: "Make/Model 'Dell Dell PowerEdge R720' not found — needs review",
  }) as never)).toBe('Dell Dell PowerEdge R720');
  expect(reviewMakeModel(R({ message: 'Serial missing' }) as never)).toBeNull();
});

it('suggestSplit strips doubled makes and splits make/model', () => {
  expect(suggestSplit('Dell Dell PowerEdge R720'))
    .toEqual({ make: 'Dell', model: 'PowerEdge R720' });
  expect(suggestSplit('HPE DL380')).toEqual({ make: 'HPE', model: 'DL380' });
  expect(suggestSplit('Arista')).toEqual({ make: 'Arista', model: 'Arista' });
});

it('missingMakeModels groups case-insensitively with row lists', () => {
  const details = [
    R({ row: 5, make_model: 'Dell Dell PowerEdge R720',
        suggested_make: 'Dell', suggested_model: 'PowerEdge R720' }),
    R({ row: 9, message: "Make/Model 'dell dell poweredge r720' not found — needs review" }),
    R({ row: 12, make_model: 'HPE DL380' }),
    R({ row: 2, status: 'created', message: 'ok' }),
  ] as never[];
  const groups = missingMakeModels(details);
  expect(groups).toHaveLength(2);
  expect(groups[0]).toMatchObject({
    text: 'Dell Dell PowerEdge R720', rows: [5, 9],
    make: 'Dell', model: 'PowerEdge R720' });
  expect(groups[1]).toMatchObject({ text: 'HPE DL380', rows: [12] });
});
```

- [ ] **Step 2: Run → FAIL** (`npx vitest run src/lib/moveAssetImport.test.ts`)

- [ ] **Step 3: Implement** — helpers in `moveAssetImport.ts` exactly per the Interfaces block:

```ts
const REVIEW_RE = /Make\/Model '(.+)' not found/;

export function reviewMakeModel(d: ImportRowDetail): string | null {
  if (d.make_model) return d.make_model;
  const m = d.message?.match(REVIEW_RE);
  return m ? m[1] : null;
}

export function suggestSplit(text: string): { make: string; model: string } {
  const tokens = text.trim().split(/\s+/);
  if (tokens.length === 1) return { make: tokens[0], model: tokens[0] };
  let drops = 0;
  while (tokens.length > 2 && drops < 2
         && tokens[0].toLowerCase() === tokens[1].toLowerCase()) {
    tokens.splice(1, 1);
    drops += 1;
  }
  return { make: tokens[0], model: tokens.slice(1).join(' ') };
}

export function missingMakeModels(details: ImportRowDetail[]) {
  const groups = new Map<string, { text: string; rows: number[];
    make: string; model: string }>();
  for (const d of details) {
    if (d.status !== 'review') continue;
    const text = reviewMakeModel(d);
    if (!text) continue;
    const key = text.toLowerCase();
    const existing = groups.get(key);
    if (existing) {
      existing.rows.push(d.row);
    } else {
      const split = d.suggested_make && d.suggested_model
        ? { make: d.suggested_make, model: d.suggested_model }
        : suggestSplit(text);
      groups.set(key, { text, rows: [d.row], ...split });
    }
  }
  return [...groups.values()].map((g) => ({ ...g, rows: [...g.rows].sort((a, b) => a - b) }));
}
```

(Adapt `ImportRowDetail` to the file's actual detail type name; extend that type in api.ts with the three optional fields.) api.ts wrapper (house pattern, no body):

```ts
export async function reprocessImportJob(jobId: string): Promise<ImportJobRow> {
  const resp = await apiFetch(`/initiatives/assets/import-jobs/${jobId}/reprocess`,
    { method: 'POST' });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

Add `no_review_rows: 'Nothing is flagged for review.'` to `IMPORT_ERRORS`.

- [ ] **Step 4: Run focused → PASS, FULL portal suite + build → green, commit**

```bash
git add -A portal && git commit -m "feat(portal): import review helpers + reprocess wrapper"
```

---

### Task 4: Portal UI — fix surface + reprocess

**Files:**
- Create: `portal/src/components/initiatives/FixMakeModelDialog.tsx`
- Modify: `portal/src/components/assets/ModelEditModal.tsx` (optional `initial?: { make: string; model: string }` prefill on create)
- Modify: `portal/src/pages/ImportMoveAssets.tsx` (missing-models card, per-row Fix, reprocess button, child banner)
- Test: `portal/src/pages/ImportMoveAssets.test.tsx` (extend or create per existing coverage), `portal/src/components/initiatives/FixMakeModelDialog.test.tsx`

**Interfaces:**
- Consumes: Task 3 helpers/wrapper; `listAssetModels`, `createAssetModel`, `updateAssetModel`, `setAssetModelAliases`, `listAssetCategories` (api.ts ~1241-1280); `ModelEditModal` (components/assets — study its props + create flow first); `ComboBox` (components/ComboBox.tsx); `can()` from useAuth.
- Produces: `FixMakeModelDialog({ text, make, model, onClose, onFixed }: { text: string; make: string; model: string; onClose: () => void; onFixed: (text: string) => void })` — two modes inside one dialog: "Create model" (renders ModelEditModal with `initial={{make, model}}`; on its onSaved, append `text` as an alias to the created model when `text.toLowerCase() !== `${make} ${model}`.toLowerCase()` — the created model's real make/model come from the modal's save result; read how onSaved reports the created id, extend minimally if it doesn't) and "Map to existing" (ComboBox over listAssetModels by "Make Model" display; confirm appends `text` to that model's aliases). Alias append = read current aliases (from the listed AssetModelItem's aliases field if present, else `GET /asset-models/{id}` — check the type first), dedupe case-insensitively, PUT via setAssetModelAliases. Calls `onFixed(text)` on success.

- [ ] **Step 1: Failing tests**

`FixMakeModelDialog.test.tsx` (house mocks): mapping mode appends the alias —

```ts
it('map-to-existing appends the csv string as an alias', async () => {
  api.listAssetModels.mockResolvedValue([
    { id: 'm1', make: 'Dell', model: 'PowerEdge R720', aliases: ['old'] },
  ] as never);
  api.setAssetModelAliases.mockResolvedValue({});
  const onFixed = vi.fn();
  render(<FixMakeModelDialog text="Dell Dell PowerEdge R720" make="Dell"
    model="PowerEdge R720" onClose={() => {}} onFixed={onFixed} />);
  await userEvent.click(await screen.findByText('Map to existing'));
  // select the model through the ComboBox (type-to-filter then click)
  await userEvent.type(screen.getByRole('textbox'), 'PowerEdge');
  await userEvent.click(await screen.findByText('Dell PowerEdge R720'));
  await userEvent.click(screen.getByRole('button', { name: /Add alias|Map/ }));
  await waitFor(() => expect(api.setAssetModelAliases).toHaveBeenCalledWith(
    'm1', ['old', 'Dell Dell PowerEdge R720']));
  expect(onFixed).toHaveBeenCalledWith('Dell Dell PowerEdge R720');
});
```

(Adapt selectors to ComboBox's real markup — read the component; keep the alias-append assertion exact.) `ImportMoveAssets.test.tsx`: with a mocked completed commit job containing 2 review rows sharing one missing string + 1 created row — the card renders "1 missing make/model" group with the string and "2 rows"; the Reprocess button calls `reprocessImportJob(jobId)` and the page then polls the CHILD id (assert `getImportJob` called with the child id after the swap); the child-job banner renders when `options.reprocess_of` is present ("Reprocessing 2 flagged rows from the earlier run."). Follow the page's existing test file conventions if one exists; else create with the standard hoisted-mock mechanics.

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement**

- `ModelEditModal`: add optional `initial` prop consumed ONLY in create mode to seed the form's make/model fields (default unchanged). If `onSaved` doesn't currently receive the saved model, extend it to pass the saved `AssetModelItem` (check all existing call sites compile — they may ignore the arg).
- `FixMakeModelDialog`: standard modal skeleton (scrim/card/head/body/foot), a two-tab or two-button mode switch ("Create model" / "Map to existing"), create mode embedding/opening `ModelEditModal` with `initial`, map mode with the ComboBox + confirm button labeled "Add alias & map". Alias logic per Interfaces. `pf-error` on failure.
- `ImportMoveAssets.tsx`:
  - `const missing = useMemo(() => missingMakeModels(details), [details]);` and `const [fixedTexts, setFixedTexts] = useState<Set<string>>(new Set());` (reset when the job id changes).
  - **Card** above the results table when `missing.length > 0`: panel titled "Missing make/models" listing each group — mono string, "N rows", and either the two action `mini-btn`s ("Create model…", "Map to existing…" — both opening `FixMakeModelDialog` with the group's text/make/model, gated `can('asset_models','add')` / `can('asset_models','change')`) or, when `fixedTexts.has(text.toLowerCase())`, a `chip c-green` "Ready — reprocess to apply". Read-only users (neither perm): the list renders with the hint "Ask an admin to add these models."
  - **Per-row Fix**: review rows whose `reviewMakeModel(d)` is non-null get a `Fix…` `mini-btn` in the Message cell opening the same dialog (same gating; hidden when the row's text is already in `fixedTexts`).
  - **Reprocess button**: in the footer when `job.status === 'completed' && counts.review > 0 && can('initiatives','change')`: label `Reprocess ${counts.review} flagged`, onClick `reprocessImportJob(job.id).then(setJob)` (plus clearing `fixedTexts` and letting the existing polling/currentStep machinery take over — verify the page's state shape and reset whatever else keys off the job id).
  - **Child banner**: when `job.options?.reprocess_of`, render above the table: `Reprocessing ${job.options.only_rows?.length ?? ''} flagged rows from the earlier run.` (muted `.dash-panel-empty`-style line or the page's own hint style).
- CSS: reuse existing classes; anything new goes in the page's existing stylesheet (check which css files ImportMoveAssets imports; likely initiatives.css — add an `imp-fix-` block there only if needed).

- [ ] **Step 4: Run focused → PASS, FULL portal suite + `npm run build` → green, commit**

```bash
git add -A portal && git commit -m "feat(portal): import fix surface + reprocess-flagged flow"
```

---

### Task 5: Verification — the real 78-row job

**Files:** none expected (fixes only if found).

- [ ] **Step 1:** FULL API + portal suites + build foreground → green; tree clean.
- [ ] **Step 2:** Browser (claude-dev, known login quirks): open the initiative's import page for existing dev job `6a915416-40cd-4812-a371-c1e0e0a4274a` (navigate to `/initiatives/<initiative id>/import-assets` — the page loads its job; check how the page discovers an existing job: if it only tracks jobs it created this session, load the job by driving `getImportJob` via the page's URL/state — read the page first; if it cannot display a historical job, verification instead runs a FRESH small import: download the template, hand-craft a 4-row file with 2 unmatched models, upload via the UI, commit, then exercise the loop).
- [ ] **Step 3:** Exercise the loop on real data, WITHOUT bulk-creating all 78 rows' models (that's Jimmy's data call): fix TWO distinct missing strings — one via "Create model…" (verify the alias lands when the string differs) and one via "Map to existing…" — then hit "Reprocess N flagged", watch the child validate, and Import (commit) it. Confirm: the child summary shows the fixed rows `created`, the rest still `review`; the initiative roster grew accordingly; reprocessing AGAIN offers the remaining flagged rows (loop works). Screenshots: the missing-models card, the child validation, the final counts.
- [ ] **Step 4:** Confirm commits; leave the branch unmerged; note remaining flagged rows are Jimmy's to fix with the new tooling.

## Out of scope (per spec)

Per-row import table; in-app editing of serials/CSV fields; auto-create without confirmation (= existing force mode).
