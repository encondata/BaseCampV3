# Access Control Portal Implementation Plan (2 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the portal to the new permission payload — `can()` gating for nav/routes/buttons, rank-aware admin menus, and the four-tab `/access` admin page (Roles, Groups, Members, Explorer).

**Architecture:** `AuthContext` stores the `perms`/`max_rank`/`scope` payload from login/refresh and exposes `can(resource, action)`. Nav items, routes, and mutating controls consult `can()` (UI mirror only — the server is authoritative). The Access page is one route with four tab components sharing a `matrixTable`-style cell component with three modes (role-checkbox / override-tristate / effective-readonly).

**Tech Stack:** React 19 + TypeScript + Vite, react-router-dom, vitest (added here for pure-helper tests), shared `listTools.tsx` toolbar, shared `ComboBox` (type-to-filter — standing rule).

**Spec:** `docs/superpowers/specs/2026-07-14-access-control-design.md` §7–§8. Prerequisite: the API plan (`2026-07-14-access-control-api.md`) is complete — `/access/*` endpoints live, session payload carries `perms`/`max_rank`/`scope`, `UserItem` carries `max_rank`.

## Global Constraints

- Same branch `feature/access-control`.
- Verification loop: `cd portal && npm run build` must pass (tsc strict) after every task; vitest (`npm test`) for pure helpers; final task verifies flows in the browser via the dev server.
- Every record-backed dropdown uses the shared type-to-filter `ComboBox` (standing rule). The Members list gets the shared Filters/Columns/Export toolbar from `portal/src/lib/listTools.tsx` (standing rule).
- Never seed dev-DB records to demo features (standing rule).
- The UI must never OFFER an action the server will 403: hide/disable controls whose `can()` is false and person-targets whose `max_rank >=` viewer's (rank-100 viewers may target rank-100).
- `/access` is never hidden from global-anchor users (`access.view` is floored on server-side); non-editors see a read-only banner and disabled controls.
- Styling: follow existing page/panel/chip patterns in `portal/src/styles/` and existing pages (Users.tsx is the closest reference); matrices live in `overflow-x:auto` wrappers.

---

### Task 1: vitest + access types + `can()` in AuthContext

**Files:**
- Modify: `portal/package.json` (add vitest, script `"test": "vitest run"`)
- Create: `portal/src/lib/access.ts`
- Modify: `portal/src/lib/api.ts` (SessionData/MeOut types gain `perms`, `max_rank`, `scope`)
- Modify: `portal/src/auth/AuthContext.tsx`
- Test: `portal/src/lib/access.test.ts`

**Interfaces:**
- Produces in `lib/access.ts`:
  ```ts
  export type Action = 'view' | 'add' | 'change' | 'delete';
  export type PermMap = Record<string, Record<Action, boolean>>;
  export interface ScopeInfo { global: boolean; client_ids: string[]; partner_ids: string[] }
  export const ACTIONS: Action[];
  export const ROUTE_RESOURCE: Record<string, string>;   // mirrors api registry routes
  export function computeCan(perms: PermMap | null, resource: string, action: Action): boolean;
  export function canTouchRank(actorRank: number, targetRank: number): boolean;
  export const RANK_LABELS: [number, string][];           // [[100,'Top'],[80,'Super admin'],…] for badges
  ```
- Produces on `useAuth()`: `can(resource, action)`, `maxRank: number`, `scope: ScopeInfo | null`.

- [ ] **Step 1: Add vitest**

```bash
cd portal && npm install -D vitest
```

Add to `portal/package.json` scripts: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing test**

```ts
// portal/src/lib/access.test.ts
import { describe, expect, it } from 'vitest';
import { ACTIONS, ROUTE_RESOURCE, canTouchRank, computeCan, type PermMap } from './access';

const perms: PermMap = {
  workers: { view: true, add: true, change: true, delete: false },
  access: { view: true, add: false, change: false, delete: false },
};

describe('computeCan', () => {
  it('reads the matrix', () => {
    expect(computeCan(perms, 'workers', 'change')).toBe(true);
    expect(computeCan(perms, 'workers', 'delete')).toBe(false);
  });
  it('defaults false for unknown resource or null perms', () => {
    expect(computeCan(perms, 'devtools', 'view')).toBe(false);
    expect(computeCan(null, 'workers', 'view')).toBe(false);
  });
});

describe('canTouchRank', () => {
  it('strictly below, top rank manages peers', () => {
    expect(canTouchRank(100, 100)).toBe(true);
    expect(canTouchRank(80, 60)).toBe(true);
    expect(canTouchRank(60, 60)).toBe(false);
    expect(canTouchRank(40, 60)).toBe(false);
  });
});

describe('route map', () => {
  it('mirrors the api registry', () => {
    expect(ROUTE_RESOURCE['/people/workers']).toBe('workers');
    expect(ROUTE_RESOURCE['/access']).toBe('access');
    expect(ROUTE_RESOURCE['/']).toBe('dashboard');
    expect(ACTIONS).toEqual(['view', 'add', 'change', 'delete']);
  });
});
```

- [ ] **Step 3: Run to verify FAIL** — `cd portal && npm test` (module not found).

- [ ] **Step 4: Implement `lib/access.ts`**

```ts
// portal/src/lib/access.ts
/** Client-side mirror of the API's access model. The server is always the
 *  authority — these helpers only decide what the UI offers. */

export type Action = 'view' | 'add' | 'change' | 'delete';
export type PermMap = Record<string, Record<Action, boolean>>;
export interface ScopeInfo { global: boolean; client_ids: string[]; partner_ids: string[] }

export const ACTIONS: Action[] = ['view', 'add', 'change', 'delete'];

/** Mirrors api/src/serversherpa/access/resources.py routes. */
export const ROUTE_RESOURCE: Record<string, string> = {
  '/': 'dashboard',
  '/people/users': 'users',
  '/people/workers': 'workers',
  '/stakeholders/clients': 'clients',
  '/stakeholders/partners': 'partners',
  '/settings': 'settings',
  '/access': 'access',
  '/audit': 'audit',
};

export function computeCan(
  perms: PermMap | null, resource: string, action: Action,
): boolean {
  return perms?.[resource]?.[action] === true;
}

/** Strictly-below management; top rank (100) may also manage peers. */
export function canTouchRank(actorRank: number, targetRank: number): boolean {
  return actorRank >= 100 || targetRank < actorRank;
}

export const RANK_LABELS: [number, string][] = [
  [100, 'Top'], [80, 'Super admin'], [60, 'Admin'], [40, 'Staff'],
  [30, 'Org owner'], [20, 'Org admin'], [10, 'Org viewer'], [5, 'External'],
];
```

- [ ] **Step 5: Extend api.ts types + AuthContext**

In `portal/src/lib/api.ts` — `SessionData` (and the `/auth/me` shape) gain:

```ts
  perms: import('./access').PermMap;
  max_rank: number;
  scope: import('./access').ScopeInfo;
```

In `portal/src/auth/AuthContext.tsx`:
- `AuthState` gains `perms: PermMap | null; maxRank: number; scope: ScopeInfo | null;` (ANON: `perms: null, maxRank: 0, scope: null`); `stateFrom` maps `data.perms / data.max_rank / data.scope`.
- Context value gains:

```ts
  const can = useCallback(
    (resource: string, action: Action = 'view') =>
      computeCan(state.perms, resource, action),
    [state.perms],
  );
```

and exposes `can`, `maxRank: state.maxRank`, `scope: state.scope` alongside the existing members (keep `hasRole`).

- [ ] **Step 6: Verify** — `cd portal && npm test && npm run build` — both green.

- [ ] **Step 7: Commit**

```bash
git add portal/package.json portal/package-lock.json portal/src/lib/access.ts portal/src/lib/access.test.ts portal/src/lib/api.ts portal/src/auth/AuthContext.tsx
git commit -m "feat(portal): perms payload, can() hook, vitest"
```

---

### Task 2: Nav, route, and palette gating + /access route stub

**Files:**
- Modify: `portal/src/layout/AppShell.tsx` (NAV_SECTIONS resource gating + Access item)
- Modify: `portal/src/components/ProtectedRoute.tsx` (`resource` prop + NoAccess state)
- Modify: `portal/src/App.tsx` (add `/access` route, per-route resources)
- Modify: `portal/src/components/CommandPalette.tsx` (perm-gated commands)
- Create: `portal/src/pages/Access.tsx` (stub page: head + placeholder)

**Interfaces:**
- `NavItem` gains `resource: string`; items render only when `can(resource, 'view')`; empty sections don't render.
- `ProtectedRoute` accepts `resource?: string`; when set and `can(resource,'view')` is false, renders the inline `NoAccess` panel ("You don't have access to this page") instead of children.

- [ ] **Step 1: AppShell**

Each `NAV_SECTIONS` item gains its resource: Dashboard→`dashboard`, Users→`users`, Workers→`workers`, Clients→`clients`, Partners→`partners`, Settings→`settings`. Add to the System section (before Settings):

```tsx
      {
        to: '/access',
        label: 'Access control',
        resource: 'access',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        ),
      },
```

In the component body:

```tsx
  const { person, roles, logout, preferences, can } = useAuth();
  const visibleSections = NAV_SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((i) => can(i.resource, 'view')) }))
    .filter((s) => s.items.length > 0);
```

and render `visibleSections` instead of `NAV_SECTIONS` (also in `sectionForPath` — pass the filtered list).

- [ ] **Step 2: ProtectedRoute + App routes**

```tsx
// ProtectedRoute.tsx — new signature and gate
export default function ProtectedRoute({
  children, resource,
}: { children: ReactNode; resource?: string }) {
  const { status, mustChangePassword, can } = useAuth();
  // …existing loading/anon/mustChange logic unchanged…
  if (resource && !can(resource, 'view')) {
    return (
      <div className="page">
        <div className="panel no-access">
          <h2>No access</h2>
          <p>You don't have permission to view this page.</p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
```

In `App.tsx`, the shell route stays one `ProtectedRoute` (auth only); per-page gating wraps each element:

```tsx
<Route path="/access" element={<ProtectedRoute resource="access"><Access /></ProtectedRoute>} />
```

Apply the same `resource` wrapper to the existing routes (`/people/users`→users, `/people/workers`→workers, `/stakeholders/clients`→clients, `/stakeholders/partners`→partners, `/settings`→settings). Simpler alternative if the current tree wraps once at the layout level: add a small `<Gate resource>` component inside each page route — either is fine, keep it consistent.

- [ ] **Step 3: CommandPalette**

Replace the `hasRole('admin', 'staff')` block (line 53) with per-resource checks: each nav command is included when `can(resource, 'view')` — Users→users, Workers→workers, Clients→clients, Partners→partners, Access control→access (navigates `/access`), Settings→settings.

- [ ] **Step 4: Stub page**

```tsx
// portal/src/pages/Access.tsx
export default function Access() {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Access control</h1>
        <p>Roles, groups, member permissions and effective access.</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Verify** — `npm run build`; then start the dev server and confirm: staff login shows Access nav item (access:view floored), Settings page visible, and direct-nav to a blocked route shows the No-access panel.

- [ ] **Step 6: Commit**

```bash
git add portal/src/layout/AppShell.tsx portal/src/components/ProtectedRoute.tsx portal/src/App.tsx portal/src/components/CommandPalette.tsx portal/src/pages/Access.tsx
git commit -m "feat(portal): permission-gated nav, routes, palette + /access stub"
```

---

### Task 3: Access API client functions

**Files:**
- Modify: `portal/src/lib/api.ts` (append access section)

**Interfaces (all use the existing `apiFetch` helper and error conventions):**

```ts
export interface AccessRole {
  name: string; label: string; color: string | null; description: string;
  rank: number; scope_anchor: 'global' | 'client' | 'partner' | 'self';
  is_system: boolean; member_count: number;
  matrix: Record<string, Record<Action, boolean>>;
}
export interface AccessGroupOut {
  id: string; name: string; description: string; icon: string;
  member_count: number;
  members: { person_id: string; display_name: string; avatar_url: string | null }[];
}
export interface AccessResourceOut {
  id: string; label: string; developer_only: boolean;
  always_viewable: boolean; gated_by: string[];
}
export interface AccessSummary {
  stats: { members: number; roles: number; groups: number;
           gated_resources: number; overrides: number };
  resources: AccessResourceOut[];
  roles: AccessRole[];
  groups: AccessGroupOut[];
}
export interface EffectiveCell { value: boolean; source: 'role' | 'override' | 'gate' | 'hard_gate' | 'floor' }
export interface EffectiveOut {
  person_id: string; display_name: string; roles: string[]; max_rank: number;
  groups: { id: string; name: string }[];
  scope: ScopeInfo;
  cells: Record<string, Record<Action, EffectiveCell>>;
}

export async function getAccessSummary(): Promise<AccessSummary>;
export async function putRoleMatrix(name: string, matrix: Record<string, Record<Action, boolean>>): Promise<void>;
export async function cloneRole(body: { source: string; name: string; label: string; rank: number }): Promise<void>;
export async function deleteRole(name: string): Promise<void>;
export async function createAccessGroup(body: { name: string; description?: string; icon?: string }): Promise<{ id: string }>;
export async function deleteAccessGroup(id: string): Promise<void>;
export async function setGroupMembers(id: string, personIds: string[]): Promise<void>;
export async function setResourceGates(resource: string, groupIds: string[]): Promise<void>;
export async function getOverrides(personId: string): Promise<{ overrides: Record<string, Record<Action, boolean>> }>;
export async function putOverrides(personId: string, overrides: Record<string, Record<Action, boolean | null>>): Promise<void>;
export async function getEffective(personId: string): Promise<EffectiveOut>;
```

- [ ] **Step 1: Implement** — follow the exact fetch/JSON/error pattern of the existing `setUserRoles` function at `portal/src/lib/api.ts:329` for each of the functions above (method/URL per the API plan Task 7–10 routes: `GET /access/summary`, `PUT /access/roles/{name}/matrix` body `{matrix}`, `POST /access/roles`, `DELETE /access/roles/{name}`, `POST /access/groups`, `DELETE /access/groups/{id}`, `PUT /access/groups/{id}/members` body `{person_ids}`, `PUT /access/resources/{resource}/gates` body `{group_ids}`, `GET|PUT /access/overrides/{personId}` body `{overrides}`, `GET /access/effective/{personId}`).

- [ ] **Step 2: Verify** — `npm run build`.

- [ ] **Step 3: Commit**

```bash
git add portal/src/lib/api.ts
git commit -m "feat(portal): access API client"
```

---

### Task 4: Access page frame + matrix cell component

**Files:**
- Modify: `portal/src/pages/Access.tsx` (real frame)
- Create: `portal/src/components/access/MatrixTable.tsx`
- Create: `portal/src/styles/access.css` (import from Access.tsx)

**Interfaces:**
- `MatrixTable` props:
  ```ts
  type CellMode = 'role' | 'override' | 'effective';
  interface MatrixTableProps {
    mode: CellMode;
    resources: AccessResourceOut[];
    // role mode: current grants; effective mode: EffectiveOut.cells;
    // override mode: overrides (sparse) + inherited effective for ghosting
    matrix?: Record<string, Record<Action, boolean>>;
    cells?: Record<string, Record<Action, EffectiveCell>>;
    overrides?: Record<string, Partial<Record<Action, boolean>>>;
    inherited?: Record<string, Record<Action, boolean>>;
    editable: boolean;
    lockedResources?: Set<string>;      // developer_only rows (padlock)
    lockedCells?: Set<string>;          // "access:view"
    onToggle?: (resource: string, action: Action) => void;         // role mode
    onCycle?: (resource: string, action: Action) => void;          // override mode: inherit→allow→deny→inherit
    onToggleColumn?: (action: Action) => void;                     // header toggle-all
  }
  ```
- Access page state: `tab: 'roles' | 'groups' | 'members' | 'explorer'`; loads `getAccessSummary()` on mount; `canEdit = can('access', 'change')`.

- [ ] **Step 1: Build the frame**

Page head ("Access control" + blurb). If `!canEdit`, render an amber chip `Read-only · admin required to edit` in the page actions. Stat strip of four tiles from `summary.stats` (Members / Roles / Groups — "gates N pages" / Overrides). Pill tab bar (four buttons, active filled — reuse `.subs-tabs`-style classes in `access.css`). Tab content renders the components from Tasks 5–8 (render placeholders `<div />` until those tasks land, keeping the build green).

- [ ] **Step 2: Build MatrixTable**

One `<table class="pm-table">` inside `<div class="pm-scroll">` (`overflow-x:auto`): rows = `resources` (label left), columns = ACTIONS (mono uppercase headers; when `editable && onToggleColumn`, a small toggle-all button in each header). Cell rendering by mode:
- `role`: checkbox button `.pm-chk`, `.on` when granted; disabled when `!editable` or resource in `lockedResources` or `${res}:${action}` in `lockedCells` (locked cells show a padlock glyph).
- `override`: `.pm-tri` cycling inherit (ghosted — shows inherited value dimmed) → allow (filled check) → deny (red ✗); title tooltip `"{state} (effective: {allowed|denied})"`.
- `effective`: read-only `.pm-eff` — `.yes` green check / `.no` dim ✗; add `.ov` (violet ring) when `cells[res][a].source === 'override'`; padlock when source `hard_gate`.

`access.css` supplies `.pm-scroll .pm-table .pm-chk .pm-tri .pm-eff .ov .subs-tabs .stat-strip .role-card .grp-card` styles consistent with the existing token variables in `portal-theme.css`.

- [ ] **Step 3: Verify** — `npm run build`; dev server: page renders stats + empty tabs.

- [ ] **Step 4: Commit**

```bash
git add portal/src/pages/Access.tsx portal/src/components/access/MatrixTable.tsx portal/src/styles/access.css
git commit -m "feat(portal): access page frame + 3-mode matrix component"
```

---

### Task 5: Roles tab

**Files:**
- Create: `portal/src/components/access/RolesTab.tsx`

**Interfaces:**
- Props: `{ summary: AccessSummary; canEdit: boolean; maxRank: number; onChanged: () => void }` (`onChanged` = refetch summary).

- [ ] **Step 1: Implement**

- **Role selector (design change 2026-07-14, replaces the card grid):** a shared type-to-filter `ComboBox` over `summary.roles` (option row: role label on the left, member count on the right — e.g. "Administrator · 3 users". NO rank number and NO raw role key in the option row; rank/anchor stay in the details panel below). Below it, a **details header panel** for the selected role: label, description, member count, rank badge (`RANK_LABELS`), scope-anchor chip, `system` marker chip when `is_system`. No card grid — the user found cards cluttered. Default selection: highest-rank role the viewer may inspect.
- **Matrix panel** for the selected role: `MatrixTable mode="role"` with `matrix={role.matrix}`, `editable={canEdit && canTouchRank(maxRank, role.rank)}`, `lockedResources={new Set(summary.resources.filter(r => r.developer_only && role.name !== 'developer').map(r => r.id))}`, `lockedCells={new Set(['access:view'])}`.
- Local edit state: copy the matrix on select; `onToggle` flips a cell, `onToggleColumn` sets the whole column to the majority-inverse; a Save bar (Save / Discard) appears when dirty → `putRoleMatrix(role.name, matrix)` then `onChanged()`. Surface API error codes as toasts (`rank_too_low`, `developer_only_resource`, `access_view_locked`).
- **Clone role** button (canEdit): small modal — source = selected role, name (slug field), label, rank (number input capped `< maxRank`, or ≤100 for rank-100 viewers) → `cloneRole(...)` → `onChanged()`. **Delete** button on selected custom roles (`!is_system`) → confirm → `deleteRole(name)` (surface `role_in_use` as a toast).

- [ ] **Step 2: Verify** — `npm run build`; in the browser as an admin: staff matrix editable, admin/super_admin matrices read-only (rank), devtools row padlocked, access:view locked on, clone + delete round-trip works.

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/access/RolesTab.tsx portal/src/pages/Access.tsx
git commit -m "feat(portal): roles tab — cards, editable matrix, clone/delete"
```

---

### Task 6: Groups tab

**Files:**
- Create: `portal/src/components/access/GroupsTab.tsx`

**Interfaces:**
- Props: `{ summary: AccessSummary; canEdit: boolean; onChanged: () => void }`.
- Consumes the users list for member picking: `listUsers()` from `lib/api.ts` (existing) through the shared `ComboBox`.

- [ ] **Step 1: Implement**

- **Group selector (design change 2026-07-14, replaces the card grid):** a shared type-to-filter `ComboBox` over groups. Below it, a **details panel** for the selected group: icon, name, description, `N members · gates P pages` (count from `summary.resources[].gated_by`), avatar stack (up to 6 `.av-sm` + `+N`), and the member list with manage controls inline (no separate modal needed unless it stays simpler). A `+ New group` button (canEdit) next to the ComboBox → name/description/icon → `createAccessGroup`.
- **Manage modal**: member list with remove buttons + a `ComboBox` (type-to-filter over `listUsers()`, excluding current members) to add → builds the full id list → `setGroupMembers(id, ids)`; `rank_too_low` surfaces as a toast. Delete-group button with confirm → `deleteAccessGroup`.
- **Page access panel**: one row per `summary.resources` (skip `access`/`devtools` — not gateable): gated → violet chip per gating group name; open → green `● Open to all` chip; `Manage` (canEdit) opens a group-multi-select modal → `setResourceGates(resource, groupIds)`. Header chip `R restricted · O open`.

- [ ] **Step 2: Verify** — `npm run build`; browser: create group, add member, gate `clients` to it, confirm a non-member staff login loses Clients from nav (payload refresh on next login/refresh), un-gate.

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/access/GroupsTab.tsx portal/src/pages/Access.tsx
git commit -m "feat(portal): groups tab — cards, membership, resource gating"
```

---

### Task 7: Members tab + override editor

**Files:**
- Create: `portal/src/components/access/MembersTab.tsx`
- Create: `portal/src/components/access/OverrideEditor.tsx`

**Interfaces:**
- MembersTab props: `{ summary: AccessSummary; canEdit: boolean; maxRank: number; onChanged: () => void }`.
- Data: `listUsers()` (each `UserItem` now has `max_rank` and `roles`); overrides fetched per person on editor open.

- [ ] **Step 1: MembersTab**

List of users holding any role. Columns: Member (avatar + name), Roles (chips), Rank (badge), Org (client/partner names for anchored grants — from the user item roles; show `—` for global), Role dropdown, Overrides button (+ count chip when > 0 — fetch counts lazily or include in a follow-up; acceptable v1: show the button without count until opened).

- **Toolbar (standing rule):** wire the shared Filters / Columns / Export from `portal/src/lib/listTools.tsx` exactly as `Users.tsx` does — filters: role (multi), rank band, has-overrides; all columns toggleable; CSV export of the visible set.
- **Role dropdown**: options = `summary.roles` filtered to `canTouchRank(maxRank, role.rank)` and non-anchored (`scope_anchor === 'global'`) roles (org-anchored grants are managed from the org's contacts page); disabled when `!canEdit || !canTouchRank(maxRank, user.max_rank)`. Change → existing `setUserRoles(personId, roles)` client fn (replace the person's global-anchor roles with the selection, preserving their org-anchored grants untouched — compute from `user.roles` minus known global names) → `onChanged()`.
- Self-row shows a `you` tag; its controls are disabled (no self-targeting).

- [ ] **Step 2: OverrideEditor**

Modal/drawer per member: loads `getOverrides(personId)` + `getEffective(personId)` (for ghosted inherited values), renders `MatrixTable mode="override"` with `overrides`, `inherited` (from effective cells' values where source ≠ override), `editable={canEdit && canTouchRank(maxRank, member.max_rank)}`, `lockedResources` = developer_only resources. `onCycle` mutates local sparse state (inherit→allow→deny→inherit; inherit = delete key). Save → `putOverrides(personId, overrides)` (null for cleared cells) → close + `onChanged()`.

- [ ] **Step 3: Verify** — `npm run build`; browser: filter list, change a staff member's role, set an override (deny workers:delete), reopen editor and confirm tri-state ghosting, clear back to inherit.

- [ ] **Step 4: Commit**

```bash
git add portal/src/components/access/MembersTab.tsx portal/src/components/access/OverrideEditor.tsx portal/src/pages/Access.tsx
git commit -m "feat(portal): members tab — toolbar, role dropdown, tri-state overrides"
```

---

### Task 8: Explorer tab

**Files:**
- Create: `portal/src/components/access/ExplorerTab.tsx`

**Interfaces:**
- Props: `{ summary: AccessSummary; canEdit: boolean; maxRank: number; selfId: string }`.

- [ ] **Step 1: Implement**

- Person picker: shared `ComboBox` over `listUsers()`; for viewers with `maxRank < 60`, lock the picker to self (server enforces `not_your_record` anyway). Default = self.
- On selection → `getEffective(personId)` → header card (avatar, name, roles chips, `N of M permissions` computed from cells), group chips (or "Not in any access group"), scope summary line: `global` → "Sees: everything"; client/partner ids → "Sees: {org names} only" (resolve names from the clients/partners list endpoints already in `lib/api.ts`); self → "Sees: own records only".
- Effective matrix: `MatrixTable mode="effective"` with `cells` — violet ring on override-sourced cells, padlock on hard-gated rows.

- [ ] **Step 2: Verify** — `npm run build`; browser: explore self as staff; as admin explore a member with an override and confirm the violet ring cell matches the override.

- [ ] **Step 3: Commit**

```bash
git add portal/src/components/access/ExplorerTab.tsx portal/src/pages/Access.tsx
git commit -m "feat(portal): explorer tab — effective permissions with sources"
```

---

### Task 9: Migrate remaining `hasRole` gates + rank-aware menus

**Files:**
- Modify: `portal/src/pages/Users.tsx`
- Modify: `portal/src/pages/Workers.tsx`
- Modify: `portal/src/pages/OrgDirectory.tsx`
- Modify: `portal/src/pages/Settings.tsx`
- Modify: `portal/src/components/UserAdminModals.tsx`

**Interfaces:** consumes `can`, `maxRank` from `useAuth()`, `canTouchRank` from `lib/access.ts`. `hasRole` remains ONLY for identity-flavored logic (e.g. worker self widgets on Profile), not for gates.

- [ ] **Step 1: Exact call-site conversions**

- `Workers.tsx:233` — `const canManage = hasRole('admin', 'staff')` → `const canManage = can('workers', 'change')`; cert-add controls check `can('workers','add')`, cert-remove `can('workers','delete')`.
- `OrgDirectory.tsx:299` — `hasRole('admin','staff')` → `can(kind === 'clients' ? 'clients' : 'partners', 'change')` (the page already knows which org type it renders).
- `Settings.tsx:168` — `hasRole('admin')` → `can('settings', 'change')`.
- `Users.tsx:465` — the current admin-target check `(hasRole('admin') || !u.roles.includes('admin'))` → `canTouchRank(maxRank, u.max_rank)`; row action menus (reset password, disable, enable, unlock, edit profile, set roles) additionally require `can('users','change')` (roles editor: `can('access','change')`).
- `UserAdminModals.tsx:257` — `const actorIsAdmin = hasRole('admin')` → take a `targetMaxRank: number` prop from the row and compute `const actorCanTouch = canTouchRank(maxRank, targetMaxRank)`; the roles checklist offers only roles with `rank < maxRank` (or ≤100 at top rank) — fetch role ranks from `getAccessSummary()` roles (pass down or fetch once).
- `CommandPalette.tsx` was converted in Task 2 — confirm no `hasRole` remains there.

- [ ] **Step 2: Verify sweep**

```bash
cd portal && grep -rn "hasRole" src --include="*.tsx" --include="*.ts"
```

Expected remaining: `AuthContext.tsx` (definition) and identity-flavored uses only (document each survivor in the commit message). Then `npm run build && npm test`.

- [ ] **Step 3: Full browser verification (spec §10-equivalent)**

Dev server + real logins (no seeded demo records — use existing dev accounts):
1. Admin: sees all nav; Access page fully editable except super_admin/founder/developer matrices (rank) and devtools padlocks.
2. Staff: Access page read-only banner; no Settings-edit controls; Users page role dropdowns hidden for admin+ targets.
3. Confirm a 403 path end-to-end: as staff, attempt a settings save via UI (control should be absent/disabled — then via curl confirm the API 403s, proving server authority).

- [ ] **Step 4: Commit**

```bash
git add portal/src
git commit -m "feat(portal): migrate hasRole gates to can()/rank-aware controls"
```

---

## Completion

Both plans done = spec fully implemented except the explicitly deferred items (view-as, org self-service, audit viewer page, per-record ACLs). Finish with the superpowers:finishing-a-development-branch skill: full API suite + portal build/test green, then merge `feature/access-control` to `main`.
