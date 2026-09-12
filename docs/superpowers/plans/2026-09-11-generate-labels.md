# Generate Labels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Port V2's Generate Labels as a queue + `label-worker` process, with a house-style page and reusable API.

**Architecture:** migration 0055 (`label_generation_runs`, `generated_labels`, `label_templates.generation_rules`); package `api/src/serversherpa/labels/generate/` (values → select → engine → runner) + worker/CLI/Procfile; routes under `/labels/generate/*` and `/labels/generated`; portal page `/labels/generate` built from the shared report-modal layout pieces; editor Generation rules panel.

**Tech Stack:** FastAPI/SQLAlchemy async/Alembic (api), React + TS + Vitest (portal).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-11-generate-labels-design.md` (authoritative). V2 reference (read-only): `/Users/jrh1812/Developer/BaseCampV2-reference/api/portal_routes.py` lines 27405–27860 and `portal-v2/src/pages/GenerateLabels.jsx`.
- Migration `0055`, `down_revision = "0054"`, single head. Status vocabulary `queued|running|completed|failed|canceled` (American spelling everywhere).
- American English. Portal idioms only (ComboBox, `.segmented`, Switch, chips, `.pf-form`, `dir-list`, `ReportOptionsLayout` pieces); guardrail green, no new allowlist entries; no raw native `<select>`; new modals carry the eyebrow/title/description header.
- Tests FOREGROUND, one call, timeout 600000ms: API `PYTHONPATH=src SS_TEST_DB=serversherpa_test_gl /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q <files>` from the worktree's api/; portal `npx vitest run <files> && npx tsc --noEmit -p .` from portal/.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `git add` by explicit path; never `git stash`; `git checkout -- api/src/serversherpa/_dev_reload.py` if it shows modified.

---

### Task 1: API core — migration, models, values/select/engine/runner, worker, CLI, Procfile
**Files:** Create `api/migrations/versions/0055_generate_labels.py`, `api/src/serversherpa/labels/compile.py` (vocab-free compile core shared with the route), `api/src/serversherpa/labels/generate/{__init__,values,select,engine,runner,jobs,worker}.py`; Modify `api/src/serversherpa/db/models.py` (`LabelGenerationRun`, `GeneratedLabel`, `LabelTemplate.generation_rules`), `api/src/serversherpa/labels/model.py`/`api/routes/labels.py` only to route `_compile_design` through `labels/compile.py`, `api/src/serversherpa/cli.py` (`label-worker`), `Procfile.dev` (`labelsvc:`). Tests `api/tests/test_label_generate_values.py`, `test_label_generate_select.py`, `test_label_generate_runner.py` (engine, runner, jobs, worker `run_once`), migration test in `test_label_generate_runner.py` or `test_label_generate_seed.py`.
**Produces:** models + the functions named in the spec's Worker section; `enqueue_run(db, *, initiative_id, label_types, regenerate_existing, requested_by, notify) -> LabelGenerationRun` in `generate/__init__.py` (validation of types against active vocab; 409-style `RunActive` exception) so Task 2's route and any future caller share it.

### Task 2: API routes + schemas + notifications + import mapping
**Files:** Modify `api/routes/labels.py`, `api/schemas.py` (`LabelRunCreateIn/LabelRunOut/LabelGeneratePreviewOut/GeneratedLabelOut`, `generation_rules` on template schemas with validation), `api/src/serversherpa/labels/v2_import.py` (`label_generation_code` → `generation_rules`), notification kinds where `report_ready` is registered (`labels_ready`, `labels_failed`) and `portal/src/components/NotificationsPanel.tsx` kind icon/label if a registry exists there; Tests extend `test_labels_api.py` (or new `test_label_generate_api.py`), `test_labels_v2_import.py`.

### Task 3: Portal — Generate Labels page, API client, editor Generation rules panel
**Files:** Create `portal/src/pages/GenerateLabels.tsx` (+ test), `portal/src/components/labels/{LabelTypeCards,GenerationProgress,LabelRunsList,LabelRunErrorsModal,GenerationRulesPanel}.tsx` (+ tests), `portal/src/lib/generateLabels.ts` (+ test: gating, progress math, error summary sorting); Modify `portal/src/lib/api.ts`, `portal/src/App.tsx` (replace the placeholder route), `portal/src/pages/LabelTemplateEditor.tsx` (rules panel), `portal/src/styles/labels.css` (layout-only).

### Task 4: Verification (controller-led)
Full suites, dev DB `alembic upgrade head`, start `labelsvc` under the running honcho stack (or a one-off `serversherpa label-worker --once`), generate Top + Front for the NAP11 demo, inspect `generated_labels`, merge to main/reports, push, memory note.
