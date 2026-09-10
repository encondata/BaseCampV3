// @vitest-environment jsdom
/**
 * Notification groups list page — the directory-pattern list (model:
 * AssetModels.tsx). Covers what a unit test can see that the pure
 * lib/notifications.ts helpers can't: wiring of load/search/permission
 * gating and the navigate-on-row-click contract (no inline expansion).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { NotificationGroup, UiPreferences } from '../lib/api';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action: string) => boolean } = {
    can: () => true,
  };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true,
      notif: { critical: true, email: true, maint: true, digest: true },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  listNotificationGroups: vi.fn(),
  createNotificationGroup: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const GROUPS: NotificationGroup[] = [
  {
    id: 'g1', name: 'Ops Alerts', description: 'Operational issues',
    channels: ['email', 'push'], quiet_start: '21:00:00', quiet_end: '07:00:00',
    timezone: 'America/Chicago', active_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    dnd_behavior: 'defer', urgent_bypass: true, enabled: true, member_count: 5,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'g2', name: 'Weekend Oncall', description: '',
    channels: [], quiet_start: null, quiet_end: null,
    timezone: 'America/New_York', active_days: ['sat', 'sun'],
    dnd_behavior: 'skip', urgent_bypass: false, enabled: false, member_count: 0,
    created_at: '2026-02-01T00:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.listNotificationGroups.mockResolvedValue(GROUPS);
});

afterEach(cleanup);

const { default: Notifications } = await import('./Notifications');

it('renders rows from the loaded groups', async () => {
  render(<Notifications />);
  expect(await screen.findByText('Ops Alerts')).not.toBeNull();
  expect(screen.getByText('Weekend Oncall')).not.toBeNull();
});

it('filters rows via the search box', async () => {
  const user = userEvent.setup();
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  await user.type(screen.getByPlaceholderText('Filter this list…'), 'Ops');

  expect(screen.getByText('Ops Alerts')).not.toBeNull();
  expect(screen.queryByText('Weekend Oncall')).toBeNull();
});

it('shows a Paused chip for a disabled group and Enabled for an active one', async () => {
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  expect(screen.getByText('Paused')).not.toBeNull();
  expect(screen.getByText('Enabled')).not.toBeNull();
});

it('hides the New group button without the add permission', async () => {
  auth.can = () => false;
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  expect(screen.queryByRole('button', { name: /New group/i })).toBeNull();
});

it('shows the New group button with the add permission', async () => {
  auth.can = () => true;
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  expect(screen.getByRole('button', { name: /New group/i })).not.toBeNull();
});

it('navigates to the group detail page on row click, with no inline expansion', async () => {
  const user = userEvent.setup();
  render(<Notifications />);
  const row = await screen.findByText('Ops Alerts');

  await user.click(row);

  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/system/notifications/g1'));
});

it('shows the empty state when there are no groups', async () => {
  api.listNotificationGroups.mockResolvedValue([]);
  render(<Notifications />);
  expect(await screen.findByText('No notification groups yet')).not.toBeNull();
});
