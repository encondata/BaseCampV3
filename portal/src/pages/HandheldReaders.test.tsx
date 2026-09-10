// @vitest-environment jsdom
/**
 * /hardware/handheld-readers — Handheld Readers device-fleet directory
 * list. Copy of KioskDevices.test.tsx (model: pages/KioskDevices.tsx /
 * KioskDevices.test.tsx), adapted for handheld_reader devices and the
 * Android/iOS/Zebra sub-type set. Covers what a unit test can see: seeded
 * rows with the type tag and all registration-chip states, the
 * "+ New handheld" add-gate and create-modal open, contextual
 * Register/Renew/De-Register actions, the create flow's exact
 * device_type on the wire, and the load-error banner. Full
 * toolbar/column-menu/reorder/CSV behavior is exercised generically by
 * lib/listTools.test.tsx and lib/columnMenu.test.tsx — this file only
 * covers HandheldReaders-specific wiring. Registration-state fixtures
 * use time-proof offsets (±/well outside the 7-day "soon" window,
 * computed off Date.now()) rather than hardcoded dates, so they never
 * age into the wrong bucket.
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
  registerDevice: vi.fn(),
  deregisterDevice: vi.fn(),
  listInitiatives: vi.fn(),
  listStatusValues: vi.fn(),
  listSites: vi.fn(),
  createDevice: vi.fn(),
  patchDevice: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const YEAR = 365 * 24 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const now = Date.now();

function handheld(overrides: Partial<DeviceItem>): DeviceItem {
  return {
    id: 'd0', device_type: 'handheld_reader', name: 'handheld',
    serial: null, mac: '94:83:C4:00:03:00',
    site_id: 's1', site_name: 'NAP 11',
    wan_ip: null, lan_ip: '192.168.8.60',
    uptime_seconds: null, last_seen_at: '2026-08-31T10:00:00Z',
    raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
    vpn_status: null, token_expires_at: null, connected_count: 0,
    model: null, antennas_connected: null, connection_type: null,
    scan_status: 'idle', scan_status_label: 'Idle', scan_status_color: '#178a4c',
    tags_read_24h: 0,
    version: '2.4.1', sub_type: 'android',
    current_initiative_id: 'i1', current_initiative_name: 'NAP11 Hall Migration (demo)',
    ...overrides,
  };
}

const DEVICES: DeviceItem[] = [
  handheld({
    id: 'd2', name: 'handheld-android-2', sub_type: 'android',
    token_expires_at: new Date(now + 50 * YEAR).toISOString(), // ok
  }),
  handheld({
    id: 'd1', name: 'handheld-ios-1', sub_type: 'ios',
    token_expires_at: new Date(now + 3 * DAY).toISOString(), // soon
  }),
  handheld({
    id: 'd3', name: 'handheld-zebra-3', sub_type: 'zebra',
    token_expires_at: null, // none
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.listDevices.mockResolvedValue(DEVICES);
  api.deleteDevice.mockResolvedValue(undefined);
  api.registerDevice.mockResolvedValue(DEVICES[0]);
  api.deregisterDevice.mockResolvedValue(DEVICES[0]);
  api.listInitiatives.mockResolvedValue([]);
  api.listStatusValues.mockResolvedValue([]);
  api.listSites.mockResolvedValue([]);
});

afterEach(cleanup);

const { default: HandheldReaders } = await import('./HandheldReaders');

it('renders seeded rows with Android/iOS/Zebra type tags and registration chips for all states', async () => {
  render(<HandheldReaders />);

  expect(await screen.findByText('handheld-android-2')).not.toBeNull();
  expect(screen.getByText('handheld-ios-1')).not.toBeNull();
  expect(screen.getByText('handheld-zebra-3')).not.toBeNull();

  expect(api.listDevices).toHaveBeenCalledWith('handheld_reader');

  const androidRow = screen.getByText('handheld-android-2').closest('.dir-row') as HTMLElement;
  expect(within(androidRow).getByText('Android')).not.toBeNull();
  const okChip = within(androidRow).getByText('Registered');
  expect(okChip.className).toContain('c-green');

  const iosRow = screen.getByText('handheld-ios-1').closest('.dir-row') as HTMLElement;
  expect(within(iosRow).getByText('iOS')).not.toBeNull();
  const soonChip = within(iosRow).getByText('Expires soon');
  expect(soonChip.className).toContain('c-amber');

  const zebraRow = screen.getByText('handheld-zebra-3').closest('.dir-row') as HTMLElement;
  expect(within(zebraRow).getByText('Zebra')).not.toBeNull();
  const noneChip = within(zebraRow).getByText('Unregistered');
  expect(noneChip.className).toContain('tag');
});

it('hides "+ New handheld" without add, shows it and opens the create modal with add', async () => {
  auth.can = () => false;
  const { rerender } = render(<HandheldReaders />);
  await screen.findByText('handheld-android-2');
  expect(screen.queryByRole('button', { name: '+ New handheld' })).toBeNull();

  auth.can = () => true;
  rerender(<HandheldReaders />);
  const user = userEvent.setup();
  const addBtn = await screen.findByRole('button', { name: '+ New handheld' });
  await user.click(addBtn);

  expect(await screen.findByRole('heading', { name: 'New handheld' })).not.toBeNull();
});

it('contextual actions: unregistered row shows Register only; registered row shows Renew + De-Register', async () => {
  const REG_DEVICES: DeviceItem[] = [
    handheld({ id: 'u1', name: 'unregistered-handheld', token_expires_at: null }),
    handheld({ id: 'u2', name: 'registered-handheld', token_expires_at: new Date(now + 50 * YEAR).toISOString() }),
  ];
  api.listDevices.mockResolvedValue(REG_DEVICES);
  const user = userEvent.setup();
  render(<HandheldReaders />);

  // Menuitems are asserted via `screen`, not `within(row)`: RowActionsMenu
  // portals the open menu to document.body (escaping .dir-list's
  // overflow:hidden — see RowActionsMenu.tsx), so its items no longer sit
  // inside the row's DOM subtree once open. Only one row's menu is ever
  // open at a time here, so screen-level queries stay unambiguous.
  const unregRow = (await screen.findByText('unregistered-handheld')).closest('.dir-row') as HTMLElement;
  await user.click(within(unregRow).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Register' })).not.toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Renew' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'De-Register' })).toBeNull();
  await user.click(within(unregRow).getByRole('button', { name: /Actions/ })); // close

  const regRow = screen.getByText('registered-handheld').closest('.dir-row') as HTMLElement;
  await user.click(within(regRow).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Renew' })).not.toBeNull();
  expect(screen.getByRole('menuitem', { name: 'De-Register' })).not.toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Register' })).toBeNull();
});

it('create flow: fills name, submits, and posts device_type handheld_reader', async () => {
  api.createDevice.mockResolvedValue(handheld({ id: 'new-1', name: 'handheld-new' }));
  const user = userEvent.setup();
  render(<HandheldReaders />);
  await screen.findByText('handheld-android-2');

  await user.click(screen.getByRole('button', { name: '+ New handheld' }));
  await user.type(await screen.findByLabelText('Name'), 'handheld-new');
  await user.selectOptions(screen.getByLabelText('Type'), 'zebra');
  await user.click(screen.getByRole('button', { name: /Create handheld/i }));

  await waitFor(() => expect(api.createDevice).toHaveBeenCalledTimes(1));
  expect(api.createDevice).toHaveBeenCalledWith(expect.objectContaining({
    device_type: 'handheld_reader', name: 'handheld-new', sub_type: 'zebra',
  }));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
});

it('shows the load-error banner when listDevices rejects', async () => {
  api.listDevices.mockRejectedValue(new Error('boom'));
  render(<HandheldReaders />);

  expect(await screen.findByText(/Couldn.t load handheld readers/i)).not.toBeNull();
});
