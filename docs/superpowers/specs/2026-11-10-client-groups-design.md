# Client groups: limit what a client employee sees

Date: 2026-11-10
Status: draft, waiting for Jimmy's review

## Why

Clients need logins to their dashboard and data. Under the old system, a
few people shared logins or passed information along for others, and that
caused more trouble than it solved. Every client employee should have their
own login. But not every employee should see every business unit's assets
and where those assets are.

The From-To file a client sends already names each asset's group in its
**Owner** column. This feature turns those Owner values into groups that
belong to the client, and lets staff limit a client login to some of them.

## Goals

- Each client has its own list of groups. Names, aliases and membership
  never cross between clients.
- Each client login keeps one tier chip for that client, and there is a new
  fourth tier:
  - **Owner** and **Admin** see everything for the client. Group chips are
    ignored for them.
  - **Viewer** sees everything, unless they have group chips. Then they see
    their groups' assets plus assets whose Owner is blank.
  - **Individual** (new) sees no assets until a group chip grants them.
    They never see blank-Owner assets. If they need those, they should be
    a Viewer instead.
- An asset's group comes from the From-To **Owner** column that is already
  imported and saved today.
- Owner values that don't match a group go to a review list on the client
  page. Staff match each value to a group or create a new one, the way the
  Makes / Models review works.
- In a move, a limited user sees only the asset rows they're allowed to
  see. Counts and totals still show what's really there.
- A hidden asset's serial, name, RFID, rack/RU, location, scans, notes and
  photos never reach a limited user anywhere: no page, no search, no
  notification, no email, no file, no kiosk call.

## Non-goals

- Changing the From-To import itself, for example a client column or an
  Owner mapping step during import. That comes later.
- Opening trucks, containers, warehouse, scans or reports to client logins.
  They are global-only today (see "Trucks and containers" below).
- Giving an asset a group by hand outside the From-To. The rules below
  treat an asset that is on no move as blank-Owner.
- Letting client logins create or edit groups, or assign group chips.
- Removing notifications a person already received before their chips
  were narrowed.

## Anti-goals (a failure even if it works)

- Any hidden asset's serial or location showing up anywhere a limited user
  can reach. One leak defeats the purpose.
- An Owner, Admin, or a Viewer with no chips seeing anything different
  from today.
- Groups typed onto a person as free text. Chips are only picked from the
  client's own list.
- An import failing or blocking because of an Owner value.

## Decisions made with Jimmy

1. **Tiers.** Owner, Admin and Viewer stay as they are. A fourth tier,
   Individual, is added below Viewer.
2. **What groups do per tier.**
   - Owner and Admin: always everything.
   - Viewer: everything until chips narrow it. With chips, it sees its
     groups plus blank-Owner assets.
   - Individual: nothing until chips grant it. It sees only its chip
     groups and never blank-Owner assets.
3. **Groups belong to one client.** Each client has its own groups and
   names.
4. **Where groups are managed.** On the client's full-details page
   (Stakeholders › Clients › a client), where staff can view, add, edit and
   remove the client's groups.
5. **Source of an asset's group.** The From-To Owner column, connected as
   part of this work. The import itself isn't changed.
6. **Unmatched values.** Blank and unmatched Owner values never block
   anything. Distinct unmatched values (each value once, not every asset)
   show in a review list with a dropdown: match to an existing group, or
   create a new one. Not every value has to be resolved.
7. **Blank Owner.** Blank-Owner assets behave as they do today: Owner,
   Admin and Viewer (even a Viewer with chips) see them, Individual does
   not.
8. **Unmatched Owner (filled in, but not matched yet).** These are hidden
   from a Viewer with chips and from an Individual until someone matches
   them. Jimmy: a restricted Viewer sees "theirs and empty."
9. **Moves, trucks and containers.** A limited user sees the move's (or
   truck's, or container's) own details. Asset lists leave out the assets
   they can't see. Counts reflect what is actually there.

## How it works

### Data

New tables, numbered from migration 0128; check the number again at merge
time:

- **`client_groups`**: `id`, `client_id` (FK clients, cascade), `name`
  (CITEXT), `created_at`, `created_by`. Unique `(client_id, name_key)`,
  where `name_key` is the normalized name (see Matching).
- **`client_group_aliases`**: `id`, `group_id` (FK, cascade), `client_id`,
  `alias` (CITEXT), `alias_key`. Unique `(client_id, alias_key)`. A key
  can't be both one group's name and another group's alias in the same
  client; enforce this in the service, with a 409 `alias_in_use`, as in
  `PUT /asset-models/{id}/aliases`.
- **`client_group_dismissals`**: `client_id`, `value_key`, `dismissed_at`,
  `dismissed_by`. A dismissed review value stays unassigned and leaves the
  review list until it is restored.
- **`client_contact_groups`**: `person_id`, `client_id`, `group_id`.
  Primary key is all three. It is keyed on the person and client, not on
  the `person_roles` row, because a tier change revokes that row and
  inserts a new one (stakeholders.py:589-598). This follows the
  `ContactProfile` precedent (models.py:259). Removing a contact
  (stakeholders.py:660) deletes the person's rows for that client.
- **`initiative_assets.owner_group_id`** (new nullable FK client_groups,
  `ON DELETE SET NULL`, indexed): the stored result of matching this row's
  Owner against the move's client's groups. Each roster row is in one of
  three states:
  - **blank**: `owner` is null or empty
  - **matched**: `owner_group_id` is set
  - **unmatched**: `owner` is set but `owner_group_id` is null

New tier role `client_individual`: anchor `client`, system role, rank 8
(between `external` 5 and `client_viewer` 10), label "Client individual",
color c-blue. It gets the same default grants as `client_viewer`
(dashboard, clients, assets and initiatives view, plus wiki view to match
the 0074 rule). The migration recreates `person_roles_client_scope_check`
(0009:101-104) to allow the new name.

### Matching

- **Normalization** for names, aliases and Owner values: trim, collapse
  runs of whitespace to one space, and compare case-insensitively. For
  example, "platform  team " matches "Platform Team".
- **What a row matches against.** A roster row matches only the groups of
  its **move's** client (`initiatives.client_id`). A move with no client
  never matches anything.
- **When `owner_group_id` is recomputed**, in the same transaction as the
  change:
  - after a From-To import or new-move wizard import finishes writing
    rows (move_assets.py `_apply_row`), for the rows it touched;
  - on a roster row edit (`PATCH /initiatives/assets/{id}`);
  - when a group is created, renamed, merged or deleted, or an alias is
    added or removed: every row of that client whose Owner key matches an
    affected key;
  - when a move's client changes: every row on that move.
- **Existing data.** No groups exist when this ships, so every row with an
  Owner starts as unmatched. Nothing needs backfilling. Rows connect as
  soon as staff create or match groups.

### Which group an asset has outside a move

Pages that show an asset on its own, rather than as a row on a move, need
one group per asset. Those pages are /assets, asset detail, search, the
client dashboard's activity feed, asset notes and files, and asset
watches.

- **The asset's group for client C** comes from its roster row on C's
  move with the newest `initiative_assets.created_at`, ties broken by
  `id`. That row's state (blank, matched or unmatched) is the asset's
  state.
- **An asset on none of C's moves** counts as blank.
- **Inside a move**, that move's own row decides, even if the asset is on
  a newer move with a different Owner.

The dev data has no asset with two different Owners, so this rule is
mostly a tie-breaker.

### The visibility rule

For an actor and a client C, take the actor's tier at C and their chip
groups G at C:

| Tier at C | Chips | Can see a roster row / asset of C when… |
|---|---|---|
| owner, admin | any (ignored) | always (today's rule) |
| viewer | none | always (today's rule) |
| viewer | G | state is blank, or the group is in G |
| individual | none | never |
| individual | G | the group is in G |

- **Group must belong to C.** Chips can only reference C's groups. The
  service rejects any other group with a 422.
- **Global staff** are never restricted.
- **Each client is decided on its own.** Someone with access to two
  clients gets each client's rule separately, never a union.
- **AccessInfo** (access/resolver.py:48) gains:
  - a per-client tier map: `client_tier: dict[client_id, role_name]`;
  - a per-client chip map: `client_groups: dict[client_id,
    frozenset[group_id]]`.

  Both `resolve_access` and `resolve_access_many` load them, one extra
  query each.
- **Shared helpers.** A new helper in `access/scope.py` produces the SQL
  for the rule:
  - one condition for `initiative_assets` rows;
  - one condition for `assets`, using the "newest row" rule above, through
    a lateral subquery or a SQL view.

  Every surface below uses these two helpers. None should rebuild the rule
  inline.
- **What "restricted" means.** A viewer at C with at least one chip, or any
  individual at C. Unrestricted clients take today's code path unchanged.

### Surfaces that must apply the rule

These come from a read-only sweep of the code on 2026-11-10. Every
endpoint below can be reached by a client login today and returns or
reveals asset data. Each one needs the rule, plus a test with a restricted
Viewer and an Individual that proves a hidden asset's serial does not
appear.

1. `GET /assets` and `GET /assets/{id}` (assets.py:285-305) apply the
   asset rule. A hidden asset returns 404, the same as out of scope.
2. `GET /assets/{id}/moves` (assets.py:308-347) lists only rows the actor
   can see.
3. `GET /initiatives/{id}/assets` (initiatives.py:1089-1096; rows at
   :1013-1086):
   - It returns only visible rows.
   - It adds true totals for the move: `total` and `by_status` counts
     over every row.
   - Today the roster needs only `initiatives:view` and never checks
     `assets:view`. The row rule must not rely on the assets grant.
4. `GET /clients/{id}/activity` (stakeholders.py:684-735) filters
   `Asset.client_id` directly and skips `scope_conditions`. It must apply
   the asset rule.
5. `GET /search` (search.py:97-115): asset hits use the asset rule. A
   restricted actor must not be able to confirm a hidden serial exists.
6. `GET /status/provenance`:
   - for `entity_type=initiative_asset`, it probes the row rule instead of
     only the move (status_provenance.py:123-127);
   - for `asset`, it uses the asset rule;
   - the scan lookup for a row is limited to that row's move
     (status_provenance.py:156-163).
7. Notes and attachments on an asset (access/hosts.py:55-75) use the asset
   rule, so a hidden asset's notes and photos are not readable by id.
8. Asset watches (me.py:494-546) and the notification checks that fire
   them go through `visible_among` (notifications/access.py:194-239). Its
   asset entry must use the asset rule. That covers:
   - setting a watch, firing it and the email re-check;
   - status-rule notice filtering (event_sweep.py:149-153).

   The `asset_watch` summary email is never re-checked today
   (event_sweep.py:535-537). Add a re-check, so a watch made before chips
   narrowed doesn't keep sending a hidden asset's serial.
9. The kiosk routes reachable by a person who holds a client tier and the
   worker role. See open question 3.
10. Portal-side numbers:
    - On InitiativeDetail, the tab badge, the "Assets — N" eyebrow, the
      "Assets by status" donut, the progress bar and "N of M shown"
      (InitiativeDetail.tsx:366, 786, 824-827, 869, 905) all compute from
      `rows.length` today. Switch them to the new true `total` and
      `by_status`.
    - ClientDashboard's "Total assets", "In transit", the fleet chart and
      the move progress bars (ClientDashboard.tsx:116-176, 301-387) need
      true numbers from the server instead of `listAssets().length`.
      Recent activity lists only visible scans.

11. `/dashboards/move` is hidden from client nav, but a client login
    can reach it by URL. Lock its route and data to global staff.
12. A watch set on a move uses that move's row rule, not the asset rule.

Owner, Admin and unchipped Viewers must get exactly what they get today on
every one of these. The tests should cover that too.

### Trucks and containers

Client logins can't open trucks, containers, warehouse or shipments today.
Those resources are global-only (resources.py:46-108), and the portal hides
them. The rule in decision 9 is how they should behave once they are
opened. This feature does not open them (see open question 1). Whoever
opens them later must know about these traps:

- `ContainerAssetRow` returns serial, name and model even for rows outside
  the viewer's scope (containers.py:358-368). It must return nothing for a
  hidden row and only count it.
- Container search (search.py:135-146) is unscoped.
- Notifications `_PAGES` has `scope=None` for truck and container
  (notifications/access.py:80, 84), and status provenance has no probe for
  them. Widening either resource would fail open.

### Rack view

RackViewModal draws from the same roster rows. A hidden asset is left out
of the drawing, so its RU slots look empty. This is my call; it matches
"just leave off devices they don't have access to see."

### Portal: client page Groups section

On `pages/StakeholderDetail.tsx`, add an `.init-panel` titled **Groups**
for clients only, between People (ends :773) and Notes & files (:854). It
uses the page's existing section idiom: `eyebrow-sm`, dir-toolbar,
DataTable machinery.

- **All | Review switch.** Copy AssetModels.tsx:437-450 exactly
  (`segmented`, `role="tablist"`). The Review tab gets a `badge-count` of
  undismissed values.
- **All tab.** One row per group, with these columns:
  - name;
  - aliases as chips;
  - assets: roster rows matched to the group on the client's moves;
  - people: how many contacts have the chip.

  Row actions use the standard `Actions ▾` menu (RowActionsMenu):
  - **Edit**: rename, and add or remove aliases with TagInput in
    free-text mode. Renaming keeps the old name as an alias, so rows
    already matched stay matched.
  - **Merge into…**: the source group's name and aliases become aliases
    of the target. Rows and chips move to the target, then the source is
    deleted. Show a dry run first, like ModelMergeModal.
  - **Delete**: confirm. The group's rows become unmatched and the chip
    comes off everyone who had it.

  An **Add group** button sits in the toolbar.
- **Review tab.** Copy ModelReviewPanel's layout (`rv-panel`, `rv-row`,
  "Show dismissed (n)" toggle, "Nothing to review" empty state).
  - Each row is a distinct unmatched Owner value on this client's moves,
    showing the value as written, "N assets · N moves", and the move
    names.
  - Actions:
    - **Match to group…** (accent): a ComboBox of the client's groups.
      Saving adds the value as an alias.
    - **Create group**: a modal with the name prefilled from the value and
      editable. If the name is edited, the original value is also added as
      an alias.
    - **Dismiss** / **Restore**.
  - Blank Owner is not listed.
- **Who can use it.** Only global staff with `clients:change` see the edit
  controls and the Review tab. Client Owner and Admin hold
  `clients:change` too, so gate on global plus `clients:change`, not
  `clients:change` alone. Client logins don't see the Groups section at
  all.
- **Endpoints** (under the existing clients router, global-only):
  - `GET /clients/{id}/groups`
  - `POST /clients/{id}/groups`
  - `PATCH /clients/{id}/groups/{gid}`
  - `DELETE /clients/{id}/groups/{gid}`
  - `POST /clients/{id}/groups/{gid}/merge {source_id, dry_run}`
  - `GET /clients/{id}/groups/review?include_dismissed=`
  - `POST /clients/{id}/groups/review/match {value, group_id}`
  - `POST /clients/{id}/groups/review/dismiss {value, dismissed}`

  Every change writes an audit row.

### Portal: tier and group chips on a person

- **Tier picker.** Add "Individual" to `TierSelect` for client links only.
  Partners stay owner/admin/viewer:
  - `tier_roles` (stakeholders.py:101) becomes per kind;
  - the schema `Literal`s (schemas.py:929, 936, 946, 977) accept
    "individual" for clients and return 422 for partners;
  - `ContactTier` (lib/api.ts:1130) and `TIER_LABEL` (TierSelect.tsx:9)
    are widened.
- **Editing chips.** Chips are edited in People › External ›
  EditPersonModal, on the client link's second line after the functions
  TagInput (External.tsx:734-743). They use `TagInput` in options mode
  with the client's groups, so nothing can be typed in. Label: "Groups".
  - For an **owner or admin** link, the chips stay saved but are shown
    dimmed, with the note "Owners and admins see every group."
  - For a **viewer** with no chips, the field says "All groups."
  - For an **individual** with no chips, the field says "No groups — sees
    no assets."
- **Showing chips read-only.** Show the chips under the tier chip in:
  - the client directory's Contacts panel (OrgDirectory.tsx:993-1002);
  - the client page's People section;
  - the user Profile's Org affiliations.
- **Endpoint.** `PATCH /clients/{id}/contacts/{person}` gains `group_ids`.
  - Writing it is global-only, even though client Owner and Admin can
    otherwise edit contacts.
  - It replaces the person's chips for that client.
  - Every group must belong to that client.
- **What the login itself can see.** `ScopeOut` gains
  `restricted_client_ids` so the portal knows when to show true totals
  next to a shorter list. Android ignores unknown keys. Check the iOS
  decoder before shipping.

### Individual with no chips

They can sign in and land on the Client Dashboard, as other client logins
do (Home.tsx:198). The dashboard shows the client's name and true totals.
Asset lists and recent activity use their normal empty states. No new
banner or explanation widget is added; see Jimmy's rule about unrequested
page widgets.

## Existing problems the sweep found

These exist today, with or without groups. Group limits are worthless if
they stay open, so each needs a decision (see open questions) or its own
task.

1. **Client plus worker reaches every move's roster through the kiosk.**
   - A person holding a client tier and the `worker` role gets
     `kiosk:view` (defaults.py:70, resources.py:108). Nothing prevents the
     combination: a client admin can add a worker as a contact, and the
     bulk workers import grants `worker` to an existing person.
   - With that grant, `/kiosk/sync/assets?initiative_id=…`,
     `/kiosk/sync/client-assets`, `/sync/containers`, `/sync/trucks` and
     `/setup-options` (kiosk.py:737, 994, 1137, 1391, 2338) return any
     move's full roster, from a kiosk or portal session.
2. **An import can attach another client's asset.**
   - The From-To importer matches assets by serial across all clients
     (move_assets.py:160-165).
   - So client B's file containing one of client A's serials attaches A's
     asset to B's move. B's users then see A's asset name, RFID, live
     location and client name.
   - Separately, the importer never sets `assets.client_id`
     (move_assets.py:439-445). Imported assets are on the client's roster
     but not on their /assets page. On dev that is 264 rows.
3. **Tiers are unioned across clients.** Someone who is owner at client A
   and viewer at client B gets `clients:change` and rank 30 at B too
   (stakeholders.py:113-126, 515-519). This design avoids the problem for
   groups by deciding per client, but the existing tier union is
   unchanged.
4. **Files default to Everyone.**
   - Uploads on a move or asset default to Everyone (attachments.py:223,
     NotesFilesPanel.tsx:105).
   - A From-To file or a report a staff member shares at Everyone has
     every serial in it, and can't be filtered by group.
   - Files are served by presigned links, which keep working after chips
     change.
5. **Asset-watch notices name sites and staff.** They include the site and
   the operator who scanned (asset_watch_check.py:249-307), which status
   provenance deliberately hides from clients. This isn't about groups,
   but it rides along with every asset a client can see.

## Answers to the open questions (2026-11-10)

Jimmy replied "ok build it" to the suggestions below. Each one is applied
as the answer, and the questions further down are kept for the record.

1. **Client logins can't lift a limit.** A client login (any tier, not
   global staff) gets a 403 `restricted_contact` when it tries to do any
   of these to a person who is an Individual, or who has group chips at
   that client:
   - change their tier;
   - remove them as a contact.

   A client login also can't add someone at the **Individual** tier.
   Making an Individual is staff-only, because staff are the only ones who
   can give them chips. The portal hides or disables those controls for
   client logins. Staff keep full control. When staff remove a contact,
   the chips are deleted as designed.
2. **Trucks and containers stay global-only.** This work only writes down
   the rule for later (see "Trucks and containers").
3. **Files and notes.** A restricted login (a Viewer with chips, or an
   Individual at the host's client) sees no notes and no files on:
   - moves (`initiative`);
   - assets (`asset`);
   - its client record (`client`).

   Lists come back empty. Reading or downloading one by id returns 404.
   Owners, Admins and unchipped Viewers are unchanged.
4. **Client tier and worker role can't be combined.**
   - Granting `worker` to someone who holds any `client_*` tier is
     refused with 409 `client_worker_conflict`.
   - Adding a `worker` as a client contact is refused the same way.
   - This applies to every path that grants these roles: contact add,
     ManageRolesModal, the bulk workers import (that row fails with the
     reason) and the CLI.
   - The migration doesn't revoke existing combinations. It reports any
     it finds with a log line, and the plan includes a read-only check of
     the dev DB.
5. **The four problems found get their own tasks.** These are problems 2
   (both halves), 3 and 5. Nothing changes for them here, and the asset
   rule only covers assets whose `client_id` is set. Move rosters are
   covered by the row rule either way.

## Open questions for Jimmy (answered above)

1. **Client admins lifting a restriction.**
   - Client Owner and Admin can change the tier of anyone below them
     (stakeholders.py:578-598) and remove and re-add contacts (:636-660).
   - That's enough to undo staff's limits:
     - change an Individual to a Viewer, who then sees everything;
     - raise a chipped Viewer to Admin;
     - remove someone and add them back without chips.
   - Should client logins be blocked from changing the tier of, or
     removing, anyone who is an Individual or has chips?
2. **Trucks and containers.** Should this work also open trucks and
   containers to client logins (with the leave-off-hidden-assets rule), or
   only set the rule for later?
3. **Files and notes on moves.** Restricted logins can read every
   Everyone-level file **and note** on a move or client they can see
   (attachments.py:125-130, access/hosts.py). Either kind can name serials
   and racks. For a Viewer with chips or an Individual, should these be
   hidden, kept, or raised to Internal?
4. **Client plus worker.** Should a person be blocked from holding a
   client tier and the worker role at once, or should the kiosk routes
   apply client and group rules?
5. **Imported assets with no client** (problem 2, second half).
   - The asset rule can only protect assets whose `client_id` is set. The
     264 imported dev assets have none, so they're only reachable through
     move rosters, where the row rule covers them.
   - Fixing it here (the importer sets `client_id`, plus a backfill) would
     grow what unrestricted logins see on /assets, the dashboard and
     search. That conflicts with "no change for them."
   - It also needs a rule for an asset on two clients' moves.
   - In scope, or its own task? Problems 2 (first half), 3 and 5: the same
     question.

## Calls I made (Jimmy to check)

- **Newest row wins.** Outside a move, an asset's group is its newest
  roster row on that client's moves. An asset on none of them counts as
  blank.
- **Rename keeps the old name.** A renamed group keeps its old name as an
  alias. Merge works the same way as model merge.
- **Deleting a group** unmatches its rows and removes its chips.
- **Staff only.** Only global staff manage groups, the review list and
  chips. Client Owner and Admin keep their current contact powers,
  including giving the new Individual tier, but they can't set chips.
- **Individual's rank and grants.** Individual is rank 8 and gets the
  same grants as Viewer, then the group filter.
- **Chips survive tier changes.** They're ignored while the person is
  Owner or Admin.
- **Rack view.** Hidden assets are left out of the rack drawing.
- **Notifications.** Notifications already received are not scrubbed
  when chips narrow. The asset-watch email gains the missing re-check.
- **Counts.** True totals show on move pages and the client dashboard.
  Status-rule notification counts stay visible-only, as they work today.
- **Matching** ignores case and extra whitespace only. No fuzzy matching.

## Left to the builder

- Whether the asset-level rule uses a lateral subquery, a SQL view or a
  materialized helper, as long as there is one shared implementation and
  /assets stays fast at about 15,000 assets.
- Index choices, the exact response shapes for true totals, and how the
  Groups section's modals are split into components.
- Test fixtures. Dev data already has 6–8 distinct Owner values each on
  Acme Widget, Contoso, Initech and Planet Express. Broadcom has one value
  and the existing `client-dev` persona.
