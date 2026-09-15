// @vitest-environment jsdom
/**
 * DeviceEditModal — create/edit for a single kiosk or handheld-reader
 * device row (generalized from the kiosk-only KioskEditModal via
 * deviceType/noun/typeOptions props). Covers: the exact createDevice
 * payload in create mode, the diff-only patchDevice payload in edit mode,
 * the move select's planned/in_progress-unarchived filter, the
 * detail-code error surface, and that typeOptions drives the Type select
 * (handheld types produce a handheld_reader create payload).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type DeviceItem, type InitiativeItem, type SiteItem, type StatusValue,
} from '../../lib/api';

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(),
  listStatusValues: vi.fn(),
  listSites: vi.fn(),
  createDevice: vi.fn(),
  patchDevice: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

function move(overrides: Partial<InitiativeItem>): InitiativeItem {
  return {
    id: 'i0', name: 'Move', description: null,
    initiative_type: 'move', type_label: 'Move', type_color: '#a36207',
    sub_type: null, sub_type_label: null, sub_type_color: null,
    status: 'planned', status_label: 'Planned', status_color: '#1668a7',
    color: null,
    client_id: null, client_name: null, site_id: null, site_name: null,
    location: null,
    scheduled_start: null, scheduled_end: null,
    sky_command_project_id: null,
    origin_site_id: null, origin_site_name: null,
    destination_site_id: null, destination_site_name: null,
    real_start_at: null, real_end_at: null, priority_devices: null,
    shipping_types: [],
    shipping_partner_id: null, shipping_partner_name: null,
    origin_tech_partner_id: null, origin_cable_partner_id: null,
    origin_logistics_partner_id: null, destination_tech_partner_id: null,
    destination_cable_partner_id: null, destination_logistics_partner_id: null,
    origin_vendor_involved: null, destination_vendor_involved: null,
    people_count: 0, links_count: 0,
    archived_at: null, created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const INITIATIVES: InitiativeItem[] = [
  move({ id: 'i1', name: 'NAP11 Hall Migration (demo)', status: 'planned' }),
  move({ id: 'i2', name: 'Dock B Refresh', status: 'in_progress' }),
  move({ id: 'i3', name: 'Old Done Move', status: 'done' }),
  move({ id: 'i4', name: 'Archived Planned Move', status: 'planned',
         archived_at: '2026-01-01T00:00:00Z' }),
  move({ id: 'i5', name: 'Server Upgrade Project', status: 'planned',
         initiative_type: 'project' }),
];

const STATUSES: StatusValue[] = [
  { record_type: 'asset', key: 'idle', label: 'Idle', description: '', color: '#178a4c',
    sort_order: 1, is_active: true, usage_count: null, progress_weight: null },
  { record_type: 'asset', key: 'scanning', label: 'Scanning', description: '', color: '#a36207',
    sort_order: 2, is_active: true, usage_count: null, progress_weight: null },
  { record_type: 'asset', key: 'retired', label: 'Retired', description: '', color: '#c03540',
    sort_order: 3, is_active: false, usage_count: null, progress_weight: null },
  { record_type: 'site', key: 'active', label: 'Active', description: '', color: '#178a4c',
    sort_order: 1, is_active: true, usage_count: null, progress_weight: null },
];

const SITES: SiteItem[] = [
  { id: 's1', name: 'NAP 11', code: null, site_type: null, type_label: null, type_color: null,
    status: 'active', status_label: 'Active', status_color: '#178a4c',
    address_line1: null, address_line2: null, city: null, region: null, postal_code: null,
    country: 'US', latitude: null, longitude: null, timezone: null, dc_provider: null,
    partner_id: null, partner_name: null, notes: null, archived_at: null,
    created_at: '2026-01-01T00:00:00Z', clients: [] },
];

const DEVICE: DeviceItem = {
  id: 'd1', device_type: 'kiosk', name: 'kiosk-1',
  serial: null, mac: '94:83:C4:00:01:01',
  site_id: 's1', site_name: 'NAP 11',
  wan_ip: null, lan_ip: '192.168.8.31',
  uptime_seconds: null, last_seen_at: null,
  raw_info: {}, registered_at: '2026-08-19T10:00:00Z',
  vpn_status: null, token_expires_at: null, connected_count: 0,
  model: null, antennas_connected: null, connection_type: null,
  scan_status: 'idle', scan_status_label: 'Idle', scan_status_color: '#178a4c',
  tags_read_24h: 0,
  version: '2.4.0', sub_type: 'laptop',
  current_initiative_id: 'i1', current_initiative_name: 'NAP11 Hall Migration (demo)',
  session_person_id: null, session_person_name: null,
  session_login_method: null, session_started_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listInitiatives.mockResolvedValue(INITIATIVES);
  api.listStatusValues.mockResolvedValue(STATUSES);
  api.listSites.mockResolvedValue(SITES);
});

afterEach(cleanup);

const { default: DeviceEditModal } = await import('./DeviceEditModal');

const KIOSK_TYPE_OPTIONS = [{ value: 'laptop', label: 'Laptop' }, { value: 'pi', label: 'Pi' }];
const HANDHELD_TYPE_OPTIONS = [
  { value: 'android', label: 'Android' }, { value: 'ios', label: 'iOS' },
  { value: 'zebra', label: 'Zebra' },
];

function renderCreate(typeOptions = KIOSK_TYPE_OPTIONS) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<DeviceEditModal deviceType="kiosk" noun="kiosk" typeOptions={typeOptions}
                          device={null} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

function renderEdit(device: DeviceItem = DEVICE) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<DeviceEditModal deviceType="kiosk" noun="kiosk" typeOptions={KIOSK_TYPE_OPTIONS}
                          device={device} onClose={onClose} onSaved={onSaved} />);
  return { onClose, onSaved };
}

it('create mode: fills name, type, scan type, and move, then submits the exact createDevice payload', async () => {
  const user = userEvent.setup();
  api.createDevice.mockResolvedValue({ ...DEVICE, id: 'new-1' });
  const { onSaved } = renderCreate();

  await user.type(await screen.findByLabelText('Name'), 'kiosk-lobby-1');
  await user.selectOptions(screen.getByLabelText('Type'), 'pi');
  await user.selectOptions(screen.getByLabelText('Scan Type'), 'scanning');
  await user.selectOptions(screen.getByLabelText('Current Move'), 'i1');

  await user.click(screen.getByRole('button', { name: /Create kiosk/i }));

  await waitFor(() => expect(api.createDevice).toHaveBeenCalledTimes(1));
  expect(api.createDevice).toHaveBeenCalledWith({
    device_type: 'kiosk', name: 'kiosk-lobby-1',
    sub_type: 'pi', mac: null, lan_ip: null, version: null,
    site_id: null, current_initiative_id: 'i1', scan_status: 'scanning',
  });
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

it('with handheld typeOptions, the Type select offers Android/iOS/Zebra and create posts device_type: handheld_reader', async () => {
  const user = userEvent.setup();
  api.createDevice.mockResolvedValue({ ...DEVICE, id: 'new-2' });
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(<DeviceEditModal deviceType="handheld_reader" noun="handheld reader"
                          typeOptions={HANDHELD_TYPE_OPTIONS}
                          device={null} onClose={onClose} onSaved={onSaved} />);

  const typeSelect = await screen.findByLabelText('Type') as HTMLSelectElement;
  const labels = Array.from(typeSelect.options).map((o) => o.textContent);
  expect(labels).toEqual(['— none', 'Android', 'iOS', 'Zebra']);

  await user.type(screen.getByLabelText('Name'), 'handheld-1');
  await user.selectOptions(typeSelect, 'zebra');
  await user.click(screen.getByRole('button', { name: /Create handheld reader/i }));

  await waitFor(() => expect(api.createDevice).toHaveBeenCalledTimes(1));
  expect(api.createDevice).toHaveBeenCalledWith(expect.objectContaining({
    device_type: 'handheld_reader', sub_type: 'zebra',
  }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

it('disables Save until a name is entered', async () => {
  renderCreate();
  await screen.findByLabelText('Name');
  const save = screen.getByRole('button', { name: /Create kiosk/i }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
});

it('edit mode: prefills from the device, changing only version submits patchDevice with ONLY {version}', async () => {
  const user = userEvent.setup();
  api.patchDevice.mockResolvedValue(DEVICE);
  const { onSaved } = renderEdit();

  const nameInput = await screen.findByLabelText('Name') as HTMLInputElement;
  expect(nameInput.value).toBe('kiosk-1');
  expect((screen.getByLabelText('Type') as HTMLSelectElement).value).toBe('laptop');
  expect((screen.getByLabelText('MAC') as HTMLInputElement).value).toBe('94:83:C4:00:01:01');
  expect((screen.getByLabelText('IP') as HTMLInputElement).value).toBe('192.168.8.31');
  expect((screen.getByLabelText('Version') as HTMLInputElement).value).toBe('2.4.0');
  expect((screen.getByLabelText('Site') as HTMLSelectElement).value).toBe('s1');
  expect((screen.getByLabelText('Current Move') as HTMLSelectElement).value).toBe('i1');
  expect((screen.getByLabelText('Scan Type') as HTMLSelectElement).value).toBe('idle');

  const versionInput = screen.getByLabelText('Version') as HTMLInputElement;
  await user.clear(versionInput);
  await user.type(versionInput, '2.5.0');

  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.patchDevice).toHaveBeenCalledTimes(1));
  expect(api.patchDevice).toHaveBeenCalledWith('d1', { version: '2.5.0' });
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

it('move select offers only unarchived planned/in_progress MOVE initiatives', async () => {
  renderCreate();
  const select = await screen.findByLabelText('Current Move') as HTMLSelectElement;
  const labels = Array.from(select.options).map((o) => o.textContent);

  expect(labels).toContain('NAP11 Hall Migration (demo)');
  expect(labels).toContain('Dock B Refresh');
  expect(labels).not.toContain('Old Done Move');
  expect(labels).not.toContain('Archived Planned Move');
  expect(labels).not.toContain('Server Upgrade Project');
});

it('shows the mapped error text when the save call rejects with bad_scan_status', async () => {
  const user = userEvent.setup();
  api.patchDevice.mockRejectedValue(new ApiError(422, 'bad_scan_status'));
  renderEdit();

  await screen.findByLabelText('Name');
  const versionInput = screen.getByLabelText('Version') as HTMLInputElement;
  await user.clear(versionInput);
  await user.type(versionInput, '2.5.0');
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('Pick a valid scan type.')).not.toBeNull();
});
