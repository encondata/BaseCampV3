// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type MyNotificationGroup, type UiPreferences } from '../../lib/api';
import { LIST_FIT } from '../../lib/listTools';

const auth = vi.hoisted(() => ({
  updatePreferences: vi.fn(async (_prefs: UiPreferences) => true),
  // The person's saved choices; beforeEach resets them, tests change them.
  categories: {} as UiPreferences['notif']['categories'],
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
      notif: { sound: 'chime', categories: auth.categories },
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
// false: the first /system/status answer has not landed yet
const statusLoaded = vi.hoisted(() => ({ value: true }));
vi.mock('../../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: { ...status }, loaded: statusLoaded.value, refresh: () => {} }),
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
// own behavior has its own coverage elsewhere. Here we only need to
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
  auth.categories = { approvals: 'email', reports: 'inbox', wiki: 'email', learning: 'email', security: 'email' };
  status.email_enabled = true;
  statusLoaded.value = true;
});

const { default: MeNotificationsPage } = await import('./MeNotifications');
const { default: CategoryDelivery } = await import('./CategoryDelivery');

// The page links to /notifications, so it renders inside a router like the real app.
const MeNotifications = () => <MemoryRouter><MeNotificationsPage /></MemoryRouter>;

const delivery = (label: string) => screen.getByRole('group', { name: `${label} delivery` });

const SECTION_COPY = 'Emails go to your contact email; account security notices go to your sign-in email. '
  + 'Your groups decide which categories can email you and when — here you can turn them down.';

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
  expect(screen.getByText(SECTION_COPY)).toBeTruthy();
  expect(screen.queryByText('Appearance')).toBeNull();
});

it('while the groups load, each stored choice shows as the pressed segment and nothing is disabled', async () => {
  api.listMyNotificationGroups.mockReturnValueOnce(new Promise(() => {}));   // never settles
  render(<MeNotifications />);
  const pressed = (label: string) =>
    within(delivery(label)).getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent);
  expect(pressed('Approvals & requests')).toEqual(['Inbox + Email']);
  expect(pressed('Reports & labels')).toEqual(['Inbox only']);
  expect(within(delivery('Wiki')).getAllByRole('button').map((b) => b.textContent))
    .toEqual(['Inbox + Email', 'Inbox only', 'Off']);
  for (const label of ['Approvals & requests', 'Reports & labels', 'Wiki', 'Learning']) {
    for (const b of within(delivery(label)).getAllByRole('button')) {
      expect((b as HTMLButtonElement).disabled).toBe(false);
      expect(b.hasAttribute('title')).toBe(false);
    }
  }
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
  expect(mine.getByText('Approvals & requests').title).toBe('Approvals & requests');   // full label on hover
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
  // Floors that hold the longest values at the 1512px reference width.
  expect(head.style.gridTemplateColumns).toContain(' minmax(156px, 1.5fr) ');   // "Approvals & requests"
  expect(head.style.gridTemplateColumns).toContain(' minmax(168px, 1.2fr) ');   // "12:00 AM – 12:00 AM CT"
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

it('the request modal wears the standard header, for Leave and for Join', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G1, G2]);
  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy());

  pickAction('My groups', 'Leave group');
  let dialog = screen.getByRole('dialog', { name: 'Ask to leave Ops' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Notification groups');
  expect(within(dialog).getByRole('heading', { name: 'Ask to leave Ops' })).toBeTruthy();
  expect(within(dialog).getByText('An admin approves the request. Add a note if it helps.').className)
    .toContain('page-hint');
  expect(dialog.classList.contains('rgm-card')).toBe(true);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();

  pickAction('Join a group', 'Ask to join');
  dialog = screen.getByRole('dialog', { name: 'Ask to join Warehouse Alerts' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Notification groups');
  expect(within(dialog).getByRole('heading', { name: 'Ask to join Warehouse Alerts' })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.requestGroupMembership).not.toHaveBeenCalled();
});

it('the request modal is locked while the request is on its way, and shows a server error beside the buttons', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G1]);
  let reject: (e: unknown) => void = () => {};
  api.requestGroupMembership.mockReturnValueOnce(new Promise((_, r) => { reject = r; }));
  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy());

  pickAction('My groups', 'Leave group');
  const dialog = screen.getByRole('dialog', { name: 'Ask to leave Ops' });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Send request' }));

  const sending = await within(dialog).findByRole('button', { name: 'Sending…' }) as HTMLButtonElement;
  expect(sending.disabled).toBe(true);
  expect((within(dialog).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true);

  reject(new ApiError(409, 'request_pending'));
  const message = await within(dialog).findByText("There's already a request waiting for this group.");
  expect(message.closest('.modal-foot')).not.toBeNull();
  expect(screen.getByRole('dialog', { name: 'Ask to leave Ops' })).toBeTruthy();   // stays open
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

// ── the delivery table only offers email that can happen ─────────────────
// What the control shows is what will really happen; the saved choice is
// never rewritten by looking at the page.

/** A group the person belongs to whose effective channels include email. */
const emailing = (...categories: string[]): MyNotificationGroup => ({
  ...G1, categories, effective_channels: ['email'],
});
const choiceButton = (label: string, name: string) =>
  within(delivery(label)).getByRole('button', { name }) as HTMLButtonElement;
const emailButton = (label: string) => choiceButton(label, 'Inbox + Email');
const pressedOf = (label: string) =>
  within(delivery(label)).getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true')
    .map((b) => b.textContent);
const rowOf = (label: string) =>
  within(screen.getByRole('table', { name: 'Notification delivery' })).getByText(label).closest('tr') as HTMLElement;
const GROUP_SOURCED = ['Approvals & requests', 'Reports & labels', 'Wiki', 'Learning'];

it('shows inbox only when no group emails the category', async () => {
  auth.categories = { ...auth.categories, reports: 'email' };
  api.listMyNotificationGroups.mockResolvedValueOnce([]);
  render(<MeNotifications />);

  await waitFor(() => expect(emailButton('Reports & labels').disabled).toBe(true));
  expect(emailButton('Reports & labels').title).toBe('None of your groups email this category');
  expect(emailButton('Reports & labels').getAttribute('aria-pressed')).toBe('false');
  expect(choiceButton('Reports & labels', 'Inbox only').getAttribute('aria-pressed')).toBe('true');
  expect(choiceButton('Reports & labels', 'Inbox only').disabled).toBe(false);
  expect(within(rowOf('Reports & labels')).getByText('No group — inbox only')).toBeTruthy();
  // Saved as Inbox + Email, and nothing can email them: all four read Inbox only.
  for (const label of GROUP_SOURCED) expect(pressedOf(label)).toEqual(['Inbox only']);
  expect(auth.updatePreferences).not.toHaveBeenCalled();   // looking changes nothing
});

it('turns email back on once a group emails it', () => {
  const onChange = vi.fn();
  const props = { categories: { ...auth.categories, reports: 'email' as const }, emailEnabled: true, onChange };
  const { rerender } = render(<CategoryDelivery {...props} groups={[]} />);
  expect(emailButton('Reports & labels').disabled).toBe(true);
  expect(pressedOf('Reports & labels')).toEqual(['Inbox only']);

  rerender(<CategoryDelivery {...props} groups={[emailing('reports')]} />);
  expect(emailButton('Reports & labels').disabled).toBe(false);
  expect(emailButton('Reports & labels').hasAttribute('title')).toBe(false);
  expect(pressedOf('Reports & labels')).toEqual(['Inbox + Email']);
  expect(within(rowOf('Reports & labels')).getByText('Ops')).toBeTruthy();   // the group, as a chip
  expect(onChange).not.toHaveBeenCalled();
});

it('the same page shows Inbox + Email again once a reload finds a group that emails it, with no extra click', async () => {
  auth.categories = { ...auth.categories, reports: 'email' };
  api.listMyNotificationGroups.mockResolvedValueOnce([G2]);                 // in no group yet
  api.requestGroupMembership.mockResolvedValueOnce({
    id: 'req3', group_id: 'g2', group_name: 'Warehouse Alerts', person_id: 'ada1', person_name: 'Ada Lovelace',
    action: 'join', status: 'pending', note: '', decided_by_name: null, decided_at: null,
    decision_note: '', created_at: '2026-09-10T00:00:00Z',
  });
  // By the time the page reloads its groups, the join has been approved.
  api.listMyNotificationGroups.mockResolvedValueOnce([
    { ...emailing('reports'), id: 'g2', name: 'Warehouse Alerts' },
  ]);
  render(<MeNotifications />);
  await waitFor(() => expect(emailButton('Reports & labels').disabled).toBe(true));
  expect(pressedOf('Reports & labels')).toEqual(['Inbox only']);

  pickAction('Join a group', 'Ask to join');
  fireEvent.click(screen.getByRole('button', { name: 'Send request' }));

  await waitFor(() => expect(emailButton('Reports & labels').disabled).toBe(false));
  expect(pressedOf('Reports & labels')).toEqual(['Inbox + Email']);
  expect(auth.updatePreferences).not.toHaveBeenCalled();                    // the saved choice was never touched
});

it('with email off on the server, every category reads inbox only and says why', async () => {
  status.email_enabled = false;
  api.listMyNotificationGroups.mockResolvedValueOnce([emailing('approvals', 'reports', 'wiki', 'learning')]);
  render(<MeNotifications />);

  await waitFor(() => expect(emailButton(GROUP_SOURCED[0]).disabled).toBe(true));
  for (const label of GROUP_SOURCED) {
    expect(emailButton(label).disabled).toBe(true);
    expect(emailButton(label).title).toBe("Email isn't set up on this server");
    expect(pressedOf(label)).toEqual(['Inbox only']);
    const from = within(rowOf(label));
    expect(from.getByText("Email isn't set up")).toBeTruthy();
    expect(from.queryByText('Ops')).toBeNull();   // a group can't email what the server can't send
  }
  const security = within(rowOf('Account security'));
  expect(security.getByText("Inbox only — email isn't set up")).toBeTruthy();
  expect(security.queryByText('Always emailed')).toBeNull();
  expect(auth.updatePreferences).not.toHaveBeenCalled();
});

it('claims nothing about email until the server status lands, then says email is off', async () => {
  // A hard refresh on /me: the status's defaults read "email off" until the
  // first /system/status answer, which here has not landed yet.
  statusLoaded.value = false;
  status.email_enabled = false;
  api.listMyNotificationGroups.mockResolvedValue([]);
  const { rerender } = render(<MeNotifications />);
  await screen.findByText("You're not in any notification groups yet.");   // the groups are in

  expect(screen.queryByText(/isn't set up/)).toBeNull();
  for (const label of GROUP_SOURCED) {
    for (const b of within(delivery(label)).getAllByRole('button')) {
      expect((b as HTMLButtonElement).disabled).toBe(false);
      expect(b.hasAttribute('title')).toBe(false);
    }
    expect(within(rowOf(label)).getByText('—')).toBeTruthy();         // Email from: not known yet
    expect(within(rowOf(label)).queryByText('No group — inbox only')).toBeNull();
  }
  expect(pressedOf('Approvals & requests')).toEqual(['Inbox + Email']);   // the saved choice, as is
  const security = () => [...rowOf('Account security').children].map((c) => c.textContent);
  expect(security()).toEqual(['Account security', '—', '—']);

  statusLoaded.value = true;                                          // it lands: email is off
  rerender(<MeNotifications />);
  expect(screen.getByText("Email isn't set up on this server yet — notifications stay in the inbox.")).toBeTruthy();
  for (const label of GROUP_SOURCED) {
    expect(emailButton(label).disabled).toBe(true);
    expect(emailButton(label).title).toBe("Email isn't set up on this server");
    expect(pressedOf(label)).toEqual(['Inbox only']);
  }
  expect(security()).toEqual(['Account security', "Inbox only — email isn't set up", '—']);
  expect(auth.updatePreferences).not.toHaveBeenCalled();
});

it('keeps the saved choice: clicking Inbox only while it already shows as selected sends no update', async () => {
  auth.categories = { ...auth.categories, wiki: 'email', learning: 'off' };
  api.listMyNotificationGroups.mockResolvedValueOnce([]);
  render(<MeNotifications />);
  await waitFor(() => expect(emailButton('Wiki').disabled).toBe(true));

  fireEvent.click(choiceButton('Wiki', 'Inbox only'));   // already the one shown as selected
  fireEvent.click(emailButton('Wiki'));                  // disabled
  expect(auth.updatePreferences).not.toHaveBeenCalled();
  expect(screen.queryByText('saved')).toBeNull();
  expect(pressedOf('Learning')).toEqual(['Off']);        // an Off choice is not relabeled

  // A deliberate change still saves, and every other saved choice goes up as it was.
  fireEvent.click(choiceButton('Wiki', 'Off'));
  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledTimes(1));
  expect(auth.updatePreferences.mock.calls[0][0].notif.categories)
    .toEqual({ approvals: 'email', reports: 'inbox', wiki: 'off', learning: 'off', security: 'email' });
});

it('links to all notifications from the section head, under the new copy', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([]);
  render(<MeNotifications />);

  const link = screen.getByRole('link', { name: 'View all notifications' });
  expect(link.getAttribute('href')).toBe('/notifications');
  expect(link.classList.contains('mini-btn')).toBe(true);
  const head = link.closest('.set-head') as HTMLElement;
  expect(within(head).getByRole('heading', { name: 'Notifications', level: 3 })).toBeTruthy();
  expect(within(head).getByText(SECTION_COPY)).toBeTruthy();
});

it('a direct category needs no group: Inbox + Email stays enabled and pressed', () => {
  const direct = [{ key: 'reports' as const, label: 'Reports & labels', emailSource: 'direct' as const }];
  const categories = { ...auth.categories, reports: 'email' as const };
  const { rerender } = render(
    <CategoryDelivery categories={categories} groups={[]} emailEnabled categoryList={direct}
                      onChange={() => {}} />,
  );
  expect(emailButton('Reports & labels').disabled).toBe(false);
  expect(pressedOf('Reports & labels')).toEqual(['Inbox + Email']);
  // No group is involved, so the column has none to name and makes no "No group" claim.
  const from = within(rowOf('Reports & labels'));
  expect(from.queryByText('No group — inbox only')).toBeNull();
  expect(from.getByText('—')).toBeTruthy();

  // It still needs a server that can send email.
  rerender(
    <CategoryDelivery categories={categories} groups={[]} emailEnabled={false} categoryList={direct}
                      onChange={() => {}} />,
  );
  expect(emailButton('Reports & labels').disabled).toBe(true);
  expect(emailButton('Reports & labels').title).toBe("Email isn't set up on this server");
  expect(pressedOf('Reports & labels')).toEqual(['Inbox only']);
});
