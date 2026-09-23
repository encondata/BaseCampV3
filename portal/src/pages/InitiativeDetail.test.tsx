// @vitest-environment jsdom
/**
 * /initiatives/:id — the Full Details page. This file covers the two
 * per-row action surfaces the Actions-menu conversion touches: the move
 * Assets list and the People roster. Everything else on the page (header
 * fields, links, notes, time summary) is out of scope here; the generic
 * toolbar/column-menu behavior is covered by lib/listTools.test.tsx and
 * lib/columnMenu.test.tsx.
 *
 * Menu items are asserted via `screen`, not `within(row)`: RowActionsMenu
 * portals the open menu to document.body (escaping .dir-list's overflow
 * clipping — see RowActionsMenu.tsx), so once open the items no longer
 * sit inside the row's DOM subtree. Only one menu is ever open at a time,
 * so screen-level queries stay unambiguous. Same reasoning and precedent
 * as KioskDevices.test.tsx:178.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type {
  InitiativeAssetRow, InitiativeDetail as InitiativeDetailOut, InitiativePersonRow,
  UiPreferences,
} from '../lib/api';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action: string) => boolean } = {
    can: () => true,
  };
  return state;
});

const updatePreferences = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    godMode: false,
    maxRank: 0,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
      motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: true, sound: 'chime' },
      list_prefs: {},
    } satisfies UiPreferences,
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
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
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
  client_id: null, client_name: null,
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
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.getInitiative.mockResolvedValue(INITIATIVE);
  api.listInitiativeAssets.mockResolvedValue([ASSET]);
  api.listAssetStatuses.mockResolvedValue([]);
  api.getTimeSummary.mockResolvedValue({
    approved_minutes: 0, pending_minutes: 0, open_count: 0, people: [],
  });
  api.listInitiativeStatuses.mockResolvedValue([]);
  api.listInitiativeTypes.mockResolvedValue([]);
  api.listInitiativeSubTypes.mockResolvedValue([]);
  api.listShippingTypes.mockResolvedValue([]);
  api.listInitiativeWorkTypes.mockResolvedValue([]);
  api.listInitiatives.mockResolvedValue([]);
  api.listSites.mockResolvedValue([]);
  api.listClients.mockResolvedValue([]);
  api.listPartners.mockResolvedValue([]);
  api.listWorkerOptions.mockResolvedValue([]);
  api.listNotes.mockResolvedValue([]);
  api.listAttachments.mockResolvedValue([]);
  api.removeInitiativeAsset.mockResolvedValue(undefined);
  api.removeInitiativePerson.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const { default: InitiativeDetail } = await import('./InitiativeDetail');

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/initiatives/i1']}>
      <Routes>
        <Route path="/initiatives/:id" element={<InitiativeDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

const assetRow = async () =>
  (await screen.findByText('switch-01')).closest('.dir-row') as HTMLElement;

const personRow = async () =>
  (await screen.findByText('Ada Lovelace')).closest('.dir-row') as HTMLElement;

/* ── assets list ─────────────────────────────────────────────────── */

it('assets row: one Actions trigger replaces the inline Edit/Remove buttons', async () => {
  renderPage();

  const row = await assetRow();
  expect(within(row).getByRole('button', { name: /Actions/ })).not.toBeNull();
  expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(within(row).queryByRole('button', { name: 'Remove' })).toBeNull();
});

it('assets row: Actions → Edit opens the asset edit dialog', async () => {
  const user = userEvent.setup();
  renderPage();

  const row = await assetRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

  expect(await screen.findByRole('heading', { name: /Edit — switch-01/ })).not.toBeNull();
});

it('assets row: Actions → Remove still confirms, and a declined confirm removes nothing',
   async () => {
     const confirmSpy = vi.fn(() => false);
     vi.stubGlobal('confirm', confirmSpy);
     const user = userEvent.setup();
     renderPage();

     const row = await assetRow();
     await user.click(within(row).getByRole('button', { name: /Actions/ }));
     await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

     expect(confirmSpy).toHaveBeenCalledTimes(1);
     expect(String(confirmSpy.mock.calls[0])).toContain('switch-01');
     expect(api.removeInitiativeAsset).not.toHaveBeenCalled();
   });

it('assets row: Actions → Remove, confirmed, removes the asset', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  const user = userEvent.setup();
  renderPage();

  const row = await assetRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

  await waitFor(() => expect(api.removeInitiativeAsset).toHaveBeenCalledWith('ia1'));
});

it('assets toolbar: Re-check placement calls the endpoint and refetches the roster', async () => {
  api.recheckInitiativePlacement.mockResolvedValue(
    { checked: 46, collisions: 0, orphans: 1, cleared: 41 });
  const user = userEvent.setup();
  renderPage();
  await assetRow();
  const before = api.listInitiativeAssets.mock.calls.length;

  await user.click(await screen.findByRole('button', { name: 'Re-check placement' }));

  await waitFor(() => expect(api.recheckInitiativePlacement).toHaveBeenCalledWith('i1'));
  await waitFor(() => expect(api.listInitiativeAssets.mock.calls.length).toBe(before + 1));
});

it('assets toolbar: Re-check placement is hidden without change permission', async () => {
  auth.can = (resource, action) => !(resource === 'initiatives' && action === 'change');
  renderPage();
  await assetRow();
  expect(screen.queryByRole('button', { name: 'Re-check placement' })).toBeNull();
  auth.can = () => true;
});

it('assets row: items are disabled, not dropped, while the row is in flight', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  // Never settles: the page stays assetsBusy for the rest of the test.
  api.removeInitiativeAsset.mockReturnValue(new Promise(() => {}));
  const user = userEvent.setup();
  renderPage();

  const row = await assetRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

  const trigger = within(row).getByRole('button', { name: /Actions/ });
  await user.click(trigger);
  await waitFor(() => {
    expect((screen.getByRole('menuitem', { name: 'Edit' }) as HTMLButtonElement).disabled)
      .toBe(true);
    expect((screen.getByRole('menuitem', { name: 'Remove' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });
});

it('assets list: the action track is trigger-sized, and the chevron column survives',
   async () => {
     renderPage();

     const row = await assetRow();
     const main = row.querySelector('.row-main') as HTMLElement;
     expect(main.style.gridTemplateColumns.endsWith('88px 30px')).toBe(true);
     expect(main.style.gridTemplateColumns).not.toContain('132px');
   });

it('assets list: columns carry px floors, header and rows share one template and minimum width, and the card scrolls sideways', async () => {
  renderPage();

  const row = await assetRow();
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  expect(card.classList.contains('editing')).toBe(false);

  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(head.style.minWidth).toMatch(/^\d+px$/);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  // Nine default columns + actions + chevron must fit a 14-inch window
  // with the nav expanded (spec: ≤ 1176px).
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(1176);
});

it('assets list: single-line values truncate with the full text on hover', async () => {
  renderPage();

  const row = await assetRow();
  const name = within(row).getByText('switch-01');
  expect(name.classList.contains('cell-line')).toBe(true);
  expect(name.getAttribute('title')).toBe('switch-01');

  const rackBtn = within(row).getByRole('button', { name: 'rack-a1' });
  expect(rackBtn.classList.contains('cell-line')).toBe(true);
  expect(rackBtn.getAttribute('title')).toBe('rack-a1');
});

it('assets list: the header renders through ColHead (long label, hidden short-label measure for wordy columns)', async () => {
  renderPage();

  const row = await assetRow();
  const head = (row.closest('.dir-list') as HTMLElement).querySelector('.list-head') as HTMLElement;
  // Exact match: the ColumnMenu trigger's aria-label ("Destination Rack
  // column menu") also contains this substring, so a loose regex would
  // match both buttons and make the query ambiguous.
  expect(within(head).getByRole('button', { name: 'Destination Rack' })).not.toBeNull();
  expect(head.querySelector('.col-head-measure')).not.toBeNull();
});

/* ── people list ─────────────────────────────────────────────────── */

it('people row: one Actions trigger replaces the inline Edit/Remove buttons', async () => {
  renderPage();

  const row = await personRow();
  expect(within(row).getByRole('button', { name: /Actions/ })).not.toBeNull();
  expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(within(row).queryByRole('button', { name: 'Remove' })).toBeNull();
});

it('people list: floors, shared template + minimum width, and the sideways-scroll card', async () => {
  renderPage();

  const row = await personRow();
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(main.style.gridTemplateColumns.endsWith('88px')).toBe(true);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(within(row).getByText('Ada Lovelace').classList.contains('cell-line')).toBe(true);
});

it('people row: Actions → Edit opens the person edit dialog', async () => {
  const user = userEvent.setup();
  renderPage();

  const row = await personRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

  expect(await screen.findByRole('heading', { name: /Edit — Ada Lovelace/ })).not.toBeNull();
});

it('people row: Actions → Remove confirms first, then removes', async () => {
  const confirmSpy = vi.fn(() => false);
  vi.stubGlobal('confirm', confirmSpy);
  const user = userEvent.setup();
  renderPage();

  const row = await personRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

  expect(confirmSpy).toHaveBeenCalledTimes(1);
  expect(String(confirmSpy.mock.calls[0])).toContain('Ada Lovelace');
  expect(api.removeInitiativePerson).not.toHaveBeenCalled();

  confirmSpy.mockReturnValue(true);
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));
  await waitFor(() => expect(api.removeInitiativePerson).toHaveBeenCalledWith('ip1'));
});

it('people list: the action track is trigger-sized', async () => {
  renderPage();

  const row = await personRow();
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(main.style.gridTemplateColumns.endsWith('88px')).toBe(true);
  expect(main.style.gridTemplateColumns).not.toContain('132px');
});

/* ── permission gate ─────────────────────────────────────────────── */

it('without initiatives:change there is no Actions trigger on either list', async () => {
  auth.can = (resource: string, action: string) =>
    !(resource === 'initiatives' && action === 'change');
  renderPage();

  const arow = await assetRow();
  expect(within(arow).queryByRole('button', { name: /Actions/ })).toBeNull();
  const prow = await personRow();
  expect(within(prow).queryByRole('button', { name: /Actions/ })).toBeNull();
});
