// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { MyNotificationGroup, UiPreferences } from '../../lib/api';
import { LIST_FIT } from '../../lib/listTools';

const auth = vi.hoisted(() => ({
  updatePreferences: vi.fn(async (_prefs: UiPreferences) => true),
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'ada1', display_name: 'Ada Lovelace', email: 'ada@test.example.com' },
    roles: ['developer'],
    preferences: {
      accent: 'amber',
      theme: 'light',
      density: 'comfortable',
      list_size: 'default',
      motion: true,
      nav_mode: 'expanded',
      nav_bg: 'default',
      nav_size: 'default',
      list_view: 'expanded',
      notif: {
        sound: 'chime',
        categories: { approvals: 'email', reports: 'inbox', wiki: 'email', learning: 'email', security: 'email' },
      },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences: auth.updatePreferences,
    can: () => false,
  }),
}));

const sounds = vi.hoisted(() => ({ playNotificationSound: vi.fn(() => true) }));
vi.mock('../../lib/notificationSounds', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/notificationSounds')>()), ...sounds,
}));

const status = vi.hoisted(() => ({ email_enabled: true }));
vi.mock('../../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: { ...status }, refresh: () => {} }),
}));

const api = vi.hoisted(() => ({
  listMyNotificationGroups: vi.fn(),
  updateMyGroupOverrides: vi.fn(),
  requestGroupMembership: vi.fn(),
  cancelMembershipRequest: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

// OverrideEditorModal is the admin group-detail editor reused as-is; its
// own behaviour has its own coverage elsewhere. Here we only need to
// confirm MeNotifications opens it with the right member and wires its
// onSave hook to the self-service PATCH — a tiny stand-in exposing both.
vi.mock('../../components/notifications/OverrideEditorModal', () => ({
  default: ({ member, onSave }: {
    member: { display_name: string };
    onSave?: (body: Record<string, unknown>) => Promise<unknown>;
  }) => (
    <div>
      <h3>Overrides — {member.display_name}</h3>
      <button onClick={() => { void onSave?.({ urgent_bypass: true }); }}>mock-save</button>
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  api.listMyNotificationGroups.mockReset();
  api.updateMyGroupOverrides.mockReset();
  api.requestGroupMembership.mockReset();
  api.cancelMembershipRequest.mockReset();
});

const { default: MeNotifications } = await import('./MeNotifications');

const delivery = (label: string) => screen.getByRole('group', { name: `${label} delivery` });

it('replaces the four old switches with a per-category delivery table', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([]);
  render(<MeNotifications />);
  for (const label of ['Critical incidents', 'Email alerts', 'Maintenance windows', 'Weekly digest']) {
    expect(screen.queryByText(label)).toBeNull();
  }
  const table = screen.getByRole('table', { name: 'Notification delivery' });
  for (const label of ['Approvals & requests', 'Reports & labels', 'Wiki', 'Learning', 'Account security']) {
    expect(within(table).getByText(label)).toBeTruthy();
  }
  expect(screen.getByText(/Emails go to your contact email\. Your groups decide which categories can email you and when; here you can turn them down\./)).toBeTruthy();
  expect(screen.queryByText('Appearance')).toBeNull();
});

it('shows each stored choice as the pressed segment', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([]);
  render(<MeNotifications />);
  const pressed = (label: string) =>
    within(delivery(label)).getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent);
  expect(pressed('Approvals & requests')).toEqual(['Inbox + Email']);
  expect(pressed('Reports & labels')).toEqual(['Inbox only']);
  expect(within(delivery('Wiki')).getAllByRole('button').map((b) => b.textContent))
    .toEqual(['Inbox + Email', 'Inbox only', 'Off']);
});

it('choosing a delivery saves the merged notif.categories object', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([]);
  render(<MeNotifications />);
  fireEvent.click(within(delivery('Wiki')).getByRole('button', { name: 'Off' }));
  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledTimes(1));
  const sent = auth.updatePreferences.mock.calls[0][0];
  expect(sent.notif).toEqual({
    sound: 'chime',
    categories: { approvals: 'email', reports: 'inbox', wiki: 'off', learning: 'email', security: 'email' },
  });
  expect(sent.accent).toBe('amber');
  await waitFor(() => expect(screen.getByText('saved')).toBeTruthy());
});

it('Account security shows "Always emailed" and no delivery control', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([]);
  render(<MeNotifications />);
  expect(screen.queryByRole('group', { name: 'Account security delivery' })).toBeNull();
  const row = screen.getByText('Account security').closest('tr') as HTMLElement;
  expect(within(row).getByText('Always emailed')).toBeTruthy();
});

it('Email from lists the member groups that carry the category and can email', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([
    { ...G1, categories: ['approvals', 'reports'], effective_channels: ['email', 'push'] },
    { ...G1, id: 'g9', name: 'Night Desk', categories: ['approvals'], effective_channels: ['web'] },
    { ...G1, id: 'g8', name: 'Wiki Watch', categories: ['wiki'], effective_channels: ['email'], is_member: false },
  ]);
  render(<MeNotifications />);
  const table = screen.getByRole('table', { name: 'Notification delivery' });
  await waitFor(() => expect(within(within(table).getByText('Approvals & requests').closest('tr') as HTMLElement).getByText('Ops')).toBeTruthy());
  const rowOf = (l: string) => within(table).getByText(l).closest('tr') as HTMLElement;
  expect(within(rowOf('Approvals & requests')).queryByText('Night Desk')).toBeNull();
  expect(within(rowOf('Reports & labels')).getByText('Ops')).toBeTruthy();
  expect(within(rowOf('Wiki')).getByText('No group — inbox only')).toBeTruthy();
});

it('shows the email-off hint only when the server has email off', async () => {
  status.email_enabled = false;
  api.listMyNotificationGroups.mockResolvedValueOnce([]);
  const { unmount } = render(<MeNotifications />);
  expect(screen.getByText("Email isn't set up on this server yet — notifications stay in the inbox.")).toBeTruthy();
  unmount();
  status.email_enabled = true;
  api.listMyNotificationGroups.mockResolvedValueOnce([]);
  render(<MeNotifications />);
  expect(screen.queryByText("Email isn't set up on this server yet — notifications stay in the inbox.")).toBeNull();
});

it('Sound row saves the chosen sound and Preview plays the current one', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([]);
  render(<MeNotifications />);
  const row = screen.getByText('Sound').closest('.set-row') as HTMLElement;
  expect(within(row).getByRole('radio', { name: 'Chime' }).getAttribute('aria-checked')).toBe('true');
  fireEvent.click(within(row).getByRole('radio', { name: 'Ping' }));
  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledTimes(1));
  expect(auth.updatePreferences.mock.calls[0][0].notif.sound).toBe('ping');
  fireEvent.click(within(row).getByRole('button', { name: 'Preview' }));
  expect(sounds.playNotificationSound).toHaveBeenCalledWith('chime'); // mock prefs still say chime
});

const G1: MyNotificationGroup = {
  id: 'g1', name: 'Ops', description: 'Operations alerts', channels: ['email', 'push'],
  quiet_start: '22:00:00', quiet_end: '07:00:00', timezone: 'America/New_York',
  active_days: ['mon', 'tue', 'wed', 'thu', 'fri'], dnd_behavior: 'defer', urgent_bypass: false,
  member_count: 3, is_member: true,
  categories: [], effective_channels: ['email', 'push'],
  overrides: {
    channels: null, quiet_mode: null, quiet_start: null, quiet_end: null,
    timezone: null, active_days: null, dnd_behavior: null, urgent_bypass: true,
  },
  effective: {
    channels: ['email', 'push'], quiet_start: '22:00:00', quiet_end: '07:00:00',
    timezone: 'America/New_York', active_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    dnd_behavior: 'defer', urgent_bypass: true,
  },
  pending_request: null,
};

const G2: MyNotificationGroup = {
  id: 'g2', name: 'Warehouse Alerts', description: 'Forklift and stock alerts', channels: ['push'],
  quiet_start: null, quiet_end: null, timezone: 'America/New_York',
  active_days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], dnd_behavior: 'skip', urgent_bypass: false,
  member_count: 5, is_member: false, categories: [], effective_channels: [], overrides: null, effective: null, pending_request: null,
};

const G3: MyNotificationGroup = {
  id: 'g3', name: 'Fleet Updates', description: 'Truck status changes', channels: ['email'],
  quiet_start: null, quiet_end: null, timezone: 'America/New_York',
  active_days: ['mon', 'tue', 'wed', 'thu', 'fri'], dnd_behavior: 'defer', urgent_bypass: false,
  member_count: 2, is_member: false, categories: [], effective_channels: [], overrides: null, effective: null, pending_request: null,
};

it('renders a member group with channel chips, quiet-hours text, days, and a Customized tag', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G1]);
  render(<MeNotifications />);

  await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy());
  expect(screen.getByText('Operations alerts')).toBeTruthy();
  expect(screen.getByText('Email')).toBeTruthy();
  expect(screen.queryByText('Push')).toBeNull(); // stored, but nothing can send it
  expect(screen.getByText('10:00 PM – 7:00 AM ET')).toBeTruthy();
  expect(screen.getByText('Mon–Fri')).toBeTruthy();
  expect(screen.getByText('Customized')).toBeTruthy();
});

it('both group lists have a Categories column, in registry order, or say inbox only', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([
    { ...G1, categories: ['wiki', 'approvals'] },
    { ...G2, categories: ['learning'] },
    { ...G3, categories: [] },
  ]);
  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Warehouse Alerts')).toBeTruthy());

  const mine = within(screen.getByRole('region', { name: 'My groups' }));
  const joinable = within(screen.getByRole('region', { name: 'Join a group' }));
  // These headers are plain labels (the lists do not sort), so look for the text.
  expect(mine.getByText('Categories')).toBeTruthy();
  expect(joinable.getByText('Categories')).toBeTruthy();
  const chipsOf = (list: ReturnType<typeof within>, text: string) =>
    [...(list.getByText(text).closest('.chips') as HTMLElement).children].map((c) => c.textContent);
  expect(chipsOf(mine, 'Wiki')).toEqual(['Approvals & requests', 'Wiki']);
  expect(chipsOf(joinable, 'Learning')).toEqual(['Learning']);
  expect(joinable.getByText('None — inbox only').className).toContain('c-slate');
});

it('a member row shows their effective channels, quiet hours and days, not the group defaults', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([{
    ...G1,
    // The group emails 22:00-07:00 Eastern on weekdays; this member has
    // narrowed it to text only, with a window in Chicago.
    effective: {
      ...G1.effective!,
      channels: ['text'], quiet_start: '21:00:00', quiet_end: '07:00:00',
      timezone: 'America/Chicago', active_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    },
  }]);
  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy());

  const row = (screen.getByText('Ops').closest('.dir-row')) as HTMLElement;
  expect(within(row).getByText('No email').className).toContain('c-slate');
  expect(within(row).queryByText('Email')).toBeNull();
  expect(within(row).getByText('9:00 PM – 7:00 AM CT')).toBeTruthy();
  expect(within(row).queryByText('10:00 PM – 7:00 AM ET')).toBeNull();
  expect(within(row).getByText('Mon–Fri')).toBeTruthy();
});

it('a joinable row shows the group\'s own channels, quiet hours and days, in the one format', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([
    G2,
    {
      ...G3, quiet_start: '23:00:00', quiet_end: '06:30:00', timezone: 'America/Los_Angeles',
      active_days: ['sat', 'sun'],
    },
  ]);
  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Warehouse Alerts')).toBeTruthy());

  const rowFor = (name: string) => (screen.getByText(name).closest('.dir-row')) as HTMLElement;
  // Warehouse Alerts: push only, no quiet hours, every day.
  const warehouse = within(rowFor('Warehouse Alerts'));
  expect(warehouse.getByText('No email')).toBeTruthy();
  expect(warehouse.getByText('Daily')).toBeTruthy();
  expect(warehouse.queryByText('Push')).toBeNull();
  // Fleet Updates: emails, overnight Pacific window, weekends.
  const fleet = within(rowFor('Fleet Updates'));
  expect(fleet.getByText('Email')).toBeTruthy();
  expect(fleet.getByText('11:00 PM – 6:30 AM PT')).toBeTruthy();
  expect(fleet.getByText('Weekends')).toBeTruthy();
});

it('quiet hours and days stay on one line, with the full text on hover', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G1]);
  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy());

  for (const text of ['10:00 PM – 7:00 AM ET', 'Mon–Fri']) {
    const el = screen.getByText(text);
    expect(el.classList.contains('cell-nowrap')).toBe(true);
    expect(el.classList.contains('cell-line')).toBe(true);
    expect(el.title).toBe(text);
    expect(el.parentElement?.classList.contains('cell')).toBe(true); // .cell .cell-line is a descendant rule
  }
});

it('My groups list: column floors, shared template + minimum, sideways-scroll card', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G1]);
  render(<MeNotifications />);

  const row = (await screen.findByText('Ops')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
  // The Categories column sits right after Group in the measured grid.
  const labels = [...head.querySelectorAll('.col-head')].map((h) => h.textContent?.trim());
  expect(labels.slice(0, 3)).toEqual(['Group', 'Categories', 'Channels']);
});

/** Standard-list rows keep their actions behind the "Actions ▾" menu:
 * open the menu inside the named section, then pick an item. */
const region = (name: string) => screen.getByRole('region', { name });
const pickAction = (sectionName: string, item: string) => {
  fireEvent.click(within(region(sectionName)).getByRole('button', { name: /Actions/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
};

it('Leave opens the request modal, Send posts the leave request, and a pending leave shows Cancel', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G1]);
  api.requestGroupMembership.mockResolvedValueOnce({
    id: 'req1', group_id: 'g1', group_name: 'Ops', person_id: 'ada1', person_name: 'Ada Lovelace',
    action: 'leave', status: 'pending', note: 'note text', decided_by_name: null, decided_at: null,
    decision_note: '', created_at: '2026-09-10T00:00:00Z',
  });
  const afterLeave = {
    ...G1,
    pending_request: { id: 'req1', action: 'leave', note: 'note text', created_at: '2026-09-10T00:00:00Z' },
  };
  api.listMyNotificationGroups.mockResolvedValueOnce([afterLeave]);

  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy());

  pickAction('My groups', 'Leave group');
  expect(screen.getByText('Ask to leave Ops')).toBeTruthy();

  fireEvent.change(screen.getByLabelText('Note (optional)'), { target: { value: 'note text' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send request' }));

  await waitFor(() => expect(api.requestGroupMembership).toHaveBeenCalledWith('g1', 'leave', 'note text'));
  await waitFor(() => expect(screen.getByText('Leave requested')).toBeTruthy());
  expect(screen.queryByText('Ask to leave Ops')).toBeNull();

  api.cancelMembershipRequest.mockResolvedValueOnce(undefined);
  api.listMyNotificationGroups.mockResolvedValueOnce([G1]);
  pickAction('My groups', 'Cancel request');
  await waitFor(() => expect(api.cancelMembershipRequest).toHaveBeenCalledWith('req1'));
  await waitFor(() => expect(screen.queryByText('Leave requested')).toBeNull());
  fireEvent.click(within(region('My groups')).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Leave group' })).toBeTruthy();
});

it('Join a group search filters non-member groups and Join posts an empty-note request', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G1, G2, G3]);
  api.requestGroupMembership.mockResolvedValueOnce({
    id: 'req2', group_id: 'g2', group_name: 'Warehouse Alerts', person_id: 'ada1', person_name: 'Ada Lovelace',
    action: 'join', status: 'pending', note: '', decided_by_name: null, decided_at: null,
    decision_note: '', created_at: '2026-09-10T00:00:00Z',
  });
  api.listMyNotificationGroups.mockResolvedValueOnce([
    G1,
    { ...G2, pending_request: { id: 'req2', action: 'join', note: '', created_at: '2026-09-10T00:00:00Z' } },
    G3,
  ]);

  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Warehouse Alerts')).toBeTruthy());
  expect(screen.getByText('Fleet Updates')).toBeTruthy();

  fireEvent.change(within(region('Join a group')).getByPlaceholderText('Filter this list…'), { target: { value: 'warehouse' } });
  expect(screen.getByText('Warehouse Alerts')).toBeTruthy();
  expect(screen.queryByText('Fleet Updates')).toBeNull();

  pickAction('Join a group', 'Ask to join');
  expect(screen.getByText('Ask to join Warehouse Alerts')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Send request' }));

  await waitFor(() => expect(api.requestGroupMembership).toHaveBeenCalledWith('g2', 'join', ''));
  await waitFor(() => expect(screen.getByText('Join requested')).toBeTruthy());
});

it('Edit overrides opens the override modal and wires onSave to updateMyGroupOverrides', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G1]);
  api.updateMyGroupOverrides.mockResolvedValueOnce({ ...G1 });
  api.listMyNotificationGroups.mockResolvedValueOnce([G1]);

  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy());

  pickAction('My groups', 'Edit overrides');
  expect(screen.getByText('Overrides — Ada Lovelace')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'mock-save' }));
  await waitFor(() => expect(api.updateMyGroupOverrides)
    .toHaveBeenCalledWith('g1', { urgent_bypass: true }));
});
