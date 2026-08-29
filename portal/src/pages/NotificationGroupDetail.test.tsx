// @vitest-environment jsdom
/**
 * Notification group detail page — hero (status/pause/edit/delete),
 * Delivery defaults read view, and the Edit settings modal's diff-only
 * PATCH behavior. Mocking style mirrors Notifications.test.tsx (hoisted
 * mocks for react-router-dom / AuthContext / lib/api).
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type NotificationGroupDetail } from '../lib/api';

const state = vi.hoisted(() => ({ groupId: 'g1' }));
const navigate = vi.hoisted(() => vi.fn());

vi.mock('react-router-dom', async (importActual) => ({
  ...(await importActual<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
  useParams: () => ({ groupId: state.groupId }),
}));

const auth = vi.hoisted(() => {
  const s: { can: (resource: string, action: string) => boolean } = { can: () => true };
  return s;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can }),
}));

const api = vi.hoisted(() => ({
  getNotificationGroup: vi.fn(),
  updateNotificationGroup: vi.fn(),
  deleteNotificationGroup: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const BASE: NotificationGroupDetail = {
  id: 'g1',
  name: 'Ops Alerts',
  description: 'Operational issues',
  channels: ['email', 'push'],
  quiet_start: '21:00:00',
  quiet_end: '07:00:00',
  timezone: 'America/Chicago',
  active_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  dnd_behavior: 'defer',
  urgent_bypass: true,
  enabled: true,
  member_count: 5,
  created_at: '2026-01-01T00:00:00Z',
  members: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  state.groupId = 'g1';
  api.getNotificationGroup.mockResolvedValue(BASE);
});

afterEach(cleanup);

const { default: NotificationGroupDetailPage } = await import('./NotificationGroupDetail');

function renderPage() {
  return render(<MemoryRouter><NotificationGroupDetailPage /></MemoryRouter>);
}

it('renders the hero and delivery defaults from the mocked detail payload', async () => {
  renderPage();

  expect(await screen.findByText('Ops Alerts')).not.toBeNull();
  expect(screen.getByText('Operational issues')).not.toBeNull();
  expect(screen.getByText('Enabled')).not.toBeNull();
  expect(screen.getByText('9:00 PM – 7:00 AM CT')).not.toBeNull();
  expect(screen.getByText('America/Chicago')).not.toBeNull();
  expect(screen.getByText('Mon–Fri')).not.toBeNull();
  expect(screen.getByText('Defer until window opens')).not.toBeNull();
  expect(screen.getByText('Urgent notifications ignore quiet hours')).not.toBeNull();
});

it('shows a Paused chip when the group is disabled', async () => {
  api.getNotificationGroup.mockResolvedValue({ ...BASE, enabled: false });
  renderPage();

  expect(await screen.findByText('Paused')).not.toBeNull();
  expect(screen.getByRole('button', { name: /^resume$/i })).not.toBeNull();
});

it('shows a not-found empty state with a back link for a missing group', async () => {
  api.getNotificationGroup.mockRejectedValue(new ApiError(404, 'not_found'));
  renderPage();

  expect(await screen.findByText('Group not found')).not.toBeNull();
  expect(screen.getByRole('link', { name: /notifications/i }).getAttribute('href'))
    .toBe('/system/notifications');
});

it('pauses an enabled group via PATCH and reloads', async () => {
  const user = userEvent.setup();
  api.updateNotificationGroup.mockResolvedValue({ ...BASE, enabled: false });
  renderPage();
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('button', { name: /^pause$/i }));

  await waitFor(() => expect(api.updateNotificationGroup)
    .toHaveBeenCalledWith('g1', { enabled: false }));
  expect(api.getNotificationGroup).toHaveBeenCalledTimes(2);
});

it('hides change/delete actions without permission', async () => {
  auth.can = () => false;
  renderPage();
  await screen.findByText('Ops Alerts');

  expect(screen.queryByRole('button', { name: /^pause$/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /^edit$/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /^delete$/i })).toBeNull();
});

it('edit group modal pre-fills and PATCHes only the changed field', async () => {
  const user = userEvent.setup();
  api.updateNotificationGroup.mockResolvedValue({ ...BASE, name: 'Ops Alerts v2' });
  renderPage();
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('button', { name: /^edit$/i }));
  const nameInput = await screen.findByDisplayValue('Ops Alerts');
  await user.clear(nameInput);
  await user.type(nameInput, 'Ops Alerts v2');
  await user.click(screen.getByRole('button', { name: /save/i }));

  await waitFor(() => expect(api.updateNotificationGroup)
    .toHaveBeenCalledWith('g1', { name: 'Ops Alerts v2' }));
});

it('maps a 409 group_exists error on the edit group modal', async () => {
  const user = userEvent.setup();
  api.updateNotificationGroup.mockRejectedValue(new ApiError(409, 'group_exists'));
  renderPage();
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('button', { name: /^edit$/i }));
  const nameInput = await screen.findByDisplayValue('Ops Alerts');
  await user.clear(nameInput);
  await user.type(nameInput, 'Weekend Oncall');
  await user.click(screen.getByRole('button', { name: /save/i }));

  expect(await screen.findByText(/already exists/i)).not.toBeNull();
});

it('delete requires a second click, then navigates to the list on success', async () => {
  const user = userEvent.setup();
  api.deleteNotificationGroup.mockResolvedValue(undefined);
  renderPage();
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('button', { name: /^delete$/i }));
  expect(api.deleteNotificationGroup).not.toHaveBeenCalled();
  const confirmBtn = await screen.findByRole('button', { name: /really delete/i });

  await user.click(confirmBtn);

  await waitFor(() => expect(api.deleteNotificationGroup).toHaveBeenCalledWith('g1'));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/system/notifications'));
});

async function openSettingsDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /edit settings/i }));
  const heading = await screen.findByRole('heading', { name: /edit settings/i });
  return heading.closest('.modal-card') as HTMLElement;
}

it('settings modal opens with current values and PATCHes only changed fields', async () => {
  const user = userEvent.setup();
  api.updateNotificationGroup.mockResolvedValue(BASE);
  renderPage();
  await screen.findByText('Ops Alerts');

  const dialog = await openSettingsDialog(user);

  // Turn the Push channel off — the only field that should change.
  const pushSwitch = within(dialog).getByRole('checkbox', { name: /push/i });
  await user.click(pushSwitch);
  await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

  await waitFor(() => expect(api.updateNotificationGroup)
    .toHaveBeenCalledWith('g1', { channels: ['email'] }));
});

it('requires at least one active day before saving settings', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Ops Alerts');

  const dialog = await openSettingsDialog(user);

  for (const label of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
    await user.click(within(dialog).getByRole('button', { name: label }));
  }
  await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

  expect(await within(dialog).findByText(/pick at least one active day/i)).not.toBeNull();
  expect(api.updateNotificationGroup).not.toHaveBeenCalled();
});

it('maps a server 422 invalid_quiet_hours error on settings save', async () => {
  const user = userEvent.setup();
  api.updateNotificationGroup.mockRejectedValue(new ApiError(422, 'invalid_quiet_hours'));
  renderPage();
  await screen.findByText('Ops Alerts');

  const dialog = await openSettingsDialog(user);
  const startInput = within(dialog).getByLabelText(/start/i);
  await user.clear(startInput);
  await user.type(startInput, '10:00');
  await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

  expect(await within(dialog).findByText(/need both a start and an end/i)).not.toBeNull();
});

it('closes the settings modal and reloads the group on a successful save', async () => {
  const user = userEvent.setup();
  api.updateNotificationGroup.mockResolvedValue(BASE);
  renderPage();
  await screen.findByText('Ops Alerts');

  const dialog = await openSettingsDialog(user);
  await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

  await waitFor(() => expect(api.getNotificationGroup).toHaveBeenCalledTimes(2));
  expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
});
