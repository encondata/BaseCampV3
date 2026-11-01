// @vitest-environment jsdom
/**
 * EditSettingsModal — the group's delivery settings in the house controls:
 * a Switch per live channel (Email), segmented Off/Custom and Defer/Skip,
 * quarter-hour ComboBox times. Saving diffs against the stored group, and a
 * channel the screen hides (Text, Push, Web) is never dropped.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type NotificationGroupDetail } from '../../lib/api';

const api = vi.hoisted(() => ({ updateNotificationGroup: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const GROUP: NotificationGroupDetail = {
  id: 'g1',
  name: 'Ops Alerts',
  description: 'Operational issues',
  channels: ['email', 'text', 'push', 'web'],
  categories: ['approvals', 'security'],
  quiet_start: null,
  quiet_end: null,
  timezone: 'America/Chicago',
  active_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  dnd_behavior: 'defer',
  urgent_bypass: true,
  enabled: true,
  member_count: 5,
  created_at: '2026-01-01T00:00:00Z',
  members: [],
};

const onClose = vi.fn();
const onSaved = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  api.updateNotificationGroup.mockResolvedValue(GROUP);
});

afterEach(cleanup);

const { default: EditSettingsModal } = await import('./EditSettingsModal');

function open(group: NotificationGroupDetail = GROUP) {
  render(<EditSettingsModal group={group} onClose={onClose} onSaved={onSaved} />);
  return screen.getByRole('dialog');
}

const save = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Save' });
const press = (dialog: HTMLElement, group: string, name: string) =>
  within(within(dialog).getByRole('group', { name: group })).getByRole('button', { name });
const pressed = (dialog: HTMLElement, group: string) =>
  within(within(dialog).getByRole('group', { name: group })).getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);

/** Open a time/timezone ComboBox and click one of its options. */
async function pick(
  user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, field: string, option: string | RegExp,
) {
  await user.click(within(dialog).getByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('button', { name: option }));
}

it('uses house controls only: no select, no time input, no bare checkbox', () => {
  const dialog = open();
  expect(dialog.querySelector('select')).toBeNull();
  expect(dialog.querySelector('input[type="time"]')).toBeNull();
  const boxes = [...dialog.querySelectorAll('input[type="checkbox"]')];
  expect(boxes.length).toBeGreaterThan(0);
  expect(boxes.every((b) => b.closest('label.switch'))).toBe(true);
});

it('wears the standard header: eyebrow, title and description', () => {
  const dialog = open();
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Notification group');
  expect(within(dialog).getByRole('heading', { name: 'Delivery settings' })).not.toBeNull();
  expect(within(dialog).getByText('Defaults every member inherits unless they set their own.')
    .className).toContain('page-hint');
  expect(dialog.getAttribute('aria-label')).toBe('Delivery settings');
});

it('gives only the live channel a switch, and says nothing is "not available yet"', () => {
  const dialog = open();
  const channels = within(dialog).getByText('Channels').nextElementSibling as HTMLElement;
  expect(within(channels).getAllByRole('checkbox').map((b) => b.getAttribute('aria-label')))
    .toEqual(['Email']);
  expect((within(channels).getByRole('checkbox', { name: 'Email' }) as HTMLInputElement).checked).toBe(true);
  for (const hidden of [/text/i, /push/i, /web/i]) {
    expect(within(dialog).queryByRole('checkbox', { name: hidden })).toBeNull();
    expect(within(dialog).queryByText(hidden)).toBeNull();
  }
  expect(screen.queryByText(/not available yet/i)).toBeNull();
  // the only other switch is Urgent bypass
  expect(within(dialog).getAllByRole('checkbox').map((b) => b.getAttribute('aria-label')))
    .toEqual(['Email', 'Urgent bypass']);
});

it('turning Email off keeps the stored Text, Push and Web', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationGroup)
    .toHaveBeenCalledWith('g1', { channels: ['text', 'push', 'web'] }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

it('turning Email on for a group that stores only hidden channels keeps them, in CHANNELS order', async () => {
  const user = userEvent.setup();
  const dialog = open({ ...GROUP, channels: ['text', 'push', 'web'] });
  expect((within(dialog).getByRole('checkbox', { name: 'Email' }) as HTMLInputElement).checked).toBe(false);
  await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationGroup)
    .toHaveBeenCalledWith('g1', { channels: ['email', 'text', 'push', 'web'] }));
});

it('a group that stores only hidden channels gets no channels key when Email is left alone', async () => {
  const user = userEvent.setup();
  const dialog = open({ ...GROUP, channels: ['text', 'push', 'web'] });
  await user.click(press(dialog, 'Window', 'Custom'));
  await pick(user, dialog, 'Start', '9:00 PM');
  await pick(user, dialog, 'End', '7:00 AM');
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationGroup).toHaveBeenCalledTimes(1));
  const patch = api.updateNotificationGroup.mock.calls[0][1];
  expect('channels' in patch).toBe(false);
  expect(patch).toEqual({ quiet_start: '21:00', quiet_end: '07:00' });
});

it('changing only the quiet window saves just the window', async () => {
  const user = userEvent.setup();
  const dialog = open();
  expect(pressed(dialog, 'Window')).toEqual(['Off']);
  expect(within(dialog).queryByRole('combobox', { name: 'Start' })).toBeNull();

  await user.click(press(dialog, 'Window', 'Custom'));
  expect(pressed(dialog, 'Window')).toEqual(['Custom']);
  await pick(user, dialog, 'Start', '9:00 PM');
  await pick(user, dialog, 'End', '7:00 AM');
  expect((within(dialog).getByRole('combobox', { name: 'Start' }) as HTMLInputElement).value).toBe('9:00 PM');
  await user.click(save(dialog));

  await waitFor(() => expect(api.updateNotificationGroup)
    .toHaveBeenCalledWith('g1', { quiet_start: '21:00', quiet_end: '07:00' }));
});

it('Custom without both times is refused here, before anything is sent', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(press(dialog, 'Window', 'Custom'));
  await pick(user, dialog, 'Start', '9:00 PM');
  await user.click(save(dialog));
  expect(await within(dialog).findByText(/need both a start and an end/i)).not.toBeNull();
  expect(api.updateNotificationGroup).not.toHaveBeenCalled();
});

it('the same start and end is refused too', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(press(dialog, 'Window', 'Custom'));
  await pick(user, dialog, 'Start', '9:00 PM');
  await pick(user, dialog, 'End', '9:00 PM');
  await user.click(save(dialog));
  expect(await within(dialog).findByText(/need both a start and an end/i)).not.toBeNull();
  expect(api.updateNotificationGroup).not.toHaveBeenCalled();
});

it('shows a stored off-grid time as its own option, in order', async () => {
  const user = userEvent.setup();
  const dialog = open({ ...GROUP, quiet_start: '21:10:00', quiet_end: '07:00:00' });
  expect(pressed(dialog, 'Window')).toEqual(['Custom']);
  expect((within(dialog).getByRole('combobox', { name: 'Start' }) as HTMLInputElement).value).toBe('9:10 PM');
  expect((within(dialog).getByRole('combobox', { name: 'End' }) as HTMLInputElement).value).toBe('7:00 AM');

  await user.click(within(dialog).getByRole('combobox', { name: 'Start' }));
  await screen.findByRole('button', { name: '9:10 PM' });
  const labels = screen.getAllByRole('button').map((b) => b.textContent);
  const at = labels.indexOf('9:10 PM');
  expect(labels.slice(at - 1, at + 2)).toEqual(['9:00 PM', '9:10 PM', '9:15 PM']);
});

it('saving a stored off-grid window without touching it sends nothing for it', async () => {
  const user = userEvent.setup();
  const dialog = open({ ...GROUP, quiet_start: '21:10:00', quiet_end: '07:00:00' });
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationGroup).toHaveBeenCalledWith('g1', {}));
});

it('turning quiet hours Off clears both times', async () => {
  const user = userEvent.setup();
  const dialog = open({ ...GROUP, quiet_start: '21:00:00', quiet_end: '07:00:00' });
  await user.click(press(dialog, 'Window', 'Off'));
  expect(within(dialog).queryByRole('combobox', { name: 'Start' })).toBeNull();
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationGroup)
    .toHaveBeenCalledWith('g1', { quiet_start: null, quiet_end: null }));
});

it('When blocked is a segmented Defer / Skip choice', async () => {
  const user = userEvent.setup();
  const dialog = open();
  const group = within(dialog).getByRole('group', { name: 'When blocked' });
  expect(within(group).getAllByRole('button').map((b) => b.textContent))
    .toEqual(['Defer until window opens', 'Skip entirely']);
  expect(pressed(dialog, 'When blocked')).toEqual(['Defer until window opens']);

  await user.click(press(dialog, 'When blocked', 'Skip entirely'));
  expect(pressed(dialog, 'When blocked')).toEqual(['Skip entirely']);
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationGroup)
    .toHaveBeenCalledWith('g1', { dnd_behavior: 'skip' }));
});

it('the timezone picker saves the chosen zone', async () => {
  const user = userEvent.setup();
  const dialog = open();
  expect((within(dialog).getByRole('combobox', { name: 'Timezone' }) as HTMLInputElement).value)
    .toBe('America/Chicago');
  await pick(user, dialog, 'Timezone', /^America\/New_York/);
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationGroup)
    .toHaveBeenCalledWith('g1', { timezone: 'America/New_York' }));
});

it('categories, days and urgent bypass still save as before', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(within(within(dialog).getByRole('group', { name: 'Categories' }))
    .getByRole('button', { name: 'Wiki' }));
  await user.click(within(within(dialog).getByRole('group', { name: 'Active days' }))
    .getByRole('button', { name: 'Fri' }));
  await user.click(within(dialog).getByRole('checkbox', { name: 'Urgent bypass' }));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationGroup).toHaveBeenCalledWith('g1', {
    categories: ['approvals', 'wiki', 'security'],
    active_days: ['mon', 'tue', 'wed', 'thu'],
    urgent_bypass: false,
  }));
});

it('needs at least one active day', async () => {
  const user = userEvent.setup();
  const dialog = open();
  for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
    await user.click(within(within(dialog).getByRole('group', { name: 'Active days' }))
      .getByRole('button', { name: day }));
  }
  await user.click(save(dialog));
  expect(await within(dialog).findByText(/pick at least one active day/i)).not.toBeNull();
  expect(api.updateNotificationGroup).not.toHaveBeenCalled();
});

it('puts a server error beside the buttons', async () => {
  const user = userEvent.setup();
  api.updateNotificationGroup.mockRejectedValue(new ApiError(422, 'invalid_timezone'));
  const dialog = open();
  await user.click(save(dialog));
  const message = await within(dialog).findByText('That timezone is not recognized.');
  expect(message.closest('.modal-foot')).not.toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
});

it('locks the dialog while the save is in flight', async () => {
  const user = userEvent.setup();
  api.updateNotificationGroup.mockReturnValue(new Promise(() => {}));
  const dialog = open();
  await user.click(save(dialog));
  const saving = await within(dialog).findByRole('button', { name: 'Saving…' }) as HTMLButtonElement;
  expect(saving.disabled).toBe(true);
  expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
});

it('Cancel and × close without saving', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(api.updateNotificationGroup).not.toHaveBeenCalled();
});
