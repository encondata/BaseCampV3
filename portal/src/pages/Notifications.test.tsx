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

import type { MembershipRequest, NotificationGroup, UiPreferences } from '../lib/api';

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
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: true, sound: 'chime' },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  listNotificationGroups: vi.fn(),
  createNotificationGroup: vi.fn(),
  listMembershipRequests: vi.fn(),
  approveMembershipRequest: vi.fn(),
  rejectMembershipRequest: vi.fn(),
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

const REQUESTS: MembershipRequest[] = [
  {
    id: 'r1', group_id: 'g1', group_name: 'Ops Alerts', person_id: 'p1', person_name: 'Alice Ng',
    action: 'join', status: 'pending', note: 'please add me', decided_by_name: null, decided_at: null,
    decision_note: '', created_at: '2026-09-10T00:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.listNotificationGroups.mockResolvedValue(GROUPS);
  api.listMembershipRequests.mockResolvedValue([]);
  api.approveMembershipRequest.mockResolvedValue(REQUESTS[0]);
  api.rejectMembershipRequest.mockResolvedValue(REQUESTS[0]);
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

it('renders the Pending requests panel from the mocked list, hidden when empty', async () => {
  render(<Notifications />);
  await screen.findByText('Ops Alerts');
  expect(screen.queryByText('Pending requests')).toBeNull();

  cleanup();
  api.listMembershipRequests.mockResolvedValue(REQUESTS);
  render(<Notifications />);
  expect(await screen.findByText('Pending requests')).not.toBeNull();
  expect(screen.getByText('Alice Ng')).not.toBeNull();
  expect(screen.getByText('Join')).not.toBeNull();
  expect(screen.getByText('please add me')).not.toBeNull();
});

it('Approve calls the API and the row disappears after refetch', async () => {
  const user = userEvent.setup();
  api.listMembershipRequests.mockResolvedValue(REQUESTS);
  render(<Notifications />);
  await screen.findByText('Pending requests');

  api.listMembershipRequests.mockResolvedValue([]);
  // Approve lives in the row's RowActionsMenu now; the open menu is
  // portaled to document.body, so the item is queried via `screen`.
  await user.click(screen.getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Approve' }));

  expect(api.approveMembershipRequest).toHaveBeenCalledWith('r1');
  await waitFor(() => expect(screen.queryByText('Pending requests')).toBeNull());
});

it('a request row folds Approve and Reject into one Actions menu', async () => {
  const user = userEvent.setup();
  api.listMembershipRequests.mockResolvedValue(REQUESTS);
  render(<Notifications />);
  await screen.findByText('Pending requests');

  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();

  await user.click(screen.getByRole('button', { name: /actions/i }));

  expect(await screen.findByRole('menuitem', { name: 'Approve' })).not.toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Reject' }).className).toMatch(/danger/);

  // the action column is sized to the trigger, not to a button strip
  const cols = [...document.querySelectorAll<HTMLTableColElement>(
    'table[aria-label="Pending membership requests"] colgroup col')];
  expect(cols.at(-1)?.style.width).toBe('88px');
});

it('Reject reveals an inline note field; confirming sends the note and refetches', async () => {
  const user = userEvent.setup();
  api.listMembershipRequests.mockResolvedValue(REQUESTS);
  render(<Notifications />);
  await screen.findByText('Pending requests');

  await user.click(screen.getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Reject' }));
  await user.type(screen.getByPlaceholderText('Reason (optional)'), 'no room');
  api.listMembershipRequests.mockResolvedValue([]);
  await user.click(screen.getByRole('button', { name: 'Confirm reject' }));

  expect(api.rejectMembershipRequest).toHaveBeenCalledWith('r1', 'no room');
  await waitFor(() => expect(screen.queryByText('Pending requests')).toBeNull());
});

it('Cancel leaves the reject flow and restores the row to its Actions menu', async () => {
  const user = userEvent.setup();
  api.listMembershipRequests.mockResolvedValue(REQUESTS);
  render(<Notifications />);
  await screen.findByText('Pending requests');

  await user.click(screen.getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Reject' }));
  expect(screen.getByPlaceholderText('Reason (optional)')).not.toBeNull();
  expect(screen.queryByRole('button', { name: /actions/i })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(screen.queryByPlaceholderText('Reason (optional)')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Confirm reject' })).toBeNull();
  expect(screen.getByRole('button', { name: /actions/i })).not.toBeNull();
  expect(api.rejectMembershipRequest).not.toHaveBeenCalled();
});

it('hides the panel without the notifications:change permission even with pending requests', async () => {
  auth.can = () => false;
  api.listMembershipRequests.mockResolvedValue(REQUESTS);
  render(<Notifications />);
  await screen.findByText('Ops Alerts');
  expect(screen.queryByText('Pending requests')).toBeNull();
  expect(api.listMembershipRequests).not.toHaveBeenCalled();
});
