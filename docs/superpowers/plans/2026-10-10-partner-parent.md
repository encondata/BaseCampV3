# Parent and Subsidiary Partners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partners can have a parent partner; staff set it in the edit form or add children on the parent's page; shown on the partner page and as an optional Partners-list column.

**Architecture:** `partners.parent_id` self-FK (migration 0095). The partner branch of the org router validates parent changes (self, scope, cycle under an advisory lock) and exposes `parent_id/parent_name/child_count` plus `GET /partners/{id}/children`. The portal adds a ComboBox to the org edit/create form, a Parent row and Child partners panel on the detail page, and an optional Parent column on the list.

**Tech Stack:** FastAPI, SQLAlchemy async, Alembic, pytest; React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-10-partner-parent-design.md` — binding.

## Global Constraints

- Migration **0095** (`api/migrations/versions/0095_partner_parent.py`, `down_revision = "0094"`): `partners.parent_id` uuid NULL FK → `partners.id` `ON DELETE SET NULL`, index `ix_partners_parent_id`, check `ck_partners_parent_not_self`.
- Error codes exactly: 422 `self_parent`, 422 `parent_not_found` (missing or out of scope), 422 `circular_parent`, 422 `parent_not_allowed` (clients router).
- Archived parents are allowed. No depth limit. No access inheritance — partner-scoped users see parent/children only where already in scope (`parent_name`/`parent_id` null otherwise; `child_count` and children list scoped).
- `GET /partners/{id}/children` returns `OrgItem` rows sorted with `natural()`; 404 when the partner isn't visible.
- Parent changes audited by the existing PATCH snapshot/diff.
- Parent changes are staff-only: on partner create/PATCH, a body containing a `parent_id` key from a non-global actor (`access.is_global` false) -> 403 `forbidden`, before any lock or lookup (partner users see the hierarchy but cannot change it).
- Portal copy: field "Parent partner" with option "None"; detail row "Parent partner"; panel "Child partners"; button "Add child"; row action "Remove"; modal eyebrow "Partners", title "Add a child partner"; empty "No child partners."; list column "Parent" (optional, off by default, partner-only).
- House idioms only (`ComboBox`, `init-panel`, `dir-list`/`ColHead`/`listGridStyle` + column floors, `RowActionsMenu`, modal header pattern, `pf-error`); natural sort; American English.
- Never commit `api/src/serversherpa/_dev_reload.py`. Never `git stash`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## How to run things (worktree `.claude/worktrees/partner-parent`)

- API tests (foreground, one at a time): `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_partnerparent DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/pytest -q <files>` (`PYTHONPATH` required — the `.venv` is an editable install of the main checkout). **Any alembic command must set `SS_DATABASE_URL` to the test DB.** Never the dev DB.
- Portal: `cd portal && npx vitest run <files>`; before committing portal work run the full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: API — parent partner column, validation, children

**Files:** Create `api/migrations/versions/0095_partner_parent.py`; modify `api/src/serversherpa/db/models.py` (`Partner.parent_id`), `api/src/serversherpa/api/routes/stakeholders.py`, `api/src/serversherpa/api/schemas.py`; tests `api/tests/test_partner_parent_api.py`, `api/tests/test_migration_0095_partner_parent.py`.

**Produces:** `OrgItem.parent_id`, `OrgItem.parent_name`, `OrgItem.child_count` (partners; null/0 or absent-equivalent for clients — keep clients' payload unchanged if the schema allows optional fields); `OrgCreateIn.parent_id`, `OrgUpdateIn.parent_id`; `GET /partners/{id}/children`.

- [ ] **Step 1: Failing tests** for every API item in the spec's Testing paragraph (follow `tests/test_stakeholders.py` fixtures; partner-scoped users via `tests/test_initiatives_client_scope.py::partner_login`; migration test style from `tests/test_migration_0091_visibility.py`).
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement.** Mirror the initiative link cycle check (`api/routes/initiatives.py` `_ancestor_ids`, `LINK_GRAPH_LOCK_KEY`) with a new lock key. Compute `parent_name`/`child_count` for list and detail in set-based queries (no per-row queries in the list).
- [ ] **Step 4: Run** the new files + `tests/test_stakeholders.py` + any org/partner tests (`grep -l "/partners" api/tests`) — pass. Ruff clean on changed code.
- [ ] **Step 5: Commit** — `feat(partners): parent partner (migration 0095) with cycle checks and a children list`.

---

### Task 2: Portal — parent picker, Parent row, Child partners panel, Parent column

**Files:** modify `portal/src/lib/api.ts` (types + `listPartnerChildren`), `portal/src/lib/orgs.ts` (column def), `portal/src/pages/OrgDirectory.tsx` (form field + column), `portal/src/pages/StakeholderDetail.tsx` (Parent row + panel; put the panel in a new `portal/src/components/stakeholders/ChildPartnersPanel.tsx` if that keeps StakeholderDetail lean) + tests.

- [ ] **Step 1: Failing tests** covering the spec's Portal testing paragraph.
- [ ] **Step 2: Run; confirm failure.**
- [ ] **Step 3: Implement** with house idioms (find where the org edit/create form lives and how ComboBox is used inside modals; the Add child modal follows the report-generate header pattern).
- [ ] **Step 4: Run** the full `npx vitest run`, `npx tsc -b`, `npm run build` — pass (guardrails included).
- [ ] **Step 5: Commit** — `feat(portal): parent partner picker, Child partners panel and Parent column`.
