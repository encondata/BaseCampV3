# Copy access and role-change review — design

**Source:** parity sheet Gaps rows 2 and 3 (Admin and permissions): "Copy one
person's access to another" and "Preview who a role change would affect".
Both live on the portal's `/access` page (Jimmy's direction, 2026-09-21).

**V2 behavior being ported:** copy replaced the target's whole permission set
with the source's, from one edit screen or across a multi-selected list. The
role-change preview existed in V2 only as a backend endpoint (affected count,
ten names, additive diff) with no screen.

**Decisions (Jimmy):** the copy dialog offers Replace and Add only (Replace is
the default); the role-change review is a review step on the Roles tab Save
only, not a per-person before/after.

## V3 access model (existing, unchanged)

A person holds roles (`person_roles`, global or anchored to a client/partner),
access group memberships (`access_group_members`), and per-cell overrides
(`permission_overrides`). A cell is one resource × action
(`view|add|change|delete`). `access/resolver.py::resolve_access` computes the
effective matrix; `access/effective.py::effective_cells` adds each cell's
source: `hard_gate`, `override`, `gate`, `floor`, `role`. Rank rules:
`can_touch_rank(actor, target)` (strictly below, top rank 100 may touch peers).
No schema change is needed for either feature.

## Feature 1: Copy access

### Where

`/access` Members tab: a **Copy access…** button in the toolbar, and a **Copy**
button on each member row (next to Overrides) that opens the dialog with that
member as the source. Both require `access:change`.

### Dialog

Report-generate modal header (eyebrow "Access", title "Copy access", one-line
description). Body, in order:

1. **Source** — house `ComboBox` over the members list (display name, roles as
   the sub line).
2. **Targets** — a chip list. A `ComboBox` labeled "Add person…" adds one
   member per pick as a removable chip; the source and already-added people
   are excluded from its options. At least one target is required.
3. **Copy** — three checkboxes, all on: Role, Access groups, Overrides. At
   least one must stay on.
4. **Mode** — segmented control: **Replace** (default) / **Add only**, with a
   one-line explanation under the selected option.
5. **Preview** button → the dialog shows the per-target plan (below). While a
   plan is shown, **Apply** is enabled. Changing any input clears the plan.

Per-target plan row: avatar + name, then for each selected part a short
from → to summary ("Role: staff → admin", "Groups: +Finance, −Ops",
"Overrides: 3 added, 1 removed, 0 changed"), or **Skipped** with the reason.
"No change" when a part already matches. A footer counts "N will change,
M skipped".

After Apply: the dialog closes, the Members list refetches, and a toast reads
"Access copied to N people" (plus "M skipped" when any were).

### API

`POST /access/copy` — requires `access:change` and a global actor.

Request:

```json
{"source_id": "<uuid>", "target_ids": ["<uuid>", ...],
 "parts": ["roles", "groups", "overrides"], "mode": "replace" | "add",
 "dry_run": true | false}
```

`target_ids` non-empty and distinct, `parts` non-empty. Errors: 404
`person_not_found` (source), 422 `no_targets` / `no_parts` / `unknown_part`
/ `unknown_mode`, 403 `cannot_target_self` when the source is the actor
(copying **from** yourself is allowed; copying **to** yourself is a per-target
skip).

Response: `{"mode", "parts", "targets": [PlanRow...], "applied": bool}` where

```json
PlanRow = {"person_id", "display_name", "avatar_url", "status": "ok"|"skipped",
           "reason": null | "cannot_target_self" | "rank_too_low" | "no_account"
                    | "role_rank_too_low",
           "roles": {"from": [..], "to": [..]} | null,
           "groups": {"from": [names], "to": [names]} | null,
           "overrides": {"added": n, "removed": n, "changed": n} | null}
```

Rules:

- **What "roles" means:** only global-anchored roles. Client- and
  partner-anchored grants are never copied and never revoked (the same rule
  `PUT /users/{id}/roles` already applies).
- **Replace:** target's global roles := source's global roles; groups :=
  source's groups; overrides := source's overrides (rows the source lacks are
  deleted).
- **Add only:** each part becomes the union; on an override conflict the
  source's value wins.
- **Skips, evaluated per target in this order:** target is the actor →
  `cannot_target_self`; target has no `user_accounts` row → `no_account`;
  `can_touch_rank(actor.max_rank, target.max_rank)` false → `rank_too_low`;
  any role the plan would newly grant has rank the actor cannot touch →
  `role_rank_too_low`. A skipped target is reported and untouched; the
  request still succeeds for the others.
- **Dry run** computes the same plan and writes nothing (no audit).
- **Real run** applies every `ok` target, then commits once. One audit row
  per target: `entity_type="person"`, `entity_id=target`,
  `action="access.copy"`, `changes={"source_id", "source_name", "mode",
  "parts", "roles": {...}, "groups": {...}, "overrides": {...}}` (only parts
  that changed). Targets with no change in any part get no audit row and are
  still reported `ok`.

### Shared apply helpers (refactor)

New module `api/src/serversherpa/access/apply.py`:

- `apply_global_roles(db, actor_id, person_id, desired: set[str], role_rows) -> dict | None`
  — the diff currently inline in `users.py::set_roles` (soft-revoke
  `revocable_current - desired`, add `desired - current`), returning
  `{"from": [...], "to": [...]}` or `None` when unchanged. Does not audit or
  commit.
- `apply_groups(db, actor_id, person_id, desired: set[uuid]) -> dict | None` —
  from `users.py::set_access_groups`, returning group **names** from/to.
- `apply_overrides(db, actor_id, person_id, desired: dict[(res, action), bool]) -> dict`
  — from `access.py::put_overrides`, returning the per-cell change map.

The three existing endpoints call these helpers and keep their own validation,
audit action names, and responses. Existing tests must pass unchanged.

## Feature 2: Role change review

### Where

`/access` Roles tab. **Save changes** opens the review modal instead of
saving. **Discard** is unchanged. Inside the modal, **Confirm** performs the
existing `PUT /access/roles/{name}/matrix`; **Back** closes it and keeps the
draft.

### Modal

Report-generate header (eyebrow "Roles", title "Review changes to {label}").

- Summary chips: "+N grants", "−M grants", "K members affected" (members
  whose effective matrix flips at least one cell) out of "T members".
- **Grant changes:** two lists, added and removed, as "Resource · action".
- **Members:** every person holding the role, sorted by flips desc then name:
  avatar, name, rank label, "3 permissions change" or "no effective change".
  Expanding a row lists each flipped cell as "Resource · action: off → on" and
  each masked cell as "Resource · action — unchanged, decided by override /
  group gate / hard gate".
- When the role has no members: "No one holds this role" and Confirm stays
  enabled.
- Errors from the preview show inline; the modal never leaves the draft in an
  unknown state.

### API

`POST /access/roles/{name}/matrix/preview` — body `MatrixIn`, same guards and
validation as the PUT (`access:change`, `_load_role_for_edit`,
`cannot_edit_own_role`, unknown resource/action, developer-only,
`access_view_locked`). Writes nothing.

Response:

```json
{"role": name, "granted": ["res:action"...], "revoked": ["res:action"...],
 "member_count": T, "affected_count": K,
 "members": [{"person_id", "display_name", "avatar_url", "max_rank",
              "flips": [{"resource", "action", "from": bool, "to": bool}],
              "masked": [{"resource", "action", "by": "override"|"gate"|"hard_gate"|"floor"}]}]}
```

`flips` = cells whose effective value differs between current and draft.
`masked` = cells in `granted ∪ revoked` whose effective value does not change
for this member; `by` is the cell's source from `effective_cells` under the
draft (a `role` source that does not flip means another held role also grants
it; report that as `by: "role"`).

### Resolver change

`resolve_access(db, person_id, *, role_grants_override: dict[str, set[tuple[str, str]]] | None = None)`
and `effective_cells(db, person_id, *, role_grants_override=None)`: when
given, the resolver uses the override's (resource, action) set for that role
name instead of the `role_permissions` rows, for every other role it reads the
table as today. Nothing else in the resolution changes. Existing callers pass
nothing.

## Portal pieces

- `lib/api.ts`: `copyAccess(body)`, `previewRoleMatrix(name, matrix)` and their
  types.
- `components/access/CopyAccessModal.tsx` (dialog + plan view),
  `components/access/PersonChipPicker.tsx` (ComboBox + chips, reusable),
  `components/access/RoleReviewModal.tsx`.
- `MembersTab.tsx`: toolbar button, per-row Copy button, toast on apply.
- `RolesTab.tsx`: Save opens the review modal; Confirm runs the existing save.
- Error copy for every API error code above, American English.

## Out of scope

Copy-access entry on the user detail page, bulk selection on the Users list,
a per-person before/after when one member's role changes, copying
notification group memberships, undo.

## Testing

- API: `test_access_copy_api.py` (replace vs add for each part, org-anchored
  roles untouched, every skip reason, dry run writes nothing, audit row per
  changed target, self-as-source allowed); `test_access_matrix_preview_api.py`
  (guards mirror the PUT, flips and masked by override / gate / other role,
  empty role); resolver override unit test; existing role/group/override
  endpoint tests unchanged after the helper refactor.
- Portal: PersonChipPicker add/remove/exclusions; CopyAccessModal payload and
  plan rendering; RolesTab Save opens review and Confirm calls the PUT;
  whole suite + `tsc --noEmit`.
- Live on the branch stack (ports 8001/5175): copy staff-tester's access to a
  second dev user in dry run and for real, then review a staff matrix change
  and confirm it.
