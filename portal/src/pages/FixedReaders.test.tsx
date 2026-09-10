// @vitest-environment jsdom
/**
 * /hardware/fixed-readers — Fixed Readers device-fleet directory list.
 * Covers what a unit test can see: seeded rows sorted by name, the
 * disabled "Register reader" affordance, Delete gating + confirm +
 * reload round trip, and the load-error banner. Full toolbar/column-menu/
 * reorder/CSV behavior is exercised generically by lib/listTools.test.tsx
 * and lib/columnMenu.test.tsx — this file only covers FixedReaders-
 * specific wiring. Unlike Routers, there is no row expansion here.
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
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const DEVICES: DeviceItem[] = [
  {
    id: 'd2', device_type: 'fixed_reader', name: 'zebra-reader-2',
    serial: 'FX9600-S2', mac: '94:83:C4:00:01:02',
    site_id: 's2', site_name: 'NAP 22',
    wan_ip: null, lan_ip: '192.168.8.22',
    uptime_seconds: 3 * 3600 + 12 * 60, last_seen_at: '2026-08-31T10:00:00Z',
    raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
    vpn_status: null, token_expires_at: null, connected_count: 0,
    model: 'FX9600', antennas_connected: 4, connection_type: 'mqtt',
    scan_status: 'rfid_1_cage_exit', scan_status_label: 'RFID 1 - Cage Exit',
    scan_status_color: '#31F527', tags_read_24h: 152,
    version: null, sub_type: null,
    current_initiative_id: null, current_initiative_name: null,
  },
  {
    id: 'd1', device_type: 'fixed_reader', name: 'dock-reader-1',
    serial: 'FX9600-S1', mac: '94:83:C4:00:01:01',
    site_id: 's1', site_name: 'NAP 11',
    wan_ip: null, lan_ip: '192.168.8.11',
    uptime_seconds: 1_036_800, last_seen_at: '2026-08-31T09:00:00Z',
    raw_info: {}, registered_at: '2026-08-18T10:00:00Z',
    vpn_status: null, token_expires_at: null, connected_count: 0,
    model: 'FX9600', antennas_connected: 2, connection_type: 'api',
    scan_status: 'rfid_2_cage_entry', scan_status_label: 'RFID 2 - Cage Entry',
    scan_status_color: '#F5A623', tags_read_24h: 88,
    version: null, sub_type: null,
    current_initiative_id: null, current_initiative_name: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.listDevices.mockResolvedValue(DEVICES);
  api.deleteDevice.mockResolvedValue(undefined);
});

afterEach(cleanup);

const { default: FixedReaders } = await import('./FixedReaders');

it('renders seeded rows sorted by name asc with model, MAC, IP, uptime, tags, antennas, connection tag, and scan-status chip', async () => {
  render(<FixedReaders />);

  expect(await screen.findByText('dock-reader-1')).not.toBeNull();
  expect(screen.getByText('zebra-reader-2')).not.toBeNull();
  expect(screen.getAllByText('FX9600')).not.toHaveLength(0);
  expect(screen.getByText('94:83:C4:00:01:01')).not.toBeNull();
  expect(screen.getByText('94:83:C4:00:01:02')).not.toBeNull();
  expect(screen.getByText('192.168.8.11')).not.toBeNull();
  expect(screen.getByText('192.168.8.22')).not.toBeNull();
  expect(screen.getByText('12d 0h')).not.toBeNull();
  expect(screen.getByText('3h 12m')).not.toBeNull();
  expect(screen.getByText('88')).not.toBeNull();
  expect(screen.getByText('152')).not.toBeNull();
  expect(screen.getByText('2 / 8')).not.toBeNull();
  expect(screen.getByText('4 / 8')).not.toBeNull();
  expect(screen.getByText('API')).not.toBeNull();
  expect(screen.getByText('MQTT')).not.toBeNull();
  expect(screen.getByText('RFID 1 - Cage Exit')).not.toBeNull();
  expect(screen.getByText('RFID 2 - Cage Entry')).not.toBeNull();
  expect(screen.getByText('NAP 11')).not.toBeNull();
  expect(screen.getByText('NAP 22')).not.toBeNull();

  expect(api.listDevices).toHaveBeenCalledWith('fixed_reader');

  const names = screen.getAllByText(/dock-reader-1|zebra-reader-2/).map((n) => n.textContent);
  expect(names).toEqual(['dock-reader-1', 'zebra-reader-2']);
});

it('shows the Register reader button, present but disabled', async () => {
  render(<FixedReaders />);
  await screen.findByText('dock-reader-1');

  const btn = screen.getByRole('button', { name: /Register reader/i }) as HTMLButtonElement;
  expect(btn).not.toBeNull();
  expect(btn.disabled).toBe(true);
});

it('hides Delete when can(scanning_hardware, delete) is false', async () => {
  auth.can = () => false;
  render(<FixedReaders />);
  await screen.findByText('dock-reader-1');
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
});

it('clicking Delete + confirm calls deleteDevice and reloads', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  render(<FixedReaders />);
  await screen.findByText('dock-reader-1');

  const row = screen.getByText('dock-reader-1').closest('.dir-row') as HTMLElement;
  const deleteBtn = within(row).getByRole('button', { name: 'Delete' });
  await user.click(deleteBtn);

  expect(confirmSpy).toHaveBeenCalledWith('Delete "dock-reader-1"? This cannot be undone.');
  await waitFor(() => expect(api.deleteDevice).toHaveBeenCalledWith('d1'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));

  confirmSpy.mockRestore();
});

it('clicking Delete without confirm does not call deleteDevice', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const user = userEvent.setup();
  render(<FixedReaders />);
  await screen.findByText('dock-reader-1');

  const row = screen.getByText('dock-reader-1').closest('.dir-row') as HTMLElement;
  const deleteBtn = within(row).getByRole('button', { name: 'Delete' });
  await user.click(deleteBtn);

  expect(confirmSpy).toHaveBeenCalled();
  expect(api.deleteDevice).not.toHaveBeenCalled();

  confirmSpy.mockRestore();
});

it('shows the load-error banner when listDevices rejects', async () => {
  api.listDevices.mockRejectedValue(new Error('boom'));
  render(<FixedReaders />);

  expect(await screen.findByText(/Couldn.t load fixed readers/i)).not.toBeNull();
});
