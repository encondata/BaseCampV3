/**
 * Nav data — the portal's left-nav sections and their items.
 *
 * Separate from AppShell.tsx so the nav table is importable on its own:
 * it is plain data (plus inline SVG icons) with no hooks, no context, and
 * no API client behind it, which keeps it loadable in a bare node test
 * environment. godmode.test.ts asserts against NAV_SECTIONS directly —
 * notably that the Variables item keeps `godOnly: true`, the only thing
 * hiding it from a developer who has not unlocked god mode.
 */

import { type ReactNode } from 'react';

import { ADMIN_RANK } from '../lib/access';

export interface NavItem { to: string; label: string; resource: string; icon: ReactNode; godOnly?: boolean; minRank?: number; globalOnly?: boolean; end?: boolean }
export interface NavSection { label: string; icon: ReactNode; items: NavItem[] }

export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Dashboards',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19V10M12 19V5M20 19v-6" />
      </svg>
    ),
    items: [
      {
        to: '/',
        label: 'Main Dashboard',
        resource: 'dashboard',
        globalOnly: true,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="9" rx="1.5" />
            <rect x="14" y="3" width="7" height="5" rx="1.5" />
            <rect x="14" y="12" width="7" height="9" rx="1.5" />
            <rect x="3" y="16" width="7" height="5" rx="1.5" />
          </svg>
        ),
      },
      {
        to: '/dashboards/move',
        label: 'Move Dashboard',
        resource: 'dashboard',
        globalOnly: true,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 21V4" />
            <path d="M5 4h13l-3 4 3 4H5" />
          </svg>
        ),
      },
      {
        to: '/dashboards/people',
        label: 'People Dashboard',
        resource: 'dashboard',
        globalOnly: true,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9.5" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        ),
      },
      {
        to: '/dashboards/clients',
        label: 'Client Dashboard',
        resource: 'dashboard',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="20" height="14" rx="2" />
            <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Assets',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 8 12 3 3 8l9 5 9-5z" />
        <path d="M3 8v8l9 5 9-5V8" />
        <path d="M12 13v8" />
      </svg>
    ),
    items: [
      {
        to: '/assets',
        end: true,
        label: 'Assets',
        resource: 'assets',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="6" rx="1.5" />
            <rect x="3" y="14" width="18" height="6" rx="1.5" />
            <path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" />
          </svg>
        ),
      },
      {
        to: '/assets/models',
        label: 'Makes / Models',
        resource: 'asset_models',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 7h16M4 12h16M4 17h10" />
            <circle cx="19" cy="17" r="2.5" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Initiatives',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 22V4" />
        <path d="M4 4h14l-2.5 4L18 12H4" />
      </svg>
    ),
    items: [
      {
        end: true,
        to: '/initiatives',
        label: 'Initiatives',
        resource: 'initiatives',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 21V4" />
            <path d="M5 4h13l-3 4 3 4H5" />
          </svg>
        ),
      },
      {
        to: '/initiatives/timeline',
        label: 'Timeline',
        resource: 'initiatives',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="17" rx="2" />
            <path d="M3 9h18" />
            <path d="M8 3v4M16 3v4" />
            <path d="M7 13h4M7 17h7" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Logistics',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 18V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12h2" />
        <path d="M14 18H9" />
        <path d="M14 10h4.5a1 1 0 0 1 .8.4l2.5 3.3a1 1 0 0 1 .2.6V18h-2" />
        <circle cx="7" cy="18" r="2" />
        <circle cx="17.5" cy="18" r="2" />
      </svg>
    ),
    items: [
      {
        to: '/logistics/containers',
        label: 'Containers',
        resource: 'containers',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 8h18v10H3z" />
            <path d="M3 8l2-4h14l2 4" />
            <path d="M8 12v3M12 12v3M16 12v3" />
          </svg>
        ),
      },
      {
        to: '/logistics/trucks',
        label: 'Trucks / Shipments',
        resource: 'trucks',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 17V7a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v10h2" />
            <path d="M14 17H9" />
            <path d="M14 9h3.5a1 1 0 0 1 .8.4l2.5 3.3a1 1 0 0 1 .2.6V17h-2" />
            <circle cx="7" cy="17" r="2" />
            <circle cx="17" cy="17" r="2" />
          </svg>
        ),
      },
      {
        to: '/logistics/warehouse',
        label: 'Warehouse',
        resource: 'warehouse',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M22 20V8.4a1 1 0 0 0-.6-.9l-9-3.7a1 1 0 0 0-.8 0l-9 3.7a1 1 0 0 0-.6.9V20" />
            <path d="M6 20v-8h12v8" />
            <path d="M6 16h12" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Sites',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 21h18" />
        <path d="M5 21V7l7-4 7 4v14" />
        <path d="M10 21v-6h4v6" />
        <path d="M9 10h.01M15 10h.01M9 14h.01M15 14h.01" />
      </svg>
    ),
    items: [
      {
        end: true,
        to: '/sites',
        label: 'Sites',
        resource: 'sites',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 21s-7-5.5-7-11a7 7 0 1 1 14 0c0 5.5-7 11-7 11z" />
            <circle cx="12" cy="10" r="2.6" />
          </svg>
        ),
      },
      {
        to: '/sites/map',
        label: 'Map',
        resource: 'sites',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="m3 6 6-2 6 2 6-2v14l-6 2-6-2-6 2V6Z" /><path d="M9 4v14M15 6v14" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'People',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
        <circle cx="17.5" cy="9.5" r="2.4" />
        <path d="M14.7 12.6a4.4 4.4 0 0 1 6.1 4.1" />
      </svg>
    ),
    items: [
      {
        to: '/people/users',
        label: 'Users',
        resource: 'users',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9.5" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        ),
      },
      {
        to: '/people/workers',
        label: 'Workers',
        resource: 'workers',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 18a10 10 0 0 1 20 0Z" />
            <path d="M9 9V4.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4.5V9" />
            <path d="M2 18h20" />
          </svg>
        ),
      },
      {
        to: '/people/external',
        label: 'External',
        resource: 'users',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9s1.3-6.4 3.8-9Z" />
          </svg>
        ),
      },
      {
        to: '/people/time',
        label: 'Time Management',
        resource: 'dashboard',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3.5 2" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Stakeholders',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 17 7.5 20.5a2.1 2.1 0 0 1-3-3L8 14" />
        <path d="m14 7 4.9-4.9a2.1 2.1 0 0 1 3 3L17 10l3 3a2.1 2.1 0 0 1-3 3l-6-6-3.5 3.5a2.1 2.1 0 0 1-3-3L9 6 6 3" />
      </svg>
    ),
    items: [
      {
        to: '/stakeholders/clients',
        label: 'Clients',
        resource: 'clients',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="20" height="14" rx="2" />
            <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
          </svg>
        ),
      },
      {
        to: '/stakeholders/partners',
        label: 'Partners',
        resource: 'partners',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 17 7.5 20.5a2.1 2.1 0 0 1-3-3L8 14" />
            <path d="m14 7 4.9-4.9a2.1 2.1 0 0 1 3 3L17 10l3 3a2.1 2.1 0 0 1-3 3l-6-6-3.5 3.5a2.1 2.1 0 0 1-3-3L9 6 6 3" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Labels',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M20.59 13.41 12 22l-9-9 8.59-8.59A2 2 0 0 1 13 4h5a2 2 0 0 1 2 2v5a2 2 0 0 1-.59 1.41z" />
        <circle cx="16.5" cy="7.5" r="1.3" />
      </svg>
    ),
    items: [
      {
        to: '/labels/print',
        label: 'Print Labels',
        resource: 'labels',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9V3h12v6" />
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <rect x="6" y="14" width="12" height="7" rx="1" />
          </svg>
        ),
      },
      {
        to: '/labels/generate',
        label: 'Generate Labels',
        resource: 'labels',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="5" width="13" height="8" rx="1.5" />
            <rect x="8" y="11" width="13" height="8" rx="1.5" />
            <path d="M6 8.5h5M11.5 14.5h5" />
          </svg>
        ),
      },
      {
        to: '/labels/containers',
        label: 'Container Labels',
        resource: 'labels',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="7" width="18" height="13" rx="1.5" />
            <path d="M3 11h18M8 7V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V7" />
          </svg>
        ),
      },
      {
        to: '/labels/templates',
        label: 'Templates',
        resource: 'labels',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M20.59 13.41 12 22l-9-9 8.59-8.59A2 2 0 0 1 13 4h5a2 2 0 0 1 2 2v5a2 2 0 0 1-.59 1.41z" />
            <circle cx="16.5" cy="7.5" r="1.3" />
          </svg>
        ),
      },
      {
        to: '/labels/printers',
        label: 'Printers',
        resource: 'labels',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="7" width="18" height="10" rx="2" />
            <path d="M7 7V4h10v3M8 17v3h8v-3" />
            <path d="M17 11h.01" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Reports',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M8 17V10M12 17V7M16 17v-5" />
      </svg>
    ),
    items: [
      {
        to: '/reports',
        label: 'Reports',
        resource: 'reports',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <path d="M14 3v6h6" />
            <path d="M8 13h8M8 17h5" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Scanning Hardware',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6v12M8 6v12M11 6v12M15 6v12M17.5 6v12M20 6v12" />
      </svg>
    ),
    items: [
      {
        to: '/hardware/fixed-readers',
        label: 'Fixed Readers',
        resource: 'scanning_hardware',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <rect x="4" y="12" width="16" height="7" rx="2" />
            <path d="M8 12V8m8 4V8M6 5c3.5-2.5 8.5-2.5 12 0" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        to: '/hardware/kiosks',
        label: 'Kiosk Devices',
        resource: 'scanning_hardware',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <rect x="4" y="4" width="16" height="12" rx="2" />
            <path d="M12 16v4m-4 0h8" strokeLinecap="round" />
          </svg>
        ),
      },
      {
        to: '/hardware/routers',
        label: 'Routers',
        resource: 'scanning_hardware',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <rect x="3" y="13" width="18" height="6" rx="2" />
            <path d="M7 13V9m0 0c2.8-2 7.2-2 10 0M17 16h.01M14 16h.01" strokeLinecap="round" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Bulk Actions',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="m12 3 8 4.5-8 4.5-8-4.5L12 3Z" />
        <path d="m4 12 8 4.5 8-4.5" />
        <path d="m4 16.5 8 4.5 8-4.5" />
      </svg>
    ),
    items: [
      {
        to: '/bulk',
        label: 'Bulk Actions',
        resource: 'dashboard',
        minRank: ADMIN_RANK,
        end: true,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="6" rx="1.5" />
            <rect x="3" y="14" width="18" height="6" rx="1.5" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Admin',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3Z" />
        <path d="m9.5 12 1.8 1.8L15 10" />
      </svg>
    ),
    items: [
      {
        to: '/admin/audit',
        label: 'Audit log',
        resource: 'audit',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M8 3h8a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
            <path d="M9.5 8h5M9.5 12h5M9.5 16h3" />
          </svg>
        ),
      },
      {
        to: '/admin/scans',
        label: 'Scans',
        resource: 'scans',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2" />
            <path d="M7 12h10" />
          </svg>
        ),
      },
      {
        to: '/admin/status-rules',
        label: 'Status rules',
        resource: 'status_rules',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="M13 2 4.5 13.5H11L9.5 22 19 10h-6.5L13 2Z" strokeLinejoin="round" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'System',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="8" />
        <path d="M12 2v4M12 18v4M2 12h4M18 12h4M4.9 4.9l2.8 2.8M16.3 16.3l2.8 2.8M4.9 19.1l2.8-2.8M16.3 7.7l2.8-2.8" />
      </svg>
    ),
    items: [
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
      {
        to: '/system/processes',
        label: 'Processes',
        resource: 'dashboard',
        minRank: 80,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="4" y="4" width="16" height="16" rx="2" />
            <path d="M9 9h6v6H9z" />
            <path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3" />
          </svg>
        ),
      },
      {
        to: '/system/notifications',
        label: 'Notifications',
        resource: 'notifications',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
        ),
      },
      {
        to: '/settings',
        label: 'System settings',
        resource: 'settings',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Developer',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="m8 16-4-4 4-4M16 8l4 4-4 4M13 5l-2 14" />
      </svg>
    ),
    items: [
      {
        to: '/dev',
        end: true,
        label: 'Developer tools',
        resource: 'devtools',
        godOnly: true,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="m8 16-4-4 4-4M16 8l4 4-4 4M13 5l-2 14" />
          </svg>
        ),
      },
      {
        to: '/dev/system-config',
        label: 'System Config',
        resource: 'devtools',
        godOnly: true,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
            <path d="M1 14h6M9 8h6M17 16h6" />
          </svg>
        ),
      },
      {
        to: '/dev/database',
        end: true,
        label: 'Database',
        resource: 'devtools',
        godOnly: true,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <ellipse cx="12" cy="6" rx="8" ry="3" />
            <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
            <path d="M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
          </svg>
        ),
      },
      {
        to: '/dev/database/variables',
        label: 'Variables',
        resource: 'devtools',
        godOnly: true,
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h16M4 12h16M4 18h10" />
          </svg>
        ),
      },
    ],
  },
];
