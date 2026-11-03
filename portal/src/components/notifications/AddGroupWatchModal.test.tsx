// @vitest-environment jsdom
/**
 * AddGroupWatchModal — "Add watch" on a group's page: point the group at an
 * initiative, a site or a truck (picked from what the admin can see), or at
 * chosen events everywhere (Everything), and say which events. Save stays off
 * until there is a thing (when one is needed) and a valid choice of events;
 * switching what is watched starts the choice over.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, READ_ONLY_MESSAGE, type NotificationGroupDetail, type NotificationKindSetting,
} from '../../lib/api';

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(),
  listSites: vi.fn(),
  listTrucks: vi.fn(),
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
  api.createGroupWatch.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function open() {
  render(<AddGroupWatchModal group={GROUP} kinds={KINDS} onAdded={onAdded} onClose={onClose} />);
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

/** Open a picker and click one of its options (the menu portals out of the dialog). */
async function pick(user: ReturnType<typeof userEvent.setup>, field: string, option: string) {
  await openPicker(user, field);
  await user.click(await screen.findByRole('button', { name: option }));
}

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

it('the "Watch" strip offers Initiative, Site, Truck and Everything, each with aria-pressed', () => {
  const dialog = open();

  const strip = within(dialog).getByRole('group', { name: 'Watch' });
  expect(strip.classList.contains('segmented')).toBe(true);
  const buttons = within(strip).getAllByRole('button');
  expect(buttons.map((b) => b.textContent)).toEqual(['Initiative', 'Site', 'Truck', 'Everything']);
  for (const b of buttons) expect(b.hasAttribute('aria-pressed')).toBe(true);
});

it('opens on Initiative: that segment is pressed, and its field is the Initiative one', () => {
  open();

  expect(segment('Initiative').getAttribute('aria-pressed')).toBe('true');
  for (const other of ['Site', 'Truck', 'Everything']) {
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

it('a list that does not load says why beside the buttons, and loads again when the kind is chosen again', async () => {
  const user = userEvent.setup();
  api.listSites.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
  open();

  await user.click(segment('Site'));
  const error = await screen.findByRole('alert');
  expect(error.textContent).toBe('Request failed (forbidden).');
  expect(error.classList.contains('pf-error')).toBe(true);
  expect(save().disabled).toBe(true);

  await user.click(segment('Truck'));
  expect(screen.queryByRole('alert')).toBeNull();

  await user.click(segment('Site'));
  await waitFor(() => expect(api.listSites).toHaveBeenCalledTimes(2));
  await openPicker(user, 'Site');
  expect(await screen.findByRole('button', { name: 'Site A' })).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
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
