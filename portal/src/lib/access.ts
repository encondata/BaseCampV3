/** Client-side mirror of the API's access model. The server is always the
 *  authority — these helpers only decide what the UI offers. */

export type Action = 'view' | 'add' | 'change' | 'delete';
export type PermMap = Record<string, Record<Action, boolean>>;
export interface ScopeInfo { global: boolean; client_ids: string[]; partner_ids: string[] }

export const ACTIONS: Action[] = ['view', 'add', 'change', 'delete'];

/** Mirrors roles.rank for "admin" (migration 0009) / the server's
 *  GATE_BYPASS_RANK — the minimum rank treated as admin client-side. */
export const ADMIN_RANK = 60;

/** Mirrors api/src/serversherpa/access/resources.py routes. */
export const ROUTE_RESOURCE: Record<string, string> = {
  '/': 'dashboard',
  '/assets': 'assets',
  '/people/users': 'users',
  '/people/workers': 'workers',
  '/people/external': 'users',
  '/sites': 'sites',
  '/initiatives': 'initiatives',
  '/logistics/containers': 'containers',
  '/stakeholders/clients': 'clients',
  '/stakeholders/partners': 'partners',
  '/settings': 'settings',
  '/system/notifications': 'notifications',
  '/access': 'access',
  '/admin/asset-models': 'asset_models',
  '/audit': 'audit',
  '/dev': 'devtools',
  '/dev/database': 'devtools',
  '/dev/database/variables': 'devtools',
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

/** Payload for PUT /users/{id}/roles when changing a member's global role.
 *
 *  The endpoint rejects any client/partner-anchored role name in the
 *  payload outright (`role_requires_org` — those grants are managed by
 *  the org-contact flows) but, server-side, also never revokes them just
 *  because they're absent. So the legal payload is: the newly chosen
 *  global role (if any) plus the member's self-anchored grants; org-
 *  anchored names must be DROPPED, not resent. Unknown-anchor names are
 *  kept (they exist server-side or the person couldn't hold them). */
export function rolesPayloadForGlobalChange(
  currentRoles: string[],
  anchorByRole: Record<string, string | undefined>,
  newGlobalRole: string,
): string[] {
  const kept = currentRoles.filter((r) => {
    const anchor = anchorByRole[r];
    return anchor !== 'global' && anchor !== 'client' && anchor !== 'partner';
  });
  return newGlobalRole ? [newGlobalRole, ...kept] : kept;
}
