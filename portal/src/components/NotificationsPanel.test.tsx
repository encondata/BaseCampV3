// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { InboxItem } from '../lib/api';

const ctx = vi.hoisted(() => ({
  unreadCount: 0, items: [] as InboxItem[], newItems: [] as InboxItem[],
  refresh: vi.fn(() => Promise.resolve()), markRead: vi.fn(() => Promise.resolve()), markUnread: vi.fn(() => Promise.resolve()),
  markAllRead: vi.fn(() => Promise.resolve()), hide: vi.fn(() => Promise.resolve()),
  clearRead: vi.fn(() => Promise.resolve()), dismissNew: vi.fn(), toast: vi.fn(),
  localToasts: [], dismissLocal: vi.fn(),
}));
vi.mock('../lib/notificationsContext', () => ({ useNotifications: () => ctx }));

const api = vi.hoisted(() => ({
  approveMembershipRequest: vi.fn(() => Promise.resolve()),
  rejectMembershipRequest: vi.fn(() => Promise.resolve()),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const { default: NotificationsPanel } = await import('./NotificationsPanel');

const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id, kind: 'report_ready', title: `Report ${id}`, body: 'NAP11', link: `/reports?tab=history&run=${id}`,
  payload: { run_id: id }, created_at: new Date(Date.now() - 90_000).toISOString(), read_at: null, ...over,
});

function renderPanel(onClose = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="*" element={<NotificationsPanel onClose={onClose} />} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

beforeEach(() => { ctx.items = []; ctx.unreadCount = 0; });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('renders rows with kind icon, unread dot, body and relative time; header shows the unread chip', () => {
  ctx.items = [item('a'), item('b', { kind: 'report_failed', read_at: new Date().toISOString(), title: 'Move Report failed' })];
  ctx.unreadCount = 1;
  renderPanel();
  expect(screen.getByText('Notifications')).toBeTruthy();
  expect(screen.getByText('1 unread')).toBeTruthy();
  const rows = screen.getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(rows[0].className).toContain('unread');
  expect(rows[1].className).not.toContain('unread');
  expect(rows[0].querySelector('.notif-dot')).toBeTruthy();
  expect(rows[1].querySelector('.notif-dot')).toBeNull();
  expect(rows[0].querySelector('.notif-icon-report_ready')).toBeTruthy();
  expect(rows[1].querySelector('.notif-icon-report_failed')).toBeTruthy();
  // both fixtures are 90 s old, so both rows render the same relative time
  expect(screen.getAllByText('1m ago')).toHaveLength(2);
});

it('row click marks read, closes, and navigates; action buttons do not navigate', async () => {
  const user = userEvent.setup();
  ctx.items = [item('a'), item('b', { read_at: new Date().toISOString() })];
  ctx.unreadCount = 1;
  const onClose = renderPanel();
  await user.click(screen.getByText('Report a'));
  expect(ctx.markRead).toHaveBeenCalledWith('a');
  expect(onClose).toHaveBeenCalledTimes(1);

  await user.click(screen.getByText('Report b'));      // row b is already read
  expect(ctx.markRead).toHaveBeenCalledTimes(1);        // no redundant markRead on a read row
  expect(onClose).toHaveBeenCalledTimes(2);             // still opens/closes

  await user.click(screen.getAllByRole('button', { name: 'Mark read' })[0]);
  expect(ctx.markRead).toHaveBeenCalledTimes(2);
  await user.click(screen.getByRole('button', { name: 'Mark unread' }));
  expect(ctx.markUnread).toHaveBeenCalledWith('b');
  await user.click(screen.getAllByRole('button', { name: 'Hide' })[1]);
  expect(ctx.hide).toHaveBeenCalledWith('b');
  expect(onClose).toHaveBeenCalledTimes(2);           // actions never close/navigate
});

it('row action buttons carry a data-tip matching their label and no native title', () => {
  ctx.items = [item('a'), item('b', { read_at: new Date().toISOString() })];
  ctx.unreadCount = 1;
  renderPanel();
  const markRead = screen.getAllByRole('button', { name: 'Mark read' })[0];
  const markUnread = screen.getByRole('button', { name: 'Mark unread' });
  const hideButtons = screen.getAllByRole('button', { name: 'Hide' });
  for (const btn of [markRead, markUnread, ...hideButtons]) {
    expect(btn.hasAttribute('title')).toBe(false);
  }
  expect(markRead.getAttribute('data-tip')).toBe('Mark read');
  expect(markUnread.getAttribute('data-tip')).toBe('Mark unread');
  for (const btn of hideButtons) {
    expect(btn.getAttribute('data-tip')).toBe('Hide');
  }
});

it('header actions: Mark all read disabled at 0 unread; Clear read disabled with no read rows', async () => {
  const user = userEvent.setup();
  ctx.items = [item('a')];
  ctx.unreadCount = 1;
  renderPanel();
  expect((screen.getByRole('button', { name: 'Clear read' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Mark all read' }));
  expect(ctx.markAllRead).toHaveBeenCalled();
  cleanup();
  ctx.items = [item('a', { read_at: new Date().toISOString() })];
  ctx.unreadCount = 0;
  renderPanel();
  expect((screen.getByRole('button', { name: 'Mark all read' }) as HTMLButtonElement).disabled).toBe(true);
  await user.click(screen.getByRole('button', { name: 'Clear read' }));
  expect(ctx.clearRead).toHaveBeenCalled();
});

it('empty state, cap footer, and keyboard: Escape closes, arrows move focus, Enter opens', async () => {
  const user = userEvent.setup();
  const onClose = renderPanel();
  expect(screen.getByText("You're all caught up.")).toBeTruthy();
  cleanup();
  ctx.items = Array.from({ length: 50 }, (_, i) => item(`n${i}`));
  ctx.unreadCount = 50;
  const onClose2 = renderPanel();
  expect(screen.getByText('Showing the 50 most recent')).toBeTruthy();
  const rows = screen.getAllByRole('listitem');
  rows[0].focus();
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(rows[1]);
  await user.keyboard('{ArrowUp}');
  expect(document.activeElement).toBe(rows[0]);
  await user.keyboard('{Enter}');
  expect(ctx.markRead).toHaveBeenCalledWith('n0');
  await user.keyboard('{Escape}');
  expect(onClose2).toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it('Escape reaches the panel even when focus is on a row action button', async () => {
  const user = userEvent.setup();
  ctx.items = [item('a')];
  ctx.unreadCount = 1;
  const onClose = renderPanel();
  screen.getByRole('button', { name: 'Hide' }).focus();
  await user.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalled();
});

const requestItem = (id: string, payload: Record<string, unknown>, over: Partial<InboxItem> = {}): InboxItem => item(id, {
  kind: 'membership_request',
  title: 'Alice asks to join Ops Alerts',
  body: 'Please add me',
  link: '/system/notifications',
  payload,
  ...over,
});

it('a pending membership_request row shows Approve/Reject; Approve calls the API and refreshes', async () => {
  const user = userEvent.setup();
  ctx.items = [requestItem('n1', { request_id: 'r1', group_id: 'g1', state: 'pending' })];
  const onClose = renderPanel();

  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(api.approveMembershipRequest).toHaveBeenCalledWith('r1');
  expect(ctx.refresh).toHaveBeenCalled();
  // clicking the button inside the strip must never navigate the row
  expect(onClose).not.toHaveBeenCalled();
});

it('Reject reveals a one-line note field; Confirm reject sends the trimmed note', async () => {
  const user = userEvent.setup();
  ctx.items = [requestItem('n1', { request_id: 'r1', group_id: 'g1', state: 'pending' })];
  renderPanel();

  await user.click(screen.getByRole('button', { name: 'Reject' }));
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  await user.type(screen.getByPlaceholderText('Reason (optional)'), '  not needed  ');
  await user.click(screen.getByRole('button', { name: 'Confirm reject' }));

  expect(api.rejectMembershipRequest).toHaveBeenCalledWith('r1', 'not needed');
  expect(ctx.refresh).toHaveBeenCalled();
});

it('Cancel on the reject note restores Approve/Reject without calling the API', async () => {
  const user = userEvent.setup();
  ctx.items = [requestItem('n1', { request_id: 'r1', group_id: 'g1', state: 'pending' })];
  renderPanel();

  await user.click(screen.getByRole('button', { name: 'Reject' }));
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  expect(api.rejectMembershipRequest).not.toHaveBeenCalled();
});

it('a decided membership_request row shows the outcome line and no buttons', () => {
  ctx.items = [requestItem('n1', { request_id: 'r1', group_id: 'g1', state: 'approved', decided_by: 'Ada' })];
  renderPanel();
  expect(screen.getByText('Approved by Ada')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
});

it('a report_ready row renders no membership strip', () => {
  ctx.items = [item('a')];
  renderPanel();
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(document.querySelector('.notif-strip')).toBeNull();
  expect(document.querySelector('.notif-outcome')).toBeNull();
});
