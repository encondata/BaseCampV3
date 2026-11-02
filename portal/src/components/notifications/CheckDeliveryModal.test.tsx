// @vitest-environment jsdom
/**
 * CheckDeliveryModal — the Delivery log's dry run: pick a person and a
 * notification type (and, for a type the account owner always gets, whose
 * copy), and GET /notifications/check explains what would happen right now —
 * the inbox, the email (now / held until the summary / not sent, and why, and
 * where to), the person's switches and where each comes from, their schedule
 * and whether it is open right now, and whether the type is critical.
 * Nothing is sent.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type DeliveryCheck, type NotificationKindInfo, type NotificationRecipient,
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
/** Local Tuesday 3 November 2026, 7:00 AM. */
const TUESDAY_7AM = new Date(2026, 10, 3, 7, 0, 0).toISOString();
const NOW = new Date().toISOString();

const KINDS: NotificationKindInfo[] = [
  { kind: 'report_ready', label: 'Report ready', category: 'reports', email: true, owner_always: false, critical: false, locked: false },
  { kind: 'password_expiring', label: 'Password expiring', category: 'security', email: true, owner_always: true, critical: true, locked: true },
  { kind: 'password_reset_request', label: 'Password reset request', category: 'approvals', email: false, owner_always: false, critical: false, locked: false },
];

const person = (person_id: string, display_name: string, job_title: string | null = null): NotificationRecipient => ({
  person_id, display_name, job_title, avatar_url: null, email: null, phone: null, has_account: true,
  can_email: true, can_text: false, can_push: true, can_web: true,
});
const PEOPLE = [person('p1', 'Ada Lovelace', 'Engineer'), person('p2', 'Bo Diaz')];

const WEEKDAYS: DeliveryCheck['schedule']['days'] = ['mon', 'tue', 'wed', 'thu', 'fri'];

const check = (over: Partial<DeliveryCheck> = {}): DeliveryCheck => ({
  person_id: 'p1', person_name: 'Ada Lovelace', kind: 'report_ready', kind_label: 'Report ready',
  category: 'reports', owner_copy: false, active: true, has_account: true,
  inbox: 'written', inbox_source: 'default', email_enabled: true, critical: false,
  switches: { inbox: { on: true, source: 'default' }, email: { on: true, source: 'default' } },
  schedule: { timezone: 'America/Chicago', days: WEEKDAYS, quiet_start: '21:00', quiet_end: '07:00', state: 'open' },
  outcome: 'now', send_at: NOW, summary_at: null, reason: null,
  address: 'ada@example.com', address_source: 'contact', ...over,
});

/** What the API answers for an email that is not sent: no address, no time. */
const notSent = (reason: string, over: Partial<DeliveryCheck> = {}): DeliveryCheck => check({
  outcome: 'not_sent', send_at: null, reason, address: null, address_source: null, ...over,
});

/** What it answers for an email held for the summary. */
const held = (over: Partial<DeliveryCheck> = {}): DeliveryCheck => check({
  outcome: 'held', send_at: null, summary_at: MONDAY_7AM, reason: 'quiet_hours',
  schedule: { timezone: 'America/Chicago', days: WEEKDAYS, quiet_start: '21:00', quiet_end: '07:00', state: 'quiet_hours' },
  ...over,
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

/** Pick Ada and "Report ready", and wait for the answer. */
async function ask(dialog: HTMLElement, user: ReturnType<typeof userEvent.setup>, kind: RegExp = /^Report ready/) {
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', kind);
  await within(dialog).findByText('Email', { selector: 'dt' });
}

/** The text of a result line (`dd`) by its label (`dt`). */
const line = (dialog: HTMLElement, label: string) =>
  within(dialog).getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? '';

it('carries the standard header: eyebrow, title and description', () => {
  const dialog = open();
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Delivery log');
  expect(within(dialog).getByRole('heading', { name: 'Check delivery' })).toBeTruthy();
  expect(dialog.querySelector('p.page-hint')?.textContent).toBe(
    'What would happen right now if this person got this type of notification. Nothing is sent.');
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

it('the copy choice is a plain two-button group: no hint under it, nothing disabled', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await pick(user, 'Person', /^Ada Lovelace/);
  await pick(user, 'Notification type', /^Password expiring/);
  const copy = within(dialog).getByRole('group', { name: 'Which copy' });
  expect(copy.hasAttribute('aria-describedby')).toBe(false);
  expect(copy.parentElement?.querySelector('p')).toBeNull();
  expect(within(copy).getAllByRole('button').every((b) => !(b as HTMLButtonElement).disabled)).toBe(true);
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

it('the result lists Inbox, Email, Their switches, Their schedule and Critical type', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await ask(dialog, user);
  expect([...dialog.querySelectorAll('dl.kv dt')].map((dt) => dt.textContent))
    .toEqual(['Inbox', 'Email', 'Their switches', 'Their schedule', 'Critical type']);
});

it('an email that goes now names the address and where it came from', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Inbox')).toBe('In inbox · Company default');
  expect(line(dialog, 'Email')).toBe('Sends now to ada@example.com (contact email)');
});

it('a held email says until the summary time, why, and where the summary goes', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(held({
    address_source: 'login',
    switches: { inbox: { on: true, source: 'default' }, email: { on: true, source: 'own' } },
  }));
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Email'))
    .toBe('Held until Mon 7:00 AM · Quiet hours · to ada@example.com (sign-in email)');
  expect(within(dialog).getByText('Held', { selector: '.chip' }).className).toContain('c-amber');
  // the same answer carries the switches and the schedule that explain it
  expect(line(dialog, 'Inbox')).toBe('In inbox · Company default');
  expect(line(dialog, 'Their switches')).toBe('Inbox on (Company default) · Email on (Their choice)');
  expect(line(dialog, 'Their schedule'))
    .toBe('America/Chicago · Mon–Fri · 9:00 PM – 7:00 AM CT · now In quiet hours');
  expect(line(dialog, 'Critical type')).toBe('No');
});

it('a held email on a day off says so, with the summary time before the next working day', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(held({
    summary_at: TUESDAY_7AM, reason: 'inactive_day',
    schedule: { timezone: 'America/Chicago', days: WEEKDAYS, quiet_start: null, quiet_end: null, state: 'inactive_day' },
  }));
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Email'))
    .toBe('Held until Tue 7:00 AM · Not an active day · to ada@example.com (contact email)');
  expect(line(dialog, 'Their schedule')).toContain('now Day off');
});

it('an email that would not go says why, and names no address', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(notSent('category_inbox_only', {
    switches: { inbox: { on: true, source: 'default' }, email: { on: false, source: 'own' } },
  }));
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Email')).toBe('Not sent · Category set to inbox only');
  expect(line(dialog, 'Email')).not.toContain('ada@example.com');
  expect(within(dialog).getByText('Not sent', { selector: '.chip' }).className).toContain('c-slate');
});

it('a category turned off keeps it out of the inbox too, and says whose choice it was', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(notSent('category_off', {
    inbox: 'suppressed', inbox_source: 'own',
    switches: { inbox: { on: false, source: 'own' }, email: { on: false, source: 'own' } },
  }));
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Inbox')).toBe('Not in inbox · Category turned off · Their choice');
  expect(line(dialog, 'Email')).toBe('Not sent · Category turned off');
  expect(line(dialog, 'Their switches')).toBe('Inbox off (Their choice) · Email off (needs Inbox)');
});

it('says Company default when the company default keeps it out of the inbox', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(notSent('category_off', {
    inbox: 'suppressed', inbox_source: 'default',
    switches: { inbox: { on: false, source: 'default' }, email: { on: false, source: 'default' } },
  }));
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Inbox')).toBe('Not in inbox · Category turned off · Company default');
  expect(line(dialog, 'Their switches')).toBe('Inbox off (Company default) · Email off (needs Inbox)');
});

it('Their switches gives each switch on or off, with where it comes from', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(check({
    switches: { inbox: { on: true, source: 'default' }, email: { on: false, source: 'own' } },
  }));
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Their switches')).toBe('Inbox on (Company default) · Email off (Their choice)');
});

it('with Inbox off, Their switches says Email needs Inbox instead of naming where the Email value comes from', async () => {
  const user = userEvent.setup();
  // What the API sends when someone turns the category off: /me writes only their Inbox value, so
  // the Email switch still follows the company default (on) and its source stays "default". Email
  // is off only because Inbox is, and naming "Company default" would blame the wrong thing.
  api.checkDelivery.mockResolvedValue(notSent('category_off', {
    inbox: 'suppressed', inbox_source: 'own',
    switches: { inbox: { on: false, source: 'own' }, email: { on: false, source: 'default' } },
  }));
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Their switches')).toBe('Inbox off (Their choice) · Email off (needs Inbox)');
});

it('with Inbox on, an Email switch the company default turned off says Company default', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(notSent('category_inbox_only', {
    switches: { inbox: { on: true, source: 'default' }, email: { on: false, source: 'default' } },
  }));
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Their switches')).toBe('Inbox on (Company default) · Email off (Company default)');
});

it('Their schedule gives the zone, days, quiet hours and whether it is open right now', async () => {
  const user = userEvent.setup();
  const quiet = formatQuietHours('21:00', '07:00', 'America/Chicago');
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Their schedule')).toBe(`America/Chicago · Mon–Fri · ${quiet} · now Open`);
  expect(quiet).toBe('9:00 PM – 7:00 AM CT');
  expect(within(dialog).getByText('Open', { selector: '.chip' }).className).toContain('c-green');
});

it('Their schedule says No quiet hours, and Daily when every day is a working day', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(check({
    schedule: {
      timezone: 'America/New_York', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      quiet_start: null, quiet_end: null, state: 'open',
    },
  }));
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Their schedule')).toBe('America/New_York · Daily · No quiet hours · now Open');
});

it('Their schedule says In quiet hours, in amber, when the quiet hours are on right now', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(held());
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Their schedule'))
    .toBe('America/Chicago · Mon–Fri · 9:00 PM – 7:00 AM CT · now In quiet hours');
  expect(within(dialog).getByText('In quiet hours', { selector: '.chip' }).className).toContain('c-amber');
});

it('Critical type says No for a type that waits, and Yes for one that skips quiet hours and the summary', async () => {
  const user = userEvent.setup();
  const dialog = open();
  await ask(dialog, user);
  expect(line(dialog, 'Critical type')).toBe('No');

  api.checkDelivery.mockResolvedValue(check({ critical: true }));
  await pick(user, 'Notification type', /^Password reset request/);   // asks again
  await waitFor(() => expect(line(dialog, 'Critical type')).toBe('Yes — skips quiet hours and the summary'));
});

it('has no Groups table, no group note, and nothing that names a group', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(held());
  const dialog = open();
  await ask(dialog, user);
  expect(within(dialog).queryByRole('table')).toBeNull();
  expect(within(dialog).queryByText('Groups', { selector: '.modal-section' })).toBeNull();
  expect(within(dialog).queryByText('Not asked')).toBeNull();
  expect(dialog.querySelector('.dlog-check')?.textContent).not.toMatch(/group/i);
});

it('the owner\'s copy goes now to the sign-in email; an admin copy stays in the inbox', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockImplementation(async (_p: string, kind: string, ownerCopy?: boolean) => {
    const fixed = { on: true, source: 'fixed' as const };
    const common = {
      kind, kind_label: 'Password expiring', category: 'security', critical: true, inbox_source: 'fixed' as const,
      switches: { inbox: fixed, email: fixed },
    };
    return ownerCopy !== false
      ? check({ ...common, owner_copy: true, address_source: 'login' })
      : notSent('admin_copy', { ...common, owner_copy: false });
  });
  const dialog = open();
  await ask(dialog, user, /^Password expiring/);
  expect(line(dialog, 'Email')).toBe('Sends now to ada@example.com (sign-in email)');
  expect(line(dialog, 'Inbox')).toBe('In inbox · Always');
  expect(line(dialog, 'Their switches')).toBe('Inbox on (Always) · Email on (Always)');
  expect(line(dialog, 'Critical type')).toBe('Yes — skips quiet hours and the summary');

  await user.click(within(dialog).getByRole('button', { name: 'An admin copy' }));
  await waitFor(() => expect(line(dialog, 'Email')).toBe('Not sent · Admin copy — inbox only'));
  expect(line(dialog, 'Inbox')).toBe('In inbox · Always');
  // the type is still critical; this copy simply is not emailed
  expect(line(dialog, 'Critical type')).toBe('Yes — skips quiet hours and the summary');
});

it('a type that is never emailed says so', async () => {
  const user = userEvent.setup();
  api.checkDelivery.mockResolvedValue(notSent('kind_not_emailed', { kind: 'password_reset_request', category: 'approvals' }));
  const dialog = open();
  await ask(dialog, user, /^Password reset request/);
  expect(line(dialog, 'Email')).toBe('Not sent · This type is never emailed');
});

it('a new pick keeps the last answer up, marked busy, until the new one lands', async () => {
  const user = userEvent.setup();
  let land: (r: DeliveryCheck) => void = () => {};
  const dialog = open();
  await ask(dialog, user);
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
