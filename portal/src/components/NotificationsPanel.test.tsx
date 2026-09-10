// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { InboxItem } from '../lib/api';

const ctx = vi.hoisted(() => ({
  unreadCount: 0, items: [] as InboxItem[], newItems: [] as InboxItem[],
  refresh: vi.fn(), markRead: vi.fn(() => Promise.resolve()), markUnread: vi.fn(() => Promise.resolve()),
  markAllRead: vi.fn(() => Promise.resolve()), hide: vi.fn(() => Promise.resolve()),
  clearRead: vi.fn(() => Promise.resolve()), dismissNew: vi.fn(), toast: vi.fn(),
  localToasts: [], dismissLocal: vi.fn(),
}));
vi.mock('../lib/notificationsContext', () => ({ useNotifications: () => ctx }));

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
