# Initiative Options Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** An "Options" page inside the Initiatives nav section — the Variables-page experience scoped to the five initiative vocabularies (initiative_type, initiative [status], initiative_sub_type, initiative_work_type, shipping_type) — editable by admins without god mode.

**Architecture:** The status-values write guards generalize from devtools-only to "devtools OR (admin-rank AND `change` on the record type's registry resource)"; the portal gains `/initiatives/options`, cloned from the Variables page's status-vocabulary tab pattern and reusing its `StatusEditModal`/`ColorField` components unchanged.

**Tech Stack:** Existing.

## Global Constraints

- API checks: `cd api && .venv/bin/pytest`. Portal: `cd portal && npx tsc --noEmit && npx vitest run`.
- Machine-coded errors; existing devtools behavior must not regress (Variables page keeps working identically for developers).
- Admin threshold is `GATE_BYPASS_RANK` from `serversherpa.access.defaults` (rank 60) — same constant the initiatives type-change gate uses. Staff (rank 40) must NOT gain vocabulary write access.
- Working tree hygiene: stage only files your task owns.

---

### Task 1: API — resource-scoped vocabulary writes

**Files:**
- Modify: `api/src/serversherpa/api/routes/status_values.py`
- Test: extend the status-values write test file (find it: `grep -rl "status-values" api/tests/ | head`)

**Requirements (prose spec — read the code first):**

1. Replace the `require_permission("devtools", "add"/"change")` guards on `create_status_value` and `update_status_value` with a shared check inside each handler: the actor may write values of `record_type` when `actor.access.can("devtools", "add"/"change")` (unchanged path) OR (`actor.access.max_rank >= GATE_BYPASS_RANK` AND `actor.access.can(rt.resource, "change")`), where `rt` is the registry entry for the record type being written. Otherwise 403 `{"code": "forbidden"}`. Import `GATE_BYPASS_RANK` from `serversherpa.access.defaults`. (Use `require_permission`-less `CurrentUser` + explicit check, or keep a base `CurrentUser` dependency — follow whichever the file's read path already uses; note the create body carries the record_type, the patch has it in the path.)
2. The unfiltered list branch (usage counts, devtools view) stays devtools-only exactly as it is.
3. Tests (extend, follow existing style):
   - An admin-role actor (rank 60, no devtools) CAN create and update a value under `initiative_sub_type` (initiatives resource) — assert 201/200 and the value round-trips through `GET /status-values?record_type=initiative_sub_type`.
   - The same admin CANNOT write a `site` record-type value if... actually admin has sites FULL — instead: a staff actor (rank 40, initiatives FULL) gets 403 on the same initiative_sub_type create — proving the rank floor, not just the resource grant.
   - Devtools path regression: existing devtools-actor write tests still pass unmodified (do not weaken them).
4. Full suite before committing; commit only this task's files.
   Message: `feat(api): admins edit vocabularies for resources they administer`

### Task 2: Portal — Initiatives → Options page

**Files:**
- Create: `portal/src/pages/InitiativeOptions.tsx`
- Modify: `portal/src/App.tsx` (route `/initiatives/options`, ProtectedRoute resource `initiatives`)
- Modify: `portal/src/layout/navSections.tsx` (Initiatives section gains "Options" item, resource `initiatives`)
- Modify: `portal/src/components/CommandPalette.tsx` (`navGated('Initiative options', '/initiatives/options', 'initiatives')`)
- Modify: `portal/src/lib/access.ts` (`ROUTE_RESOURCE['/initiatives/options'] = 'initiatives'`)

**Requirements:**

1. The page renders five tabs — Types, Statuses, Sub-types, Work types, Shipping types — mapping to record types `initiative_type`, `initiative`, `initiative_sub_type`, `initiative_work_type`, `shipping_type`. Clone the Variables page's status-vocabulary tab structure (list rows with color chip, label, description, sort order, active state; add + edit affordances) and REUSE its `StatusEditModal` and `ColorField` components as-is — read `portal/src/pages/Variables.tsx` first and lift the minimal pattern, not the whole page (no usage counts here: that API branch is devtools-only; omit that column rather than calling it).
2. Edit/add affordances render only when the actor can write: `useAuth()`'s `maxRank >= ADMIN_RANK` (import from `lib/access.ts`) — staff see the vocabularies read-only. The server enforces the same rule regardless.
3. Header follows the house dev-page pattern: eyebrow "Initiatives", title "Options", hint explaining these lists drive the initiative forms (types, statuses, sub-types, work types, shipping types).
4. `tsc` + vitest clean; commit only this task's files.
   Message: `feat(portal): Initiatives Options page — vocabulary management without god mode`
