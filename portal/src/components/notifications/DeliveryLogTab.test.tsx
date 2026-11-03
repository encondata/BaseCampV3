// @vitest-environment jsdom
/**
 * DeliveryLogTab — System › Notifications › Delivery log: the server-paged list
 * of every notification and email decision (usePagedList over
 * GET /notifications/log), its toolbar (search, Outcome / Channel / Category
 * facets, the time range) and the row trail. Check delivery opens from here.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type DeliveryLogEntry } from '../../lib/api';
import { fullDateTime } from '../../lib/format';
import { LIST_FIT } from '../../lib/listTools';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};   // jsdom has none; ComboBox scrolls its active option

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ preferences: { list_size: 'default' } }),
}));

const api = vi.hoisted(() => ({
  getDeliveryLogPage: vi.fn(),
  checkDelivery: vi.fn(),
  listNotificationKinds: vi.fn(),
  listNotificationRecipients: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: DeliveryLogTab } = await import('./DeliveryLogTab');

const DAY = 86_400_000;
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
/** Local Monday 2 November 2026, 7:00 AM. */
const MONDAY_7AM = new Date(2026, 10, 2, 7, 0, 0).toISOString();

const entry = (id: number, over: Partial<DeliveryLogEntry> = {}): DeliveryLogEntry => ({
  id, at: minutesAgo(5), event: 'inbox_written', channel: 'inbox', reason: null,
  kind: 'report_ready', kind_label: 'Report ready', category: 'reports', detail: {},
  process: 'api', person_id: 'p1', person_name: 'Ada Lovelace', notification_id: 'n1',
  notification_title: 'NAP11 move report is ready',
  notification_link: '/reports?tab=history&run=r1', outbox_id: null, to_address: null,
  outbox_status: null, ...over,
});

const SENT = entry(40, {
  event: 'email_sent', channel: 'email', detail: { attempt: 1 }, process: 'notification-worker',
  outbox_id: 'o1', to_address: 'ada@example.com', outbox_status: 'sent',
});
/** A queued email from before Phase 1: held by a group's schedule (deferred, with why and which groups). */
const HELD = entry(38, {
  event: 'email_queued', channel: 'email', kind: 'wiki_update', kind_label: 'Page updated',
  category: 'wiki', notification_id: 'n3', notification_title: 'Rack plan was updated',
  notification_link: 'https://wiki.example.com/pages/rack-plan',
  outbox_id: 'o3', to_address: 'ada@example.com', outbox_status: 'queued',
  detail: {
    template: 'notification', send_at: MONDAY_7AM, deferred: true, reason: 'quiet_hours',
    groups: ['Night Desk'], via: 'contact',
  },
});
const SUPPRESSED = entry(30, {
  event: 'inbox_suppressed', reason: 'category_off', kind: 'wiki_comment', kind_label: 'New comment',
  category: 'wiki', person_id: 'p2', person_name: 'Bo Diaz', notification_id: null,
  notification_title: null, notification_link: null,
});
const TEMPLATE = entry(20, {
  event: 'email_queued', channel: 'email', kind: 'learning_reminder', kind_label: 'learning_reminder',
  category: null, person_id: null, person_name: null, notification_id: null,
  notification_title: null, notification_link: null, outbox_id: 'o2',
  to_address: 'someone@example.com', outbox_status: 'queued',
  detail: { template: 'learning_reminder', send_at: minutesAgo(5), deferred: false },
});
const FAILED = entry(10, {
  event: 'email_failed', channel: 'email', kind: 'labels_ready', kind_label: 'Labels ready',
  notification_id: 'n2', notification_title: 'NAP11 labels are ready', outbox_id: 'o4',
  to_address: 'ada@example.com', outbox_status: 'failed', process: 'notification-worker',
  detail: { attempts: 5, error: 'SMTPRecipientsRefused', smtp_code: 550 },
});
const ROWS = [SENT, HELD, SUPPRESSED, TEMPLATE, FAILED];

/** Phase 1: an email held for the person's summary, the same notification
 *  once it went out in the summary, and the summary email itself. */
const HELD_FOR_SUMMARY = entry(44, {
  event: 'email_held', channel: 'email', reason: 'quiet_hours', kind: 'report_ready',
  notification_id: 'n5', notification_title: 'NAP12 move report is ready',
  detail: { summary_at: MONDAY_7AM },
});
const IN_SUMMARY = entry(43, {
  event: 'email_summarized', channel: 'email', kind: 'wiki_comment', kind_label: 'New comment',
  category: 'wiki', notification_id: 'n6', notification_title: 'Comment on the rack plan',
  outbox_id: 'o5', to_address: 'ada@example.com', outbox_status: 'sent', process: 'notification-worker',
});
const SUMMARY_EMAIL = entry(42, {
  event: 'email_queued', channel: 'email', kind: 'notification_summary',
  kind_label: 'notification_summary', category: null, notification_id: null,
  notification_title: null, notification_link: null, outbox_id: 'o5',
  to_address: 'ada@example.com', outbox_status: 'sent', process: 'notification-worker',
  detail: { template: 'notification_summary', send_at: minutesAgo(5), deferred: false, summary: true, count: 3 },
});
const NEW_ROWS = [HELD_FOR_SUMMARY, IN_SUMMARY, SUMMARY_EMAIL];

/** n1's whole trail, newest first as the API sends it. */
const TRAIL_N1 = [
  SENT,
  entry(36, {
    at: minutesAgo(30), event: 'email_queued', channel: 'email', outbox_id: 'o1',
    to_address: 'ada@example.com', outbox_status: 'sent',
    detail: { template: 'notification', send_at: minutesAgo(30), deferred: false, groups: ['Ops Alerts'], via: 'contact' },
  }),
  entry(35, { at: minutesAgo(31) }),
];

const page = (rows: DeliveryLogEntry[], next_cursor: string | null = null, total = rows.length) =>
  ({ rows, next_cursor, total });

const lastQuery = () => api.getDeliveryLogPage.mock.lastCall![0];
/** The list's own calls (not the trail's). */
const listCalls = () => api.getDeliveryLogPage.mock.calls
  .map((c) => c[0]).filter((q) => !q.notificationId && !q.outboxId);

function renderTab(onCount = vi.fn()) {
  render(<MemoryRouter><DeliveryLogTab onCount={onCount} /></MemoryRouter>);
  return onCount;
}

const rowOf = (text: string) => screen.getByText(text).closest('.dir-row') as HTMLElement;

async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Filters/ }));
  return screen.getByText('Outcome', { selector: '.pop-title' }).closest('.pop-menu') as HTMLElement;
}

beforeEach(() => {
  api.getDeliveryLogPage.mockImplementation(async (q: { notificationId?: string }) =>
    (q.notificationId === 'n1' ? page(TRAIL_N1) : page(ROWS)));
  api.listNotificationKinds.mockResolvedValue([]);
  api.listNotificationRecipients.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('asks for the last 7 days of everything, newest first', async () => {
  renderTab();
  await screen.findByText('NAP11 move report is ready');
  const [first] = listCalls();
  expect(first).toMatchObject({ events: [], channel: null, category: null, search: '', cursor: null });
  expect(Math.abs(Date.parse(first.since) - (Date.now() - 7 * DAY))).toBeLessThan(60_000);
  expect(screen.getByRole('button', { name: '7 days' }).getAttribute('aria-pressed')).toBe('true');
});

it('renders a row per decision with its outcome chip', async () => {
  renderTab();
  await screen.findByText('NAP11 move report is ready');

  const chipOf = (row: HTMLElement, label: string) => within(row).getByText(label, { selector: '.chip' });
  expect(chipOf(rowOf('NAP11 move report is ready'), 'Sent').className).toContain('c-green');
  expect(chipOf(rowOf('Rack plan was updated'), 'Held').className).toContain('c-amber');
  expect(chipOf(rowOf('Bo Diaz'), 'Not in inbox').className).toContain('c-slate');
  expect(chipOf(rowOf('learning_reminder'), 'Queued').className).toContain('c-blue');
  expect(chipOf(rowOf('NAP11 labels are ready'), 'Failed').className).toContain('c-red');
});

it('an email held for the summary is amber, one in a summary blue, and a row from before Phase 1 still reads Held', async () => {
  api.getDeliveryLogPage.mockResolvedValue(page([...NEW_ROWS, HELD]));
  renderTab();
  await screen.findByText('NAP12 move report is ready');

  const chipOf = (row: HTMLElement, label: string) => within(row).getByText(label, { selector: '.chip' });
  const held = rowOf('NAP12 move report is ready');
  expect(chipOf(held, 'Held for summary').className).toContain('c-amber');
  expect(within(held).getByText('Until Mon 7:00 AM · Quiet hours')).toBeTruthy();
  expect(within(held).getByText('Email', { selector: '.chip' })).toBeTruthy();

  const summarized = rowOf('Comment on the rack plan');
  expect(chipOf(summarized, 'In summary').className).toContain('c-blue');
  expect(within(summarized).getByText('New comment')).toBeTruthy();       // the kind under the title
  expect(within(summarized).getByText('Wiki', { selector: '.chip' })).toBeTruthy();

  // the summary email itself is template mail: queued, with how many it holds
  const mail = rowOf('notification_summary');
  expect(chipOf(mail, 'Queued').className).toContain('c-blue');
  expect(within(mail).getByText('Summary email · 3 notifications')).toBeTruthy();

  // a queued row from before Phase 1 that carries deferred keeps its words
  const old = rowOf('Rack plan was updated');
  expect(chipOf(old, 'Held').className).toContain('c-amber');
  expect(within(old).getByText('Held until Mon 7:00 AM · Quiet hours · Night Desk')).toBeTruthy();
});

it('a queued email says why it did not wait, in the Detail column', async () => {
  const queued = (id: number, title: string, extra: Record<string, unknown>) => entry(id, {
    event: 'email_queued', channel: 'email', notification_id: `n${id}`, notification_title: title,
    outbox_id: `o${id}`,
    detail: { template: 'notification', send_at: minutesAgo(5), deferred: false, via: 'contact', ...extra },
  });
  api.getDeliveryLogPage.mockResolvedValue(page([
    queued(60, 'A critical one', { critical: true }),
    queued(61, 'The owner copy', { owner_copy: true, via: 'login' }),
    queued(62, 'Sent after the summary', { after_summary: true }),
  ]));
  renderTab();
  await screen.findByText('A critical one');
  expect(within(rowOf('A critical one')).getByText('Due now · critical')).toBeTruthy();
  expect(within(rowOf('The owner copy')).getByText("Due now · owner's copy")).toBeTruthy();
  expect(within(rowOf('Sent after the summary')).getByText('Due now · after the summary')).toBeTruthy();
});

it('fills When, Person, Notification, Category, Channel and Detail', async () => {
  renderTab();
  await screen.findByText('NAP11 move report is ready');

  const held = rowOf('Rack plan was updated');
  const when = within(held).getByText('5m ago');
  expect(when.getAttribute('title')).toBe(fullDateTime(HELD.at));
  expect(within(held).getByRole('link', { name: 'Ada Lovelace' }).getAttribute('href')).toBe('/people/users/p1');
  expect(within(held).getByText('Page updated')).toBeTruthy();                 // the kind under the title
  expect(within(held).getByText('Wiki', { selector: '.chip' })).toBeTruthy();
  expect(within(held).getByText('Email', { selector: '.chip' })).toBeTruthy();
  const detail = within(held).getByText('Held until Mon 7:00 AM · Quiet hours · Night Desk');
  expect(detail.getAttribute('title')).toBe('Held until Mon 7:00 AM · Quiet hours · Night Desk');

  // template mail: no person, no category; the kind stands in for the title
  const template = rowOf('learning_reminder');
  expect(within(template).queryByRole('link')).toBeNull();
  expect(within(template).getAllByText('—').length).toBeGreaterThanOrEqual(2);  // Person and Category
  expect(within(template).getByText('Due now')).toBeTruthy();

  // an inbox row that was never written still names the kind
  const suppressed = rowOf('Bo Diaz');
  expect(within(suppressed).getByText('New comment')).toBeTruthy();
  expect(within(suppressed).getByText('Inbox', { selector: '.chip' })).toBeTruthy();
  expect(within(suppressed).getByText('Category turned off')).toBeTruthy();
});

it('the Person link opens the user page without opening the row', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByText('NAP11 move report is ready');
  const row = rowOf('Rack plan was updated');
  await user.click(within(row).getByRole('link', { name: 'Ada Lovelace' }));
  expect(row.classList.contains('open')).toBe(false);
});

it('a standard list: floors, one template for head and rows, sideways scroll, fit', async () => {
  renderTab();
  await screen.findByText('NAP11 move report is ready');
  const row = rowOf('NAP11 move report is ready');
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
  expect([...head.querySelectorAll('.col-head')].map((h) => h.textContent?.trim()).filter(Boolean))
    .toEqual(['When', 'Person', 'Notification', 'Category', 'Channel', 'Outcome', 'Detail']);
});

it('choosing "30 days" changes since, and All drops it', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByText('NAP11 move report is ready');
  const range = screen.getByRole('group', { name: 'Time range' });
  expect(within(range).getAllByRole('button').map((b) => b.textContent))
    .toEqual(['24 h', '7 days', '30 days', 'All']);

  await user.click(within(range).getByRole('button', { name: '30 days' }));
  await waitFor(() => expect(Math.abs(Date.parse(lastQuery().since) - (Date.now() - 30 * DAY)))
    .toBeLessThan(60_000));
  expect(within(range).getByRole('button', { name: '30 days' }).getAttribute('aria-pressed')).toBe('true');
  expect(within(range).getByRole('button', { name: '7 days' }).getAttribute('aria-pressed')).toBe('false');

  await user.click(within(range).getByRole('button', { name: '24 h' }));
  await waitFor(() => expect(Math.abs(Date.parse(lastQuery().since) - (Date.now() - DAY)))
    .toBeLessThan(60_000));

  await user.click(within(range).getByRole('button', { name: 'All' }));
  await waitFor(() => expect(lastQuery().since).toBeNull());
});

it('the Outcome filter sends the chosen events', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByText('NAP11 move report is ready');
  const menu = await openFilters(user);

  const optionsAfter = (title: string) => {
    const options: (string | null)[] = [];
    for (let el = within(menu).getByText(title, { selector: '.pop-title' }).nextElementSibling;
      el && el.classList.contains('pop-item'); el = el.nextElementSibling) options.push(el.textContent);
    return options;
  };
  expect(optionsAfter('Outcome')).toEqual([
    'In inbox', 'Not in inbox', 'Queued', 'Not emailed', 'Held for summary', 'In summary',
    'Sent', 'Dropped', 'Retrying', 'Failed',
  ]);
  expect(optionsAfter('Channel')).toEqual(['Inbox', 'Email']);
  expect(optionsAfter('Category')).toEqual([
    'Approvals & requests', 'Reports & labels', 'Wiki', 'Learning', 'Initiatives', 'Trucks',
    'Devices', 'Status rules', 'Bulk actions', 'Account security',
  ]);

  await user.click(within(menu).getByRole('button', { name: 'Failed' }));
  await user.click(within(menu).getByRole('button', { name: 'Sent' }));
  await waitFor(() => expect(lastQuery().events).toEqual(['email_sent', 'email_failed']));

  await user.click(within(menu).getByRole('button', { name: 'In summary' }));
  await user.click(within(menu).getByRole('button', { name: 'Held for summary' }));
  await waitFor(() => expect(lastQuery().events)
    .toEqual(['email_held', 'email_summarized', 'email_sent', 'email_failed']));
});

it('Channel and Category each send one value; picking another replaces it', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByText('NAP11 move report is ready');
  const menu = await openFilters(user);
  const item = (name: string) => within(menu).getByRole('button', { name });

  await user.click(item('Email'));
  await waitFor(() => expect(lastQuery().channel).toBe('email'));
  await user.click(item('Inbox'));
  await waitFor(() => expect(lastQuery().channel).toBe('inbox'));
  expect(item('Email').classList.contains('on')).toBe(false);
  expect(item('Inbox').classList.contains('on')).toBe(true);

  await user.click(item('Wiki'));
  await waitFor(() => expect(lastQuery().category).toBe('wiki'));
  await user.click(item('Learning'));
  await waitFor(() => expect(lastQuery().category).toBe('learning'));
  expect(item('Wiki').classList.contains('on')).toBe(false);

  await user.click(item('Learning'));                 // off again
  await waitFor(() => expect(lastQuery().category).toBeNull());
});

it('the search box searches on the server', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByText('NAP11 move report is ready');
  await user.type(screen.getByPlaceholderText('Filter this list…'), 'ada');
  await waitFor(() => expect(lastQuery().search).toBe('ada'));
});

it('expanding a row requests its trail by notificationId and shows it oldest first', async () => {
  const user = userEvent.setup();
  renderTab();
  await user.click(await screen.findByText('NAP11 move report is ready'));

  await waitFor(() => expect(api.getDeliveryLogPage).toHaveBeenCalledWith(
    expect.objectContaining({
      notificationId: 'n1', events: [], channel: null, category: null, since: null, cursor: null,
    }),
    expect.anything(),
  ));
  const trail = await screen.findByRole('table', { name: 'Delivery trail' });
  expect(within(trail).getAllByRole('columnheader').map((h) => h.textContent))
    .toEqual(['Time', 'Event', 'Detail', 'Process']);
  const rows = within(trail).getAllByRole('row').slice(1);
  expect(rows.map((r) => r.children[1].textContent)).toEqual(['In inbox', 'Queued', 'Sent']);
  expect(rows.map((r) => r.children[0].textContent)).toEqual(
    [TRAIL_N1[2], TRAIL_N1[1], TRAIL_N1[0]].map((e) => fullDateTime(e.at)));
  expect(rows[0].children[2].textContent).toBe('—');
  expect(rows[1].children[2].textContent).toBe('Due now · Ops Alerts');
  expect(rows[2].children[2].textContent).toBe('Sent on attempt 1');
  expect(rows[2].children[3].textContent).toBe('notification-worker');

  const row = rowOf('NAP11 move report is ready');
  expect(row.classList.contains('open')).toBe(true);
  expect(within(row).getByText(/^Email to/).textContent).toBe('Email to ada@example.com (contact email)');
  expect(within(row).getByRole('link', { name: 'Open user page' }).getAttribute('href'))
    .toBe('/people/users/p1');
  expect(within(row).getByRole('link', { name: 'Open notification link' }).getAttribute('href'))
    .toBe('/reports?tab=history&run=r1');
});

/** n5's whole trail, newest first as the API sends it: inbox, held, then in a summary. */
const TRAIL_HELD = [
  entry(52, {
    at: minutesAgo(5), event: 'email_summarized', channel: 'email', kind: 'report_ready',
    notification_id: 'n5', notification_title: 'NAP12 move report is ready', outbox_id: 'o5',
    to_address: 'ada@example.com', outbox_status: 'sent', process: 'notification-worker',
  }),
  entry(51, {
    at: minutesAgo(30), event: 'email_held', channel: 'email', reason: 'quiet_hours',
    notification_id: 'n5', notification_title: 'NAP12 move report is ready',
    detail: { summary_at: MONDAY_7AM },
  }),
  entry(50, { at: minutesAgo(31), notification_id: 'n5', notification_title: 'NAP12 move report is ready' }),
];

it('a held notification\'s trail reads inbox, held for the summary, then in the summary', async () => {
  const user = userEvent.setup();
  api.getDeliveryLogPage.mockImplementation(async (q: { notificationId?: string }) =>
    (q.notificationId === 'n5' ? page(TRAIL_HELD) : page([HELD_FOR_SUMMARY])));
  renderTab();
  await user.click(await screen.findByText('NAP12 move report is ready'));

  const trail = await screen.findByRole('table', { name: 'Delivery trail' });
  const rows = within(trail).getAllByRole('row').slice(1);
  expect(rows.map((r) => r.children[1].textContent)).toEqual(['In inbox', 'Held for summary', 'In summary']);
  expect(rows.map((r) => r.children[2].textContent)).toEqual(['—', 'Until Mon 7:00 AM · Quiet hours', '—']);
  expect(within(rows[1]).getByText('Held for summary').className).toContain('c-amber');
  expect(within(rows[2]).getByText('In summary').className).toContain('c-blue');
  // the address is the summary email's, from its outbox row
  expect(within(rowOf('NAP12 move report is ready')).getByText(/^Email to/).textContent)
    .toBe('Email to ada@example.com');
});

it('a held notification that is dropped reads inbox, held for the summary, then dropped with the reason', async () => {
  const user = userEvent.setup();
  api.getDeliveryLogPage.mockImplementation(async (q: { notificationId?: string }) => (q.notificationId === 'n5'
    ? page([
      entry(53, {
        at: minutesAgo(5), event: 'email_skipped', channel: 'email', reason: 'read',
        notification_id: 'n5', notification_title: 'NAP12 move report is ready',
      }),
      TRAIL_HELD[1], TRAIL_HELD[2],
    ])
    : page([HELD_FOR_SUMMARY])));
  renderTab();
  await user.click(await screen.findByText('NAP12 move report is ready'));

  const trail = await screen.findByRole('table', { name: 'Delivery trail' });
  const rows = within(trail).getAllByRole('row').slice(1);
  expect(rows.map((r) => r.children[1].textContent)).toEqual(['In inbox', 'Held for summary', 'Dropped']);
  expect(rows[2].children[2].textContent).toBe('Already read in the portal');
  expect(within(rowOf('NAP12 move report is ready')).queryByText(/^Email to/)).toBeNull();
});

it('the summary email\'s own trail runs queued, in summary for each item, then sent; each item is named', async () => {
  const user = userEvent.setup();
  const sentSummary = entry(55, {
    at: minutesAgo(4), event: 'email_sent', channel: 'email', kind: 'notification_summary',
    kind_label: 'notification_summary', category: null, notification_id: null,
    notification_title: null, notification_link: null, outbox_id: 'o5',
    to_address: 'ada@example.com', outbox_status: 'sent', process: 'notification-worker',
    detail: { attempt: 1 },
  });
  const item = (id: number, notificationId: string, title: string, secondsAgo: number) => entry(id, {
    at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
    event: 'email_summarized', channel: 'email', kind: 'wiki_comment',
    notification_id: notificationId, notification_title: title, outbox_id: 'o5',
    to_address: 'ada@example.com', outbox_status: 'sent', process: 'notification-worker',
  });
  api.getDeliveryLogPage.mockImplementation(async (q: { outboxId?: string }) => (q.outboxId === 'o5'
    ? page([sentSummary, item(54, 'n7', 'Second comment', 289), item(53, 'n6', 'First comment', 290), SUMMARY_EMAIL])
    : page([SUMMARY_EMAIL])));
  renderTab();
  await user.click(await screen.findByText('notification_summary'));

  await waitFor(() => expect(api.getDeliveryLogPage).toHaveBeenCalledWith(
    expect.objectContaining({ outboxId: 'o5' }), expect.anything()));
  const call = api.getDeliveryLogPage.mock.calls.find((c) => c[0].outboxId === 'o5')![0];
  expect(call.notificationId).toBeUndefined();
  const trail = await screen.findByRole('table', { name: 'Delivery trail' });
  const rows = within(trail).getAllByRole('row').slice(1);
  expect(rows.map((r) => r.children[1].textContent)).toEqual(['Queued', 'In summary', 'In summary', 'Sent']);
  expect(rows.map((r) => r.children[2].textContent)).toEqual([
    'Summary email · 3 notifications', 'First comment', 'Second comment', 'Sent on attempt 1',
  ]);
  expect(within(rowOf('notification_summary')).getByText(/^Email to/).textContent)
    .toBe('Email to ada@example.com');
});

it('another app\'s notification link leaves the portal; template mail opens by outbox id', async () => {
  const user = userEvent.setup();
  renderTab();
  await user.click(await screen.findByText('Rack plan was updated'));
  const held = rowOf('Rack plan was updated');
  expect((await within(held).findByRole('link', { name: 'Open notification link' })).getAttribute('href'))
    .toBe('https://wiki.example.com/pages/rack-plan');

  await user.click(screen.getByText('learning_reminder'));
  await waitFor(() => expect(api.getDeliveryLogPage).toHaveBeenCalledWith(
    expect.objectContaining({ outboxId: 'o2' }), expect.anything()));
  const call = api.getDeliveryLogPage.mock.calls.find((c) => c[0].outboxId === 'o2')![0];
  expect(call.notificationId).toBeUndefined();
  const template = rowOf('learning_reminder');
  expect(within(template).queryByRole('link', { name: 'Open user page' })).toBeNull();
  expect(within(template).queryByRole('link', { name: 'Open notification link' })).toBeNull();
});

it('an inbox row that was never written is its own trail, with no request', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByText('NAP11 move report is ready');
  const row = rowOf('Bo Diaz');
  await user.click(within(row).getByText('New comment'));
  const trail = await within(row).findByRole('table', { name: 'Delivery trail' });
  const rows = within(trail).getAllByRole('row').slice(1);
  expect(rows.map((r) => r.children[1].textContent)).toEqual(['Not in inbox']);
  expect(rows[0].children[2].textContent).toBe('Category turned off');
  expect(api.getDeliveryLogPage.mock.calls.filter((c) => c[0].notificationId || c[0].outboxId)).toEqual([]);
  expect(within(row).getByRole('link', { name: 'Open user page' }).getAttribute('href')).toBe('/people/users/p2');
  expect(within(row).queryByRole('link', { name: 'Open notification link' })).toBeNull();
});

it('a trail that fails to load says so and can retry', async () => {
  const user = userEvent.setup();
  let fail = true;
  api.getDeliveryLogPage.mockImplementation(async (q: { notificationId?: string }) => {
    if (!q.notificationId) return page(ROWS);
    if (fail) throw new Error('boom');
    return page(TRAIL_N1);
  });
  renderTab();
  await user.click(await screen.findByText('NAP11 move report is ready'));
  const row = rowOf('NAP11 move report is ready');
  expect(await within(row).findByText("Couldn't load the trail.")).toBeTruthy();
  fail = false;
  await user.click(within(row).getByRole('button', { name: 'Retry' }));
  expect(await within(row).findByRole('table', { name: 'Delivery trail' })).toBeTruthy();
});

it('"Load more" asks for the next page and appends it', async () => {
  const user = userEvent.setup();
  const older = entry(5, { notification_id: 'n9', notification_title: 'An older report' });
  api.getDeliveryLogPage.mockImplementation(async (q: { cursor: string | null }) =>
    (q.cursor === '10' ? page([older], null, 6) : page(ROWS, '10', 6)));
  renderTab();
  await screen.findByText('NAP11 move report is ready');
  expect(screen.getByText('5 of 6 shown')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('An older report')).toBeTruthy();
  expect(lastQuery()).toMatchObject({ cursor: '10' });
  expect(screen.getByText('6 of 6 shown')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

it('reports the total for the page header', async () => {
  api.getDeliveryLogPage.mockResolvedValue(page(ROWS, '10', 812));
  const onCount = renderTab();
  await screen.findByText('NAP11 move report is ready');
  await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(812));
});

it('says when nothing matches', async () => {
  api.getDeliveryLogPage.mockResolvedValue(page([]));
  renderTab();
  expect(await screen.findByText('Nothing logged')).toBeTruthy();
});

it('a failed first page says why and can reload', async () => {
  api.getDeliveryLogPage.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
  const onCount = renderTab();
  expect(await screen.findByText('Cannot load the delivery log')).toBeTruthy();
  expect(screen.getByText('Only super admins and above can read the delivery log.')).toBeTruthy();
  expect(onCount).toHaveBeenLastCalledWith(null);

  await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
  expect(await screen.findByText('NAP11 move report is ready')).toBeTruthy();
});

it('"Check delivery" opens the dry-run dialog, and Done shuts it', async () => {
  const user = userEvent.setup();
  renderTab();
  await screen.findByText('NAP11 move report is ready');
  await user.click(screen.getByRole('button', { name: 'Check delivery' }));
  const dialog = await screen.findByRole('dialog', { name: 'Check delivery' });
  await waitFor(() => expect(api.listNotificationKinds).toHaveBeenCalled());
  await user.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('dialog', { name: 'Check delivery' })).toBeNull();
});
