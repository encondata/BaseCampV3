// @vitest-environment jsdom
/**
 * OverrideEditorModal — one member's own settings for a group, every
 * inherit-or-custom choice a segmented control with the group's value as a
 * hint under it. Saving diffs against the stored overrides (an explicit
 * null for "back to the group's value"), and a channel the screen hides is
 * never dropped. The self-service /me editor is this same modal with
 * `onSave` and its own header.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type NotificationGroupDetail, type NotificationMember,
  type NotificationMemberOverrides,
} from '../../lib/api';

const api = vi.hoisted(() => ({ updateNotificationMember: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const GROUP: NotificationGroupDetail = {
  id: 'g1',
  name: 'Ops Alerts',
  description: 'Operational issues',
  channels: ['email', 'text'],
  categories: ['approvals'],
  quiet_start: '21:00:00',
  quiet_end: '07:00:00',
  timezone: 'America/Chicago',
  active_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  dnd_behavior: 'defer',
  urgent_bypass: true,
  enabled: true,
  member_count: 1,
  created_at: '2026-01-01T00:00:00Z',
  members: [],
};

const NO_OVERRIDES: NotificationMemberOverrides = {
  channels: null, quiet_mode: null, quiet_start: null, quiet_end: null,
  timezone: null, active_days: null, dnd_behavior: null, urgent_bypass: null,
};

const member = (overrides: Partial<NotificationMemberOverrides> = {}): NotificationMember => ({
  person_id: 'p1',
  display_name: 'Alice Tech',
  job_title: null,
  avatar_url: null,
  email: 'alice@example.com',
  phone: '555-1212',
  has_account: true,
  can_email: true,
  can_text: true,
  can_push: true,
  can_web: true,
  overrides: { ...NO_OVERRIDES, ...overrides },
  effective: {
    channels: ['email', 'text'], quiet_start: '21:00:00', quiet_end: '07:00:00',
    timezone: 'America/Chicago', active_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    dnd_behavior: 'defer', urgent_bypass: true,
  },
  added_at: '2026-01-02T00:00:00Z',
});

const onClose = vi.fn();
const onSaved = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  api.updateNotificationMember.mockResolvedValue(member());
});

afterEach(cleanup);

const { default: OverrideEditorModal } = await import('./OverrideEditorModal');

function open(
  m: NotificationMember = member(),
  extra: { group?: NotificationGroupDetail; onSave?: (b: Partial<NotificationMemberOverrides>) => Promise<unknown> } = {},
) {
  render(<OverrideEditorModal group={extra.group ?? GROUP} member={m}
                              onSave={extra.onSave} onClose={onClose} onSaved={onSaved} />);
  return screen.getByRole('dialog');
}

const save = (dialog: HTMLElement) => within(dialog).getByRole('button', { name: 'Save' });
const seg = (dialog: HTMLElement, group: string) => within(dialog).getByRole('group', { name: group });
const press = (dialog: HTMLElement, group: string, name: string) =>
  within(seg(dialog, group)).getByRole('button', { name });
const pressed = (dialog: HTMLElement, group: string) =>
  within(seg(dialog, group)).getAllByRole('button')
    .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
const labels = (dialog: HTMLElement, group: string) =>
  within(seg(dialog, group)).getAllByRole('button').map((b) => b.textContent);

async function pick(
  user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement, field: string, option: string | RegExp,
) {
  await user.click(within(dialog).getByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('button', { name: option }));
}

it('uses house controls only: no select, no time input, no bare checkbox', async () => {
  const user = userEvent.setup();
  const dialog = open(member({ channels: ['email'] }));
  expect(dialog.querySelector('select')).toBeNull();
  expect(dialog.querySelector('input[type="time"]')).toBeNull();
  await user.click(press(dialog, 'Quiet hours', 'Custom'));   // reveals the time pickers
  await user.click(press(dialog, 'Timezone', 'Custom'));
  expect(dialog.querySelector('select')).toBeNull();
  expect(dialog.querySelector('input[type="time"]')).toBeNull();
  const boxes = [...dialog.querySelectorAll('input[type="checkbox"]')];
  expect(boxes.length).toBeGreaterThan(0);
  expect(boxes.every((b) => b.closest('label.switch'))).toBe(true);
});

it('admin header: eyebrow, "Overrides — name" and the first name in the description', () => {
  const dialog = open();
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Notification group');
  expect(within(dialog).getByRole('heading', { name: 'Overrides — Alice Tech' })).not.toBeNull();
  const hint = within(dialog).getByText(
    "Alice's own settings for this group. Anything on Group default follows the group.");
  expect(hint.className).toContain('page-hint');
});

it('self-service header (onSave passed): "Your settings", "My settings — group"', () => {
  const dialog = open(member(), { onSave: vi.fn().mockResolvedValue(undefined) });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Your settings');
  expect(within(dialog).getByRole('heading', { name: 'My settings — Ops Alerts' })).not.toBeNull();
  const hint = within(dialog).getByText('Anything on Group default follows the group.');
  expect(hint.className).toContain('page-hint');
  expect(within(dialog).queryByRole('heading', { name: /Overrides/ })).toBeNull();
});

it('every choice is a segmented control, all on Group default for a member with no overrides', () => {
  const dialog = open();
  expect(labels(dialog, 'Channels')).toEqual(['Group default', 'Custom']);
  expect(labels(dialog, 'Active days')).toEqual(['Group default', 'Custom']);
  expect(labels(dialog, 'Quiet hours')).toEqual(['Group default', 'None', 'Custom']);
  expect(labels(dialog, 'Timezone')).toEqual(['Group default', 'Custom']);
  expect(labels(dialog, 'When blocked')).toEqual(['Group default', 'Defer', 'Skip']);
  expect(labels(dialog, 'Urgent bypass')).toEqual(['Group default', 'On', 'Off']);
  for (const g of ['Channels', 'Active days', 'Quiet hours', 'Timezone', 'When blocked', 'Urgent bypass']) {
    expect(seg(dialog, g).classList.contains('segmented')).toBe(true);
    expect(pressed(dialog, g)).toEqual(['Group default']);
  }
});

it('shows the stored overrides as the pressed segment', () => {
  const dialog = open(member({
    channels: ['email'], active_days: ['sat'], quiet_mode: 'none', timezone: 'UTC',
    dnd_behavior: 'skip', urgent_bypass: false,
  }));
  expect(pressed(dialog, 'Channels')).toEqual(['Custom']);
  expect(pressed(dialog, 'Active days')).toEqual(['Custom']);
  expect(pressed(dialog, 'Quiet hours')).toEqual(['None']);
  expect(pressed(dialog, 'Timezone')).toEqual(['Custom']);
  expect(pressed(dialog, 'When blocked')).toEqual(['Skip']);
  expect(pressed(dialog, 'Urgent bypass')).toEqual(['Off']);
});

it('shows the group\'s value as a hint under each control', () => {
  const dialog = open();
  const hintOf = (g: string) => seg(dialog, g).nextElementSibling as HTMLElement;
  expect(hintOf('Quiet hours').textContent).toBe('Group default: 9:00 PM – 7:00 AM CT');
  expect(hintOf('Channels').textContent).toBe('Group default: Email');
  expect(hintOf('Active days').textContent).toBe('Group default: Mon–Fri');
  expect(hintOf('Timezone').textContent).toBe('Group default: America/Chicago');
  expect(hintOf('When blocked').textContent).toBe('Group default: Defer until window opens');
  expect(hintOf('Urgent bypass').textContent).toBe('Group default: Ignores quiet hours');
  for (const g of ['Quiet hours', 'Channels', 'Active days', 'Timezone', 'When blocked', 'Urgent bypass']) {
    expect(hintOf(g).classList.contains('cell-sub')).toBe(true);
  }
});

it('words the hints for a group with no quiet hours, no email, and a respectful bypass', () => {
  const dialog = open(member(), {
    group: { ...GROUP, channels: ['text', 'push'], quiet_start: null, quiet_end: null,
      dnd_behavior: 'skip', urgent_bypass: false },
  });
  const hintOf = (g: string) => seg(dialog, g).nextElementSibling as HTMLElement;
  expect(hintOf('Quiet hours').textContent).toBe('Group default: None');
  expect(hintOf('Channels').textContent).toBe('Group default: No email');
  expect(hintOf('When blocked').textContent).toBe('Group default: Skip entirely');
  expect(hintOf('Urgent bypass').textContent).toBe('Group default: Respects quiet hours');
});

it('sends an empty patch when nothing changed (a stored off-grid time is not a change)', async () => {
  const user = userEvent.setup();
  const dialog = open(member({ channels: ['email'], quiet_mode: 'custom', quiet_start: '21:10:00', quiet_end: '07:00:00' }));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember).toHaveBeenCalledWith('g1', 'p1', {}));
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

it('Quiet hours None saves quiet_mode "none" with both times cleared', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(press(dialog, 'Quiet hours', 'None'));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember).toHaveBeenCalledWith('g1', 'p1', {
    quiet_mode: 'none', quiet_start: null, quiet_end: null,
  }));
});

it('Quiet hours Group default saves quiet_mode null', async () => {
  const user = userEvent.setup();
  const dialog = open(member({ quiet_mode: 'none' }));
  expect(pressed(dialog, 'Quiet hours')).toEqual(['None']);
  await user.click(press(dialog, 'Quiet hours', 'Group default'));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember).toHaveBeenCalledWith('g1', 'p1', {
    quiet_mode: null, quiet_start: null, quiet_end: null,
  }));
});

it('Quiet hours Custom takes quarter-hour ComboBox times and saves them as HH:MM', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(press(dialog, 'Quiet hours', 'Custom'));
  await pick(user, dialog, 'Start', '10:00 PM');
  await pick(user, dialog, 'End', '6:30 AM');
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember).toHaveBeenCalledWith('g1', 'p1', {
    quiet_mode: 'custom', quiet_start: '22:00', quiet_end: '06:30',
  }));
});

it('a stored off-grid custom time shows as its own option', async () => {
  const user = userEvent.setup();
  const dialog = open(member({ quiet_mode: 'custom', quiet_start: '21:10:00', quiet_end: '07:00:00' }));
  expect((within(dialog).getByRole('combobox', { name: 'Start' }) as HTMLInputElement).value).toBe('9:10 PM');
  await user.click(within(dialog).getByRole('combobox', { name: 'Start' }));
  await screen.findByRole('button', { name: '9:10 PM' });
});

it('Custom quiet hours need both times', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(press(dialog, 'Quiet hours', 'Custom'));
  await pick(user, dialog, 'Start', '10:00 PM');
  await user.click(save(dialog));
  expect(await within(dialog).findByText(/need both a start and an end/i)).not.toBeNull();
  expect(api.updateNotificationMember).not.toHaveBeenCalled();
});

it('Urgent bypass Off saves false, On saves true, and Group default clears it', async () => {
  const user = userEvent.setup();
  let dialog = open();
  await user.click(press(dialog, 'Urgent bypass', 'Off'));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { urgent_bypass: false }));
  cleanup();

  dialog = open();
  await user.click(press(dialog, 'Urgent bypass', 'On'));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenLastCalledWith('g1', 'p1', { urgent_bypass: true }));
  cleanup();

  dialog = open(member({ urgent_bypass: true }));
  expect(pressed(dialog, 'Urgent bypass')).toEqual(['On']);
  await user.click(press(dialog, 'Urgent bypass', 'Group default'));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenLastCalledWith('g1', 'p1', { urgent_bypass: null }));
});

it('When blocked Skip saves skip, Defer saves defer', async () => {
  const user = userEvent.setup();
  let dialog = open();
  await user.click(press(dialog, 'When blocked', 'Skip'));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { dnd_behavior: 'skip' }));
  cleanup();

  dialog = open(member({ dnd_behavior: 'skip' }));
  await user.click(press(dialog, 'When blocked', 'Defer'));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenLastCalledWith('g1', 'p1', { dnd_behavior: 'defer' }));
});

it('Custom timezone shows the zone picker and saves the choice', async () => {
  const user = userEvent.setup();
  const dialog = open();
  expect(within(dialog).queryByRole('combobox', { name: 'Timezone' })).toBeNull();
  await user.click(press(dialog, 'Timezone', 'Custom'));
  expect((within(dialog).getByRole('combobox', { name: 'Timezone' }) as HTMLInputElement).value)
    .toBe('America/Chicago');
  await pick(user, dialog, 'Timezone', /^America\/Denver/);
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { timezone: 'America/Denver' }));
});

it('Custom active days are day toggles, and at least one is required', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(press(dialog, 'Active days', 'Custom'));
  const days = within(dialog).getByRole('group', { name: 'Custom days' });
  expect(within(days).getAllByRole('button').map((b) => b.textContent))
    .toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  expect(within(days).getAllByRole('button').every((b) => b.getAttribute('aria-pressed') === 'false')).toBe(true);

  await user.click(save(dialog));
  expect(await within(dialog).findByText(/pick at least one active day/i)).not.toBeNull();
  expect(api.updateNotificationMember).not.toHaveBeenCalled();

  await user.click(within(days).getByRole('button', { name: 'Sat' }));
  await user.click(within(days).getByRole('button', { name: 'Sun' }));
  expect(within(days).getByRole('button', { name: 'Sat' }).getAttribute('aria-pressed')).toBe('true');
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { active_days: ['sat', 'sun'] }));
});

// ── channels ───────────────────────────────────────────────────────────

it('Custom channels list only the live channel, even for a member who can get every channel', async () => {
  const user = userEvent.setup();
  const dialog = open();   // can_email/text/push/web all true
  expect(within(dialog).queryByRole('checkbox', { name: 'Email' })).toBeNull();   // Group default: no switches
  await user.click(press(dialog, 'Channels', 'Custom'));
  expect(within(dialog).getAllByRole('checkbox').map((b) => b.getAttribute('aria-label')))
    .toEqual(['Email']);
  for (const hidden of [/text/i, /push/i, /web/i]) {
    expect(within(dialog).queryByRole('checkbox', { name: hidden })).toBeNull();
  }
  expect(screen.queryByText(/not available yet/i)).toBeNull();
});

it('a member who cannot be emailed gets no channel switch', async () => {
  const user = userEvent.setup();
  const dialog = open({ ...member(), can_email: false });
  await user.click(press(dialog, 'Channels', 'Custom'));
  expect(within(dialog).queryAllByRole('checkbox')).toEqual([]);
  expect(within(dialog).getByText('This member will get no email from this group.')).not.toBeNull();
});

it('a member override of Text only, switched to Custom with Email on, saves Email and Text', async () => {
  const user = userEvent.setup();
  const dialog = open(member({ channels: ['text'] }));
  expect(pressed(dialog, 'Channels')).toEqual(['Custom']);
  expect((within(dialog).getByRole('checkbox', { name: 'Email' }) as HTMLInputElement).checked).toBe(false);
  expect(within(dialog).getByText('This member will get no email from this group.')).not.toBeNull();

  await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }));
  expect(within(dialog).queryByText('This member will get no email from this group.')).toBeNull();
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { channels: ['email', 'text'] }));
});

it('going Group default → Custom → Email on keeps the stored hidden channels the same way', async () => {
  const user = userEvent.setup();
  const dialog = open(member({ channels: ['text', 'web'] }));
  await user.click(press(dialog, 'Channels', 'Group default'));
  await user.click(press(dialog, 'Channels', 'Custom'));
  await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { channels: ['email', 'text', 'web'] }));
});

it('turning Email off keeps the stored Text', async () => {
  const user = userEvent.setup();
  const dialog = open(member({ channels: ['email', 'text'] }));
  await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { channels: ['text'] }));
});

it('changing something else leaves a custom channel list, hidden channels included, untouched', async () => {
  const user = userEvent.setup();
  const dialog = open(member({ channels: ['email', 'text', 'push'] }));
  await user.click(press(dialog, 'Urgent bypass', 'Off'));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { urgent_bypass: false }));
});

it('keeps a stored email override that the member cannot receive right now', async () => {
  const user = userEvent.setup();
  const dialog = open({ ...member({ channels: ['email'] }), can_email: false });
  expect(within(dialog).queryAllByRole('checkbox')).toEqual([]);
  await user.click(press(dialog, 'Urgent bypass', 'Off'));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { urgent_bypass: false }));
});

// ── a stored channel the member can no longer receive ──────────────────
// The API refuses a channel list that holds a channel outside the person's
// capabilities (Text needs a phone, Push and Web need an account) with a 422
// channel_unavailable. So a save that changes the list sends only what the
// member can still receive, and a list left alone is not sent at all (the
// server keeps what is stored).

/** Alice with her phone number gone: Text is stored on her override but she cannot get it. */
const noPhone = (overrides: Partial<NotificationMemberOverrides>): NotificationMember => (
  { ...member(overrides), can_text: false });

it('turning Email off drops a stored Text the member can no longer receive', async () => {
  const user = userEvent.setup();
  const dialog = open(noPhone({ channels: ['email', 'text'] }));
  await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { channels: [] }));
});

it('turning Email on keeps only the stored channels the member can still receive', async () => {
  const user = userEvent.setup();
  const dialog = open(noPhone({ channels: ['text', 'web'] }));   // Web still reachable, Text not
  await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { channels: ['email', 'web'] }));
});

it('Group default → Custom → Email on sends only what the member can receive', async () => {
  const user = userEvent.setup();
  const dialog = open(noPhone({ channels: ['text'] }));
  await user.click(press(dialog, 'Channels', 'Group default'));
  await user.click(press(dialog, 'Channels', 'Custom'));
  await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { channels: ['email'] }));
});

it('a member without an account loses a stored Push or Web the same way', async () => {
  const user = userEvent.setup();
  const dialog = open({ ...member({ channels: ['email', 'push', 'web'] }), can_push: false, can_web: false });
  await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { channels: [] }));
});

it('self-service (onSave) gets the same list the API accepts', async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue(undefined);
  const dialog = open(noPhone({ channels: ['email', 'text'] }), { onSave });
  await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }));
  await user.click(save(dialog));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ channels: [] }));
  expect(api.updateNotificationMember).not.toHaveBeenCalled();
});

it('an untouched channel list is not sent, so a stored Text nobody can receive stays stored', async () => {
  const user = userEvent.setup();
  const dialog = open(noPhone({ channels: ['email', 'text'] }));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember).toHaveBeenCalledWith('g1', 'p1', {}));
});

it('changing something else leaves that same channel list out of the patch', async () => {
  const user = userEvent.setup();
  const dialog = open(noPhone({ channels: ['email', 'text'] }));
  await user.click(press(dialog, 'Urgent bypass', 'Off'));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { urgent_bypass: false }));
});

it('switching Email off and on again is still an untouched list', async () => {
  const user = userEvent.setup();
  const dialog = open(noPhone({ channels: ['email', 'text'] }));
  await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }));
  await user.click(within(dialog).getByRole('checkbox', { name: 'Email' }));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember).toHaveBeenCalledWith('g1', 'p1', {}));
});

it('Group default clears a custom channel list with an explicit null', async () => {
  const user = userEvent.setup();
  const dialog = open(member({ channels: ['email'] }));
  await user.click(press(dialog, 'Channels', 'Group default'));
  await user.click(save(dialog));
  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p1', { channels: null }));
});

// ── saving ─────────────────────────────────────────────────────────────

it('self-service hands the patch to onSave instead of the admin endpoint', async () => {
  const user = userEvent.setup();
  const onSave = vi.fn().mockResolvedValue(undefined);
  const dialog = open(member(), { onSave });
  await user.click(press(dialog, 'Urgent bypass', 'Off'));
  await user.click(save(dialog));
  await waitFor(() => expect(onSave).toHaveBeenCalledWith({ urgent_bypass: false }));
  expect(api.updateNotificationMember).not.toHaveBeenCalled();
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
});

it('puts a server error beside the buttons and stays open', async () => {
  const user = userEvent.setup();
  api.updateNotificationMember.mockRejectedValue(new ApiError(422, 'channel_unavailable'));
  const dialog = open();
  await user.click(save(dialog));
  const message = await within(dialog).findByText("That channel isn't available for this person.");
  expect(message.closest('.modal-foot')).not.toBeNull();
  expect(onSaved).not.toHaveBeenCalled();
});

it('locks the dialog while the save is in flight', async () => {
  const user = userEvent.setup();
  api.updateNotificationMember.mockReturnValue(new Promise(() => {}));
  const dialog = open();
  await user.click(save(dialog));
  expect(((await within(dialog).findByRole('button', { name: 'Saving…' })) as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);
  expect((press(dialog, 'Urgent bypass', 'Off') as HTMLButtonElement).disabled).toBe(true);
});

it('Cancel and × close without saving', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await user.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(api.updateNotificationMember).not.toHaveBeenCalled();
});
