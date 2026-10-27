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
      notif: { sound: 'chime', categories: { approvals: 'email', reports: 'email', wiki: 'email', learning: 'email', security: 'email' } },
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
  setDevicePersonal: vi.fn(),
  forgetDeviceBiometric: vi.fn(),
  listUsers: vi.fn(),
  listPersonalCandidates: vi.fn(),
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

it('a Time Clock laptop reads "Time Clock" on Overview and Setup, with no scan type picker', async () => {
  api.getDevice.mockResolvedValue(detail({
    station_type: 'timeclock', rfid_reader: null,
    scan_status: null, scan_status_label: null,
    setup: {
      initiative_id: 'i1', initiative_name: 'Initech ORD1 to AUS1 Migration',
      site_id: 's1', site_name: 'ORD1', site_role: 'source', station_type: 'timeclock',
      scan_status: null, scan_status_label: null,
    },
  }));
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  expect(screen.getAllByText('Time Clock \u00b7 Laptop').length).toBeGreaterThan(0);
  expect(screen.getByText('Time Clock')).not.toBeNull();
  expect(screen.queryByText(/timeclock/)).toBeNull();
  cleanup();
  renderAt('/hardware/kiosks/k1/setup');
  await screen.findByText('Initech ORD1 to AUS1 Migration');
  expect(screen.getByText('Time Clock')).not.toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Scan type' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save scan type' })).toBeNull();
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
  }, 3);
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
  await waitFor(() => expect(api.resetDeviceConfig).toHaveBeenCalledWith('k1', 3));
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

it('a stale save shows the changed note; Reload keeps the draft and saves on the fresh version', async () => {
  const user = userEvent.setup();
  // the kiosk reported a new volume (version 4) while the editor was open
  const fresh = structuredClone(CONFIG);
  (fresh.sound as { volume: number }).volume = 0.5;
  api.putDeviceConfig.mockRejectedValueOnce(new ApiError(409, 'config_changed', {
    code: 'config_changed', config_version: 4,
  }));
  renderAt('/hardware/kiosks/k1/settings');
  await screen.findByRole('heading', { name: 'Appearance' });
  api.getDevice.mockResolvedValue(detail({ config: fresh, config_version: 4, sync_state: 'in_sync' }));

  await user.click(screen.getByRole('button', { name: 'Edit appearance' }));
  const dialog = await screen.findByRole('dialog', { name: 'Edit appearance' });
  expect(dialog.querySelector('.modal-body')?.classList.contains('kd-modal-scroll')).toBe(true);
  const flash = within(dialog).getByLabelText('Flash length (ms)');
  await user.clear(flash);
  await user.type(flash, '600');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText("This kiosk's settings changed since you opened them."))
    .not.toBeNull();
  expect(api.putDeviceConfig).toHaveBeenCalledTimes(1);

  await user.click(within(dialog).getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(api.getDevice).toHaveBeenCalledTimes(2));
  // the draft survives the reload
  expect((within(screen.getByRole('dialog', { name: 'Edit appearance' }))
    .getByLabelText('Flash length (ms)') as HTMLInputElement).value).toBe('600');
  await user.click(within(screen.getByRole('dialog', { name: 'Edit appearance' }))
    .getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.putDeviceConfig).toHaveBeenCalledTimes(2));
  // built on the fresh document: the kiosk's newer volume is kept
  expect(api.putDeviceConfig).toHaveBeenLastCalledWith('k1', {
    ...fresh,
    appearance: { ...CONFIG.appearance, flash_ms: 600 },
  }, 4);
});

it('a 409 not_reported save says the kiosk has to report first', async () => {
  const user = userEvent.setup();
  api.putDeviceConfig.mockRejectedValueOnce(new ApiError(409, 'not_reported', {
    code: 'not_reported',
  }));
  renderAt('/hardware/kiosks/k1/settings');
  await screen.findByRole('heading', { name: 'Appearance' });
  await user.click(screen.getByRole('button', { name: 'Edit appearance' }));
  const dialog = await screen.findByRole('dialog', { name: 'Edit appearance' });
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  expect(await within(dialog).findByText(
    "This kiosk hasn't reported its settings yet. They can be edited after its first report."))
    .not.toBeNull();
  expect(within(dialog).queryByRole('button', { name: 'Reload' })).toBeNull();
});

it('a stale reset offers Reload; the reset modal has a close button', async () => {
  const user = userEvent.setup();
  api.resetDeviceConfig.mockRejectedValueOnce(new ApiError(409, 'config_changed', {
    code: 'config_changed', config_version: 4,
  }));
  renderAt('/hardware/kiosks/k1/settings');
  await screen.findByRole('heading', { name: 'Appearance' });
  await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));
  const dialog = await screen.findByRole('dialog', { name: 'Reset to defaults' });
  await user.click(within(dialog).getByRole('button', { name: 'Reset settings' }));
  expect(await within(dialog).findByText("This kiosk's settings changed since you opened them."))
    .not.toBeNull();
  api.getDevice.mockResolvedValue(detail({ config_version: 4 }));
  api.resetDeviceConfig.mockResolvedValue(detail({ config_version: 5 }));
  await user.click(within(dialog).getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(api.getDevice).toHaveBeenCalledTimes(2));
  await user.click(within(screen.getByRole('dialog', { name: 'Reset to defaults' }))
    .getByRole('button', { name: 'Reset settings' }));
  await waitFor(() => expect(api.resetDeviceConfig).toHaveBeenLastCalledWith('k1', 4));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

  await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));
  const again = await screen.findByRole('dialog', { name: 'Reset to defaults' });
  await user.click(within(again).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('a history load failure leaves the source lines off and the History tab shows the error', async () => {
  const user = userEvent.setup();
  api.getDeviceConfigHistory.mockRejectedValue(new ApiError(500, 'boom'));
  renderAt('/hardware/kiosks/k1/settings');
  await screen.findByRole('heading', { name: 'Appearance' });
  await waitFor(() => expect(api.getDeviceConfigHistory).toHaveBeenCalled());
  expect(screen.queryByText(/changed on the|No changes recorded/)).toBeNull();
  await user.click(screen.getByRole('tab', { name: 'History' }));
  expect(await screen.findByText("Couldn't load the history.")).not.toBeNull();
});

const LABEL_STATION = {
  label_kind: 'front',
  printer: { type: 'network', ip: '10.0.0.40', model: 'ZT411', serial: 'S1' },
  dpi: 300, offset_x: -12, offset_y: 4,
};

it('the Devices tab shows a read-only Label Station card from config.label_station', async () => {
  api.getDevice.mockResolvedValue(detail({ config: { ...structuredClone(CONFIG), label_station: LABEL_STATION } }));
  renderAt('/hardware/kiosks/k1/devices');
  const head = await screen.findByRole('heading', { name: 'Label Station' });
  const card = head.closest('.panel') as HTMLElement;
  expect(within(card).getByText('Front')).not.toBeNull();
  expect(within(card).getByText('Network')).not.toBeNull();
  expect(within(card).getByText('ZT411')).not.toBeNull();
  expect(within(card).getByText('10.0.0.40')).not.toBeNull();
  expect(within(card).getByText('300 dpi')).not.toBeNull();
  expect(within(card).getByText('-12 dots')).not.toBeNull();
  expect(within(card).getByText('4 dots')).not.toBeNull();
  expect(within(card).queryByRole('button')).toBeNull();
});

it('the Label Station card shows the print mode: peel off, or tear off when not reported', async () => {
  api.getDevice.mockResolvedValue(detail({ config: {
    ...structuredClone(CONFIG), label_station: { ...LABEL_STATION, peel: true } } }));
  renderAt('/hardware/kiosks/k1/devices');
  let card = (await screen.findByRole('heading', { name: 'Label Station' })).closest('.panel') as HTMLElement;
  expect(within(card).getByText('Print mode')).not.toBeNull();
  expect(within(card).getByText('Peel off')).not.toBeNull();
  cleanup();
  // a laptop from before the peeler check reports no peel: tear off
  api.getDevice.mockResolvedValue(detail({ config: { ...structuredClone(CONFIG), label_station: LABEL_STATION } }));
  renderAt('/hardware/kiosks/k1/devices');
  card = (await screen.findByRole('heading', { name: 'Label Station' })).closest('.panel') as HTMLElement;
  expect(within(card).getByText('Tear off')).not.toBeNull();
});

it('a USB Label Station shows no IP row', async () => {
  api.getDevice.mockResolvedValue(detail({ config: {
    ...structuredClone(CONFIG),
    label_station: { ...LABEL_STATION, label_kind: 'top', printer: { type: 'usb', ip: null, model: 'ZD621', serial: null } },
  } }));
  renderAt('/hardware/kiosks/k1/devices');
  const head = await screen.findByRole('heading', { name: 'Label Station' });
  const card = head.closest('.panel') as HTMLElement;
  expect(within(card).getByText('Top')).not.toBeNull();
  expect(within(card).getByText('USB')).not.toBeNull();
  expect(within(card).queryByText('IP')).toBeNull();
});

it('the Label Station card is hidden when the section is absent or null', async () => {
  renderAt('/hardware/kiosks/k1/devices');
  await screen.findByText('FX9600');
  expect(screen.queryByRole('heading', { name: 'Label Station' })).toBeNull();
  cleanup();
  api.getDevice.mockResolvedValue(detail({ config: { ...structuredClone(CONFIG), label_station: null } }));
  renderAt('/hardware/kiosks/k1/devices');
  await screen.findByText('FX9600');
  expect(screen.queryByRole('heading', { name: 'Label Station' })).toBeNull();
});

it('an edit elsewhere sends label_station back untouched', async () => {
  const user = userEvent.setup();
  const config = { ...structuredClone(CONFIG), label_station: LABEL_STATION };
  api.getDevice.mockResolvedValue(detail({ config }));
  renderAt('/hardware/kiosks/k1/settings');
  await screen.findByRole('heading', { name: 'Appearance' });
  await user.click(screen.getByRole('button', { name: 'Edit appearance' }));
  const dialog = await screen.findByRole('dialog', { name: 'Edit appearance' });
  const flash = within(dialog).getByLabelText('Flash length (ms)');
  await user.clear(flash);
  await user.type(flash, '600');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.putDeviceConfig).toHaveBeenCalledTimes(1));
  const sent = api.putDeviceConfig.mock.calls[0][1] as Record<string, unknown>;
  expect(JSON.stringify(sent.label_station)).toBe(JSON.stringify(LABEL_STATION));
});

/* ── Personal device (biometric sign-in) ───────────────────────────── */

/** Local noon on Nov 22: "Nov 22" in every time zone. */
const NOV_22 = new Date(2099, 10, 22, 12).toISOString();

/** A plain (non-station) phone kiosk that is Lee's personal device. */
function personal(overrides: Partial<DeviceDetail> = {}): DeviceDetail {
  const base = detail();
  return detail({
    sub_type: 'android', station_type: null, rfid_reader: null,
    setup: { ...base.setup, station_type: null },
    shared_station: false,
    personal_person: { id: 'p9', display_name: 'Lee Owner' },
    personal_biometric: { on: true, renews_at: NOV_22 },
    ...overrides,
  });
}

/** What GET /devices/{id}/personal-candidates answers: eligible people only. */
const PEOPLE = [
  { person_id: 'p2', display_name: 'Sam Lead', login_email: 'sam@x.test' },
  { person_id: 'p3', display_name: 'Ann Other', login_email: 'ann@x.test' },
];

/** The server's search: name or email, case-insensitively. */
function candidates() {
  api.listPersonalCandidates.mockImplementation(async (_id: string, q?: string) => {
    const needle = (q ?? '').trim().toLowerCase();
    return PEOPLE.filter((p) => !needle || p.display_name.toLowerCase().includes(needle)
      || p.login_email.toLowerCase().includes(needle));
  });
}

function personalRow(): HTMLElement {
  return screen.getByTestId('kiosk-personal');
}

it('Overview shows the personal device, its fingerprint status, and Change, Clear and Forget fingerprint', async () => {
  api.getDevice.mockResolvedValue(personal());
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  expect(screen.getByText('Personal device')).not.toBeNull();
  const row = personalRow();
  expect(within(row).getByText('Lee Owner')).not.toBeNull();
  expect(within(row).getByText('Fingerprint on · renews by Nov 22')).not.toBeNull();
  expect(within(row).getByRole('button', { name: 'Change…' })).not.toBeNull();
  expect(within(row).getByRole('button', { name: 'Clear' })).not.toBeNull();
  expect(within(row).getByRole('button', { name: 'Forget fingerprint' })).not.toBeNull();
});

it('an expired key reads expired; no key reads off and offers no Forget fingerprint', async () => {
  api.getDevice.mockResolvedValue(personal({ personal_biometric: { on: true, renews_at: '2020-01-02T12:00:00Z' } }));
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  expect(within(personalRow()).getByText('Fingerprint expired · renews at the next password sign-in')).not.toBeNull();
  cleanup();
  api.getDevice.mockResolvedValue(personal({ personal_biometric: { on: false, renews_at: null } }));
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  expect(within(personalRow()).getByText('Fingerprint off')).not.toBeNull();
  expect(within(personalRow()).queryByRole('button', { name: 'Forget fingerprint' })).toBeNull();
});

it("the picker offers the server's eligible people, searches there, and saves the chosen person", async () => {
  const user = userEvent.setup();
  api.getDevice.mockResolvedValue(personal({ personal_person: null, personal_biometric: null }));
  candidates();
  api.setDevicePersonal.mockResolvedValue(personal({
    personal_person: { id: 'p2', display_name: 'Sam Lead' }, personal_biometric: { on: false, renews_at: null },
  }));
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  expect(within(personalRow()).getByText('None')).not.toBeNull();
  await user.click(within(personalRow()).getByRole('button', { name: 'Choose person…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Whose phone is this?' });
  expect(within(dialog).getByText('Kiosk 97F0 · Personal device')).not.toBeNull();
  expect(await within(dialog).findByText('Ann Other')).not.toBeNull();
  expect(api.listPersonalCandidates).toHaveBeenCalledWith('k1', '');
  await user.type(within(dialog).getByRole('searchbox', { name: 'Search people' }), 'sam');
  await waitFor(() => expect(within(dialog).queryByText('Ann Other')).toBeNull());
  expect(api.listPersonalCandidates).toHaveBeenLastCalledWith('k1', 'sam');
  expect(api.listUsers).not.toHaveBeenCalled();
  const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  await user.click(within(dialog).getByRole('radio', { name: /Sam Lead/ }));
  await user.click(save);
  await waitFor(() => expect(api.setDevicePersonal).toHaveBeenCalledWith('k1', 'p2'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(within(personalRow()).getByText('Sam Lead')).not.toBeNull();
  expect(within(personalRow()).getByText('Fingerprint off')).not.toBeNull();
});

it('a not_eligible refusal shows its reason in the picker and keeps it open', async () => {
  const user = userEvent.setup();
  api.getDevice.mockResolvedValue(personal({ personal_person: null, personal_biometric: null }));
  candidates();
  api.setDevicePersonal.mockRejectedValue(
    new ApiError(422, 'not_eligible', { code: 'not_eligible', reason: 'no_kiosk_view' }));
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  await user.click(within(personalRow()).getByRole('button', { name: 'Choose person…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Whose phone is this?' });
  await user.click(await within(dialog).findByRole('radio', { name: /Ann Other/ }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  const err = await within(dialog).findByRole('alert');
  expect(err.textContent).toBe("They don't have kiosk access.");
  expect(screen.getByRole('dialog', { name: 'Whose phone is this?' })).not.toBeNull();
});

it('Clear removes the person', async () => {
  const user = userEvent.setup();
  api.getDevice.mockResolvedValue(personal());
  api.setDevicePersonal.mockResolvedValue(personal({ personal_person: null, personal_biometric: null }));
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  await user.click(within(personalRow()).getByRole('button', { name: 'Clear' }));
  await waitFor(() => expect(api.setDevicePersonal).toHaveBeenCalledWith('k1', null));
  expect(await within(personalRow()).findByText('None')).not.toBeNull();
  expect(within(personalRow()).queryByRole('button', { name: 'Clear' })).toBeNull();
});

it('Forget fingerprint revokes the key and reloads the status; a read-only refusal shows its message', async () => {
  const user = userEvent.setup();
  api.getDevice.mockResolvedValueOnce(personal())
    .mockResolvedValue(personal({ personal_biometric: { on: false, renews_at: null } }));
  api.forgetDeviceBiometric.mockRejectedValueOnce(
    new ApiError(423, 'read_only_mode', undefined, 'The portal is read-only right now.'));
  api.forgetDeviceBiometric.mockResolvedValue(undefined);
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  await user.click(within(personalRow()).getByRole('button', { name: 'Forget fingerprint' }));
  expect((await within(personalRow()).findByRole('alert')).textContent).toBe('The portal is read-only right now.');
  await user.click(within(personalRow()).getByRole('button', { name: 'Forget fingerprint' }));
  await waitFor(() => expect(api.forgetDeviceBiometric).toHaveBeenCalledTimes(2));
  expect(await within(personalRow()).findByText('Fingerprint off')).not.toBeNull();
  expect(within(personalRow()).queryByRole('alert')).toBeNull();
});

it('without the rights the personal device is read-only', async () => {
  api.getDevice.mockResolvedValue(personal());
  auth.maxRank = 60;
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  expect(within(personalRow()).getByText('Lee Owner')).not.toBeNull();
  expect(within(personalRow()).getByText('Fingerprint on · renews by Nov 22')).not.toBeNull();
  expect(within(personalRow()).queryAllByRole('button')).toHaveLength(0);
  cleanup();
  auth.maxRank = 80;
  auth.can = (_r, a) => a === 'view';
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  expect(within(personalRow()).queryAllByRole('button')).toHaveLength(0);
});

it('a shared station says it cannot be a personal device; a stale person there can only be cleared', async () => {
  renderAt('/hardware/kiosks/k1');   // the default fixture is an RFID Station
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  expect(within(personalRow()).getByText("Shared station — can't be a personal device")).not.toBeNull();
  expect(within(personalRow()).queryAllByRole('button')).toHaveLength(0);
  cleanup();
  api.getDevice.mockResolvedValue(detail({
    personal_person: { id: 'p9', display_name: 'Lee Owner' }, personal_biometric: { on: false, renews_at: null },
  }));
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  expect(within(personalRow()).getByText('Lee Owner')).not.toBeNull();
  expect(within(personalRow()).getByText("Shared station — can't be a personal device")).not.toBeNull();
  expect(within(personalRow()).getAllByRole('button').map((b) => b.textContent)).toEqual(['Clear']);
});

it('a station-key kiosk with no station type reads as shared (the shared_station flag)', async () => {
  api.getDevice.mockResolvedValue(personal({
    shared_station: true, personal_person: null, personal_biometric: null,
  }));
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  expect(within(personalRow()).getByText("Shared station — can't be a personal device")).not.toBeNull();
  expect(within(personalRow()).queryByRole('button', { name: 'Choose person…' })).toBeNull();
  expect(within(personalRow()).queryByText('None')).toBeNull();
});

it('a biometric session reads "Fingerprint" on Overview', async () => {
  api.getDevice.mockResolvedValue(personal({ session_login_method: 'biometric' }));
  renderAt('/hardware/kiosks/k1');
  await screen.findByRole('heading', { name: /Kiosk 97F0/ });
  expect(screen.getByText('Fingerprint')).not.toBeNull();
});
