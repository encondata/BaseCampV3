// @vitest-environment jsdom
/**
 * AddGroupWatchModal — "Add watch" on a group's page: point the group at an
 * initiative, a site, a truck or a device (picked from what the admin can see;
 * a device only if notifications cover it), or at chosen events everywhere
 * (Everything), and say which events. Save stays off until there is a thing
 * (when one is needed) and a valid choice of events; switching what is watched
 * starts the choice over.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, READ_ONLY_MESSAGE, type DeviceItem, type NotificationGroupDetail,
  type NotificationKindSetting,
} from '../../lib/api';

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(),
  listSites: vi.fn(),
  listTrucks: vi.fn(),
  listDevices: vi.fn(),
  createGroupWatch: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: AddGroupWatchModal } = await import('./AddGroupWatchModal');

const GROUP: NotificationGroupDetail = {
  id: 'g1', name: 'Group A', description: '', enabled: true, member_count: 0,
  created_at: '2026-11-02T00:00:00Z', members: [],
};

const kind = (
  key: string, label: string, category: NotificationKindSetting['category'],
  over: Partial<NotificationKindSetting> = {},
): NotificationKindSetting => ({
  kind: key, label, category, email: true, owner_always: false, critical: false, locked: false,
  watchable: false, everywhere: false, reaches: [], ...over,
});

// In registry order, as GET /notifications/settings lists them.
const KINDS: NotificationKindSetting[] = [
  kind('report_ready', 'Report ready', 'reports'),
  kind('initiative_status_changed', 'Initiative status changed', 'initiatives',
    { watchable: true, everywhere: true, reaches: ['initiative', 'site'] }),
  kind('truck_status_changed', 'Truck status changed', 'trucks',
    { watchable: true, everywhere: true, reaches: ['truck', 'initiative', 'site'] }),
  kind('kind_a', 'Kind A', 'initiatives', { watchable: true, reaches: ['initiative'] }),
];

// The lists carry far more than the picker uses: only the id and the name count.
const INITIATIVES = [
  { id: 'ini-a', name: 'Initiative A', status: 'planned' },
  { id: 'ini-b', name: 'Initiative B', status: 'active' },
];
const SITES = [
  { id: 'site-a', name: 'Site A', code: 'SA' },
  { id: 'site-b', name: 'Site B', code: null },
];
const TRUCKS = [
  { id: 'truck-a', name: 'Truck A', status: 'in_transit' },
];

/** A device as GET /devices lists it. The picker reads only its type, its name and what makes it
 *  one that notifications cover; the rest is here to make a whole DeviceItem. */
const device = (id: string, name: string, over: Partial<DeviceItem> = {}): DeviceItem => ({
  id, device_type: 'fixed_reader', name,
  serial: null, mac: null, site_id: null, site_name: null, wan_ip: null, lan_ip: null,
  uptime_seconds: null, last_seen_at: null, raw_info: {}, registered_at: '2026-11-02T00:00:00Z',
  vpn_status: null, token_expires_at: null, connected_count: 0,
  model: null, antennas_connected: null, connection_type: null,
  scan_status: null, scan_status_label: null, scan_status_color: null, tags_read_24h: 0,
  version: null, sub_type: null, current_initiative_id: null, current_initiative_name: null,
  session_person_id: null, session_person_name: null, session_login_method: null,
  session_started_at: null, setup_clear_requested_at: null, setup_clear_requested_by_name: null,
  ...over,
});

const laptop = (station: DeviceItem['station_type']): Partial<DeviceItem> =>
  ({ device_type: 'kiosk', sub_type: 'laptop', station_type: station });

// The devices notifications cover (A, B, C: an RFID Station, a fixed reader, an approved router)
// among those they do not. Device C's hostname is what the Routers list makes readable.
const DEVICES: DeviceItem[] = [
  device('dev-d', 'Device D', laptop('label')),
  device('dev-a', 'Device A', laptop('rfid')),
  device('dev-e', 'Device E', laptop('timeclock')),
  device('dev-f', 'Device F', laptop(null)),
  device('dev-b', 'Device B'),
  device('dev-g', 'Device G', { device_type: 'kiosk', sub_type: 'android', station_type: 'rfid' }),
  device('dev-h', 'Device H', { device_type: 'kiosk', sub_type: 'web' }),
  device('dev-i', 'device_i', { device_type: 'router', approval_state: 'pending' }),
  device('dev-c', 'device_c', { device_type: 'router', approval_state: 'approved' }),
  device('dev-j', 'device_j', { device_type: 'router', approval_state: 'revoked' }),
  device('dev-k', 'device_k', { device_type: 'router', approval_state: null }),
  device('dev-l', 'Device L', { device_type: 'handheld_reader' }),
];

/** The registry's Device offline: it reaches devices, sites and initiatives, and an Everything watch may name it. */
const DEVICE_OFFLINE = kind('device_offline', 'Device offline', 'devices',
  { watchable: true, everywhere: true, reaches: ['device', 'site', 'initiative'] });

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const onAdded = vi.fn();
const onClose = vi.fn();

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  api.listInitiatives.mockResolvedValue(INITIATIVES);
  api.listSites.mockResolvedValue(SITES);
  api.listTrucks.mockResolvedValue(TRUCKS);
  api.listDevices.mockResolvedValue(DEVICES);
  api.createGroupWatch.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function open(kinds: NotificationKindSetting[] = KINDS) {
  render(<AddGroupWatchModal group={GROUP} kinds={kinds} onAdded={onAdded} onClose={onClose} />);
  return screen.getByRole('dialog', { name: 'Add watch' });
}

const segment = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const combobox = (name: string) => screen.getByRole('combobox', { name }) as HTMLInputElement;
const checkbox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const footer = () => screen.getByRole('dialog').querySelector('.modal-foot') as HTMLElement;
const save = () => within(footer()).getByRole('button', { name: 'Add watch' }) as HTMLButtonElement;
const cancel = () => within(footer()).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;

/** Open a picker once its list is in (it is off until then). */
async function openPicker(user: ReturnType<typeof userEvent.setup>, field: string) {
  const input = combobox(field);
  await waitFor(() => expect(input.disabled).toBe(false));
  await user.click(input);
}

/** Open a picker and click one of its options (the menu portals out of the dialog). An option is
 *  found by its own text: a device's kind is shown beside its name, in the same button. */
async function pick(user: ReturnType<typeof userEvent.setup>, field: string, option: string) {
  await openPicker(user, field);
  await user.click(await screen.findByText(option, { selector: '.kbar-item' }));
}

/** What the open picker offers: each option's name, and the kind shown beside it (if any). */
const offered = () => [...document.querySelectorAll('.combo-menu .kbar-item')]
  .map((o) => [o.firstChild?.textContent, o.querySelector('.sub')?.textContent]);

// ── the header ──────────────────────────────────────────────────────────

it('wears the standard header: the group\'s name, "Add watch", and the description', () => {
  const dialog = open();

  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Group A');
  expect(within(dialog).getByRole('heading', { name: 'Add watch', level: 3 })).toBeTruthy();
  expect(dialog.querySelector('p.page-hint')?.textContent)
    .toBe("Pick what this group's members hear about.");
  expect(dialog.classList.contains('nm-card')).toBe(true);
  expect(dialog.classList.contains('rgm-card')).toBe(true);
});

it('uses house controls only: no select', () => {
  const dialog = open();

  expect(dialog.querySelector('select')).toBeNull();
});

it('the footer is Add watch (btn-solid) and Cancel (mini-btn), with the error line beside them', async () => {
  const user = userEvent.setup();
  api.createGroupWatch.mockRejectedValue(new ApiError(404, 'thing_not_found'));
  open();

  expect(save().className).toBe('btn-solid');
  expect(save().getAttribute('type')).toBe('button');
  expect(cancel().className).toBe('mini-btn');

  await pick(user, 'Initiative', 'Initiative A');
  await user.click(save());
  const error = await screen.findByRole('alert');
  expect(error.tagName).toBe('SPAN');
  expect(error.classList.contains('pf-error')).toBe(true);
  expect(footer().contains(error)).toBe(true);
});

// ── what is watched ─────────────────────────────────────────────────────

it('the "Watch" strip offers Initiative, Site, Truck, Device and Everything, each with aria-pressed', () => {
  const dialog = open();

  const strip = within(dialog).getByRole('group', { name: 'Watch' });
  expect(strip.classList.contains('segmented')).toBe(true);
  const buttons = within(strip).getAllByRole('button');
  expect(buttons.map((b) => b.textContent))
    .toEqual(['Initiative', 'Site', 'Truck', 'Device', 'Everything']);
  for (const b of buttons) expect(b.hasAttribute('aria-pressed')).toBe(true);
});

it('opens on Initiative: that segment is pressed, and its field is the Initiative one', () => {
  open();

  expect(segment('Initiative').getAttribute('aria-pressed')).toBe('true');
  for (const other of ['Site', 'Truck', 'Device', 'Everything']) {
    expect(segment(other).getAttribute('aria-pressed')).toBe('false');
  }
  expect(combobox('Initiative').getAttribute('placeholder')).toBe('Search initiatives…');
});

it('picking Site presses it, and shows the field "Site" with "Search sites…"', async () => {
  const user = userEvent.setup();
  open();

  await user.click(segment('Site'));

  expect(segment('Site').getAttribute('aria-pressed')).toBe('true');
  expect(segment('Initiative').getAttribute('aria-pressed')).toBe('false');
  expect(combobox('Site').getAttribute('placeholder')).toBe('Search sites…');
  expect(screen.queryByRole('combobox', { name: 'Initiative' })).toBeNull();
});

it('picking Truck shows the field "Truck" with "Search trucks…"', async () => {
  const user = userEvent.setup();
  open();

  await user.click(segment('Truck'));

  expect(combobox('Truck').getAttribute('placeholder')).toBe('Search trucks…');
});

it('picking Device presses it, and shows the field "Device" with "Search devices…"', async () => {
  const user = userEvent.setup();
  open();

  await user.click(segment('Device'));

  expect(segment('Device').getAttribute('aria-pressed')).toBe('true');
  expect(segment('Initiative').getAttribute('aria-pressed')).toBe('false');
  expect(combobox('Device').getAttribute('placeholder')).toBe('Search devices…');
  expect(screen.queryByRole('combobox', { name: 'Initiative' })).toBeNull();
});

it('the field label is the thing\'s name, tied to the picker', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(segment('Site'));

  const label = within(dialog).getByText('Site', { selector: 'label' });
  expect(label.getAttribute('for')).toBe(combobox('Site').id);
  expect(combobox('Site').id).not.toBe('');
});

it('lists the initiatives for the picker as the dialog opens, by name', async () => {
  const user = userEvent.setup();
  open();

  await waitFor(() => expect(api.listInitiatives).toHaveBeenCalledTimes(1));
  await openPicker(user, 'Initiative');

  expect((await screen.findByRole('button', { name: 'Initiative A' })).classList.contains('kbar-item')).toBe(true);
  expect(screen.getByRole('button', { name: 'Initiative B' })).toBeTruthy();
  expect(api.listSites).not.toHaveBeenCalled();
  expect(api.listTrucks).not.toHaveBeenCalled();
  expect(api.listDevices).not.toHaveBeenCalled();
});

it('the options of Site come from listSites, the name being the label', async () => {
  const user = userEvent.setup();
  open();

  await user.click(segment('Site'));
  await waitFor(() => expect(api.listSites).toHaveBeenCalledTimes(1));
  await openPicker(user, 'Site');

  expect(await screen.findByRole('button', { name: 'Site A' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Site B' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Initiative A' })).toBeNull();
});

it('the options of Truck come from listTrucks, which leaves archived trucks out', async () => {
  const user = userEvent.setup();
  open();

  await user.click(segment('Truck'));
  await openPicker(user, 'Truck');

  expect(await screen.findByRole('button', { name: 'Truck A' })).toBeTruthy();
  expect(api.listTrucks).toHaveBeenCalledTimes(1);
  expect(api.listTrucks).toHaveBeenCalledWith();
});

it('the options of Device come from listDevices, only for the devices notifications cover, each with its kind beside its name', async () => {
  const user = userEvent.setup();
  open();

  await user.click(segment('Device'));
  await waitFor(() => expect(api.listDevices).toHaveBeenCalledTimes(1));
  expect(api.listDevices).toHaveBeenCalledWith();
  await openPicker(user, 'Device');
  await screen.findByText('Device A', { selector: '.kbar-item' });

  // An RFID Station, a fixed reader and an approved router, in the order the list gave them:
  // not another kiosk (a Label Station, a Time Clock, a laptop with no station type, an Android
  // one whose station type reads rfid, a web kiosk), nor a router that is pending, revoked or
  // not an agent's, nor a device of any other type
  expect(offered()).toEqual([
    ['Device A', 'RFID Station'],
    ['Device B', 'Fixed Reader'],
    ['Device C', 'Router'],
  ]);
  expect(screen.queryByRole('button', { name: 'Initiative A' })).toBeNull();
});

it('names a router as the Routers list does (its hostname made readable) and any other device as it is', async () => {
  const user = userEvent.setup();
  api.listDevices.mockResolvedValue([
    device('dev-r', 'device_r', { device_type: 'router', approval_state: 'approved' }),
    device('dev-s', 'device_s', laptop('rfid')),
    device('dev-f', 'device_f'),
  ]);
  open();

  await user.click(segment('Device'));
  await openPicker(user, 'Device');
  await screen.findByText('Device R', { selector: '.kbar-item' });

  expect(offered()).toEqual([
    ['Device R', 'Router'],
    ['device_s', 'RFID Station'],
    ['device_f', 'Fixed Reader'],
  ]);
});

it('the Device picker filters by what is typed, its kind included', async () => {
  const user = userEvent.setup();
  open();
  await user.click(segment('Device'));

  await openPicker(user, 'Device');
  await user.type(combobox('Device'), 'Fixed');

  expect(await screen.findByText('Device B', { selector: '.kbar-item' })).toBeTruthy();
  expect(offered()).toEqual([['Device B', 'Fixed Reader']]);
});

it('a device list with nothing to watch in it offers no devices', async () => {
  const user = userEvent.setup();
  api.listDevices.mockResolvedValue([
    device('dev-d', 'Device D', laptop('label')),
    device('dev-i', 'device_i', { device_type: 'router', approval_state: 'pending' }),
  ]);
  open();
  await user.click(segment('Device'));

  await openPicker(user, 'Device');

  expect(await screen.findByText('No matches.')).toBeTruthy();
  expect(offered()).toEqual([]);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('the picker filters by what is typed', async () => {
  const user = userEvent.setup();
  open();
  await user.click(segment('Site'));

  await openPicker(user, 'Site');
  await user.type(combobox('Site'), 'B');

  expect(await screen.findByRole('button', { name: 'Site B' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Site A' })).toBeNull();
});

it('asks for a kind\'s things once: coming back to a kind uses the answer it has', async () => {
  const user = userEvent.setup();
  open();
  await openPicker(user, 'Initiative');
  await screen.findByRole('button', { name: 'Initiative A' });   // the answer is in
  await user.click(segment('Site'));
  await openPicker(user, 'Site');
  await screen.findByRole('button', { name: 'Site A' });

  await user.click(segment('Initiative'));
  await user.click(segment('Site'));
  await user.click(segment('Everything'));
  await user.click(segment('Initiative'));

  expect(api.listInitiatives).toHaveBeenCalledTimes(1);
  expect(api.listSites).toHaveBeenCalledTimes(1);
  await openPicker(user, 'Initiative');
  expect(await screen.findByRole('button', { name: 'Initiative A' })).toBeTruthy();
});

it('a menu left open when the kind is changed from the keyboard does not carry over to the new kind', async () => {
  const user = userEvent.setup();
  open();
  await openPicker(user, 'Initiative');
  await screen.findByRole('button', { name: 'Initiative A' });   // its menu is open

  await user.tab({ shift: true });      // Everything
  await user.tab({ shift: true });      // Device
  await user.tab({ shift: true });      // Truck
  await user.tab({ shift: true });      // Site
  expect(document.activeElement).toBe(segment('Site'));
  await user.keyboard('{Enter}');

  expect(segment('Site').getAttribute('aria-pressed')).toBe('true');
  expect(combobox('Site').getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: 'Site A' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Initiative A' })).toBeNull();
});

// ── saving a thing ──────────────────────────────────────────────────────

it('Save stays disabled until a site is picked, then adds with All events on', async () => {
  const user = userEvent.setup();
  open();
  await user.click(segment('Site'));

  expect(save().disabled).toBe(true);
  await user.click(save());
  expect(api.createGroupWatch).not.toHaveBeenCalled();

  await pick(user, 'Site', 'Site A');
  expect(combobox('Site').value).toBe('Site A');
  expect(save().disabled).toBe(false);
});

it('Save adds the group\'s watch on the site: createGroupWatch(groupId, {thing: "site", id, kinds: []})', async () => {
  const user = userEvent.setup();
  open();
  await user.click(segment('Site'));
  await pick(user, 'Site', 'Site B');

  await user.click(save());

  await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  expect(api.createGroupWatch).toHaveBeenCalledTimes(1);
  expect(api.createGroupWatch).toHaveBeenCalledWith('g1', { thing: 'site', id: 'site-b', kinds: [] });
});

it('adds an initiative and a truck the same way', async () => {
  const user = userEvent.setup();
  open();
  await pick(user, 'Initiative', 'Initiative B');
  await user.click(save());
  await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  expect(api.createGroupWatch).toHaveBeenLastCalledWith(
    'g1', { thing: 'initiative', id: 'ini-b', kinds: [] });

  cleanup();
  onAdded.mockClear();
  open();
  await user.click(segment('Truck'));
  await pick(user, 'Truck', 'Truck A');
  await user.click(save());
  await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  expect(api.createGroupWatch).toHaveBeenLastCalledWith(
    'g1', { thing: 'truck', id: 'truck-a', kinds: [] });
});

it('Save stays disabled until a device is picked, then adds the group\'s watch on it: createGroupWatch(groupId, {thing: "device", id, kinds: []})', async () => {
  const user = userEvent.setup();
  open();
  await user.click(segment('Device'));

  expect(save().disabled).toBe(true);
  await user.click(save());
  expect(api.createGroupWatch).not.toHaveBeenCalled();

  await pick(user, 'Device', 'Device B');
  expect(combobox('Device').value).toBe('Device B');
  expect(save().disabled).toBe(false);
  await user.click(save());

  await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  expect(api.createGroupWatch).toHaveBeenCalledTimes(1);
  expect(api.createGroupWatch).toHaveBeenCalledWith('g1', { thing: 'device', id: 'dev-b', kinds: [] });
});

it('a router is added by its id, whatever its name reads as', async () => {
  const user = userEvent.setup();
  open();
  await user.click(segment('Device'));
  await pick(user, 'Device', 'Device C');

  expect(combobox('Device').value).toBe('Device C');
  await user.click(save());

  await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  expect(api.createGroupWatch).toHaveBeenCalledWith('g1', { thing: 'device', id: 'dev-c', kinds: [] });
});

it('the events of a device: All events is on, and turning it off offers Device offline to pick', async () => {
  const user = userEvent.setup();
  open([...KINDS, DEVICE_OFFLINE]);
  await user.click(segment('Device'));
  await pick(user, 'Device', 'Device A');

  expect(checkbox('All events').checked).toBe(true);
  expect(screen.queryByRole('checkbox', { name: 'Device offline' })).toBeNull();

  await user.click(checkbox('All events'));

  // Only what reaches a device: not the status changes of an initiative or a truck
  expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label')))
    .toEqual(['All events', 'Device offline']);
  expect(save().disabled).toBe(true);

  await user.click(checkbox('Device offline'));
  expect(save().disabled).toBe(false);
  await user.click(save());

  await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  expect(api.createGroupWatch).toHaveBeenCalledWith(
    'g1', { thing: 'device', id: 'dev-a', kinds: ['device_offline'] });
});

it('the events follow the thing: "All events" is on, and turning it off lists what applies to the thing', async () => {
  const user = userEvent.setup();
  open();
  await user.click(segment('Site'));

  expect(checkbox('All events').checked).toBe(true);
  expect(screen.queryByRole('checkbox', { name: 'Truck status changed' })).toBeNull();

  await user.click(checkbox('All events'));

  // What reaches a site, not what reaches an initiative only
  expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label')))
    .toEqual(['All events', 'Initiative status changed', 'Truck status changed']);
});

it('with All events off, Save stays disabled until an event is picked as well as a thing', async () => {
  const user = userEvent.setup();
  open();
  await user.click(segment('Site'));
  await pick(user, 'Site', 'Site A');
  expect(save().disabled).toBe(false);

  await user.click(checkbox('All events'));
  expect(save().disabled).toBe(true);

  await user.click(checkbox('Truck status changed'));
  expect(save().disabled).toBe(false);

  await user.click(checkbox('Truck status changed'));
  expect(save().disabled).toBe(true);
});

it('picked events are saved in registry order, whatever order they were picked in', async () => {
  const user = userEvent.setup();
  open();
  await user.click(segment('Site'));
  await pick(user, 'Site', 'Site A');
  await user.click(checkbox('All events'));
  await user.click(checkbox('Truck status changed'));
  await user.click(checkbox('Initiative status changed'));

  await user.click(save());

  await waitFor(() => expect(api.createGroupWatch).toHaveBeenCalledTimes(1));
  expect(api.createGroupWatch).toHaveBeenCalledWith('g1', {
    thing: 'site', id: 'site-a', kinds: ['initiative_status_changed', 'truck_status_changed'],
  });
});

it('a picked event is not enough without a thing', async () => {
  const user = userEvent.setup();
  open();
  await user.click(checkbox('All events'));
  await user.click(checkbox('Kind A'));

  expect(save().disabled).toBe(true);
});

// ── Everything ──────────────────────────────────────────────────────────

it('Everything hides the picker and the "All events" switch, and lists its events from the start', async () => {
  const user = userEvent.setup();
  open();

  await user.click(segment('Everything'));

  expect(segment('Everything').getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('checkbox', { name: 'All events' })).toBeNull();
  expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label')))
    .toEqual(['Initiative status changed', 'Truck status changed']);
  expect(screen.getAllByRole('checkbox').every((c) => !(c as HTMLInputElement).checked)).toBe(true);
});

it('Everything asks for no list of things', async () => {
  const user = userEvent.setup();
  open();
  await waitFor(() => expect(api.listInitiatives).toHaveBeenCalledTimes(1));

  await user.click(segment('Everything'));

  expect(api.listSites).not.toHaveBeenCalled();
  expect(api.listTrucks).not.toHaveBeenCalled();
  expect(api.listDevices).not.toHaveBeenCalled();
});

it('Everything keeps Save disabled until a kind is picked, then adds it with no thing', async () => {
  const user = userEvent.setup();
  open();
  await user.click(segment('Everything'));

  expect(save().disabled).toBe(true);
  await user.click(save());
  expect(api.createGroupWatch).not.toHaveBeenCalled();

  await user.click(checkbox('Truck status changed'));
  expect(save().disabled).toBe(false);
  await user.click(save());

  await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  expect(api.createGroupWatch).toHaveBeenCalledWith(
    'g1', { thing: 'everything', id: null, kinds: ['truck_status_changed'] });
});

// ── switching what is watched ───────────────────────────────────────────

it('switching kinds clears the picked thing and puts the events back to All events', async () => {
  const user = userEvent.setup();
  open();
  await pick(user, 'Initiative', 'Initiative A');
  await user.click(checkbox('All events'));
  await user.click(checkbox('Kind A'));
  expect(save().disabled).toBe(false);

  await user.click(segment('Site'));

  expect(combobox('Site').value).toBe('');
  expect(checkbox('All events').checked).toBe(true);
  expect(screen.queryByRole('checkbox', { name: 'Kind A' })).toBeNull();
  expect(save().disabled).toBe(true);

  // and back: the initiative is not remembered either
  await user.click(segment('Initiative'));
  expect(combobox('Initiative').value).toBe('');
  expect(save().disabled).toBe(true);
});

it('switching to Everything starts with All off and nothing picked, and back from it starts with All on', async () => {
  const user = userEvent.setup();
  open();
  await pick(user, 'Initiative', 'Initiative A');

  await user.click(segment('Everything'));
  expect(save().disabled).toBe(true);
  expect(screen.getAllByRole('checkbox').every((c) => !(c as HTMLInputElement).checked)).toBe(true);

  await user.click(checkbox('Truck status changed'));
  await user.click(segment('Truck'));
  expect(checkbox('All events').checked).toBe(true);
  expect(combobox('Truck').value).toBe('');

  await user.click(segment('Everything'));
  expect(checkbox('Truck status changed').checked).toBe(false);
  expect(save().disabled).toBe(true);
});

it('pressing the segment that is already on changes nothing', async () => {
  const user = userEvent.setup();
  open();
  await user.click(segment('Site'));
  await pick(user, 'Site', 'Site A');
  await user.click(checkbox('All events'));
  await user.click(checkbox('Truck status changed'));

  await user.click(segment('Site'));

  expect(combobox('Site').value).toBe('Site A');
  expect(checkbox('Truck status changed').checked).toBe(true);
  expect(save().disabled).toBe(false);
});

// ── a refused save ──────────────────────────────────────────────────────

it('already_watching says "You\'re already watching this." in pf-error, and the dialog stays open', async () => {
  const user = userEvent.setup();
  api.createGroupWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  open();
  await user.click(segment('Site'));
  await pick(user, 'Site', 'Site A');

  await user.click(save());

  const error = await screen.findByRole('alert');
  expect(error.textContent).toBe("You're already watching this.");
  expect(error.classList.contains('pf-error')).toBe(true);
  expect(onAdded).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(save().disabled).toBe(false);
});

it('any other API error reads as the house fallback with its code', async () => {
  const user = userEvent.setup();
  api.createGroupWatch.mockRejectedValue(new ApiError(404, 'thing_not_found'));
  open();
  await pick(user, 'Initiative', 'Initiative A');

  await user.click(save());

  expect((await screen.findByRole('alert')).textContent).toBe('Request failed (thing_not_found).');
  expect(onAdded).not.toHaveBeenCalled();
});

it('read-only maintenance says its own message', async () => {
  const user = userEvent.setup();
  api.createGroupWatch.mockRejectedValue(
    new ApiError(423, 'read_only_mode', { code: 'read_only_mode' }, READ_ONLY_MESSAGE));
  open();
  await pick(user, 'Initiative', 'Initiative A');

  await user.click(save());

  expect((await screen.findByRole('alert')).textContent).toBe(READ_ONLY_MESSAGE);
});

it('a failure that is not the API\'s (no connection) is the plain sentence', async () => {
  const user = userEvent.setup();
  api.createGroupWatch.mockRejectedValue(new Error('Failed to fetch'));
  open();
  await pick(user, 'Initiative', 'Initiative A');

  await user.click(save());

  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't update your watch.");
});

it('an old error goes when the choice is changed, and the save can be tried again', async () => {
  const user = userEvent.setup();
  api.createGroupWatch
    .mockRejectedValueOnce(new ApiError(409, 'already_watching'))
    .mockResolvedValueOnce({});
  open();
  await pick(user, 'Initiative', 'Initiative A');
  await user.click(save());
  await screen.findByRole('alert');

  await pick(user, 'Initiative', 'Initiative B');
  expect(screen.queryByRole('alert')).toBeNull();

  await user.click(save());
  await waitFor(() => expect(onAdded).toHaveBeenCalledTimes(1));
  expect(api.createGroupWatch.mock.calls.map((call) => (call[1] as { id: string }).id))
    .toEqual(['ini-a', 'ini-b']);
});

it('an old error also goes when the events or the kind of thing are changed', async () => {
  const user = userEvent.setup();
  api.createGroupWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  open();
  await pick(user, 'Initiative', 'Initiative A');
  await user.click(save());
  await screen.findByRole('alert');

  await user.click(checkbox('All events'));
  expect(screen.queryByRole('alert')).toBeNull();

  await user.click(checkbox('Kind A'));
  await user.click(save());
  await screen.findByRole('alert');

  await user.click(segment('Everything'));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('is locked while the save is on its way: no second save, no Cancel, no ×, no Escape, no change of choice', async () => {
  const user = userEvent.setup();
  const pending = deferred<unknown>();
  api.createGroupWatch.mockReturnValue(pending.promise);
  open();
  await pick(user, 'Initiative', 'Initiative A');

  await user.click(save());
  await waitFor(() => expect(save().disabled).toBe(true));

  await user.click(save());
  expect(api.createGroupWatch).toHaveBeenCalledTimes(1);
  expect(cancel().disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();

  // The request is for the thing and events it was sent with: the choice can't move under it
  expect(combobox('Initiative').disabled).toBe(true);
  await user.click(segment('Site'));
  await user.click(checkbox('All events'));
  expect(segment('Initiative').getAttribute('aria-pressed')).toBe('true');
  expect(combobox('Initiative').value).toBe('Initiative A');
  expect(checkbox('All events').checked).toBe(true);

  await act(async () => { pending.resolve({}); });
  expect(onAdded).toHaveBeenCalledTimes(1);
});

it('Cancel and the × close it without adding anything', async () => {
  const user = userEvent.setup();
  open();
  await pick(user, 'Initiative', 'Initiative A');

  await user.click(cancel());
  await user.click(screen.getByRole('button', { name: 'Close' }));

  expect(onClose).toHaveBeenCalledTimes(2);
  expect(api.createGroupWatch).not.toHaveBeenCalled();
  expect(onAdded).not.toHaveBeenCalled();
});

// ── the lists that do not load ──────────────────────────────────────────

it('a list that does not load says so beside the buttons, and loads again when the kind is chosen again', async () => {
  const user = userEvent.setup();
  api.listSites.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
  open();

  await user.click(segment('Site'));
  const error = await screen.findByRole('alert');
  expect(error.textContent).toBe('Could not load the site list.');
  expect(error.tagName).toBe('SPAN');
  expect(error.classList.contains('pf-error')).toBe(true);
  expect(footer().contains(error)).toBe(true);
  expect(save().disabled).toBe(true);

  await user.click(segment('Truck'));
  expect(screen.queryByRole('alert')).toBeNull();

  await user.click(segment('Site'));
  await waitFor(() => expect(api.listSites).toHaveBeenCalledTimes(2));
  await openPicker(user, 'Site');
  expect(await screen.findByRole('button', { name: 'Site A' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each([
  ['Initiative', 'listInitiatives', 'Could not load the initiative list.'],
  ['Site', 'listSites', 'Could not load the site list.'],
  ['Truck', 'listTrucks', 'Could not load the truck list.'],
  ['Device', 'listDevices', 'Could not load the device list.'],
] as const)('%s: a list that does not load says so in its own sentence, whatever the failure was', async (kind, call, copy) => {
  const user = userEvent.setup();
  api[call].mockRejectedValue(new Error('Failed to fetch'));
  open();
  if (kind !== 'Initiative') await user.click(segment(kind));

  expect((await screen.findByRole('alert')).textContent).toBe(copy);
  expect(combobox(kind).disabled).toBe(true);
  expect(save().disabled).toBe(true);
});

it('a list that does not load says the same for an error of the API: its code is not told', async () => {
  api.listInitiatives.mockRejectedValue(new ApiError(500, 'boom'));
  open();

  expect((await screen.findByRole('alert')).textContent).toBe('Could not load the initiative list.');
});

it('the notice of a list that did not load stays while the events are changed, and the picker stays off', async () => {
  const user = userEvent.setup();
  api.listSites.mockRejectedValue(new ApiError(500, 'boom'));
  open();
  await user.click(segment('Site'));
  await screen.findByRole('alert');

  await user.click(checkbox('All events'));
  expect(screen.getByRole('alert').textContent).toBe('Could not load the site list.');
  await user.click(checkbox('Truck status changed'));
  expect(screen.getByRole('alert').textContent).toBe('Could not load the site list.');
  await user.click(checkbox('Truck status changed'));
  await user.click(checkbox('All events'));

  expect(screen.getByRole('alert').textContent).toBe('Could not load the site list.');
  expect(combobox('Site').disabled).toBe(true);
  expect(save().disabled).toBe(true);
});

it('the notice of a list that did not load goes when another kind is chosen, Everything included', async () => {
  const user = userEvent.setup();
  api.listSites.mockRejectedValue(new ApiError(500, 'boom'));
  open();
  await user.click(segment('Site'));
  await screen.findByRole('alert');

  await user.click(segment('Everything'));

  expect(screen.queryByRole('alert')).toBeNull();
});

it('the notice goes when the list arrives after all (an earlier request, answering late)', async () => {
  const user = userEvent.setup();
  const slow = deferred<unknown>();
  api.listSites.mockReturnValueOnce(slow.promise).mockRejectedValueOnce(new ApiError(500, 'boom'));
  open();

  await user.click(segment('Site'));          // the first request, still out
  await user.click(segment('Truck'));
  await user.click(segment('Site'));          // asks again: this one fails
  expect((await screen.findByRole('alert')).textContent).toBe('Could not load the site list.');
  expect(combobox('Site').disabled).toBe(true);

  await act(async () => { slow.resolve(SITES); });

  expect(screen.queryByRole('alert')).toBeNull();
  expect(combobox('Site').disabled).toBe(false);
  await user.click(combobox('Site'));
  expect(await screen.findByRole('button', { name: 'Site A' })).toBeTruthy();
});

it('the picker is off while its list is on its way, and on once it is in', async () => {
  const user = userEvent.setup();
  const sites = deferred<unknown>();
  api.listSites.mockReturnValue(sites.promise);
  open();

  await user.click(segment('Site'));
  expect(combobox('Site').disabled).toBe(true);
  expect(combobox('Site').getAttribute('placeholder')).toBe('Search sites…');

  await act(async () => { sites.resolve(SITES); });
  expect(combobox('Site').disabled).toBe(false);
  await user.click(combobox('Site'));
  expect(await screen.findByRole('button', { name: 'Site A' })).toBeTruthy();
});

it('the picker stays off when its list does not load, and comes on when the retry brings it in', async () => {
  const user = userEvent.setup();
  api.listSites.mockRejectedValueOnce(new ApiError(500, 'boom'));
  open();

  await user.click(segment('Site'));
  await screen.findByRole('alert');
  expect(combobox('Site').disabled).toBe(true);

  await user.click(segment('Truck'));
  await user.click(segment('Site'));
  await waitFor(() => expect(combobox('Site').disabled).toBe(false));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('a failure for a kind that is no longer chosen is not told', async () => {
  const user = userEvent.setup();
  const sites = deferred<unknown>();
  api.listSites.mockReturnValue(sites.promise);
  open();

  await user.click(segment('Site'));
  await user.click(segment('Truck'));
  await act(async () => { sites.reject(new ApiError(500, 'boom')); });

  expect(screen.queryByRole('alert')).toBeNull();
  await openPicker(user, 'Truck');
  expect(await screen.findByRole('button', { name: 'Truck A' })).toBeTruthy();
});

it('a list that lands after another kind was chosen is kept for its own kind', async () => {
  const user = userEvent.setup();
  const sites = deferred<unknown>();
  api.listSites.mockReturnValue(sites.promise);
  open();

  await user.click(segment('Site'));
  await user.click(segment('Truck'));
  await act(async () => { sites.resolve(SITES); });
  expect(screen.queryByRole('button', { name: 'Site A' })).toBeNull();   // not the Truck picker's

  await user.click(segment('Site'));
  await openPicker(user, 'Site');

  expect(await screen.findByRole('button', { name: 'Site A' })).toBeTruthy();
  expect(api.listSites).toHaveBeenCalledTimes(1);
});
