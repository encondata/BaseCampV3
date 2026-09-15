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

import {
  ApiError, type NotificationGroupDetail, type NotificationMember, type NotificationRecipient,
} from '../lib/api';

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
  addNotificationMember: vi.fn(),
  updateNotificationMember: vi.fn(),
  removeNotificationMember: vi.fn(),
  listNotificationRecipients: vi.fn(),
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

// Alice: no override (inherits the group's channels), but can't actually
// receive Text (no phone on file) — exercises the unreachable-channel
// warning chip.
const MEMBER_1: NotificationMember = {
  person_id: 'p1',
  display_name: 'Alice Tech',
  job_title: 'Technician',
  avatar_url: null,
  email: 'alice@example.com',
  phone: null,
  has_account: true,
  can_email: true,
  can_text: false,
  can_push: true,
  can_web: true,
  overrides: {
    channels: null, quiet_mode: null, quiet_start: null, quiet_end: null,
    timezone: null, active_days: null, dnd_behavior: null, urgent_bypass: null,
  },
  effective: {
    channels: ['email', 'text'],
    quiet_start: '21:00:00', quiet_end: '07:00:00', timezone: 'America/Chicago',
    active_days: ['mon', 'tue', 'wed', 'thu', 'fri'], dnd_behavior: 'defer', urgent_bypass: true,
  },
  added_at: '2026-01-02T00:00:00Z',
};

// Bob: fully reachable, but has a channel override restricting him to
// email only — exercises the Override marker + reset-to-inherit.
const MEMBER_2: NotificationMember = {
  person_id: 'p2',
  display_name: 'Bob Override',
  job_title: null,
  avatar_url: null,
  email: 'bob@example.com',
  phone: '555-1212',
  has_account: true,
  can_email: true,
  can_text: true,
  can_push: true,
  can_web: true,
  overrides: {
    channels: ['email'], quiet_mode: null, quiet_start: null, quiet_end: null,
    timezone: null, active_days: null, dnd_behavior: null, urgent_bypass: null,
  },
  effective: {
    channels: ['email'],
    quiet_start: '21:00:00', quiet_end: '07:00:00', timezone: 'America/Chicago',
    active_days: ['mon', 'tue', 'wed', 'thu', 'fri'], dnd_behavior: 'defer', urgent_bypass: true,
  },
  added_at: '2026-01-03T00:00:00Z',
};

const RECIPIENTS: NotificationRecipient[] = [
  {
    person_id: 'p1', display_name: 'Alice Tech', job_title: 'Technician', avatar_url: null,
    email: 'alice@example.com', phone: null, has_account: true,
    can_email: true, can_text: false, can_push: true, can_web: true,
  },
  {
    person_id: 'p3', display_name: 'Carol New', job_title: 'Coordinator', avatar_url: null,
    email: 'carol@example.com', phone: '555-2222', has_account: true,
    can_email: true, can_text: true, can_push: true, can_web: true,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  state.groupId = 'g1';
  api.getNotificationGroup.mockResolvedValue(BASE);
  api.listNotificationRecipients.mockResolvedValue([]);
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

// ── Members panel (Task 5) ──────────────────────────────────────────

it('members table renders effective channel chips, a warning on an unreachable channel, and an Override marker', async () => {
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1, MEMBER_2] });
  renderPage();
  await screen.findByText('Ops Alerts');

  await screen.findByText('Alice Tech');
  const textChip = screen.getByText('Text (SMS)');
  expect(textChip.title).toBe('No phone number');
  expect(textChip.className).toContain('c-red');

  // Alice has no override on channels; Bob's channel override should
  // surface an "Override" marker.
  expect(screen.getAllByText('Override').length).toBeGreaterThan(0);
});

it('excludes current members from the add-member recipients combo', async () => {
  const user = userEvent.setup();
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  api.listNotificationRecipients.mockResolvedValue(RECIPIENTS);
  renderPage();
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByPlaceholderText(/add a member/i));

  expect(await screen.findByText('Carol New')).not.toBeNull();
  // Alice already appears once (in the members table) — the combo must
  // not add a second occurrence for a person already in the group.
  expect(screen.getAllByText('Alice Tech')).toHaveLength(1);
});

it('override modal shows switch rows only for channels the member can receive', async () => {
  const user = userEvent.setup();
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  renderPage();
  await screen.findByText('Ops Alerts');

  await openRowMenu(user, /alice tech/i);
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

  const heading = await screen.findByRole('heading', { name: /overrides — alice tech/i });
  const dialog = heading.closest('.modal-card') as HTMLElement;

  await user.selectOptions(within(dialog).getByLabelText('Channels'), 'custom');

  expect(within(dialog).getByRole('checkbox', { name: /^email$/i })).not.toBeNull();
  expect(within(dialog).getByRole('checkbox', { name: /^push$/i })).not.toBeNull();
  expect(within(dialog).getByRole('checkbox', { name: /^web$/i })).not.toBeNull();
  // Alice has no phone on file — Text must not offer a switch row.
  expect(within(dialog).queryByRole('checkbox', { name: /text/i })).toBeNull();
});

it('resetting a channel override to inherit sends an explicit null', async () => {
  const user = userEvent.setup();
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_2] });
  api.updateNotificationMember.mockResolvedValue(MEMBER_2);
  renderPage();
  await screen.findByText('Ops Alerts');

  await openRowMenu(user, /bob override/i);
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

  const heading = await screen.findByRole('heading', { name: /overrides — bob override/i });
  const dialog = heading.closest('.modal-card') as HTMLElement;

  await user.selectOptions(within(dialog).getByLabelText('Channels'), 'default');
  await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p2', { channels: null }));
});

it('retries the recipients fetch after a failed attempt on reopen', async () => {
  const user = userEvent.setup();
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [] });
  api.listNotificationRecipients
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValueOnce(RECIPIENTS);
  renderPage();
  await screen.findByText('Ops Alerts');

  const input = screen.getByPlaceholderText(/add a member/i);
  await user.click(input);

  expect(await screen.findByText('Could not load the recipient list.')).not.toBeNull();
  expect(api.listNotificationRecipients).toHaveBeenCalledTimes(1);

  // Close (outside click) then reopen/refocus — should retry the fetch
  // rather than dead-ending on the first failure.
  await user.click(document.body);
  await user.click(input);

  expect(await screen.findByText('Carol New')).not.toBeNull();
  expect(api.listNotificationRecipients).toHaveBeenCalledTimes(2);
});

it('drops a stale unreachable channel from a custom override when saving', async () => {
  const user = userEvent.setup();
  const member: NotificationMember = {
    ...MEMBER_1,
    person_id: 'p4',
    display_name: 'Dana Stale',
    overrides: { ...MEMBER_1.overrides, channels: ['email', 'text'] },
    effective: { ...MEMBER_1.effective, channels: ['email'] },
  };
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [member] });
  api.updateNotificationMember.mockResolvedValue(member);
  renderPage();
  await screen.findByText('Ops Alerts');

  await openRowMenu(user, /dana stale/i);
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

  const heading = await screen.findByRole('heading', { name: /overrides — dana stale/i });
  const dialog = heading.closest('.modal-card') as HTMLElement;

  // Channels mode is already Custom (overrides.channels is non-null) —
  // Alice/Dana has no phone on file, so Text must not offer a switch row
  // even though the stored override still lists it.
  expect(within(dialog).getByRole('checkbox', { name: /^email$/i })).not.toBeNull();
  expect(within(dialog).queryByRole('checkbox', { name: /text/i })).toBeNull();

  await user.click(within(dialog).getByRole('button', { name: /^save$/i }));

  await waitFor(() => expect(api.updateNotificationMember)
    .toHaveBeenCalledWith('g1', 'p4', { channels: ['email'] }));
});

// ── Members panel row actions (Task 3) ──────────────────────────────

/** Open one member row's Actions menu. Items are then queried via
 *  `screen`, NOT `within(row)`: RowActionsMenu portals the open menu to
 *  document.body (see RowActionsMenu.tsx and the note at
 *  KioskDevices.test.tsx:178), so they no longer sit in the row's DOM
 *  subtree. Only one menu is open at a time, so screen-level queries
 *  stay unambiguous. */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  const row = screen.getByRole('row', { name });
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  return row;
}

it('member row: one Actions trigger replaces the inline Edit/Remove buttons', async () => {
  const user = userEvent.setup();
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  renderPage();
  await screen.findByText('Ops Alerts');

  const row = screen.getByRole('row', { name: /alice tech/i });
  expect(within(row).queryByRole('button', { name: /^edit$/i })).toBeNull();
  expect(within(row).queryByRole('button', { name: /^remove$/i })).toBeNull();

  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Edit' })).not.toBeNull();
  const remove = screen.getByRole('menuitem', { name: 'Remove' });
  expect(remove.className).toContain('danger');
});

it('member row: Remove confirms through confirm() and never reflows the row', async () => {
  const user = userEvent.setup();
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  api.removeNotificationMember.mockResolvedValue(undefined);
  renderPage();
  await screen.findByText('Ops Alerts');

  const row = screen.getByRole('row', { name: /alice tech/i });
  const actionCell = row.querySelectorAll('td')[5] as HTMLElement;
  const before = actionCell.innerHTML;

  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

  expect(confirmSpy).toHaveBeenCalled();
  expect(api.removeNotificationMember).not.toHaveBeenCalled();
  // The old inline confirm swapped the cell into Edit + "Really remove?" +
  // Cancel, which is the only reason the column was 250px wide. The menu
  // path must leave the cell's markup byte-identical.
  expect(actionCell.innerHTML).toBe(before);
  expect(screen.queryByRole('button', { name: /really remove/i })).toBeNull();
  expect(screen.queryByRole('button', { name: /^cancel$/i })).toBeNull();

  confirmSpy.mockReturnValue(true);
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

  await waitFor(() => expect(api.removeNotificationMember).toHaveBeenCalledWith('g1', 'p1'));
  confirmSpy.mockRestore();
});

it('member row: the actions column is sized to the trigger, not to an inline confirm', async () => {
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  const { container } = renderPage();
  await screen.findByText('Alice Tech');

  const cols = container.querySelectorAll('.ngd-members-table col');
  expect((cols[cols.length - 1] as HTMLElement).style.width).toBe('88px');
});

it('member row: menu items are disabled, not dropped, while the row is in flight', async () => {
  const user = userEvent.setup();
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  api.removeNotificationMember.mockReturnValue(new Promise(() => {}));
  renderPage();
  await screen.findByText('Ops Alerts');

  const row = screen.getByRole('row', { name: /alice tech/i });
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await waitFor(() => {
    expect((screen.getByRole('menuitem', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('menuitem', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true);
  });
  confirmSpy.mockRestore();
});

it('member row: no Actions column at all without change permission', async () => {
  auth.can = () => false;
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  renderPage();
  await screen.findByText('Alice Tech');

  const row = screen.getByRole('row', { name: /alice tech/i });
  expect(within(row).queryByRole('button', { name: /Actions/ })).toBeNull();
  expect(screen.queryByRole('columnheader', { name: /actions/i })).toBeNull();
});
