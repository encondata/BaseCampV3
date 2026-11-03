// @vitest-environment jsdom
/**
 * WatchesSection — "What you watch" on /me › Notifications: the person's own
 * watches and their groups', how to change the events of their own or stop
 * watching, and the "everywhere" button that watches (or edits) chosen events
 * across everything they can see.
 */

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, READ_ONLY_MESSAGE, type NotificationKindSetting, type Watch } from '../../lib/api';

const api = vi.hoisted(() => ({
  listMyWatches: vi.fn(),
  createMyWatch: vi.fn(),
  updateMyWatch: vi.fn(),
  deleteMyWatch: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: WatchesSection } = await import('./WatchesSection');

const INI_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const GROUP_ID = '44444444-4444-4444-8444-444444444444';

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
];

const YOU: Watch['via'] = { type: 'you', id: null, name: null };
const GROUP_A: Watch['via'] = { type: 'group', id: GROUP_ID, name: 'Group A' };

const ownInitiative: Watch = {
  id: 'w-ini', thing: 'initiative', thing_id: INI_ID, thing_name: 'Initiative A',
  link: `/initiatives/${INI_ID}`, kinds: [], via: YOU, created_at: '2026-11-02T12:00:00Z',
};
const groupSite: Watch = {
  id: 'w-site', thing: 'site', thing_id: SITE_ID, thing_name: 'Site A',
  link: `/sites/${SITE_ID}`, kinds: ['initiative_status_changed', 'truck_status_changed'],
  via: GROUP_A, created_at: '2026-11-02T11:00:00Z',
};
const ownEverything: Watch = {
  id: 'w-all', thing: 'everything', thing_id: null, thing_name: null, link: null,
  kinds: ['truck_status_changed'], via: YOU, created_at: '2026-11-02T09:00:00Z',
};
const groupEverything: Watch = { ...ownEverything, id: 'w-gall', via: GROUP_A };

const HINT = 'Things you watch and the ones your groups watch. '
  + 'What reaches you still follows your switches and schedule.';
const EMPTY = "You aren't watching anything yet. Use Watch on a page to start.";

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  api.listMyWatches.mockReset();
  api.createMyWatch.mockReset();
  api.updateMyWatch.mockReset();
  api.deleteMyWatch.mockReset();
  api.listMyWatches.mockResolvedValue([]);
  api.createMyWatch.mockResolvedValue(ownEverything);
  api.updateMyWatch.mockResolvedValue(ownInitiative);
  api.deleteMyWatch.mockResolvedValue(undefined);
});
afterEach(cleanup);

const show = (kinds: NotificationKindSetting[] = KINDS) => (
  <MemoryRouter><WatchesSection kinds={kinds} /></MemoryRouter>
);
const renderSection = (kinds?: NotificationKindSetting[]) => render(show(kinds));

/** The section, once its watches are in. */
const loaded = () => screen.findByRole('region', { name: 'What you watch' });

const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;

/** Open a row's actions menu and pick an item. */
async function pickAction(user: ReturnType<typeof userEvent.setup>, rowName: string, item: string) {
  await user.click(within(rowOf(rowName)).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: item }));
}

it('asks for the person\'s watches once, when it mounts', async () => {
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');

  expect(api.listMyWatches).toHaveBeenCalledTimes(1);
  expect(api.createMyWatch).not.toHaveBeenCalled();
  expect(api.updateMyWatch).not.toHaveBeenCalled();
  expect(api.deleteMyWatch).not.toHaveBeenCalled();
});

it('opens with the head: "What you watch" with its count, the hint, and the everywhere button', async () => {
  api.listMyWatches.mockResolvedValue([ownInitiative, groupSite]);
  renderSection();
  const section = await loaded();

  expect(section.tagName).toBe('SECTION');
  expect(section.classList.contains('set-section')).toBe(true);
  expect(section.classList.contains('me-watch-card')).toBe(true);
  const heading = within(section).getByRole('heading', { name: /What you watch/, level: 3 });
  expect(heading.firstChild?.textContent?.trim()).toBe('What you watch');
  await waitFor(() => expect(heading.querySelector('span.badge-count')?.textContent).toBe('2'));

  const head = heading.closest('.set-head') as HTMLElement;
  expect(head.classList.contains('set-head-actions')).toBe(true);
  const hint = within(head).getByText(HINT);
  expect(hint.tagName).toBe('P');
  const button = within(head).getByRole('button', { name: 'Watch events everywhere…' });
  expect(button.classList.contains('mini-btn')).toBe(true);
  expect(button.getAttribute('type')).toBe('button');
});

it('counts every row it lists: its own and its groups\'', async () => {
  api.listMyWatches.mockResolvedValue([ownInitiative, groupSite, ownEverything]);
  renderSection();
  await screen.findByText('Site A');

  expect(document.querySelector('.badge-count')?.textContent).toBe('3');
});

it('says nothing about the list, not even that it is empty or how many, until the watches are in', async () => {
  const pending = deferred<Watch[]>();
  api.listMyWatches.mockReturnValue(pending.promise);
  renderSection();
  const section = await loaded();

  expect(screen.queryByText(EMPTY)).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
  expect(document.querySelector('.badge-count')).toBeNull();
  expect(within(section).getByRole('heading', { name: 'What you watch' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Watch events everywhere…' })).toBeTruthy();

  await act(async () => { pending.resolve([ownInitiative]); });
  expect(document.querySelector('.badge-count')?.textContent).toBe('1');
});

it('draws no count when the watches could not be loaded', async () => {
  api.listMyWatches.mockRejectedValue(new ApiError(500, 'server_error'));
  renderSection();
  await screen.findByText('Could not load your watches.');

  expect(document.querySelector('.badge-count')).toBeNull();
});

it('shows the empty state\'s copy when the person watches nothing', async () => {
  renderSection();

  expect(await screen.findByText(EMPTY)).toBeTruthy();
  expect(document.querySelector('.badge-count')?.textContent).toBe('0');
});

it('lists a table with Watching, Events and Via, and the Actions column for their own watches', async () => {
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');

  expect(screen.getAllByRole('columnheader').map((h) => h.textContent))
    .toEqual(['Watching', 'Events', 'Via', 'Actions']);
  expect(document.querySelector('.set-section .watch-table .data-table')).not.toBeNull();
});

it('an own initiative row: the name linked to its page, the Initiative chip, All events, You', async () => {
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');

  const link = screen.getByRole('link', { name: 'Initiative A' });
  expect(link.getAttribute('href')).toBe(`/initiatives/${INI_ID}`);
  const row = rowOf('Initiative A');
  expect(within(row).getByText('Initiative').classList.contains('chip')).toBe(true);
  expect(within(row).getByText('All events')).toBeTruthy();
  expect(within(row).getByText('You')).toBeTruthy();
});

it('a group row: the thing, the narrowed events\' labels, the group\'s name, and no actions', async () => {
  api.listMyWatches.mockResolvedValue([groupSite]);
  renderSection();
  await screen.findByText('Site A');

  const row = rowOf('Site A');
  expect(screen.getByRole('link', { name: 'Site A' }).getAttribute('href')).toBe(`/sites/${SITE_ID}`);
  expect(within(row).getByText('Initiative status changed, Truck status changed')).toBeTruthy();
  expect(within(row).getByText('Group A')).toBeTruthy();
  expect(within(row).queryByRole('button', { name: /Actions/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Actions/ })).toBeNull();
});

it('only their own rows get Actions, when a group\'s are listed beside them', async () => {
  api.listMyWatches.mockResolvedValue([groupSite, ownInitiative]);
  renderSection();
  await screen.findByText('Site A');

  expect(screen.getAllByRole('button', { name: /Actions/ })).toHaveLength(1);
  expect(within(rowOf('Initiative A')).getByRole('button', { name: /Actions/ })).toBeTruthy();
  expect(within(rowOf('Site A')).queryByRole('button', { name: /Actions/ })).toBeNull();
});

it('an own row\'s menu is "Choose events…" and "Stop watching" (destructive)', async () => {
  const user = userEvent.setup();
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');

  await user.click(within(rowOf('Initiative A')).getByRole('button', { name: /Actions/ }));

  expect(screen.getAllByRole('menuitem').map((m) => m.textContent))
    .toEqual(['Choose events…', 'Stop watching']);
  expect(screen.getByRole('menuitem', { name: 'Stop watching' }).className).toContain('danger');
  expect(screen.getByRole('menuitem', { name: 'Choose events…' }).className).not.toContain('danger');
});

it('"Stop watching" deletes that watch, then loads the list again', async () => {
  const user = userEvent.setup();
  api.listMyWatches.mockResolvedValueOnce([ownInitiative, groupSite]).mockResolvedValueOnce([groupSite]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Stop watching');

  expect(api.deleteMyWatch).toHaveBeenCalledTimes(1);
  expect(api.deleteMyWatch).toHaveBeenCalledWith('w-ini');
  await waitFor(() => expect(screen.queryByText('Initiative A')).toBeNull());
  expect(api.listMyWatches).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Site A')).toBeTruthy();
  expect(document.querySelector('.badge-count')?.textContent).toBe('1');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('stopping the last watch shows the empty state', async () => {
  const user = userEvent.setup();
  api.listMyWatches.mockResolvedValueOnce([ownInitiative]).mockResolvedValueOnce([]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Stop watching');

  expect(await screen.findByText(EMPTY)).toBeTruthy();
});

it('a watch being stopped cannot be stopped twice', async () => {
  const user = userEvent.setup();
  const pending = deferred<void>();
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  api.deleteMyWatch.mockReturnValue(pending.promise);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Stop watching');
  await user.click(within(rowOf('Initiative A')).getByRole('button', { name: /Actions/ }));

  expect((screen.getByRole('menuitem', { name: 'Stop watching' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('menuitem', { name: 'Stop watching' }));
  expect(api.deleteMyWatch).toHaveBeenCalledTimes(1);

  await act(async () => { pending.resolve(); });
});

it('a failed stop says why, and loads the list again to show what is true', async () => {
  const user = userEvent.setup();
  api.deleteMyWatch.mockRejectedValue(new ApiError(500, 'server_error'));
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Stop watching');

  const error = await screen.findByRole('alert');
  expect(error.textContent).toBe('Request failed (server_error).');
  expect(error.classList.contains('pf-error')).toBe(true);
  expect(api.listMyWatches).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Initiative A')).toBeTruthy();
});

it('a stop refused by read-only maintenance shows the server\'s own message', async () => {
  const user = userEvent.setup();
  api.deleteMyWatch.mockRejectedValue(
    new ApiError(423, 'read_only_mode', { code: 'read_only_mode' }, READ_ONLY_MESSAGE));
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Stop watching');

  expect((await screen.findByRole('alert')).textContent).toBe(READ_ONLY_MESSAGE);
});

it('a watch that is already gone is simply gone: no error, the list is loaded again', async () => {
  const user = userEvent.setup();
  api.deleteMyWatch.mockRejectedValue(new ApiError(404, 'watch_not_found'));
  api.listMyWatches.mockResolvedValueOnce([ownInitiative]).mockResolvedValueOnce([]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Stop watching');

  expect(await screen.findByText(EMPTY)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('an old stop error goes away when the next one succeeds', async () => {
  const user = userEvent.setup();
  api.deleteMyWatch.mockRejectedValueOnce(new ApiError(500, 'server_error'))
    .mockResolvedValueOnce(undefined);
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Stop watching');
  await screen.findByRole('alert');
  await pickAction(user, 'Initiative A', 'Stop watching');

  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(api.deleteMyWatch).toHaveBeenCalledTimes(2);
});

it('"Choose events…" opens the events dialog for that watch, with the standard header', async () => {
  const user = userEvent.setup();
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Choose events…');

  const dialog = screen.getByRole('dialog', { name: 'Initiative A' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Watch');
  expect(within(dialog).getByRole('heading', { name: 'Initiative A', level: 3 })).toBeTruthy();
  expect(dialog.querySelector('p.page-hint')?.textContent)
    .toBe('Pick the events you want to hear about.');
  // An "All events" watch opens on All events.
  expect((within(dialog).getByRole('checkbox', { name: 'All events' }) as HTMLInputElement).checked).toBe(true);
});

it('"Choose events…" on a narrowed watch opens on its events', async () => {
  const user = userEvent.setup();
  api.listMyWatches.mockResolvedValue([{ ...ownInitiative, kinds: ['truck_status_changed'] }]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Choose events…');

  const dialog = screen.getByRole('dialog');
  expect((within(dialog).getByRole('checkbox', { name: 'All events' }) as HTMLInputElement).checked).toBe(false);
  expect((within(dialog).getByRole('checkbox', { name: 'Truck status changed' }) as HTMLInputElement).checked)
    .toBe(true);
  expect((within(dialog).getByRole('checkbox', { name: 'Initiative status changed' }) as HTMLInputElement).checked)
    .toBe(false);
});

it('Choose events… → All off → Truck status changed → Save changes that watch\'s events and loads the list again', async () => {
  const user = userEvent.setup();
  api.listMyWatches.mockResolvedValueOnce([ownInitiative])
    .mockResolvedValueOnce([{ ...ownInitiative, kinds: ['truck_status_changed'] }]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Choose events…');
  const dialog = screen.getByRole('dialog', { name: 'Initiative A' });
  await user.click(within(dialog).getByRole('checkbox', { name: 'All events' }));
  await user.click(within(dialog).getByRole('checkbox', { name: 'Truck status changed' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateMyWatch).toHaveBeenCalledTimes(1));
  expect(api.updateMyWatch).toHaveBeenCalledWith('w-ini', ['truck_status_changed']);
  expect(api.createMyWatch).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.listMyWatches).toHaveBeenCalledTimes(2);
  await waitFor(() => expect(within(rowOf('Initiative A')).getByText('Truck status changed')).toBeTruthy());
});

it('Save with All events on sends no kinds', async () => {
  const user = userEvent.setup();
  api.listMyWatches.mockResolvedValue([{ ...ownInitiative, kinds: ['truck_status_changed'] }]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Choose events…');
  const dialog = screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('checkbox', { name: 'All events' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateMyWatch).toHaveBeenCalledWith('w-ini', []));
});

it('Cancel leaves the dialog without saving or loading again', async () => {
  const user = userEvent.setup();
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Choose events…');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.updateMyWatch).not.toHaveBeenCalled();
  expect(api.listMyWatches).toHaveBeenCalledTimes(1);
});

it('a save for a watch that is already gone stays in the dialog with its error, and the list is loaded again', async () => {
  const user = userEvent.setup();
  api.updateMyWatch.mockRejectedValue(new ApiError(404, 'watch_not_found'));
  api.listMyWatches.mockResolvedValueOnce([ownInitiative]).mockResolvedValue([]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Choose events…');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

  const dialog = screen.getByRole('dialog');
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Request failed (watch_not_found).');
  // the section behind it now shows what is true: the watch is gone
  expect(await screen.findByText(EMPTY)).toBeTruthy();
  expect(api.listMyWatches).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('dialog')).toBe(dialog);
});

it('an own Everything row has the same two actions, and its dialog is titled "Everything"', async () => {
  const user = userEvent.setup();
  api.listMyWatches.mockResolvedValue([ownEverything]);
  renderSection();
  await screen.findByText('Everything');

  await pickAction(user, 'Everything', 'Choose events…');

  const dialog = screen.getByRole('dialog', { name: 'Everything' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Watch');
  expect(within(dialog).getByRole('heading', { name: 'Everything', level: 3 })).toBeTruthy();
  expect(within(dialog).queryByRole('checkbox', { name: 'All events' })).toBeNull();
  expect((within(dialog).getByRole('checkbox', { name: 'Truck status changed' }) as HTMLInputElement).checked)
    .toBe(true);

  await user.click(within(dialog).getByRole('checkbox', { name: 'Initiative status changed' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateMyWatch).toHaveBeenCalledWith(
    'w-all', ['initiative_status_changed', 'truck_status_changed']));
});

it('a group\'s Everything row is listed without actions', async () => {
  api.listMyWatches.mockResolvedValue([groupEverything]);
  renderSection();
  await screen.findByText('Everything');

  expect(within(rowOf('Everything')).getByText('Group A')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Actions/ })).toBeNull();
});

it('the everywhere button opens the Everything dialog: no All switch, and Save waits for a kind', async () => {
  const user = userEvent.setup();
  renderSection();
  await screen.findByText(EMPTY);

  await user.click(screen.getByRole('button', { name: 'Watch events everywhere…' }));

  const dialog = screen.getByRole('dialog', { name: 'Everything' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Watch');
  expect(within(dialog).getByRole('heading', { name: 'Everything', level: 3 })).toBeTruthy();
  expect(dialog.querySelector('p.page-hint')?.textContent)
    .toBe('Pick the events you want to hear about.');
  expect(within(dialog).queryByRole('checkbox', { name: 'All events' })).toBeNull();
  expect(within(dialog).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label')))
    .toEqual(['Initiative status changed', 'Truck status changed']);
  const saveButton = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  expect(saveButton.disabled).toBe(true);

  await user.click(within(dialog).getByRole('checkbox', { name: 'Truck status changed' }));
  expect(saveButton.disabled).toBe(false);
});

it('Save in the everywhere dialog creates the person\'s Everything watch, and loads the list again', async () => {
  const user = userEvent.setup();
  api.listMyWatches.mockResolvedValueOnce([]).mockResolvedValueOnce([ownEverything]);
  renderSection();
  await screen.findByText(EMPTY);

  await user.click(screen.getByRole('button', { name: 'Watch events everywhere…' }));
  const dialog = screen.getByRole('dialog', { name: 'Everything' });
  await user.click(within(dialog).getByRole('checkbox', { name: 'Truck status changed' }));
  await user.click(within(dialog).getByRole('checkbox', { name: 'Initiative status changed' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.createMyWatch).toHaveBeenCalledTimes(1));
  expect(api.createMyWatch).toHaveBeenCalledWith({
    thing: 'everything', id: null, kinds: ['initiative_status_changed', 'truck_status_changed'],
  });
  expect(api.updateMyWatch).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.listMyWatches).toHaveBeenCalledTimes(2);
  // Now they have one, and the button says so.
  expect(await screen.findByRole('button', { name: 'Edit events everywhere…' })).toBeTruthy();
});

it('with an own Everything watch the button reads "Edit events everywhere…"', async () => {
  api.listMyWatches.mockResolvedValue([ownInitiative, ownEverything]);
  renderSection();

  expect(await screen.findByRole('button', { name: 'Edit events everywhere…' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Watch events everywhere…' })).toBeNull();
});

it('"Edit events everywhere…" opens on the watch\'s events, and Save changes that watch', async () => {
  const user = userEvent.setup();
  api.listMyWatches.mockResolvedValue([ownEverything]);
  renderSection();

  await user.click(await screen.findByRole('button', { name: 'Edit events everywhere…' }));
  const dialog = screen.getByRole('dialog', { name: 'Everything' });
  expect((within(dialog).getByRole('checkbox', { name: 'Truck status changed' }) as HTMLInputElement).checked)
    .toBe(true);
  await user.click(within(dialog).getByRole('checkbox', { name: 'Initiative status changed' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateMyWatch).toHaveBeenCalledTimes(1));
  expect(api.updateMyWatch).toHaveBeenCalledWith(
    'w-all', ['initiative_status_changed', 'truck_status_changed']);
  expect(api.createMyWatch).not.toHaveBeenCalled();
});

it('a group\'s Everything watch does not turn the button into Edit', async () => {
  api.listMyWatches.mockResolvedValue([groupEverything]);
  renderSection();
  await screen.findByText('Group A');

  expect(screen.getByRole('button', { name: 'Watch events everywhere…' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit events everywhere…' })).toBeNull();
});

it('a watch already there shows "You\'re already watching this." in the everywhere dialog, and the list is loaded again', async () => {
  const user = userEvent.setup();
  // made somewhere else since the list was loaded: the second answer has it
  api.createMyWatch.mockRejectedValue(new ApiError(409, 'already_watching'));
  api.listMyWatches.mockResolvedValueOnce([]).mockResolvedValue([ownEverything]);
  renderSection();
  await screen.findByText(EMPTY);

  await user.click(screen.getByRole('button', { name: 'Watch events everywhere…' }));
  const dialog = screen.getByRole('dialog', { name: 'Everything' });
  await user.click(within(dialog).getByRole('checkbox', { name: 'Truck status changed' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  expect((await within(dialog).findByRole('alert')).textContent).toBe("You're already watching this.");
  expect(screen.getByRole('dialog', { name: 'Everything' })).toBeTruthy();
  // the section behind the dialog shows the watch that is there, and its button says Edit
  expect(await screen.findByRole('button', { name: 'Edit events everywhere…' })).toBeTruthy();
  expect(screen.queryByText(EMPTY)).toBeNull();
  expect(api.listMyWatches).toHaveBeenCalledTimes(2);
});

it('an Everything watch that is already gone is told in the dialog, and the list is loaded again', async () => {
  const user = userEvent.setup();
  api.updateMyWatch.mockRejectedValue(new ApiError(404, 'watch_not_found'));
  api.listMyWatches.mockResolvedValueOnce([ownEverything]).mockResolvedValue([]);
  renderSection();

  await user.click(await screen.findByRole('button', { name: 'Edit events everywhere…' }));
  const dialog = screen.getByRole('dialog', { name: 'Everything' });
  await user.click(within(dialog).getByRole('checkbox', { name: 'Initiative status changed' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  expect((await within(dialog).findByRole('alert')).textContent).toBe('Request failed (watch_not_found).');
  expect(await screen.findByRole('button', { name: 'Watch events everywhere…' })).toBeTruthy();
  expect(api.listMyWatches).toHaveBeenCalledTimes(2);
});

it('any other refused save leaves the list alone: it is not loaded again', async () => {
  const user = userEvent.setup();
  api.updateMyWatch.mockRejectedValue(new ApiError(422, 'invalid_kind'));
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Choose events…');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

  expect((await within(screen.getByRole('dialog')).findByRole('alert')).textContent)
    .toBe('Request failed (invalid_kind).');
  expect(api.listMyWatches).toHaveBeenCalledTimes(1);
});

it('a save refused by read-only maintenance says so in the dialog and leaves the list alone', async () => {
  const user = userEvent.setup();
  api.updateMyWatch.mockRejectedValue(
    new ApiError(423, 'read_only_mode', { code: 'read_only_mode' }, READ_ONLY_MESSAGE));
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');

  await pickAction(user, 'Initiative A', 'Choose events…');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

  expect((await within(screen.getByRole('dialog')).findByRole('alert')).textContent).toBe(READ_ONLY_MESSAGE);
  expect(api.listMyWatches).toHaveBeenCalledTimes(1);
});

it('a stop error goes when a later events save goes through', async () => {
  const user = userEvent.setup();
  api.deleteMyWatch.mockRejectedValue(new ApiError(500, 'server_error'));
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');
  await pickAction(user, 'Initiative A', 'Stop watching');
  expect((await screen.findByRole('alert')).textContent).toBe('Request failed (server_error).');

  await pickAction(user, 'Initiative A', 'Choose events…');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.updateMyWatch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('a stop error goes when a later Everything save goes through', async () => {
  const user = userEvent.setup();
  api.deleteMyWatch.mockRejectedValue(new ApiError(500, 'server_error'));
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');
  await pickAction(user, 'Initiative A', 'Stop watching');
  expect((await screen.findByRole('alert')).textContent).toBe('Request failed (server_error).');

  await user.click(screen.getByRole('button', { name: 'Watch events everywhere…' }));
  const dialog = screen.getByRole('dialog', { name: 'Everything' });
  await user.click(within(dialog).getByRole('checkbox', { name: 'Truck status changed' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.createMyWatch).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('a stop error stays when a save is refused', async () => {
  const user = userEvent.setup();
  api.deleteMyWatch.mockRejectedValue(new ApiError(500, 'server_error'));
  api.updateMyWatch.mockRejectedValue(new ApiError(422, 'invalid_kind'));
  api.listMyWatches.mockResolvedValue([ownInitiative]);
  renderSection();
  await screen.findByText('Initiative A');
  await pickAction(user, 'Initiative A', 'Stop watching');
  await screen.findByRole('alert');

  await pickAction(user, 'Initiative A', 'Choose events…');
  const dialog = screen.getByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  await within(dialog).findByRole('alert');

  // the stop's own line is still under the head, outside the dialog
  const section = screen.getByRole('region', { name: 'What you watch' });
  expect(within(section).getByText('Request failed (server_error).')).toBeTruthy();
});

it('says the watches could not be loaded, and lists nothing, when the call fails', async () => {
  api.listMyWatches.mockRejectedValue(new ApiError(500, 'server_error'));
  renderSection();

  const error = await screen.findByText('Could not load your watches.');
  expect(error.classList.contains('pf-error')).toBe(true);
  expect(screen.queryByText(EMPTY)).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
  // The head and the everywhere button are still there.
  expect(screen.getByRole('heading', { name: /What you watch/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Watch events everywhere…' })).toBeTruthy();
});

it('names the events by the kinds it is given, and follows them when they arrive', async () => {
  api.listMyWatches.mockResolvedValue([{ ...ownInitiative, kinds: ['truck_status_changed'] }]);
  const view = renderSection([]);
  await screen.findByText('Initiative A');

  // Until the settings are in, an event shows as itself.
  expect(within(rowOf('Initiative A')).getByText('truck_status_changed')).toBeTruthy();

  view.rerender(show(KINDS));
  expect(within(rowOf('Initiative A')).getByText('Truck status changed')).toBeTruthy();
  expect(api.listMyWatches).toHaveBeenCalledTimes(1);
});

it('does not show the result of a list call that was overtaken by a later one', async () => {
  const user = userEvent.setup();
  const first = deferred<Watch[]>();
  api.listMyWatches.mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce([ownEverything]);
  renderSection();
  await loaded();

  // Save an Everything watch while the first answer is still out.
  await user.click(screen.getByRole('button', { name: 'Watch events everywhere…' }));
  const dialog = screen.getByRole('dialog', { name: 'Everything' });
  await user.click(within(dialog).getByRole('checkbox', { name: 'Truck status changed' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));
  await screen.findByRole('button', { name: 'Edit events everywhere…' });

  await act(async () => { first.resolve([]); });           // the stale answer, late

  expect(screen.getByRole('button', { name: 'Edit events everywhere…' })).toBeTruthy();
  expect(screen.queryByText(EMPTY)).toBeNull();
});
