# Kiosk Label Templates Download Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A kiosk that syncs a move also downloads that move's label template set, by Jimmy's rules. Every template arrives ready for the kiosk to fill in and print without the portal. The web kiosk stores the set in IndexedDB; the laptop edge caches it.

**Architecture:**
- A new API service picks the templates, converts design templates to code with their tokens left in, and attaches the size and DPI details.
- Two routes serve it: `GET /kiosk/sync/label-templates`, plus a station-key twin.
- The web kiosk's `runSync` fetches the set as a soft step and stores it.
- The edge adds the path to its sync list and its station-sync list, so it's cached like the rest.

**Tech Stack:** FastAPI + SQLAlchemy (API), React + IndexedDB (kiosk), FastAPI + sqlite3 (edge).

**Spec:** `docs/superpowers/specs/2026-10-19-kiosk-label-templates-sync-design.md`

## Global Constraints

**Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/kiosk-label-templates`, branch `kiosk-label-templates`.

**Setup**, only if missing:
- `cd kiosk_laptop/edge && python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'`
- `npm --prefix kiosk ci && npm --prefix portal ci`
- API tests need symlinks: `api/.venv` → `/Users/jrh1812/Developer/BaseCampV3/api/.venv` and `.env` → `/Users/jrh1812/Developer/BaseCampV3/.env`. Remove both after committing and never stage them.

**Git:** stage by explicit path only; never `.superpowers/`, `.venv`, `node_modules` or `.env`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Suites:** run every suite in the FOREGROUND with a 600000 ms timeout.
- API: `cd api && SS_TEST_DB=serversherpa_test_label_templates PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q -p no:cacheprovider <files>`
- Edge: `cd kiosk_laptop/edge && .venv/bin/pytest -q -p no:cacheprovider`
- Kiosk: `npm --prefix kiosk test -- --run`, then `npm --prefix kiosk run build`

**No portal migration.** **Copy:** American English.

**Selection rules (verbatim from the spec).** Active templates only. A template is included when any of these hold:
- its `label_type == "front"`;
- it is linked to the move's destination site;
- it is linked to the move's source (origin) site;
- its name contains "generic" (case-insensitive);
- its `label_type` is `container` or `container_info`;
- **fallback:** it is named exactly "Generic Rack and RU" (case-insensitive), and no active template is linked to the destination site. A move with no destination site counts as having none.

Each template appears once, with a **set** of reasons from `destination_site`, `source_site`, `front`, `generic`, `container`, `fallback`. Both DPI versions come down because they are separate templates. Output is ordered by `natural(name)`.

**Access:** copy `/kiosk/sync/containers` exactly, both the session route (move lock, move-password checks) and the `/kiosk/station/sync/*` twin. A non-move initiative gets 422 and an unknown one 404, the same as the others.

## Review Focus

1. **Tokens survive conversion.** A design template converted with no values keeps every `{placeholder}` token in the output, and filling them in (`apply_placeholders`) gives the same text the portal's generator renders for a simple asset. Pin it with a test that compares against `render_label` for one design template. If they differ, record exactly how in the task report; the spec's §7 risk is for the next step. (Task 1.)
2. **Inactive templates and templates for other sites never leak in,** except through the Front, Generic and Container rules. (Task 1.)
3. **A failed template fetch never fails the move sync,** and the kiosk keeps its previous set. (Task 2.)
4. **The laptop serves the set offline** from its cache, including for an RFID Station syncing under the station key. (Task 2.)

---

### Task 1: API — select, convert and serve the move's label templates

**Files:**
- Create: `api/src/serversherpa/labels/kiosk_templates.py`
- Modify:
  - `api/src/serversherpa/api/schemas.py`: add `KioskLabelTemplateOut` and `KioskLabelTemplatesSyncOut`.
  - `api/src/serversherpa/api/routes/kiosk.py`: add the two routes, next to the container sync routes and their station twin.
- Test: `api/tests/test_kiosk_label_templates_sync.py`

**Interfaces:**
- Produces `async def move_template_set(db, initiative) -> list[tuple[LabelTemplate, set[str]]]` in `labels/kiosk_templates.py`.
- Produces `def template_code(template, size_meta, dpi_meta) -> str`:
  - `code` kind: returns `template.code`;
  - `design` kind: `compile_parsed_design(parse_design({...design, size}), dots=..., language_key=..., subs=None)`, so tokens stay intact. Copy how `generate/engine.py` builds the design and size, and how the worker looks up size and DPI metadata.
- `KioskLabelTemplateOut` fields:
  - identity: `id`, `name`, `label_type`, `size_key`, `dpi_key`, `language_key`, `version`, `updated_at`, `site_names: list[str]`;
  - `reasons: list[str]`, sorted;
  - `code: str` and `generation_rules: dict`;
  - size and DPI details: `width_in`, `height_in`, `dots`;
  - `error: str | None`, set when a design can't convert; the template is still listed with `code: ""`.
- `KioskLabelTemplatesSyncOut`: `initiative_id`, `generated_at`, `templates: list[KioskLabelTemplateOut]`.
- Routes:
  - `GET /kiosk/sync/label-templates?initiative_id=`
  - `GET /kiosk/station/sync/label-templates?serial=&initiative_id=`

- [ ] **Step 1: Write the failing tests.** Seed a move with origin and destination sites, then check each rule and the edge cases:
  - Front template included with reason `front`.
  - Destination-linked and source-linked templates included with their reasons.
  - A template linked only to another site is excluded.
  - Generic-named templates included, whatever the case, with reason `generic`.
  - Container and container_info included.
  - Inactive templates excluded everywhere.
  - A template matching two rules appears once, with both reasons.
  - **Fallback:**
    - no destination template → Generic Rack and RU gets `fallback` (plus `generic`);
    - destination has a template → no `fallback` reason;
    - move with no destination site → fallback applies.
  - 203 and 300 DPI versions both listed.
  - A design template's code keeps its `{asset_name}` token, and filling it in matches `render_label` (Review Focus 1).
  - A code template's code is returned verbatim.
  - The station twin works, and access errors match `/sync/containers` (non-move 422, unknown 404, wrong move key 403 `move_locked`).
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the new file plus `test_kiosk_sync_api.py`, `test_kiosk_station_scans.py` and the labels generate tests (grep `api/tests` for `render_label` / `select_template`). All pass.**
- [ ] **Step 5: Commit** `feat: kiosk move sync label templates (front, site, generic, container, fallback)`.

### Task 2: Kiosk and edge — download, store and cache the set

**Files:**
- Modify:
  - `kiosk/src/lib/localDb.ts`: bump `DB_VERSION` to 6 and add store `label_templates` (keyPath `id`). Add it to whatever list "Clear local data" uses for move stores, so it clears with the move data.
  - `kiosk/src/lib/sync.ts`: `runSync` fetches `/kiosk/sync/label-templates?initiative_id=` after the asset sync. On success it replaces the store; on failure it logs, keeps the old set, and the sync still succeeds.
  - `kiosk/src/lib/api.ts`: add the types and fetcher.
  - Add a small read helper, e.g. `getLabelTemplates()`, for the next step.
  - `kiosk_laptop/edge/src/edge/sync.py`: add `/kiosk/sync/label-templates?{q}` to `sync_paths`, and `"label-templates"` to `STATION_SYNC`. A 404 from an older portal stores an empty `{templates: []}`, like `client-assets` does. Check that `CACHEABLE` already covers `/kiosk/sync/`.
- Test: kiosk `sync.test.ts` and `localDb.test.ts`; edge `test_sync.py`.

- [ ] **Step 1: Write the failing tests.**
  - Kiosk:
    - `runSync` stores the templates;
    - a failed template fetch keeps the old set and the sync still succeeds;
    - a second sync replaces the set, so a template that no longer matches is removed;
    - the DB upgrades from v5 to v6 without losing data;
    - "Clear local data" empties the store.
  - Edge:
    - the person sync caches the label-templates response;
    - the station sync caches it under the same key;
    - an older portal's 404 is stored as an empty set;
    - a cached GET is served offline.
- [ ] **Step 2: Run them; they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the full edge suite, the full kiosk suite and the kiosk build. All pass.**
- [ ] **Step 5: Commit** `feat(kiosk): download and keep the move's label templates; edge caches them`.
