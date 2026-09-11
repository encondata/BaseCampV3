# Move Scan History Report — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Port V2's Move Scan History Report (XLSX + PDF) into V3's reports framework with a roomy Generate modal.

**Architecture:** New module `api/src/serversherpa/reports/move_scan_history/` (gather → xlsx | html→pdf), migration 0054 seeds the definition, a preview endpoint feeds the modal, the shared Generate modal shell gets wider with a header and a pick-step summary card, plus a per-report options component.

**Tech Stack:** FastAPI/SQLAlchemy async/Alembic/openpyxl/Jinja2/WeasyPrint/pdf417gen (api), React + TS + Vitest (portal).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-11-move-scan-history-design.md` (authoritative). V2 reference (read-only): `/Users/jrh1812/Developer/BaseCampV2-reference/api/reports/scan_history_report.py`, `api/reports/_pdf_utils.py`, `portal-v2/src/pages/MoveScanHistoryReport.jsx`.
- Migration `0054`, `down_revision = "0053"`, single head. Report type `move_scan_history`. Error codes: `initiative_unavailable`, `initiative_not_found`, plus existing reports codes.
- American English. Portal idioms only (ComboBox, `.segmented`, Switch, chips, `.pf-form`, `.dash-kpis`, mini-list); guardrail green, no new allowlist entries; no raw native `<select>`.
- Tests FOREGROUND, one call, timeout 600000ms: API `PYTHONPATH=src SS_TEST_DB=serversherpa_test_msh /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q <files>` from the worktree's api/; portal `npx vitest run <files> && npx tsc --noEmit -p .` from portal/.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `git add` by explicit path; never `git stash`; `git checkout -- api/src/serversherpa/_dev_reload.py` if it shows modified.

---

### Task 1: API core — migration, gather, xlsx, build (xlsx), registry, options

**Files:** Create `api/migrations/versions/0054_move_scan_history.py`, `api/src/serversherpa/reports/move_scan_history/{__init__,gather,xlsx}.py`; Modify `reports/registry.py` (register), `api/routes/reports.py` (+`schemas.py`) only if run creation needs per-type handling (it should not — `_validated_options(report_type, options, run=True)` already dispatches). Tests `api/tests/test_move_scan_history_gather.py`, `test_move_scan_history_xlsx.py`, extend `test_report_seed.py`/`test_site_move_survey_fixtures.py`-style migration test.

**Produces:** `gather(db, initiative_id) -> ScanHistoryData(initiative_id, name, client_name, scheduled_start, source_name, destination_name, assets: list[AssetRow(asset_id:int, serial_number:str, name:str)], statuses: list[StatusCol(key,label,in_pipeline,scan_count)], scan_progress: dict[int, list[ScanHit(status_key, status_label, at: datetime)]], total_assets, scanned_assets, completed, completion_pct, last_scan_at)`; `PIPELINE_STATUS_KEYS`; `columns_for(data, mode) -> list[StatusCol]`; `build_workbook(data, columns, generated_at, tz) -> bytes`; `validate_options`, `validate_run_options`, `build` (pdf branch raises `OptionsError`/NotImplemented until Task 2).

- [ ] Migration 0054 seeds the definition (`CAST(:options AS jsonb)`, `ON CONFLICT (name) WHERE archived_at IS NULL DO NOTHING` like 0052). Test asserts the seeded row and single head.
- [ ] gather per spec (queries: initiative + client + sites; roster; status vocabulary; grouped earliest scans). Tests seed an initiative with three assets, scans (duplicates, null-status, archived, an off-pipeline status), assert ordering/dedupe/columns/completion/empty move.
- [ ] xlsx per spec; tests open the bytes with openpyxl and assert cells/formats/empty messages.
- [ ] Commit `feat(reports): Move Scan History — gather, XLSX, definition (migration 0054)`.

### Task 2: API — PDF, barcode, preview endpoint, worker types

**Files:** Create `reports/move_scan_history/{pdf,barcode}.py`, `reports/move_scan_history/templates/move_scan_history.html`; Modify `api/pyproject.toml` (`pdf417gen>=0.7`, package-data for the new templates dir), `api/routes/reports.py` (+`schemas.py`: `ScanHistoryPreviewOut`), `reports/move_scan_history/__init__.py` (pdf branch). Tests `test_move_scan_history_pdf.py`, extend `test_reports_api.py`, `test_report_worker.py`.

- [ ] `pdf417_png(text) -> bytes`; `render_html(data, columns, generated_at, tracking_id, tz)`; `build` pdf branch via `move_report.render.render_pdf_async`.
- [ ] Preview endpoint per spec (scope via `scope_conditions("initiatives", …)` like `create_run`).
- [ ] Tests per spec. Commit `feat(reports): Move Scan History PDF with tracking barcode + preview endpoint`.

### Task 3: Portal — roomy Generate modal shell, scan-history options, definition options

**Files:** Modify `portal/src/components/reports/GenerateReportModal.tsx` (+ tests), `portal/src/styles/reports.css`, `portal/src/lib/api.ts` (`getScanHistoryPreview`, typings), `EditDefinitionModal.tsx` (+ test); Create `portal/src/components/reports/MoveScanHistoryOptions.tsx` (+ test), `portal/src/lib/moveScanHistory.ts` (+ test: option payload, column preview split).

- [ ] Shell per spec (width, header, step indicator, pick-step summary card) — Move Report + survey flows unchanged in behavior; update their tests only where markup moved.
- [ ] `MoveScanHistoryOptions` per spec; `EditDefinitionModal` segmented controls for `default_format` / `status_columns`.
- [ ] Run `npx vitest run src/components/reports src/lib/moveScanHistory.test.ts src/styles/listTypography.test.ts && npx tsc --noEmit -p .`. Commit `feat(portal): roomy Generate modal shell + Move Scan History options`.

### Task 4: Verification (controller-led)

Full suites, dev DB `alembic upgrade head`, live generate both formats for the NAP11 demo, inspect xlsx + PDF, merge to main/reports, push, memory note.
