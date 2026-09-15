# User detail page — `/people/users/:personId`

**Date:** 2026-09-15 · **Status:** approved (Jimmy, 2026-09-15: everything about the person; access groups editable in place; one aggregated endpoint; styled like /me; the access block keeps today's rank-60 rule) · **Branch:** `user-detail` (worktree off `main` @ ad84c30)

## Problem

`/people/users` is a directory list with a row expansion. The expansion shows a kv dump of profile and account fields and five buttons (Edit profile, Reset password, Manage roles, Unlock, Enable/Disable). Nothing on the page says what a user can actually do:

- **Roles** grant permissions through the role matrix. "Manage roles" only toggles the six role names.
- **Access groups** are a separate mechanism: a page gated behind a group is visible only to that group's members and rank-60+ admins. Membership is edited only on `/access` › Groups, one group at a time. No surface lists a user's groups except `/access` › Explorer, which is hidden below rank 60.
- **Permission overrides** per person live on `/access` › Members.
- Sessions, activity, worker profile, org affiliations, and notification groups are not visible for other users anywhere.

A user's full picture is spread across three tabs on a different page and is partly invisible. This spec adds a full-detail page for one user, styled like `/me`, with everything in one place and the access pieces editable from it.

## Design

### Approach

One new aggregated read endpoint feeds one new page. Existing mutation endpoints and modals are reused; two small new mutations are added (set access groups for a person, sign out everywhere). No migration. The list keeps its row expansion as a quick glance and gains a "Full details" button.

### Page — `portal/src/pages/UserDetail.tsx`

Route `/people/users/:personId`, `ProtectedRoute resource="users"`. Chrome mirrors `Profile.tsx` (`/me`): eyebrow, `profile-hero`, `segmented me-tabs`, `profile-grid` panels, `profile-full` panel. Styles reuse `profile.css`, `directory.css`, `settings.css`, `access.css`; anything new goes in `portal/src/styles/user-detail.css` under a `ud-` prefix (layout only — the list typography guardrail stays green).

**Header.** Eyebrow "People › Users" with a `← Users` back link (`idet-back`, as WorkerDetail). Hero: cover, `AvatarUpload` (editable when the actor can change users and can touch the person), `h1` display name + account status chip (`STATUS_META`), `pm-role` line "Job title · role, role" (or "No title set" / "no roles"), `pm-sub` contact strip (✉ contact email, ☏ phone, ⌖ city/region, "joined <account created>"). Rank label from `RANK_LABELS` shown as a `chip tag` next to the status chip when `max_rank > 0`.

**Hero actions** (`profile-actions`), gated exactly as the list expansion today:

- Self → one button "Go to My profile" (→ `/me`) and no admin actions.
- Actor cannot touch the person's rank → the Access page's `ro-chip` ("Read-only · their rank is at or above yours"), no buttons.
- Otherwise: `Edit profile` (users:change), `Reset password` (users:change), `Unlock` (users:change, status locked), `Enable account` / `Disable account` (users:change), and the god-mode delete button. All reuse `UserAdminModals` (`AdminEditProfileModal`, `ResetPasswordModal`, `AccountStateModal`) and `GodDeleteButton`.

**Tabs** (`segmented me-tabs`, URL-driven like /me): `Profile` (`/people/users/:id`), `Access` (`/people/users/:id/access`), `History` (`/people/users/:id/history`). History is rendered only when `can('audit', 'view')`.

**Profile tab.**

- `profile-grid` left panel **Profile**: kv list — Person ID, Badge ID, Preferred name, Job title, Contact email, Phone, Address (same join as /me), Source (`manual` → "Added manually", `v2_import` → "Imported from V2" with `source_ref` mono under it; any other value shown raw), Member since (person created). Panel head button `Edit` opens `AdminEditProfileModal` (same gating as the hero).
- Right panel **Account**: kv list — Login email, Status chip, Password ("change required" amber chip, else "Last reset <date>" or "set"), Last sign-in (relative, with absolute on `title`), Account created. Panel head button `Reset password`.
- `profile-full` panel **Memberships**: three mini-lists (`mini-list` / `mini-row`), each with a header and an empty note:
  - *Worker profile* — one row: trade, level badge, partner name or "Direct hire", status chip, and a `mini-btn` "Open worker page" → `/people/workers/:id`. Hidden entirely when `worker` is null (a note "Not a worker" instead).
  - *Org affiliations* — one row per client/partner-anchored role grant: org name (link → `/stakeholders/clients/:id` or `/stakeholders/partners/:id`), role label chip. Note "No client or partner roles" when empty.
  - *Notification groups* — one row per group: name (link → `/system/notifications/:id`), channels as `chip tag`s, member since. Note "Not in any notification groups" when empty.
- `profile-full` panel **Active sessions** (only when `sessions` is non-null): the /me session rows (`session-item`: device from `describeUserAgent`, IP, started, expires) without the per-row revoke; head button `Sign out everywhere` (danger `mini-btn`) → confirm modal → `POST /users/{id}/sessions/revoke-all`. "No live sessions found." when empty.

**Access tab.** Four `panel`s stacked full width (`profile-full`), each a real aligned table (`DataTable`-style rows, `—` per empty cell):

1. **Roles** — columns Role (chip, `ROLE_CLS` — moved from `Users.tsx` into `lib/users.ts` so both pages share it), Label, Rank, Scope (org name or "Global"), Granted by, Granted on. Head button `Manage roles` (access:change and can touch) → existing `ManageRolesModal`. Empty note "No roles granted".
2. **Access groups** — columns Group (link → `/access?tab=groups&group=<id>`), Description, Pages gated (count, `title` lists the page labels), Added by, Added on. Head button `Manage groups` → new `ManageGroupsModal`. Empty note "Not in any access groups".
3. **Overrides** — columns Page, Action, Effect (allow `c-green` / deny `c-red` chip), Set by, Set on. Head button `Edit overrides` → existing `OverrideEditor` (`components/access/OverrideEditor.tsx`). Empty note "No overrides".
4. **Effective permissions** — the read-only `MatrixTable` from `components/access/MatrixTable.tsx` fed with `access.cells`, exactly as ExplorerTab renders it, with the scope line ("Global" or the client/partner names) above it.

When `access` is null (actor below rank 60 and not self) panels 2–4 render one shared note instead of tables: "Resolved access (groups, overrides, effective permissions) is visible to admins at rank 60 and above." Roles still render from the base payload and `Manage roles` still works for access:change actors — no dead buttons.

**History tab.** `ActivityHistory` (`components/ActivityHistory.tsx`) with a new optional `subjectName` prop: when set, rows with `by_me` label the actor as that name instead of "You", the who-filter option reads the name, and the legend dot keeps the `me` class. Fed by `GET /users/{id}/activity`, fetched when the tab is first opened.

**Manage groups modal** (`components/ManageGroupsModal.tsx`, exported next to the other user admin modals). Report-generate header pattern (eyebrow "Access groups", title "Groups — <name>", description "Members of a group can open the pages gated behind it."). Body: one `role-pick`-style toggle per group from `getAccessSummary().groups`, each showing the group name, description, and "gates N pages" (count of `summary.resources` whose `gated_by` includes the group). Disabled with a `title` when the actor cannot touch the person. Save → `PUT /users/{id}/access-groups` with the full selected id list; errors map `rank_too_low` / `group_not_found` / `user_not_found`. Note under the toggles: "Adding someone to a group does not grant a role — it only unlocks gated pages." Sizes to content (wide card, no clipped dropdowns).

**Not found / loading.** Unknown id, no account, or 404 → `dir-empty` "User not found — This person does not exist or has no login account." with the back link. Loading → back link + "Loading…" hint.

**After every mutation** the page reloads the payload (`load()`), and the History tab refetches if it has been opened.

### Users list changes — `portal/src/pages/Users.tsx`

- The expansion's `detail-actions` gains a first button `Full details` (`mini-btn accent`, → `/people/users/:id`) for every row the actor can see, including self (next to "Go to My profile") and outranked rows (next to the read-only note).
- `AddPersonModal.onCreated` navigates to `/people/users/:newId` instead of expanding the row.
- The `Workers.tsx` empty-state copy "Grant someone the worker role via Users → Manage roles" is unchanged (still true).

### Access page deep link — `portal/src/pages/Access.tsx`, `GroupsTab.tsx`

`Access` reads `useSearchParams()`: `tab` (one of roles/groups/members/explorer) sets the initial tab; `group` is passed to `GroupsTab` as `initialGroupId`, which seeds `selectedId` when that group exists in the summary. Params are read once on mount; tab clicks do not write back to the URL (unchanged behavior).

### API — `api/src/serversherpa/api/routes/users.py`

No migration. Schemas in `api/src/serversherpa/api/schemas.py`.

**`GET /users/{person_id}` → `UserDetailOut`** — `require_permission("users", "view")`; the row must satisfy `scope_conditions("users", …)` (same visibility as the list); 404 `user_not_found` when the person is missing or has no `UserAccount`.

```
person:   PersonDetail fields + source, source_ref, archived_at
account:  login_email, status (active|locked|disabled), must_change_password,
          last_login_at, created_at, password_updated_at
roles:    [{ role, label, rank, scope_anchor, org: {kind: client|partner, id, name} | null,
             granted_by: {id, display_name} | null, granted_at }]   # active grants only
max_rank: int
worker:   { trade, level, level_label, partner: {id, name} | null, status, status_label,
            status_color } | null
notification_groups: [{ id, name, channels, added_at }]   # enabled groups only; channels = effective
access:   null | { groups: [{ id, name, description, gate_count, gated_pages: [label],
                              added_by: {id, display_name} | null, added_at }],
                   overrides: [{ resource, resource_label, action, allow,
                                 set_by: {id, display_name} | null, set_at }],
                   scope: ScopeInfo (as /access/effective),
                   cells: same shape as /access/effective }
sessions: null | [{ family_id, started_at, last_active_at, expires_at, ip_address, user_agent }]
```

- `access` is populated only when the actor has `access:view` **and** (`actor.max_rank >= GATE_BYPASS_RANK` or `person_id == actor.person.id`) — the same rule `/access/effective/{id}` enforces today. The cell computation is factored out of `access.py::effective` into `serversherpa/access/effective.py::effective_cells(db, person_id)` and reused by both endpoints so the sourcing logic has one home.
- `sessions` is populated only when the actor has `users:change` and is global (`_require_global` semantics without raising) — matches the other admin mutations. The session query is the `/me/sessions` query with the target id and no `current` flag; factor it into a helper shared with `me.py`.
- `roles.org.name` comes from `Client.name` / `Partner.name`; `granted_by` / `added_by` / `set_by` display names come from one batched `Person` lookup.
- `notification_groups.channels` is the member's effective channels (`effective_settings()` from `routes/notifications.py`).

**`GET /users/{person_id}/activity` → `list[MyActivityItem]`** — `require_permission("audit", "view")` + `_require_global`; 404 when the person has no account. Same query as `/me/activity` pointed at the target (rows where they acted, plus `ABOUT_ME_ENTITY_TYPES` rows whose `entity_id` is their person id or login email); `by_me` = the target acted. Factor the query out of `me.py` into a shared `person_activity(db, person_id, email)` helper. Limit 100.

**`PUT /users/{person_id}/access-groups` body `{ group_ids: [uuid] }` → `{ group_ids: [uuid] }`** — `require_permission("access", "change")`; `_load_target` (global actor, not self, 404, rank check); unknown id → 404 `group_not_found`. Diff against current membership: delete removed rows, insert added rows with `added_by`. One audit row: `entity_type="person"`, `entity_id=<person>`, `action="access_groups.set"`, `changes={"groups": {"from": [names], "to": [names]}}`. Returns the sorted resulting id list.

**`POST /users/{person_id}/sessions/revoke-all` → 204** — `require_permission("users", "change")`; `_load_target`; `_revoke_all_sessions(db, person_id, reason="admin_revoke")`; audit `entity_type="auth"`, `entity_id=<person>`, `action="session.revoke_all"`.

Existing endpoints are untouched: `PUT /users/{id}/roles`, `PATCH /users/{id}/profile`, `POST …/reset-password|disable|enable|unlock`, `PUT /access/overrides/{id}`.

### Portal API client — `portal/src/lib/api.ts`

`UserDetailOut` and its nested types, `getUserDetail(id)`, `getUserActivity(id)`, `setUserAccessGroups(id, groupIds)`, `revokeAllUserSessions(id)`.

### Navigation

`App.tsx` adds `/people/users/:personId`, `/people/users/:personId/access`, `/people/users/:personId/history` (one element, tab derived from the path). The command palette and search results are unchanged in this spec.

## Error handling

- Page load failures: 404 → not-found state; 403 → not-found state (the list would not have shown the row); network → "Could not load this user." hint with a Retry button.
- Modal errors reuse the existing maps (`USER_ERRORS`, `UserAdminModals` error text) plus `group_not_found` for the groups modal.
- The History tab shows "Could not load history." with Retry on failure; a 403 hides the tab (defensive — the tab is already gated on `audit:view`).

## Testing

**API — `api/tests/test_users_detail_api.py`** (real Postgres, existing fixtures):

- detail: 200 for a global users:view actor with every block; `access` null for a rank-40 actor viewing someone else and populated for the same actor viewing self; `access` populated for a rank-60 actor; `sessions` null for a users:view-only actor and populated for users:change; 404 for a person without an account; scope refusal for a client-anchored actor viewing an out-of-scope user.
- roles block carries `org.name` for a client-anchored grant and `granted_by.display_name`.
- activity: 403 without audit:view; rows include both acted-by and about-them entries; `by_me` reflects the target.
- access-groups: diff adds and removes; audit row shape; 403 `rank_too_low` when the target outranks the actor; 403 `cannot_target_self`; 404 `group_not_found`.
- revoke-all: live sessions get `revoked_at`; audit row present; 403 without users:change.
- `effective_cells` refactor: the existing `test_access_api.py` effective tests keep passing unchanged.

**Portal — `portal/src/pages/UserDetail.test.tsx`** (vitest + jsdom, fetch mocked as in `Profile.test.tsx`):

- three tabs, Profile active at the base path; History hidden without audit:view.
- Profile tab renders the Profile / Account / Memberships / Active sessions panels from a fixture; sessions panel absent when `sessions` is null.
- Access tab renders four panels; the rank note replaces panels 2–4 when `access` is null; `Manage roles` still present for access:change.
- self → "Go to My profile" only; outranked → read-only chip, no buttons.
- Manage groups modal: toggling and saving sends the full id list to `PUT /users/:id/access-groups`; `rank_too_low` shows its message.
- `Sign out everywhere` confirms then posts to revoke-all and reloads.
- `Users.test` addition: the expansion shows `Full details` linking to the page. `Access.test` addition: `?tab=groups&group=<id>` opens Groups with that group selected. `ActivityHistory` with `subjectName` labels `by_me` rows with the name.

**Live verification** (dev stack, `claude-dev` and `jhenderson` accounts): screenshots of all three tabs for a rank-100 viewer, the Access tab for a rank-40 viewer (note shown), the Manage groups modal before and after a save (and the group's member list on `/access` reflecting it), and the list expansion's Full details button. Run the list typography guardrail.

## Out of scope

- Editing another user's notification-group overrides or worker profile from this page (links out instead).
- Per-session revoke for other users (only sign-out-everywhere).
- Writing tab changes back to the Access page URL.
- Command palette / global search deep links to the new page.
