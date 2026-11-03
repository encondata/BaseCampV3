// @vitest-environment jsdom
/**
 * /hardware/routers — Routers device-fleet directory list. Covers what a
 * unit test can see: seeded rows sorted by name, the disabled "Register
 * router" affordance, Delete gating + confirm + reload round trip, the
 * load-error banner, and Watch / Stop watching in an approved router's row
 * menu. Full toolbar/column-menu/reorder/CSV behavior
 * is exercised generically by lib/listTools.test.tsx and
 * lib/columnMenu.test.tsx — this file only covers Routers-specific wiring.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DeviceItem, UiPreferences, Watch } from '../lib/api';
import { LIST_FIT } from '../lib/listTools';

const auth = vi.hoisted(() => {
  const state: {
    can: (resource: string, action: string) => boolean;
    /** The saved list layouts (preferences.list_prefs) the page opens with. */
    listPrefs: Record<string, unknown>;
  } = {
    can: () => true,
    listPrefs: {},
  };
  return state;
});

const updatePreferences = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', list_view: 'expanded',
      notif: { sound: 'chime', switches: {}, schedule: { timezone: null, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], quiet_start: null, quiet_end: null } },
      list_prefs: auth.listPrefs,
    } satisfies UiPreferences,
    updatePreferences,
  }),
}));

const api = vi.hoisted(() => ({
  listDevices: vi.fn(),
  deleteDevice: vi.fn(),
  listDeviceLeases: vi.fn(),
  approveRouter: vi.fn(),
  revokeRouter: vi.fn(),
  listMyWatches: vi.fn(),
  createMyWatch: vi.fn(),
  deleteMyWatch: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const DEVICES: DeviceItem[] = [
  {
    id: 'd2', device_type: 'router', name: 'zebra-router-2',
    serial: 'GL-MT300N-Z2', mac: '94:83:C4:00:00:02',
    site_id: 's2', site_name: 'NAP 22',
    wan_ip: '203.0.113.22', lan_ip: '192.168.8.2',
    uptime_seconds: 3 * 3600 + 12 * 60, last_seen_at: '2026-08-31T10:00:00Z',
    raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
    vpn_status: 'down', token_expires_at: '2026-11-29T00:00:00Z', connected_count: 2,
    approval_state: 'pending', secret_mismatch: true, agent_source_ip: '203.0.113.22',
    model: null, antennas_connected: null, connection_type: null,
    scan_status: null, scan_status_label: null, scan_status_color: null,
    tags_read_24h: 0,
    version: null, sub_type: null,
    current_initiative_id: null, current_initiative_name: null,
    session_person_id: null, session_person_name: null,
    session_login_method: null, session_started_at: null,
    setup_clear_requested_at: null, setup_clear_requested_by_name: null,
  },
  {
    id: 'd1', device_type: 'router', name: 'dock-router-1',
    serial: 'GL-MT300N-A1', mac: '94:83:C4:00:00:01',
    site_id: 's1', site_name: 'NAP 11',
    wan_ip: '203.0.113.14', lan_ip: '192.168.8.1',
    uptime_seconds: 1_036_800, last_seen_at: '2026-08-31T09:00:00Z',
    raw_info: {}, registered_at: '2026-08-18T10:00:00Z',
    vpn_status: 'up', token_expires_at: '2026-08-30T00:00:00Z', connected_count: 5,
    approval_state: 'approved', secret_mismatch: false, agent_source_ip: '203.0.113.14',
    model: 'GL.iNet GL-MT3000', antennas_connected: null, connection_type: null,
    scan_status: null, scan_status_label: null, scan_status_color: null,
    tags_read_24h: 0,
    version: null, sub_type: null,
    current_initiative_id: null, current_initiative_name: null,
    session_person_id: null, session_person_name: null,
    session_login_method: null, session_started_at: null,
    setup_clear_requested_at: null, setup_clear_requested_by_name: null,
  },
];

/** The person's own watch of the approved router (d1). */
const WATCH_D1: Watch = {
  id: 'w1', thing: 'device', thing_id: 'd1', thing_name: 'dock-router-1',
  link: '/hardware/routers?focus=d1', kinds: [], via: { type: 'you', id: null, name: null },
  created_at: '2026-11-02T12:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no scrollIntoView; ?focus= scrolls its row into view
  Element.prototype.scrollIntoView = vi.fn();
  auth.can = () => true;
  auth.listPrefs = {};
  api.listDevices.mockResolvedValue(DEVICES);
  api.deleteDevice.mockResolvedValue(undefined);
  api.listDeviceLeases.mockResolvedValue([]);
  api.approveRouter.mockResolvedValue(DEVICES[0]);
  api.revokeRouter.mockResolvedValue(DEVICES[0]);
  api.listMyWatches.mockResolvedValue([]);
  api.createMyWatch.mockResolvedValue(WATCH_D1);
  api.deleteMyWatch.mockResolvedValue(undefined);
});

afterEach(cleanup);

const { default: Routers } = await import('./Routers');

function renderRouters(entry = '/hardware/routers') {
  return render(<MemoryRouter initialEntries={[entry]}><Routers /></MemoryRouter>);
}

it('routers list: column floors, shared template + minimum, sideways-scroll card', async () => {
  renderRouters();
  const row = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

it('renders seeded rows sorted by name asc with WAN/LAN IPs, MAC, serial, and humanized uptime', async () => {
  renderRouters();

  expect(await screen.findByText('Dock Router 1')).not.toBeNull();
  expect(screen.getByText('Zebra Router 2')).not.toBeNull();
  expect(screen.getByText('203.0.113.14')).not.toBeNull();
  expect(screen.getByText('192.168.8.1')).not.toBeNull();
  expect(screen.getByText('203.0.113.22')).not.toBeNull();
  expect(screen.getByText('192.168.8.2')).not.toBeNull();
  expect(screen.getByText('94:83:C4:00:00:01')).not.toBeNull();
  expect(screen.getByText('94:83:C4:00:00:02')).not.toBeNull();
  expect(screen.getByText('12d 0h')).not.toBeNull();
  expect(screen.getByText('3h 12m')).not.toBeNull();

  expect(api.listDevices).toHaveBeenCalledWith('router');

  const names = screen.getAllByText(/Dock Router 1|Zebra Router 2/).map((n) => n.textContent);
  expect(names).toEqual(['Dock Router 1', 'Zebra Router 2']);
});

it('without change/delete rights only an approved router has a row menu, and it holds only Watch', async () => {
  auth.can = () => false;
  const user = userEvent.setup();
  renderRouters();
  const approved = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  const pending = screen.getByText('Zebra Router 2').closest('.dir-row') as HTMLElement;
  expect(within(pending).queryByRole('button', { name: /Actions/ })).toBeNull();
  expect(screen.getAllByRole('button', { name: /Actions/ })).toHaveLength(1);

  await user.click(within(approved).getByRole('button', { name: /Actions/ }));
  expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Watch']);
});

it('Delete from the row menu confirms, deletes and reloads', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(confirmSpy).toHaveBeenCalledWith('Delete "Dock Router 1"? This cannot be undone.');
  await waitFor(() => expect(api.deleteDevice).toHaveBeenCalledWith('d1'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
  confirmSpy.mockRestore();
});

it('shows the load-error banner when listDevices rejects', async () => {
  api.listDevices.mockRejectedValue(new Error('boom'));
  renderRouters();

  expect(await screen.findByText(/Couldn.t load routers/i)).not.toBeNull();
});

it('renders VPN chips per state', async () => {
  const CHIP_DEVICES: DeviceItem[] = [
    {
      id: 'c1', device_type: 'router', name: 'chip-router-connected',
      serial: 'GL-1', mac: '94:83:C4:00:01:01',
      site_id: 's1', site_name: 'NAP 11',
      wan_ip: '203.0.113.1', lan_ip: '192.168.8.1',
      uptime_seconds: 100, last_seen_at: '2026-08-31T10:00:00Z',
      raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
      vpn_status: 'up', connected_count: 3,
      token_expires_at: null,
      model: null, antennas_connected: null, connection_type: null,
      scan_status: null, scan_status_label: null, scan_status_color: null,
      tags_read_24h: 0,
      version: null, sub_type: null,
      current_initiative_id: null, current_initiative_name: null,
      session_person_id: null, session_person_name: null,
      session_login_method: null, session_started_at: null,
      setup_clear_requested_at: null, setup_clear_requested_by_name: null,
    },
    {
      id: 'c2', device_type: 'router', name: 'chip-router-disconnected',
      serial: 'GL-2', mac: '94:83:C4:00:01:02',
      site_id: 's2', site_name: 'NAP 22',
      wan_ip: '203.0.113.2', lan_ip: '192.168.8.2',
      uptime_seconds: 100, last_seen_at: '2026-08-31T10:00:00Z',
      raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
      vpn_status: 'down', connected_count: 0,
      token_expires_at: null,
      model: null, antennas_connected: null, connection_type: null,
      scan_status: null, scan_status_label: null, scan_status_color: null,
      tags_read_24h: 0,
      version: null, sub_type: null,
      current_initiative_id: null, current_initiative_name: null,
      session_person_id: null, session_person_name: null,
      session_login_method: null, session_started_at: null,
      setup_clear_requested_at: null, setup_clear_requested_by_name: null,
    },
    {
      id: 'c3', device_type: 'router', name: 'chip-router-healthy',
      serial: 'GL-3', mac: '94:83:C4:00:01:03',
      site_id: 's1', site_name: 'NAP 11',
      wan_ip: '203.0.113.3', lan_ip: '192.168.8.3',
      uptime_seconds: 100, last_seen_at: '2026-08-31T10:00:00Z',
      raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
      vpn_status: null, connected_count: 1,
      token_expires_at: null,
      model: null, antennas_connected: null, connection_type: null,
      scan_status: null, scan_status_label: null, scan_status_color: null,
      tags_read_24h: 0,
      version: null, sub_type: null,
      current_initiative_id: null, current_initiative_name: null,
      session_person_id: null, session_person_name: null,
      session_login_method: null, session_started_at: null,
      setup_clear_requested_at: null, setup_clear_requested_by_name: null,
    },
  ];
  api.listDevices.mockResolvedValue(CHIP_DEVICES);
  renderRouters();

  const connectedRow = (await screen.findByText('Chip Router Connected')).closest('.dir-row') as HTMLElement;
  expect(within(connectedRow).getByText('Up').className).toContain('c-green');

  const disconnectedRow = screen.getByText('Chip Router Disconnected').closest('.dir-row') as HTMLElement;
  expect(within(disconnectedRow).getByText('Down').className).toContain('c-red');

  const healthyRow = screen.getByText('Chip Router Healthy').closest('.dir-row') as HTMLElement;
  expect(within(healthyRow).queryByText('Up')).toBeNull(); // vpn null, unchipped
  expect(within(healthyRow).queryByText('Down')).toBeNull();
});

it('clicking a row toggles the expansion; opening the Actions menu does not open it', async () => {
  const user = userEvent.setup();
  renderRouters();
  await screen.findByText('Dock Router 1');

  const row = screen.getByText('Dock Router 1').closest('.dir-row') as HTMLElement;
  expect(row.className).not.toContain('open');

  await user.click(within(row).getByText('Dock Router 1'));
  expect(row.className).toContain('open');

  await user.click(within(row).getByText('Dock Router 1'));
  expect(row.className).not.toContain('open');

  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(row.className).not.toContain('open');
});

// Names show title-cased (routerDisplayName), so 'rack 1' renders as 'Rack 1'; the numeric order is what this pins.
it('sorts the Name column naturally: numbers by value, both directions', async () => {
  const named = (id: string, name: string): DeviceItem => ({ ...DEVICES[0], id, name, serial: id, mac: id });
  api.listDevices.mockResolvedValue([named('n10', 'Rack 10'), named('n2', 'Rack 2'), named('n1', 'rack 1')]);
  const user = userEvent.setup();
  renderRouters();
  await screen.findByText('Rack 10');
  const order = () => screen.getAllByText(/^Rack (10|2|1)$/).map((n) => n.textContent);
  const nameHeader = () => [...document.querySelectorAll<HTMLButtonElement>('.list-head button.sortable')]
    .find((b) => b.textContent?.trim().startsWith('Name')) as HTMLButtonElement;

  // Name ascending is the page default.
  expect(order()).toEqual(['Rack 1', 'Rack 2', 'Rack 10']);
  await user.click(nameHeader());
  expect(order()).toEqual(['Rack 10', 'Rack 2', 'Rack 1']);
  await user.click(nameHeader());
  expect(order()).toEqual(['Rack 1', 'Rack 2', 'Rack 10']);
});

it('shows Approval chips with the secret-changed badge, and Status', async () => {
  renderRouters();
  const approved = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  expect(within(approved).getByText('Approved').className).toContain('c-green');
  const pending = screen.getByText('Zebra Router 2').closest('.dir-row') as HTMLElement;
  expect(within(pending).getByText('Pending').className).toContain('c-amber');
  expect(within(pending).getByText('Secret changed')).toBeTruthy();
  // both fixtures were last seen long ago
  expect(within(approved).getByText('Offline')).toBeTruthy();
});

it('Approve on a pending row confirms with MAC/model/IP and calls approveRouter', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Zebra Router 2')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.queryByRole('menuitem', { name: 'Revoke' })).toBeNull();
  await user.click(screen.getByRole('menuitem', { name: 'Approve' }));
  expect(confirmSpy.mock.calls[0][0]).toContain('94:83:C4:00:00:02');
  expect(confirmSpy.mock.calls[0][0]).toContain('203.0.113.22');
  await waitFor(() => expect(api.approveRouter).toHaveBeenCalledWith('d2'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
  confirmSpy.mockRestore();
});

it('Approve on a knocked-down router (approved before, now pending with a mismatch) warns first', async () => {
  api.listDevices.mockResolvedValue([
    { ...DEVICES[0], approved_at: '2026-08-20T10:00:00Z' }, DEVICES[1]]);
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Zebra Router 2')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Approve' }));
  expect(confirmSpy).toHaveBeenCalledWith(
    '"Zebra Router 2" was approved, then reported with a different secret. '
    + 'Approving now trusts that new secret. If the router itself wasn\'t reset or '
    + 'reinstalled, don\'t approve: it restores itself the next time it checks in '
    + 'with its approved secret. Approve anyway?');
  expect(api.approveRouter).not.toHaveBeenCalled();
  confirmSpy.mockReturnValue(true);
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Approve' }));
  await waitFor(() => expect(api.approveRouter).toHaveBeenCalledWith('d2'));
  confirmSpy.mockRestore();
});

it('Revoke on an approved row', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.queryByRole('menuitem', { name: 'Approve' })).toBeNull();
  await user.click(screen.getByRole('menuitem', { name: 'Revoke' }));
  await waitFor(() => expect(api.revokeRouter).toHaveBeenCalledWith('d1'));
  confirmSpy.mockRestore();
});

it('an approved row with a mismatch offers Dismiss warning, which confirms and approves', async () => {
  api.listDevices.mockResolvedValue([DEVICES[0], { ...DEVICES[1], secret_mismatch: true }]);
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  expect(within(row).getByText('Secret changed').getAttribute('title')).toBe(
    'A report with a different secret was seen; the router has since proved itself with its approved secret.');
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Revoke' })).toBeTruthy();
  await user.click(screen.getByRole('menuitem', { name: 'Dismiss warning' }));
  expect(confirmSpy).toHaveBeenCalledWith(
    'Dismiss the "Secret changed" warning on "Dock Router 1"? '
    + 'It is reporting with its approved secret again.');
  await waitFor(() => expect(api.approveRouter).toHaveBeenCalledWith('d1'));
  confirmSpy.mockRestore();
});

it('an approved row without a mismatch has no Dismiss warning', async () => {
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Revoke' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Dismiss warning' })).toBeNull();
});

it('cancelling the confirm does nothing', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Zebra Router 2')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Approve' }));
  expect(api.approveRouter).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

it('change rights without delete: Approve/Revoke but no Delete', async () => {
  auth.can = (_r, action) => action !== 'delete';
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Revoke' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
});

it('How to add a router opens the install modal', async () => {
  const user = userEvent.setup();
  renderRouters();
  await screen.findByText('Dock Router 1');
  await user.click(screen.getByRole('button', { name: 'How to add a router' }));
  expect(screen.getByRole('heading', { name: 'Add a router' })).toBeTruthy();
});

it('?focus=<id> opens that row', async () => {
  renderRouters('/hardware/routers?focus=d2');
  expect(await screen.findByText('Reports are held until this router is approved.')).toBeTruthy();
});

it('?focus applies once: a later reload does not re-open a collapsed row', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.listDevices.mockImplementation(async () => DEVICES.map((d) => ({ ...d }))); // new array per load
  const user = userEvent.setup();
  renderRouters('/hardware/routers?focus=d2');
  const held = 'Reports are held until this router is approved.';
  expect(await screen.findByText(held)).toBeTruthy();
  const d2 = screen.getByText('Zebra Router 2').closest('.dir-row') as HTMLElement;
  await user.click(d2.querySelector('.row-main') as HTMLElement);
  expect(screen.queryByText(held)).toBeNull();
  const d1 = screen.getByText('Dock Router 1').closest('.dir-row') as HTMLElement;
  await user.click(within(d1).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Revoke' }));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText(held)).toBeNull();
  confirmSpy.mockRestore();
});

it('?focus on a row a saved filter hides opens it once the filter is cleared', async () => {
  // the list opens with a saved Name filter that leaves only Dock Router 1
  auth.listPrefs = { 'hardware-routers': { filters: { name: { text: 'dock' } } } };
  const user = userEvent.setup();
  renderRouters('/hardware/routers?focus=d2');
  await screen.findByText('Dock Router 1');
  expect(screen.queryByText('Zebra Router 2')).toBeNull();
  const scroll = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  expect(scroll).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: /1 filter active/ }));
  expect(await screen.findByText('Reports are held until this router is approved.')).toBeTruthy();
  const row = screen.getByText('Zebra Router 2').closest('.dir-row') as HTMLElement;
  expect(row.className).toContain('open');
  expect(scroll).toHaveBeenCalledTimes(1);
  expect(scroll.mock.contexts[0]).toBe(row);
});

/** A router fixture with a given hostname. */
const routerNamed = (id: string, name: string): DeviceItem => (
  { ...DEVICES[1], id, name, serial: id, mac: id });

it('shows a router hostname readable, with the raw name on hover', async () => {
  api.listDevices.mockResolvedValue([routerNamed('k19', 'csg_router_kit_19')]);
  renderRouters();
  const cell = await screen.findByText('CSG Router Kit 19');
  expect(cell.getAttribute('title')).toBe('csg_router_kit_19');
  expect(screen.queryByText('csg_router_kit_19')).toBeNull();
});

it('search finds a router by its readable name or its raw hostname', async () => {
  api.listDevices.mockResolvedValue([
    routerNamed('k19', 'csg_router_kit_19'), routerNamed('dr2', 'dock_router_2')]);
  const user = userEvent.setup();
  renderRouters();
  await screen.findByText('CSG Router Kit 19');
  const box = screen.getByPlaceholderText('Filter this list…');

  await user.type(box, 'csg_router');
  expect(screen.getByText('CSG Router Kit 19')).toBeTruthy();
  expect(screen.queryByText('Dock Router 2')).toBeNull();

  await user.clear(box);
  await user.type(box, 'Router Kit 19');
  expect(screen.getByText('CSG Router Kit 19')).toBeTruthy();
  expect(screen.queryByText('Dock Router 2')).toBeNull();
});

it('confirm dialogs name the router readably', async () => {
  api.listDevices.mockResolvedValue([routerNamed('k19', 'csg_router_kit_19')]);
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('CSG Router Kit 19')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(confirmSpy).toHaveBeenCalledWith('Delete "CSG Router Kit 19"? This cannot be undone.');
  expect(api.deleteDevice).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

it('sorts by the readable name, not the raw hostname', async () => {
  // Raw hostnames sort dock_router_10 first ('_' before '.'); readable names sort
  // Dock Router 2 first. Only sorting by the readable name passes.
  api.listDevices.mockResolvedValue([
    routerNamed('r10', 'dock_router_10'), routerNamed('r2', 'dock.router.2')]);
  renderRouters();
  const ten = await screen.findByText('Dock Router 10');
  const two = screen.getByText('Dock Router 2');
  // Dock Router 2 precedes Dock Router 10 in document order (default sort is name ascending).
  expect(two.compareDocumentPosition(ten) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('the Name column filter lists and matches the readable name', async () => {
  api.listDevices.mockResolvedValue([
    routerNamed('k19', 'csg_router_kit_19'), routerNamed('dr2', 'dock_router_2')]);
  const user = userEvent.setup();
  renderRouters();
  await screen.findByText('CSG Router Kit 19');
  await user.click(screen.getByRole('button', { name: 'Name column menu' }));
  // The checklist offers readable values; the raw hostname appears nowhere as text.
  expect(screen.getAllByText('CSG Router Kit 19').length).toBeGreaterThan(1);
  expect(screen.getAllByText('Dock Router 2').length).toBeGreaterThan(1);
  expect(screen.queryByText('csg_router_kit_19')).toBeNull();
  // A text filter matches against the readable name ("router kit" has no underscores).
  await user.type(screen.getByPlaceholderText('Filter Name'), 'router kit');
  expect(screen.getAllByText('CSG Router Kit 19').length).toBeGreaterThan(0);
  expect(screen.queryByText('Dock Router 2')).toBeNull();
});

it('Revoke and plain Approve confirms start with the readable name', async () => {
  api.listDevices.mockResolvedValue([
    routerNamed('k19', 'csg_router_kit_19'),
    { ...DEVICES[0], id: 'p1', name: 'dock_router_2', serial: 'p1', mac: 'p1' },
  ]);
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const user = userEvent.setup();
  renderRouters();
  const approved = (await screen.findByText('CSG Router Kit 19')).closest('.dir-row') as HTMLElement;
  await user.click(within(approved).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Revoke' }));
  expect(confirmSpy.mock.calls[0][0]).toMatch(/^Revoke "CSG Router Kit 19"\?/);

  const pending = screen.getByText('Dock Router 2').closest('.dir-row') as HTMLElement;
  await user.click(within(pending).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Approve' }));
  expect(confirmSpy.mock.calls[1][0]).toMatch(/^Approve "Dock Router 2"\?/);
  confirmSpy.mockRestore();
});

it('exports the readable name plus a Hostname column', async () => {
  api.listDevices.mockResolvedValue([routerNamed('k19', 'csg_router_kit_19')]);
  let blob: Blob | null = null;
  const createUrl = vi.fn((b: Blob) => { blob = b; return 'blob:routers'; });
  const prevCreate = URL.createObjectURL, prevRevoke = URL.revokeObjectURL;
  URL.createObjectURL = createUrl as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const user = userEvent.setup();
  renderRouters();
  await screen.findByText('CSG Router Kit 19');
  await user.click(screen.getByRole('button', { name: /Export/ }));
  expect(createUrl).toHaveBeenCalledTimes(1);
  const text = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob as unknown as Blob);
  });
  const [header, row] = text.split('\n');
  const heads = header.split(',');
  const cells = row.split(',');
  expect(cells[heads.indexOf('Name')]).toBe('CSG Router Kit 19');
  expect(cells[heads.indexOf('Hostname')]).toBe('csg_router_kit_19');
  clickSpy.mockRestore();
  URL.createObjectURL = prevCreate;
  URL.revokeObjectURL = prevRevoke;
});

/* ── Watch / Stop watching in an approved router's row menu ─────────── */

/** The labels of the open menu's items, in order. */
const menuItems = () => screen.getAllByRole('menuitem').map((m) => m.textContent);

it('an approved router\'s menu starts with Watch, then the actions it always had', async () => {
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(menuItems()).toEqual(['Watch', 'Revoke', 'Delete']);
  expect(api.listMyWatches).toHaveBeenCalledTimes(1);
});

it('a click on Watch watches that router on every event, and the menu then reads Stop watching', async () => {
  api.listMyWatches.mockResolvedValueOnce([]).mockResolvedValue([WATCH_D1]);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Watch' }));

  await waitFor(() => expect(api.createMyWatch).toHaveBeenCalledWith(
    { thing: 'device', id: 'd1', kinds: [] }));
  expect(row.className).not.toContain('open');            // opening the menu is not a row click
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await waitFor(() => expect(menuItems()).toEqual(['Stop watching', 'Revoke', 'Delete']));
});

it('a router the person watches reads Stop watching first, and a click stops that watch', async () => {
  api.listMyWatches.mockResolvedValueOnce([WATCH_D1]).mockResolvedValue([]);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  await waitFor(() => expect(api.listMyWatches).toHaveBeenCalled());
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await waitFor(() => expect(menuItems()[0]).toBe('Stop watching'));
  expect(menuItems()).toEqual(['Stop watching', 'Revoke', 'Delete']);
  await user.click(screen.getByRole('menuitem', { name: 'Stop watching' }));

  await waitFor(() => expect(api.deleteMyWatch).toHaveBeenCalledWith('w1'));
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await waitFor(() => expect(menuItems()[0]).toBe('Watch'));
});

it('a group\'s watch of the router does not read as the person\'s own', async () => {
  // d1 is watched by a group only; d3 (the control) is watched by the person themselves
  api.listDevices.mockResolvedValue([
    DEVICES[1], { ...DEVICES[1], id: 'd3', name: 'old-router-3', serial: 'd3', mac: 'd3' }]);
  api.listMyWatches.mockResolvedValue([
    { ...WATCH_D1, id: 'w-group', via: { type: 'group', id: 'g1', name: 'Group A' } },
    { ...WATCH_D1, id: 'w3', thing_id: 'd3', thing_name: 'old-router-3' },
  ]);
  const user = userEvent.setup();
  renderRouters();
  const own = (await screen.findByText('Old Router 3')).closest('.dir-row') as HTMLElement;
  await user.click(within(own).getByRole('button', { name: /Actions/ }));
  await waitFor(() => expect(menuItems()[0]).toBe('Stop watching'));     // the list has landed
  await user.keyboard('{Escape}');

  const grouped = screen.getByText('Dock Router 1').closest('.dir-row') as HTMLElement;
  await user.click(within(grouped).getByRole('button', { name: /Actions/ }));
  expect(menuItems()[0]).toBe('Watch');
});

it('a pending router\'s menu has no watch action, and neither has a revoked one', async () => {
  api.listDevices.mockResolvedValue([
    DEVICES[0],                                                    // d2, pending
    { ...DEVICES[1], id: 'd3', name: 'old-router-3', serial: 'd3', mac: 'd3', approval_state: 'revoked' },
  ]);
  const user = userEvent.setup();
  renderRouters();
  const pending = (await screen.findByText('Zebra Router 2')).closest('.dir-row') as HTMLElement;
  await user.click(within(pending).getByRole('button', { name: /Actions/ }));
  expect(menuItems()).toEqual(['Approve', 'Delete']);
  await user.keyboard('{Escape}');

  const revoked = screen.getByText('Old Router 3').closest('.dir-row') as HTMLElement;
  await user.click(within(revoked).getByRole('button', { name: /Actions/ }));
  expect(menuItems()).toEqual(['Approve', 'Delete']);
  expect(screen.queryByRole('menuitem', { name: /Watch|Stop watching/ })).toBeNull();
});

it('a router with no approval state (not an agent) has no watch action', async () => {
  api.listDevices.mockResolvedValue([{ ...DEVICES[1], approval_state: null }]);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(menuItems()).toEqual(['Delete']);
});

it('the watch action is off while its change is on the way', async () => {
  let finish!: () => void;
  api.createMyWatch.mockReturnValue(new Promise((resolve) => { finish = () => resolve(WATCH_D1); }));
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('Dock Router 1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Watch' }));

  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect((screen.getByRole('menuitem', { name: 'Watch' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('menuitem', { name: 'Revoke' }) as HTMLButtonElement).disabled).toBe(false);

  finish();
  await waitFor(() => expect(
    (screen.getByRole('menuitem', { name: /Watch|Stop watching/ }) as HTMLButtonElement).disabled,
  ).toBe(false));
});
