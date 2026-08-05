/**
 * The pages the topbar's global search can offer, and the permission gate over
 * them. Search must not name a page the user cannot open: the nav and the ⌘K
 * palette both hide those, so listing them here would leak the portal's shape
 * to anyone who types a letter.
 *
 * Kept out of Topbar.tsx so a bare node test can import it — Topbar pulls in
 * lib/api, which reads `window` at module scope. Same reason NAV_SECTIONS sits
 * in layout/navSections.tsx rather than in AppShell.tsx.
 */

import { isNavItemVisible } from './godmode';

export interface SearchPage {
  label: string;
  to: string;
  /** The resource whose `view` permission opens this page — mirroring the
   *  `resource=` prop on its <ProtectedRoute> in App.tsx, which is the real
   *  binding (lib/access.ts's ROUTE_RESOURCE map is test-only). `null` only
   *  for a route with no <ProtectedRoute> at all; it is required, and
   *  nullable rather than optional, so a new page cannot be added here
   *  without deciding what guards it. */
  resource: string | null;
  godOnly?: boolean;
}

export const SEARCH_PAGES: SearchPage[] = [
  { label: 'Dashboard', to: '/', resource: 'dashboard' },
  { label: 'Users', to: '/people/users', resource: 'users' },
  { label: 'Workers', to: '/people/workers', resource: 'workers' },
  { label: 'Clients', to: '/stakeholders/clients', resource: 'clients' },
  { label: 'Partners', to: '/stakeholders/partners', resource: 'partners' },
  { label: 'Settings', to: '/settings', resource: 'settings' },
  // /me is the one route App.tsx mounts without a <ProtectedRoute>: every
  // signed-in user has a profile.
  { label: 'My profile', to: '/me', resource: null },
  // The godOnly pages (/dev, /dev/database/variables) are deliberately absent.
  // Adding one means giving it `godOnly: true` so the gate below keeps it
  // hidden until god mode is unlocked — see the god-mode design spec.
];

/** Pages matching `needle` that this user may actually open. Gate first, match
 *  second: a page the user cannot view is not a search result at any query. */
export function searchPages(
  needle: string,
  can: (resource: string, action: 'view') => boolean,
  godMode: boolean,
): SearchPage[] {
  const q = needle.trim().toLowerCase();
  if (!q) return [];
  return SEARCH_PAGES
    .filter((p) => p.resource === null
      || isNavItemVisible({ resource: p.resource, godOnly: p.godOnly }, can, godMode))
    .filter((p) => p.label.toLowerCase().includes(q));
}
