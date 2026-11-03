// @vitest-environment jsdom
/**
 * /hardware/fixed-readers — Fixed Readers device-fleet directory list.
 * Covers what a unit test can see: seeded rows sorted by name, the
 * disabled "Register reader" affordance, the row menu (Watch / Stop
 * watching, then Delete gated + confirm + reload round trip), ?focus=<id>
 * marking its row, and the load-error banner. Full toolbar/column-menu/
 * reorder/CSV behavior is exercised generically by lib/listTools.test.tsx
 * and lib/columnMenu.test.tsx — this file only covers FixedReaders-
 * specific wiring. Unlike Routers, there is no row expansion here.
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
    make: null, reader_status: null, antennas_total: null,
    current_initiative_id: null, current_initiative_name: null,
    session_person_id: null, session_person_name: null,
    session_login_method: null, session_started_at: null,
    setup_clear_requested_at: null, setup_clear_requested_by_name: null,
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
    make: null, reader_status: null, antennas_total: null,
    current_initiative_id: null, current_initiative_name: null,
    session_person_id: null, session_person_name: null,
    session_login_method: null, session_started_at: null,
    setup_clear_requested_at: null, setup_clear_requested_by_name: null,
  },
];

/** The person's own watch of the reader d1. */
const WATCH_D1: Watch = {
  id: 'w1', thing: 'device', thing_id: 'd1', thing_name: 'dock-reader-1',
  link: '/hardware/fixed-readers?focus=d1', kinds: [], via: { type: 'you', id: null, name: null },
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
  api.listMyWatches.mockResolvedValue([]);
  api.createMyWatch.mockResolvedValue(WATCH_D1);
  api.deleteMyWatch.mockResolvedValue(undefined);
});

afterEach(cleanup);

const { default: FixedReaders } = await import('./FixedReaders');

function renderReaders(entry = '/hardware/fixed-readers') {
  return render(<MemoryRouter initialEntries={[entry]}><FixedReaders /></MemoryRouter>);
}

/** The labels of the open menu's items, in order. */
const menuItems = () => screen.getAllByRole('menuitem').map((m) => m.textContent);

it('renders seeded rows sorted by name asc with model, MAC, IP, uptime, tags, antennas, connection tag, and scan-status chip', async () => {
  renderReaders();

  expect(await screen.findByText('dock-reader-1')).not.toBeNull();
  expect(screen.getByText('zebra-reader-2')).not.toBeNull();
  expect(screen.getAllByText('FX9600')).not.toHaveLength(0);
  expect(screen.getByText('94:83:C4:00:01:01')).not.toBeNull();
  expect(screen.getByText('94:83:C4:00:01:02')).not.toBeNull();
  expect(screen.getByText('192.168.8.11')).not.toBeNull();
  expect(screen.getByText('192.168.8.22')).not.toBeNull();
  expect(screen.getByText('88')).not.toBeNull();
  expect(screen.getByText('152')).not.toBeNull();
  expect(screen.getByText('2 / 8')).not.toBeNull();
  expect(screen.getByText('4 / 8')).not.toBeNull();
  expect(screen.getByText('RFID 1 - Cage Exit')).not.toBeNull();
  expect(screen.getByText('RFID 2 - Cage Entry')).not.toBeNull();
  expect(screen.getByText('NAP 11')).not.toBeNull();
  expect(screen.getByText('NAP 22')).not.toBeNull();

  expect(api.listDevices).toHaveBeenCalledWith('fixed_reader');

  const names = screen.getAllByText(/dock-reader-1|zebra-reader-2/).map((n) => n.textContent);
  expect(names).toEqual(['dock-reader-1', 'zebra-reader-2']);
});

it('shows the Register reader button, present but disabled', async () => {
  renderReaders();
  await screen.findByText('dock-reader-1');

  const btn = screen.getByRole('button', { name: /Register reader/i }) as HTMLButtonElement;
  expect(btn).not.toBeNull();
  expect(btn.disabled).toBe(true);
});

it('hides Delete when can(scanning_hardware, delete) is false: the row menu holds only Watch', async () => {
  auth.can = () => false;
  const user = userEvent.setup();
  renderReaders();
  await screen.findByText('dock-reader-1');
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();      // no bare button any more
  const row = screen.getByText('dock-reader-1').closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(menuItems()).toEqual(['Watch']);
});

it('each row has one Actions menu, holding Watch and then Delete, in place of the bare Delete button', async () => {
  const user = userEvent.setup();
  renderReaders();
  await screen.findByText('dock-reader-1');
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  expect(screen.getAllByRole('button', { name: /Actions/ })).toHaveLength(2);

  const row = screen.getByText('dock-reader-1').closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(menuItems()).toEqual(['Watch', 'Delete']);
  expect(screen.getByRole('menuitem', { name: 'Delete' }).className).toContain('danger');
  expect(api.listMyWatches).toHaveBeenCalledTimes(1);
});

it('a click on Watch watches that reader on every event, and the menu then reads Stop watching', async () => {
  api.listMyWatches.mockResolvedValueOnce([]).mockResolvedValue([WATCH_D1]);
  const user = userEvent.setup();
  renderReaders();
  const row = (await screen.findByText('dock-reader-1')).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Watch' }));

  await waitFor(() => expect(api.createMyWatch).toHaveBeenCalledWith(
    { thing: 'device', id: 'd1', kinds: [] }));
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await waitFor(() => expect(menuItems()).toEqual(['Stop watching', 'Delete']));
  // only the reader that was watched changed
  const other = screen.getByText('zebra-reader-2').closest('.dir-row') as HTMLElement;
  await user.click(within(other).getByRole('button', { name: /Actions/ }));
  expect(menuItems()).toEqual(['Watch', 'Delete']);
});

it('a reader the person watches reads Stop watching first, and a click stops that watch', async () => {
  api.listMyWatches.mockResolvedValueOnce([WATCH_D1]).mockResolvedValue([]);
  const user = userEvent.setup();
  renderReaders();
  const row = (await screen.findByText('dock-reader-1')).closest('.dir-row') as HTMLElement;
  await waitFor(() => expect(api.listMyWatches).toHaveBeenCalled());
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await waitFor(() => expect(menuItems()).toEqual(['Stop watching', 'Delete']));
  await user.click(screen.getByRole('menuitem', { name: 'Stop watching' }));

  await waitFor(() => expect(api.deleteMyWatch).toHaveBeenCalledWith('w1'));
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await waitFor(() => expect(menuItems()[0]).toBe('Watch'));
});

it('clicking Delete + confirm calls deleteDevice and reloads', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  renderReaders();
  await screen.findByText('dock-reader-1');

  const row = screen.getByText('dock-reader-1').closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

  expect(confirmSpy).toHaveBeenCalledWith('Delete "dock-reader-1"? This cannot be undone.');
  await waitFor(() => expect(api.deleteDevice).toHaveBeenCalledWith('d1'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));

  confirmSpy.mockRestore();
});

it('clicking Delete without confirm does not call deleteDevice', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  const user = userEvent.setup();
  renderReaders();
  await screen.findByText('dock-reader-1');

  const row = screen.getByText('dock-reader-1').closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

  expect(confirmSpy).toHaveBeenCalled();
  expect(api.deleteDevice).not.toHaveBeenCalled();

  confirmSpy.mockRestore();
});

it('shows the load-error banner when listDevices rejects', async () => {
  api.listDevices.mockRejectedValue(new Error('boom'));
  renderReaders();

  expect(await screen.findByText(/Couldn.t load fixed readers/i)).not.toBeNull();
});

it('fixed readers list: column floors, shared template + minimum, sideways-scroll card', async () => {
  renderReaders();
  const row = (await screen.findByText('dock-reader-1')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

const KIOSK_READER: DeviceItem = {
  ...DEVICES[0], id: 'd3', name: 'kiosk-reader-3', serial: 'FX9600-S3',
  mac: '94:83:C4:00:01:03', lan_ip: '192.168.8.33',
  antennas_connected: 2, antennas_total: 4, connection_type: 'local_api',
  make: 'Zebra', reader_status: 'reading',
};
const OFFLINE_READER: DeviceItem = {
  ...DEVICES[1], id: 'd4', name: 'old-reader-4', serial: 'FX9600-S4',
  mac: '94:83:C4:00:01:04', lan_ip: '192.168.8.44',
  make: 'Zebra', reader_status: 'offline',
};

it('shows Make and a Status chip, and antennas over antennas_total', async () => {
  api.listDevices.mockResolvedValue([KIOSK_READER, ...DEVICES]);
  renderReaders();
  const row = (await screen.findByText('kiosk-reader-3')).closest('.dir-row') as HTMLElement;
  expect(within(row).getByText('Zebra')).not.toBeNull();
  const chip = within(row).getByText('Reading');
  expect(chip.className).toContain('c-green');
  expect(within(row).getByText('2 / 4')).not.toBeNull();
  const plain = screen.getByText('dock-reader-1').closest('.dir-row') as HTMLElement;
  expect(within(plain).getByText('2 / 8')).not.toBeNull();
});

it('renders Standby slate and Offline red chips', async () => {
  api.listDevices.mockResolvedValue([
    { ...KIOSK_READER, reader_status: 'standby' }, OFFLINE_READER]);
  renderReaders();
  await screen.findByText('old-reader-4');
  expect(screen.getByText('Standby').className).toContain('c-slate');
  expect(screen.getByText('Offline').className).toContain('c-red');
});

it('Status facet filters to Offline', async () => {
  api.listDevices.mockResolvedValue([KIOSK_READER, OFFLINE_READER]);
  const user = userEvent.setup();
  renderReaders();
  await screen.findByText('old-reader-4');
  await user.click(screen.getByRole('button', { name: /Filter/i }));
  const menu = document.querySelector('.pop-menu') as HTMLElement;
  expect(within(menu).getByText('Status')).not.toBeNull();
  await user.click(within(menu).getByText('Offline', { selector: '.pop-item' }));
  await waitFor(() => expect(screen.queryByText('kiosk-reader-3')).toBeNull());
  expect(screen.getByText('old-reader-4')).not.toBeNull();
});

it('CSV export includes Make and Status columns', async () => {
  api.listDevices.mockResolvedValue([KIOSK_READER]);
  const lt = await import('../lib/listTools');
  const spy = vi.spyOn(lt, 'exportCsv').mockImplementation(() => {});
  const user = userEvent.setup();
  renderReaders();
  await screen.findByText('kiosk-reader-3');
  await user.click(screen.getByRole('button', { name: /Export/i }));
  const [, cols, rows] = spy.mock.calls[0] as [string, [string, (d: DeviceItem) => string][], DeviceItem[]];
  const byName = Object.fromEntries(cols.map(([n, f]) => [n, f(rows[0])]));
  expect(byName.Make).toBe('Zebra');
  expect(byName.Status).toBe('Reading');
  spy.mockRestore();
});

it('Uptime and Connection are off by default but listed in the Columns menu', async () => {
  const user = userEvent.setup();
  renderReaders();
  const row = (await screen.findByText('dock-reader-1')).closest('.dir-row') as HTMLElement;
  expect(within(row).queryByText('12d 0h')).toBeNull();
  expect(within(row).queryByText('API')).toBeNull();
  await user.click(screen.getByRole('button', { name: /Columns/i }));
  const menu = document.querySelector('.pop-menu') as HTMLElement;
  expect(within(menu).getByText('Uptime', { selector: '.pop-item' })).not.toBeNull();
  expect(within(menu).getByText('Connection', { selector: '.pop-item' })).not.toBeNull();
});

/* ── ?focus=<id>: a Device offline notification opens the list on that row ── */

it('every row carries its device id', async () => {
  renderReaders();
  const row = (await screen.findByText('dock-reader-1')).closest('.dir-row') as HTMLElement;
  expect(row.getAttribute('data-device-id')).toBe('d1');
  expect((screen.getByText('zebra-reader-2').closest('.dir-row') as HTMLElement)
    .getAttribute('data-device-id')).toBe('d2');
});

it('?focus=<id> marks that row and scrolls it into view', async () => {
  renderReaders('/hardware/fixed-readers?focus=d2');
  const marked = (await screen.findByText('zebra-reader-2')).closest('.dir-row') as HTMLElement;
  await waitFor(() => expect(marked.className).toContain('open'));
  expect((screen.getByText('dock-reader-1').closest('.dir-row') as HTMLElement).className)
    .not.toContain('open');

  const scroll = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
  expect(scroll.mock.contexts[0]).toBe(marked);
  expect(scroll).toHaveBeenCalledWith({ block: 'center' });
});

it('with no ?focus, or one for a reader that is not in the list, no row is marked or scrolled to', async () => {
  renderReaders();
  await screen.findByText('dock-reader-1');
  expect(document.querySelector('.dir-row.open')).toBeNull();
  cleanup();

  renderReaders('/hardware/fixed-readers?focus=gone');
  await screen.findByText('dock-reader-1');
  expect(document.querySelector('.dir-row.open')).toBeNull();
  expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
});

it('?focus applies once: a later reload keeps the mark and does not scroll again', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.listDevices.mockImplementation(async () => DEVICES.map((d) => ({ ...d })));   // new array per load
  const user = userEvent.setup();
  renderReaders('/hardware/fixed-readers?focus=d2');
  await screen.findByText('zebra-reader-2');
  await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1));

  // deleting the other reader reloads the list
  const other = screen.getByText('dock-reader-1').closest('.dir-row') as HTMLElement;
  await user.click(within(other).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(2));
  await new Promise((r) => setTimeout(r, 20));

  expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  expect((screen.getByText('zebra-reader-2').closest('.dir-row') as HTMLElement).className)
    .toContain('open');
  confirmSpy.mockRestore();
});

it('?focus on a row a saved filter hides scrolls to it once the filter is cleared', async () => {
  // the list opens with a saved Name filter that leaves only dock-reader-1
  auth.listPrefs = { 'hardware-fixed-readers': { filters: { name: { text: 'dock' } } } };
  const user = userEvent.setup();
  renderReaders('/hardware/fixed-readers?focus=d2');
  await screen.findByText('dock-reader-1');
  expect(screen.queryByText('zebra-reader-2')).toBeNull();
  const scroll = Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>;
  expect(scroll).not.toHaveBeenCalled();

  await user.click(screen.getByRole('button', { name: /1 filter active/ }));
  const marked = (await screen.findByText('zebra-reader-2')).closest('.dir-row') as HTMLElement;
  await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
  expect(scroll.mock.contexts[0]).toBe(marked);
  expect(marked.className).toContain('open');
});
