# Container Labels — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Port V2's Container Labels (Avery 5164 PDF sheets) with a byte-for-byte-equivalent drawing routine, runnable in the browser (instant download) and server-side (report run).

**Architecture:** migration 0057 (`containers.initiative_id`, "Container Labels" definition); shared TS module `portal/src/labels/containerLabelSheet.ts` (V2 jsPDF port) + Node bundle `dist-node/render-container-labels.js`; report module `reports/container_labels/` calling the bundle; page `/labels/containers` + report options step.

**Tech Stack:** jsPDF ^3.0.4, bwip-js ^4.8.0 (same majors as V2), Vite SSR bundle, FastAPI/SQLAlchemy/Alembic.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-09-12-container-labels-design.md` (authoritative). V2 reference (read-only): `/Users/jrh1812/Developer/BaseCampV2-reference/portal-v2/src/pages/ContainerLabels.jsx`, images in `/Users/jrh1812/Developer/BaseCampV2-reference/portal-v2/public/images/*-tag.png`.
- Migration `0057`, `down_revision = "0056"`, single head. American English. Portal idioms only; new modals/pages carry the roomy header; guardrail green, no new allowlist entries; no native `<select>`.
- Tests FOREGROUND, one call, timeout 600000ms: API `PYTHONPATH=src SS_TEST_DB=serversherpa_test_cl /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/python -m pytest -q <files>` from the worktree's api/; portal `npx vitest run <files> && npx tsc --noEmit -p .` from portal/.
- Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; `git add` by explicit path and commit IMMEDIATELY after staging (three implementers share this worktree — an earlier broad `git add` swept another agent's files); never `git stash`; `git checkout -- api/src/serversherpa/_dev_reload.py` if it shows modified.

### Task 1: API — migration 0057, containers.initiative_id, report module + Node renderer bridge
**Files:** Create `api/migrations/versions/0057_container_labels.py`, `api/src/serversherpa/reports/container_labels/{__init__,gather}.py`, `api/src/serversherpa/reports/container_label_renderer.py`; Modify `db/models.py` (`Container.initiative_id`), `api/routes/containers.py` (+ `schemas.py`: `initiative_id`/`initiative_name`, filter, 404), `reports/registry.py`; Tests `test_containers_api.py` (extend), `test_container_labels_report.py` (new), `test_report_seed.py`.

### Task 2: Portal — the PDF module (exact V2 port), adapters, Node bundle, exactness tests
**Files:** Create `portal/src/labels/containerLabelSheet.ts`, `portal/src/labels/containerLabelAdapters.browser.ts`, `portal/src/labels/containerLabelAdapters.node.ts`, `portal/src/labels/renderContainerLabels.ts`, `portal/vite.container-labels.config.ts`, `portal/src/labels/containerLabelSheet.test.ts` (log-equivalence vs embedded V2 routine + real jsPDF smoke), `portal/public/images/*-tag.png` (copied); Modify `portal/package.json` (deps + `build:container-labels` + `build`), `.gitignore` if needed (dist-node already ignored).

### Task 3: Portal — page, report options step, container edit modal initiative field, nav
**Files:** Create `portal/src/pages/ContainerLabels.tsx` (+ test), `portal/src/components/labels/{ContainerPickList,ContainerTagPicker}.tsx` (+ tests), `portal/src/components/reports/ContainerLabelsOptions.tsx` (+ test); Modify `portal/src/lib/api.ts` (containers `initiative_id`/filter, `listContainers({initiative_id})`), `portal/src/App.tsx`, `portal/src/layout/navSections.tsx` + `labelsNav.test.tsx`, `portal/src/components/containers/ContainerEditModal.tsx` (+ test), `portal/src/pages/Containers.tsx` (Initiative column/facet), `portal/src/components/reports/GenerateReportModal.tsx` (delegate for `container_labels`), `portal/src/styles/labels.css`.

### Task 4: Verification (controller-led)
Build the Node bundle, full suites, dev DB `alembic upgrade head`, assign demo containers to NAP11, download + report-run PDFs, compare page counts/text, merge, push, memory.
