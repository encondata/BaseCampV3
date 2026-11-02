// @vitest-environment jsdom
/**
 * Notification group detail page — hero (status/pause/edit/delete) and the
 * Members panel with its row menu. A group is a member list: it carries no
 * delivery settings, so the page shows none and a member row has nothing to
 * edit but its place on the list. Mocking style mirrors Notifications.test.tsx
 * (hoisted mocks for react-router-dom / AuthContext / lib/api).
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
  enabled: true,
  member_count: 5,
  created_at: '2026-01-01T00:00:00Z',
  members: [],
};

const MEMBER_1: NotificationMember = {
  person_id: 'p1',
  display_name: 'Alice Tech',
  job_title: 'Technician',
  avatar_url: null,
  email: 'alice@example.com',
  phone: null,
  has_account: true,
  added_at: '2026-01-02T00:00:00Z',
};

const MEMBER_2: NotificationMember = {
  person_id: 'p2',
  display_name: 'Bob Mason',
  job_title: null,
  avatar_url: null,
  email: 'bob@example.com',
  phone: '555-1212',
  has_account: true,
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
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
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

// ── the hero ────────────────────────────────────────────────────────

it('the hero keeps the name, status, member count, description and the Pause, Edit and Delete actions', async () => {
  renderPage();

  const title = await screen.findByRole('heading', { name: 'Ops Alerts' });
  expect(screen.getByText('Operational issues').className).toContain('page-hint');
  expect(within(title.closest('.idet-title-row') as HTMLElement).getByText('Enabled').className)
    .toContain('c-green');
  expect(screen.getByText('5 members')).not.toBeNull();
  for (const name of [/^pause$/i, /^edit$/i, /^delete$/i]) {
    expect(screen.getByRole('button', { name })).not.toBeNull();
  }
});

it('group page has no delivery settings', async () => {
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  renderPage();
  await screen.findByText('Alice Tech');

  expect(screen.queryByText('Delivery defaults')).toBeNull();
  expect(screen.queryByRole('button', { name: /edit settings/i })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
  // None of the old panel's rows, and nothing like them in the members table.
  for (const label of [
    'Channels', 'Categories', 'Quiet hours', 'Timezone', 'Active days', 'When blocked', 'Urgent bypass',
  ]) {
    expect(screen.queryByText(label)).toBeNull();
  }
  // The hero carries no channel chips either: only its status and member count.
  const title = screen.getByRole('heading', { name: 'Ops Alerts' });
  const row = title.closest('.idet-title-row') as HTMLElement;
  expect(row.querySelector('.chips')).toBeNull();
  expect([...row.querySelectorAll('.chip')].map((c) => c.textContent)).toEqual(['Enabled', '5 members']);
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

it('edit group modal wears the standard header and closes from Cancel without saving', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('button', { name: /^edit$/i }));
  const dialog = await screen.findByRole('dialog', { name: 'Edit group' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Notification group');
  expect(within(dialog).getByRole('heading', { name: 'Edit group' })).not.toBeNull();
  expect(within(dialog).getByText('Rename the group or change its description.').className)
    .toContain('page-hint');
  expect(within(dialog).getByDisplayValue('Ops Alerts')).not.toBeNull();

  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog', { name: 'Edit group' })).toBeNull();
  expect(api.updateNotificationGroup).not.toHaveBeenCalled();
});

it('edit group modal: the footer Save is the form\'s submit button, so Enter in a field saves', async () => {
  const user = userEvent.setup();
  api.updateNotificationGroup.mockResolvedValue({ ...BASE, name: 'Ops Alerts v2' });
  renderPage();
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('button', { name: /^edit$/i }));
  const nameInput = await screen.findByDisplayValue('Ops Alerts');
  const form = nameInput.closest('form') as HTMLFormElement;
  const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
  // The button lives in the dialog's footer, outside the form; the `form`
  // attribute makes it the form's default button (what Enter presses).
  expect(form.contains(save)).toBe(false);
  expect(save.type).toBe('submit');
  expect(form.id).not.toBe('');
  expect(save.getAttribute('form')).toBe(form.id);

  await user.type(nameInput, ' v2');
  await user.click(save);
  await waitFor(() => expect(api.updateNotificationGroup)
    .toHaveBeenCalledWith('g1', { name: 'Ops Alerts v2' }));
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

// ── the Members panel ───────────────────────────────────────────────

it('members table columns are Person, Contact and Actions', async () => {
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1, MEMBER_2] });
  renderPage();
  await screen.findByText('Alice Tech');

  const table = screen.getByRole('table', { name: 'Members' });
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent))
    .toEqual(['Person', 'Contact', 'Actions']);

  // One cell per column: who they are, how to reach them, the menu.
  const alice = within(table).getByRole('row', { name: /alice tech/i });
  const cells = alice.querySelectorAll('td');
  expect(cells).toHaveLength(3);
  expect(cells[0].textContent).toContain('Alice Tech');
  expect(cells[0].textContent).toContain('Technician');
  expect(cells[1].textContent).toContain('alice@example.com');
  expect(cells[1].textContent).toContain('—');                  // no phone on file
  expect(within(cells[2] as HTMLElement).getByRole('button', { name: /Actions/ })).not.toBeNull();

  // A person with no job title says so with a dash; their phone shows.
  const bob = within(table).getByRole('row', { name: /bob mason/i }).querySelectorAll('td');
  expect(bob[0].textContent).toContain('Bob Mason');
  expect(bob[0].textContent).toContain('—');
  expect(bob[1].textContent).toContain('555-1212');

  // Nothing of the old delivery columns or their markers.
  expect(within(table).queryByText('Override')).toBeNull();
  expect(table.querySelector('.chip')).toBeNull();
});

it('members table columns are Person and Contact without change permission', async () => {
  auth.can = () => false;
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  renderPage();
  await screen.findByText('Alice Tech');

  const table = screen.getByRole('table', { name: 'Members' });
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent))
    .toEqual(['Person', 'Contact']);
  const row = within(table).getByRole('row', { name: /alice tech/i });
  expect(row.querySelectorAll('td')).toHaveLength(2);
  expect(within(row).queryByRole('button', { name: /Actions/ })).toBeNull();
  // and no add-member field
  expect(screen.queryByPlaceholderText(/add a member/i)).toBeNull();
});

it('the members table sits in .ngd-members, the scope of its themed scrollbar: a card too narrow for it scrolls sideways', async () => {
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  const { container } = renderPage();
  await screen.findByText('Alice Tech');

  const scroll = container.querySelector('.ngd-members > .data-table-scroll');
  expect(scroll).toBeTruthy();
  expect(scroll?.querySelector('table[aria-label="Members"]')).toBeTruthy();
});

it('a group with no members says "No members yet."', async () => {
  api.getNotificationGroup.mockResolvedValue({ ...BASE, member_count: 0, members: [] });
  renderPage();

  expect(await screen.findByText('No members yet.')).not.toBeNull();
  expect(screen.queryByText(/add people above/i)).toBeNull();
  expect(screen.queryByRole('table', { name: 'Members' })).toBeNull();
});

it('the add-member picker names a person by job title only, with no channel parts', async () => {
  const user = userEvent.setup();
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [] });
  api.listNotificationRecipients.mockResolvedValue([
    RECIPIENTS[1],
    {
      person_id: 'p7', display_name: 'Dan Nomail', job_title: 'Driver', avatar_url: null,
      email: null, phone: '555-3333', has_account: true,
      can_email: false, can_text: true, can_push: true, can_web: true,
    },
  ]);
  renderPage();
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByPlaceholderText(/add a member/i));

  expect(await screen.findByText('Coordinator')).not.toBeNull();
  expect(screen.getByText('Driver')).not.toBeNull();
  expect(screen.queryByText(/email/i)).toBeNull();
});

it('picking a person adds them to the group and reloads it', async () => {
  const user = userEvent.setup();
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [] });
  api.addNotificationMember.mockResolvedValue({ ...MEMBER_1, person_id: 'p3', display_name: 'Carol New' });
  api.listNotificationRecipients.mockResolvedValue(RECIPIENTS);
  renderPage();
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByPlaceholderText(/add a member/i));
  await user.click(await screen.findByText('Carol New'));

  await waitFor(() => expect(api.addNotificationMember).toHaveBeenCalledWith('g1', 'p3'));
  await waitFor(() => expect(api.getNotificationGroup).toHaveBeenCalledTimes(2));
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

// ── the member row's Actions menu ───────────────────────────────────

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

it('member menu offers Remove only', async () => {
  const user = userEvent.setup();
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  renderPage();
  await screen.findByText('Alice Tech');

  // One Actions trigger, not an inline button.
  const row = screen.getByRole('row', { name: /alice tech/i });
  expect(within(row).queryByRole('button', { name: /^edit$/i })).toBeNull();
  expect(within(row).queryByRole('button', { name: /^remove$/i })).toBeNull();

  await openRowMenu(user, /alice tech/i);

  const items = screen.getAllByRole('menuitem');
  expect(items.map((i) => i.textContent)).toEqual(['Remove']);
  expect(items[0].className).toContain('danger');
  expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
});

it('member row: Remove confirms through confirm() and never reflows the row', async () => {
  const user = userEvent.setup();
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  api.removeNotificationMember.mockResolvedValue(undefined);
  renderPage();
  await screen.findByText('Ops Alerts');

  const row = screen.getByRole('row', { name: /alice tech/i });
  const actionCell = row.querySelectorAll('td')[2] as HTMLElement;
  const before = actionCell.innerHTML;

  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

  expect(confirmSpy).toHaveBeenCalledWith('Remove Alice Tech from this group?');
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
  await waitFor(() => expect(api.getNotificationGroup).toHaveBeenCalledTimes(2));
  confirmSpy.mockRestore();
});

it('member row: a failed Remove says so under the menu and keeps the row', async () => {
  const user = userEvent.setup();
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  api.removeNotificationMember.mockRejectedValue(new ApiError(403, 'forbidden'));
  renderPage();
  await screen.findByText('Ops Alerts');

  await openRowMenu(user, /alice tech/i);
  await user.click(screen.getByRole('menuitem', { name: 'Remove' }));

  expect(await screen.findByText('Request failed (forbidden).')).not.toBeNull();
  expect(screen.getByRole('row', { name: /alice tech/i })).not.toBeNull();
  confirmSpy.mockRestore();
});

it('member row: the actions column is sized to the trigger, not to an inline confirm', async () => {
  api.getNotificationGroup.mockResolvedValue({ ...BASE, members: [MEMBER_1] });
  const { container } = renderPage();
  await screen.findByText('Alice Tech');

  const cols = container.querySelectorAll('.ngd-members-table col');
  expect(cols).toHaveLength(3);
  expect((cols[cols.length - 1] as HTMLElement).style.width).toBe('88px');
});

it('member row: Remove is disabled, not dropped, while the row is in flight', async () => {
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
    expect((screen.getByRole('menuitem', { name: 'Remove' }) as HTMLButtonElement).disabled).toBe(true);
  });
  expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  confirmSpy.mockRestore();
});
