# Seed Data Recipes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recipes, which are named sets of hand-ticked database rows and Spaces files from a snapshot, can be built into a subset snapshot and deployed to a new environment.

**Architecture:**
- **Scratch Postgres:** a container beside Sirdar holds scratch databases. A snapshot's `db.dump` is restored there for browsing, and subsets are built there. Sirdar never reads a live environment.
- **Recipes:** they live in Sirdar's own database. A row is identified by its primary key. Each table is in one of three modes: empty, ticked rows, or All rows. Files can be overridden by hand.
- **Building a subset:** it does the following, in order:
  - copies the kept rows (ticked rows plus the required-FK closure) into a fresh database with the snapshot's schema;
  - empties optional links to rows that weren't kept;
  - fails on a required link to a row that wasn't kept;
  - optionally resets passwords and 2FA;
  - dumps the result;
  - bundles only the kept files.

  The result is an ordinary snapshot (`origin = "recipe"`). The existing "From a snapshot" deploy path restores it.
- **Web:** a new **Seed Data** nav section (DB and Spaces pages), plus a third Data-step choice, **From a recipe**.

**Tech Stack:**
- Python 3.13, FastAPI, async SQLAlchemy and asyncpg (Sirdar API), Alembic;
- Postgres 16 (scratch) and the `postgresql-client-16` tools from the PGDG apt repository;
- React and vitest (Sirdar web).

**Spec:** `docs/superpowers/specs/2026-11-07-sirdar-seed-data-recipes-design.md`, with the reviewed mockup at `.superpowers/brainstorm/62208-1794078203/content/seed-data.html`.

## Global Constraints

- Sirdar has no client or partner concepts. The only ServerSherpa-specific code is the password-reset list (Task 7).
- Scratch Postgres is major version **16**. `pg_restore`/`pg_dump` in the Sirdar image are exactly **16**: a newer `pg_dump` writes archives an environment's `pg_restore` 16 can't read.
- File-key columns are found by name: `storage_key`, `preview_key`, `avatar_key`, `logo_key`, `file_key`, or any column whose name ends in `_storage_key`. This is the same rule as `scripts/make-sql-seed-snapshot.sh`.
- Required link = a foreign key whose columns are all NOT NULL. Optional link = any other foreign key.
- The migration version table (`alembic_version`) always comes whole.
- Tables a recipe doesn't mention come over empty.
- With a filter on, Check all and Deselect all act on every row matching the filter, across pages.
- Copy: American English. Exact UI strings:
  - nav section `Seed Data`, with pages `DB` and `Spaces`;
  - Data-step choice `From a recipe`;
  - password choices `Keep passwords and 2FA` and `Make everyone reset their password`;
  - the needed-rows box `Added because they're needed`;
  - the files column `Kept because`;
  - the table switch `All rows`.
- Run tests from `sirdar/api` with `.venv/bin/pytest`, and from `sirdar/web` with `npx vitest run`. Test DB names start with `sirdar_test`. Tests never touch a real snapshot or environment.
- Stage files by explicit path. Never commit `api/src/serversherpa/_dev_reload.py`.

## Rulings made while planning (check while reading)

- **Password reset sets `user_accounts.password_hash` to NULL instead of a random hash.**
  - A random hash would need ServerSherpa's hashing and the pepper inside Sirdar.
  - With NULL, no password can match, and the reset link sets one, which is the outcome the spec asks for.
  - Cost if wrong: the portal shows those users as "Invited" until they reset.
- **"Take a new one" stays where it is today.** You take or upload a snapshot in Deploy › Snapshots, and the Data step then picks it, as "From a snapshot" does now.
- **A recipe deploy is two calls from the web.** The web first builds the subset snapshot and waits for it to be ready (progress shown), then creates the environment with that snapshot and the first super admin. The deploy pipeline doesn't change except that a recipe snapshot allows a first super admin.

- **The first super admin is required when "Make everyone reset their password" is chosen** and optional otherwise. With every password reset, nobody could sign in without one.
- **No caps** (Jimmy, 2026-11-07): no limit on ticked rows per table or on keys returned for Check all.

## Review Focus

1. **A table without a primary key:** it can't hold ticked rows. Show it with ticking disabled, offering only All rows or empty.
2. **A circular or self-referencing required FK** (a wiki page's parent): the closure must terminate, and the load must succeed in any order.
3. **A huge table** (`raw_scans`, `audit_log`): paging stays fast, and Check all with a filter returns keys without loading whole rows into the browser.
4. **A recipe naming a table, column or key the snapshot lacks:** it's skipped and listed, never a 500.
5. **Reset mode on a snapshot missing one of the listed reset tables or columns:** the build fails and names it, and never ships the secret.

---

### Task 1: Data model, migration and access resource

**Files:**
- Modify: `sirdar/api/src/sirdar_api/db/models.py` (new `SeedRecipe`, `SeedRecipeTable`, `SeedRecipeRow`, `SeedRecipeFile`; `Snapshot` gains `recipe_id`, `source_snapshot_id`, `reset_passwords`)
- Create: `sirdar/api/migrations/versions/0017_seed_recipes.py`
- Modify: `sirdar/api/src/sirdar_api/access/resources.py` (`Resource("seed_data", "Seed Data")`), `access/defaults.py` (every role gets the same actions for `seed_data` as it has for `deploy`)
- Test: `sirdar/api/tests/test_seed_models.py`

**Interfaces (Produces):**
- `seed_recipes(id uuid pk, name text unique, notes text default '', created_by uuid null, created_at, updated_at)`
- `seed_recipe_tables(recipe_id fk cascade, table_name text, mode text check in ('rows','all'), pk(recipe_id, table_name))`. A table with no row here is empty.
- `seed_recipe_rows(recipe_id fk cascade, table_name text, pk jsonb, pk(recipe_id, table_name, pk))`. `pk` is a JSON object `{column: value-as-text}` covering every primary-key column.
- `seed_recipe_files(recipe_id fk cascade, key text, keep bool, pk(recipe_id, key))`. These are manual overrides only.
- `snapshots.origin` also allows `"recipe"`. New nullable columns `recipe_id` (fk on delete set null), `source_snapshot_id` (fk on delete set null) and `reset_passwords` bool default false.

- [ ] **Step 1: Write failing tests:** creating a recipe with each child table round-trips; deleting a recipe cascades its children and sets `snapshots.recipe_id` to NULL; a duplicate name is refused; `mode='x'` is refused; `"seed_data"` is in `REGISTRY`; and for every role in `defaults`, `seed_data` equals `deploy`.
- [ ] **Step 2: Run** `.venv/bin/pytest -q tests/test_seed_models.py`. Expected: FAIL.
- [ ] **Step 3: Implement the models and migration 0017** (downgrade drops them). Add the resource and defaults.
- [ ] **Step 4: Run** the test file plus `tests/test_access*.py`. Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(sirdar): seed recipe tables and the seed_data permission`.

### Task 2: Scratch Postgres and restoring a snapshot into it

**Files:**
- Modify: `sirdar/docker-compose.yml` (service `sirdar-scratch`: `postgres:16-alpine`, its own named volume, password `SIRDAR_SCRATCH_PASSWORD`, healthcheck like `sirdar-db`; `sirdar` gets `SIRDAR_SCRATCH_URL=postgresql://postgres:${SIRDAR_SCRATCH_PASSWORD}@sirdar-scratch:5432/postgres`)
- Modify: `sirdar/install.sh` and `sirdar/.env.example` (generate `SIRDAR_SCRATCH_PASSWORD` on first install, as `SIRDAR_DB_PASSWORD` is)
- Modify: `sirdar/Dockerfile` (final stage: `postgresql-client-16` from apt.postgresql.org)
- Modify: `sirdar/api/src/sirdar_api/config.py` (`scratch_url: str = ""`, `scratch_idle_minutes: int = 60`)
- Create: `sirdar/api/src/sirdar_api/seed/__init__.py`, `sirdar/api/src/sirdar_api/seed/scratch.py`
- Test: `sirdar/api/tests/test_seed_scratch.py`, plus a tests conftest fixture that points `scratch_url` at the test Postgres

**Interfaces (Produces):**
- `scratch.db_name(snapshot_id: uuid.UUID, purpose: str = "browse") -> str`, which returns `f"sirdar_scratch_{purpose}_{snapshot_id.hex}"` (in tests `sirdar_test_scratch_…`).
- `async def ensure_restored(settings, snap: Snapshot) -> str`: extracts `db.dump` from the bundle into a private temp dir, creates the DB if missing, runs `pg_restore --no-owner --no-privileges --dbname`, records it as ready, and returns the DB name. If two callers start at once, only one restores (a per-name `asyncio.Lock`). If a restore fails, the half-made DB is dropped and `SeedError("restore_failed")` is raised.
- `async def connect(settings, name) -> asyncpg.Connection`
- `async def drop(settings, name) -> None`
- `async def sweep_idle(settings) -> int`: drops browse DBs unused for `scratch_idle_minutes`. It's called from the app's existing periodic loop, if there is one, or else from a new lifespan task.
- `scratch.status(snapshot_id) -> "absent"|"restoring"|"ready"|"failed"` (in memory).
- `class SeedError(Exception)` with a `code` attribute (in `seed/__init__.py`).
- `scratch_url` empty: every seed endpoint answers 409 `scratch_not_configured`.

- [ ] **Step 1: Write failing tests** using a small hand-made bundle. The fixture builds a `db.dump` with the test Postgres's `pg_dump -Fc` (two tables, one FK) and a tarred bundle in the format `snapshots.store_bundle` expects. Test that:
  - `ensure_restored` makes a DB with both tables;
  - a second concurrent call restores once;
  - a corrupt dump raises `restore_failed` and leaves no DB;
  - `sweep_idle` drops a DB past the idle time and keeps a fresh one;
  - with no `scratch_url`, the API answers 409.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Run the tools with `asyncio.create_subprocess_exec`, passing the password through `PGPASSWORD` in the child env only. Never log the URL.
- [ ] **Step 4: Run.** Expected: PASS. Also build the image locally (`docker build -f sirdar/Dockerfile .`) and check that `pg_restore --version` prints 16.x.
- [ ] **Step 5: Commit** with message `feat(sirdar): a scratch Postgres that snapshots are restored into for Seed Data`.

### Task 3: Browsing tables and rows

**Files:**
- Create: `sirdar/api/src/sirdar_api/seed/browse.py`, `sirdar/api/src/sirdar_api/api/routes/seed.py` (router prefix `/api/seed`, registered in `api/app.py`, resource `seed_data`)
- Test: `sirdar/api/tests/test_seed_browse.py`

**Interfaces (Produces):**
- `POST /api/seed/snapshots/{snapshot_id}/open`: starts `ensure_restored` in the background and returns `{"status": …}`. `GET /api/seed/snapshots/{snapshot_id}` returns `{"status": …}`.
- `GET /api/seed/snapshots/{id}/tables` returns `[{"table", "rows", "pk": [col…] | null, "file_columns": [col…]}]` for the `public` schema, sorted by name, without `alembic_version`.
- `GET /api/seed/snapshots/{id}/tables/{table}/rows?page=1&size=50&sort=col&dir=asc&filter_col=&filter=` returns `{"columns": [{"name","type"}], "rows": [{"pk": {...}, "values": {...}}], "total"}`.
  - The filter is a case-insensitive substring match on the column cast to text.
  - Table and column names are checked against the catalog, never interpolated raw (use `psycopg`-style identifier quoting via `asyncpg` plus a catalog check).
  - Values are rendered as text, cut to 200 characters; `bytea` shows as `<n bytes>`.
- `GET /api/seed/snapshots/{id}/tables/{table}/keys?filter_col=&filter=` returns `{"pks": [{...}], "total"}` for every matching row. Check all with a filter uses it.
- Views require `seed_data:view`.

- [ ] **Step 1: Write failing tests** against a restored test bundle:
  - the tables list, counts, `pk` and `file_columns`;
  - paging, sort, filter and total;
  - an unknown table or column answers 404 `table_not_found` / `column_not_found`, and an injection-style name is refused;
  - `keys` with a filter returns exactly the matching keys;
  - a table without a primary key reports `pk: null`;
  - access is refused without `seed_data`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(sirdar): browse a snapshot's tables and rows for Seed Data`.

### Task 4: Needed rows (the required-link closure)

**Files:**
- Create: `sirdar/api/src/sirdar_api/seed/closure.py`
- Modify: `sirdar/api/src/sirdar_api/api/routes/seed.py`
- Test: `sirdar/api/tests/test_seed_closure.py`

**Interfaces:**
- `async def foreign_keys(conn) -> list[ForeignKey]`. `ForeignKey(table, columns: tuple, ref_table, ref_columns: tuple, required: bool)` is read from `pg_constraint`. `required` means every column is NOT NULL.
- `async def closure(conn, kept: dict[str, set[PK] | Literal["all"]]) -> Closure`, where `Closure(added: dict[str, set[PK]], reasons: list[Reason])` and `Reason(table, pk, needed_by_table, needed_by_pk, via_columns)`.
  - It follows required FKs from every kept row, transitively, to a fixed point.
  - `"all"` tables are complete and never need additions.
  - `PK` is a tuple of the pk values as text, in pk-column order.
- `POST /api/seed/snapshots/{id}/resolve` with body `{"tables": {table: {"mode": "rows"|"all", "pks": [...]}}}` returns `{"added": {table: [pk-object…]}, "reasons": [{"table","pk","label","needed_by_table","needed_by_pk","needed_by_label"}], "missing": {table: [pk-object…]}}`.
  - `label` is the row's first text column that isn't a key (else its pk text). This is how the mockup shows "Person D".
  - `missing` lists ticked keys the snapshot doesn't have.

- [ ] **Step 1: Write failing tests** on a fixture schema covering:
  - person ← worker (required) ← site (optional to person);
  - three levels deep;
  - a self-referencing required parent;
  - a composite FK;
  - a two-table cycle.

  Assert that:
  - required links add rows with correct reasons;
  - optional links add nothing;
  - cycles terminate;
  - `"all"` tables add nothing;
  - missing keys are listed.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with set-based queries per FK per round (one `SELECT … WHERE (cols) IN (…)` per FK), not per row.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(sirdar): Seed Data ticks the rows a ticked row can't exist without`.

### Task 5: Recipes API

**Files:**
- Create: `sirdar/api/src/sirdar_api/seed/recipes.py`
- Modify: `sirdar/api/src/sirdar_api/api/routes/seed.py`
- Test: `sirdar/api/tests/test_seed_recipes_api.py`

**Interfaces:**
- `GET /api/seed/recipes` returns `[{"id","name","notes","tables": n, "rows": n, "files": n, "updated_at"}]`.
- `POST /api/seed/recipes` with `{"name","notes"}` (needs `seed_data:add`; a name that's taken answers 409 `recipe_name_taken`).
- `GET /api/seed/recipes/{id}` returns `{"id","name","notes","tables": {table: {"mode", "pks": [...]}}, "files": {key: bool}}`.
- `PUT /api/seed/recipes/{id}` with the same body shape replaces tables, rows and files in one transaction (`seed_data:change`). Validation:
  - pk objects must be flat string maps;
  - `mode` must be `rows` or `all`.
- `DELETE /api/seed/recipes/{id}` (`seed_data:delete`). Snapshots built from the recipe stay, with `recipe_id` NULL.
- Each change writes an audit row: `seed.recipe_create`, `seed.recipe_change` or `seed.recipe_delete`, with counts, never row values.

- [ ] **Step 1: Write failing tests** for CRUD, validation, a taken name, audit rows, and permissions per action.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(sirdar): save Seed Data recipes by name`.

### Task 6: Files that follow the records

**Files:**
- Create: `sirdar/api/src/sirdar_api/seed/files.py`
- Modify: `sirdar/api/src/sirdar_api/api/routes/seed.py`
- Test: `sirdar/api/tests/test_seed_files.py`

**Interfaces:**
- `def file_columns(columns: list[str]) -> list[str]` applies the Global Constraints naming rule.
- `async def referenced(conn, kept_rows: dict[str, set[PK] | "all"]) -> dict[str, Reason]` maps each storage key to its first referencing kept row (table, pk, label, column).
- `def object_keys(bundle_path) -> list[tuple[str, int]]` reads `objects.tar` member names and sizes without extracting.
- `GET /api/seed/snapshots/{id}/files?recipe_id=…&page&size&filter=` returns `{"files": [{"key","size","kept": bool,"because": str}], "total"}`, where:
  - `kept` = (referenced, or manual keep) and not manual drop;
  - `because` = `"Avatar of Person A (people)"`-style text built from the column name and row label, `"Ticked by hand"`, or `"—"`.

  The column-name-to-phrase map is: `avatar_key` → `Avatar of`, `logo_key` → `Logo of`, anything else → `File on`.

- [ ] **Step 1: Write failing tests:**
  - a kept row's key is kept with the right because-text;
  - a manual drop beats a reference;
  - a manual keep keeps an unreferenced file;
  - a key a row names that isn't in `objects.tar` is ignored;
  - the naming rule matches exactly the listed names and the `_storage_key` suffix.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(sirdar): Seed Data files follow their records`.

### Task 7: Building a subset snapshot

**Files:**
- Create: `sirdar/api/src/sirdar_api/seed/build.py`
- Modify: `sirdar/api/src/sirdar_api/deploy/snapshots.py` (store a bundle with `origin="recipe"` and the new columns; `snapshot_out` adds `recipe`, `source_snapshot`, `reset_passwords`)
- Modify: `sirdar/api/src/sirdar_api/api/routes/seed.py`
- Test: `sirdar/api/tests/test_seed_build.py`

**Interfaces:**
- `POST /api/seed/recipes/{id}/build` with `{"snapshot_id", "reset_passwords": bool}` (needs `seed_data:view` and `deploy:add`).
  - It creates a `pending` `Snapshot` named `"{recipe name} from {snapshot name}"`. If the name is taken it gets a suffix, as snapshot names already do.
  - It starts the build in the background and returns the snapshot via `snapshot_out`.
  - The existing snapshot status shows progress: `pending` → `ready` or `failed`. The failure reason is in `notes`.
- **Build steps, in order:**
  1. `ensure_restored` the source into a `purpose="build"` DB of its own.
  2. Create the subset DB from the source's schema (`pg_dump --schema-only` | `pg_restore`).
  3. Load the kept rows in one transaction with `SET session_replication_role = replica`:
     - `all` tables are copied whole;
     - `rows` tables copy ticked plus closure rows;
     - `alembic_version` is copied whole;
     - other tables are left empty.
  4. Set each optional FK whose target row is missing to NULL.
  5. If any required FK still points at a missing row, fail with `missing_parent: {table} {pk} needs {ref_table}`.
  6. If `reset_passwords`, apply the reset list (below). If any listed table or column is absent, fail with `reset_target_missing: {name}`.
  7. Run `pg_dump -Fc` on the subset.
  8. Write a new `objects.tar` holding only the kept files, with content types kept the way `objects.tar` stores them.
  9. Copy the source's `keys.enc`. The manifest is the source's, plus `"recipe"`, `"source_snapshot"`, `"reset_passwords"` and the row and file counts.
  10. Store the bundle through `snapshots.store_bundle`.
  11. Drop both scratch DBs.
- **Reset list** (`seed/reset.py`, the only ServerSherpa-specific code). It's one constant with a comment pointing at ServerSherpa's models:
  - `UPDATE user_accounts SET password_hash = NULL, must_change_password = true, password_updated_at = NULL, totp_secret_enc = NULL, totp_confirmed_at = NULL, totp_last_counter = NULL, failed_login_count = 0, locked_until = NULL`
  - empty these tables: `password_history`, `totp_backup_codes`, `trusted_devices`, `auth_sessions`, `password_reset_tokens`, `biometric_keys`.

- [ ] **Step 1: Write failing tests** on the fixture bundle:
  - the subset has exactly the kept rows;
  - `all` tables are whole;
  - unmentioned tables are empty;
  - an optional orphan is NULL;
  - a forced required orphan fails with its name;
  - reset mode empties the listed tables and NULLs the columns, and leaves them alone when off;
  - a missing reset table fails;
  - `objects.tar` holds only the kept keys;
  - the stored snapshot is `ready`, `origin="recipe"`, and has `recipe_id`, `source_snapshot_id` and `reset_passwords` set;
  - a failure marks it `failed` with the code in `notes`, and the scratch DBs are gone afterwards.

  The fixture schema mirrors the reset-list tables and columns.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then run `tests/test_deploy_snapshots*.py` (unchanged behavior).
- [ ] **Step 5: Commit** with message `feat(sirdar): build a subset snapshot from a recipe`.

### Task 8: A recipe snapshot allows a first super admin

**Files:**
- Modify: `sirdar/api/src/sirdar_api/deploy/environments.py` (`first_admin_with_seed` is raised only when the seed snapshot's `origin != "recipe"`)
- Modify: `sirdar/api/src/sirdar_api/api/routes/deploy.py` (the three places that compute `first_admin=snapshot is None and …` become `(snapshot is None or snapshot.origin == "recipe") and …`)
- Test: `sirdar/api/tests/test_seed_deploy.py`

- [ ] **Step 1: Write failing tests:**
  - creating an environment with a recipe snapshot plus a first admin is accepted;
  - a plain snapshot plus a first admin still answers `first_admin_with_seed`;
  - the first Update of a recipe-seeded environment (SSH, DigitalOcean and LAN routes, with the existing fakes) plans step 11 Create the first admin and restores the snapshot.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. Then run `tests/test_deploy_api.py`, `tests/test_deploy_do_deployments_api.py` and `tests/test_deploy_lan_api.py`.
- [ ] **Step 5: Commit** with message `feat(sirdar): a recipe deploy can add a first super admin`.

### Task 9: Web: Seed Data nav and the DB page

**Files:**
- Modify: `sirdar/web/src/layout/sirdarNav.tsx` (a section `Seed Data` with `DB` → `/seed/db` and `Spaces` → `/seed/spaces`, resource `seed_data`, placed after Deployments), `sirdar/web/src/App.tsx` (routes)
- Create: `sirdar/web/src/pages/seed/SeedDb.tsx`, `sirdar/web/src/pages/seed/RowTable.tsx`, `sirdar/web/src/pages/seed/seedApi.ts`, `sirdar/web/src/pages/seed/selection.ts`
- Test: `sirdar/web/src/pages/seed/selection.test.ts`, `SeedDb.test.tsx`, `RowTable.test.tsx`

**Interfaces:**
- `selection.ts` is pure:
  - `type Selection = { [table: string]: { mode: 'rows' | 'all'; pks: Set<string> } }`, where pk strings are `JSON.stringify` of the pk object with sorted keys;
  - `toggle(sel, table, pk, on)`;
  - `range(sel, table, orderedPks, fromIdx, toIdx, on)`;
  - `setMany(sel, table, pks, on)`;
  - `setAll(sel, table, on: boolean)`, which toggles `mode`.
- **The page**, as in the mockup:
  - a recipe picker (with New recipe), the recipe name, and a snapshot picker (ready snapshots), with `Save recipe`;
  - a tables list showing `ticked / total` per table;
  - for the selected table:
    - `Check all`, `Deselect all` and an `All rows` switch;
    - a column filter (column select plus text), paging and sort;
    - checkboxes per row, with shift-click range on the visible rows;
  - after each change the page calls `resolve` (debounced 300 ms) and shows `Added because they're needed`, with lines like `partners: Partner A, needed by worker_profiles row for Person D`, plus the missing keys if any.
- **Check all / Deselect all:**
  - with a filter, they call `keys` and set those;
  - with no filter, they call `keys` with no filter.
- A table with `pk: null` shows its checkboxes disabled, with a hint that only `All rows` or empty is possible.
- While the snapshot is restoring, the page shows a status line and polls `GET /api/seed/snapshots/{id}` every 2 s.
- Reuse the existing Sirdar UI idioms: `ComboBox`, page sections, buttons, `page-hint`.

- [ ] **Step 1: Write failing tests:**
  - `selection.ts`: toggle; range ticking and unticking; setMany; setAll flipping the mode;
  - `RowTable`: shift-click ticks the range between the last click and this one;
  - `SeedDb` (mocked API): Check all with a filter calls `keys` with that filter; the `Added because they're needed` box renders resolve's reasons; `Save recipe` PUTs the selection shape from Task 5; a `pk: null` table disables its checkboxes.
- [ ] **Step 2: Run** `npx vitest run src/pages/seed`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, then the whole web suite plus `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** with message `feat(sirdar): Seed Data › DB page`.

### Task 10: Web: the Spaces page

**Files:**
- Create: `sirdar/web/src/pages/seed/SeedSpaces.tsx`
- Test: `sirdar/web/src/pages/seed/SeedSpaces.test.tsx`

**Interfaces:**
- **The page:** the same recipe and snapshot pickers as the DB page, and a file table with `File`, size, `Kept because` and a checkbox. It has `Check all`, `Deselect all`, a filter and shift-click (reusing `RowTable` and `selection.ts`).
- **Manual changes:**
  - unticking a referenced file stores `keep: false`;
  - ticking an unreferenced file stores `keep: true`;
  - returning a file to its referenced state removes the override.
- `Save recipe` PUTs the recipe with `files`.

- [ ] **Step 1: Write failing tests:** the because-text renders; unticking a referenced file saves `false`; re-ticking it removes the override; Check all with a filter saves every matching key.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with message `feat(sirdar): Seed Data › Spaces page`.

### Task 11: Web: the Data step's "From a recipe"

**Files:**
- Modify: `sirdar/web/src/pages/deploy/steps/DataStep.tsx`, `sirdar/web/src/pages/deploy/flowState.ts` (`dataMode: 'empty' | 'snapshot' | 'recipe'`; `recipeId`, `recipeSnapshotId`, `resetPasswords`), `sirdar/web/src/pages/deploy/steps/ReviewStep.tsx`, `sirdar/web/src/pages/deploy/DeployFlow.tsx`
- Test: the matching `*.test.tsx` and `flowState.test.ts`

**Interfaces:**
- **The Data step's third choice, `From a recipe`:**
  - a `Recipe` ComboBox;
  - a `Snapshot` ComboBox of ready snapshots, with the same hint as From a snapshot about taking one in Snapshots;
  - a line showing the recipe's ticked records found and missing in that snapshot, from `resolve` (counts only);
  - `Passwords`: `Keep passwords and 2FA` (default) or `Make everyone reset their password`, with the hint "Every copied user gets no usable password and their 2FA is cleared; they set new ones from a reset link.";
  - the same first super admin fields as Start empty.
- **Validation:** a recipe and a snapshot are required. The first super admin is optional when keeping passwords and required when resetting.
- **Review** lists the Recipe, Snapshot, Passwords and First super admin.
- **On Deploy:** the flow POSTs `/api/seed/recipes/{id}/build` and shows `Building the recipe's snapshot…` while polling the snapshot every 2 s. When it's ready, it creates the environment with `snapshot_id` = the built snapshot plus `first_admin`. When it fails, it shows the snapshot's `notes` on the Data step.

- [ ] **Step 1: Write failing tests:**
  - flowState validation for the recipe mode;
  - the Data step renders the three choices and the password options;
  - Review lists the recipe fields;
  - DeployFlow (mocked API) builds, waits for ready, then creates with the built snapshot id and the first admin, and shows a failed build's notes.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS, then the whole web suite plus `tsc`.
- [ ] **Step 5: Commit** with message `feat(sirdar): deploy a new environment from a Seed Data recipe`.

### Task 12: Docs, full suites and live check

**Files:**
- Modify: `sirdar/README.md` (a new "Seed Data" section after "Snapshots": recipes, the scratch Postgres and its volume, required versus optional links, All rows, file following, the reset list, and From a recipe)

- [ ] **Step 1: Write the README section,** matching the spec's wording for each decided behavior.
- [ ] **Step 2: Run the full API suite** (`.venv/bin/pytest -q`, in the background, about 25 min) and the full web suite. Expected: 0 failed.
- [ ] **Step 3: Commit** with message `docs(sirdar): Seed Data in the README`.
- [ ] **Step 4: Live check (controller, after the merge Jimmy asks for):**
  - update Tower;
  - build a recipe from a demo snapshot;
  - deploy it to a throwaway SSH or ESXi environment, once with each password mode;
  - confirm the first admin signs in and copied users can't sign in with their old password in reset mode;
  - delete the environment.
