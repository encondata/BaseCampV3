// @vitest-environment jsdom
/**
 * Move Dashboard (/dashboards/move) — narrow coverage: just the summary
 * strip's scheduled window, which is where the date-only off-by-one lived
 * (see lib/timeline.ts's parseApiDay). The roster table, filters, and
 * refresh cadence are exercised in the browser/manually.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { InitiativeItem, UiPreferences } from '../lib/api';

const auth = vi.hoisted(() => ({
  can: (_resource: string, _action?: string) => true,
}));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    godMode: false,
    // usePersistentListState (the roster table's column/sort/filter
    // persistence) reads preferences.list_prefs unconditionally — an
    // empty object is enough since this file never exercises the table.
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
      motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: true, sound: 'chime' },
      list_prefs: {},
    } as unknown as UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(),
  listInitiativeAssets: vi.fn(),
  listAssetStatuses: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const { default: MoveDashboard } = await import('./MoveDashboard');

const move = (over: Partial<InitiativeItem> = {}): InitiativeItem => ({
  id: 'm1', name: 'Denver → Austin', description: null,
  initiative_type: 'move', type_label: 'Move', type_color: '#1668a7',
  sub_type: null, sub_type_label: null, sub_type_color: null,
  status: 'in_progress', status_label: 'In Progress', status_color: '#1668a7',
  color: null,
  client_id: null, client_name: null,
  site_id: null, site_name: null, location: null,
  scheduled_start: '2026-09-01', scheduled_end: '2026-09-15',
  sky_command_project_id: null,
  origin_site_id: null, origin_site_name: 'DC1',
  destination_site_id: null, destination_site_name: 'DC2',
  real_start_at: null, real_end_at: null,
  priority_devices: null, shipping_types: [],
  shipping_partner_id: null, shipping_partner_name: null,
  origin_tech_partner_id: null, origin_cable_partner_id: null,
  origin_logistics_partner_id: null,
  destination_tech_partner_id: null, destination_cable_partner_id: null,
  destination_logistics_partner_id: null,
  origin_vendor_involved: null, destination_vendor_involved: null,
  people_count: 0, links_count: 0,
  archived_at: null, created_at: '2026-01-01T00:00:00Z',
  ...over,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.can = () => true;
});

it("renders the move's scheduled window without shifting it west of UTC", async () => {
  // scheduled_start/scheduled_end are date-only fields, stored as
  // midnight UTC for a plain YYYY-MM-DD input. vitest inherits whatever
  // TZ the shell has, so pin a west-of-UTC zone here — on a UTC host a
  // bare `new Date(iso)` bug and the parseApiDay fix would agree,
  // proving nothing.
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  api.listInitiatives.mockResolvedValue([move()]);
  api.listInitiativeAssets.mockResolvedValue([]);
  api.listAssetStatuses.mockResolvedValue([]);
  try {
    render(<MemoryRouter><MoveDashboard /></MemoryRouter>);
    expect(await screen.findByText(/Sep 1, 2026/)).toBeTruthy();
    expect(await screen.findByText(/Sep 15, 2026/)).toBeTruthy();
    expect(screen.queryByText(/Aug 31, 2026/)).toBeNull();
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

it('renders a dash for a move with no scheduled dates', async () => {
  api.listInitiatives.mockResolvedValue([move({ scheduled_start: null, scheduled_end: null })]);
  api.listInitiativeAssets.mockResolvedValue([]);
  api.listAssetStatuses.mockResolvedValue([]);
  render(<MemoryRouter><MoveDashboard /></MemoryRouter>);
  expect(await screen.findByText('— → —')).toBeTruthy();
});
