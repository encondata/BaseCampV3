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
  },
  {
    id: 'd1', device_type: 'router', name: 'dock-router-1',
    serial: 'GL-MT300N-A1', mac: '94:83:C4:00:00:01',
    site_id: 's1', site_name: 'NAP 11',
    wan_ip: '203.0.113.14', lan_ip: '192.168.8.1',
    uptime_seconds: 1_036_800, last_seen_at: '2026-08-31T09:00:00Z',
    raw_info: {}, registered_at: '2026-08-18T10:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.listDevices.mockResolvedValue(DEVICES);
  api.deleteDevice.mockResolvedValue(undefined);
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
