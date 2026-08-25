# God-Mode Pending Deletes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** God-mode users can mark any directory record "pending delete"; a new Developer → Database page lists the marked records and offers one Reconcile control that hard-deletes them all (best-effort, per-row error reporting).

**Architecture:** One generic `pending_deletes` table + a devtools-gated API (mark / unmark / list / reconcile with a frozen entity→model registry); portal gets a shared `GodDeleteButton` dropped into every directory page's expanded-row actions plus a "Pending delete" row tag, and a new `/dev/database` page.

**Tech Stack:** Existing (Alembic, FastAPI async, React/Vite).

## Global Constraints

- API checks: `cd api && .venv/bin/pytest`. Portal: `cd portal && npx tsc --noEmit && npx vitest run`.
- Machine-coded errors. Server-side gate is `require_permission("devtools", "change")` for mutations, `("devtools", "view")` for the list — god mode in the portal is visibility only.
- Reconcile must never fail wholesale: each row deletes inside its own savepoint (`db.begin_nested()`); FK violations are caught per row and reported, the marker row stays for failures and is removed on success. Response: `{"deleted": <n>, "failed": [{"entity_type", "entity_id", "label", "reason"}]}` where reason is a short machine string (e.g. `fk_violation`, `not_found` — a target already hard-deleted elsewhere counts as success and clears the marker).
- Every successful hard delete writes an audit row (`action="hard_delete"`, entity_type/id of the target).
- Working tree hygiene: stage only files your task owns; other sessions may hold uncommitted changes elsewhere.

---

### Task 1: API — pending_deletes table + devtools endpoints

**Files:**
- Create: migration `api/migrations/versions/00XX_pending_deletes.py` (next free number — check)
- Modify: `api/src/serversherpa/db/models.py` (PendingDelete model)
- Modify: `api/src/serversherpa/api/schemas.py` (banner section)
- Modify: `api/src/serversherpa/api/routes/devtools.py` (endpoints — read its existing guard style first)
- Modify: `api/tests/conftest.py` (TRUNCATE list gains `pending_deletes`)
- Test: `api/tests/test_pending_deletes_api.py`

**Requirements (prose spec — follow existing idioms):**

1. Table `pending_deletes`: `id` uuid PK gen_random_uuid, `entity_type` text NOT NULL, `entity_id` uuid NOT NULL, `entity_label` text NOT NULL DEFAULT '' (display-only snapshot), `marked_by` uuid FK people NULL, `marked_at` timestamptz NOT NULL now(). Unique `(entity_type, entity_id)`. Full downgrade.
2. Frozen registry in the router: `DELETABLE: dict[str, type]` mapping `person → Person, client → Client, partner → Partner, site → Site, asset → Asset, asset_model → AssetModel, container → Container, initiative → Initiative`. Unknown type → 422 `unknown_entity_type`; target row must exist at mark time → 422 `entity_not_found`; duplicate mark → 409 `already_pending`.
3. Endpoints (in devtools.py, matching its existing router/prefix conventions):
   - `GET /devtools/pending-deletes` (devtools view) → list, newest first, each row + `marked_by_name`.
   - `POST /devtools/pending-deletes` (devtools change) body `{entity_type, entity_id, entity_label}`.
   - `DELETE /devtools/pending-deletes/{id}` (devtools change) → 204 unmark; 404 `marker_not_found`.
   - `POST /devtools/pending-deletes/reconcile` (devtools change) → per Global Constraints; deletes the target via `db.delete()` inside `begin_nested()` per row so one FK failure doesn't poison the batch; audit each success (`hard_delete`); return the summary.
4. Tests: mark/list/unmark round-trip; duplicate → 409; unknown type → 422; reconcile deletes a marked initiative (verify row gone + marker gone + audit row exists); reconcile reports `fk_violation` and RETAINS the marker for a site that an initiative still references (create site, reference it from an initiative's `site_id`, mark site, reconcile → failed entry, site still present); a marker whose target is already gone reconciles as success (marker cleared, counted in `deleted`); non-devtools actor (staff) → 403 on all four.
5. Full suite green before committing; commit only this task's files.
   Message: `feat(api): god-mode pending deletes — mark, list, reconcile with per-row savepoints`

### Task 2: Portal — GodDeleteButton on every directory page

**Files:**
- Modify: `portal/src/lib/api.ts` (client + `PendingDeleteItem` interface, `/* ── pending deletes ── */` banner)
- Create: `portal/src/components/GodDeleteButton.tsx`
- Create: `portal/src/lib/pendingDeletes.ts` — a tiny shared hook `usePendingDeletes(enabled: boolean)` returning `{pendingIds: Set<string>, mark, unmark, refresh}` (fetches the list once when enabled; pure helpers unit-testable where practical)
- Modify: every directory page with expanded rows — `Users` (people/users), `Workers`, `External`, `OrgDirectory` (covers Clients + Partners), `Sites`, `Assets`, `AssetModels`, `Containers`, `Initiatives` (find exact files; External may share Users' surface — read before assuming)
- Test: `portal/src/lib/pendingDeletes.test.ts` for any pure logic

**Requirements:**

1. `GodDeleteButton` props: `entityType`, `entityId`, `label`, `pending: boolean`, `onChange`. Renders nothing unless passed `visible` (pages gate on `godMode` from `useAuth()`). Not pending → small danger button "Delete" (`mini-btn sm danger` idiom) that marks (POST) with a `confirm()` guard; pending → a "Pending delete" `chip tag` + small "Undo" button that unmarks.
2. Each listed page: in the expanded-row detail actions area, render the button (entity_type per the Task 1 registry; `label` = the row's display name). Rows whose id is in `pendingIds` also show a "Pending delete" tag chip next to their status chips in the row itself.
3. The hook fetches `/devtools/pending-deletes` only when `godMode` is true (never for normal users) and exposes mark/unmark that update the local set optimistically.
4. `tsc` + vitest clean; commit only this task's files.
   Message: `feat(portal): god-mode Delete on directory rows — pending-delete marks`

### Task 3: Portal — Developer → Database page with Reconcile

**Files:**
- Create: `portal/src/pages/DevDatabase.tsx`
- Modify: `portal/src/App.tsx` (route `/dev/database`, ProtectedRoute resource `devtools`)
- Modify: `portal/src/layout/navSections.tsx` (Developer section gains "Database", godOnly — mirror how "Variables" at `/dev/database/variables` is declared)
- Modify: `portal/src/components/CommandPalette.tsx` (`navGated('Database', '/dev/database', 'devtools', true)` — match the Variables entry's arity)
- Modify: `portal/src/lib/access.ts` (`ROUTE_RESOURCE['/dev/database'] = 'devtools'`)
- Modify: `portal/src/lib/api.ts` (reconcile client call if not added in Task 2)

**Requirements:**

1. Page lists pending records grouped by entity type: label, type, marked-by, marked-at, per-row Undo (unmark). Empty state: "Nothing pending delete."
2. One primary control: "Reconcile — permanently delete N records" with a `confirm()` guard. On completion show the summary inline: deleted count, and each failure as label + human reason (`fk_violation` → "Still referenced by other records — remove those references first."). Failed rows remain listed.
3. Follow the Variables page's structure/styling as the dev-page exemplar (read it first).
4. `tsc` + vitest clean; commit only this task's files.
   Message: `feat(portal): Developer Database page — pending-delete reconcile`
