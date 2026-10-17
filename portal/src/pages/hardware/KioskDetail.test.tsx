// @vitest-environment jsdom
/**
 * /hardware/kiosks/:id — the kiosk details page. Covers the five tabs from a
 * mocked GET /devices/{id}, the rank-80 edit gate, that an edit PUTs the
 * whole document with only that section changed (unknown sections kept), a
 * 422 shown beside its field, the three sync-line states, the scan type
 * picker, and the History list's column floors.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type DeviceConfigHistoryItem, type DeviceDetail, type UiPreferences,
} from '../../lib/api';
import { DEFAULT_CONFIG } from '../../lib/kioskConfig';
import { LIST_FIT } from '../../lib/listTools';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action: string) => boolean; maxRank: number } = {
    can: () => true,
    maxRank: 80,
  };
  return state;
});

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    get maxRank() { return auth.maxRank; },
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', list_view: 'expanded',
      notif: { sound: 'chime', categories: { approvals: 'email', reports: 'email', wiki: 'email', security: 'email' } },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  getDevice: vi.fn(),
  getDeviceConfigHistory: vi.fn(),
  listKioskSounds: vi.fn(),
  listStatusValues: vi.fn(),
  putDeviceConfig: vi.fn(),
  resetDeviceConfig: vi.fn(),
  setDeviceScanType: vi.fn(),
  uploadKioskSound: vi.fn(),
  getKioskSoundBlob: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const CONFIG = {
  ...structuredClone(DEFAULT_CONFIG),
  future_section: { keep: [1, 2, 3] },
};

function detail(overrides: Partial<DeviceDetail> = {}): DeviceDetail {
  return {
    id: 'k1', device_type: 'kiosk', name: 'Kiosk 97F0',
    serial: 'SER-97F0', mac: '94:83:C4:00:02:00',
    site_id: 's1', site_name: 'ORD1',
    wan_ip: '203.0.113.9', lan_ip: '192.168.8.40',
    uptime_seconds: null, last_seen_at: new Date(Date.now() - 40_000).toISOString(),
    raw_info: { printer_model: 'ZD621' }, registered_at: '2026-08-19T10:00:00Z',
    vpn_status: null, token_expires_at: new Date(Date.now() + 365 * 86400_000).toISOString(),
    connected_count: 0, model: null, antennas_connected: null, connection_type: null,
    scan_status: 'on_truck', scan_status_label: 'On Truck RFID', scan_status_color: '#178a4c',
    tags_read_24h: 0, version: '3.1.0', sub_type: 'laptop',
    current_initiative_id: 'i1', current_initiative_name: 'Initech ORD1 to AUS1 Migration',
    session_person_id: 'p1', session_person_name: 'Pat Crew',
    session_login_method: 'password', session_started_at: '2026-10-17T08:00:00Z',
    station_type: 'rfid',
    rfid_reader: {
      ip: '192.168.8.50', serial: 'FX-1', model: 'FX9600',
      versions: { readerApplication: '3.10.30' }, paired_at: '2026-10-01T10:00:00Z',
    },
    setup_clear_requested_at: null, setup_clear_requested_by_name: null,
    config: structuredClone(CONFIG),
    config_version: 3,
    config_changed_at: '2026-10-17T10:00:00Z',
    config_source: 'portal',
    config_changed_by_name: 'Jimmy Henderson',
    config_reported_at: '2026-10-17T11:00:00Z',
    config_applied_version: 3,
    sync_state: 'in_sync',
    setup: {
      initiative_id: 'i1', initiative_name: 'Initech ORD1 to AUS1 Migration',
      site_id: 's1', site_name: 'ORD1', site_role: 'source', station_type: 'rfid',
      scan_status: 'on_truck', scan_status_label: 'On Truck RFID',
    },
    scan_type_options: [
      { key: 'on_truck', label: 'On Truck RFID', color: '#178a4c' },
      { key: 'received', label: 'Received RFID', color: '#2266aa' },
    ],
    ...overrides,
  };
}

const HISTORY: DeviceConfigHistoryItem[] = [
  { at: '2026-10-17T10:00:00Z', source: 'portal', version: 3, by_name: 'Jimmy Henderson',
    changes: { 'appearance.flash_ms': { from: 350, to: 600 } } },
  { at: '2026-10-16T10:00:00Z', source: 'kiosk', version: 2, by_name: null,
    changes: { 'sound.volume': { from: 0.8, to: 0.5 } } },
];

beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no scrollIntoView; ComboBox scrolls its active option into view
  Element.prototype.scrollIntoView = vi.fn();
  auth.can = () => true;
  auth.maxRank = 80;
  api.getDevice.mockResolvedValue(detail());
  api.getDeviceConfigHistory.mockResolvedValue(HISTORY);
  api.listKioskSounds.mockResolvedValue([]);
  api.listStatusValues.mockResolvedValue([
    { record_type: 'asset', key: 'pre_stage', label: 'Pre-Stage', description: '', color: '#888',
      sort_order: 1, is_active: true, usage_count: null, progress_weight: null },
  ]);
  api.putDeviceConfig.mockImplementation(async (_id: string, config: Record<string, unknown>) =>
    detail({ config, config_version: 4, sync_state: 'pending' }));
});

afterEach(cleanup);

const { default: KioskDetail } = await import('./KioskDetail');

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/hardware/kiosks/:id" element={<KioskDetail />} />
        <Route path="/hardware/kiosks/:id/:tab" element={<KioskDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('renders every tab from the detail', async () => {
  const user = userEvent.setup();
  renderAt('/hardware/kiosks/k1');
  expect(await screen.findByRole('heading', { name: /Kiosk 97F0/ })).not.toBeNull();
  const tabs = screen.getByRole('tablist');
  expect(within(tabs).getAllByRole('tab').map((t) => t.textContent))
    .toEqual(['Overview', 'Settings', 'Devices', 'Setup & move', 'History']);

  // Overview
  expect(screen.getByText('Pat Crew')).not.toBeNull();
  expect(screen.getAllByText('In sync').length).toBeGreaterThan(0);

  // Settings: alarm card on a laptop RFID Station
  await user.click(within(tabs).getByRole('tab', { name: 'Settings' }));
  expect(await screen.findByRole('heading', { name: 'Appearance' })).not.toBeNull();
  expect(screen.getByRole('heading', { name: 'Sound' })).not.toBeNull();
  expect(screen.getByRole('heading', { name: 'Checkpoints' })).not.toBeNull();
  expect(screen.getByRole('heading', { name: 'Developer' })).not.toBeNull();
  expect(screen.getByRole('heading', { name: 'Off-move alarm' })).not.toBeNull();
  expect(screen.getByText('350 ms')).not.toBeNull();
  expect(screen.getByText(/changed on the portal by Jimmy Henderson/)).not.toBeNull();
  expect(screen.getByText('Pre-Stage')).not.toBeNull();

  // Devices: reader and printer
  await user.click(within(tabs).getByRole('tab', { name: 'Devices' }));
  expect(await screen.findByText('FX9600')).not.toBeNull();
  expect(screen.getByText('ZD621')).not.toBeNull();

  // Setup & move
  await user.click(within(tabs).getByRole('tab', { name: 'Setup & move' }));
  expect(await screen.findByText('Initech ORD1 to AUS1 Migration')).not.toBeNull();
  expect(screen.getByText('Source')).not.toBeNull();

  // History
  await user.click(within(tabs).getByRole('tab', { name: 'History' }));
  expect(await screen.findByText('Appearance › Flash length: 350 → 600')).not.toBeNull();
  expect(screen.getAllByText('Jimmy Henderson').length).toBeGreaterThan(0);
});

it('hides Edit, Reset and the scan type picker below rank 80', async () => {
  auth.maxRank = 60;
  renderAt('/hardware/kiosks/k1/settings');
  await screen.findByRole('heading', { name: 'Appearance' });
  expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reset to defaults' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Upload sound' })).toBeNull();
  cleanup();
  renderAt('/hardware/kiosks/k1/setup');
  await screen.findByText('Initech ORD1 to AUS1 Migration');
  expect(screen.queryByRole('combobox', { name: 'Scan type' })).toBeNull();
});

it('hides Edit without scanning_hardware change even at rank 80', async () => {
  auth.can = (_r, a) => a === 'view';
  renderAt('/hardware/kiosks/k1/settings');
  await screen.findByRole('heading', { name: 'Appearance' });
  expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
});

it('an edit saves the whole document with only that section changed', async () => {
  const user = userEvent.setup();
  renderAt('/hardware/kiosks/k1/settings');
  await screen.findByRole('heading', { name: 'Appearance' });
  await user.click(screen.getByRole('button', { name: 'Edit appearance' }));
  const dialog = await screen.findByRole('dialog', { name: 'Edit appearance' });
  const flash = within(dialog).getByLabelText('Flash length (ms)');
  await user.clear(flash);
  await user.type(flash, '600');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.putDeviceConfig).toHaveBeenCalledTimes(1));
  expect(api.putDeviceConfig).toHaveBeenCalledWith('k1', {
    ...CONFIG,
    appearance: { ...CONFIG.appearance, flash_ms: 600 },
  });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
});

it('shows a 422 beside its field and keeps the modal open', async () => {
  const user = userEvent.setup();
  api.putDeviceConfig.mockRejectedValue(new ApiError(422, 'bad_config', {
    code: 'bad_config', field: 'appearance.flash_ms', message: 'flash_ms must be 100 to 2000',
  }));
  renderAt('/hardware/kiosks/k1/settings');
  await screen.findByRole('heading', { name: 'Appearance' });
  await user.click(screen.getByRole('button', { name: 'Edit appearance' }));
  const dialog = await screen.findByRole('dialog', { name: 'Edit appearance' });
  const flash = within(dialog).getByLabelText('Flash length (ms)');
  await user.clear(flash);
  await user.type(flash, '5');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  const err = await within(dialog).findByText('flash_ms must be 100 to 2000');
  // beside the field: inside the same form group as the input
  expect(err.closest('.kd-field')).toBe(flash.closest('.kd-field'));
  expect(screen.getByRole('dialog', { name: 'Edit appearance' })).not.toBeNull();
});

it('reset asks for confirmation first', async () => {
  const user = userEvent.setup();
  api.resetDeviceConfig.mockResolvedValue(detail());
  renderAt('/hardware/kiosks/k1/settings');
  await screen.findByRole('heading', { name: 'Appearance' });
  await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));
  const dialog = await screen.findByRole('dialog', { name: 'Reset to defaults' });
  expect(api.resetDeviceConfig).not.toHaveBeenCalled();
  await user.click(within(dialog).getByRole('button', { name: 'Reset settings' }));
  await waitFor(() => expect(api.resetDeviceConfig).toHaveBeenCalledWith('k1'));
});

it.each([
  ['in_sync', 'In sync'],
  ['pending', 'Pending on kiosk'],
  ['waiting_first_report', 'Waiting for first report'],
] as const)('the sync line reads %s', async (state, text) => {
  api.getDevice.mockResolvedValue(detail({
    sync_state: state,
    config_reported_at: state === 'waiting_first_report' ? null : '2026-10-17T11:00:00Z',
  }));
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  const line = screen.getByTestId('kiosk-sync-line');
  expect(line.textContent).toContain(text);
});

it('changes the scan type from the Setup & move tab', async () => {
  const user = userEvent.setup();
  api.setDeviceScanType.mockResolvedValue(detail({ scan_status: 'received', scan_status_label: 'Received RFID' }));
  renderAt('/hardware/kiosks/k1/setup');
  await screen.findByText('Initech ORD1 to AUS1 Migration');
  await user.click(screen.getByRole('combobox', { name: 'Scan type' }));
  await user.click(await screen.findByText('Received RFID'));
  await user.click(screen.getByRole('button', { name: 'Save scan type' }));
  await waitFor(() => expect(api.setDeviceScanType).toHaveBeenCalledWith('k1', 'received'));
});

it('history list: column floors, shared template, sideways-scroll card', async () => {
  renderAt('/hardware/kiosks/k1/history');
  const row = (await screen.findByText('Appearance › Flash length: 350 → 600')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
  expect(within(head).getAllByText(/^(At|Source|By|Changes)$/).map((n) => n.textContent?.trim()))
    .toEqual(['At', 'Source', 'By', 'Changes']);
});

it('an unknown kiosk shows not found', async () => {
  api.getDevice.mockRejectedValue(new ApiError(404, 'device_not_found'));
  renderAt('/hardware/kiosks/nope');
  expect(await screen.findByText('Kiosk not found')).not.toBeNull();
});

it('an Android kiosk that has never reported shows the not-reported note and no Edit', async () => {
  api.getDevice.mockResolvedValue(detail({
    sub_type: 'zebra', station_type: null, rfid_reader: null,
    config: null, config_version: 0, config_changed_at: null, config_source: null,
    config_changed_by_name: null, config_reported_at: null, config_applied_version: null,
    sync_state: 'waiting_first_report',
  }));
  renderAt('/hardware/kiosks/k1/settings');
  expect(await screen.findByRole('heading', { name: 'RFID sled' })).not.toBeNull();
  expect(screen.queryByRole('heading', { name: 'Off-move alarm' })).toBeNull();
  expect(screen.getAllByText(/Settings not reported by this app version yet/).length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: /^Edit/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reset to defaults' })).toBeNull();
});
