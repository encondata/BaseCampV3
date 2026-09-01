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
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DeviceItem, UiPreferences } from '../lib/api';

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
      accent: 'blue', theme: 'dark', density: 'comfortable', motion: true,
      notif: { critical: true, email: true, maint: true, digest: true },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences,
  }),
}));

const api = vi.hoisted(() => ({
  listDevices: vi.fn(),
  deleteDevice: vi.fn(),
  listDeviceLeases: vi.fn(),
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
    vpn_status: 'disconnected', token_expires_at: '2026-11-29T00:00:00Z', connected_count: 2,
    model: null, antennas_connected: null, connection_type: null,
    scan_status: null, scan_status_label: null, scan_status_color: null,
    tags_read_24h: 0,
    version: null, kiosk_type: null,
    current_initiative_id: null, current_initiative_name: null,
  },
  {
    id: 'd1', device_type: 'router', name: 'dock-router-1',
    serial: 'GL-MT300N-A1', mac: '94:83:C4:00:00:01',
    site_id: 's1', site_name: 'NAP 11',
    wan_ip: '203.0.113.14', lan_ip: '192.168.8.1',
    uptime_seconds: 1_036_800, last_seen_at: '2026-08-31T09:00:00Z',
    raw_info: {}, registered_at: '2026-08-18T10:00:00Z',
    vpn_status: 'connected', token_expires_at: '2026-08-30T00:00:00Z', connected_count: 5,
    model: null, antennas_connected: null, connection_type: null,
    scan_status: null, scan_status_label: null, scan_status_color: null,
    tags_read_24h: 0,
    version: null, kiosk_type: null,
    current_initiative_id: null, current_initiative_name: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.listDevices.mockResolvedValue(DEVICES);
  api.deleteDevice.mockResolvedValue(undefined);
  api.listDeviceLeases.mockResolvedValue([]);
});

afterEach(cleanup);

const { default: Routers } = await import('./Routers');

it('renders seeded rows sorted by name asc with WAN/LAN IPs, MAC, serial, and humanized uptime', async () => {
  render(<Routers />);

  expect(await screen.findByText('dock-router-1')).not.toBeNull();
  expect(screen.getByText('zebra-router-2')).not.toBeNull();
  expect(screen.getByText('203.0.113.14')).not.toBeNull();
  expect(screen.getByText('192.168.8.1')).not.toBeNull();
  expect(screen.getByText('203.0.113.22')).not.toBeNull();
  expect(screen.getByText('192.168.8.2')).not.toBeNull();
  expect(screen.getByText('94:83:C4:00:00:01')).not.toBeNull();
  expect(screen.getByText('94:83:C4:00:00:02')).not.toBeNull();
  expect(screen.getByText('GL-MT300N-A1')).not.toBeNull();
  expect(screen.getByText('GL-MT300N-Z2')).not.toBeNull();
  expect(screen.getByText('12d 0h')).not.toBeNull();
  expect(screen.getByText('3h 12m')).not.toBeNull();

  expect(api.listDevices).toHaveBeenCalledWith('router');

  const names = screen.getAllByText(/dock-router-1|zebra-router-2/).map((n) => n.textContent);
  expect(names).toEqual(['dock-router-1', 'zebra-router-2']);
});

it('shows the Register router button, present but disabled', async () => {
  render(<Routers />);
  await screen.findByText('dock-router-1');

  const btn = screen.getByRole('button', { name: /Register router/i }) as HTMLButtonElement;
  expect(btn).not.toBeNull();
  expect(btn.disabled).toBe(true);
});

it('hides Delete when can(scanning_hardware, delete) is false', async () => {
  auth.can = () => false;
  render(<Routers />);
  await screen.findByText('dock-router-1');
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
});

it('clicking Delete + confirm calls deleteDevice and reloads', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  render(<Routers />);
  await screen.findByText('dock-router-1');

  const row = screen.getByText('dock-router-1').closest('.dir-row') as HTMLElement;
  const deleteBtn = within(row).getByRole('button', { name: 'Delete' });
  await user.click(deleteBtn);

  expect(confirmSpy).toHaveBeenCalledWith('Delete "dock-router-1"? This cannot be undone.');
  await waitFor(() => expect(api.deleteDevice).toHaveBeenCalledWith('d1'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));

  confirmSpy.mockRestore();
});

it('shows the load-error banner when listDevices rejects', async () => {
  api.listDevices.mockRejectedValue(new Error('boom'));
  render(<Routers />);

  expect(await screen.findByText(/Couldn.t load routers/i)).not.toBeNull();
});

it('renders VPN chips and token-expiry chips per state', async () => {
  const DAY = 24 * 3600 * 1000;
  const CHIP_DEVICES: DeviceItem[] = [
    {
      id: 'c1', device_type: 'router', name: 'chip-router-connected',
      serial: 'GL-1', mac: '94:83:C4:00:01:01',
      site_id: 's1', site_name: 'NAP 11',
      wan_ip: '203.0.113.1', lan_ip: '192.168.8.1',
      uptime_seconds: 100, last_seen_at: '2026-08-31T10:00:00Z',
      raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
      vpn_status: 'connected', connected_count: 3,
      token_expires_at: new Date(Date.now() - DAY).toISOString(), // expired
      model: null, antennas_connected: null, connection_type: null,
      scan_status: null, scan_status_label: null, scan_status_color: null,
      tags_read_24h: 0,
      version: null, kiosk_type: null,
      current_initiative_id: null, current_initiative_name: null,
    },
    {
      id: 'c2', device_type: 'router', name: 'chip-router-disconnected',
      serial: 'GL-2', mac: '94:83:C4:00:01:02',
      site_id: 's2', site_name: 'NAP 22',
      wan_ip: '203.0.113.2', lan_ip: '192.168.8.2',
      uptime_seconds: 100, last_seen_at: '2026-08-31T10:00:00Z',
      raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
      vpn_status: 'disconnected', connected_count: 0,
      token_expires_at: new Date(Date.now() + 3 * DAY).toISOString(), // soon
      model: null, antennas_connected: null, connection_type: null,
      scan_status: null, scan_status_label: null, scan_status_color: null,
      tags_read_24h: 0,
      version: null, kiosk_type: null,
      current_initiative_id: null, current_initiative_name: null,
    },
    {
      id: 'c3', device_type: 'router', name: 'chip-router-healthy',
      serial: 'GL-3', mac: '94:83:C4:00:01:03',
      site_id: 's1', site_name: 'NAP 11',
      wan_ip: '203.0.113.3', lan_ip: '192.168.8.3',
      uptime_seconds: 100, last_seen_at: '2026-08-31T10:00:00Z',
      raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
      vpn_status: null, connected_count: 1,
      token_expires_at: new Date(Date.now() + 60 * DAY).toISOString(), // healthy
      model: null, antennas_connected: null, connection_type: null,
      scan_status: null, scan_status_label: null, scan_status_color: null,
      tags_read_24h: 0,
      version: null, kiosk_type: null,
      current_initiative_id: null, current_initiative_name: null,
    },
  ];
  api.listDevices.mockResolvedValue(CHIP_DEVICES);
  render(<Routers />);

  const connectedRow = (await screen.findByText('chip-router-connected')).closest('.dir-row') as HTMLElement;
  expect(within(connectedRow).getByText('Connected')).not.toBeNull();
  expect(within(connectedRow).getByText('expired')).not.toBeNull();
  expect(within(connectedRow).getByText('expired').className).toContain('c-red');

  const disconnectedRow = screen.getByText('chip-router-disconnected').closest('.dir-row') as HTMLElement;
  expect(within(disconnectedRow).getByText('Disconnected')).not.toBeNull();
  const amberChip = disconnectedRow.querySelector('.chip.c-amber');
  expect(amberChip).not.toBeNull();

  const healthyRow = screen.getByText('chip-router-healthy').closest('.dir-row') as HTMLElement;
  expect(within(healthyRow).getByText('—')).not.toBeNull(); // vpn null, unchipped
  const healthyText = new Date(CHIP_DEVICES[2].token_expires_at!).toLocaleDateString();
  expect(within(healthyRow).getByText(healthyText)).not.toBeNull();
});

it('clicking a row toggles the expansion; clicking Delete does not open it', async () => {
  const user = userEvent.setup();
  render(<Routers />);
  await screen.findByText('dock-router-1');

  const row = screen.getByText('dock-router-1').closest('.dir-row') as HTMLElement;
  expect(row.className).not.toContain('open');

  await user.click(within(row).getByText('dock-router-1'));
  expect(row.className).toContain('open');
  await waitFor(() => expect(api.listDeviceLeases).toHaveBeenCalledWith('d1'));

  await user.click(within(row).getByText('dock-router-1'));
  expect(row.className).not.toContain('open');

  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const deleteBtn = within(row).getByRole('button', { name: 'Delete' });
  await user.click(deleteBtn);
  expect(confirmSpy).toHaveBeenCalled();
  expect(row.className).not.toContain('open');
  expect(api.deleteDevice).not.toHaveBeenCalled();

  confirmSpy.mockRestore();
});
