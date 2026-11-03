// @vitest-environment jsdom
/**
 * WatchEventsModal — "Choose events…": the standard notification dialog around
 * WatchEventsEditor. It opens on the watch's own events (all of them when it
 * names none), saves only when something is chosen, closes once the save
 * has gone through, and stays open with the failure beside the buttons when it
 * has not.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { ApiError, READ_ONLY_MESSAGE, type NotificationKindSetting, type WatchTarget } from '../../lib/api';
import WatchEventsModal from './WatchEventsModal';

const kind = (
  key: string, label: string, category: NotificationKindSetting['category'],
  over: Partial<NotificationKindSetting> = {},
): NotificationKindSetting => ({
  kind: key, label, category, email: true, owner_always: false, critical: false, locked: false,
  watchable: false, everywhere: false, reaches: [], ...over,
});

const KINDS: NotificationKindSetting[] = [
  kind('report_ready', 'Report ready', 'reports'),
  kind('initiative_status_changed', 'Initiative status changed', 'initiatives',
    { watchable: true, everywhere: true, reaches: ['initiative', 'site'] }),
  kind('truck_status_changed', 'Truck status changed', 'trucks',
    { watchable: true, everywhere: true, reaches: ['truck', 'initiative', 'site'] }),
  kind('kind_a', 'Kind A', 'initiatives', { watchable: true, reaches: ['initiative'] }),
];

afterEach(cleanup);

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function setup(over: Partial<{
  thing: WatchTarget; initial: string[]; saveLabel: string;
  onSave: (kinds: string[]) => Promise<void>;
}> = {}) {
  const onSave = vi.fn<(kinds: string[]) => Promise<void>>(over.onSave ?? (async () => {}));
  const onClose = vi.fn();
  render(
    <WatchEventsModal eyebrow="Watch" title="Initiative A"
                      description="Pick the events you want to hear about."
                      thing={over.thing ?? 'initiative'} kinds={KINDS} initial={over.initial ?? []}
                      saveLabel={over.saveLabel} onSave={onSave} onClose={onClose} />,
  );
  return { onSave, onClose, dialog: screen.getByRole('dialog') };
}

const checkbox = (name: string) => screen.getByRole('checkbox', { name }) as HTMLInputElement;
const save = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const cancel = () => screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;

it('wears the standard header: the "Watch" eyebrow, the title, and the description', () => {
  const { dialog } = setup();

  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Watch');
  expect(within(dialog).getByRole('heading', { name: 'Initiative A', level: 3 })).toBeTruthy();
  expect(dialog.querySelector('p.page-hint')?.textContent)
    .toBe('Pick the events you want to hear about.');
  expect(dialog.classList.contains('nm-card')).toBe(true);
  expect(dialog.classList.contains('rgm-card')).toBe(true);
});

it('puts the eyebrow, title and description it is given in the header (a group, and Everything)', () => {
  render(
    <WatchEventsModal eyebrow="Group A" title="Everything" description="Pick the events this group hears about."
                      thing="everything" kinds={KINDS} initial={[]}
                      onSave={async () => {}} onClose={() => {}} />,
  );
  const dialog = screen.getByRole('dialog', { name: 'Everything' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Group A');
  expect(dialog.querySelector('p.page-hint')?.textContent).toBe('Pick the events this group hears about.');
});

it('has no "All events" switch for Everything, and its events are listed from the start', () => {
  setup({ thing: 'everything' });

  expect(screen.queryByRole('checkbox', { name: 'All events' })).toBeNull();
  expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label')))
    .toEqual(['Initiative status changed', 'Truck status changed']);
});

it('groups the kinds under their category labels', async () => {
  const user = userEvent.setup();
  const { dialog } = setup();

  await user.click(checkbox('All events'));

  const groups = within(dialog).getAllByRole('group');
  expect(groups.map((g) => g.getAttribute('aria-label'))).toEqual(['Initiatives', 'Trucks']);
  expect(within(groups[0]).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label')))
    .toEqual(['Initiative status changed', 'Kind A']);
  expect(within(groups[1]).getAllByRole('checkbox').map((c) => c.getAttribute('aria-label')))
    .toEqual(['Truck status changed']);
});

it('opens on All events when the watch names none, and saves it as no kinds', async () => {
  const user = userEvent.setup();
  const { onSave } = setup({ initial: [] });

  expect(checkbox('All events').checked).toBe(true);
  expect(save().disabled).toBe(false);
  expect(screen.queryByRole('checkbox', { name: 'Truck status changed' })).toBeNull();

  await user.click(save());

  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave).toHaveBeenCalledWith([]);
});

it('opens on the events the watch names, All off, and saves them', async () => {
  const user = userEvent.setup();
  const { onSave } = setup({ initial: ['truck_status_changed'] });

  expect(checkbox('All events').checked).toBe(false);
  expect(checkbox('Truck status changed').checked).toBe(true);
  expect(checkbox('Kind A').checked).toBe(false);

  await user.click(save());

  expect(onSave).toHaveBeenCalledWith(['truck_status_changed']);
});

it('turning All off starts from no picks, and Save stays off until one is picked', async () => {
  const user = userEvent.setup();
  const { onSave } = setup({ initial: [] });

  await user.click(checkbox('All events'));

  expect(save().disabled).toBe(true);
  await user.click(save());
  expect(onSave).not.toHaveBeenCalled();

  await user.click(checkbox('Truck status changed'));
  expect(save().disabled).toBe(false);

  await user.click(checkbox('Truck status changed'));
  expect(save().disabled).toBe(true);
});

it('turning All off after picks were made drops them', async () => {
  const user = userEvent.setup();
  setup({ initial: ['kind_a'] });

  await user.click(checkbox('All events'));     // on: the picks are not shown
  await user.click(checkbox('All events'));     // off again: from none

  expect(checkbox('Kind A').checked).toBe(false);
  expect(save().disabled).toBe(true);
});

it('Everything saves nothing until a kind is picked, then saves the picks in registry order', async () => {
  const user = userEvent.setup();
  const { onSave } = setup({ thing: 'everything', initial: [] });

  expect(save().disabled).toBe(true);

  await user.click(checkbox('Truck status changed'));
  await user.click(checkbox('Initiative status changed'));
  expect(save().disabled).toBe(false);
  await user.click(save());

  expect(onSave).toHaveBeenCalledWith(['initiative_status_changed', 'truck_status_changed']);
});

it('an existing Everything watch opens on its events', async () => {
  const user = userEvent.setup();
  const { onSave } = setup({ thing: 'everything', initial: ['truck_status_changed'] });

  expect(checkbox('Truck status changed').checked).toBe(true);
  expect(save().disabled).toBe(false);
  await user.click(save());

  expect(onSave).toHaveBeenCalledWith(['truck_status_changed']);
});

it('the footer is Save (btn-solid) and Cancel (mini-btn), and Save reads saveLabel when given', () => {
  setup({ saveLabel: 'Add watch' });

  const foot = screen.getByRole('dialog').querySelector('.modal-foot') as HTMLElement;
  const add = within(foot).getByRole('button', { name: 'Add watch' });
  expect(add.className).toBe('btn-solid');
  expect(add.getAttribute('type')).toBe('button');
  expect(within(foot).getByRole('button', { name: 'Cancel' }).className).toBe('mini-btn');
  expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
});

it('Save reads "Save" by default', () => {
  setup();

  expect(save().className).toBe('btn-solid');
});

it('closes once the save has gone through', async () => {
  const user = userEvent.setup();
  const { onSave, onClose } = setup();

  await user.click(save());

  expect(onSave).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('does not close before the save has gone through', async () => {
  const user = userEvent.setup();
  const pending = deferred<void>();
  const { onClose } = setup({ onSave: () => pending.promise });

  await user.click(save());
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => { pending.resolve(); });
  expect(onClose).toHaveBeenCalledTimes(1);
});

it('Cancel and the × close it without saving', async () => {
  const user = userEvent.setup();
  const { onSave, onClose } = setup();

  await user.click(cancel());
  await user.click(screen.getByRole('button', { name: 'Close' }));

  expect(onClose).toHaveBeenCalledTimes(2);
  expect(onSave).not.toHaveBeenCalled();
});

it('a rejected save says "You\'re already watching this." for already_watching, and stays open', async () => {
  const user = userEvent.setup();
  const { onClose } = setup({ onSave: async () => { throw new ApiError(409, 'already_watching'); } });

  await user.click(save());

  const error = await screen.findByRole('alert');
  expect(error.textContent).toBe("You're already watching this.");
  expect(error.classList.contains('pf-error')).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(save().disabled).toBe(false);
});

it('any other API error reads as the house fallback with its code', async () => {
  const user = userEvent.setup();
  setup({ onSave: async () => { throw new ApiError(404, 'thing_not_found'); } });

  await user.click(save());

  expect((await screen.findByRole('alert')).textContent).toBe('Request failed (thing_not_found).');
});

it('read-only maintenance says its own message', async () => {
  const user = userEvent.setup();
  setup({
    onSave: async () => {
      throw new ApiError(423, 'read_only_mode', { code: 'read_only_mode' }, READ_ONLY_MESSAGE);
    },
  });

  await user.click(save());

  expect((await screen.findByRole('alert')).textContent).toBe(READ_ONLY_MESSAGE);
});

it('a failure that is not the API\'s (no connection) is the plain sentence', async () => {
  const user = userEvent.setup();
  setup({ onSave: async () => { throw new Error('Failed to fetch'); } });

  await user.click(save());

  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't update your watch.");
});

it('an old error goes when the choice is changed, and can be tried again', async () => {
  const user = userEvent.setup();
  const onSave = vi.fn<(kinds: string[]) => Promise<void>>()
    .mockRejectedValueOnce(new ApiError(409, 'already_watching'))
    .mockResolvedValueOnce(undefined);
  const onClose = vi.fn();
  render(
    <WatchEventsModal eyebrow="Watch" title="Initiative A" description="d" thing="initiative"
                      kinds={KINDS} initial={[]} onSave={onSave} onClose={onClose} />,
  );

  await user.click(save());
  await screen.findByRole('alert');

  await user.click(checkbox('All events'));
  expect(screen.queryByRole('alert')).toBeNull();

  await user.click(checkbox('Kind A'));
  await user.click(save());
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls).toEqual([[[]], [['kind_a']]]);
});

it('is locked while the save is on its way: no second save, no Cancel, no ×, no Escape', async () => {
  const user = userEvent.setup();
  const pending = deferred<void>();
  const { onSave, onClose } = setup({ onSave: () => pending.promise });

  await user.click(save());
  await waitFor(() => expect(save().disabled).toBe(true));

  await user.click(save());
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(cancel().disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).not.toHaveBeenCalled();

  await act(async () => { pending.resolve(); });
  expect(onClose).toHaveBeenCalledTimes(1);
});
