// @vitest-environment jsdom
/**
 * Home (/) — mostly covers the client-anchored redirect; the rest of the
 * page's panels are exercised in the browser/manually. The flight board's
 * date window is the one exception, added alongside the date-only
 * off-by-one fix in windowLines (see lib/timeline.ts's parseApiDay).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { ScopeInfo } from '../lib/access';
import type { InitiativeItem } from '../lib/api';

const auth = vi.hoisted(() => {
  const state: {
    can: (resource: string, action?: string) => boolean;
    mustChangePassword: boolean;
    scope: ScopeInfo | null;
  } = {
    can: () => false,
    mustChangePassword: false,
    scope: null,
  };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    mustChangePassword: auth.mustChangePassword,
    scope: auth.scope,
  }),
}));

const api = vi.hoisted(() => ({
  listAssets: vi.fn(() => new Promise(() => {})),
  listAssetStatuses: vi.fn(() => new Promise(() => {})),
  listAuditLog: vi.fn(() => new Promise(() => {})),
  listContainers: vi.fn(() => new Promise(() => {})),
  listInitiativeAssets: vi.fn(() => new Promise(() => {})),
  listInitiatives: vi.fn(() => new Promise(() => {})),
  listProcessedScans: vi.fn(() => new Promise(() => {})),
  listScanDailyStats: vi.fn(() => new Promise(() => {})),
  listSites: vi.fn(() => new Promise(() => {})),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const { default: Home } = await import('./Home');

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  auth.can = () => false;
  auth.mustChangePassword = false;
  auth.scope = null;
});

it('client-anchored users are redirected to the client dashboard', async () => {
  auth.scope = { global: false, client_ids: ['c1'], partner_ids: [] };
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/dashboards/clients" element={<div>CLIENT DASH</div>} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.queryByText('CLIENT DASH')).not.toBeNull());
});

it('global users render Home normally', async () => {
  auth.scope = { global: true, client_ids: [], partner_ids: [] };
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.queryByText('CLIENT DASH')).toBeNull());
});

const boardInitiative = (over: Partial<InitiativeItem> = {}): InitiativeItem => ({
  id: 'i1', name: 'Board Move', description: null,
  initiative_type: 'other', type_label: 'Other', type_color: '#1668a7',
  sub_type: null, sub_type_label: null, sub_type_color: null,
  status: 'planned', status_label: 'Planned', status_color: '#1668a7',
  color: null,
  client_id: null, client_name: null,
  site_id: null, site_name: null, location: null,
  scheduled_start: '2026-09-01', scheduled_end: null,
  sky_command_project_id: null,
  origin_site_id: null, origin_site_name: null,
  destination_site_id: null, destination_site_name: null,
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

it('flight board renders scheduled_start without shifting it west of UTC', async () => {
  // scheduled_start is a date-only field, stored as midnight UTC for a
  // plain YYYY-MM-DD input. vitest inherits whatever TZ the shell has, so
  // pin a west-of-UTC zone here — on a UTC host a bare `new Date(iso)`
  // bug and the parseApiDay fix would agree, proving nothing.
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  auth.scope = { global: true, client_ids: [], partner_ids: [] };
  auth.can = (r: string) => r === 'initiatives';
  api.listInitiatives.mockResolvedValue([boardInitiative()]);
  api.listAssetStatuses.mockResolvedValue([]);
  try {
    render(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<Home />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/Sep 1/)).toBeTruthy();
    expect(screen.queryByText(/Aug 31/)).toBeNull();
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

it("flight board's window covers the unscheduled, from-only, and by-only branches", async () => {
  auth.scope = { global: true, client_ids: [], partner_ids: [] };
  auth.can = (r: string) => r === 'initiatives';
  api.listInitiatives.mockResolvedValue([
    boardInitiative({ id: 'i1', name: 'No dates', scheduled_start: null, scheduled_end: null }),
    boardInitiative({ id: 'i2', name: 'Start only', scheduled_start: '2026-09-01', scheduled_end: null }),
    boardInitiative({ id: 'i3', name: 'End only', scheduled_start: null, scheduled_end: '2026-09-15' }),
  ]);
  api.listAssetStatuses.mockResolvedValue([]);
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<Home />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('No dates');
  expect(screen.getByText('unscheduled')).toBeTruthy();
  expect(screen.getByText(/from Sep 1/)).toBeTruthy();
  expect(screen.getByText(/by Sep 15/)).toBeTruthy();
});
