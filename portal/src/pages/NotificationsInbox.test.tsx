// @vitest-environment jsdom
/**
 * /notifications: the full inbox. Rows are the bell's (InboxRow), grouped
 * Today / Yesterday / Earlier by the local date of created_at, paged with
 * "Load more" behind usePagedList. Row actions go through the shared inbox
 * context (so the bell's badge follows) and show on the page at once through
 * a local overlay; Mark all read / Clear read reload page 1.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { InboxItem } from '../lib/api';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};   // jsdom has none; ComboBox scrolls its active option

const ctx = vi.hoisted(() => ({
  unreadCount: 0, items: [] as InboxItem[], newItems: [] as InboxItem[],
  refresh: vi.fn(() => Promise.resolve()), markRead: vi.fn(() => Promise.resolve()),
  markUnread: vi.fn(() => Promise.resolve()), markAllRead: vi.fn(() => Promise.resolve()),
  hide: vi.fn(() => Promise.resolve()), clearRead: vi.fn(() => Promise.resolve()),
  dismissNew: vi.fn(), toast: vi.fn(), localToasts: [], dismissLocal: vi.fn(),
}));
vi.mock('../lib/notificationsContext', () => ({ useNotifications: () => ctx }));

const api = vi.hoisted(() => ({
  listInboxPage: vi.fn(),
  approveMembershipRequest: vi.fn(() => Promise.resolve()),
  rejectMembershipRequest: vi.fn(() => Promise.resolve()),
  approveRouter: vi.fn(() => Promise.resolve()),
  revokeRouter: vi.fn(() => Promise.resolve()),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

vi.mock('../lib/inboxLinks', async (importActual) => ({
  ...(await importActual<typeof import('../lib/inboxLinks')>()),
  leaveFor: vi.fn(),
}));
const { leaveFor } = await import('../lib/inboxLinks');

const { default: NotificationsInbox } = await import('./NotificationsInbox');

/** Local noon, `daysAgo` calendar days back: the grouping is by LOCAL date, and
 *  noon keeps a fixture on its day whatever time the suite runs (and across DST). */
const noon = (daysAgo: number): string => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysAgo, 12, 0, 0).toISOString();
};

const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id, kind: 'report_ready', category: 'reports', title: `Report ${id}`, body: 'NAP11',
  link: `/reports?tab=history&run=${id}`, payload: { run_id: id },
  created_at: noon(0), read_at: null, ...over,
});

const page = (rows: InboxItem[], next_cursor: string | null = null) =>
  ({ rows, next_cursor, total: rows.length });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/notifications']}>
      <Routes>
        <Route path="/notifications" element={<NotificationsInbox />} />
        <Route path="/reports" element={<div>reports page</div>} />
        <Route path="/me/notifications" element={<div>settings page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const rowOf = (title: string) => screen.getByText(title).closest('[role="listitem"]') as HTMLElement;
const titlesIn = (group: string) =>
  within(screen.getByRole('list', { name: group })).getAllByRole('listitem')
    .map((r) => r.querySelector('.notif-title')?.textContent);
const lastQuery = () => api.listInboxPage.mock.lastCall![0];
const listCard = () => document.querySelector('.dir-list') as HTMLElement;

/** A promise the test settles by hand, to hold a page-1 reload open. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
type Page = ReturnType<typeof page>;

beforeEach(() => {
  ctx.unreadCount = 0;
  api.listInboxPage.mockResolvedValue(page([]));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('names the page like the other account pages and asks the first page of everything', async () => {
  api.listInboxPage.mockResolvedValue(page([item('a')]));
  renderPage();
  expect(screen.getByText('Account').classList.contains('eyebrow')).toBe(true);
  expect(screen.getByRole('heading', { level: 1, name: 'Notifications' })).toBeTruthy();
  expect(screen.getByText('Everything sent to you, newest first.')).toBeTruthy();
  await screen.findByText('Report a');
  expect(api.listInboxPage).toHaveBeenCalledTimes(1);
  expect(lastQuery()).toMatchObject({ category: null, unreadOnly: false, cursor: null });
});

it('groups rows under Today, Yesterday and Earlier by the local date of created_at', async () => {
  api.listInboxPage.mockResolvedValue(page([
    item('t1', { created_at: noon(0) }), item('t2', { created_at: noon(0) }),
    item('y1', { created_at: noon(1) }),
    item('e1', { created_at: noon(2) }), item('e2', { created_at: noon(40) }),
  ]));
  renderPage();
  await screen.findByText('Report t1');
  expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent))
    .toEqual(['Today', 'Yesterday', 'Earlier']);
  expect(titlesIn('Today')).toEqual(['Report t1', 'Report t2']);
  expect(titlesIn('Yesterday')).toEqual(['Report y1']);
  expect(titlesIn('Earlier')).toEqual(['Report e1', 'Report e2']);
});

it('draws no heading for a day with nothing in it', async () => {
  api.listInboxPage.mockResolvedValue(page([item('y1', { created_at: noon(1) }), item('e1', { created_at: noon(9) })]));
  renderPage();
  await screen.findByText('Report y1');
  expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Yesterday', 'Earlier']);
  expect(screen.queryByRole('heading', { name: 'Today' })).toBeNull();
});

it('rows are the bell rows: kind icon, unread dot, body and relative time', async () => {
  api.listInboxPage.mockResolvedValue(page([
    item('a'),
    item('b', { kind: 'report_failed', title: 'Move Report failed', read_at: new Date().toISOString() }),
  ]));
  renderPage();
  await screen.findByText('Report a');
  const a = rowOf('Report a');
  const b = rowOf('Move Report failed');
  expect(a.className).toContain('unread');
  expect(a.querySelector('.notif-dot')).toBeTruthy();
  expect(a.querySelector('.notif-icon-report_ready')).toBeTruthy();
  expect(within(a).getByText('NAP11')).toBeTruthy();
  expect(b.className).not.toContain('unread');
  expect(b.querySelector('.notif-icon-report_failed')).toBeTruthy();
});

it('a notification about several items keeps one line per item in its body', async () => {
  const body = 'Truck A: Created → Active\nTruck B: Created → Active';
  api.listInboxPage.mockResolvedValue(page([
    item('g', { kind: 'truck_status_changed', category: 'trucks', title: 'Truck status changed (2)', body }),
  ]));
  renderPage();
  await screen.findByText('Truck status changed (2)');

  const row = rowOf('Truck status changed (2)');
  const text = row.querySelector('.notif-body') as HTMLElement;
  expect(text.textContent).toBe(body);          // the break is in the text...
  // ...and the stylesheet shows it. jsdom lays nothing out, so ask the cascade of the real
  // toast.css what .notif-body does with a line break (and that the time under it is not touched).
  const style = document.createElement('style');
  style.textContent = readFileSync(join(__dirname, '../styles/toast.css'), 'utf8');
  document.head.appendChild(style);
  try {
    expect(getComputedStyle(text).whiteSpace).toBe('pre-line');
    expect(getComputedStyle(row.querySelector('.notif-time') as HTMLElement).whiteSpace).not.toBe('pre-line');
  } finally {
    style.remove();
  }
});

it('All | Unread is a pressed-state segmented control; Unread asks for unread only', async () => {
  const user = userEvent.setup();
  renderPage();
  const all = screen.getByRole('button', { name: 'All' });
  const unread = screen.getByRole('button', { name: 'Unread' });
  expect(all.closest('.segmented')).toBeTruthy();
  expect(all.getAttribute('aria-pressed')).toBe('true');
  expect(unread.getAttribute('aria-pressed')).toBe('false');
  await waitFor(() => expect(api.listInboxPage).toHaveBeenCalledTimes(1));

  await user.click(unread);
  await waitFor(() => expect(lastQuery()).toMatchObject({ unreadOnly: true, category: null, cursor: null }));
  expect(unread.getAttribute('aria-pressed')).toBe('true');
  expect(all.getAttribute('aria-pressed')).toBe('false');

  await user.click(all);
  await waitFor(() => expect(lastQuery()).toMatchObject({ unreadOnly: false }));
});

it('the category picker is the house dropdown: All categories plus the twelve, and a pick filters the server', async () => {
  const user = userEvent.setup();
  renderPage();
  const picker = screen.getByRole('combobox', { name: 'Category' }) as HTMLInputElement;
  expect(picker.classList.contains('org-select')).toBe(true);
  expect(picker.value).toBe('All categories');

  await user.click(picker);
  expect(within(document.querySelector('.combo-menu') as HTMLElement).getAllByRole('button').map((b) => b.textContent))
    .toEqual([
      'All categories', 'Approvals & requests', 'Reports & labels', 'Wiki', 'Learning',
      'Initiatives', 'Assets', 'Project plans', 'Trucks', 'Devices', 'Status rules',
      'Bulk actions', 'Account security',
    ]);

  await user.click(screen.getByRole('button', { name: 'Wiki' }));
  await waitFor(() => expect(lastQuery()).toMatchObject({ category: 'wiki', unreadOnly: false, cursor: null }));
  expect(picker.value).toBe('Wiki');

  await user.click(screen.getByRole('button', { name: 'Unread' }));
  await waitFor(() => expect(lastQuery()).toMatchObject({ category: 'wiki', unreadOnly: true }));

  await user.click(picker);
  await user.click(screen.getByRole('button', { name: 'All categories' }));
  await waitFor(() => expect(lastQuery()).toMatchObject({ category: null, unreadOnly: true }));
});

it('"Load more" asks for the next_cursor and appends; it goes away on the last page', async () => {
  const user = userEvent.setup();
  api.listInboxPage
    .mockResolvedValueOnce(page([item('a'), item('b')], 'cursor-2'))
    .mockResolvedValueOnce(page([item('c')], null));
  renderPage();
  await screen.findByText('Report a');
  expect(api.listInboxPage).toHaveBeenCalledTimes(1);

  await user.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('Report c');
  expect(api.listInboxPage).toHaveBeenCalledTimes(2);
  expect(lastQuery()).toMatchObject({ cursor: 'cursor-2', unreadOnly: false, category: null });
  expect(screen.getAllByRole('listitem')).toHaveLength(3);
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

it('no "Load more" when the first page is everything', async () => {
  api.listInboxPage.mockResolvedValue(page([item('a')], null));
  renderPage();
  await screen.findByText('Report a');
  expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
});

it('marking a row read updates it in place with no reload, and tells the shared inbox', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockResolvedValue(page([item('a'), item('b')]));
  renderPage();
  await screen.findByText('Report a');
  const row = rowOf('Report a');
  expect(row.className).toContain('unread');

  await user.click(within(row).getByRole('button', { name: 'Mark read' }));
  expect(ctx.markRead).toHaveBeenCalledWith('a');
  expect(row.className).not.toContain('unread');
  expect(row.querySelector('.notif-dot')).toBeNull();
  expect(within(row).getByRole('button', { name: 'Mark unread' })).toBeTruthy();
  expect(rowOf('Report b').className).toContain('unread');             // only that row
  expect(api.listInboxPage).toHaveBeenCalledTimes(1);                  // no reload

  await user.click(within(row).getByRole('button', { name: 'Mark unread' }));
  expect(ctx.markUnread).toHaveBeenCalledWith('a');
  expect(row.className).toContain('unread');
  expect(within(row).getByRole('button', { name: 'Mark read' })).toBeTruthy();
  expect(api.listInboxPage).toHaveBeenCalledTimes(1);
});

it('a row that was already read can be marked unread in place', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockResolvedValue(page([item('a', { read_at: new Date().toISOString() })]));
  renderPage();
  await screen.findByText('Report a');
  await user.click(screen.getByRole('button', { name: 'Mark unread' }));
  expect(ctx.markUnread).toHaveBeenCalledWith('a');
  expect(rowOf('Report a').className).toContain('unread');
});

it('Hide removes the row at once with no reload, and the group heading goes with its last row', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockResolvedValue(page([item('t', { created_at: noon(0) }), item('y', { created_at: noon(1) })]));
  renderPage();
  await screen.findByText('Report t');

  await user.click(within(rowOf('Report y')).getByRole('button', { name: 'Hide' }));
  expect(ctx.hide).toHaveBeenCalledWith('y');
  expect(screen.queryByText('Report y')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Yesterday' })).toBeNull();
  expect(screen.getByText('Report t')).toBeTruthy();
  expect(api.listInboxPage).toHaveBeenCalledTimes(1);
});

it('hiding every loaded row while more remain offers "Load more" instead of claiming the inbox is empty', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockResolvedValue(page([item('a')], 'cursor-2'));
  renderPage();
  await screen.findByText('Report a');
  await user.click(screen.getByRole('button', { name: 'Hide' }));
  expect(screen.queryByText('Report a')).toBeNull();
  expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
  expect(screen.queryByText('No notifications yet.')).toBeNull();
  expect(screen.queryByText("You're all caught up.")).toBeNull();
  expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
});

it('row actions carry a tip matching their label and no native title', async () => {
  api.listInboxPage.mockResolvedValue(page([item('a'), item('b', { read_at: new Date().toISOString() })]));
  renderPage();
  await screen.findByText('Report a');
  const buttons = [
    within(rowOf('Report a')).getByRole('button', { name: 'Mark read' }),
    within(rowOf('Report b')).getByRole('button', { name: 'Mark unread' }),
    ...screen.getAllByRole('button', { name: 'Hide' }),
  ];
  for (const btn of buttons) {
    expect(btn.hasAttribute('title')).toBe(false);
    expect(btn.getAttribute('data-tip')).toBe(btn.getAttribute('aria-label'));
  }
});

it('opening a row marks it read and follows its link: in the app by router, to another app by leaving', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockResolvedValue(page([
    item('w', { kind: 'wiki_update', category: 'wiki', title: 'Pat published Runbook', link: 'https://wiki.example.com/n/abc' }),
    item('a', { title: 'Move Report ready', link: '/reports' }),
    item('n', { title: 'No link here', link: null }),
  ]));
  renderPage();
  await screen.findByText('Pat published Runbook');

  await user.click(screen.getByText('Pat published Runbook'));
  expect(leaveFor).toHaveBeenCalledWith('https://wiki.example.com/n/abc');
  expect(ctx.markRead).toHaveBeenCalledWith('w');
  expect(rowOf('Pat published Runbook').className).not.toContain('unread');
  expect(screen.queryByText('reports page')).toBeNull();

  await user.click(screen.getByText('No link here'));
  expect(ctx.markRead).toHaveBeenCalledWith('n');
  expect(leaveFor).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('reports page')).toBeNull();

  await user.click(screen.getByText('Move Report ready'));
  expect(ctx.markRead).toHaveBeenCalledWith('a');
  expect(screen.getByText('reports page')).toBeTruthy();
});

it('opening a row that is already read does not mark it again', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockResolvedValue(page([item('a', { title: 'Old news', read_at: new Date().toISOString(), link: '/reports' })]));
  renderPage();
  await user.click(await screen.findByText('Old news'));
  expect(ctx.markRead).not.toHaveBeenCalled();
  expect(screen.getByText('reports page')).toBeTruthy();
});

it('a row marked read on the page and then opened is not marked twice', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockResolvedValue(page([item('a', { link: '/reports' })]));
  renderPage();
  await screen.findByText('Report a');
  await user.click(screen.getByRole('button', { name: 'Mark read' }));
  await user.click(screen.getByText('Report a'));
  expect(ctx.markRead).toHaveBeenCalledTimes(1);
});

it('arrow keys move between rows across the day groups; Enter opens the focused row', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockResolvedValue(page([
    item('t', { created_at: noon(0), link: '/reports' }), item('y', { created_at: noon(1), link: '/reports' }),
  ]));
  renderPage();
  await screen.findByText('Report t');
  const [first, second] = screen.getAllByRole('listitem');
  first.focus();
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(second);
  await user.keyboard('{ArrowUp}');
  expect(document.activeElement).toBe(first);
  await user.keyboard('{Enter}');
  expect(ctx.markRead).toHaveBeenCalledWith('t');
  expect(screen.getByText('reports page')).toBeTruthy();
});

it('a new view brings in the server state too: what the page overlaid on the old view is dropped', async () => {
  const user = userEvent.setup();
  const readAt = new Date().toISOString();
  api.listInboxPage.mockResolvedValue(page([item('a', { read_at: readAt })]));
  renderPage();
  await screen.findByText('Report a');
  await user.click(screen.getByRole('button', { name: 'Mark unread' }));
  expect(rowOf('Report a').className).toContain('unread');             // overlay: unread

  await user.click(screen.getByRole('button', { name: 'Unread' }));
  await waitFor(() => expect(lastQuery()).toMatchObject({ unreadOnly: true }));
  await waitFor(() => expect(rowOf('Report a').className).not.toContain('unread'));   // the server says read
});

it('Mark all read goes through the shared inbox, then reloads page 1', async () => {
  const user = userEvent.setup();
  ctx.unreadCount = 2;
  api.listInboxPage.mockResolvedValueOnce(page([item('a'), item('b')])).mockResolvedValue(
    page([item('a', { read_at: new Date().toISOString() }), item('b', { read_at: new Date().toISOString() })]));
  renderPage();
  await screen.findByText('Report a');
  expect(rowOf('Report a').className).toContain('unread');

  await user.click(screen.getByRole('button', { name: 'Mark all read' }));
  expect(ctx.markAllRead).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(api.listInboxPage).toHaveBeenCalledTimes(2));
  expect(lastQuery()).toMatchObject({ cursor: null });
  await waitFor(() => expect(rowOf('Report a').className).not.toContain('unread'));
  expect(rowOf('Report b').className).not.toContain('unread');
});

it('Mark all read paints the loaded rows read at once, before the server has answered', async () => {
  const user = userEvent.setup();
  ctx.unreadCount = 2;
  api.listInboxPage.mockResolvedValue(page([item('a'), item('b', { read_at: new Date().toISOString() }), item('c')]));
  ctx.markAllRead.mockReturnValueOnce(new Promise(() => {}));          // the server never answers in this test
  renderPage();
  await screen.findByText('Report a');
  await user.click(screen.getByRole('button', { name: 'Mark all read' }));
  expect(rowOf('Report a').className).not.toContain('unread');
  expect(rowOf('Report c').className).not.toContain('unread');
  expect(api.listInboxPage).toHaveBeenCalledTimes(1);                  // the reload waits for the inbox call
});

it('Clear read hides the loaded read rows at once, before the server has answered', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockResolvedValue(page([item('a'), item('b', { read_at: new Date().toISOString() })]));
  ctx.clearRead.mockReturnValueOnce(new Promise(() => {}));
  renderPage();
  await screen.findByText('Report b');
  await user.click(screen.getByRole('button', { name: 'Clear read' }));
  expect(screen.queryByText('Report b')).toBeNull();
  expect(screen.getByText('Report a')).toBeTruthy();
  expect(api.listInboxPage).toHaveBeenCalledTimes(1);
});

// The hook keeps the old rows on screen until page 1 lands, so the page's patches stay on them until then
// and go when the fresh rows arrive. The tests below hold the reload open to see both sides of that.

it('Mark all read keeps the rows read while page 1 reloads; when the fresh rows land their word wins', async () => {
  const user = userEvent.setup();
  const readAt = new Date().toISOString();
  const reload = deferred<Page>();
  ctx.unreadCount = 2;
  api.listInboxPage.mockResolvedValueOnce(page([item('a'), item('b')])).mockReturnValueOnce(reload.promise);
  renderPage();
  await screen.findByText('Report a');

  await user.click(screen.getByRole('button', { name: 'Mark all read' }));
  await waitFor(() => expect(api.listInboxPage).toHaveBeenCalledTimes(2));            // the reload is out, held open
  await waitFor(() => expect(listCard().getAttribute('aria-busy')).toBe('true'));      // and the page shows it is loading
  expect(rowOf('Report a').className).not.toContain('unread');                         // the old rows keep what was painted on them
  expect(rowOf('Report b').className).not.toContain('unread');

  reload.resolve(page([item('a', { read_at: readAt }), item('b')]));                   // the server: b is unread (someone marked it again)
  await waitFor(() => expect(rowOf('Report b').className).toContain('unread'));        // fresh rows replace the patches
  expect(rowOf('Report a').className).not.toContain('unread');
  expect(listCard().getAttribute('aria-busy')).toBe('false');
});

it('a row marked read stays read while an All to Unread switch loads; the new view then brings in the server state', async () => {
  const user = userEvent.setup();
  const reload = deferred<Page>();
  api.listInboxPage.mockResolvedValueOnce(page([item('a'), item('b')])).mockReturnValueOnce(reload.promise);
  renderPage();
  await screen.findByText('Report a');
  await user.click(within(rowOf('Report a')).getByRole('button', { name: 'Mark read' }));

  await user.click(screen.getByRole('button', { name: 'Unread' }));
  await waitFor(() => expect(lastQuery()).toMatchObject({ unreadOnly: true }));
  expect(rowOf('Report a').className).not.toContain('unread');                         // the old view is still up, with its patch
  expect(rowOf('Report b').className).toContain('unread');

  reload.resolve(page([item('b')]));                                                   // the server: only b is unread
  await waitFor(() => expect(screen.queryByText('Report a')).toBeNull());
  expect(rowOf('Report b').className).toContain('unread');
});

it('"Load more" keeps what the page painted on the rows it already showed', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockResolvedValueOnce(page([item('a')], 'cursor-2')).mockResolvedValueOnce(page([item('b')], null));
  renderPage();
  await screen.findByText('Report a');
  await user.click(screen.getByRole('button', { name: 'Mark read' }));                  // only a is on screen
  await user.click(screen.getByRole('button', { name: 'Load more' }));
  await screen.findByText('Report b');
  expect(rowOf('Report a').className).not.toContain('unread');
  expect(rowOf('Report b').className).toContain('unread');
});

it('Clear read goes through the shared inbox, then reloads page 1', async () => {
  const user = userEvent.setup();
  const readAt = new Date().toISOString();
  api.listInboxPage.mockResolvedValueOnce(page([item('a'), item('b', { read_at: readAt })]))
    .mockResolvedValue(page([item('a')]));
  renderPage();
  await screen.findByText('Report b');

  await user.click(screen.getByRole('button', { name: 'Clear read' }));
  expect(ctx.clearRead).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(api.listInboxPage).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByText('Report b')).toBeNull());
  expect(screen.getByText('Report a')).toBeTruthy();
});

it('Mark all read is off when nothing is unread; Clear read is off when a full unfiltered list has nothing read', async () => {
  api.listInboxPage.mockResolvedValue(page([item('a', { read_at: new Date().toISOString() })]));
  ctx.unreadCount = 0;
  renderPage();
  await screen.findByText('Report a');
  expect(screen.getByRole('button', { name: 'Mark all read' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByRole('button', { name: 'Clear read' }).hasAttribute('disabled')).toBe(false);
  cleanup();

  api.listInboxPage.mockResolvedValue(page([item('a')]));
  ctx.unreadCount = 1;
  renderPage();
  await screen.findByText('Report a');
  expect(screen.getByRole('button', { name: 'Mark all read' }).hasAttribute('disabled')).toBe(false);
  expect(screen.getByRole('button', { name: 'Clear read' }).hasAttribute('disabled')).toBe(true);
});

it('Clear read stays available when the list is filtered or more is waiting (read rows may be out of view)', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockResolvedValue(page([item('a')], 'cursor-2'));
  renderPage();
  await screen.findByText('Report a');
  expect(screen.getByRole('button', { name: 'Clear read' }).hasAttribute('disabled')).toBe(false);   // more pages
  cleanup();

  api.listInboxPage.mockResolvedValue(page([item('a')], null));
  renderPage();
  await screen.findByText('Report a');
  expect(screen.getByRole('button', { name: 'Clear read' }).hasAttribute('disabled')).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Unread' }));
  await waitFor(() => expect(lastQuery()).toMatchObject({ unreadOnly: true }));
  expect(screen.getByRole('button', { name: 'Clear read' }).hasAttribute('disabled')).toBe(false);   // filtered
});

it('Settings is a mini-btn link to /me/notifications', async () => {
  const user = userEvent.setup();
  renderPage();
  const settings = screen.getByRole('link', { name: 'Settings' });
  expect(settings.getAttribute('href')).toBe('/me/notifications');
  expect(settings.classList.contains('mini-btn')).toBe(true);
  await user.click(settings);
  expect(screen.getByText('settings page')).toBeTruthy();
});

it('the toolbar is the house one: Mark all read, Clear read and Settings share it with the filters', async () => {
  renderPage();
  const toolbar = document.querySelector('.dir-toolbar') as HTMLElement;
  expect(within(toolbar).getByRole('button', { name: 'All' })).toBeTruthy();
  expect(within(toolbar).getByRole('combobox', { name: 'Category' })).toBeTruthy();
  for (const name of ['Mark all read', 'Clear read']) {
    expect(within(toolbar).getByRole('button', { name }).classList.contains('mini-btn')).toBe(true);
  }
  expect(within(toolbar).getByRole('link', { name: 'Settings' })).toBeTruthy();
  await waitFor(() => expect(api.listInboxPage).toHaveBeenCalled());
});

it('an empty inbox says "No notifications yet."; an empty Unread view says "You\'re all caught up."', async () => {
  const user = userEvent.setup();
  renderPage();
  expect(await screen.findByText('No notifications yet.')).toBeTruthy();
  expect(screen.queryByText("You're all caught up.")).toBeNull();
  expect(screen.queryByRole('heading', { level: 2 })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Unread' }));
  expect(await screen.findByText("You're all caught up.")).toBeTruthy();
  expect(screen.queryByText('No notifications yet.')).toBeNull();
});

it('neither empty line shows while the first page is still loading', async () => {
  api.listInboxPage.mockReturnValue(new Promise(() => {}));
  renderPage();
  expect(screen.getByText('Loading…')).toBeTruthy();
  expect(screen.queryByText('No notifications yet.')).toBeNull();
  expect(screen.queryByText("You're all caught up.")).toBeNull();
});

it('a failed first page says so and "Try again" asks for it again', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockRejectedValueOnce(new Error('boom')).mockResolvedValue(page([item('a')]));
  renderPage();
  expect(await screen.findByText("Couldn't load notifications")).toBeTruthy();
  expect(screen.getByText('Network error — try again.')).toBeTruthy();
  expect(screen.queryByText('No notifications yet.')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Try again' }));
  expect(await screen.findByText('Report a')).toBeTruthy();
  expect(screen.queryByText("Couldn't load notifications")).toBeNull();
});

it('a failed "Load more" keeps the rows, says so, and Retry asks for the same page again', async () => {
  const user = userEvent.setup();
  api.listInboxPage
    .mockResolvedValueOnce(page([item('a')], 'cursor-2'))
    .mockRejectedValueOnce(new Error('boom'))
    .mockResolvedValueOnce(page([item('b')], null));
  renderPage();
  await screen.findByText('Report a');
  await user.click(screen.getByRole('button', { name: 'Load more' }));
  expect(await screen.findByText('Network error — try again.')).toBeTruthy();
  expect(screen.getByText('Report a')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Report b')).toBeTruthy();
  expect(lastQuery()).toMatchObject({ cursor: 'cursor-2' });
});

const requestItem = (id: string, state: string): InboxItem => item(id, {
  kind: 'membership_request', category: 'approvals', title: 'Alice asks to join Ops Alerts', body: 'Please add me',
  link: '/system/notifications', payload: { request_id: 'r1', group_id: 'g1', state, decided_by: 'Ada' },
});

it('the approve/reject strips work on the page: Approve decides, then the bell and the page both refresh', async () => {
  const user = userEvent.setup();
  api.listInboxPage
    .mockResolvedValueOnce(page([requestItem('n1', 'pending')]))
    .mockResolvedValue(page([requestItem('n1', 'approved')]));
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Approve' }));
  expect(api.approveMembershipRequest).toHaveBeenCalledWith('r1');
  expect(ctx.refresh).toHaveBeenCalled();
  await waitFor(() => expect(api.listInboxPage).toHaveBeenCalledTimes(2));
  expect(await screen.findByText('Approved by Ada')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByText('reports page')).toBeNull();               // a strip click never opens the row
});

it('Approve stays busy until the fresh rows land, so a second click cannot reach an already-decided request', async () => {
  const user = userEvent.setup();
  const reload = deferred<Page>();
  api.listInboxPage.mockResolvedValueOnce(page([requestItem('n1', 'pending')])).mockReturnValueOnce(reload.promise);
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(api.listInboxPage).toHaveBeenCalledTimes(2));            // decided, the bell refreshed, page 1 held open
  expect(api.approveMembershipRequest).toHaveBeenCalledTimes(1);
  expect(ctx.refresh).toHaveBeenCalled();
  const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
  const reject = screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
  expect(approve.disabled).toBe(true);                                                 // the stale pending row is still up
  expect(reject.disabled).toBe(true);
  await user.click(approve);
  expect(api.approveMembershipRequest).toHaveBeenCalledTimes(1);

  reload.resolve(page([requestItem('n1', 'approved')]));
  expect(await screen.findByText('Approved by Ada')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
});

it('the strip is free again once the fresh rows land, even when the row still says pending', async () => {
  const user = userEvent.setup();
  const reload = deferred<Page>();
  api.listInboxPage.mockResolvedValueOnce(page([requestItem('n1', 'pending')])).mockReturnValueOnce(reload.promise);
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(api.listInboxPage).toHaveBeenCalledTimes(2));
  expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);

  reload.resolve(page([requestItem('n1', 'pending')]));
  await waitFor(() => expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false));
});

it('a pending router approval shows its strip on the page too', async () => {
  const user = userEvent.setup();
  api.listInboxPage.mockResolvedValue(page([item('n1', {
    kind: 'router_approval', category: 'approvals', title: 'Router waiting for approval', body: 'GL.iNet',
    link: '/hardware/routers?focus=r1', payload: { device_id: 'd1', state: 'pending' },
  })]));
  renderPage();
  await user.click(await screen.findByRole('button', { name: 'Reject' }));
  expect(api.revokeRouter).toHaveBeenCalledWith('d1');
});
