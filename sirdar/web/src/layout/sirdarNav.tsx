import type { NavSection } from '@portal/layout/navSections';

const icon = (d: string) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
);

const I = {
  dash: icon('M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z'),
  users: icon('M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'),
  shield: icon('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'),
  log: icon('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8'),
  gear: icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'),
};

export const SIRDAR_NAV: NavSection[] = [
  { label: 'Dashboard', icon: I.dash, items: [
    { to: '/', label: 'Dashboard', resource: 'dashboard', icon: I.dash, end: true },
  ] },
  { label: 'Administration', icon: I.shield, items: [
    { to: '/admin/users', label: 'Users', resource: 'users', icon: I.users },
    { to: '/admin/access', label: 'Roles & access', resource: 'access', icon: I.shield },
    { to: '/admin/audit', label: 'Audit log', resource: 'audit', icon: I.log },
  ] },
  { label: 'System', icon: I.gear, items: [
    { to: '/settings', label: 'Settings', resource: 'settings', icon: I.gear },
  ] },
];

export const PAGE_TITLES: Record<string, string> = {
  '/': 'Dashboard',
  '/admin/users': 'Users',
  '/admin/access': 'Roles & access',
  '/admin/audit': 'Audit log',
  '/settings': 'Settings',
  '/me': 'My profile & preferences',
};

export function visibleSections(can: (resource: string, action: 'view') => boolean): NavSection[] {
  return SIRDAR_NAV
    .map((s) => ({ ...s, items: s.items.filter((i) => can(i.resource, 'view')) }))
    .filter((s) => s.items.length > 0);
}
