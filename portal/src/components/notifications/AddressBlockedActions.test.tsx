// @vitest-environment jsdom
/** End to end through the real provider: the toast and the bell's row
 *  both read the block's state from the inbox poll. */
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { Inbox, InboxItem } from '../../lib/api';

const api = vi.hoisted(() => ({
  listInbox: vi.fn(), markInboxRead: vi.fn(() => Promise.resolve()),
  clearAddressBlock: vi.fn(), blockAddressPermanently: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../../lib/api')>()), ...api }));
vi.mock('../../lib/notificationSounds', () => ({ playNotificationSound: vi.fn(), installAudioUnlock: vi.fn(() => () => {}) }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ person: { id: 'p1' }, preferences: null }) }));

const { NotificationsProvider, INBOX_POLL_MS } = await import('../../lib/notificationsContext');
const { default: ToastHost } = await import('../ToastHost');
const { default: NotificationsPanel } = await import('../NotificationsPanel');
const { addressBlockOpen } = await import('./AddressBlockedActions');

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

const blocked = (payload: Record<string, unknown> = {}, read_at: string | null = null): InboxItem => ({
  id: 'b1', kind: 'address_blocked', category: 'security', body: '', link: '/system/blocked-addresses',
  title: 'Sign-ins blocked from 203.0.113.7 for 1 hour (10 failed attempts)',
  created_at: new Date().toISOString(), read_at,
  payload: { address: '203.0.113.7', level: 1, ends_at: new Date(Date.now() + 3_600_000).toISOString(),
    failure_count: 10, state: 'open', ...payload },
});
const inbox = (items: InboxItem[]): Inbox =>
  ({ unread_count: items.filter((i) => !i.read_at).length, items, next_cursor: null, total: items.length });

it('another admin clearing the block takes the toast away and the row reads Cleared by them', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  api.listInbox.mockResolvedValue(inbox([blocked()]));
  render(
    <MemoryRouter>
      <NotificationsProvider><ToastHost /><NotificationsPanel onClose={() => {}} /></NotificationsProvider>
    </MemoryRouter>,
  );
  // first poll after sign-in: the open block toasts, and the row has its buttons too
  expect(await screen.findByRole('status')).toBeTruthy();
  expect(screen.getAllByRole('button', { name: 'Clear block' })).toHaveLength(2);

  api.listInbox.mockResolvedValue(inbox([blocked({ state: 'cleared', decided_by: 'Ada Admin' }, new Date().toISOString())]));
  await act(async () => { await vi.advanceTimersByTimeAsync(INBOX_POLL_MS + 50); });
  expect(screen.queryByRole('status')).toBeNull();
  expect(screen.getByText('Cleared by Ada Admin')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Clear block' })).toBeNull();
});

it('addressBlockOpen: open and timed in the future, or open and permanent; nothing else', () => {
  const now = Date.parse('2026-11-10T12:00:00Z');
  const at = (ends_at: string | null, state = 'open') => blocked({ ends_at, state });
  expect(addressBlockOpen(at('2026-11-10T13:00:00Z'), now)).toBe(true);
  expect(addressBlockOpen(at(null), now)).toBe(true);
  expect(addressBlockOpen(at('2026-11-10T11:59:59Z'), now)).toBe(false);
  expect(addressBlockOpen(at(null, 'cleared'), now)).toBe(false);
  expect(addressBlockOpen(at(null, 'permanent'), now)).toBe(false);
  expect(addressBlockOpen({ ...at(null), kind: 'report_ready' }, now)).toBe(false);
});
