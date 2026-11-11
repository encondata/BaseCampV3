// @vitest-environment jsdom
/** Restricted client logins see a shorter move roster; the counts stay true. */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ScopeInfo } from '../lib/access';
import { ApiError } from '../lib/api';
import type {
  InitiativeAssetRow, InitiativeDetail as InitiativeDetailOut, InitiativePersonRow,
  StatusValue, UiPreferences,
} from '../lib/api';
import { ListPrefsFromAuth } from '../test/ListPrefsFromAuth';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action: string) => boolean; maxRank: number; scope: ScopeInfo | null } = {
    can: () => true,
    maxRank: 0,
    scope: null,
  };
  return state;
});

const updatePreferences = vi.hoisted(() => vi.fn(() => Promise.resolve()));

const prefs = vi.hoisted(() => ({
  accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
  motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', list_view: 'expanded',
  notif: { sound: 'chime', switches: {}, schedule: { timezone: null, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], quiet_start: null, quiet_end: null } },
  list_prefs: {},
} as UiPreferences));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    godMode: false,
    maxRank: auth.maxRank,
    preferences: prefs,
    scope: auth.scope,
    updatePreferences,
  }),
}));

const api = vi.hoisted(() => ({
  getInitiative: vi.fn(),
  listInitiativeAssets: vi.fn(),
  listAssetStatuses: vi.fn(),
  getTimeSummary: vi.fn(),
  listInitiativeStatuses: vi.fn(),
  listInitiativeTypes: vi.fn(),
  listInitiativeSubTypes: vi.fn(),
  listShippingTypes: vi.fn(),
  listInitiativeWorkTypes: vi.fn(),
  listInitiatives: vi.fn(),
  listSites: vi.fn(),
  listClients: vi.fn(),
  listPartners: vi.fn(),
  listWorkerOptions: vi.fn(),
  listNotes: vi.fn(),
  listAttachments: vi.fn(),
  removeInitiativeAsset: vi.fn(),
  removeInitiativePerson: vi.fn(),
  updateInitiativeAsset: vi.fn(),
  updateInitiativePerson: vi.fn(),
  addInitiativePerson: vi.fn(),
  addInitiativeLink: vi.fn(),
  removeInitiativeLink: vi.fn(),
  updateInitiativeLink: vi.fn(),
  recheckInitiativePlacement: vi.fn(),
  getInitiativeAssetTotals: vi.fn(),
  getWatchState: vi.fn(),
  listMyAssetWatches: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

// the Learning tab's own calls (its behavior is covered by InitiativeLearningTab.test.tsx)
const learning = vi.hoisted(() => ({
  getInitiativeLearning: vi.fn(),
  listInitiativeRoster: vi.fn(),
  getInitiativeGrid: vi.fn(),
}));
vi.mock('../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../lib/learning')>()),
  ...learning,
}));

// the Project plan tab's calls (its behavior is covered by components/plans/PlanTab.test.tsx)
const plans = vi.hoisted(() => ({
  getPlan: vi.fn(),
  getPlanVersion: vi.fn(),
}));
vi.mock('../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/plans/api')>()),
  ...plans,
}));

const PERSON: InitiativePersonRow = {
  id: 'ip1', person_id: 'p1', person_name: 'Ada Lovelace',
  work_type: 'tech', work_type_label: 'Tech', work_type_color: '#178a4c',
  site_worked_id: 's1', site_worked_name: 'NAP 11',
  rating: 4, created_at: '2026-09-01T10:00:00Z',
};

const ASSET: InitiativeAssetRow = {
  id: 'ia1', asset_id: 'a1',
  priority_wave: null, disposition: null, owner: null,
  source_pod: null, destination_pod: null,
  source_rack: 'rack-a1', source_ru: null,
  source_verified: null, source_position: null,
  destination_rack: null, destination_ru: null,
  destination_verified: null, destination_position: null,
  cable_info: null, vendor_involved: null,
  status: 'staged', status_label: 'Staged', status_color: '#178a4c',
  created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z',
  asset: {
    id: 'a1', legacy_id: null, serial_number: 'SN-0001', name: 'switch-01',
    rfid_tag: null, pod_number: null, model_make: 'Cisco', model_name: 'C9300',
    ru_size: 1, model_form_factor: null, location_detail: null, client_name: null,
    model_category: 'network', model_category_label: 'Network',
    model_category_color: '#3b82f6',
    status: 'active', status_label: 'Active', status_color: '#178a4c',
  },
};

const INITIATIVE: InitiativeDetailOut = {
  id: 'i1', name: 'NAP11 Hall Migration', description: null,
  initiative_type: 'move', type_label: 'Move', type_color: '#3b82f6',
  sub_type: null, sub_type_label: null, sub_type_color: null,
  status: 'active', status_label: 'Active', status_color: '#178a4c',
  color: null,
  client_id: 'c1', client_name: 'Acme',
  site_id: null, site_name: null, location: null,
  scheduled_start: null, scheduled_end: null,
  sky_command_project_id: null,
  origin_site_id: null, origin_site_name: null,
  destination_site_id: null, destination_site_name: null,
  real_start_at: null, real_end_at: null,
  priority_devices: null,
  shipping_types: [],
  shipping_partner_id: null, shipping_partner_name: null,
  origin_tech_partner_id: null, origin_cable_partner_id: null,
  origin_logistics_partner_id: null,
  destination_tech_partner_id: null, destination_cable_partner_id: null,
  destination_logistics_partner_id: null,
  origin_vendor_involved: null, destination_vendor_involved: null,
  people_count: 1, links_count: 0,
  parent_id: null, parent_role: null,
  archived_at: null, created_at: '2026-09-01T10:00:00Z',
  people: [PERSON],
  links_children: [], links_parents: [],
  kiosk_password_set: false,
};


const status = (key: string, label: string, color: string): StatusValue => ({
  record_type: 'asset', key, label, description: '', color, sort_order: 0,
  is_active: true, usage_count: null, progress_weight: 50,
});

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();
  auth.can = () => true;
  auth.maxRank = 0;
  auth.scope = { global: false, client_ids: ['c1'], partner_ids: [], restricted_client_ids: ['c1'] };
  prefs.list_view = 'expanded';
  prefs.list_prefs = {};
  api.getInitiative.mockResolvedValue(INITIATIVE);
  api.listInitiativeAssets.mockResolvedValue([ASSET]);
  api.getInitiativeAssetTotals.mockResolvedValue({ total: 4, by_status: { staged: 3, shipped: 1 } });
  api.listAssetStatuses.mockResolvedValue([
    status('staged', 'Staged', '#178a4c'), status('shipped', 'Shipped', '#1668a7'),
  ]);
  api.getTimeSummary.mockResolvedValue({
    approved_minutes: 0, pending_minutes: 0, open_count: 0, people: [],
  });
  for (const k of ['listInitiativeStatuses', 'listInitiativeTypes', 'listInitiativeSubTypes',
    'listShippingTypes', 'listInitiativeWorkTypes', 'listInitiatives', 'listSites', 'listClients',
    'listPartners', 'listWorkerOptions', 'listNotes', 'listAttachments', 'listMyAssetWatches'] as const) {
    api[k].mockResolvedValue([]);
  }
  api.getWatchState.mockResolvedValue({ watching: false, watch_id: null, kinds: [] });
  learning.getInitiativeLearning.mockResolvedValue({
    stats: { invited: 0, opened: 0, in_progress: 0, complete: 0, overdue: 0 },
    schedule: {
      mode: 'manual', send_offset_days: 7, send_time: '08:00', reminder_offsets: [5, 3],
      due_offset_days: 2, late_adds: true, sent_at: null, send_at: null,
      codes_expire_on: null, ended: false, inactive: false, is_default: true,
    },
    packets: [], extras: [], timeline: [],
  });
  learning.listInitiativeRoster.mockResolvedValue([]);
  learning.getInitiativeGrid.mockResolvedValue({ documents: [], rows: [] });
  plans.getPlan.mockRejectedValue(new ApiError(404, 'no_plan', { code: 'no_plan' }));
});

afterEach(() => { cleanup(); });

vi.mock('../lib/rackPdf', () => ({ exportRackPdf: vi.fn() }));

const { default: InitiativeDetail } = await import('./InitiativeDetail');

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/initiatives/i1?tab=full']}>
      <Routes>
        <Route path="/initiatives/:id" element={<InitiativeDetail />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: ListPrefsFromAuth },
  );
}

it('restricted login: badge, eyebrow, donut and N of M use the true totals', async () => {
  renderPage();
  expect(await screen.findByText('1 of 4 shown')).not.toBeNull();
  expect(screen.getByRole('tab', { name: /^Assets/ }).textContent).toContain('4');
  expect(screen.getByText('Assets — 4')).not.toBeNull();
  expect(screen.getByRole('img', { name: /Asset status breakdown — 4 assets/ })).not.toBeNull();
  expect(api.getInitiativeAssetTotals).toHaveBeenCalledWith('i1');
});

it('unrestricted login: the totals endpoint is never called', async () => {
  auth.scope = { global: true, client_ids: [], partner_ids: [], restricted_client_ids: [] };
  renderPage();
  expect(await screen.findByText('1 of 1 shown')).not.toBeNull();
  expect(screen.getByText('Assets — 1')).not.toBeNull();
  expect(api.getInitiativeAssetTotals).not.toHaveBeenCalled();
});

it('restricted to a different client: the totals endpoint is not called', async () => {
  auth.scope = { global: false, client_ids: ['c1'], partner_ids: [], restricted_client_ids: ['c9'] };
  renderPage();
  expect(await screen.findByText('1 of 1 shown')).not.toBeNull();
  expect(api.getInitiativeAssetTotals).not.toHaveBeenCalled();
});
