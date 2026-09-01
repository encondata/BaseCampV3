// @vitest-environment jsdom
/**
 * /hardware/kiosks — Kiosk Devices device-fleet directory list. Covers
 * what a unit test can see: seeded rows with the type tag, all four
 * registration-chip states, current-move name, and scan-type chip; the
 * "+ New kiosk" add-gate; contextual Register/Renew/De-Register actions
 * per row's registration state; the Register flow round trip; and the
 * load-error banner. Full toolbar/column-menu/reorder/CSV behavior is
 * exercised generically by lib/listTools.test.tsx and
 * lib/columnMenu.test.tsx — this file only covers KioskDevices-specific
 * wiring. Registration-state fixtures use time-proof offsets (±/well
 * outside the 7-day "soon" window, computed off Date.now()) rather than
 * hardcoded dates, so they never age into the wrong bucket.
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

function kiosk(overrides: Partial<DeviceItem>): DeviceItem {
  return {
    id: 'd0', device_type: 'kiosk', name: 'kiosk',
    serial: null, mac: '94:83:C4:00:02:00',
    site_id: 's1', site_name: 'NAP 11',
    wan_ip: null, lan_ip: '192.168.8.40',
    uptime_seconds: null, last_seen_at: '2026-08-31T10:00:00Z',
    raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
    vpn_status: null, token_expires_at: null, connected_count: 0,
    model: null, antennas_connected: null, connection_type: null,
    scan_status: 'idle', scan_status_label: 'Idle', scan_status_color: '#178a4c',
    tags_read_24h: 0,
    version: '2.4.1', sub_type: 'pi',
    current_initiative_id: 'i1', current_initiative_name: 'NAP11 Hall Migration (demo)',
    ...overrides,
  };
}

const DEVICES: DeviceItem[] = [
  kiosk({
    id: 'd2', name: 'kiosk-lobby-2',
    token_expires_at: new Date(now + 50 * YEAR).toISOString(), // ok
  }),
  kiosk({
    id: 'd1', name: 'kiosk-dock-1',
    token_expires_at: new Date(now + 3 * DAY).toISOString(), // soon
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

const { default: KioskDevices } = await import('./KioskDevices');

it('renders seeded rows sorted by name asc, with the type tag, current move, and scan-type chip', async () => {
  render(<KioskDevices />);

  expect(await screen.findByText('kiosk-dock-1')).not.toBeNull();
  expect(screen.getByText('kiosk-lobby-2')).not.toBeNull();
  expect(screen.getAllByText('Pi')).not.toHaveLength(0);
  expect(screen.getAllByText('NAP11 Hall Migration (demo)')).not.toHaveLength(0);
  expect(screen.getAllByText('Idle')).not.toHaveLength(0);

  expect(api.listDevices).toHaveBeenCalledWith('kiosk');

  const names = screen.getAllByText(/kiosk-dock-1|kiosk-lobby-2/).map((n) => n.textContent);
  expect(names).toEqual(['kiosk-dock-1', 'kiosk-lobby-2']);
});

it('renders registration chips for all four states', async () => {
  const REG_DEVICES: DeviceItem[] = [
    kiosk({ id: 'r1', name: 'reg-ok', token_expires_at: new Date(now + 50 * YEAR).toISOString() }),
    kiosk({ id: 'r2', name: 'reg-soon', token_expires_at: new Date(now + 3 * DAY).toISOString() }),
    kiosk({ id: 'r3', name: 'reg-expired', token_expires_at: new Date(now - 50 * YEAR).toISOString() }),
    kiosk({ id: 'r4', name: 'reg-none', token_expires_at: null }),
  ];
  api.listDevices.mockResolvedValue(REG_DEVICES);
  render(<KioskDevices />);

  const okRow = (await screen.findByText('reg-ok')).closest('.dir-row') as HTMLElement;
  const okChip = within(okRow).getByText('Registered');
  expect(okChip.className).toContain('c-green');

  const soonRow = screen.getByText('reg-soon').closest('.dir-row') as HTMLElement;
  const soonChip = within(soonRow).getByText('Expires soon');
  expect(soonChip.className).toContain('c-amber');

  const expiredRow = screen.getByText('reg-expired').closest('.dir-row') as HTMLElement;
  const expiredChip = within(expiredRow).getByText('Expired');
  expect(expiredChip.className).toContain('c-red');

  const noneRow = screen.getByText('reg-none').closest('.dir-row') as HTMLElement;
  const noneChip = within(noneRow).getByText('Unregistered');
  expect(noneChip.className).toContain('tag');
});

it('hides "+ New kiosk" without add, shows it and opens the create modal with add', async () => {
  auth.can = () => false;
  const { rerender } = render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');
  expect(screen.queryByRole('button', { name: '+ New kiosk' })).toBeNull();

  auth.can = () => true;
  rerender(<KioskDevices />);
  const user = userEvent.setup();
  const addBtn = await screen.findByRole('button', { name: '+ New kiosk' });
  await user.click(addBtn);

  expect(await screen.findByRole('heading', { name: 'New kiosk' })).not.toBeNull();
});

it('contextual actions: unregistered row shows Register only; registered row shows Renew + De-Register', async () => {
  const REG_DEVICES: DeviceItem[] = [
    kiosk({ id: 'u1', name: 'unregistered-kiosk', token_expires_at: null }),
    kiosk({ id: 'u2', name: 'registered-kiosk', token_expires_at: new Date(now + 50 * YEAR).toISOString() }),
  ];
  api.listDevices.mockResolvedValue(REG_DEVICES);
  const user = userEvent.setup();
  render(<KioskDevices />);

  // Menuitems are asserted via `screen`, not `within(row)`: RowActionsMenu
  // portals the open menu to document.body (escaping .dir-list's
  // overflow:hidden — see RowActionsMenu.tsx), so its items no longer sit
  // inside the row's DOM subtree once open. Only one row's menu is ever
  // open at a time here, so screen-level queries stay unambiguous.
  const unregRow = (await screen.findByText('unregistered-kiosk')).closest('.dir-row') as HTMLElement;
  await user.click(within(unregRow).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Register' })).not.toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Renew' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'De-Register' })).toBeNull();
  await user.click(within(unregRow).getByRole('button', { name: /Actions/ })); // close

  const regRow = screen.getByText('registered-kiosk').closest('.dir-row') as HTMLElement;
  await user.click(within(regRow).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Renew' })).not.toBeNull();
  expect(screen.getByRole('menuitem', { name: 'De-Register' })).not.toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Register' })).toBeNull();
});

it('Register flow: click Register, confirm the days modal, calls registerDevice and reloads', async () => {
  const REG_DEVICES: DeviceItem[] = [
    kiosk({ id: 'u1', name: 'unregistered-kiosk', token_expires_at: null }),
  ];
  api.listDevices.mockResolvedValue(REG_DEVICES);
  const user = userEvent.setup();
  render(<KioskDevices />);

  const row = (await screen.findByText('unregistered-kiosk')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  // Portaled to document.body once open — see the comment above.
  await user.click(screen.getByRole('menuitem', { name: 'Register' }));

  expect(await screen.findByRole('heading', { name: /Register unregistered-kiosk/ })).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'Confirm' }));

  await waitFor(() => expect(api.registerDevice).toHaveBeenCalledWith('u1', 30));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
});

it('De-Register: confirm calls deregisterDevice and reloads', async () => {
  const REG_DEVICES: DeviceItem[] = [
    kiosk({ id: 'u2', name: 'registered-kiosk', token_expires_at: new Date(now + 50 * YEAR).toISOString() }),
  ];
  api.listDevices.mockResolvedValue(REG_DEVICES);
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  render(<KioskDevices />);

  const row = (await screen.findByText('registered-kiosk')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  // Portaled to document.body once open — see the comment above.
  await user.click(screen.getByRole('menuitem', { name: 'De-Register' }));

  expect(confirmSpy).toHaveBeenCalled();
  await waitFor(() => expect(api.deregisterDevice).toHaveBeenCalledWith('u2'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));

  confirmSpy.mockRestore();
});

it('hides row actions when can(scanning_hardware, change) is false', async () => {
  auth.can = (resource, action) => !(resource === 'scanning_hardware' && action === 'change');
  const user = userEvent.setup();
  render(<KioskDevices />);
  const row = (await screen.findByText('kiosk-dock-1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(within(row).queryByRole('menuitem', { name: 'Edit' })).toBeNull();
  expect(within(row).queryByRole('menuitem', { name: 'Register' })).toBeNull();
  expect(within(row).queryByRole('menuitem', { name: 'Renew' })).toBeNull();
  expect(within(row).queryByRole('menuitem', { name: 'De-Register' })).toBeNull();
});

it('viewer with no change/delete grants sees NO Actions button', async () => {
  auth.can = (resource, action) => !(resource === 'scanning_hardware'
    && (action === 'change' || action === 'delete'));
  render(<KioskDevices />);
  const row = (await screen.findByText('kiosk-dock-1')).closest('.dir-row') as HTMLElement;
  expect(within(row).queryByRole('button', { name: /Actions/ })).toBeNull();
});

it('clicking Delete + confirm calls deleteDevice and reloads', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');

  const row = screen.getByText('kiosk-dock-1').closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  // Portaled to document.body once open — see the comment above.
  const deleteBtn = screen.getByRole('menuitem', { name: 'Delete' });
  await user.click(deleteBtn);

  expect(confirmSpy).toHaveBeenCalledWith('Delete "kiosk-dock-1"? This cannot be undone.');
  await waitFor(() => expect(api.deleteDevice).toHaveBeenCalledWith('d1'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));

  confirmSpy.mockRestore();
});

it('shows the load-error banner when listDevices rejects', async () => {
  api.listDevices.mockRejectedValue(new Error('boom'));
  render(<KioskDevices />);

  expect(await screen.findByText(/Couldn.t load kiosks/i)).not.toBeNull();
});
