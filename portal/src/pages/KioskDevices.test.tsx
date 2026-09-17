// @vitest-environment jsdom
/**
 * /hardware/kiosks — Kiosk Devices device-fleet directory list. Covers
 * what a unit test can see: seeded rows with the type tag, all four
 * registration-chip states, current-move name, and scan-type chip; the
 * "+ New kiosk" add-gate; contextual Register/Renew/De-Register actions
 * per row's registration state; the Register flow round trip; the
 * load-error banner; and the "Clear offline" bulk flow — its rank gate,
 * the dry run that fills the modal, a confirm whose notice reports the
 * SERVER's counts rather than the preview's, and a preview that failed
 * (read-only mode 423s the dry run too, since it is itself a POST).
 * Full toolbar/column-menu/reorder/CSV behavior is exercised generically by
 * lib/listTools.test.tsx and lib/columnMenu.test.tsx — this file only
 * covers KioskDevices-specific wiring. Registration-state fixtures use
 * time-proof offsets (±/well outside the 7-day "soon" window, computed off
 * Date.now()) rather than hardcoded dates, so they never age into the
 * wrong bucket.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DeviceItem, UiPreferences } from '../lib/api';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action: string) => boolean; maxRank: number } = {
    can: () => true,
    maxRank: 60,
  };
  return state;
});

const updatePreferences = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    get maxRank() { return auth.maxRank; },
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
  clearOfflineKiosks: vi.fn(),
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
    session_person_id: null, session_person_name: null,
    session_login_method: null, session_started_at: null,
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

const MATCH = {
  id: 'd1', name: 'kiosk-dock-01', sub_type: 'laptop',
  registration: 'expired' as const, last_seen_at: '2026-09-14T10:00:00Z',
};
const MATCH_B = {
  id: 'd2', name: 'kiosk-pi-07', sub_type: 'pi',
  registration: 'unregistered' as const, last_seen_at: null,
};
const MATCH_C = {
  id: 'd3', name: 'kiosk-dock-03', sub_type: 'laptop',
  registration: 'expired' as const, last_seen_at: '2026-09-15T10:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  auth.maxRank = 60;
  api.clearOfflineKiosks.mockResolvedValue({ dry_run: true, kiosks: [], skipped: [], not_found: 0 });
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

it('renders the signed-in user and login-method chip; a session-less row shows dashes', async () => {
  const SESSION_DEVICES: DeviceItem[] = [
    kiosk({
      id: 's1', name: 'kiosk-signed-in',
      session_person_id: 'p1', session_person_name: 'Claude Dev',
      session_login_method: 'link', session_started_at: '2026-09-13T10:00:00Z',
    }),
    kiosk({ id: 's2', name: 'kiosk-signed-out' }),
  ];
  api.listDevices.mockResolvedValue(SESSION_DEVICES);
  render(<KioskDevices />);

  const signedInRow = (await screen.findByText('kiosk-signed-in')).closest('.dir-row') as HTMLElement;
  expect(within(signedInRow).getByText('Claude Dev')).not.toBeNull();
  const chip = within(signedInRow).getByText('Phone link');
  expect(chip.className).toContain('chip tag');

  const signedOutRow = screen.getByText('kiosk-signed-out').closest('.dir-row') as HTMLElement;
  const dashes = within(signedOutRow).getAllByText('—');
  expect(dashes.length).toBeGreaterThanOrEqual(2);
});

it('shows the load-error banner when listDevices rejects', async () => {
  api.listDevices.mockRejectedValue(new Error('boom'));
  render(<KioskDevices />);

  expect(await screen.findByText(/Couldn.t load kiosks/i)).not.toBeNull();
});

/* ── Clear offline kiosks ──────────────────────────────────────────── */

it('hides the clear button below rank 60', async () => {
  auth.maxRank = 40;
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');
  expect(screen.queryByRole('button', { name: /Clear offline/ })).toBeNull();
});

it('shows the clear button for an admin', async () => {
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');
  expect(screen.getByRole('button', { name: /Clear offline/ })).not.toBeNull();
});

it('opens the modal with the dry-run matches', async () => {
  api.clearOfflineKiosks.mockResolvedValueOnce({
    dry_run: true, kiosks: [MATCH], skipped: [], not_found: 0,
  });
  const user = userEvent.setup();
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');

  await user.click(screen.getByRole('button', { name: /Clear offline/ }));

  expect(await screen.findByText('kiosk-dock-01')).not.toBeNull();
  expect(api.clearOfflineKiosks).toHaveBeenCalledWith({ dry_run: true });
});

it('confirms with the previewed ids and reports what the server actually did', async () => {
  api.clearOfflineKiosks
    .mockResolvedValueOnce({ dry_run: true, kiosks: [MATCH, MATCH_B], skipped: [], not_found: 0 })
    // the server re-checks: MATCH_B came back to life between the two calls
    .mockResolvedValueOnce({ dry_run: false, kiosks: [MATCH], skipped: [MATCH_B], not_found: 0 });
  const user = userEvent.setup();
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');

  await user.click(screen.getByRole('button', { name: /Clear offline/ }));
  await user.click(await screen.findByRole('button', { name: /Delete 2 kiosks/ }));

  await waitFor(() => expect(api.clearOfflineKiosks).toHaveBeenLastCalledWith(
    { dry_run: false, ids: [MATCH.id, MATCH_B.id] },
  ));
  // the notice reports the response (1), never the preview's prediction (2)
  expect(await screen.findByText(/Deleted 1 kiosk/)).not.toBeNull();
  expect(screen.getByText(/1 skipped/)).not.toBeNull();
  expect(screen.queryByText(/Deleted 2 kiosks/)).toBeNull();
  // and the list is reloaded, and the modal is gone
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('button', { name: /Delete 2 kiosks/ })).toBeNull();
});

it('surfaces ids that no longer existed at all, so the count reconciles', async () => {
  api.clearOfflineKiosks
    .mockResolvedValueOnce({ dry_run: true, kiosks: [MATCH, MATCH_B], skipped: [], not_found: 0 })
    .mockResolvedValueOnce({ dry_run: false, kiosks: [MATCH], skipped: [], not_found: 1 });
  const user = userEvent.setup();
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');

  await user.click(screen.getByRole('button', { name: /Clear offline/ }));
  await user.click(await screen.findByRole('button', { name: /Delete 2 kiosks/ }));

  expect(await screen.findByText(/Deleted 1 kiosk.*no longer existed/)).not.toBeNull();
});

it('says nothing was deleted when every previewed kiosk came back', async () => {
  api.clearOfflineKiosks
    .mockResolvedValueOnce({ dry_run: true, kiosks: [MATCH], skipped: [], not_found: 0 })
    .mockResolvedValueOnce({ dry_run: false, kiosks: [], skipped: [MATCH], not_found: 0 });
  const user = userEvent.setup();
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');

  await user.click(screen.getByRole('button', { name: /Clear offline/ }));
  await user.click(await screen.findByRole('button', { name: /Delete 1 kiosk/ }));

  expect(await screen.findByText(/Nothing deleted/)).not.toBeNull();
});

it('opens the modal on an empty preview rather than silently doing nothing', async () => {
  api.clearOfflineKiosks.mockResolvedValueOnce({
    dry_run: true, kiosks: [], skipped: [], not_found: 0,
  });
  const user = userEvent.setup();
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');

  await user.click(screen.getByRole('button', { name: /Clear offline/ }));

  expect(await screen.findByText(/Nothing to clear/)).not.toBeNull();
});

it('explains a preview that read-only maintenance mode rejected, and opens no modal', async () => {
  // The preview is itself a POST, so read-only mode 423s the dry run — not
  // just the delete. An empty modal here would read as "nothing to clear".
  const { ApiError, READ_ONLY_MESSAGE } = await import('../lib/api');
  api.clearOfflineKiosks.mockRejectedValueOnce(
    new ApiError(423, 'read_only_mode', undefined, READ_ONLY_MESSAGE),
  );
  const user = userEvent.setup();
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');

  await user.click(screen.getByRole('button', { name: /Clear offline/ }));

  expect(await screen.findByText(/read-only maintenance mode/)).not.toBeNull();
  expect(screen.queryByText(/Nothing to clear/)).toBeNull();
  expect(screen.queryByRole('button', { name: /^Delete \d/ })).toBeNull();
});

it('explains any other failed preview instead of opening an empty modal', async () => {
  api.clearOfflineKiosks.mockRejectedValueOnce(new Error('boom'));
  const user = userEvent.setup();
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');

  await user.click(screen.getByRole('button', { name: /Clear offline/ }));

  expect(await screen.findByText(/Couldn.t check which kiosks/i)).not.toBeNull();
  expect(screen.queryByText(/Nothing to clear/)).toBeNull();
});

it('reports deleted, skipped, and not-found together', async () => {
  api.clearOfflineKiosks
    .mockResolvedValueOnce({ dry_run: true, kiosks: [MATCH, MATCH_B, MATCH_C], skipped: [], not_found: 0 })
    .mockResolvedValueOnce({ dry_run: false, kiosks: [MATCH], skipped: [MATCH_B], not_found: 1 });
  const user = userEvent.setup();
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');

  await user.click(screen.getByRole('button', { name: /Clear offline/ }));
  await user.click(await screen.findByRole('button', { name: /Delete 3 kiosks/ }));

  expect(await screen.findByText(
    /Deleted 1 kiosk.*1 skipped, seen since the preview.*1 kiosk no longer existed/,
  )).not.toBeNull();
});

it('reports a not-found-only result when nothing was deleted or skipped', async () => {
  api.clearOfflineKiosks
    .mockResolvedValueOnce({ dry_run: true, kiosks: [MATCH, MATCH_B], skipped: [], not_found: 0 })
    .mockResolvedValueOnce({ dry_run: false, kiosks: [], skipped: [], not_found: 2 });
  const user = userEvent.setup();
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');

  await user.click(screen.getByRole('button', { name: /Clear offline/ }));
  await user.click(await screen.findByRole('button', { name: /Delete 2 kiosks/ }));

  expect(await screen.findByText(/Nothing deleted.*2 kiosks no longer existed/)).not.toBeNull();
});

it('caps the confirm batch at 500 ids and tells the operator to rerun for the rest', async () => {
  const many = Array.from({ length: 501 }, (_, i) => ({
    id: `m${i}`, name: `kiosk-${i}`, sub_type: 'pi',
    registration: 'unregistered' as const, last_seen_at: null,
  }));
  api.clearOfflineKiosks
    .mockResolvedValueOnce({ dry_run: true, kiosks: many, skipped: [], not_found: 0 })
    .mockResolvedValueOnce({ dry_run: false, kiosks: many.slice(0, 500), skipped: [], not_found: 0 });
  const user = userEvent.setup();
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');

  await user.click(screen.getByRole('button', { name: /Clear offline/ }));

  expect(await screen.findByText(/Showing the first 500 of 501 matches/)).not.toBeNull();
  await user.click(screen.getByRole('button', { name: /Delete 500 kiosks/ }));

  await waitFor(() => expect(api.clearOfflineKiosks).toHaveBeenLastCalledWith(
    { dry_run: false, ids: many.slice(0, 500).map((k) => k.id) },
  ));
});

it('disables the Clear offline button and blocks a second click while the preview is in flight',
  async () => {
    let resolvePreview: (value: unknown) => void = () => {};
    api.clearOfflineKiosks.mockImplementationOnce(
      () => new Promise((resolve) => { resolvePreview = resolve; }),
    );
    const user = userEvent.setup();
    render(<KioskDevices />);
    await screen.findByText('kiosk-dock-1');

    const btn = screen.getByRole('button', { name: /Clear offline/ });
    await user.click(btn);

    const busyBtn = screen.getByRole('button', { name: /Checking/ }) as HTMLButtonElement;
    expect(busyBtn.disabled).toBe(true);
    await user.click(busyBtn); // no-op: disabled while the dry run is in flight

    resolvePreview({ dry_run: true, kiosks: [MATCH], skipped: [], not_found: 0 });
    await screen.findByText('kiosk-dock-01');

    expect(api.clearOfflineKiosks).toHaveBeenCalledTimes(1);
  });

it('clears a lingering clear-offline notice once another action runs', async () => {
  api.clearOfflineKiosks
    .mockResolvedValueOnce({ dry_run: true, kiosks: [MATCH], skipped: [], not_found: 0 })
    .mockResolvedValueOnce({ dry_run: false, kiosks: [MATCH], skipped: [], not_found: 0 });
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  render(<KioskDevices />);
  await screen.findByText('kiosk-dock-1');

  await user.click(screen.getByRole('button', { name: /Clear offline/ }));
  await user.click(await screen.findByRole('button', { name: /Delete 1 kiosk/ }));
  expect(await screen.findByText(/Deleted 1 kiosk/)).not.toBeNull();

  const row = screen.getByText('kiosk-dock-1').closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

  await waitFor(() => expect(api.deleteDevice).toHaveBeenCalled());
  expect(screen.queryByText(/Deleted 1 kiosk/)).toBeNull();

  confirmSpy.mockRestore();
});
