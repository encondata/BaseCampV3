// @vitest-environment jsdom
/**
 * /hardware/routers — Routers device-fleet directory list. Covers what a
 * unit test can see: seeded rows sorted by name, the disabled "Register
 * router" affordance, Delete gating + confirm + reload round trip, and
 * the load-error banner. Full toolbar/column-menu/reorder/CSV behavior
 * is exercised generically by lib/listTools.test.tsx and
 * lib/columnMenu.test.tsx — this file only covers Routers-specific wiring.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DeviceItem, UiPreferences } from '../lib/api';
import { LIST_FIT } from '../lib/listTools';

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
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: true, sound: 'chime' },
      list_prefs: {},
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

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.listDevices.mockResolvedValue(DEVICES);
  api.deleteDevice.mockResolvedValue(undefined);
  api.listDeviceLeases.mockResolvedValue([]);
  api.approveRouter.mockResolvedValue(DEVICES[0]);
  api.revokeRouter.mockResolvedValue(DEVICES[0]);
});

afterEach(cleanup);

const { default: Routers } = await import('./Routers');

function renderRouters(entry = '/hardware/routers') {
  return render(<MemoryRouter initialEntries={[entry]}><Routers /></MemoryRouter>);
}

it('routers list: column floors, shared template + minimum, sideways-scroll card', async () => {
  renderRouters();
  const row = (await screen.findByText('dock-router-1')).closest('.dir-row') as HTMLElement;
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

  expect(await screen.findByText('dock-router-1')).not.toBeNull();
  expect(screen.getByText('zebra-router-2')).not.toBeNull();
  expect(screen.getByText('203.0.113.14')).not.toBeNull();
  expect(screen.getByText('192.168.8.1')).not.toBeNull();
  expect(screen.getByText('203.0.113.22')).not.toBeNull();
  expect(screen.getByText('192.168.8.2')).not.toBeNull();
  expect(screen.getByText('94:83:C4:00:00:01')).not.toBeNull();
  expect(screen.getByText('94:83:C4:00:00:02')).not.toBeNull();
  expect(screen.getByText('12d 0h')).not.toBeNull();
  expect(screen.getByText('3h 12m')).not.toBeNull();

  expect(api.listDevices).toHaveBeenCalledWith('router');

  const names = screen.getAllByText(/dock-router-1|zebra-router-2/).map((n) => n.textContent);
  expect(names).toEqual(['dock-router-1', 'zebra-router-2']);
});

it('hides the row Actions menu entirely without change/delete rights', async () => {
  auth.can = () => false;
  renderRouters();
  await screen.findByText('dock-router-1');
  expect(screen.queryByRole('button', { name: /Actions/ })).toBeNull();
});

it('Delete from the row menu confirms, deletes and reloads', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('dock-router-1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(confirmSpy).toHaveBeenCalledWith('Delete "dock-router-1"? This cannot be undone.');
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

  const connectedRow = (await screen.findByText('chip-router-connected')).closest('.dir-row') as HTMLElement;
  expect(within(connectedRow).getByText('Up').className).toContain('c-green');

  const disconnectedRow = screen.getByText('chip-router-disconnected').closest('.dir-row') as HTMLElement;
  expect(within(disconnectedRow).getByText('Down').className).toContain('c-red');

  const healthyRow = screen.getByText('chip-router-healthy').closest('.dir-row') as HTMLElement;
  expect(within(healthyRow).queryByText('Up')).toBeNull(); // vpn null, unchipped
  expect(within(healthyRow).queryByText('Down')).toBeNull();
});

it('clicking a row toggles the expansion; opening the Actions menu does not open it', async () => {
  const user = userEvent.setup();
  renderRouters();
  await screen.findByText('dock-router-1');

  const row = screen.getByText('dock-router-1').closest('.dir-row') as HTMLElement;
  expect(row.className).not.toContain('open');

  await user.click(within(row).getByText('dock-router-1'));
  expect(row.className).toContain('open');

  await user.click(within(row).getByText('dock-router-1'));
  expect(row.className).not.toContain('open');

  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(row.className).not.toContain('open');
});

it('sorts the Name column naturally: numbers by value, case ignored, both directions', async () => {
  const named = (id: string, name: string): DeviceItem => ({ ...DEVICES[0], id, name, serial: id, mac: id });
  api.listDevices.mockResolvedValue([named('n10', 'Rack 10'), named('n2', 'Rack 2'), named('n1', 'rack 1')]);
  const user = userEvent.setup();
  renderRouters();
  await screen.findByText('Rack 10');
  const order = () => screen.getAllByText(/^(Rack 10|Rack 2|rack 1)$/).map((n) => n.textContent);
  const nameHeader = () => [...document.querySelectorAll<HTMLButtonElement>('.list-head button.sortable')]
    .find((b) => b.textContent?.trim().startsWith('Name')) as HTMLButtonElement;

  // Name ascending is the page default.
  expect(order()).toEqual(['rack 1', 'Rack 2', 'Rack 10']);
  await user.click(nameHeader());
  expect(order()).toEqual(['Rack 10', 'Rack 2', 'rack 1']);
  await user.click(nameHeader());
  expect(order()).toEqual(['rack 1', 'Rack 2', 'Rack 10']);
});

it('shows Approval chips with the secret-changed badge, and Status', async () => {
  renderRouters();
  const approved = (await screen.findByText('dock-router-1')).closest('.dir-row') as HTMLElement;
  expect(within(approved).getByText('Approved').className).toContain('c-green');
  const pending = screen.getByText('zebra-router-2').closest('.dir-row') as HTMLElement;
  expect(within(pending).getByText('Pending').className).toContain('c-amber');
  expect(within(pending).getByText('Secret changed')).toBeTruthy();
  // both fixtures were last seen long ago
  expect(within(approved).getByText('Offline')).toBeTruthy();
});

it('Approve on a pending row confirms with MAC/model/IP and calls approveRouter', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('zebra-router-2')).closest('.dir-row') as HTMLElement;
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
  const row = (await screen.findByText('zebra-router-2')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Approve' }));
  expect(confirmSpy).toHaveBeenCalledWith(
    '"zebra-router-2" was approved, then reported with a different secret. '
    + 'Approving now trusts that new secret. If the router itself wasn\'t reset or '
    + 'reinstalled, don\'t approve: it restores itself the next time it checks in '
    + 'with its approved secret. Approve anyway?');
  expect(api.approveRouter).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

it('Revoke on an approved row', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('dock-router-1')).closest('.dir-row') as HTMLElement;
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
  const row = (await screen.findByText('dock-router-1')).closest('.dir-row') as HTMLElement;
  expect(within(row).getByText('Secret changed').getAttribute('title')).toBe(
    'A report with a different secret was seen; the router has since proved itself with its approved secret.');
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Revoke' })).toBeTruthy();
  await user.click(screen.getByRole('menuitem', { name: 'Dismiss warning' }));
  expect(confirmSpy).toHaveBeenCalledWith(
    'Dismiss the "Secret changed" warning on "dock-router-1"? '
    + 'It is reporting with its approved secret again.');
  await waitFor(() => expect(api.approveRouter).toHaveBeenCalledWith('d1'));
  confirmSpy.mockRestore();
});

it('an approved row without a mismatch has no Dismiss warning', async () => {
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('dock-router-1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Revoke' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Dismiss warning' })).toBeNull();
});

it('cancelling the confirm does nothing', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('zebra-router-2')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Approve' }));
  expect(api.approveRouter).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

it('change rights without delete: Approve/Revoke but no Delete', async () => {
  auth.can = (_r, action) => action !== 'delete';
  const user = userEvent.setup();
  renderRouters();
  const row = (await screen.findByText('dock-router-1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Revoke' })).toBeTruthy();
  expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
});

it('How to add a router opens the install modal', async () => {
  const user = userEvent.setup();
  renderRouters();
  await screen.findByText('dock-router-1');
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
  const d2 = screen.getByText('zebra-router-2').closest('.dir-row') as HTMLElement;
  await user.click(d2.querySelector('.row-main') as HTMLElement);
  expect(screen.queryByText(held)).toBeNull();
  const d1 = screen.getByText('dock-router-1').closest('.dir-row') as HTMLElement;
  await user.click(within(d1).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Revoke' }));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByText(held)).toBeNull();
  confirmSpy.mockRestore();
});
