# Client Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let staff limit a client login to some of that client's groups.
Groups come from the From-To Owner column. Client logins get a new
Individual tier that sees nothing until it's granted groups.

**Architecture:**
- **Group lists and matching.** Each client owns a list of groups and
  aliases. Every roster row stores the group its Owner value matched
  (`initiative_assets.owner_group_id`), recomputed whenever the Owner or
  the group list changes.
- **Access.** AccessInfo learns each client's tier and chip groups. The
  existing `scope_conditions("assets")` becomes group-aware, so every
  current asset call site inherits the rule.
- **Roster rows.** A new `roster_row_condition` filters move rosters.
  Move and dashboard totals come from two new endpoints, so they show the
  true numbers even when the lists are shorter.

**Tech Stack:** FastAPI, SQLAlchemy 2 async, Alembic, Postgres 16, pytest
(real Postgres); React + TypeScript + Vitest portal.

**Spec:** `docs/superpowers/specs/2026-11-10-client-groups-design.md`.
Read it first: the visibility table, the "Answers to the open questions"
section and "Surfaces that must apply the rule" are the requirements.

## Global Constraints

- **Migration.** The migration is `0128_client_groups.py`, with
  `down_revision = "0127"`. Check the head again before merge.
- **Tier names.** The new role is `client_individual`: rank 8, anchor
  `client`, label "Client individual", color `c-blue`, `is_system` true.
  The tier key is `"individual"`, for clients only. Partners stay
  owner/admin/viewer.
- **Normalization.** `group_key(s)` is `re.sub(r"\s+", " ", s.strip()).lower()`.
  Its SQL twin is `lower(regexp_replace(btrim(x), '\s+', ' ', 'g'))`, and
  the two must agree.
- **Blank Owner** means `owner IS NULL OR btrim(owner) = ''`.
- **Error codes:**
  - 409 `alias_in_use`, `group_name_taken`, `client_worker_conflict`
  - 403 `restricted_contact`
  - 422 `group_not_in_client`, `individual_is_staff_only`,
    `tier_not_for_partners`
  - 404 `group_not_found`
- **Copy:**
  - section and chip-field label: "Groups"
  - review empty state: "Nothing to review"
  - dimmed chips note: "Owners and admins see every group."
  - Viewer with no chips: "All groups."
  - Individual with no chips: "No groups — sees no assets."
- **Language and style.** American English in all copy, comments and docs.
  Every modal gets rounded corners and the standard report-generate header
  pattern. Action buttons are never below a scroll. No default browser
  scrollbars. Follow light/dark theme. No new reader-facing widgets beyond
  the ones named here. Row actions use the existing `RowActionsMenu`
  "Actions ▾".
- **Running tests in this worktree.** `api/.venv` is the main checkout's
  editable install, so always run API tests as
  `cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_clientgroups .venv/bin/python -m pytest …`.
  Run everything in the FOREGROUND with a long timeout. Never background a
  suite.
- **Portal tests** run as `cd portal && npx vitest run <files>`. The
  worktree's `portal/node_modules` is a symlink to main's, so never run
  `npm install` here.
- **What must not change.** Owner, Admin, Viewer-without-chips and global
  staff responses are byte-for-byte what they are today. Every surface
  task includes a test proving that.

## Review Focus

1. **A client tier plus a group from a different client** must never widen
   access. Chips are validated against the client (422) and evaluated per
   client. Pinned in Task 4 (`test_chip_from_other_client_rejected`) and
   Task 3 (`test_two_clients_rules_independent`).
2. **Owner values that differ only by case or spacing** ("platform  ",
   "PLATFORM") must match the same group, and a renamed group must keep
   matching its old name. Pinned in Task 2
   (`test_match_ignores_case_and_spacing`, `test_rename_keeps_old_alias`).
3. **A restricted login guessing ids** (asset, roster row, note,
   attachment, provenance) must get 404, exactly like out-of-scope today,
   never 403 and never a payload. Pinned in Task 6
   (`test_hidden_ids_404_everywhere`).
4. **Chips narrowed after a watch was set** must stop asset-watch emails
   for hidden assets. Pinned in Task 7
   (`test_asset_watch_email_rechecked_after_chips_narrow`).
5. **Re-importing a From-To** that changes an asset's Owner must move the
   row to its new group (or to unmatched) right away. Pinned in Task 2
   (`test_reimport_rematches_owner`).

---

### Task 1: Schema, role and normalization

**Files:**
- Create: `api/migrations/versions/0128_client_groups.py`
- Modify: `api/src/serversherpa/db/models.py` (new models next to
  `ContactProfile`, plus `InitiativeAsset.owner_group_id`)
- Modify: `api/src/serversherpa/access/defaults.py:56-64` (a
  `client_individual` grant matching `client_viewer`)
- Create: `api/src/serversherpa/clientgroups/__init__.py`,
  `api/src/serversherpa/clientgroups/keys.py`
- Test: `api/tests/test_client_groups_schema.py`

**Interfaces:**
- Produces models `ClientGroup(id, client_id, name, name_key, created_at,
  created_by)`, `ClientGroupAlias(id, group_id, client_id, alias,
  alias_key, created_at)`, `ClientGroupDismissal(client_id, value_key,
  dismissed_at, dismissed_by)` and `ClientContactGroup(person_id,
  client_id, group_id)`.
- `InitiativeAsset.owner_group_id: Mapped[uuid.UUID | None]`, FK
  `client_groups.id ON DELETE SET NULL`, indexed.
- A view `asset_owner_current(asset_id, client_id, owner, owner_group_id)`:
  `DISTINCT ON (ia.asset_id, i.client_id)` over `initiative_assets ia JOIN
  initiatives i` where `i.client_id IS NOT NULL`, ordered by
  `ia.created_at DESC, ia.id DESC`.
  - Expose it as a SQLAlchemy `Table` named `asset_owner_current` in
    `models.py`. It has no ORM class.
- `keys.py`:
  - `group_key(value: str | None) -> str` (empty for None or blank);
  - `owner_key_sql(col) -> ColumnElement[str]`;
  - `is_blank_sql(col) -> ColumnElement[bool]`.
- Unique constraints:
  - `client_groups (client_id, name_key)`;
  - `client_group_aliases (client_id, alias_key)`;
  - `client_group_dismissals` PK `(client_id, value_key)`;
  - `client_contact_groups` PK `(person_id, client_id, group_id)`, with
    `group_id` FK cascade and `client_id` FK cascade.
- Migration steps:
  - insert the `client_individual` role with `ON CONFLICT DO UPDATE`,
    following 0109's `learning_admin`;
  - drop and recreate `person_roles_client_scope_check` with four names;
  - add `role_permissions` for `client_individual` matching
    `client_viewer` (including `wiki:view`);
  - log the count of people holding a `client_*` tier and `worker`
    together;
  - write a `downgrade()` that reverses all of it.

- [ ] **Step 1: Write failing tests** in `test_client_groups_schema.py`:
  - `test_group_key_rules`:
    - `group_key("  Platform   Team ") == "platform team"`;
    - `group_key(None) == ""` and `group_key("   ") == ""`;
    - against the DB,
      `select(owner_key_sql(literal("  PLAT  form ")))` returns
      `"plat form"`.
  - `test_individual_role_exists`: `Role` row `client_individual` has rank
    8 and anchor `client`, and a `PersonRole(role="client_individual",
    client_id=c.id)` commits.
  - `test_group_name_unique_per_client`:
    - the same `name_key` twice in one client raises IntegrityError;
    - the same `name_key` in two clients commits.
  - `test_asset_owner_current_picks_newest_row`: one asset on two of a
    client's moves with owners "A" (older) then "B"; the view row has
    owner "B".
- [ ] **Step 2: Run them, and expect them to FAIL**
  - `cd api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_clientgroups .venv/bin/python -m pytest tests/test_client_groups_schema.py -v`
  - They fail on an import error or a missing table.
- [ ] **Step 3: Implement** the migration, models, `defaults.py` entry and
  `keys.py`.
- [ ] **Step 4: Run the tests above plus the existing access tests, and
  expect PASS**
  - `tests/test_client_groups_schema.py`
  - `tests/test_access_registry.py`
  - `tests/test_access_scope.py`
  - Then run `alembic upgrade head` on the dev DB
    (`cd api && PYTHONPATH=src .venv/bin/alembic upgrade head`) and
    confirm `alembic current` shows 0128.
- [ ] **Step 5: Commit** with the message `feat(api): client groups schema + client_individual role (0128)`.

### Task 2: Group service and Owner matching

**Files:**
- Create: `api/src/serversherpa/clientgroups/service.py`
- Modify: `api/src/serversherpa/imports/move_assets.py`: after the rows of
  one run are applied, call `rematch_rows` for the touched roster row ids.
- Modify: `api/src/serversherpa/api/routes/initiatives.py:1207-1255`: the
  roster PATCH re-matches its row, and an initiative update that changes
  `client_id` re-matches every row on that move.
- Create: `api/tests/client_groups_fixtures.py` (shared by later tasks)
- Test: `api/tests/test_client_groups_service.py`

**Interfaces:**
- Consumes the Task 1 models and `group_key` / `owner_key_sql`.
- Produces, in `service.py` (every function takes `db: AsyncSession` first,
  never commits, and lets the caller commit):
  - `create_group(db, client_id, name, actor_id) -> ClientGroup`. It
    raises `GroupError("group_name_taken", 409)` or
    `GroupError("alias_in_use", 409)` when the key is any group name or
    alias in that client.
  - `rename_group(db, group, new_name, actor_id) -> ClientGroup`. The old
    name is added as an alias.
  - `set_aliases(db, group, aliases: list[str]) -> list[str]`
  - `merge_groups(db, target, source, *, dry_run: bool) -> MergePlan`,
    where `MergePlan` is a dataclass with `aliases_added: list[str]`,
    `rows_moved: int`, `people_moved: int` and `conflicts: list[str]`.
    The source's name and aliases become the target's aliases, rows and
    chips are re-pointed, and the source is deleted.
  - `delete_group(db, group) -> None`. Rows go to unmatched; chips go
    through the FK cascade.
  - `review_values(db, client_id, *, include_dismissed: bool) ->
    list[ReviewValue]`, where `ReviewValue` has `value` (the most common
    spelling), `value_key`, `asset_count`, `move_ids`, `move_names` and
    `dismissed: bool`. It covers non-blank, unmatched owners on the
    client's moves.
  - `match_value(db, client_id, value, group_id) -> ClientGroup`. It adds
    the alias and re-matches.
  - `set_dismissed(db, client_id, value, dismissed: bool, actor_id) ->
    None`
  - `rematch_client(db, client_id, keys: set[str] | None = None) -> int`.
    One `UPDATE … FROM` over the client's moves; it returns the number of
    rows changed.
  - `rematch_rows(db, row_ids: list[uuid.UUID]) -> int`
  - `class GroupError(Exception)` with `code: str` and `status: int`.
- Fixture module `client_groups_fixtures.py`:
  - `async def seed_grouped_client(db) -> SimpleNamespace` with `client`;
    `groups` = {"Platform", "Storage"}; one `move`; `assets` = 4 assets
    with `client_id` set and roster owners "Platform", "storage ",
    blank and "Platfrom" (unmatched); plus `other_client` with a move,
    one asset and owner "Platform".
  - `async def client_user(db, api, client_id, tier: str, group_ids=(),
    email=…) -> dict`. It returns auth headers, built the same way as
    `tests/test_initiatives_client_scope.client_login`, and inserts
    `ClientContactGroup` rows.

- [ ] **Step 1: Write failing tests**:
  - `test_match_ignores_case_and_spacing`: after `rematch_client`, the
    "storage " row has the Storage group id.
  - `test_rename_keeps_old_alias`: renaming Platform to "Platform Eng"
    keeps the "Platform" rows matched, and `"platform"` is in the alias
    list.
  - `test_name_and_alias_collide`: creating "Storage" again raises 409
    `group_name_taken`, and an alias "storage" on Platform raises 409
    `alias_in_use`.
  - `test_review_lists_unmatched_not_blank`: `review_values` returns
    exactly one value, "Platfrom" with `asset_count == 1`, and no blank.
  - `test_match_value_adds_alias_and_rematches`: after
    `match_value(…, "Platfrom", platform.id)` the row is matched and
    `review_values` is empty.
  - `test_dismiss_hides_from_review`: dismissed values are left out by
    default and come back with `include_dismissed=True` and
    `dismissed=True`.
  - `test_merge_dry_run_then_apply`: the dry run reports
    `rows_moved == 1`, and the DB is unchanged. The real run leaves the
    source gone and the target holding its rows, aliases and chips.
  - `test_delete_unmatches_rows_and_chips`
  - `test_groups_never_cross_clients`: `other_client`'s "Platform" row
    stays unmatched while it has no groups.
  - `test_reimport_rematches_owner`: running the From-To importer again on
    the move with that asset's Owner changed to "Storage" leaves the row
    with the Storage group. Use the existing import test helpers in
    `tests/test_move_asset_import*.py`.
  - `test_roster_patch_rematches`
- [ ] **Step 2: Run them, and expect them to FAIL**
  - `… pytest tests/test_client_groups_service.py -v`
- [ ] **Step 3: Implement** `service.py` and the three hooks.
- [ ] **Step 4: Run them, and expect PASS.** Run the existing
  `tests/test_move_asset_import*.py` and `tests/test_initiatives*.py`
  too; nothing there should change.
- [ ] **Step 5: Commit** with the message `feat(api): client group service and Owner matching`.

### Task 3: AccessInfo tiers and chips, and group-aware scope

**Files:**
- Modify: `api/src/serversherpa/access/resolver.py` (AccessInfo,
  `_assemble`, `resolve_access`, `resolve_access_many`)
- Modify: `api/src/serversherpa/access/scope.py`
- Modify: `api/src/serversherpa/api/schemas.py:227-231` (`ScopeOut`) and
  `api/src/serversherpa/api/routes/auth.py:117-120` (`_scope_out`)
- Test: `api/tests/test_client_groups_access.py`

**Interfaces:**
- AccessInfo gains these fields:
  - `client_tiers: dict[uuid.UUID, str]`, the tier key ("owner",
    "admin", "viewer" or "individual"). Fill it in `_assemble` from the
    grants rows whose role starts with `client_`. If a client somehow has
    two rows, keep the highest rank.
  - `client_group_ids: dict[uuid.UUID, frozenset[uuid.UUID]]`, loaded
    with one extra query in each resolver from `ClientContactGroup`.
    Update the docstring of `resolve_access_many` to say at most six
    queries.
- AccessInfo gains this method:
  - `def restricted_clients(self) -> dict[uuid.UUID,
    tuple[Literal["viewer", "individual"], frozenset[uuid.UUID]]]`.
    It is empty for global actors. Otherwise it holds every client where
    the tier is "individual", or "viewer" with a non-empty group set.
- `scope.py` changes:
  - `scope_conditions("assets", …)`: for each restricted client C, the
    condition becomes
    `Asset.client_id == C AND <asset rule over asset_owner_current>`.
    Unrestricted clients keep `Asset.client_id IN (…)`. The asset rule:
    - viewer: `NOT EXISTS (v where v.asset_id = Asset.id and v.client_id
      = C and not is_blank(v.owner) and (v.owner_group_id is null or
      v.owner_group_id not in G))`;
    - individual: `EXISTS (v where v.asset_id = Asset.id and v.client_id
      = C and v.owner_group_id in G)`, and the condition is false when G
      is empty.
  - `def roster_row_condition(access: AccessInfo) -> ColumnElement |
    None`. It returns None when nothing is restricted. Otherwise it ANDs,
    for each restricted client C:
    `or_(InitiativeAsset.initiative_id.not_in(<C's move ids>),
    <allowed>)`, where `<allowed>` is
    `or_(is_blank_sql(owner), owner_group_id.in_(G))` for a viewer and
    `owner_group_id.in_(G)` for an individual.
  - `def is_restricted_at(access: AccessInfo, client_id: uuid.UUID |
    None) -> bool`
- `ScopeOut` gains `restricted_client_ids: list[uuid.UUID] = []`.

- [ ] **Step 1: Write failing tests** using `seed_grouped_client`. Assert
  on `select(Asset.id).where(scope_conditions("assets", info, pid))`
  directly:
  - `test_owner_admin_unchipped_viewer_see_all_four`
  - `test_viewer_with_platform_sees_platform_and_blank`: the asset ids
    are exactly Platform and blank, never Storage or "Platfrom".
  - `test_individual_without_chips_sees_none`
  - `test_individual_with_storage_sees_only_storage`
  - `test_owner_chips_ignored`: an owner with chips sees all four.
  - `test_two_clients_rules_independent`: a person who is viewer+chips at
    C and owner at D sees all of D's assets and only the allowed ones of
    C.
  - `test_roster_row_condition_matches_asset_rule`: the same expectations
    on the move's `InitiativeAsset` rows.
  - `test_global_unrestricted`: `scope_conditions` returns None and
    `roster_row_condition` returns None.
  - `test_me_scope_lists_restricted_clients`: `GET /auth/me` for a
    chipped viewer returns `scope.restricted_client_ids == [str(c.id)]`,
    and for an owner returns `[]`.
- [ ] **Step 2: Run them, and expect them to FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them plus the existing access tests, and expect PASS**
  - `tests/test_client_groups_access.py`
  - `tests/test_access_scope.py`
  - `tests/test_access_registry.py`
  - `tests/test_initiatives_client_scope.py`
  - `tests/test_clients_activity_api.py`
  - `tests/test_auth*.py`
- [ ] **Step 5: Check the iOS decoder.** Confirm the iOS `ScopeOut`
  equivalent (`IOS_Kiosk_App`, grep `client_ids`) decodes with an unknown
  key present. If it uses a strict decoder, add the field as optional
  there and note it in the commit.
- [ ] **Step 6: Commit** with the message `feat(api): per-client tiers and group chips in access scope`.

### Task 4: Contacts (Individual tier, chips, client-login guards)

**Files:**
- Modify: `api/src/serversherpa/api/routes/stakeholders.py:90-135,
  480-660` (a per-kind `tier_roles`, `group_ids` on PATCH, guards, the
  contact list)
- Modify: `api/src/serversherpa/api/schemas.py:929, 936, 946, 977` (add
  "individual" to the Literals, plus `group_ids: list[uuid.UUID] | None`
  on `ContactUpdateIn` and `group_ids: list[uuid.UUID]` on the contact
  row out)
- Test: `api/tests/test_client_groups_contacts.py`

**Interfaces:**
- Consumes `ClientContactGroup` and `GroupError` codes.
- Produces:
  - `PATCH /clients/{id}/contacts/{person}` with
    `{"group_ids": [...]}`. It is global-only (otherwise 403
    `forbidden`). It replaces the set, validates each group against the
    client (422 `group_not_in_client`) and audits `contact.groups`.
  - The contact list rows include `group_ids`.
  - Partners: tier "individual" gets 422 `tier_not_for_partners`.

- [ ] **Step 1: Write failing tests**:
  - `test_staff_add_individual_and_set_chips`
  - `test_chip_from_other_client_rejected`: 422 `group_not_in_client`.
  - `test_client_admin_cannot_set_chips`: 403.
  - `test_client_admin_cannot_add_individual`: 422
    `individual_is_staff_only`.
  - `test_client_admin_cannot_retier_or_remove_restricted`: on an
    Individual, and on a Viewer with chips, a PATCH with a tier gets 403
    `restricted_contact` and a DELETE gets 403 `restricted_contact`. On a
    Viewer without chips, both still work as today.
  - `test_staff_remove_deletes_chips`
  - `test_partner_individual_rejected`
  - `test_contact_list_returns_group_ids`
- [ ] **Step 2: Run them, and expect them to FAIL.**
- [ ] **Step 3: Implement.** Global-only means `actor.access.is_global`.
- [ ] **Step 4: Run them plus `tests/test_stakeholders.py`, and expect
  PASS.**
- [ ] **Step 5: Commit** with the message `feat(api): Individual tier, group chips and restricted-contact guards`.

### Task 5: Groups API

**Files:**
- Create: `api/src/serversherpa/api/routes/client_groups.py`. Include it
  in the app next to the stakeholders routers, under prefix `/clients`.
- Modify: `api/src/serversherpa/api/schemas.py` (`ClientGroupOut`,
  `ClientGroupIn`, `ClientGroupPatchIn`, `ReviewValueOut`, `MergeIn`,
  `MergePlanOut`, `ReviewMatchIn`, `ReviewDismissIn`)
- Test: `api/tests/test_client_groups_api.py`

**Interfaces:**
- Every route needs `require_permission("clients","change")` plus
  `is_global` (otherwise 403 `forbidden`), and the client must exist (404
  `org_not_found`).
- `ClientGroupOut` is
  `{id, name, aliases: list[str], asset_count: int, people_count: int}`.
  `asset_count` counts roster rows matched to the group on the client's
  moves.
- The routes are exactly the list in the spec (the "Endpoints" bullet
  under "Portal: client page Groups section"). They map `GroupError` to
  `{"detail": {"code": …}}` with its status, and audit
  `entity_type="client"` with actions `group.create`, `group.update`,
  `group.merge`, `group.delete`, `group.review.match` and
  `group.review.dismiss`.

- [ ] **Step 1: Write failing tests**:
  - `test_crud_roundtrip`
  - `test_client_owner_gets_403`
  - `test_review_list_and_match`
  - `test_merge_dry_run_shape`
  - `test_counts`: Platform has `asset_count == 1` and `people_count`
    equal to the chips seeded.
- [ ] **Step 2: Run them, and expect them to FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, and expect PASS.**
- [ ] **Step 5: Commit** with the message `feat(api): client groups endpoints`.

### Task 6: Apply the rule to rosters, assets, totals, provenance, notes and files

**Files:**
- Modify: `api/src/serversherpa/api/routes/initiatives.py:1013-1096`
  (apply `roster_row_condition`), and add a
  `GET /initiatives/{id}/asset-totals` route
- Modify: `api/src/serversherpa/api/routes/assets.py:308-347` (filter the
  moves list by `roster_row_condition`)
- Modify: `api/src/serversherpa/api/routes/stakeholders.py:684-735`:
  activity uses `scope_conditions("assets")` instead of the direct
  `Asset.client_id` filter, and add a `GET /clients/{id}/asset-totals`
  route
- Modify: `api/src/serversherpa/api/routes/status_provenance.py:59-65,
  123-127, 156-163`: an `initiative_asset` probe uses
  `roster_row_condition` too, and the scan lookup is limited to that
  row's initiative
- Modify: `api/src/serversherpa/access/hosts.py`: in
  `authorize_host_view`, for `asset`, `initiative` and `client` hosts,
  return 404 `entity_not_found` when `is_restricted_at(access,
  <host client id>)`
  - The host's client id is `Asset.client_id`, `Initiative.client_id`, or
    the client's own id.
  - Check that `notes.py` and `attachments.py` list, read and download
    routes all go through `authorize_host_view`. Any that don't must be
    routed through it.
- Modify: `portal/src/App.tsx:111-112`: make `/dashboards/move`
  `globalOnly`. On the API side, any endpoint only MoveDashboard uses that
  returns asset rows needs an `is_global` check (find them from
  `portal/src/pages/MoveDashboard.tsx`).
- Test: `api/tests/test_client_groups_surfaces.py`

**Interfaces:**
- `GET /initiatives/{id}/asset-totals` takes `initiatives:view` plus the
  initiative scope. It returns
  `{"total": int, "by_status": {status: int}}` over every roster row,
  unfiltered by groups.
- `GET /clients/{id}/asset-totals` takes `clients:view` plus the org
  scope. It returns `{"total": int, "by_status": {status: int}}` over
  `assets` with that `client_id` and `archived_at IS NULL`, unfiltered.
  The portal's "In transit" is `by_status["in_transit"]`.

- [ ] **Step 1: Write failing tests.** For each of these, run a chipped
  viewer (Platform), an individual (Storage), an unchipped viewer and an
  owner:
  - `GET /initiatives/{id}/assets`
  - `GET /assets`
  - `GET /assets/{id}`
  - `GET /assets/{id}/moves`
  - `GET /clients/{id}/activity` (seed `ProcessedScan` rows for all four
    assets)
  - `GET /search?q=<serial>`
  - `GET /status/provenance`

  The tests:
  - `test_roster_filtered_per_tier`
  - `test_totals_are_true_for_restricted`: `total == 4` and the by_status
    counts sum to 4 for the individual too.
  - `test_unrestricted_responses_unchanged`: compare the owner and
    unchipped-viewer JSON to a run with the feature tables empty.
  - `test_hidden_ids_404_everywhere`: for the individual, the hidden
    asset's id gets 404 from `/assets/{id}`, `/assets/{id}/moves`,
    `/notes?entity_type=asset&entity_id=…`,
    `/attachments?entity_type=asset…` and `/status/provenance`.
  - `test_search_cannot_confirm_hidden_serial`
  - `test_activity_lists_only_visible_scans`
  - `test_restricted_sees_no_move_or_client_notes_files`: the lists come
    back 404 for a chipped viewer and an individual on the move and on
    the client, and work for owner and unchipped viewer.
  - `test_move_dashboard_global_only` (only if API endpoints were
    changed).
- [ ] **Step 2: Run them, and expect them to FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, and expect PASS.** Then run every test file that
  touches these routes: `tests/test_initiatives*.py`,
  `tests/test_assets*.py`, `tests/test_clients_activity_api.py`,
  `tests/test_search*.py`, `tests/test_status_provenance*.py`,
  `tests/test_notes*.py`, `tests/test_attachments*.py`.
- [ ] **Step 5: Commit** with the message `feat(api): group rule on rosters, assets, activity, search, provenance, notes and files`.

### Task 7: Notifications, asset watches and the client-worker conflict

**Files:**
- Modify: `api/src/serversherpa/notifications/access.py`: the asset page
  already probes through `scope_conditions("assets")`, so verify that,
  and add a test. Watches set on an initiative must use
  `roster_row_condition` for their per-row filtering.
- Modify: `api/src/serversherpa/notifications/event_sweep.py:516-550`:
  `watch_recheck` re-checks `asset_watch` notices through
  `visible_among("asset", …)` instead of returning None.
- Create: `api/src/serversherpa/access/role_mix.py` with
  `async def assert_no_client_worker_mix(db, person_id: uuid.UUID,
  adding_role: str) -> None`. It raises `RoleMixError` (code
  `client_worker_conflict`) when adding `worker` to someone with an active
  `client_*` row, or a `client_*` row to someone with an active `worker`.
- Modify every grant site:
  - `access/apply.py:67`
  - `api/routes/users.py:413, 779`
  - `api/routes/stakeholders.py:531, 593` (contact add and tier change)
  - `people/bulk_import.py:534, 572` (the row fails with reason
    `client_worker_conflict`)
  - `people/assign_bulk.py:686, 736` (same)
  - `api/routes/kiosk_rolodex.py:538`
  - `services/move_password.py:87`
  - `people/v2_import.py:241` (skip and log)

  API routes map the error to 409 `client_worker_conflict`.
- Test: `api/tests/test_client_groups_notifications.py`,
  `api/tests/test_client_worker_conflict.py`

- [ ] **Step 1: Write failing tests**:
  - `test_status_rule_notice_skips_hidden_asset`
  - `test_cannot_watch_hidden_asset`
  - `test_asset_watch_email_rechecked_after_chips_narrow`: set a watch as
    an unchipped viewer, give them a Storage-only chip, fire the watch on
    the Platform asset, and check that no email is sent.
  - `test_add_worker_to_client_contact_409`
  - `test_add_client_contact_to_worker_409`
  - `test_bulk_workers_row_fails_on_client_person`
  - `test_existing_mix_not_revoked`
- [ ] **Step 2: Run them, and expect them to FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them plus every `tests/test_notification*.py`,
  `tests/test_asset_watch*.py`, `tests/test_bulk_workers*.py`,
  `tests/test_assign*.py`, `tests/test_users*.py` and
  `tests/test_kiosk_rolodex*.py`, and expect PASS.**
- [ ] **Step 5: Commit** with the message `feat(api): group-aware notices + refuse client tier with worker role`.

### Task 8: Portal Groups section on the client page

**Files:**
- Modify: `portal/src/lib/api.ts`: types `ClientGroup`, `ReviewValue`,
  `MergePlan`, plus `listClientGroups`, `createClientGroup`,
  `updateClientGroup`, `deleteClientGroup`, `mergeClientGroups`,
  `listGroupReview`, `matchGroupReview` and `dismissGroupReview`
- Create: `portal/src/components/clients/ClientGroupsPanel.tsx`. It owns
  the All | Review switch and the review payload, the same way
  `AssetModels.tsx:187-266` does.
- Create: `portal/src/components/clients/GroupReviewPanel.tsx`, a copy of
  the `ModelReviewPanel` layout and CSS classes (`rv-*`).
- Create: `portal/src/components/clients/GroupEditModal.tsx` (name, plus
  aliases through `TagInput` free-text mode), `GroupMergeModal.tsx` (a
  ComboBox target, then the dry-run summary, then Merge) and
  `GroupMatchModal.tsx` (a ComboBox of groups, plus a "Create group"
  path).
- Modify: `portal/src/pages/StakeholderDetail.tsx`: render
  `ClientGroupsPanel` between People (ends :773) and Notes (:854) when
  `kind==='client' && scope.global`.
- Test: `portal/src/components/clients/ClientGroupsPanel.test.tsx`,
  `GroupReviewPanel.test.tsx`

**Interfaces:** it uses the Task 5 endpoints and their JSON exactly.

- [ ] **Step 1: Write failing tests**:
  - The panel renders groups with alias chips and counts.
  - The Review badge shows the undismissed count.
  - Match calls `matchGroupReview` with `{value, group_id}`, and the row
    leaves the list.
  - Dismiss and Restore toggle.
  - Merge shows the dry-run numbers before confirming.
  - The panel is not rendered for a non-global scope.
- [ ] **Step 2: Run them, and expect them to FAIL**
  - `cd portal && npx vitest run src/components/clients`
- [ ] **Step 3: Implement,** using the existing idioms: `.init-panel`,
  `eyebrow-sm`, `segmented`, DataTable, RowActionsMenu, `mini-btn`.
- [ ] **Step 4: Run them, and expect PASS.** Also run
  `npx tsc -p tsconfig.json --noEmit` and the list-typography guardrail
  test (`npx vitest run src/lib/listTypography*`).
- [ ] **Step 5: Commit** with the message `feat(portal): Groups section with review list on client page`.

### Task 9: Portal tier and chips on a person

**Files:**
- Modify: `portal/src/lib/api.ts:1130` (`ContactTier` adds
  `'individual'`), `patchContactLink` (`group_ids`), and the contact row
  type (`group_ids`)
- Modify: `portal/src/components/TierSelect.tsx`: a `kind` prop. The
  "Individual" option appears only for `kind==='client'` and only when
  `scope.global`.
- Modify: `portal/src/pages/External.tsx:711-775`: the client link's second
  line gets a "Groups" `TagInput` in options mode (staff only), with the
  empty-state and dimmed copy from Global Constraints. Client logins see
  the tier select disabled, and Remove hidden, for restricted contacts.
- Modify: read-only chips in `portal/src/pages/OrgDirectory.tsx:993-1002`,
  the People section of `StakeholderDetail.tsx`, and
  `components/users/UserProfileTab.tsx:177-190`
- Modify: `portal/src/lib/external.ts:77` and `External.tsx:336, 570` (a
  label for "individual")
- Test: `portal/src/components/TierSelect.test.tsx`,
  `portal/src/pages/External.groups.test.tsx`

- [ ] **Step 1: Write failing tests**:
  - Individual is offered for client links to staff only, never for
    partners.
  - The chips save as `group_ids`.
  - An owner link shows dimmed chips with the note.
  - An Individual with no chips shows "No groups — sees no assets."
  - A client-login actor sees the tier disabled on a restricted contact.
- [ ] **Step 2: Run them, and expect them to FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, and expect PASS,** together with the existing
  `External`, `OrgDirectory`, `StakeholderDetail` and `UserProfileTab`
  tests and `tsc`.
- [ ] **Step 5: Commit** with the message `feat(portal): Individual tier and group chips on client contacts`.

### Task 10: Portal true totals for restricted logins

**Files:**
- Modify: `portal/src/lib/access.ts:8` (`ScopeInfo.restricted_client_ids`)
- Modify: `portal/src/lib/api.ts` (`getInitiativeAssetTotals` and
  `getClientAssetTotals`)
- Modify: `portal/src/pages/InitiativeDetail.tsx:366, 786, 824-827, 869,
  905` and `portal/src/lib/initiatives.ts` (`moveAssetProgress`). When the
  move's client is in `restricted_client_ids`, these use the totals
  endpoint for the tab badge, the eyebrow count, the donut, the progress
  bar and "N of M shown" (N = visible rows, M = true total).
- Modify: `portal/src/pages/ClientDashboard.tsx:116-189, 301-387`. When the
  selected client is restricted, "Total assets", "In transit", "Asset
  fleet by status" and the move progress bars come from the totals
  endpoints.
- Test: `portal/src/pages/InitiativeDetail.totals.test.tsx`,
  `portal/src/pages/ClientDashboard.totals.test.tsx`

- [ ] **Step 1: Write failing tests:** with a restricted scope, 1 visible
  row and totals `{total: 4}`, the badge and eyebrow show 4, the text
  says "1 of 4 shown", and the donut total is 4. With an unrestricted
  scope, the totals endpoint is never called.
- [ ] **Step 2: Run them, and expect them to FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, and expect PASS,** together with the existing
  `InitiativeDetail` and `ClientDashboard` tests and `tsc`.
- [ ] **Step 5: Commit** with the message `feat(portal): true move and dashboard totals for restricted client logins`.

### Task 11: Full suites and live check

- [ ] **Step 1: Run the full API suite.** Run it in the foreground (about
  2 h 15 min) with `cd api && PYTHONPATH=src
  SS_TEST_DB=serversherpa_test_clientgroups .venv/bin/python -m pytest -q
  -p no:cacheprovider 2>&1 | tail -40`. Judge it by the summary line.
  The known pre-existing failure `test_assets_model.py::test_seeds_present`
  may appear; anything else must be fixed.
- [ ] **Step 2: Run the full portal suite** (`cd portal && npx vitest
  run`) and `npx tsc --noEmit`.
- [ ] **Step 3: Live check on dev** (in the controller session, not a
  subagent):
  - Create groups on Acme Widget from its review list.
  - Make a chipped Viewer and an Individual.
  - Sign in as each and check the move roster, the counts, the dashboard
    and search.
  - Take screenshots.
