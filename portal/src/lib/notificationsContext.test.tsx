// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Inbox } from './api';

const api = vi.hoisted(() => ({
  listInbox: vi.fn(), markInboxRead: vi.fn(), markAllInboxRead: vi.fn(),
  markInboxUnread: vi.fn(), hideInboxItem: vi.fn(), clearReadInbox: vi.fn(),
}));
vi.mock('./api', async (importActual) => ({ ...(await importActual<typeof import('./api')>()), ...api }));
const sounds = vi.hoisted(() => ({ playNotificationSound: vi.fn(() => true), installAudioUnlock: vi.fn(() => () => {}) }));
vi.mock('./notificationSounds', () => sounds);
const auth = vi.hoisted(() => ({
  person: { id: 'p1' } as { id: string } | null,
  preferences: { notif: { critical: true, email: true, maint: true, digest: false, sound: 'ping' } },
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => auth }));

const { NotificationsProvider, useNotifications, INBOX_POLL_MS } = await import('./notificationsContext');

const inbox = (items: Inbox['items']): Inbox =>
  ({ unread_count: items.filter((i) => !i.read_at).length, items });
const item = (id: string, read = false) => ({
  id, kind: 'report_ready', title: `T${id}`, body: '', link: '/reports', payload: {},
  created_at: '2026-09-09T12:00:00Z', read_at: read ? '2026-09-09T12:01:00Z' : null,
});

function Probe() {
  const n = useNotifications();
  return <div>unread:{n.unreadCount} new:{n.newItems.map((i) => i.id).join(',')}
    <button onClick={() => void n.markRead('a')}>read-a</button>
    <button onClick={() => void n.markUnread('a')}>unread-a</button>
    <button onClick={() => void n.hide('a')}>hide-a</button>
    <button onClick={() => void n.clearRead()}>clear</button></div>;
}

beforeEach(() => {
  api.listInbox.mockResolvedValue(inbox([item('a')]));
  api.markInboxRead.mockResolvedValue(undefined);
  api.markInboxUnread.mockResolvedValue(undefined);
  api.hideInboxItem.mockResolvedValue(undefined);
  api.clearReadInbox.mockResolvedValue(undefined);
  auth.person = { id: 'p1' };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

it('polls on mount, exposes the unread count, and flags only items that appear AFTER the first poll as new', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<NotificationsProvider><Probe /></NotificationsProvider>);
  await screen.findByText('unread:1 new:');                       // first poll: nothing "new"
  api.listInbox.mockResolvedValue(inbox([item('b'), item('a')]));
  await act(async () => { await vi.advanceTimersByTimeAsync(INBOX_POLL_MS + 50); });
  await screen.findByText('unread:2 new:b');
});

it('markRead calls the API and drops the count', async () => {
  render(<NotificationsProvider><Probe /></NotificationsProvider>);
  await screen.findByText('unread:1 new:');
  api.listInbox.mockResolvedValue(inbox([item('a', true)]));
  await act(async () => { screen.getByText('read-a').click(); });
  await waitFor(() => expect(api.markInboxRead).toHaveBeenCalledWith('a'));
  await screen.findByText('unread:0 new:');
});

it('resets provider state on identity change so the next person\'s first poll starts clean', async () => {
  const { rerender } = render(<NotificationsProvider><Probe /></NotificationsProvider>);
  await screen.findByText('unread:1 new:');

  // sign-out: person goes to null — state should reset immediately
  auth.person = null;
  rerender(<NotificationsProvider><Probe /></NotificationsProvider>);
  await screen.findByText('unread:0 new:');

  // sign-in as a different person: first poll should NOT flag existing
  // unread items as "new" (the seen sentinel must have been reset)
  api.listInbox.mockResolvedValue(inbox([item('x'), item('y')]));
  auth.person = { id: 'p2' };
  rerender(<NotificationsProvider><Probe /></NotificationsProvider>);
  await screen.findByText('unread:2 new:');
});

it('markUnread does not bump the count for an item that is already unread (symmetric guard)', async () => {
  let resolveMark!: () => void;
  const pending = new Promise<void>((res) => { resolveMark = res; });
  api.markInboxUnread.mockReturnValue(pending);
  api.listInbox.mockResolvedValue(inbox([item('a')]));          // 'a' unread throughout
  render(<NotificationsProvider><Probe /></NotificationsProvider>);
  await screen.findByText('unread:1 new:');
  await act(async () => { screen.getByText('unread-a').click(); });
  // markInboxUnread is still pending, so refresh() has not run yet — this
  // is purely the optimistic step, which must not touch an already-unread item.
  expect(screen.getByText(/unread:1/)).toBeTruthy();
  await act(async () => { resolveMark(); await pending; });
  await waitFor(() => expect(api.listInbox).toHaveBeenCalledTimes(2));   // refresh after resolve
  expect(screen.getByText(/unread:1/)).toBeTruthy();
});

it('markUnread, hide and clearRead call the API optimistically and refresh', async () => {
  api.listInbox.mockResolvedValue(inbox([item('a', true), item('b')]));
  render(<NotificationsProvider><Probe /></NotificationsProvider>);
  await screen.findByText('unread:1 new:');
  await act(async () => { screen.getByText('unread-a').click(); });
  await waitFor(() => expect(api.markInboxUnread).toHaveBeenCalledWith('a'));
  await act(async () => { screen.getByText('hide-a').click(); });
  await waitFor(() => expect(api.hideInboxItem).toHaveBeenCalledWith('a'));
  await act(async () => { screen.getByText('clear').click(); });
  await waitFor(() => expect(api.clearReadInbox).toHaveBeenCalled());
  expect(api.listInbox.mock.calls.length).toBeGreaterThanOrEqual(4);   // refresh after each
});

it('plays the chosen sound only when NEW items arrive after the first poll', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<NotificationsProvider><Probe /></NotificationsProvider>);
  await screen.findByText('unread:1 new:');
  expect(sounds.playNotificationSound).not.toHaveBeenCalled();      // first poll is silent
  api.listInbox.mockResolvedValue(inbox([item('b'), item('a')]));
  await act(async () => { await vi.advanceTimersByTimeAsync(INBOX_POLL_MS + 50); });
  await screen.findByText('unread:2 new:b');
  expect(sounds.playNotificationSound).toHaveBeenCalledTimes(1);
  expect(sounds.playNotificationSound).toHaveBeenCalledWith('ping');
  await act(async () => { await vi.advanceTimersByTimeAsync(INBOX_POLL_MS + 50); });
  expect(sounds.playNotificationSound).toHaveBeenCalledTimes(1);    // same items again: no replay
});
