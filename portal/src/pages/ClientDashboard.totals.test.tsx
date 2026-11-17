// @vitest-environment jsdom
/**
 * /dashboards/clients — the client-facing landing page: a client picker
 * (or a static name for a single-client scoped viewer), an identity band,
 * a KPI strip, that client's initiatives, its asset fleet distribution,
 * and recent scan activity. Refresh idiom mirrors PeopleDashboard (quiet
 * catches, panels never blank on a refetch); per-resource panel gating
 * follows Home.tsx.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  getClientAssetTotals: vi.fn(),
  getInitiativeAssetTotals: vi.fn(),
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
  parent_id: null, parent_role: null,
  archived_at: null, created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const asset = (over: Partial<AssetItem> = {}): AssetItem => ({
  id: 'a1', legacy_id: 1, serial_number: 'SN1', name: 'core-sw-01', rfid_tag: null,
  pod_number: null, model_id: null, model: null, client_id: 'c1', client_name: 'Acme',
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
  auth.scope = { global: false, client_ids: ['c1'], partner_ids: [], restricted_client_ids: ['c1'] };
  api.listClients.mockResolvedValue([clientRef('c1', 'Acme')]);
  api.getOrg.mockResolvedValue(org());
  api.listInitiatives.mockResolvedValue([initiative()]);
  api.listInitiativeAssets.mockResolvedValue([]);
  api.listAssets.mockResolvedValue([asset({ id: 'a1' })]);
  api.listAssetStatuses.mockResolvedValue(STATUSES);
  api.getClientActivity.mockResolvedValue(ACTIVITY);
  api.getClientAssetTotals.mockResolvedValue({
    total: 12, by_status: { in_transit: 7, labeled: 5 },
  });
  api.getInitiativeAssetTotals.mockResolvedValue({ total: 4, by_status: { in_transit: 4 } });
});

afterEach(() => { cleanup(); });

it('restricted login: Total assets, In transit, fleet and move progress use the true totals', async () => {
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  const kpi = async (label: string) =>
    (await screen.findByText(label)).closest('.dash-kpi') as HTMLElement;
  await waitFor(async () => expect(within(await kpi('Total assets')).getByText('12')).toBeTruthy());
  expect(within(await kpi('In transit')).getByText('7')).toBeTruthy();
  const fleet = screen.getByLabelText('Asset fleet');
  await waitFor(() => expect(within(fleet).getByText('Labeled')).toBeTruthy());
  expect(within(fleet).getByText('5')).toBeTruthy();
  await waitFor(() => expect(api.getInitiativeAssetTotals).toHaveBeenCalledWith('i1'));
  expect(api.getClientAssetTotals).toHaveBeenCalledWith('c1');
  expect(await screen.findByText('50%')).toBeTruthy();
  expect(api.listInitiativeAssets).not.toHaveBeenCalled();
});

it('unrestricted login: the totals endpoints are never called', async () => {
  auth.scope = { global: true, client_ids: [], partner_ids: [], restricted_client_ids: [] };
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  await waitFor(() => expect(api.listInitiativeAssets).toHaveBeenCalled());
  const kpi = (await screen.findByText('Total assets')).closest('.dash-kpi') as HTMLElement;
  await waitFor(() => expect(within(kpi).getByText('1')).toBeTruthy());
  expect(api.getClientAssetTotals).not.toHaveBeenCalled();
  expect(api.getInitiativeAssetTotals).not.toHaveBeenCalled();
});

it('restricted login: a failed client totals call shows an error, not Loading forever', async () => {
  api.getClientAssetTotals.mockRejectedValue(new Error('boom'));
  render(<MemoryRouter><ClientDashboard /></MemoryRouter>);
  const fleet = await screen.findByLabelText('Asset fleet');
  expect(await within(fleet).findByText(/Couldn't load this client's asset totals/)).toBeTruthy();
  expect(within(fleet).queryByText('Loading…')).toBeNull();
});
