# Status values + the Variables admin page

**Date:** 2026-07-15
**Status:** approved

## Problem

Controlled vocabularies in this codebase are one narrow table each, seeded at
migration time, editable only through a `PATCH` on a few label fields. There is
no create, no delete, and no admin surface — a new status means a migration.

The tables have also drifted apart for no reason. `site_types` has `icon` but no
`color`; `site_statuses` has `color` but no `icon`; `worker_levels` uses `level`
as its PK and `rank` as its sort where the site tables use `key` and
`sort_order`. And `worker_profiles.status` isn't a lookup at all — it's a CHECK
constraint over three bare strings with no label, colour, or description.

More entities will need statuses. Each one currently costs a table.

## Approach

One new `status_values` table, discriminated by `record_type`, holding the
status vocabulary for every entity. Status is the one vocabulary with the same
shape everywhere: label, description, colour, sort order.

`site_types`, `worker_levels`, and `roles` keep their own tables. Their extra
columns (`icon`, `expected_skills`, `scope_anchor`/`is_system`) have no
parallel in each other, and folding them together would mean a wide table of
mostly-NULL columns. They get UI, not a migration.

### Decisions

| Question | Decision |
|---|---|
| Existing `site_statuses` | Folded in and dropped. No compatibility shim. |
| Removing a value | No `DELETE`. `is_active` gates pickers; existing rows keep rendering. |
| `record_type` governance | Code-side registry, mirroring `access/resources.py`. |
| Launch record types | `site` and `worker`. |
| Page shape | One tabbed page: Statuses / Site types / Worker levels. |
| Nav | Flat nav, hierarchical URL. No third accordion level yet. |
| Write gate | `devtools` — developer-only, for all three tabs. |
| Read gate | The owning entity's `view` permission. |
| Create on site types / worker levels | Out of scope. Edit-only. |

## Data model

```
status_values
  record_type   text        NOT NULL   -- validated against the code registry
  key           text        NOT NULL
  label         text        NOT NULL
  description   text        NOT NULL DEFAULT ''
  color         text        NOT NULL   -- token name: c-green, c-amber, …
  sort_order    integer     NOT NULL DEFAULT 0
  is_active     boolean     NOT NULL DEFAULT true
  updated_at    timestamptz NOT NULL DEFAULT now()
  PRIMARY KEY (record_type, key)
```

The composite PK is what keeps the FK honest. A FK on `key` alone would let a
site reference a worker status. Each consuming table exposes its record type as
a generated column so the composite FK has something to point at:

```sql
ALTER TABLE sites ADD COLUMN status_record_type text
  GENERATED ALWAYS AS ('site') STORED;
ALTER TABLE sites ADD CONSTRAINT fk_sites_status
  FOREIGN KEY (status_record_type, status) REFERENCES status_values(record_type, key);
```

Postgres computes the column, so it cannot drift. `worker_profiles` gets the
same with `'worker'`. Both `status` columns are already `NOT NULL` with a
`server_default` of `'active'`, so the FK needs no NULL tolerance.

`is_active` does not participate in the FK. A record may reference a
deactivated status indefinitely and still render its label and colour;
deactivation only means "don't offer this in pickers." The FK is what makes
that safe.

### `key` is immutable — and that is load-bearing

`PATCH` cannot change `key` or `record_type`. Beyond the obvious (they are the
PK and the FK target), `worker_profiles` carries a second CHECK constraint:

```sql
status != 'blacklist' OR status_note IS NOT NULL
```

That hardcodes the literal string `'blacklist'`. It survives the move to
editable data only because no API can rename that key. An admin may relabel
`blacklist` to "Do not dispatch"; the underlying key, and therefore the
constraint, is untouched. If key editing is ever added, this constraint must be
revisited first.

### Registry

`api/src/serversherpa/status/registry.py`, shaped after `access/resources.py`:

```python
StatusRecordType("site",   "Site",   table="sites",
                 column="status", resource="sites")
StatusRecordType("worker", "Worker", table="worker_profiles",
                 column="status", resource="workers")
```

`resource` drives the read gate. `table`/`column` let the API compute a live
usage count per value — the information needed before deciding to deactivate
something.

A `record_type` is not data: a row saying `record_type='invoice'` is inert until
an invoices feature ships, and that feature ships as a deploy anyway. So the
registry costs nothing that wasn't already being paid, and it matches the
existing convention rather than introducing a second one.

## Migration `0012_status_values.py`

In order:

1. Create `status_values`.
2. Copy the four `site_statuses` rows in as `record_type='site'`.
3. Insert `record_type='worker'`: `active`/Active/c-green,
   `standby`/Standby/c-amber, `blacklist`/Blacklist/c-red. Descriptions written
   fresh — these have none today.
4. Add generated columns + composite FKs on `sites` and `worker_profiles`.
5. Drop the `sites.status → site_statuses.key` FK.
6. Drop `worker_profiles_status_check`.
7. Drop `site_statuses`.

Downgrade reverses it. `worker_profiles_blacklist_note_check` is untouched
throughout.

## API

| Endpoint | Gate | Notes |
|---|---|---|
| `GET /status-values?record_type=site` | that type's `resource:view` | active only, no counts |
| `GET /status-values` | `devtools:view` | all types, includes inactive, with usage counts |
| `POST /status-values` | `devtools:add` | |
| `PATCH /status-values/{record_type}/{key}` | `devtools:change` | `label`, `description`, `color`, `sort_order`, `is_active` |

No `DELETE`.

The split means the count query only runs for the one caller that wants it, and
an ordinary user cannot enumerate record types they have no business seeing.
An unknown `record_type` is a 422 `unknown_record_type`, matching the existing
`unknown_site_type` / `unknown_status` convention in `routes/sites.py`.

`devtools` is `developer_only=True` and `visible_to={"global"}`, so the hard
gate in `resolver.py` blocks every non-global actor before overrides are read.
`require_permission("devtools", ...)` therefore implies global on its own — no
`_require_global` call is needed, unlike the `settings:change` endpoints it
replaces.

### Changed endpoints

- `PATCH /site-types/{key}` — `settings:change` + `_require_global` →
  `devtools:change`.
- `PATCH /worker-levels/{level}` — `settings:change` → `devtools:change`. This
  also closes an existing gap: it never had the `_require_global` check its
  site-lookup counterparts do.
- `GET /worker-levels` — `require_roles("admin","staff","worker")` →
  `require_permission("workers", "view")`. The role list silently excludes
  `developer` and `founder` by name; the Worker levels tab would hit that
  immediately.
- `DELETE`d: `GET /site-statuses`, `PATCH /site-statuses/{key}`.

Setting a record's status is unaffected. `sites.status` is still written under
`sites:change`. The vocabulary is developer-gated; the value is not.

## Portal

**Route** `/dev/database/variables`, `<ProtectedRoute resource="devtools">`.
**Nav:** a second item in the existing Developer section, `godOnly: true` — without
it the page appears in the sidebar for anyone holding `devtools` whether or not
they have unlocked god mode. `devtools` keeps `routes=()` in the registry; the
god-mode spec omits them deliberately and that stays.

Also needs: a `navGated` line in `CommandPalette.tsx`, a `ROUTE_RESOURCE` entry
in `lib/access.ts`, and `CRUMBS`/`PAGES` entries in `Topbar.tsx`.

**Page:** `pages/Variables.tsx`, three tabs, each a list built from the existing
toolbar (`FilterButton` / `ColumnsButton` / `ExportButton` from
`lib/listTools.tsx`) in the canonical order, with the row-expand → Edit-modal
pattern from `pages/Sites.tsx`. Row expansion is read-only; every control lives
behind the Edit button.

- **Statuses** — loads unfiltered `GET /status-values`. `record_type` is a
  facet, as is `is_active`. Columns: record type, key, label, description,
  colour swatch, sort order, active, usage count. `+ New status` when
  `can('devtools','add')`.
- **Site types** — `GET /site-types`. Edit-only.
- **Worker levels** — `GET /worker-levels`, ordered by `rank`. Edit-only.

Tabs are page-local state, not routes. Each tab owns its own facet and column
state.

**Client:** `listSiteStatuses()` in `lib/api.ts` repoints to
`/status-values?record_type=site` and keeps its signature, so `Sites.tsx` and
`SiteEditModal.tsx` need no change beyond what the type requires.

**Pure helpers** in `lib/variables.ts` with `lib/variables.test.ts` beside it,
per the house convention: search text, facet extraction, form ↔ payload
mapping, and the create-mode save trap (`needsStatusCreate`) that `lib/sites.ts`
solves for sites — once `POST` succeeds, a retry must never re-create.

## Testing

**API** (`api/tests/test_status_values.py`):
- Read gate: `sites:view` reads `?record_type=site`; the same actor is refused
  the unfiltered listing. A `devtools` holder gets both.
- Write gate: `settings:change` alone is refused `POST`/`PATCH`. A non-global
  actor with a `devtools` override is refused by the hard gate.
- `key`/`record_type` are rejected in a `PATCH` body (`extra="forbid"`).
- Unknown `record_type` → 422 `unknown_record_type`.
- Deactivating an in-use status succeeds, and the referencing record still
  renders its label and colour.
- The composite FK rejects a site pointing at a worker status key.
- Usage counts are correct and absent from the entity-scoped listing.

**Migration:** upgrade preserves all four site statuses and every
`worker_profiles.status` value; downgrade restores the CHECK constraint.

**Portal** (`lib/variables.test.ts`): the pure helpers, per convention.
`lib/godmode.test.ts` gains a case pinning that the Variables nav item is hidden
without god mode even when `devtools` is held.

## Out of scope

- Create/delete for `site_types` and `worker_levels`. Adding a level means
  picking a free `rank` and reordering against a unique constraint — a real
  feature, not a form field.
- A third nav level. Worth doing when Database holds three pages.
- Migrating `roles` or `access_groups` to this table.
- Editing `key`. See the `blacklist` CHECK above.
