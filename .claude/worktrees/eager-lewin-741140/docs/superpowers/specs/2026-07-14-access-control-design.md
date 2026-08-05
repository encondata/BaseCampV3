# Access Control — Design Spec

**Date:** 2026-07-14
**Status:** Approved for planning
**Scope:** Server-authoritative policy layer (permissions, roles, ranks, groups, overrides, row scoping) **plus** the four-tab Access control admin page, **plus** an app-wide user audit trail (generic service + full retrofit of existing mutation endpoints and auth events). View-as impersonation is explicitly deferred to a later spec.
**Reference:** `fibertrace/design-docs/access-control.md` (UI/model blueprint; this spec adapts it server-side and adds rank hierarchy + row scoping).

---

## 1. Mental model

Two orthogonal axes, composed:

- **The matrix** answers *"can this role do this action on this resource type?"* — `resource × (view/add/change/delete)` boolean grants.
- **Row scoping** answers *"on which rows?"* — derived from the role's **scope anchor** and the grant's org pointer (`person_roles.client_id` / `partner_id` / the person themselves).

Layered on top:

- **Per-person overrides** (tri-state: inherit/allow/deny) for one-off exceptions.
- **Access groups** membership-gate sensitive resources (role says *could*, gate says *only if you're in the club*).
- **Rank hierarchy** governs who may administer whom: nobody touches access at or above their own level.

Resolution precedence (per resource × action): **hard code gates → override → group gate → role union**, with `always_viewable` applied last as a floor.

---

## 2. Roles, ranks, scope anchors

`roles` table (extended, not replaced) gains `rank int`, `scope_anchor enum('global','client','partner','self')`, `is_system bool`, `label`, `color`.

| Rank | Role(s) | Anchor | Notes |
|---|---|---|---|
| 100 | `developer` | global | Full everything, including `developer_only` resources |
| 100 | `founder` | global | Same authority as developer **except** `developer_only` resources (hard-coded, not editable) |
| 80 | `super_admin` | global | |
| 60 | `admin` | global | Gating-bypass threshold (rank ≥ 60 bypasses group gates) |
| 40 | `staff` | global | |
| 30 | `client_owner` / `vendor_owner` | client / partner | |
| 20 | `client_admin` / `vendor_admin` | client / partner | |
| 10 | `client_viewer` / `vendor_viewer` | client / partner | |
| 10 | `worker` | self | |
| 5 | `external` | self | Catch-all, minimal |

- **Custom roles** are created by cloning an existing role: deep-copies its matrix, inherits its scope anchor, and takes a rank chosen by the creator, capped **below** the creator's rank.
- Old flat `client` / `vendor` roles are retired; existing grants are remapped (§8).
- `person_roles` is **untouched** — it already carries the scope instance (`client_id`/`partner_id`) and grant history. A person may hold multiple grants; permissions union, scope sets union, and `max_rank` = highest rank held.

### Rank rules (enforced server-side on every admin mutation)

1. An actor may only manage people whose max rank is **strictly below** their own. Exception: rank-100 holders may also manage each other (someone must be able to). The existing no-self-targeting rule stays.
2. An actor may only grant/revoke roles, edit role matrices, or create clones with rank **strictly below** their own (rank-100: ≤ 100).
3. Overrides and group-membership edits follow rule 1 (the target person's rank governs).
4. Any Access-control mutation additionally requires the `access:change` permission (defaults to admin+).

Rank + anchor compose for the future: a `client_owner` outranks a `client_viewer` *within the same client scope*, which lays groundwork for org self-service later without new machinery. (Self-service itself is out of scope for v1.)

---

## 3. Resource registry (code, not DB)

`api/src/serversherpa/access/resources.py` — a static list; deploys introduce resources, never DB writes.

```python
Resource(
    id="workers", label="Workers", routes=["workers"],
    scope=ScopeMap(client=None,
                   partner="worker_profiles.partner_id",
                   self="worker_profiles.person_id"),
    developer_only=False, always_viewable=False,
)
```

Initial registry: `dashboard`, `users`, `workers`, `clients`, `partners`, `attachments`, `settings`, `access`, `audit`, `devtools`.

Per-resource declarations:
- **routes** — portal routes the resource gates (route→resource map ships to the portal).
- **scope map** — per anchor type, the column that filters rows. No entry for an anchor = that anchor type cannot see the resource at all (hard gate).
- **`developer_only`** — only accounts holding the `developer` role can ever access it (`devtools` now; any future infra surface). No matrix edit or override can grant it to anyone else — enforced in code, founder included.
- **`always_viewable`** — `view` is forced true for every role (`access` — anti-lockout: the Access page is never hidden; editing still requires `access:change` + rank).

---

## 4. Database (migration 0009)

Sparse-grant tables; all follow existing audit-column conventions.

| Table | Shape | Semantics |
|---|---|---|
| `roles` (extended) | + `rank`, `scope_anchor`, `is_system`, `label`, `color` | System roles seeded per §2 |
| `role_permissions` | PK (`role`, `resource`, `action`) | Row present = granted. Actions: `view/add/change/delete`. Defaults seeded from a code-side spec |
| `access_groups` | id, name, description, icon | |
| `access_group_members` | group_id × person_id, `added_by/added_at` | |
| `resource_group_gates` | resource × group_id | No rows for a resource = open to any role the matrix allows |
| `permission_overrides` | person_id × resource × action → `allow bool`, `set_by/set_at` | Row absent = inherit; true = force allow; false = force deny |
| `audit_log` | `actor_person_id`, `entity_type`, `entity_id`, `action`, `changes` JSON (before→after per field), `ip`, `at` | **App-wide** audit trail (see §6a) — written by every mutation in the app, not just access control |

---

## 5. Resolution

Single resolver, `api/src/serversherpa/access/resolver.py`:

```
effective_permissions(person):
  grants   = active person_roles rows        # possibly several
  roles    = their role definitions (rank, anchor)
  max_rank = highest rank held

  for each resource in REGISTRY:
    # 0. hard gates — data can never open these
    if resource.developer_only and "developer" not in roles → all false
    if no scope-map entry exists for ANY of the person's anchors
       and person holds no global-anchor role → all false

    for each action:
      # 1. explicit per-person override wins
      if override(person, resource, action) exists → that value
      # 2. else group gate
      elif gated(resource) and not in_any_gating_group(person) and max_rank < 60 → false
      # 3. else role grant, unioned across all held roles
      else → any(role_permissions[role][resource][action] for role in roles)

    # floor, applied last
    if resource.always_viewable → view = true
```

**Row scoping** is separate:
- *Scope set* = union over grants: any global role → `ALL`; client-anchored grants → set of `client_id`s; partner-anchored → `partner_id`s; self → own `person_id`.
- `scope_filter(resource, person)` returns a SQLAlchemy clause: `ALL` → no filter; else `scope_col IN (ids)` per the resource's scope map, OR-ed across anchor types the person holds.

**Caching:** resolver runs per request inside `get_current_user` (3 small indexed queries alongside the existing role lookup). No snapshot invalidation in v1. The resolved object is also returned in login/refresh/`me` payloads.

---

## 6. API enforcement

- New dependency **`require_permission(resource, action)`** replaces `require_roles` at every call site (users, stakeholders, workers routers — the plan enumerates the mapping). 403 `{"code":"forbidden"}` as today. `require_roles` survives only for role-identity cases (e.g. worker self-service endpoints).
- `AuthContext` gains `perms` and `scope`.
- **Scoped queries:** list/detail/mutation handlers apply `scope_filter()`. Out-of-scope detail → **404** (not 403 — no ID probing). Mutations re-check scope on the loaded row. Creates force the new row's scope column into the actor's scope. **Global search** applies the same rules per category: a category the actor can't `view` is omitted, and visible categories are scope-filtered.
- **New router `routes/access.py`:**

| Endpoints | Guard |
|---|---|
| `GET /access/summary` (stats, roles, matrix, groups, gates) | `access:view` (always granted) |
| `PUT /access/roles/{key}/matrix` · `POST /access/roles` (clone) · `DELETE /access/roles/{key}` (custom only) | `access:change` + rank rules |
| `GET/POST/DELETE /access/groups…` + members + gates | `access:change` + rank rule on member targets |
| `GET/PUT/DELETE /access/overrides/{person_id}` | `access:change` + rank rule |
| `PUT /access/people/{person_id}/role` | `access:change` + rank rules on target **and** new role |
| `GET /access/effective/{person_id}` (Explorer "why" payload) | `access:view`; actors below rank 60 may only query themselves |

- **Server invariants (rejected regardless of actor):** granting `developer_only` resources to non-developer roles; removing `view` on `access` from any role; deleting or re-ranking system roles; rank violations; self-targeting.
- Every mutation writes an `audit_log` row via the shared audit service (§6a).

---

## 6a. App-wide audit trail

A generic, always-on record of **who did what, to what, and what changed**.

**Service:** `api/src/serversherpa/services/audit.py` — one helper, called from the service layer inside the same transaction as the mutation (an audit row never commits without its change, and vice versa):

```python
await audit(db, actor=ctx, entity_type="worker", entity_id=wid,
            action="update", changes=diff(before, after), ip=client_ip)
```

- `changes` is a per-field before→after JSON diff, computed by a shared `diff()` helper from the loaded row's prior state. Sensitive fields (password hashes, token hashes) are **never** stored — redacted at the diff layer by field-name denylist.
- `action` vocabulary: `create / update / delete / archive / restore` for data, plus domain verbs where clearer (`role.grant`, `role.revoke`, `override.set`, `group.member_add`, `login`, `login_failed`, `logout`, `password_change`, `session_revoke`, `token_replay_detected`).
- Actor is nullable only for pre-auth events (`login_failed` records the attempted email + IP).

**Full retrofit (this effort, not deferred):** every existing mutation endpoint gets an audit call — users/account admin, stakeholders (clients, partners, contacts), workers (profile/level/certs/blacklist), attachments, self-service profile/password/UI-prefs — plus auth events (login success/failure, logout, refresh-replay detection, forced password change, session revocation). The implementation plan enumerates every call site; reads are not logged.

**Indexes:** `(entity_type, entity_id, at)` for per-record history, `(actor_person_id, at)` for per-user activity. Append-only — no update/delete API, and no ORM update path; retention/pruning is a future ops decision.

---

## 7. Portal integration

- Auth payloads gain `perms` (effective matrix), `max_rank`, scope summary; stored in `AuthContext`.
- **`useAccess()`** hook: `can(resource, action)`, `maxRank`. `hasRole()` survives only for identity-flavored checks; every gate-shaped call site migrates (AppShell nav, ProtectedRoute, CommandPalette, UserAdminModals, Settings — plan enumerates all).
- Enforcement points:
  1. **Nav** (accordion + ⌘K): items render only when `can(resource,'view')`, via the route→resource map.
  2. **Routes:** `ProtectedRoute` gains a `resource` prop; direct navigation to an unviewable route renders a "no access" state.
  3. **Actions:** mutating controls disable with tooltip when `can()` is false. UI is a convenience mirror — the server is always the authority.
- Person-row action menus hide/disable for targets at or above the viewer's rank.

---

## 8. Access control page (`portal/src/pages/Access.tsx`, route `/access`)

Four-tab layout per the reference, built with V3 shell/panel patterns. Page head + stat strip (Members · Roles · Groups/gated pages · Overrides) + pill tabs. `access:view` without `access:change` → amber "Read-only" chip, all controls disabled; the page itself is never hidden.

- **Roles tab:** role cards (label, member count, **rank badge**, **anchor badge**, description, system marker). Selected role → permission matrix (rows = registry, columns = 4 actions, checkbox cells, column toggle-all). `developer_only` rows render padlocked for all roles but developer; `access` view column locked on. Editable only when viewer's rank > role's rank. Clone → name + rank picker capped below viewer's rank.
- **Groups tab:** group cards (member count, "gates N pages", avatar stack) + "Page access by group" panel (per-resource gating chips or "Open to all", Manage button). Member adding uses the shared type-to-filter **ComboBox**.
- **Members tab:** everyone holding any grant — avatar/name, role dropdown (options capped below viewer's rank), org column (client/partner for anchored grants), overrides count chip → **tri-state override editor** (inherit/allow/deny cells cycling, inherited value ghosted). Gets the shared **Filters / Columns / Export** toolbar (`listTools.tsx`): filter by role, rank band, org, has-overrides.
- **Explorer tab:** person ComboBox → group chips, scope summary ("sees: Acme Corp only"), read-only **effective matrix** (green/dim cells, violet ring where an override decided the cell) driven by `GET /access/effective/{id}`. Viewers below rank 60: self only.

Responsive: matrices and member rows scroll horizontally in `overflow-x:auto` containers; card grids collapse per global rules.

---

## 9. Migration & rollout

**Migration 0009**, one migration:
1. Extend `roles`; insert system roles; seed `role_permissions` from the code-side default spec.
2. Create the five new tables (§4).
3. Remap grants in place: `client` → `client_viewer`, `vendor` → `vendor_viewer` (preserving org pointers + history); delete retired role rows. Downgrade reverses.

**Atomic cutover:** the same branch converts every `require_roles` call site and every portal `hasRole` gate — no dual-system period. Seeded matrix preserves current behavior day one (admin+staff keep today's capabilities; `super_admin` = admin + access editing; `developer` = everything).

---

## 10. Testing

Pytest, existing api test layout; portal tests alongside. **No seeded demo records — tests build their own fixtures.**

- **Resolver units (core investment):** precedence (override > gate > role), gating with/without rank-60 bypass, `developer_only` immunity to matrix edits *and* overrides, `always_viewable` floor, multi-role union, scope-set derivation.
- **Rank rules:** table-driven actor×target grids — staff→admin blocked, admin→admin blocked, rank-100 peer management allowed, clone-rank cap, self-targeting blocked.
- **Routes:** converted endpoints 403 without permission; scoped lists return only in-scope rows; out-of-scope detail → 404; creates forced into actor scope.
- **Admin API:** invariants hold (can't ungrant `access:view`, can't grant `developer_only`, system roles protected); audit rows written.
- **Audit trail:** every retrofitted mutation writes exactly one row with a correct field diff; sensitive fields redacted; auth events (login/failed/logout/replay) logged; audit row rolls back if the mutation fails.
- **Portal:** `can()` hook units + nav-gating smoke test.

---

## 11. Out of scope (deferred)

- **View-as impersonation** (reference §9) — own spec later; the resolver's person-parameterized design already supports it.
- **Org self-service** (client-owner managing their own contacts) — model supports it (rank × scope), no UI/endpoints in v1.
- **Per-record ACLs / sharing** — no current need; world is org-partitioned.
- **Audit log viewer page** — the trail itself is fully implemented in this effort (§6a); the `/audit` browsing UI (the registry's reserved `audit` resource) is a future feature.
