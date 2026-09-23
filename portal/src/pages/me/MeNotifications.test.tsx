// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { MyNotificationGroup, UiPreferences } from '../../lib/api';

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
      notif: { critical: true, email: true, maint: true, digest: false, sound: 'chime' },
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

it('renders the four notification rows', () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([]);
  render(<MeNotifications />);
  for (const label of ['Critical incidents', 'Email alerts', 'Maintenance windows', 'Weekly digest']) {
    expect(screen.getByText(label)).toBeTruthy();
  }
  expect(screen.queryByText('Appearance')).toBeNull();
});

it('toggling a switch saves the merged notif object', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([]);
  render(<MeNotifications />);
  const row = screen.getByText('Weekly digest').closest('.set-row') as HTMLElement;
  fireEvent.click(within(row).getByRole('checkbox'));
  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledTimes(1));
  const sent = auth.updatePreferences.mock.calls[0][0];
  expect(sent.notif).toEqual({ critical: true, email: true, maint: true, digest: true, sound: 'chime' });
  expect(sent.accent).toBe('amber');
  await waitFor(() => expect(screen.getByText('saved')).toBeTruthy());
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
  member_count: 5, is_member: false, overrides: null, effective: null, pending_request: null,
};

const G3: MyNotificationGroup = {
  id: 'g3', name: 'Fleet Updates', description: 'Truck status changes', channels: ['email'],
  quiet_start: null, quiet_end: null, timezone: 'America/New_York',
  active_days: ['mon', 'tue', 'wed', 'thu', 'fri'], dnd_behavior: 'defer', urgent_bypass: false,
  member_count: 2, is_member: false, overrides: null, effective: null, pending_request: null,
};

it('renders a member group with channel chips, quiet-hours text, days, and a Customized tag', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G1]);
  render(<MeNotifications />);

  await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy());
  expect(screen.getByText('Operations alerts')).toBeTruthy();
  expect(screen.getByText('Email')).toBeTruthy();
  expect(screen.getByText('Push')).toBeTruthy();
  expect(screen.getByText('22:00–07:00 (America/New_York)')).toBeTruthy();
  expect(screen.getByText('Mon–Fri')).toBeTruthy();
  expect(screen.getByText('Customized')).toBeTruthy();
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
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(1176);
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
