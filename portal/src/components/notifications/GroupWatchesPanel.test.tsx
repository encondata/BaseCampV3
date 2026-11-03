// @vitest-environment jsdom
/**
 * GroupWatchesPanel — "What this group watches" on a group's page, under
 * Members: the things and events the group's members hear about, as a table
 * without Via. People who can change notifications add a watch, choose a
 * watch's events, or remove it; everyone else reads the list.
 */

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, READ_ONLY_MESSAGE, type NotificationGroupDetail, type NotificationKindSetting,
  type NotificationSettings, type Watch,
} from '../../lib/api';

const api = vi.hoisted(() => ({
  listGroupWatches: vi.fn(),
  getNotificationSettings: vi.fn(),
  createGroupWatch: vi.fn(),
  updateGroupWatch: vi.fn(),
  deleteGroupWatch: vi.fn(),
  listInitiatives: vi.fn(),
  listSites: vi.fn(),
  listTrucks: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: GroupWatchesPanel } = await import('./GroupWatchesPanel');

const INI_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';

const GROUP: NotificationGroupDetail = {
  id: 'g1', name: 'Group A', description: '', enabled: true, member_count: 0,
  created_at: '2026-11-02T00:00:00Z', members: [],
};
const OTHER_GROUP: NotificationGroupDetail = { ...GROUP, id: 'g2', name: 'Group B' };

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
const SETTINGS: NotificationSettings = { defaults: {}, critical_kinds: [], kinds: KINDS };

const VIA: Watch['via'] = { type: 'group', id: 'g1', name: 'Group A' };

const initiative: Watch = {
  id: 'w-ini', thing: 'initiative', thing_id: INI_ID, thing_name: 'Initiative A',
  link: `/initiatives/${INI_ID}`, kinds: [], via: VIA, created_at: '2026-11-02T12:00:00Z',
};
const site: Watch = {
  id: 'w-site', thing: 'site', thing_id: SITE_ID, thing_name: 'Site A',
  link: `/sites/${SITE_ID}`, kinds: ['initiative_status_changed', 'truck_status_changed'],
  via: VIA, created_at: '2026-11-02T11:00:00Z',
};
const everything: Watch = {
  id: 'w-all', thing: 'everything', thing_id: null, thing_name: null, link: null,
  kinds: ['truck_status_changed'], via: VIA, created_at: '2026-11-02T09:00:00Z',
};

const EMPTY = "This group isn't watching anything yet.";
const LOAD_FAILED = "Could not load this group's watches.";
const DESCRIPTION = 'Pick the events this group hears about.';

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  api.listGroupWatches.mockResolvedValue([]);
  api.getNotificationSettings.mockResolvedValue(SETTINGS);
  api.createGroupWatch.mockResolvedValue(site);
  api.updateGroupWatch.mockResolvedValue(site);
  api.deleteGroupWatch.mockResolvedValue(undefined);
  api.listInitiatives.mockResolvedValue([{ id: INI_ID, name: 'Initiative A' }]);
  api.listSites.mockResolvedValue([{ id: SITE_ID, name: 'Site A' }]);
  api.listTrucks.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const show = (group: NotificationGroupDetail = GROUP, canChange = true) => (
  <MemoryRouter><GroupWatchesPanel group={group} canChange={canChange} /></MemoryRouter>
);
const renderPanel = (group?: NotificationGroupDetail, canChange?: boolean) => render(show(group, canChange));

const eyebrow = (container: HTMLElement) =>
  container.querySelector('p.eyebrow-sm')?.textContent;
const headers = () => screen.queryAllByRole('columnheader').map((h) => h.textContent);
const rowOf = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
const cells = (row: HTMLElement) => within(row).getAllByRole('cell');

/** Open a row's actions menu and pick an item. */
async function pickAction(user: ReturnType<typeof userEvent.setup>, rowName: string, item: string) {
  await user.click(within(rowOf(rowName)).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: item }));
}

/** Open a picker in the Add watch dialog once its list is in (it is off until then). */
async function openPicker(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, field: string) {
  const input = within(dialog).getByRole('combobox', { name: field }) as HTMLInputElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  await user.click(input);
}

// ── what it asks for ────────────────────────────────────────────────────

it('asks for the group\'s watches and the company settings once each, when it mounts', async () => {
  api.listGroupWatches.mockResolvedValue([initiative]);
  renderPanel();
  await screen.findByText('Initiative A');

  expect(api.listGroupWatches).toHaveBeenCalledTimes(1);
  expect(api.listGroupWatches).toHaveBeenCalledWith('g1');
  expect(api.getNotificationSettings).toHaveBeenCalledTimes(1);
  expect(api.createGroupWatch).not.toHaveBeenCalled();
  expect(api.updateGroupWatch).not.toHaveBeenCalled();
  expect(api.deleteGroupWatch).not.toHaveBeenCalled();
});

// ── the panel ───────────────────────────────────────────────────────────

it('is the Members panel\'s card: div.init-panel with an 18px top margin, headed by an eyebrow with the count', async () => {
  api.listGroupWatches.mockResolvedValue([initiative, site, everything]);
  const { container } = renderPanel();
  await screen.findByText('Initiative A');

  const panel = container.querySelector('div.init-panel') as HTMLElement;
  expect(panel).not.toBeNull();
  expect(panel.style.marginTop).toBe('18px');
  const head = panel.querySelector('p.eyebrow-sm') as HTMLElement;
  expect(head.textContent).toBe('What this group watches — 3');
});

it('puts "Add watch" after the eyebrow when the person can change notifications', async () => {
  const { container } = renderPanel(GROUP, true);
  await screen.findByText(EMPTY);

  const button = screen.getByRole('button', { name: 'Add watch' });
  expect(button.classList.contains('mini-btn')).toBe(true);
  expect(button.getAttribute('type')).toBe('button');
  const head = container.querySelector('p.eyebrow-sm') as HTMLElement;
  expect(head.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const table = container.querySelector('.watch-table') as HTMLElement;
  expect(button.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('says nothing about the list, not even a count or that it is empty, until the watches are in', async () => {
  api.listGroupWatches.mockReturnValue(new Promise(() => {}));   // never settles
  const { container } = renderPanel();
  await waitFor(() => expect(api.getNotificationSettings).toHaveBeenCalled());

  expect(eyebrow(container)).toBe('What this group watches');
  expect(screen.queryByText(EMPTY)).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.queryByText(LOAD_FAILED)).toBeNull();
});

it('shows the empty-state copy and a count of 0 when the group watches nothing', async () => {
  const { container } = renderPanel();

  expect(await screen.findByText(EMPTY)).toBeTruthy();
  expect(eyebrow(container)).toBe('What this group watches — 0');
});

it('lists a table of Watching and Events, without Via, and Actions for those who can change it', async () => {
  api.listGroupWatches.mockResolvedValue([initiative]);
  const { container } = renderPanel();
  await screen.findByText('Initiative A');

  expect(headers()).toEqual(['Watching', 'Events', 'Actions']);
  expect(screen.queryByText('Via')).toBeNull();
  expect(container.querySelector('.init-panel .watch-table .data-table')).not.toBeNull();
  expect(screen.getByRole('table', { name: 'Watches' })).toBeTruthy();
});

it('a thing row: the name linked to its page, its kind as a chip, and All events', async () => {
  api.listGroupWatches.mockResolvedValue([initiative]);
  renderPanel();
  await screen.findByText('Initiative A');

  const link = screen.getByRole('link', { name: 'Initiative A' });
  expect(link.getAttribute('href')).toBe(`/initiatives/${INI_ID}`);
  const row = rowOf('Initiative A');
  expect(within(row).getByText('Initiative').classList.contains('chip')).toBe(true);
  expect(cells(row)[1].textContent).toBe('All events');
});

it('a narrowed row names its events by the company settings\' labels', async () => {
  api.listGroupWatches.mockResolvedValue([site]);
  renderPanel();
  await screen.findByText('Site A');

  expect(within(rowOf('Site A')).getByText('Site').classList.contains('chip')).toBe(true);
  expect(cells(rowOf('Site A'))[1].textContent).toBe('Initiative status changed, Truck status changed');
});

it('an Everything row reads "Everything", with the events it names', async () => {
  api.listGroupWatches.mockResolvedValue([everything]);
  renderPanel();
  await screen.findByText('Everything');

  const row = rowOf('Everything');
  expect(within(row).queryByRole('link')).toBeNull();
  expect(cells(row)[0].textContent).toBe('Everything');
  expect(cells(row)[1].textContent).toBe('Truck status changed');
});

it('keeps the order the API gives (newest first)', async () => {
  api.listGroupWatches.mockResolvedValue([site, everything, initiative]);
  renderPanel();
  await screen.findByText('Site A');

  const rows = screen.getAllByRole('row').slice(1);
  expect(rows.map((r) => within(r).queryByRole('link')?.textContent ?? 'Everything'))
    .toEqual(['Site A', 'Everything', 'Initiative A']);
});

it('waits for the company settings so the events read as labels at once, not as codes', async () => {
  const settings = deferred<NotificationSettings>();
  api.getNotificationSettings.mockReturnValue(settings.promise);
  api.listGroupWatches.mockResolvedValue([site]);
  const { container } = renderPanel();
  await waitFor(() => expect(eyebrow(container)).toBe('What this group watches — 1'));

  expect(screen.queryByText('Site A')).toBeNull();
  expect(screen.queryByText(/initiative_status_changed/)).toBeNull();

  await act(async () => { settings.resolve(SETTINGS); });
  expect(cells(rowOf('Site A'))[1].textContent).toBe('Initiative status changed, Truck status changed');
});

it('still lists the watches when the company settings can\'t be loaded: the events read as their codes', async () => {
  api.getNotificationSettings.mockRejectedValue(new ApiError(500, 'boom'));
  api.listGroupWatches.mockResolvedValue([site]);
  renderPanel();
  await screen.findByText('Site A');

  expect(cells(rowOf('Site A'))[1].textContent).toBe('initiative_status_changed, truck_status_changed');
  expect(screen.queryByText(LOAD_FAILED)).toBeNull();
});

// ── read only ───────────────────────────────────────────────────────────

it('without change permission: no "Add watch", no Actions column, no Actions button', async () => {
  api.listGroupWatches.mockResolvedValue([initiative, site]);
  renderPanel(GROUP, false);
  await screen.findByText('Initiative A');

  expect(screen.queryByRole('button', { name: 'Add watch' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Actions/ })).toBeNull();
  expect(headers()).toEqual(['Watching', 'Events']);
  // the list itself is still there to read
  expect(screen.getByRole('link', { name: 'Site A' })).toBeTruthy();
  expect(screen.getByText('What this group watches — 2')).toBeTruthy();
});

it('without change permission an empty group still says so', async () => {
  renderPanel(GROUP, false);

  expect(await screen.findByText(EMPTY)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Add watch' })).toBeNull();
});

// ── the row actions ─────────────────────────────────────────────────────

it('a row\'s menu offers "Choose events…" and "Remove" (destructive)', async () => {
  const user = userEvent.setup();
  api.listGroupWatches.mockResolvedValue([site]);
  renderPanel();
  await screen.findByText('Site A');

  await user.click(within(rowOf('Site A')).getByRole('button', { name: /Actions/ }));

  const items = screen.getAllByRole('menuitem');
  expect(items.map((i) => i.textContent)).toEqual(['Choose events…', 'Remove']);
  expect(items[1].className).toContain('danger');
  expect(items[0].className).not.toContain('danger');
});

it('Remove stops the group watching it: deleteGroupWatch(groupId, watchId), then the list is read again', async () => {
  const user = userEvent.setup();
  api.listGroupWatches.mockResolvedValueOnce([initiative, site]).mockResolvedValue([initiative]);
  renderPanel();
  await screen.findByText('Site A');

  await pickAction(user, 'Site A', 'Remove');

  await waitFor(() => expect(api.deleteGroupWatch).toHaveBeenCalledTimes(1));
  expect(api.deleteGroupWatch).toHaveBeenCalledWith('g1', 'w-site');
  await waitFor(() => expect(screen.queryByText('Site A')).toBeNull());
  expect(api.listGroupWatches).toHaveBeenCalledTimes(2);
  expect(screen.getByText('What this group watches — 1')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('Remove asks nothing first: a watch is as easy to add back', async () => {
  const user = userEvent.setup();
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  api.listGroupWatches.mockResolvedValue([site]);
  renderPanel();
  await screen.findByText('Site A');

  await pickAction(user, 'Site A', 'Remove');

  await waitFor(() => expect(api.deleteGroupWatch).toHaveBeenCalledTimes(1));
  expect(confirmSpy).not.toHaveBeenCalled();
  confirmSpy.mockRestore();
});

it('a watch that is already gone is as good as removed: no error, and the list is read again', async () => {
  const user = userEvent.setup();
  api.deleteGroupWatch.mockRejectedValue(new ApiError(404, 'watch_not_found'));
  api.listGroupWatches.mockResolvedValueOnce([site]).mockResolvedValue([]);
  renderPanel();
  await screen.findByText('Site A');

  await pickAction(user, 'Site A', 'Remove');

  expect(await screen.findByText(EMPTY)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('a refused Remove says why in pf-error, and the list is read again', async () => {
  const user = userEvent.setup();
  api.deleteGroupWatch.mockRejectedValue(new ApiError(403, 'forbidden'));
  api.listGroupWatches.mockResolvedValue([site]);
  renderPanel();
  await screen.findByText('Site A');

  await pickAction(user, 'Site A', 'Remove');

  const error = await screen.findByRole('alert');
  expect(error.textContent).toBe('Request failed (forbidden).');
  expect(error.classList.contains('pf-error')).toBe(true);
  expect(screen.getByText('Site A')).toBeTruthy();
  await waitFor(() => expect(api.listGroupWatches).toHaveBeenCalledTimes(2));
});

it('read-only maintenance says its own message on a refused Remove', async () => {
  const user = userEvent.setup();
  api.deleteGroupWatch.mockRejectedValue(
    new ApiError(423, 'read_only_mode', { code: 'read_only_mode' }, READ_ONLY_MESSAGE));
  api.listGroupWatches.mockResolvedValue([site]);
  renderPanel();
  await screen.findByText('Site A');

  await pickAction(user, 'Site A', 'Remove');

  expect((await screen.findByRole('alert')).textContent).toBe(READ_ONLY_MESSAGE);
});

it('the next Remove clears the last one\'s error', async () => {
  const user = userEvent.setup();
  api.deleteGroupWatch.mockRejectedValueOnce(new ApiError(403, 'forbidden')).mockResolvedValue(undefined);
  api.listGroupWatches.mockResolvedValue([site]);
  renderPanel();
  await screen.findByText('Site A');
  await pickAction(user, 'Site A', 'Remove');
  await screen.findByRole('alert');

  await pickAction(user, 'Site A', 'Remove');

  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  expect(api.deleteGroupWatch).toHaveBeenCalledTimes(2);
});

it('both of a row\'s actions are off while its Remove is on its way, and come back after', async () => {
  const user = userEvent.setup();
  const pending = deferred<void>();
  api.deleteGroupWatch.mockReturnValue(pending.promise);
  api.listGroupWatches.mockResolvedValue([site]);
  renderPanel();
  await screen.findByText('Site A');
  await pickAction(user, 'Site A', 'Remove');

  await user.click(within(rowOf('Site A')).getByRole('button', { name: /Actions/ }));
  await waitFor(() => {
    expect((screen.getByRole('menuitem', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true);
  });
  expect((screen.getByRole('menuitem', { name: 'Choose events…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByRole('menuitem')).toHaveLength(2);
  await user.keyboard('{Escape}');
  expect(api.deleteGroupWatch).toHaveBeenCalledTimes(1);

  await act(async () => { pending.resolve(); });
  await user.click(within(rowOf('Site A')).getByRole('button', { name: /Actions/ }));
  expect((screen.getByRole('menuitem', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(false);
});

// ── Choose events… ──────────────────────────────────────────────────────

it('"Choose events…" opens the dialog: the group\'s name, the thing\'s name, and the group description', async () => {
  const user = userEvent.setup();
  api.listGroupWatches.mockResolvedValue([site]);
  renderPanel();
  await screen.findByText('Site A');

  await pickAction(user, 'Site A', 'Choose events…');

  const dialog = screen.getByRole('dialog', { name: 'Site A' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Group A');
  expect(within(dialog).getByRole('heading', { name: 'Site A', level: 3 })).toBeTruthy();
  expect(dialog.querySelector('p.page-hint')?.textContent).toBe(DESCRIPTION);
  // it opens on the events the watch names
  expect((within(dialog).getByRole('checkbox', { name: 'All events' }) as HTMLInputElement).checked).toBe(false);
  expect((within(dialog).getByRole('checkbox', { name: 'Truck status changed' }) as HTMLInputElement).checked).toBe(true);
  expect(api.updateGroupWatch).not.toHaveBeenCalled();
});

it('saving the events changes the group\'s watch: updateGroupWatch(groupId, watchId, kinds), then it closes and the list is read again', async () => {
  const user = userEvent.setup();
  api.listGroupWatches.mockResolvedValueOnce([site])
    .mockResolvedValue([{ ...site, kinds: ['truck_status_changed'] }]);
  renderPanel();
  await screen.findByText('Site A');
  await pickAction(user, 'Site A', 'Choose events…');
  const dialog = screen.getByRole('dialog', { name: 'Site A' });

  await user.click(within(dialog).getByRole('checkbox', { name: 'Initiative status changed' }));
  await user.click(within(dialog).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateGroupWatch).toHaveBeenCalledTimes(1));
  expect(api.updateGroupWatch).toHaveBeenCalledWith('g1', 'w-site', ['truck_status_changed']);
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await waitFor(() => expect(cells(rowOf('Site A'))[1].textContent).toBe('Truck status changed'));
  expect(api.listGroupWatches).toHaveBeenCalledTimes(2);
});

it('All events saves as no kinds', async () => {
  const user = userEvent.setup();
  api.listGroupWatches.mockResolvedValue([initiative]);
  renderPanel();
  await screen.findByText('Initiative A');
  await pickAction(user, 'Initiative A', 'Choose events…');

  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateGroupWatch).toHaveBeenCalledWith('g1', 'w-ini', []));
});

it('an Everything watch\'s dialog is titled "Everything" and has no All events switch', async () => {
  const user = userEvent.setup();
  api.listGroupWatches.mockResolvedValue([everything]);
  renderPanel();
  await screen.findByText('Everything');

  await pickAction(user, 'Everything', 'Choose events…');

  const dialog = screen.getByRole('dialog', { name: 'Everything' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Group A');
  expect(dialog.querySelector('p.page-hint')?.textContent).toBe(DESCRIPTION);
  expect(within(dialog).queryByRole('checkbox', { name: 'All events' })).toBeNull();
  expect((within(dialog).getByRole('checkbox', { name: 'Truck status changed' }) as HTMLInputElement).checked).toBe(true);
});

it('a refused change keeps the dialog open with the reason, and the list is read again', async () => {
  const user = userEvent.setup();
  api.updateGroupWatch.mockRejectedValue(new ApiError(404, 'watch_not_found'));
  api.listGroupWatches.mockResolvedValueOnce([site]).mockResolvedValue([]);
  renderPanel();
  await screen.findByText('Site A');
  await pickAction(user, 'Site A', 'Choose events…');

  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));

  const dialog = screen.getByRole('dialog');
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Request failed (watch_not_found).');
  await waitFor(() => expect(api.listGroupWatches).toHaveBeenCalledTimes(2));
  expect(await screen.findByText(EMPTY)).toBeTruthy();
});

it('Cancel closes the dialog without saving', async () => {
  const user = userEvent.setup();
  api.listGroupWatches.mockResolvedValue([site]);
  renderPanel();
  await screen.findByText('Site A');
  await pickAction(user, 'Site A', 'Choose events…');

  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.updateGroupWatch).not.toHaveBeenCalled();
});

// ── Add watch ───────────────────────────────────────────────────────────

it('"Add watch" opens the Add watch dialog for this group', async () => {
  const user = userEvent.setup();
  renderPanel();
  await screen.findByText(EMPTY);

  await user.click(screen.getByRole('button', { name: 'Add watch' }));

  const dialog = screen.getByRole('dialog', { name: 'Add watch' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Group A');
  expect(dialog.querySelector('p.page-hint')?.textContent).toBe("Pick what this group's members hear about.");
});

it('adding a watch closes the dialog, reads the list again and shows the new row', async () => {
  const user = userEvent.setup();
  api.listGroupWatches.mockResolvedValueOnce([]).mockResolvedValue([site]);
  renderPanel();
  await screen.findByText(EMPTY);
  await user.click(screen.getByRole('button', { name: 'Add watch' }));
  const dialog = screen.getByRole('dialog', { name: 'Add watch' });

  await user.click(within(dialog).getByRole('button', { name: 'Site' }));
  await openPicker(user, dialog, 'Site');
  await user.click(await screen.findByRole('button', { name: 'Site A' }));
  await user.click(within(dialog).getByRole('button', { name: 'Add watch' }));

  await waitFor(() => expect(api.createGroupWatch).toHaveBeenCalledWith(
    'g1', { thing: 'site', id: SITE_ID, kinds: [] }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(await screen.findByRole('link', { name: 'Site A' })).toBeTruthy();
  expect(api.listGroupWatches).toHaveBeenCalledTimes(2);
  expect(screen.getByText('What this group watches — 1')).toBeTruthy();
});

it('the Add watch dialog knows the company settings\' events', async () => {
  const user = userEvent.setup();
  renderPanel();
  await screen.findByText(EMPTY);
  await user.click(screen.getByRole('button', { name: 'Add watch' }));
  const dialog = screen.getByRole('dialog', { name: 'Add watch' });

  await user.click(within(dialog).getByRole('button', { name: 'Everything' }));

  expect(within(dialog).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label')))
    .toEqual(['Initiative status changed', 'Truck status changed']);
});

it('Cancel in the Add watch dialog closes it and adds nothing', async () => {
  const user = userEvent.setup();
  renderPanel();
  await screen.findByText(EMPTY);
  await user.click(screen.getByRole('button', { name: 'Add watch' }));

  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.createGroupWatch).not.toHaveBeenCalled();
  expect(api.listGroupWatches).toHaveBeenCalledTimes(1);
});

// ── the list does not load ──────────────────────────────────────────────

it('a list that does not load says so in the page\'s house form, and shows no count and no empty state', async () => {
  api.listGroupWatches.mockRejectedValue(new ApiError(500, 'boom'));
  const { container } = renderPanel();

  const error = await screen.findByText(LOAD_FAILED);
  expect(error.tagName).toBe('P');
  expect(error.classList.contains('pf-error')).toBe(true);
  expect(eyebrow(container)).toBe('What this group watches');
  expect(screen.queryByText(EMPTY)).toBeNull();
  expect(screen.queryByRole('table')).toBeNull();
  // adding does not need the list
  expect(screen.getByRole('button', { name: 'Add watch' })).toBeTruthy();
});

it('a reload that fails keeps the list that is there, and says so', async () => {
  const user = userEvent.setup();
  api.deleteGroupWatch.mockResolvedValue(undefined);
  api.listGroupWatches.mockResolvedValueOnce([initiative, site])
    .mockRejectedValue(new ApiError(500, 'boom'));
  renderPanel();
  await screen.findByText('Site A');

  await pickAction(user, 'Site A', 'Remove');

  expect(await screen.findByText(LOAD_FAILED)).toBeTruthy();
  expect(screen.getByText('Site A')).toBeTruthy();
  expect(screen.getByText('Initiative A')).toBeTruthy();
});

it('the next list that loads takes the failure notice away', async () => {
  const user = userEvent.setup();
  api.listGroupWatches.mockResolvedValueOnce([site])
    .mockRejectedValueOnce(new ApiError(500, 'boom'))
    .mockResolvedValue([initiative]);
  renderPanel();
  await screen.findByText('Site A');
  await pickAction(user, 'Site A', 'Remove');
  await screen.findByText(LOAD_FAILED);

  await pickAction(user, 'Site A', 'Remove');

  await screen.findByText('Initiative A');
  expect(screen.queryByText(LOAD_FAILED)).toBeNull();
});

it('only the newest list counts: an older answer arriving late is dropped', async () => {
  const user = userEvent.setup();
  const first = deferred<Watch[]>();
  api.listGroupWatches.mockReturnValueOnce(first.promise).mockResolvedValue([initiative]);
  renderPanel();
  await waitFor(() => expect(api.listGroupWatches).toHaveBeenCalledTimes(1));
  // a second read while the first is still out: Add watch → add → reload
  await user.click(screen.getByRole('button', { name: 'Add watch' }));
  const dialog = screen.getByRole('dialog', { name: 'Add watch' });
  await openPicker(user, dialog, 'Initiative');
  await user.click(await screen.findByRole('button', { name: 'Initiative A' }));
  await user.click(within(dialog).getByRole('button', { name: 'Add watch' }));
  await screen.findByRole('link', { name: 'Initiative A' });

  await act(async () => { first.resolve([site]); });

  expect(screen.getByRole('link', { name: 'Initiative A' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Site A' })).toBeNull();
  expect(screen.getByText('What this group watches — 1')).toBeTruthy();
});

// ── another group ───────────────────────────────────────────────────────

it('asks again for another group\'s watches, and shows nothing of the first group\'s meanwhile', async () => {
  api.listGroupWatches.mockResolvedValueOnce([site]);
  const view = renderPanel(GROUP);
  await screen.findByText('Site A');

  const second = deferred<Watch[]>();
  api.listGroupWatches.mockReturnValue(second.promise);
  view.rerender(show(OTHER_GROUP));

  await waitFor(() => expect(api.listGroupWatches).toHaveBeenLastCalledWith('g2'));
  expect(screen.queryByText('Site A')).toBeNull();
  expect(eyebrow(view.container)).toBe('What this group watches');

  await act(async () => { second.resolve([initiative]); });
  expect(await screen.findByText('Initiative A')).toBeTruthy();
  expect(eyebrow(view.container)).toBe('What this group watches — 1');
});

it('a first group\'s answer that lands after the switch is dropped', async () => {
  const first = deferred<Watch[]>();
  api.listGroupWatches.mockReturnValueOnce(first.promise);
  const view = renderPanel(GROUP);
  await waitFor(() => expect(api.listGroupWatches).toHaveBeenCalledTimes(1));

  api.listGroupWatches.mockResolvedValue([initiative]);
  view.rerender(show(OTHER_GROUP));
  await screen.findByText('Initiative A');
  await act(async () => { first.resolve([site]); });

  expect(screen.queryByText('Site A')).toBeNull();
  expect(screen.getByText('Initiative A')).toBeTruthy();
  expect(eyebrow(view.container)).toBe('What this group watches — 1');
});

it('does not ask again when the same group is loaded afresh (a new object with the same id)', async () => {
  api.listGroupWatches.mockResolvedValue([site]);
  const view = renderPanel(GROUP);
  await screen.findByText('Site A');

  view.rerender(show({ ...GROUP, enabled: false, member_count: 3 }));

  expect(api.listGroupWatches).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Site A')).toBeTruthy();
});

it('the dialogs name the group they are for', async () => {
  const user = userEvent.setup();
  api.listGroupWatches.mockResolvedValue([site]);
  renderPanel(OTHER_GROUP);
  await screen.findByText('Site A');

  await pickAction(user, 'Site A', 'Choose events…');

  expect(screen.getByRole('dialog').querySelector('.eyebrow')?.textContent).toBe('Group B');
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateGroupWatch).toHaveBeenCalledWith(
    'g2', 'w-site', ['initiative_status_changed', 'truck_status_changed']));
});
