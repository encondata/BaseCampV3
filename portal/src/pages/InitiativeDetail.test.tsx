// @vitest-environment jsdom
/**
 * /initiatives/:id — the Full Details page. This file covers the two
 * per-row action surfaces the Actions-menu conversion touches: the move
 * Assets list and the People roster. Everything else on the page (header
 * fields, links, notes, time summary) is out of scope here; the generic
 * toolbar/column-menu behavior is covered by lib/listTools.test.tsx and
 * lib/columnMenu.test.tsx.
 *
 * The assets row menu also carries "Watch…" / "Watching…" (a watch on the asset on this
 * initiative), for everyone who can open the asset; Edit and Remove stay with
 * initiatives:change.
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
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ADMIN_RANK } from '../lib/access';
import { ApiError } from '../lib/api';
import type {
  AssetWatch, InitiativeAssetRow, InitiativeDetail as InitiativeDetailOut, InitiativePersonRow,
  StatusValue, UiPreferences,
} from '../lib/api';
import { LIST_FIT } from '../lib/listTools';
import { ListPrefsFromAuth } from '../test/ListPrefsFromAuth';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action: string) => boolean; maxRank: number } = {
    can: () => true,
    maxRank: 0,
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
  getWatchState: vi.fn(),            // the header's Watch button
  createMyWatch: vi.fn(),
  listMyAssetWatches: vi.fn(),       // the assets row menu's Watch… / Watching…
  createMyAssetWatch: vi.fn(),
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
  kiosk_password_set: false,
};

/** The person's watch of the asset a1 on this initiative (the row ia1), for its next update. */
const ROW_WATCH: AssetWatch = {
  id: 'w1', asset_id: 'a1', asset_name: 'SN-0001',
  initiative_id: 'i1', initiative_name: 'NAP11 Hall Migration', initiative_asset_id: 'ia1',
  condition: 'next_update', status: null, status_label: null,
  current_status: 'staged', current_status_label: 'Staged',
  link: '/initiatives/i1/assets/ia1', created_at: '2026-11-05T12:00:00Z',
};

const status = (key: string, label: string): StatusValue => ({
  record_type: 'asset', key, label, description: '', color: '#888888', sort_order: 0,
  is_active: true, usage_count: null, progress_weight: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; the Watch modal's ComboBox scrolls its active option
  auth.can = () => true;
  auth.maxRank = 0;
  prefs.list_view = 'expanded';
  prefs.list_prefs = {};
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
  api.getWatchState.mockResolvedValue({ watching: false, watch_id: null, kinds: [] });
  api.listMyAssetWatches.mockResolvedValue([]);
  api.createMyAssetWatch.mockResolvedValue(ROW_WATCH);
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

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const rackPdf = vi.hoisted(() => ({ exportRackPdf: vi.fn(() => Promise.resolve()) }));
vi.mock('../lib/rackPdf', () => rackPdf);

const { default: InitiativeDetail } = await import('./InitiativeDetail');

function renderPage(tab?: string) {
  return render(
    <MemoryRouter initialEntries={[`/initiatives/i1${tab ? `?tab=${tab}` : ''}`]}>
      <Routes>
        <Route path="/initiatives/:id" element={<InitiativeDetail />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: ListPrefsFromAuth },
  );
}

let currentSearch = '';
function LocationProbe() {
  currentSearch = useLocation().search;
  return null;
}

const assetRow = async () =>
  (await screen.findByText('switch-01')).closest('.dir-row') as HTMLElement;

const personRow = async () =>
  (await screen.findByText('Ada Lovelace')).closest('.dir-row') as HTMLElement;

/* ── header: Watch, Import assets, Edit ──────────────────────────── */

const headerActions = async () =>
  (await screen.findByRole('heading', { name: 'NAP11 Hall Migration' }))
    .closest('.idet-header')!.querySelector('.idet-header-actions') as HTMLElement;

const actionNames = (actions: HTMLElement) => [...actions.children].map((el) => el.textContent);

it('header: Watch comes first, then Import assets and Edit, for someone who can change it', async () => {
  renderPage();
  const actions = await headerActions();
  await within(actions).findByRole('button', { name: 'Watch' });

  expect(actionNames(actions)).toEqual(['Watch', 'Import assets', 'Edit']);
  expect(api.getWatchState).toHaveBeenCalledWith('initiative', 'i1');
});

it('header: Watch still shows without change permission, and Edit and Import assets do not', async () => {
  auth.can = (resource, action) => !(resource === 'initiatives' && action === 'change');
  renderPage();
  const actions = await headerActions();
  await within(actions).findByRole('button', { name: 'Watch' });

  expect(actionNames(actions)).toEqual(['Watch']);
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('link', { name: 'Import assets' })).toBeNull();
});

it('header: a click on Watch watches this initiative', async () => {
  const user = userEvent.setup();
  api.createMyWatch.mockResolvedValue({
    id: 'w1', thing: 'initiative', thing_id: 'i1', thing_name: 'NAP11 Hall Migration',
    link: '/initiatives/i1', kinds: [], via: { type: 'you' }, created_at: '2026-11-02T12:00:00Z',
  });
  renderPage();
  const actions = await headerActions();

  await user.click(await within(actions).findByRole('button', { name: 'Watch' }));

  await waitFor(() => expect(api.createMyWatch)
    .toHaveBeenCalledWith({ thing: 'initiative', id: 'i1', kinds: [] }));
  expect(await within(actions).findByRole('button', { name: 'Watching' })).not.toBeNull();
});

/* ── assets list ─────────────────────────────────────────────────── */

it('tabs: opens on Overview, and a tab click shows that section and records it in the URL', async () => {
  const user = userEvent.setup();
  renderPage();
  const overview = await screen.findByRole('tab', { name: 'Overview' });
  expect(overview.getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText('Linked initiatives')).not.toBeNull();
  expect(screen.queryByText('switch-01')).toBeNull();
  await user.click(screen.getByRole('tab', { name: /^Assets/ }));
  expect(await screen.findByText('switch-01')).not.toBeNull();
  expect(screen.queryByText('Linked initiatives')).toBeNull();
  expect(screen.getByRole('tab', { name: /^Assets/ }).getAttribute('aria-selected')).toBe('true');
});

it('tabs: ?tab= deep-links to a tab, and the Learning tab renders the learning panel', async () => {
  renderPage('learning');
  expect((await screen.findByRole('tab', { name: 'Learning' })).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByRole('group', { name: 'Learning progress' })).not.toBeNull();
  expect(learning.getInitiativeLearning).toHaveBeenCalledWith('i1');
  expect(screen.getByRole('region', { name: 'Invites and reminders' })).not.toBeNull();
  expect(screen.queryByText(/Coming soon/)).toBeNull();
});

it('tabs: Learning is offered only to Learning managers', async () => {
  // workers:view and initiatives:view alone read nothing the Learning API allows
  auth.can = (resource: string) => resource !== 'learning' && resource !== 'wiki';
  renderPage('learning');
  await screen.findByRole('tab', { name: 'Overview' });
  expect(screen.queryByRole('tab', { name: 'Learning' })).toBeNull();
  // a deep link falls back to Overview
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  expect(learning.getInitiativeLearning).not.toHaveBeenCalled();
});

it('tabs: Project plan sits after Full Picture and renders the plan tab', async () => {
  renderPage('plan');
  const tab = await screen.findByRole('tab', { name: 'Project plan' });
  expect(tab.getAttribute('aria-selected')).toBe('true');
  const names = screen.getAllByRole('tab').map((t) => t.textContent);
  expect(names.indexOf('Project plan')).toBe(names.indexOf('Full Picture') + 1);
  expect(await screen.findByText('No project plan yet')).not.toBeNull();
  expect(plans.getPlan).toHaveBeenCalledWith('i1');
  // the panel spans the whole grid, like Learning
  expect(screen.getByText('No project plan yet').closest('.idet-plan')).not.toBeNull();
  expect(screen.queryByText('Linked initiatives')).toBeNull();
});

it('tabs: Project plan is offered only with project_plans:view', async () => {
  auth.can = (resource: string) => resource !== 'project_plans';
  renderPage('plan');
  await screen.findByRole('tab', { name: 'Overview' });
  expect(screen.queryByRole('tab', { name: 'Project plan' })).toBeNull();
  // a deep link falls back to Overview
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  expect(plans.getPlan).not.toHaveBeenCalled();
});

it('tabs: leaving the Project plan tab drops its view and task from the URL', async () => {
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/initiatives/i1?tab=plan&view=gantt&task=t1']}>
      <Routes>
        <Route path="/initiatives/:id" element={<><InitiativeDetail /><LocationProbe /></>} />
      </Routes>
    </MemoryRouter>,
    { wrapper: ListPrefsFromAuth },
  );
  await screen.findByText('No project plan yet');
  await user.click(screen.getByRole('tab', { name: /^Assets/ }));
  expect(currentSearch).toBe('?tab=assets');
});

it('tabs: Full Picture shows the overview and the assets list together', async () => {
  renderPage('full');
  expect((await screen.findByRole('tab', { name: 'Full Picture' })).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('switch-01')).not.toBeNull();
  expect(screen.getByText('Linked initiatives')).not.toBeNull();
  expect(screen.queryByText('Ada Lovelace')).toBeNull();
});

it('tabs: an unknown ?tab= falls back to Overview', async () => {
  renderPage('nope');
  expect((await screen.findByRole('tab', { name: 'Overview' })).getAttribute('aria-selected')).toBe('true');
});

it('assets row: one Actions trigger replaces the inline Edit/Remove buttons', async () => {
  renderPage('assets');

  const row = await assetRow();
  expect(within(row).getByRole('button', { name: /Actions/ })).not.toBeNull();
  expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(within(row).queryByRole('button', { name: 'Remove' })).toBeNull();
});

it('assets row: Actions → Edit opens the asset edit dialog', async () => {
  const user = userEvent.setup();
  renderPage('assets');

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
     renderPage('assets');

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
  renderPage('assets');

  const row = await assetRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

  await waitFor(() => expect(api.removeInitiativeAsset).toHaveBeenCalledWith('ia1'));
});

it('assets toolbar: Re-check placement calls the endpoint and refetches the roster', async () => {
  api.recheckInitiativePlacement.mockResolvedValue(
    { checked: 46, collisions: 0, orphans: 1, cleared: 41 });
  const user = userEvent.setup();
  renderPage('assets');
  await assetRow();
  const before = api.listInitiativeAssets.mock.calls.length;

  await user.click(await screen.findByRole('button', { name: 'Re-check placement' }));

  await waitFor(() => expect(api.recheckInitiativePlacement).toHaveBeenCalledWith('i1'));
  await waitFor(() => expect(api.listInitiativeAssets.mock.calls.length).toBe(before + 1));
});

it('assets toolbar: Re-check placement is hidden without change permission', async () => {
  auth.can = (resource, action) => !(resource === 'initiatives' && action === 'change');
  renderPage('assets');
  await assetRow();
  expect(screen.queryByRole('button', { name: 'Re-check placement' })).toBeNull();
  auth.can = () => true;
});

it('assets row: items are disabled, not dropped, while the row is in flight', async () => {
  vi.stubGlobal('confirm', vi.fn(() => true));
  // Never settles: the page stays assetsBusy for the rest of the test.
  api.removeInitiativeAsset.mockReturnValue(new Promise(() => {}));
  const user = userEvent.setup();
  renderPage('assets');

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
     renderPage('assets');

     const row = await assetRow();
     const main = row.querySelector('.row-main') as HTMLElement;
     expect(main.style.gridTemplateColumns.endsWith('88px 30px')).toBe(true);
     expect(main.style.gridTemplateColumns).not.toContain('132px');
   });

it('assets list: columns carry px floors, header and rows share one template and minimum width, and the card scrolls sideways', async () => {
  renderPage('assets');

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
  // with the nav expanded (spec: ≤ LIST_FIT.initPanel — 1134px, the .init-panel's
  // 18px padding and 1px border either side off the measured 1174px page width).
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.initPanel);
});

it('assets list: edit mode drops the row minimum since the card is no longer a scroll container', async () => {
  auth.maxRank = ADMIN_RANK;
  const user = userEvent.setup();
  renderPage('assets');

  const row = await assetRow();
  const card = row.closest('.dir-list') as HTMLElement;
  expect(row.style.minWidth).not.toBe('');

  await user.click(await screen.findByRole('button', { name: 'Edit table' }));

  expect(card.classList.contains('editing')).toBe(true);
  const editingRow = await assetRow();
  expect(editingRow.style.minWidth).toBe('');
});

it('assets list: single-line values truncate with the full text on hover', async () => {
  renderPage('assets');

  const row = await assetRow();
  const name = within(row).getByText('switch-01');
  expect(name.classList.contains('cell-line')).toBe(true);
  expect(name.getAttribute('title')).toBe('switch-01');

  const rackBtn = within(row).getByRole('button', { name: 'rack-a1' });
  expect(rackBtn.classList.contains('cell-line')).toBe(true);
  expect(rackBtn.getAttribute('title')).toBe('rack-a1');
});

it('assets list: the header renders through ColHead (long label, hidden short-label measure for wordy columns)', async () => {
  renderPage('assets');

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
  renderPage('people');

  const row = await personRow();
  expect(within(row).getByRole('button', { name: /Actions/ })).not.toBeNull();
  expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(within(row).queryByRole('button', { name: 'Remove' })).toBeNull();
});

it('people list: floors, shared template + minimum width, and the sideways-scroll card', async () => {
  renderPage('people');

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
  renderPage('people');

  const row = await personRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

  expect(await screen.findByRole('heading', { name: /Edit — Ada Lovelace/ })).not.toBeNull();
});

it('people row: Actions → Remove confirms first, then removes', async () => {
  const confirmSpy = vi.fn(() => false);
  vi.stubGlobal('confirm', confirmSpy);
  const user = userEvent.setup();
  renderPage('people');

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
  renderPage('people');

  const row = await personRow();
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(main.style.gridTemplateColumns.endsWith('88px')).toBe(true);
  expect(main.style.gridTemplateColumns).not.toContain('132px');
});

/* ── permission gate ─────────────────────────────────────────────── */

/** The labels of the open menu's items, in order (the open menu is portaled: `screen`, not the row). */
const menuItems = () => screen.getAllByRole('menuitem').map((m) => m.textContent);

const cannotChange = (resource: string, action: string) =>
  !(resource === 'initiatives' && action === 'change');
const cannotViewAssets = (resource: string, action: string) =>
  !(resource === 'assets' && action === 'view');

it('without initiatives:change the people list still has no Actions trigger', async () => {
  auth.can = cannotChange;
  renderPage('people');

  const prow = await personRow();
  expect(within(prow).queryByRole('button', { name: /Actions/ })).toBeNull();
});

it('without initiatives:change the assets row still has an Actions button, holding only Watch…', async () => {
  auth.can = cannotChange;
  const user = userEvent.setup();
  renderPage('assets');

  const row = await assetRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));

  expect(menuItems()).toEqual(['Watch…']);
});

it('an editor sees Edit, Watch… and Remove in the assets row menu, the destructive item last', async () => {
  const user = userEvent.setup();
  renderPage('assets');

  const row = await assetRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));

  expect(menuItems()).toEqual(['Edit', 'Watch…', 'Remove']);
});

it('without assets:view there is no Watch… (the API would refuse it): an editor keeps Edit and Remove', async () => {
  auth.can = cannotViewAssets;
  const user = userEvent.setup();
  renderPage('assets');

  const row = await assetRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));

  expect(menuItems()).toEqual(['Edit', 'Remove']);
});

it('without assets:view and without initiatives:change the row has no Actions trigger, but its track stays so the columns line up', async () => {
  auth.can = (resource, action) => cannotChange(resource, action) && cannotViewAssets(resource, action);
  renderPage('assets');

  const row = await assetRow();
  expect(within(row).queryByRole('button', { name: /Actions/ })).toBeNull();
  const main = row.querySelector('.row-main') as HTMLElement;
  const head = (row.closest('.dir-list') as HTMLElement).querySelector('.list-head') as HTMLElement;
  expect(main.style.gridTemplateColumns.endsWith('88px 30px')).toBe(true);
  // a cell (and a header spacer) for every track: the header and the rows keep the same columns
  expect(head.children.length).toBe(main.children.length);
});

it('without assets:view and without initiatives:change a click on the empty Actions cell expands the row, as anywhere else on it', async () => {
  auth.can = (resource, action) => cannotChange(resource, action) && cannotViewAssets(resource, action);
  const user = userEvent.setup();
  renderPage('assets');

  const row = await assetRow();
  await user.click(row.querySelector('.idet-assets-actions') as HTMLElement);

  expect(row.classList.contains('open')).toBe(true);
  expect(within(row).getByRole('tab', { name: 'Move Details' })).toBeTruthy();
});

it('with a trigger in it, a click beside the trigger in the Actions cell leaves the row closed', async () => {
  const user = userEvent.setup();
  renderPage('assets');

  const row = await assetRow();
  await user.click(row.querySelector('.idet-assets-actions') as HTMLElement);

  expect(row.classList.contains('open')).toBe(false);
  expect(within(row).queryByRole('tab', { name: 'Move Details' })).toBeNull();
});

it('for a viewer too the Actions track and its header spacer are there, as for an editor', async () => {
  auth.can = cannotChange;
  renderPage('assets');

  const row = await assetRow();
  const main = row.querySelector('.row-main') as HTMLElement;
  const head = (row.closest('.dir-list') as HTMLElement).querySelector('.list-head') as HTMLElement;
  expect(main.style.gridTemplateColumns.endsWith('88px 30px')).toBe(true);
  expect(head.children.length).toBe(main.children.length);
  expect(main.querySelector('.idet-assets-actions')).not.toBeNull();
});

/* ── Watch… on the assets row ────────────────────────────────────── */

it('assets row: the Watch item reads "Watching…" while the person watches the asset on this initiative, and opens the modal on that watch', async () => {
  api.listMyAssetWatches.mockResolvedValue([ROW_WATCH]);
  const user = userEvent.setup();
  renderPage('assets');

  const row = await assetRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(await screen.findByRole('menuitem', { name: 'Watching…' }));

  const dialog = screen.getByRole('dialog', { name: 'Watch SN-0001' });
  expect(within(dialog).getByRole('button', { name: 'Save' })).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: 'Stop watching' })).toBeTruthy();
});

it('assets row: Actions → Watch… opens the Watch modal for the asset on this initiative, reading the row status', async () => {
  api.listAssetStatuses.mockResolvedValue([
    status('active', 'Active'), status('staged', 'Staged'), status('shipped', 'Shipped'),
  ]);
  const user = userEvent.setup();
  renderPage('assets');

  const row = await assetRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Watch…' }));

  // named by the serial number first (the Edit dialog says switch-01)
  const dialog = await screen.findByRole('dialog', { name: 'Watch SN-0001' });
  expect(dialog.querySelector('p.page-hint')?.textContent).toMatch(/ On NAP11 Hall Migration\.$/);
  await user.click(within(dialog).getByRole('button', { name: 'Status becomes' }));
  // the row is Staged; the asset itself is Active
  expect(within(dialog).getByText('Its status on this initiative is Staged now.')).toBeTruthy();
  const picker = within(dialog).getByRole('combobox', { name: 'Status' }) as HTMLInputElement;
  await waitFor(() => expect(picker.disabled).toBe(false));
  await user.click(picker);
  expect(await screen.findByText('Active', { selector: '.kbar-item' })).toBeTruthy();
  expect(screen.getByText('Shipped', { selector: '.kbar-item' })).toBeTruthy();
  expect(screen.queryByText('Staged', { selector: '.kbar-item' })).toBeNull();
});

it('assets row: watching from the modal sets a watch on this asset and initiative, reads the watches again, and the item reads "Watching…"', async () => {
  api.listMyAssetWatches.mockResolvedValueOnce([]).mockResolvedValue([ROW_WATCH]);
  const user = userEvent.setup();
  renderPage('assets');

  const row = await assetRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Watch…' }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Watch' }));

  await waitFor(() => expect(api.createMyAssetWatch).toHaveBeenCalledWith({
    asset_id: 'a1', initiative_id: 'i1', condition: 'next_update', status: null,
  }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(api.listMyAssetWatches).toHaveBeenCalledTimes(2));
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(await screen.findByRole('menuitem', { name: 'Watching…' })).toBeTruthy();
});

it('a viewer can watch from the assets row: Watch… sets the watch just the same', async () => {
  auth.can = cannotChange;
  const user = userEvent.setup();
  renderPage('assets');

  const row = await assetRow();
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Watch…' }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Watch' }));

  await waitFor(() => expect(api.createMyAssetWatch).toHaveBeenCalledWith({
    asset_id: 'a1', initiative_id: 'i1', condition: 'next_update', status: null,
  }));
});

/* ── people edit table (rank-gated, independent of god mode) ─────── */

const peopleToolbar = async () =>
  (await screen.findByPlaceholderText('Filter people…')).closest('.dir-toolbar') as HTMLElement;

it('people list: Edit table shows for super admin (80) without god mode and edits Work type', async () => {
  auth.maxRank = 80;
  api.listInitiativeWorkTypes.mockResolvedValue([{
    record_type: 'work_type', key: 'tech', label: 'Tech', description: '', color: '#178a4c',
    sort_order: 1, is_active: true, usage_count: null,
  }]);
  const user = userEvent.setup();
  renderPage('people');
  await user.click(within(await peopleToolbar()).getByRole('button', { name: 'Edit table' }));
  const row = await personRow();
  expect(row.closest('.dir-list')!.classList.contains('editing')).toBe(true);
  const workType = within(row).getAllByRole('combobox')
    .find((el) => within(el).queryByRole('option', { name: 'Tech' })) as HTMLSelectElement;
  expect(workType).toBeDefined();
  expect(workType.value).toBe('tech');
  expect(within(row).getByRole('spinbutton')).not.toBeNull();
});

it('people list: Edit table shows for developer (100)', async () => {
  auth.maxRank = 100;
  renderPage('people');
  expect(within(await peopleToolbar()).getByRole('button', { name: 'Edit table' })).not.toBeNull();
});

it('people list: the Edit table toggle carries the neutral tooltip, not the god-mode one', async () => {
  auth.maxRank = 80;
  renderPage('people');
  const toggle = within(await peopleToolbar()).getByRole('button', { name: 'Edit table' });
  expect(toggle.getAttribute('title')).toBe('Edit table directly');
});

it('people list: Edit table is hidden for admin (60)', async () => {
  auth.maxRank = 60;
  renderPage('people');
  expect(within(await peopleToolbar()).queryByRole('button', { name: 'Edit table' })).toBeNull();
});

it('people list: Edit table is hidden without change permission', async () => {
  auth.maxRank = 100;
  auth.can = (resource, action) => !(resource === 'initiatives' && action === 'change');
  renderPage('people');
  expect(within(await peopleToolbar()).queryByRole('button', { name: 'Edit table' })).toBeNull();
});

/* ── kiosk password line ─────────────────────────────────────────── */

it('admins see the kiosk password as Not set / Set', async () => {
  auth.maxRank = ADMIN_RANK;
  renderPage();
  const dt = await screen.findByText('Kiosk password');
  expect(dt.nextElementSibling?.textContent).toBe('Not set');
  cleanup();

  api.getInitiative.mockResolvedValue({ ...INITIATIVE, kiosk_password_set: true });
  renderPage();
  const dt2 = await screen.findByText('Kiosk password');
  expect(dt2.nextElementSibling?.textContent).toBe('Set');
});

it('a project has no kiosk password line, even for admins', async () => {
  auth.maxRank = ADMIN_RANK;
  api.getInitiative.mockResolvedValue({
    ...INITIATIVE, initiative_type: 'project', type_label: 'Project' });
  renderPage();
  await screen.findAllByText('Project');
  expect(screen.queryByText('Kiosk password')).toBeNull();
});

it('non-admins do not see the kiosk password line', async () => {
  renderPage();
  await screen.findByRole('tab', { name: 'Overview' });
  expect(screen.queryByText('Kiosk password')).toBeNull();
});

it('assets list: the Location cell links to the container and truck', async () => {
  const { MOVE_ASSET_COLUMNS } = await import('../lib/initiatives');
  prefs.list_prefs = { initiative_assets: {
    visible: ['asset_name', 'location'], seen: MOVE_ASSET_COLUMNS.map((c) => c.key),
    order: [], sortKey: 'asset_name', sortDir: 1,
  } };
  api.listInitiativeAssets.mockResolvedValue([{
    ...ASSET,
    asset: { ...ASSET.asset, container_id: 'c1', container_name: 'ATL1-W1M-DC-01', truck_id: 't1', truck_name: 'ATL1-T01' },
  }]);
  renderPage('assets');
  const row = await assetRow();
  expect(within(row).getByRole('link', { name: 'ATL1-W1M-DC-01' }).getAttribute('href'))
    .toBe('/logistics/containers?open=c1');
  expect(within(row).getByRole('link', { name: 'ATL1-T01' }).getAttribute('href'))
    .toBe('/logistics/trucks/t1');
});

it("assets list: a rack cell opens the rack view, whose Export PDF names the move", async () => {
  const user = userEvent.setup();
  api.listInitiativeAssets.mockResolvedValue([{ ...ASSET, source_ru: 10 }]);
  renderPage('assets');

  const row = await assetRow();
  await user.click(within(row).getByRole('button', { name: 'rack-a1' }));
  await user.click(screen.getByRole('button', { name: 'Export PDF' }));
  expect(rackPdf.exportRackPdf).toHaveBeenCalledWith(expect.objectContaining({
    moveName: 'NAP11 Hall Migration', rackName: 'rack-a1', sideLabel: 'Source',
  }));
});
