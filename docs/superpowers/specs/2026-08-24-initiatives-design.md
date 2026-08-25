# Initiatives — unified projects / events / moves

**Date:** 2026-08-24
**Status:** Approved pending review
**Replaces (V2):** the entire "Initiatives" nav group — `projects`, `events`, `moves` tables, twelve pages (`Projects/Events/Moves` list + `New*` + `*Detail` + `Edit*`), `people_work_association`, `projects_associations`.

## Background — what we are replacing

V2 modeled projects, events, and moves as three separate tables, three route
families, and three permission keys, yet ~85% of their fields are the same
concept under inconsistent names (`scheduled_date` vs `scheduled_start`,
`client` vs `client_id`, `status` vs `move_status`). V2 itself already unified
them in embryo: the client "Work History" table `UNION ALL`s the three tables
into one list with a type chip, and four other screens concatenate the three
list endpoints client-side to build "initiative" dropdowns.

V3 unifies them into **one `initiatives` table with an `initiative_type`
vocabulary field** (`project` | `event` | `move`). All three types are equal
and selectable; type-specific fields are nullable columns shown conditionally
in the form.

### Problems this design deliberately fixes

1. **Client-blanking bug** — V2 `EditProject.jsx` read `client_id` from a
   response that returned `client`, so saving a project silently cleared its
   client. One entity, one field name.
2. **Shipping type stored as a comma-joined string** — becomes `text[]`
   validated against a `shipping_type` vocabulary.
3. **`source_vendor_involment` misspelling** — schema-level, propagated
   through pydantic and the frontend. Renamed `*_vendor_involved`.
4. **Status vocabulary confusion** — V2 projects/events joined
   `status_options` with no type filter and populated their dropdowns from the
   *Moves* vocabulary; new projects hardcoded status id 43. One shared
   `initiative` status vocabulary, seeded, with an explicit default.
5. **Project-only associations** — V2 only projects could contain
   moves/events/sub-projects, and the circular-reference guard covered only
   project→project. Links become initiative↔initiative for any types, cycle
   guard universal.
6. **Orphan columns** — `projects.site` / `events.site` were written by bulk
   import but never read. Dropped; a real `site_id` lives on the core.
7. **Advertised-but-missing end date** — V2's bulk CSV templates offered
   `start_date`/`end_date` columns that didn't exist. Core gets
   `scheduled_start` + `scheduled_end`.
8. **"Completed" matched by lowercased label string** in list pages and
   dashboards. V3 filters on vocabulary keys.

## Decisions

1. **Unified entity, "label + extra fields"** — shared core on every
   initiative; type-specific fields are real nullable columns shown when the
   type is selected. (Not a JSONB `details` blob: 9 of the move fields are
   FKs to sites/partners, and V3's entire tooling — vocab FKs, god-edit,
   column filters — assumes real columns.)
2. **Type is admin-changeable** — `initiative_type` is editable after
   creation by admins only (403 `type_change_forbidden` otherwise). On type
   change, previous type-specific field values are retained in the DB, just
   hidden by the form.
3. **Fresh start** — no V2 data migration. Old data stays in V2 for
   reference.
4. **One wide table** — no 1:1 side table, no JSONB.
5. **Sub-type is a vocabulary** (`initiative_sub_type`), replacing V2's
   free-text `project_type`/`event_type`.
6. **Slice scope** — this spec covers CRUD + list page + people assignments +
   initiative links. Deferred to later specs: move asset tracking / scanning /
   reports / dashboards / bulk import; the man-hours time summary (V3 has no
   timeclock yet — when timeclock is ported its entries will reference
   `initiative_id` and the card becomes a pure read); client-portal
   visibility (resource is global-only for now); V2's rating→worker-average
   recompute (open until V3 workers display a rating).
7. **V2 `metadata` JSONB columns dropped** (pattern unused in V3);
   `asset_count` deferred to the move-assets slice.

## Data model

Migration: next free revision number (0016 at time of writing; renumber if
taken). Seeds vocabularies, creates tables + generated-column composite FKs
into `status_values(record_type, key)`, indexes, role grants. Full
`downgrade()`.

### `initiatives`

Shared core (all types):

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `name` | text | NOT NULL |
| `description` | text | NULL |
| `initiative_type` | text | NOT NULL, vocab `initiative_type` (seeds: `project`, `event`, `move`) |
| `sub_type` | text | NULL, vocab `initiative_sub_type` (seed a starter set from V2's common values) |
| `status` | text | NOT NULL DEFAULT `planned`, vocab `initiative` (seeds: `planned`, `scheduled`, `in_progress`, `on_hold`, `completed`, `cancelled`) |
| `client_id` | uuid | NULL, FK clients |
| `site_id` | uuid | NULL, FK sites |
| `location` | text | NULL — free-text fallback when no site fits |
| `scheduled_start` | timestamptz | NULL |
| `scheduled_end` | timestamptz | NULL |
| `sky_command_project_id` | text | NULL — shown on project-type forms |
| archive + audit columns | | same pattern as `containers` |

Move block (all NULL, form shows when type = `move`; writable regardless of
current type per Decision 2):

| Column | Type |
|---|---|
| `origin_site_id`, `destination_site_id` | uuid FK sites |
| `real_start_at`, `real_end_at` | timestamptz |
| `priority_devices` | boolean |
| `shipping_types` | text[] — API-validated against vocab `shipping_type` (seeds: `truck`, `air`, `rail`, `ferry`; array so no composite-FK enforcement — the one deliberate exception) |
| `shipping_partner_id` | uuid FK partners |
| `origin_tech_partner_id`, `origin_cable_partner_id`, `origin_logistics_partner_id` | uuid FK partners |
| `destination_tech_partner_id`, `destination_cable_partner_id`, `destination_logistics_partner_id` | uuid FK partners |
| `origin_vendor_involved`, `destination_vendor_involved` | boolean |

### `initiative_people`

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `initiative_id` | uuid | NOT NULL FK initiatives ON DELETE CASCADE |
| `person_id` | uuid | NOT NULL FK people |
| `work_type` | text | NULL, vocab `initiative_work_type` |
| `site_worked_id` | uuid | NULL, FK sites |
| `rating` | smallint | NULL, CHECK 1–5 |
| `created_at` / `updated_at` | timestamptz | |

Unique `(initiative_id, person_id)` → 409 `duplicate_person`.

### `initiative_links`

| Column | Type | Constraints |
|---|---|---|
| `id` | uuid | PK |
| `parent_id` | uuid | NOT NULL FK initiatives ON DELETE CASCADE |
| `child_id` | uuid | NOT NULL FK initiatives ON DELETE CASCADE |
| `role` | text | NULL |
| `sort_order` | integer | NULL |
| `notes` | text | NULL |
| `created_at` | timestamptz | |

Unique `(parent_id, child_id)` → 409 `duplicate_link`. CHECK
`parent_id <> child_id` → 422 `self_link`. API walks ancestors on create →
422 `circular_link`. Any type may parent any type.

### Registries and wiring

- `status/registry.py`: five entries — `initiative` (status), `initiative_type`,
  `initiative_sub_type` (all on `initiatives`), `initiative_work_type`
  (on `initiative_people`), `shipping_type` (on `initiatives.shipping_types`,
  array-validated in API). All appear automatically on the Variables page.
  Colors from the house palette.
- `access/resources.py`: `Resource("initiatives", "Initiatives",
  routes=("/initiatives",), visible_to=frozenset({"global"}))` — global-only
  this slice; client visibility is a future decision.
- `access/defaults.py` + migration grant seeds, kept in exact sync.
- Notes/files: V3's existing polymorphic notes/files mechanism with
  `entity_type="initiative"` (replaces V2's three separate notes/images/
  documents association styles).

## API

Router `api/routes/initiatives.py`, containers conventions throughout:
`_err` machine codes, `_check_refs`, denormalized `(label, color)` on rows,
audit in the same transaction, soft archive, no list pagination, literal
routes above `/{id}`.

| Method + path | Guard (`initiatives`, verb) | Behavior |
|---|---|---|
| `GET /initiatives` | view | full list, `created_at desc`; denormalized: type/sub_type/status label+color, `client_name`, `site_name`, `origin_site_name`, `destination_site_name`, `shipping_partner_name`, `people_count`, `links_count` |
| `POST /initiatives` | add | validates all FKs/vocab keys; 422 codes below |
| `GET /initiatives/{id}` | view | detail: row + people (with person name, work-type chip) + links (both directions, each with the other initiative's name/type/status chips) |
| `PATCH /initiatives/{id}` | change | partial; `initiative_type` change requires admin else 403 `type_change_forbidden`; old type-specific values retained |
| `POST /initiatives/{id}/archive`, `/unarchive` | delete / change | 204, soft |
| `GET /initiatives/{id}/people` | view | |
| `POST /initiatives/{id}/people` | change | 409 `duplicate_person` |
| `PATCH /initiatives/people/{assoc_id}` | change | work_type / site_worked / rating |
| `DELETE /initiatives/people/{assoc_id}` | change | hard delete of the association row |
| `GET /initiatives/{id}/links` | view | |
| `POST /initiatives/{id}/links` | change | 422 `self_link` / `circular_link`, 409 `duplicate_link` |
| `PATCH /initiatives/links/{link_id}` | change | role / sort_order / notes |
| `DELETE /initiatives/links/{link_id}` | change | hard delete of the link row |
| `GET /initiatives/{id}/audit` | view | paginated (limit ≤ 500) |

Error codes: `initiative_not_found`, `client_not_found`, `site_not_found`,
`partner_not_found`, `person_not_found`, `unknown_status`,
`unknown_initiative_type`, `unknown_sub_type`, `unknown_work_type`,
`unknown_shipping_type`, `type_change_forbidden`, `duplicate_person`,
`duplicate_link`, `self_link`, `circular_link`, plus the standard
non-nullable empty-string 422s.

Global search: initiatives join the topbar search index (name, client name,
site names), `kind: 'initiative'`, deep-linking to `/initiatives?open=<id>`.

## Portal

One page for all three types — `/initiatives`.

- **Nav**: new sidebar section "Initiatives" with the single item; command
  palette `navGated('Initiatives', '/initiatives', 'initiatives')`; Topbar
  search deep-link case; `lib/access.ts` `ROUTE_RESOURCE` entry (also add the
  missing `/logistics/containers` entry found during exploration).
- **`pages/Initiatives.tsx`** — cloned from `Containers.tsx`: `COLUMNS` =
  name, type (chip), sub-type (chip), status (chip), client, site, location,
  scheduled start, scheduled end + move columns (origin, destination,
  shipping types, shipping partner, real start/end) default-hidden;
  per-column `ColumnMenu` filters; CSV export; `usePersistentListState
  ('initiatives', …)`; god-edit; `useRecordFocus` deep links;
  `EmptyClearFilters`.
- **Expanded row**: People panel (add person combo, work-type chip, rating,
  remove), Links panel (add link with role; rows show the other initiative's
  type/status chips and navigate on click), `NotesFilesPanel`.
- **`components/initiatives/InitiativeEditModal.tsx`** — only mutation
  surface; `null` = create. Type picker required on create, disabled on edit
  for non-admins (uses `useAuth()` role). Form sections: core always; Sky
  Command field when type = project; move block when type = move. Shipping
  types as checkbox group. All dropdowns from `GET /status-values?record_type=…`.
- **`lib/api.ts`** — `/* ── initiatives ── */` banner: `Initiative`,
  `InitiativePerson`, `InitiativeLink` interfaces + list/create/update/
  archive/people/links calls.
- **`lib/initiatives.ts`** — `initiativeSearchText`, `initiativeCellText`,
  `INITIATIVE_ERRORS` (code → sentence, incl. "Only admins can change an
  initiative's type."), `InitiativeFormState` + `formFromInitiative()` +
  `initiativePayload()`, god-fields factory. Unit-tested without jsdom.
- Styles: reuse `directory.css` vocabulary; new CSS file only if genuinely
  needed.

## Tests

- `api/tests/test_initiatives_model.py` — defaults, FK/unique/check
  constraints, vocab seeds present.
- `api/tests/test_initiatives_api.py` — CRUD roundtrip asserting denormalized
  labels; every 422 code; 403 `type_change_forbidden` for staff, success for
  admin with old move fields retained; archive/unarchive; 403 for a role
  without the permission; empty-string rejection on `name`.
- `api/tests/test_initiative_people_api.py` — add/update/remove, 409
  duplicate, rating bounds, unknown work_type.
- `api/tests/test_initiative_links_api.py` — add/remove, self-link, duplicate,
  circular chain (A→B→C then C→A rejected), cross-type links.
- `api/tests/test_search_initiatives.py` — global search hit + deep-link
  shape.
- `api/tests/conftest.py` — add the three tables to TRUNCATE list; add the
  five vocab seed-restore blocks.
- Portal: `lib/initiatives.test.ts`,
  `components/initiatives/InitiativeEditModal.test.tsx`; `npx tsc --noEmit`
  + `npx vitest run` clean.

Checks: `cd api && .venv/bin/pytest` · `cd portal && npx tsc --noEmit && npx vitest run`.
