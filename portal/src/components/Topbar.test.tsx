// @vitest-environment jsdom
/**
 * Topbar AI-button gating: the button (and its popover) render only for a
 * caller with ai:view — same mechanism as ProtectedRoute's can() gate.
 * A caller without the grant would otherwise hit a 403 that AiAssistant's
 * error branch shows as "Something went wrong — try again."; hiding the
 * button entirely is the honest behavior.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action?: string) => boolean } = {
    can: () => true,
  };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can }),
}));

vi.mock('../lib/api', () => ({
  apiFetch: vi.fn(() => new Promise(() => {})),
  listInbox: vi.fn(() => Promise.resolve({ unread_count: 0, items: [] })),
}));

// The bell reads the shared inbox provider; the provider itself is covered
// by lib/notificationsContext.test.tsx.
const bell = vi.hoisted(() => ({
  unreadCount: 0, items: [] as unknown[], markRead: vi.fn(), markAllRead: vi.fn(),
  markUnread: vi.fn(), hide: vi.fn(), clearRead: vi.fn(),
  refresh: vi.fn(), newItems: [], dismissNew: vi.fn(),
}));
vi.mock('../lib/notificationsContext', () => ({ useNotifications: () => bell }));

vi.mock('./AiAssistant', () => ({
  default: () => <div>AI PANEL</div>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.can = () => true;
  bell.unreadCount = 0;
  bell.items = [];
});

function renderTopbar() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Topbar />
    </MemoryRouter>,
  );
}

const { TopbarProvider } = await import('../lib/topbar');
const { default: TopbarInner } = await import('./Topbar');

function Topbar() {
  return (
    <TopbarProvider>
      <TopbarInner />
    </TopbarProvider>
  );
}

it('hides the AI button for a caller without ai:view', () => {
  auth.can = () => false;
  renderTopbar();
  expect(screen.queryByTitle('AI assistant')).toBeNull();
});

it('shows the AI button for a caller with ai:view', () => {
  auth.can = (resource) => resource === 'ai';
  renderTopbar();
  expect(screen.getByRole('button', { name: 'AI assistant' })).toBeDefined();
});

it('bell shows the unread badge and lists items; clicking one marks it read', async () => {
  bell.unreadCount = 2;
  bell.items = [{ id: 'n1', kind: 'report_ready', title: 'Move Report is ready', body: 'NAP11',
    link: '/reports?tab=history&run=r1', payload: { run_id: 'r1' }, created_at: '2026-09-09T12:00:00Z', read_at: null }];
  const user = userEvent.setup();
  renderTopbar();
  expect(screen.getByText('2')).toBeTruthy();                       // badge
  await user.click(screen.getByRole('button', { name: /^Notifications/ }));
  expect(screen.getByRole('listitem')).toBeTruthy();                 // the panel's row
  await user.click(screen.getByText('Move Report is ready'));
  expect(bell.markRead).toHaveBeenCalledWith('n1');
  await user.click(screen.getByRole('button', { name: /^Notifications/ }));
  await user.click(screen.getByText('Mark all read'));
  expect(bell.markAllRead).toHaveBeenCalled();
});
