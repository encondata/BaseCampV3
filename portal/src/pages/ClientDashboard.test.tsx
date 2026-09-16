// @vitest-environment jsdom
/**
 * /dashboards/clients — the client-facing landing page: a client picker
 * (or a static name for a single-client scoped viewer), an identity band,
 * a KPI strip, that client's initiatives, its asset fleet distribution,
 * and recent scan activity. Refresh idiom mirrors PeopleDashboard (quiet
 * catches, panels never blank on a refetch); per-resource panel gating
 * follows Home.tsx.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ScopeInfo } from '../lib/access';
import type {
  AssetItem, ClientActivityOut, InitiativeItem, OrgRef, StatusValue,
} from '../lib/api';
import type { OrgItem } from '../lib/orgs';

const auth = vi.hoisted(() => {
  const state: {
    can: (resource: string, action?: string) => boolean;
    scope: ScopeInfo | null;
  } = {
    can: () => true,
    scope: { global: true, client_ids: [], partner_ids: [] },
  };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can, scope: auth.scope }),
}));

const api = vi.hoisted(() => ({
  listClients: vi.fn(),
  getOrg: vi.fn(),
  listInitiatives: vi.fn(),
  listInitiativeAssets: vi.fn(),
  listAssets: vi.fn(),
  listAssetStatuses: vi.fn(),
  getClientActivity: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const { default: ClientDashboard } = await import('./ClientDashboard');

const clientRef = (id: string, name: string): OrgRef => ({ id, name });

const org = (over: Partial<OrgItem> = {}): OrgItem => ({
  id: 'c1', name: 'Acme', code: null, partner_types: [], status: 'active',
  tier: 'preferred', service_region: null, phone: null,
  website: 'https://acme.example',
  address_line1: null, address_line2: null, city: 'Denver', region: 'CO',
  postal_code: null, country: 'US', notes: null,
  account_manager: { id: 'm1', display_name: 'Jim Manager' },
  contact_count: 0, logo_url: null, archived_at: null,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const initiative = (over: Partial<InitiativeItem> = {}): InitiativeItem => ({
  id: 'i1', name: 'Acme move', description: null,
  initiative_type: 'move', type_label: 'Move', type_color: '#1668a7',
  sub_type: null, sub_type_label: null, sub_type_color: null,
  status: 'in_progress', status_label: 'In Progress', status_color: '#1668a7',
  color: null,
  client_id: 'c1', client_name: 'Acme',
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

const asset = (over: Partial<AssetItem> = {}): AssetItem => ({
  id: 'a1', legacy_id: 1, serial_number: 'SN1', name: 'core-sw-01', rfid_tag: null,
  model_id: null, model: null, client_id: 'c1', client_name: 'Acme',
  site_id: null, site_name: null, location_detail: '', status: 'in_transit',
  status_label: 'In Transit', status_color: '#1668a7', has_rails: null,
  last_seen_at: null, archived_at: null, created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const STATUSES: StatusValue[] = [
  { record_type: 'asset', key: 'in_transit', label: 'In Transit',
    description: '', color: '#1668a7', sort_order: 1, is_active: true,
    usage_count: null, progress_weight: 50 },
  { record_type: 'asset', key: 'labeled', label: 'Labeled',
    description: '', color: '#178a4c', sort_order: 2, is_active: true,
    usage_count: null, progress_weight: 10 },
];

const ASSETS: AssetItem[] = [
  asset({ id: 'a1' }),
  asset({ id: 'a2' }),
  asset({ id: 'a3', name: 'edge-rt-04', status: 'labeled', status_label: 'Labeled', status_color: '#178a4c' }),
];

const ACTIVITY: ClientActivityOut = {
  // status/status_label are nullable on this row (a scan that hasn't
  // resolved to a known asset status) — deliberately null here so the
  // fixture also exercises ClientDashboard's `status_label ?? 'Scanned'`
  // fallback, and so this fixed "In Transit" text stays unique to the
  // asset-fleet panel's aggregated status row (avoiding an ambiguous
  // queryByText match across two panels showing the same label).
  events: [{
    id: 'ev1', scanned_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    asset_id: 'a1', asset_name: 'core-sw-01', serial_number: 'SN1',
    status: null, status_label: null, status_color: '#51606f',
    site_name: 'DC1', device_id: 'RDR-1',
  }],
  activity_7d: 9,
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  auth.scope = { global: true, client_ids: [], partner_ids: [] };
  api.listClients.mockResolvedValue([clientRef('c1', 'Acme'), clientRef('c2', 'Beta')]);
  api.getOrg.mockImplementation((_kind: string, id: string) =>
    Promise.resolve(org({ id, name: id === 'c2' ? 'Beta' : 'Acme' })));
  api.listInitiatives.mockResolvedValue([
    initiative(),
    initiative({
      id: 'i2', name: 'Acme finished move', real_end_at: '2026-08-01T00:00:00Z',
      // Distinct status from the active fixture's 'In Progress' — a
      // finished initiative wouldn't still show that status anyway, and
      // it keeps 'In Progress' unique to the active row's status chip.
      status: 'completed', status_label: 'Completed', status_color: '#178a4c',
    }),
  ]);
  api.listInitiativeAssets.mockResolvedValue([]);
  api.listAssets.mockResolvedValue(ASSETS);
  api.listAssetStatuses.mockResolvedValue(STATUSES);
  api.getClientActivity.mockResolvedValue(ACTIVITY);
});

afterEach(() => {
  cleanup();
});

it('internal user gets a client select and panels for the first client', async () => {
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByLabelText('Client')).not.toBeNull());
  // The panels resolve from their own fetches after the select appears —
  // wait for each rather than asserting synchronously (a race that lost
  // under a loaded full-suite run).
  expect(await screen.findByText('Acme move')).toBeTruthy();    // initiatives
  expect(await screen.findByText('In Progress')).toBeTruthy();  // initiative status chip
  expect(await screen.findByText('In Transit')).toBeTruthy();   // fleet dist
  expect(await screen.findByText('9')).toBeTruthy();            // activity 7d KPI
});

it('switching client reloads panels', async () => {
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByLabelText('Client')).not.toBeNull());
  api.getClientActivity.mockClear();
  fireEvent.change(screen.getByLabelText('Client'), { target: { value: 'c2' } });
  await waitFor(() => expect(api.getClientActivity).toHaveBeenCalledWith('c2'));
});

it('single-client user sees static name, no select', async () => {
  auth.scope = { global: false, client_ids: ['c1'], partner_ids: [] };
  api.listClients.mockResolvedValue([{ id: 'c1', name: 'Acme' }]);
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryAllByText('Acme').length).toBeGreaterThan(0));
  expect(screen.queryByLabelText('Client')).toBeNull();
});

it('permission-poor user sees the empty note', async () => {
  auth.can = (r: string) => r === 'dashboard';
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  await waitFor(() =>
    expect(screen.queryByText(/Nothing your permissions/)).not.toBeNull());
});

it('clients:view is the functional prerequisite — holding only initiatives:view still shows the empty note, no picker or grid', async () => {
  auth.can = (r: string) => r === 'dashboard' || r === 'initiatives';
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  await waitFor(() =>
    expect(screen.queryByText(/Nothing your permissions/)).not.toBeNull());
  expect(screen.queryByLabelText('Client')).toBeNull();
  expect(screen.queryByText('Acme move')).toBeNull();
  expect(api.listClients).not.toHaveBeenCalled();
});

it('activity rows render with status label and relative time', async () => {
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('core-sw-01')).not.toBeNull());
  expect(screen.queryByText('In Transit')).not.toBeNull();
});

it('renders an initiative\'s scheduled dates without shifting them west of UTC', async () => {
  // scheduled_start/scheduled_end are date-only fields (midnight UTC for a
  // plain YYYY-MM-DD input). vitest inherits whatever TZ the shell has, so
  // pin a west-of-UTC zone here rather than trusting the host — on a UTC
  // host `new Date(iso)` and the parseApiDay+longDateOf fix agree even
  // when buggy, which would prove nothing.
  const prevTz = process.env.TZ;
  process.env.TZ = 'America/New_York';
  try {
    render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
    // Both fixture initiatives share the same scheduled_start, so more
    // than one row shows the date — assert on the set, not a single match.
    expect((await screen.findAllByText(/Sep 1, 2026/)).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/Aug 31, 2026/).length).toBe(0);
  } finally {
    if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
  }
});

it('renders a dash for an initiative with no scheduled dates', async () => {
  api.listInitiatives.mockResolvedValue([
    initiative({ id: 'i3', name: 'Unscheduled move', scheduled_start: null, scheduled_end: null }),
  ]);
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  const nameEl = await screen.findByText('Unscheduled move');
  const row = nameEl.closest('.cdash-init-row') as HTMLElement;
  expect(within(row).getByText('— – —')).toBeTruthy();
});
