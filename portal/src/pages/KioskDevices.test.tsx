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

import { ApiError, type DeviceItem, type UiPreferences } from '../lib/api';
import { LIST_FIT } from '../lib/listTools';

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
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', list_view: 'expanded',
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
  requestClearSetup: vi.fn(),
  cancelClearSetup: vi.fn(),
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
    station_type: null, rfid_reader: null,
    setup_clear_requested_at: null, setup_clear_requested_by_name: null,
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

it('kiosk devices list: column floors, shared template + minimum, sideways-scroll card', async () => {
  render(<KioskDevices />);
  const row = (await screen.findByText('kiosk-dock-1')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

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

it('the edit modal offers every sub-type the kiosk heartbeat can derive', async () => {
  const user = userEvent.setup();
  render(<KioskDevices />);

  const row = (await screen.findByText('kiosk-dock-1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

  const type = await screen.findByRole('combobox', { name: 'Type' });
  const options = within(type).getAllByRole('option').map((o) => o.textContent);
  expect(options).toEqual(
    ['— none', 'Laptop', 'Pi', 'Android', 'Android (Zebra)', 'iOS', 'Web'],
  );
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

it('renders the signed-in user; login-method chip is hidden by default', async () => {
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
  // login_method column is default: false, so "Phone link" doesn't appear in default view
  expect(within(signedInRow).queryByText('Phone link')).toBeNull();

  const signedOutRow = screen.getByText('kiosk-signed-out').closest('.dir-row') as HTMLElement;
  const dashes = within(signedOutRow).getAllByText('—');
  expect(dashes.length).toBeGreaterThanOrEqual(1);
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

const READER = {
  ip: '192.168.8.77', serial: '23001010101010', model: 'FX9600',
  versions: { readerApplication: '3.4.2', radioFirmware: '2.1.0', cloudAgentApplication: '1.9.9' },
  paired_at: '2026-10-01T15:30:00Z',
};

const STATION_DEVICES: DeviceItem[] = [
  kiosk({ id: 's1', name: 'station-rfid', sub_type: 'laptop', station_type: 'rfid', rfid_reader: READER }),
  kiosk({ id: 's2', name: 'station-label', sub_type: 'laptop', station_type: 'label' }),
  kiosk({ id: 's3', name: 'plain-pi', sub_type: 'pi' }),
];

it('stationTypeLabel maps station and sub type', async () => {
  const { stationTypeLabel } = await import('../lib/devices');
  expect(stationTypeLabel(STATION_DEVICES[0])).toBe('RFID \u00b7 Laptop');
  expect(stationTypeLabel(STATION_DEVICES[1])).toBe('Label Station \u00b7 Laptop');
  expect(stationTypeLabel(kiosk({ station_type: 'rfid', sub_type: 'pi' }))).toBe('RFID \u00b7 Pi');
  expect(stationTypeLabel(STATION_DEVICES[2])).toBe('Pi');
});

it('Type column and filter options use the station labels', async () => {
  api.listDevices.mockResolvedValue(STATION_DEVICES);
  render(<KioskDevices />);
  await screen.findByText('station-rfid');
  expect(screen.getByText('RFID \u00b7 Laptop')).not.toBeNull();
  expect(screen.getByText('Label Station \u00b7 Laptop')).not.toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /filter/i }));
  const rfid = await screen.findAllByText('RFID \u00b7 Laptop');
  expect(rfid.length).toBeGreaterThan(1);
  expect(screen.getAllByText('Label Station \u00b7 Laptop').length).toBeGreaterThan(1);
});

const open = async (name: string) => {
  const row = (await screen.findByText(name)).closest('.dir-row') as HTMLElement;
  await userEvent.click(row.querySelector('.row-main') as HTMLElement);
  return row;
};

it('every kiosk row has a chevron and a Station table; no switcher without a reader', async () => {
  api.listDevices.mockResolvedValue(STATION_DEVICES);
  render(<KioskDevices />);
  const row = await open('station-label');
  expect(row.querySelector('.chevron-cell')).not.toBeNull();
  const t = within(row).getByRole('table', { name: 'Station' });
  expect(within(t).getByText('Station type')).not.toBeNull();
  expect(within(t).getByText('Label Station \u00b7 Laptop')).not.toBeNull();
  expect(within(row).queryByRole('tablist')).toBeNull();
  const pi = await open('plain-pi');
  expect(within(pi).getByRole('table', { name: 'Station' })).not.toBeNull();
  expect(within(pi).queryByRole('tablist')).toBeNull();
});

it('RFID kiosk gets a Station/Reader switcher and a Reader table with the paired time', async () => {
  api.listDevices.mockResolvedValue(STATION_DEVICES);
  render(<KioskDevices />);
  const row = await open('station-rfid');
  expect(within(row).getByRole('tablist')).not.toBeNull();
  expect(within(row).getByRole('table', { name: 'Station' })).not.toBeNull();
  await userEvent.click(within(row).getByRole('tab', { name: 'Reader' }));
  const t = within(row).getByRole('table', { name: 'Paired reader' });
  for (const h of ['IP', 'Model', 'Serial', 'Reader app', 'Radio', 'Cloud agent', 'Paired']) {
    expect(within(t).getByText(h)).not.toBeNull();
  }
  for (const v of ['192.168.8.77', 'FX9600', '23001010101010', '3.4.2', '2.1.0', '1.9.9']) {
    expect(within(t).getByText(v)).not.toBeNull();
  }
  expect(within(t).getByText(new Date(READER.paired_at).toLocaleString())).not.toBeNull();
});

it('Reader table falls back to dashes for missing versions and paired time', async () => {
  api.listDevices.mockResolvedValue([kiosk({
    id: 's9', name: 'station-bare', sub_type: 'laptop', station_type: 'rfid',
    rfid_reader: { ip: '10.0.0.5', serial: null, model: null, versions: null, paired_at: null },
  })]);
  render(<KioskDevices />);
  const row = await open('station-bare');
  await userEvent.click(within(row).getByRole('tab', { name: 'Reader' }));
  const t = within(row).getByRole('table', { name: 'Paired reader' });
  expect(within(t).getAllByText('\u2014')).toHaveLength(6);
});

it('Type cell, filter and search agree for a null sub_type', async () => {
  api.listDevices.mockResolvedValue([kiosk({ id: 'n1', name: 'no-type', sub_type: null })]);
  render(<KioskDevices />);
  const row = (await screen.findByText('no-type')).closest('.dir-row') as HTMLElement;
  const { stationTypeLabel, deviceCellText } = await import('../lib/devices');
  expect(stationTypeLabel({ station_type: null, sub_type: null })).toBe('\u2014');
  expect(deviceCellText(DEVICES[0], 'sub_type')).toBe('Pi');
  expect(row.querySelector('.chip.tag.cell-line')).toBeNull();
  expect(deviceCellText(kiosk({ sub_type: null }), 'sub_type')).toBe('\u2014');
});

/* ── Clear Setup ───────────────────────────────────────────────────── */

async function openActions(name: string) {
  const user = userEvent.setup();
  const row = (await screen.findByText(name)).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  return { user, row };
}

it('Clear Setup confirms with the spec copy, posts, and reloads', async () => {
  api.listDevices.mockResolvedValue([kiosk({ id: 'k1', name: 'kiosk-dock-1' })]);
  api.requestClearSetup.mockResolvedValue(kiosk({ id: 'k1' }));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<KioskDevices />);
  const { user } = await openActions('kiosk-dock-1');
  await user.click(await screen.findByRole('menuitem', { name: 'Clear Setup' }));
  expect(confirm).toHaveBeenCalledWith(
    'Clear Setup on "kiosk-dock-1"? The next time it checks in, its move, site and checkpoint are cleared and whoever is signed in is sent to Kiosk Setup. Queued scans are kept.');
  await waitFor(() => expect(api.requestClearSetup).toHaveBeenCalledWith('k1'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
  confirm.mockRestore();
});

it('declining the confirm does nothing', async () => {
  api.listDevices.mockResolvedValue([kiosk({ id: 'k1', name: 'kiosk-dock-1' })]);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<KioskDevices />);
  const { user } = await openActions('kiosk-dock-1');
  await user.click(await screen.findByRole('menuitem', { name: 'Clear Setup' }));
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(api.requestClearSetup).not.toHaveBeenCalled();
  expect(api.listDevices).toHaveBeenCalledTimes(1);
  confirm.mockRestore();
});

it('a pending clear shows the chip with who/when and offers Cancel instead', async () => {
  api.listDevices.mockResolvedValue([kiosk({
    id: 'k1', name: 'kiosk-dock-1',
    setup_clear_requested_at: '2026-10-01T14:14:00Z',
    setup_clear_requested_by_name: 'Jimmy Henderson',
  })]);
  api.cancelClearSetup.mockResolvedValue(kiosk({ id: 'k1' }));
  render(<KioskDevices />);
  const chip = await screen.findByText('Setup clear pending');
  expect(chip.className).toContain('c-amber');
  expect(chip.getAttribute('title')).toMatch(/^Requested by Jimmy Henderson, /);
  // A sibling of the ellipsizing name, never inside it (it would be clipped).
  const nameLine = screen.getByText('kiosk-dock-1', { selector: '.cell-line' });
  expect(nameLine.contains(chip)).toBe(false);
  expect(chip.closest('.cell-line')).toBeNull();
  expect(chip.parentElement).toBe(nameLine.parentElement);
  const { user } = await openActions('kiosk-dock-1');
  expect(screen.queryByRole('menuitem', { name: 'Clear Setup' })).toBeNull();
  await user.click(screen.getByRole('menuitem', { name: 'Cancel clear setup' }));
  await waitFor(() => expect(api.cancelClearSetup).toHaveBeenCalledWith('k1'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
});

it('a kiosk with nothing pending shows no chip and no Cancel item', async () => {
  api.listDevices.mockResolvedValue([kiosk({ id: 'k1', name: 'kiosk-dock-1' })]);
  render(<KioskDevices />);
  await openActions('kiosk-dock-1');
  expect(screen.queryByText('Setup clear pending')).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Cancel clear setup' })).toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Clear Setup' })).not.toBeNull();
});

it('not_a_kiosk shows the friendly error', async () => {
  api.listDevices.mockResolvedValue([kiosk({ id: 'k1', name: 'kiosk-dock-1' })]);
  api.requestClearSetup.mockRejectedValue(new ApiError(409, 'not_a_kiosk'));
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<KioskDevices />);
  const { user } = await openActions('kiosk-dock-1');
  await user.click(await screen.findByRole('menuitem', { name: 'Clear Setup' }));
  expect(await screen.findByText('Only kiosks can have their setup cleared.')).not.toBeNull();
  confirm.mockRestore();
});

it('Clear Setup is hidden without change permission', async () => {
  auth.can = (resource, action) => !(resource === 'scanning_hardware' && action === 'change');
  api.listDevices.mockResolvedValue([kiosk({ id: 'k1', name: 'kiosk-dock-1' })]);
  render(<KioskDevices />);
  // delete is still granted, so the Actions menu exists but offers Delete only
  await openActions('kiosk-dock-1');
  expect(screen.getByRole('menuitem', { name: 'Delete' })).not.toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Clear Setup' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Cancel clear setup' })).toBeNull();
});
