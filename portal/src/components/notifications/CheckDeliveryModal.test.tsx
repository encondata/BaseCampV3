// @vitest-environment jsdom
/**
 * CheckDeliveryModal — the Delivery log's dry run: pick a person and a
 * notification type (and, for a type the account owner always gets, whose
 * copy), and GET /notifications/check explains what would happen right now —
 * the inbox, the email (now / held until / not sent, and why, and where to),
 * and every group's verdict. Nothing is sent.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type DeliveryCheck, type DeliveryCheckGroup, type NotificationKindInfo,
  type NotificationRecipient,
} from '../../lib/api';
import { formatQuietHours } from '../../lib/notifications';

const api = vi.hoisted(() => ({
  checkDelivery: vi.fn(),
  listNotificationKinds: vi.fn(),
  listNotificationRecipients: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: CheckDeliveryModal } = await import('./CheckDeliveryModal');

/** Local Monday 2 November 2026, 7:00 AM. */
const MONDAY_7AM = new Date(2026, 10, 2, 7, 0, 0).toISOString();
const NOW = new Date().toISOString();

const KINDS: NotificationKindInfo[] = [
  { kind: 'report_ready', label: 'Report ready', category: 'reports', email: true, owner_always: false, urgent: false },
  { kind: 'password_expiring', label: 'Password expiring', category: 'security', email: true, owner_always: true, urgent: true },
  { kind: 'password_reset_request', label: 'Password reset request', category: 'approvals', email: false, owner_always: false, urgent: false },
];

const person = (person_id: string, display_name: string, job_title: string | null = null): NotificationRecipient => ({
  person_id, display_name, job_title, avatar_url: null, email: null, phone: null, has_account: true,
  can_email: true, can_text: false, can_push: true, can_web: true,
});
const PEOPLE = [person('p1', 'Ada Lovelace', 'Engineer'), person('p2', 'Bo Diaz')];

const group = (over: Partial<DeliveryCheckGroup> = {}): DeliveryCheckGroup => ({
  group_id: 'g1', name: 'Night Desk', enabled: true, subscribed: true, email_channel: true,
  verdict: 'quiet_hours', allowed_at: MONDAY_7AM, quiet_start: '21:00:00', quiet_end: '07:00:00',
  timezone: 'America/Chicago', active_days: ['mon', 'tue', 'wed', 'thu', 'fri'], ...over,
});

const check = (over: Partial<DeliveryCheck> = {}): DeliveryCheck => ({
  person_id: 'p1', person_name: 'Ada Lovelace', kind: 'report_ready', kind_label: 'Report ready',
  category: 'reports', email_source: 'groups', owner_copy: false, active: true, has_account: true,
  choice: 'email', inbox: 'written', email_enabled: true, outcome: 'now', send_at: NOW, reason: null,
  address: 'ada@example.com', address_source: 'contact', groups: [], ...over,
});

const onClose = vi.fn();

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  api.listNotificationKinds.mockResolvedValue(KINDS);
  api.listNotificationRecipients.mockResolvedValue(PEOPLE);
  api.checkDelivery.mockResolvedValue(check());
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function open() {
  render(<CheckDeliveryModal onClose={onClose} />);
  return screen.getByRole('dialog', { name: 'Check delivery' });
}

/** Open a picker and click one of its options (the menu portals out of the dialog). */
async function pick(user: ReturnType<typeof userEvent.setup>, field: string, option: RegExp) {
  await user.click(screen.getByRole('combobox', { name: field }));
  await user.click(await screen.findByRole('button', { name: option }));
}

/** The text of a result line (`dd`) by its label (`dt`). */
const line = (dialog: HTMLElement, label: string) =>
  within(dialog).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? '';

it('carries the standard header: eyebrow, title and description', () => {
  const dialog = open();
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Delivery log');
  expect(within(dialog).getByRole('heading', { name: 'Check delivery' })).toBeTruthy();
  expect(dialog.querySelector('p.page-hint')?.textContent).toBe(
    'What would happen right now if this person got a notification in this category. Nothing is sent.');
  expect(dialog.classList.contains('nm-card')).toBe(true);
});

it('uses house controls only: no select, no bare checkbox', () => {
  const dialog = open();
  expect(dialog.querySelector('select')).toBeNull();
  expect(dialog.querySelector('input[type="checkbox"]')).toBeNull();
});

it('offers the registered types with their category under each', async () => {
  const user = userEvent.setup();
  open();
  await user.click(screen.getByRole('combobox', { name: 'Notification type' }));
  const option = await screen.findByRole('button', { name: /^Report ready/ });
  expect(option.querySelector('.sub')?.textContent).toBe('Reports & labels');
  expect(screen.getByRole('button', { name: /^Password expiring/ }).querySelector('.sub')?.textContent)
    .toBe('Account security');
});

it('picking a person and "Report ready" asks checkDelivery(personId, "report_ready")', async () => {
  const user = userEvent.setup();
  open();
  await pick(user, 'Person', /^Ada Lovelace/);
  expect(api.checkDelivery).not.toHaveBeenCalled();
  await pick(user, 'Notification type', /^Report ready/);
  await waitFor(() => expect(api.checkDelivery).toHaveBeenCalledTimes(1));
  expect(api.checkDelivery.mock.calls[0]).toEqual(['p1', 'report_ready']);   // owner_copy left out
});

it('the owner / admin copy choice shows only for a type the owner always gets', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', /^Report ready/);
  await waitFor(() => expect(api.checkDelivery).toHaveBeenCalled());
  expect(within(dialog).queryByRole('group', { name: 'Which copy' })).toBeNull();

  await pick(user, 'Notification type', /^Password expiring/);
  const copy = within(dialog).getByRole('group', { name: 'Which copy' });
  expect(within(copy).getAllByRole('button').map((b) => [b.textContent, b.getAttribute('aria-pressed')]))
    .toEqual([['The account owner', 'true'], ['An admin copy', 'false']]);
  await waitFor(() => expect(api.checkDelivery.mock.lastCall).toEqual(['p1', 'password_expiring']));

  await user.click(within(copy).getByRole('button', { name: 'An admin copy' }));
  await waitFor(() => expect(api.checkDelivery.mock.lastCall).toEqual(['p1', 'password_expiring', false]));
  expect(within(copy).getByRole('button', { name: 'An admin copy' }).getAttribute('aria-pressed')).toBe('true');

  await user.click(within(copy).getByRole('button', { name: 'The account owner' }));
  await waitFor(() => expect(api.checkDelivery.mock.lastCall).toEqual(['p1', 'password_expiring']));
});

it('a new type starts from the owner\'s copy again', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', /^Password expiring/);
  await user.click(within(dialog).getByRole('button', { name: 'An admin copy' }));
  await pick(user, 'Notification type', /^Report ready/);
  await pick(user, 'Notification type', /^Password expiring/);
  expect(within(dialog).getByRole('button', { name: 'The account owner' }).getAttribute('aria-pressed'))
    .toBe('true');
});

it('an email that goes now names the address and where it came from', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', /^Report ready/);
  await within(dialog).findByText('Email', { selector: 'dt' });
  expect(line(dialog, 'Inbox')).toBe('In inbox');
  expect(line(dialog, 'Email')).toBe('Sends now to ada@example.com (contact email)');
});

it('a held email says until when and why', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(check({
    outcome: 'held', send_at: MONDAY_7AM, reason: 'quiet_hours', address_source: 'login',
    groups: [group()],
  }));
  const dialog = open();
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', /^Report ready/);
  await within(dialog).findByText('Email', { selector: 'dt' });
  const email = line(dialog, 'Email');
  expect(email).toContain('Held until Mon 7:00 AM');
  expect(email).toContain('Quiet hours');
  expect(email).toContain('to ada@example.com (sign-in email)');
  expect(within(dialog).getByText('Held', { selector: '.chip' }).className).toContain('c-amber');
});

it('an email that would not go says why, and names no address', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(check({
    outcome: 'not_sent', send_at: null, reason: 'no_email_group',
    groups: [group({ email_channel: false, verdict: 'no_email_channel', allowed_at: null })],
  }));
  const dialog = open();
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', /^Report ready/);
  await within(dialog).findByText('Email', { selector: 'dt' });
  expect(line(dialog, 'Email')).toBe('Not sent · No group emails this category');
  expect(line(dialog, 'Email')).not.toContain('ada@example.com');
});

it('a category turned off keeps it out of the inbox too', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(check({
    choice: 'off', inbox: 'suppressed', outcome: 'not_sent', send_at: null, reason: 'category_off',
  }));
  const dialog = open();
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', /^Report ready/);
  await within(dialog).findByText('Inbox', { selector: 'dt' });
  expect(line(dialog, 'Inbox')).toBe('Not in inbox · Category turned off');
  expect(line(dialog, 'Email')).toBe('Not sent · Category turned off');
});

it('renders every group\'s verdict in a table', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(check({
    outcome: 'held', send_at: MONDAY_7AM, reason: 'quiet_hours',
    groups: [
      group(),
      group({ group_id: 'g2', name: 'Ops Alerts', verdict: 'open', allowed_at: NOW, quiet_start: null, quiet_end: null, active_days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] }),
      group({ group_id: 'g3', name: 'Skips Nights', verdict: 'quiet_hours', allowed_at: null }),   // skips instead of deferring
      group({ group_id: 'g4', name: 'Old Team', enabled: false, verdict: 'paused', allowed_at: null }),
      group({ group_id: 'g5', name: 'Wiki Only', subscribed: false, verdict: 'not_subscribed', allowed_at: null }),
    ],
  }));
  const dialog = open();
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', /^Report ready/);

  const table = await within(dialog).findByRole('table', { name: 'Groups' });
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent))
    .toEqual(['Group', 'Subscribed', 'Email', 'Now', 'Earliest send']);
  const rows = within(table).getAllByRole('row').slice(1);
  const cells = (r: HTMLElement) => [...r.children].map((c) => c.textContent);

  const quiet = formatQuietHours('21:00:00', '07:00:00', 'America/Chicago');
  expect(cells(rows[0])).toEqual([`Night Desk${quiet} · Mon–Fri`, 'Yes', 'Yes', 'Quiet hours', 'Mon 7:00 AM']);
  expect(cells(rows[1])).toEqual(['Ops AlertsNo quiet hours · Daily', 'Yes', 'Yes', 'Open', 'Now']);
  expect(cells(rows[2])[3]).toBe('Quiet hours');
  expect(cells(rows[2])[4]).toBe('Never');
  expect(cells(rows[3]).slice(3)).toEqual(['Paused', '—']);
  expect(cells(rows[4]).slice(1)).toEqual(['No', 'Yes', 'Not subscribed', '—']);
  expect(within(rows[0]).getByText('Quiet hours', { selector: '.chip' }).className).toContain('c-amber');
  expect(within(rows[1]).getByText('Open', { selector: '.chip' }).className).toContain('c-green');
});

it('a person in no group gets an empty groups table that says so', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(check({ outcome: 'not_sent', send_at: null, reason: 'no_email_group' }));
  const dialog = open();
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', /^Report ready/);
  const table = await within(dialog).findByRole('table', { name: 'Groups' });
  expect(within(table).getByText('Not in any notification group.')).toBeTruthy();
});

it('the owner\'s copy is always emailed; an admin copy explains the groups path instead', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockImplementation(async (_p: string, kind: string, ownerCopy?: boolean) => check({
    kind, kind_label: 'Password expiring', category: 'security', email_source: 'always',
    owner_copy: ownerCopy !== false, address_source: ownerCopy !== false ? 'login' : 'contact',
    groups: [group({ verdict: 'quiet_hours' })],
  }));
  const dialog = open();
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', /^Password expiring/);
  expect(await within(dialog).findByText(/always emailed/)).toBeTruthy();

  await user.click(within(dialog).getByRole('button', { name: 'An admin copy' }));
  await waitFor(() => expect(within(dialog).queryByText(/always emailed/)).toBeNull());
  expect(within(dialog).getByText(/covers Account security with Email on/)).toBeTruthy();
});

it('a type that is never emailed says no group is asked', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(check({
    kind: 'password_reset_request', category: 'approvals', outcome: 'not_sent', send_at: null,
    reason: 'kind_not_emailed', address: null, address_source: null,
  }));
  const dialog = open();
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', /^Password reset request/);
  expect(await within(dialog).findByText('This type is never emailed, so no group is asked.')).toBeTruthy();
  expect(line(dialog, 'Email')).toBe('Not sent · This type is never emailed');
});

it('a new pick keeps the last answer up, marked busy, until the new one lands', async () => {
  const user = userEvent.setup();
  let land: (r: DeliveryCheck) => void = () => {};
  const dialog = open();
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', /^Report ready/);
  await within(dialog).findByText('Email', { selector: 'dt' });
  const answer = () => within(dialog).getByRole('region', { name: 'Result' }).parentElement as HTMLElement;
  expect(answer().getAttribute('aria-busy')).toBe('false');

  api.checkDelivery.mockImplementationOnce(() => new Promise<DeliveryCheck>((resolve) => { land = resolve; }));
  await pick(user, 'Person', /^Bo Diaz/);
  expect(line(dialog, 'Email')).toBe('Sends now to ada@example.com (contact email)');   // still the last answer
  expect(answer().getAttribute('aria-busy')).toBe('true');

  land(check({ person_id: 'p2', person_name: 'Bo Diaz', address: 'bo@example.com' }));
  await waitFor(() => expect(line(dialog, 'Email')).toBe('Sends now to bo@example.com (contact email)'));
  expect(answer().getAttribute('aria-busy')).toBe('false');
});

it('a person who is gone says so instead of a result', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockRejectedValue(new ApiError(404, 'person_not_found'));
  const dialog = open();
  await pick(user, 'Person', /^Bo Diaz/);
  await pick(user, 'Notification type', /^Report ready/);
  expect((await within(dialog).findByRole('alert')).textContent).toBe('That person no longer exists.');
  expect(within(dialog).queryByText('Email', { selector: 'dt' })).toBeNull();
});

it('Done closes the dialog', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await user.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(onClose).toHaveBeenCalled();
});
