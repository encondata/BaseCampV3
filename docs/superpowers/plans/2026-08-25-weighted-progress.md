# Weighted Move Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admin-editable `progress_weight` on move-asset statuses driving a weighted progress percentage; bar label becomes percentage-only.

**Spec:** docs/superpowers/specs/2026-08-25-weighted-progress-design.md — the requirements source; implementers read it in full (Math section and seed table are binding, weights VERBATIM).

## Global Constraints

- API from `api/` (.venv), portal from `portal/`. Baselines: 458 pytest, 441 vitest, both green at 865a113. Reference patterns: migrations 0019/0020, status_values routes + tests, Variables.tsx status editor, moveAssetProgress in lib/initiatives.ts.
- Commits end with:

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>

### Task 1: API — column, seeds, editor validation

**Files:** Create `api/migrations/versions/0021_progress_weight.py`; Modify `api/src/serversherpa/db/models.py` (StatusValue), `api/src/serversherpa/api/schemas.py` + `api/src/serversherpa/api/routes/status_values.py` (read + create/update with `invalid_progress_weight` 422); Test: extend `api/tests/test_status_values_*.py` per existing conventions; conftest seed restore must include weights.

**Produces:** `progress_weight` on every status-values payload row; editor accepts int 0–100 | null.

- [ ] TDD; migration up/down/up clean; full pytest green; commit `feat(api): progress_weight on status values, seeded for move assets`.

### Task 2: Portal — weighted math, percent-only bar, editor input

**Files:** Modify `portal/src/lib/api.ts` (StatusValue type), `portal/src/lib/initiatives.ts` (`moveAssetProgress(rows, statuses)` per spec Math) + `portal/src/lib/initiatives.test.ts`, `portal/src/pages/InitiativeDetail.tsx` (pass statuses, percent-only label), `portal/src/pages/Variables.tsx` (Progress weight input, move_asset_status only).

- [ ] TDD the math; tsc/test/build clean; commit `feat(portal): weighted move progress, percent-only bar, weight editor`.

### Task 3: Controller verification + peer notification

- [ ] Suites, ledger, notify the vocabulary-merge session about the column.
