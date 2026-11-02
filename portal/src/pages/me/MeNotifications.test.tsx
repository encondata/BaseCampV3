// @vitest-environment jsdom
/**
 * /me › Notifications: the "What you get" switch grid (Inbox and Email per
 * category, following the company defaults until the person changes a switch),
 * the critical note, the Sound row, the "When email reaches you" schedule card,
 * and the groups lists (Group, Members, Status — groups no longer decide what
 * a person gets). Only the person's own choices are ever saved.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, type MyNotificationGroup, type NotificationKindSetting, type NotificationSettings,
  type SwitchPair, type UiPreferences,
} from '../../lib/api';
import { LIST_FIT } from '../../lib/listTools';

const auth = vi.hoisted(() => ({
  updatePreferences: vi.fn(async (_prefs: UiPreferences) => true),
  // The person's saved notification preferences; beforeEach resets them, tests change them.
  notif: undefined as unknown as UiPreferences['notif'],
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
      notif: auth.notif,
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
  getNotificationSettings: vi.fn(),
  listMyNotificationGroups: vi.fn(),
  requestGroupMembership: vi.fn(),
  cancelMembershipRequest: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const ON: SwitchPair = { inbox: true, email: true };

const kind = (
  key: string, label: string, category: NotificationKindSetting['category'],
  over: Partial<NotificationKindSetting> = {},
): NotificationKindSetting => ({
  kind: key, label, category, email: true, owner_always: false, critical: false, locked: false, ...over,
});

/** What GET /notifications/settings answers: Reports email is off by default,
 *  one kind an admin marked critical, and the two security kinds always are. */
const SETTINGS: NotificationSettings = {
  defaults: { approvals: ON, reports: { inbox: true, email: false }, wiki: ON, learning: ON },
  critical_kinds: ['report_failed'],
  kinds: [
    kind('membership_request', 'Group membership request', 'approvals'),
    kind('report_ready', 'Report ready', 'reports'),
    kind('report_failed', 'Report failed', 'reports', { critical: true }),
    kind('learning_quiz_locked', 'Quiz locked', 'learning', { email: false }),
    kind('password_expiring', 'Password expiring', 'security',
      { owner_always: true, critical: true, locked: true }),
    kind('totp_enrolled', 'Two-factor authentication enrolled', 'security',
      { owner_always: true, critical: true, locked: true }),
  ],
};

const EVERY_DAY: UiPreferences['notif']['schedule']['days'] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  api.getNotificationSettings.mockReset();
  api.listMyNotificationGroups.mockReset();
  api.requestGroupMembership.mockReset();
  api.cancelMembershipRequest.mockReset();
  api.getNotificationSettings.mockResolvedValue(SETTINGS);
  api.listMyNotificationGroups.mockResolvedValue([]);
  auth.notif = {
    sound: 'chime',
    switches: {},
    schedule: { timezone: null, days: [...EVERY_DAY], quiet_start: null, quiet_end: null },
  };
  status.email_enabled = true;
  statusLoaded.value = true;
});

const { default: MeNotificationsPage } = await import('./MeNotifications');

// The page links to /notifications, so it renders inside a router like the real app.
const MeNotifications = () => <MemoryRouter><MeNotificationsPage /></MemoryRouter>;

const sw = (channel: 'Inbox' | 'Email', category: string) =>
  screen.getByRole('checkbox', { name: `${channel} for ${category}` }) as HTMLInputElement;

/** The reason a switch gives for being off limits: the title of what wraps it. */
const reason = (input: HTMLElement) => input.closest('[title]')?.getAttribute('title') ?? null;

const GRID_CATEGORIES = ['Approvals & requests', 'Reports & labels', 'Wiki', 'Learning'];

/** The grid is inert until the company defaults have arrived. */
const loaded = () => waitFor(() => expect(sw('Inbox', 'Wiki').disabled).toBe(false));

const HEAD_COPY = 'Emails go to your contact email; account security notices go to your sign-in email. '
  + "Switches you haven't changed follow the company defaults.";
const CRITICAL_NOTE = 'Critical notifications still follow these switches, but skip your quiet hours, '
  + 'days off and the summary email. Your admins choose which are critical. '
  + 'Right now: Report failed, Password expiring, Two-factor authentication enrolled.';
const EMAIL_OFF_HINT = "Email isn't set up on this server yet — notifications stay in the inbox.";

/** Everything the page sent to updatePreferences in its first save. */
const firstSave = async () => {
  await waitFor(() => expect(auth.updatePreferences).toHaveBeenCalledTimes(1));
  return auth.updatePreferences.mock.calls[0][0];
};

// ── the "What you get" card ──────────────────────────────────────────────

it('opens with the "What you get" head: the section copy, and the link to all notifications', async () => {
  render(<MeNotifications />);
  await loaded();
  const link = screen.getByRole('link', { name: 'View all notifications' });
  expect(link.getAttribute('href')).toBe('/notifications');
  expect(link.classList.contains('mini-btn')).toBe(true);
  const head = link.closest('.set-head') as HTMLElement;
  expect(within(head).getByRole('heading', { name: 'What you get', level: 3 })).toBeTruthy();
  expect(within(head).getByText(HEAD_COPY)).toBeTruthy();
  // The groups no longer decide anything, and the copy no longer says they do.
  expect(screen.queryByText(/Your groups decide/)).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Notifications', level: 3 })).toBeNull();
  expect(screen.queryByText('Appearance')).toBeNull();
});

it('lists a switch grid, not the old delivery table, and loads the company defaults once', async () => {
  render(<MeNotifications />);
  await loaded();
  expect(api.getNotificationSettings).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('table', { name: 'Notification delivery' })).toBeNull();
  const grid = screen.getByRole('table', { name: 'Notification switches' });
  for (const label of [...GRID_CATEGORIES, 'Account security']) {
    expect(within(grid).getByText(label)).toBeTruthy();
  }
  for (const label of ['Critical incidents', 'Email alerts', 'Maintenance windows', 'Weekly digest']) {
    expect(screen.queryByText(label)).toBeNull();
  }
  expect(screen.queryByRole('group', { name: /delivery/ })).toBeNull();
});

it('the grid follows the company defaults, and says every row does', async () => {
  api.getNotificationSettings.mockResolvedValue({
    ...SETTINGS,
    defaults: {
      approvals: ON, reports: { inbox: true, email: false },
      wiki: { inbox: false, email: false }, learning: ON,
    },
  });
  render(<MeNotifications />);
  await waitFor(() => expect(sw('Inbox', 'Approvals & requests').disabled).toBe(false));

  expect(sw('Inbox', 'Approvals & requests').checked).toBe(true);
  expect(sw('Email', 'Approvals & requests').checked).toBe(true);
  expect(sw('Inbox', 'Reports & labels').checked).toBe(true);
  expect(sw('Email', 'Reports & labels').checked).toBe(false);
  expect(sw('Inbox', 'Wiki').checked).toBe(false);
  expect(sw('Email', 'Wiki').checked).toBe(false);
  expect(reason(sw('Email', 'Wiki'))).toBe('Turn on Inbox to get email');
  expect(screen.getAllByText('Company default')).toHaveLength(4);
  expect(screen.queryByText('Your choice')).toBeNull();
  expect(auth.updatePreferences).not.toHaveBeenCalled();   // looking changes nothing
});

it('the person\'s own values win over the defaults, and the row says "Your choice"', async () => {
  auth.notif.switches = { reports: { email: true }, wiki: { inbox: false } };
  render(<MeNotifications />);
  await loaded();

  expect(sw('Email', 'Reports & labels').checked).toBe(true);    // default off, theirs on
  expect(sw('Inbox', 'Wiki').checked).toBe(false);               // default on, theirs off
  expect(sw('Email', 'Wiki').checked).toBe(false);               // Email needs Inbox
  const reports = screen.getByRole('row', { name: /Reports & labels/ });
  expect(within(reports).getByText('Your choice')).toBeTruthy();
  expect(within(screen.getByRole('row', { name: /Wiki/ })).getByText('Your choice')).toBeTruthy();
  expect(screen.getAllByText('Company default')).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Use company default' })).toHaveLength(2);
});

it('while the company defaults load, every switch is off limits and nothing is claimed', async () => {
  api.getNotificationSettings.mockReturnValue(new Promise(() => {}));   // never settles
  render(<MeNotifications />);
  for (const label of GRID_CATEGORIES) {
    for (const channel of ['Inbox', 'Email'] as const) {
      expect(sw(channel, label).disabled).toBe(true);
      expect(sw(channel, label).checked).toBe(false);
    }
  }
  expect(screen.queryByText(/Right now:/)).toBeNull();
  expect(screen.queryByText('Could not load notification settings.')).toBeNull();
  await screen.findByText("You're not in any notification groups yet.");   // the groups are in
});

it('if the settings can\'t be loaded it says so, and leaves the grid off limits', async () => {
  api.getNotificationSettings.mockRejectedValue(new ApiError(500, 'server_error'));
  render(<MeNotifications />);
  const error = await screen.findByText('Could not load notification settings.');
  expect(error.tagName).toBe('P');
  expect(error.classList.contains('pf-error')).toBe(true);
  for (const label of GRID_CATEGORIES) {
    expect(sw('Inbox', label).disabled).toBe(true);
    expect(sw('Email', label).disabled).toBe(true);
  }
  expect(screen.queryByText(/Right now:/)).toBeNull();
  // The rest of the page is still there.
  expect(screen.getByRole('heading', { name: 'When email reaches you' })).toBeTruthy();
  expect(screen.getByRole('radio', { name: 'Chime' })).toBeTruthy();
});

it('Account security shows "Always" twice and no switch', async () => {
  render(<MeNotifications />);
  await loaded();
  const row = screen.getByRole('row', { name: /Account security/ });
  expect(within(row).getAllByText('Always')).toHaveLength(2);
  expect(within(row).queryByRole('checkbox')).toBeNull();
});

// ── saving: only the person's own choices go up ──────────────────────────

it('flipping Wiki Email off saves switches.wiki = {email: false}, with everything else as it was', async () => {
  render(<MeNotifications />);
  await loaded();
  fireEvent.click(sw('Email', 'Wiki'));

  const sent = await firstSave();
  expect(sent.notif).toEqual({
    sound: 'chime',
    switches: { wiki: { email: false } },
    schedule: { timezone: null, days: EVERY_DAY, quiet_start: null, quiet_end: null },
  });
  expect(sent.accent).toBe('amber');
  await waitFor(() => expect(screen.getByText('saved')).toBeTruthy());
});

it('after a save the row says "Your choice", and the company defaults are not fetched again', async () => {
  // Like the real AuthContext: what is saved becomes the person's preferences.
  auth.updatePreferences.mockImplementationOnce(async (prefs: UiPreferences) => {
    auth.notif = prefs.notif;
    return true;
  });
  render(<MeNotifications />);
  await loaded();
  fireEvent.click(sw('Email', 'Wiki'));

  await waitFor(() => expect(within(screen.getByRole('row', { name: /Wiki/ })).getByText('Your choice')).toBeTruthy());
  expect(sw('Email', 'Wiki').checked).toBe(false);
  expect(screen.getAllByText('Company default')).toHaveLength(3);
  expect(api.getNotificationSettings).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(screen.getByText('saved')).toBeTruthy());
});

it('flipping Reports Email on saves {email: true}, because its default is off', async () => {
  render(<MeNotifications />);
  await loaded();
  fireEvent.click(sw('Email', 'Reports & labels'));
  expect((await firstSave()).notif.switches).toEqual({ reports: { email: true } });
});

it('flipping Wiki Inbox off saves {inbox: false}, and keeps an Email value already chosen', async () => {
  auth.notif.switches = { wiki: { email: false } };
  render(<MeNotifications />);
  await loaded();
  fireEvent.click(sw('Inbox', 'Wiki'));
  expect((await firstSave()).notif.switches).toEqual({ wiki: { email: false, inbox: false } });
});

it('other categories\' own choices go up unchanged', async () => {
  auth.notif.switches = { reports: { inbox: false }, learning: { email: false } };
  render(<MeNotifications />);
  await loaded();
  fireEvent.click(sw('Email', 'Wiki'));
  expect((await firstSave()).notif.switches).toEqual({
    reports: { inbox: false }, learning: { email: false }, wiki: { email: false },
  });
});

it('flipping a switch back to the default drops the key: absent means it follows the default', async () => {
  auth.notif.switches = { wiki: { email: false }, reports: { inbox: false } };
  render(<MeNotifications />);
  await loaded();
  fireEvent.click(sw('Email', 'Wiki'));   // off → on, which is the default
  const saved = (await firstSave()).notif.switches;
  expect(saved).toEqual({ reports: { inbox: false } });
  expect('wiki' in saved).toBe(false);
});

it('"Use company default" removes the key', async () => {
  auth.notif.switches = { wiki: { email: false }, reports: { inbox: false } };
  render(<MeNotifications />);
  await loaded();
  const wiki = screen.getByRole('row', { name: /Wiki/ });
  fireEvent.click(within(wiki).getByRole('button', { name: 'Use company default' }));
  const saved = (await firstSave()).notif.switches;
  expect(saved).toEqual({ reports: { inbox: false } });
  expect('wiki' in saved).toBe(false);
});

it('"Use company default" on the only choice leaves no switches at all', async () => {
  auth.notif.switches = { wiki: { inbox: false, email: false } };
  render(<MeNotifications />);
  await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Use company default' }));
  expect((await firstSave()).notif.switches).toEqual({});
});

// ── the critical note ────────────────────────────────────────────────────

it('the critical note lists the critical kinds\' labels, in registry order', async () => {
  render(<MeNotifications />);
  await loaded();
  const note = screen.getByText(CRITICAL_NOTE);
  expect(note.tagName).toBe('P');
  // It sits under the grid and above the Sound row.
  const grid = screen.getByRole('table', { name: 'Notification switches' });
  const sound = screen.getByText('Sound').closest('.set-row') as HTMLElement;
  expect(grid.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(note.compareDocumentPosition(sound) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('the critical note follows what the admins have marked critical', async () => {
  api.getNotificationSettings.mockResolvedValue({
    ...SETTINGS,
    critical_kinds: ['report_failed', 'report_ready'],
    kinds: SETTINGS.kinds.map((k) => (k.kind === 'report_ready' ? { ...k, critical: true } : k)),
  });
  render(<MeNotifications />);
  await loaded();
  expect(screen.getByText(
    CRITICAL_NOTE.replace('Report failed,', 'Report ready, Report failed,'))).toBeTruthy();
});

it('with no critical kinds the note still explains critical, and names none', async () => {
  api.getNotificationSettings.mockResolvedValue({
    ...SETTINGS, critical_kinds: [], kinds: SETTINGS.kinds.map((k) => ({ ...k, critical: false })),
  });
  render(<MeNotifications />);
  await loaded();
  expect(screen.getByText(
    'Critical notifications still follow these switches, but skip your quiet hours, days off '
    + 'and the summary email. Your admins choose which are critical.')).toBeTruthy();
  expect(screen.queryByText(/Right now/)).toBeNull();
});

// ── email that can't be sent ─────────────────────────────────────────────

it('shows the email-off hint only when the server has email off', async () => {
  status.email_enabled = false;
  const { unmount } = render(<MeNotifications />);
  await loaded();
  expect(screen.getByText(EMAIL_OFF_HINT)).toBeTruthy();
  unmount();
  status.email_enabled = true;
  render(<MeNotifications />);
  await loaded();
  expect(screen.queryByText(EMAIL_OFF_HINT)).toBeNull();
});

it('with email off on the server, the Email column is disabled and says why; Inbox is not', async () => {
  status.email_enabled = false;
  render(<MeNotifications />);
  await loaded();
  for (const label of GRID_CATEGORIES) {
    expect(sw('Email', label).disabled).toBe(true);
    expect(reason(sw('Email', label))).toBe("Email isn't set up on this server");
    expect(sw('Inbox', label).disabled).toBe(false);
  }
  fireEvent.click(sw('Inbox', 'Wiki'));
  expect((await firstSave()).notif.switches).toEqual({ wiki: { inbox: false } });
});

it('claims nothing about email until the server status lands, then says email is off', async () => {
  // A hard refresh on /me: the status's defaults read "email off" until the
  // first /system/status answer, which here has not landed yet.
  statusLoaded.value = false;
  status.email_enabled = false;
  const { rerender } = render(<MeNotifications />);
  await loaded();

  expect(screen.queryByText(EMAIL_OFF_HINT)).toBeNull();
  for (const label of GRID_CATEGORIES) {
    expect(sw('Email', label).disabled).toBe(false);
    expect(reason(sw('Email', label))).toBeNull();
  }
  expect(sw('Email', 'Wiki').checked).toBe(true);   // what they'd get, as is

  statusLoaded.value = true;                        // it lands: email is off
  rerender(<MeNotifications />);
  expect(screen.getByText(EMAIL_OFF_HINT)).toBeTruthy();
  for (const label of GRID_CATEGORIES) {
    expect(sw('Email', label).disabled).toBe(true);
    expect(reason(sw('Email', label))).toBe("Email isn't set up on this server");
  }
  expect(auth.updatePreferences).not.toHaveBeenCalled();
});

// ── Sound ────────────────────────────────────────────────────────────────

it('Sound row saves the chosen sound and Preview plays the current one', async () => {
  render(<MeNotifications />);
  await loaded();
  const row = screen.getByText('Sound').closest('.set-row') as HTMLElement;
  expect(within(row).getByRole('radio', { name: 'Chime' }).getAttribute('aria-checked')).toBe('true');
  fireEvent.click(within(row).getByRole('radio', { name: 'Ping' }));
  const sent = await firstSave();
  expect(sent.notif.sound).toBe('ping');
  expect(sent.notif.switches).toEqual({});                 // the rest of notif goes up as it was
  expect(sent.notif.schedule.days).toEqual(EVERY_DAY);
  fireEvent.click(within(row).getByRole('button', { name: 'Preview' }));
  expect(sounds.playNotificationSound).toHaveBeenCalledWith('chime'); // mock prefs still say chime
  await waitFor(() => expect(screen.getByText('saved')).toBeTruthy());
});

// ── the schedule card ────────────────────────────────────────────────────

it('shows the schedule card once, under the grid, with its own head', async () => {
  render(<MeNotifications />);
  await loaded();
  expect(screen.getAllByRole('heading', { name: 'When email reaches you' })).toHaveLength(1);
  expect(screen.getByText(
    'Email that arrives during quiet hours or on a day off waits, then comes as one summary '
    + 'an hour before your day starts. Your inbox in the portal still updates right away.')).toBeTruthy();
  const stack = screen.getByRole('link', { name: 'View all notifications' }).closest('.set-stack');
  expect(stack?.contains(screen.getByRole('heading', { name: 'When email reaches you' }))).toBe(true);
});

it('the schedule card shows the saved schedule', async () => {
  auth.notif.schedule = {
    timezone: 'America/Chicago', days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    quiet_start: '21:00', quiet_end: '06:00',
  };
  render(<MeNotifications />);
  await loaded();
  expect((screen.getByRole('combobox', { name: 'Timezone' }) as HTMLInputElement).value).toBe('America/Chicago');
  expect(screen.getByRole('button', { name: 'Sat' }).getAttribute('aria-pressed')).toBe('false');
  expect(screen.getByRole('button', { name: 'Mon' }).getAttribute('aria-pressed')).toBe('true');
  expect((screen.getByRole('checkbox', { name: 'Quiet hours' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('combobox', { name: 'Quiet hours start' }) as HTMLInputElement).value).toBe('9:00 PM');
  expect(screen.getByRole('status').textContent).toContain('5:00 AM CT');
});

it('a schedule change saves notif.schedule, and keeps the sound and the switches', async () => {
  auth.notif.switches = { wiki: { email: false } };
  render(<MeNotifications />);
  await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Sat' }));

  const sent = await firstSave();
  expect(sent.notif).toEqual({
    sound: 'chime',
    switches: { wiki: { email: false } },
    schedule: {
      timezone: null, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sun'], quiet_start: null, quiet_end: null,
    },
  });
  await waitFor(() => expect(screen.getByText('saved')).toBeTruthy());
});

it('an invalid schedule is never saved: removing every day asks for one and sends nothing', async () => {
  auth.notif.schedule = { ...auth.notif.schedule, days: ['mon'] };
  render(<MeNotifications />);
  await loaded();
  fireEvent.click(screen.getByRole('button', { name: 'Mon' }));
  expect(screen.getByRole('status').textContent).toBe('Pick at least one day.');
  expect(auth.updatePreferences).not.toHaveBeenCalled();
});

// ── the groups lists ─────────────────────────────────────────────────────

/** A group as the API answers: a name, a description, its (hidden) categories,
 *  its members and the viewer's own request. No delivery settings. */
const G1: MyNotificationGroup = {
  id: 'g1', name: 'Ops', description: 'Operations alerts', categories: ['approvals', 'wiki'],
  member_count: 3, is_member: true, pending_request: null,
};

const G2: MyNotificationGroup = {
  id: 'g2', name: 'Warehouse Alerts', description: 'Forklift and stock alerts', categories: ['learning'],
  member_count: 5, is_member: false, pending_request: null,
};

const G3: MyNotificationGroup = {
  id: 'g3', name: 'Fleet Updates', description: 'Truck status changes', categories: [],
  member_count: 2, is_member: false, pending_request: null,
};

/** Standard-list rows keep their actions behind the "Actions ▾" menu:
 * open the menu inside the named section, then pick an item. */
const region = (name: string) => screen.getByRole('region', { name });
const pickAction = (sectionName: string, item: string) => {
  fireEvent.click(within(region(sectionName)).getByRole('button', { name: /Actions/ }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
};

it('the hints say groups don\'t change what you get, and how to join one', async () => {
  render(<MeNotifications />);
  await loaded();
  const mine = within(region('My groups'));
  const joinable = within(region('Join a group'));
  const myHint = mine.getByText("The notification groups you belong to. Groups don't change what you get.");
  expect(myHint.classList.contains('page-hint')).toBe(true);
  const joinHint = joinable.getByText('Search other notification groups and ask to join.');
  expect(joinHint.classList.contains('page-hint')).toBe(true);
  expect(screen.queryByText(/tune your own overrides/)).toBeNull();
});

it('a member group row shows its name, description, member count and no delivery settings', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G1]);
  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy());

  const row = screen.getByText('Ops').closest('.dir-row') as HTMLElement;
  expect(within(row).getByText('Operations alerts')).toBeTruthy();
  expect(within(row).getByText('3')).toBeTruthy();
  expect(within(row).getByText('—')).toBeTruthy();                       // no request waiting
  // Nothing of the group's old delivery settings, categories or overrides is shown.
  for (const text of ['Email', 'No email', 'Push', 'Customized',
    'Approvals & requests', 'Wiki', 'None — inbox only']) {
    expect(within(row).queryByText(text)).toBeNull();
  }
});

it('both group lists have Group, Members and Status columns, and no Categories, Channels, Quiet hours or Days', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G1, G2, G3]);
  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Warehouse Alerts')).toBeTruthy());

  for (const name of ['My groups', 'Join a group']) {
    const list = within(region(name));
    const head = region(name).querySelector('.list-head') as HTMLElement;
    const labels = [...head.querySelectorAll('.col-head')].map((h) => h.textContent?.trim());
    expect(labels).toEqual(['Group', 'Members', 'Status', 'Actions']);
    for (const gone of ['Categories', 'Channels', 'Quiet hours', 'Days']) {
      expect(list.queryByText(gone)).toBeNull();
    }
  }
});

it('a group row has no "Edit overrides" action, only Leave', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G1]);
  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Ops')).toBeTruthy());

  fireEvent.click(within(region('My groups')).getByRole('button', { name: /Actions/ }));
  expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Leave group']);
  expect(screen.queryByRole('menuitem', { name: 'Edit overrides' })).toBeNull();
  expect(screen.queryByText(/Overrides/)).toBeNull();
});

it('a joinable group row offers Ask to join, and shows no delivery settings either', async () => {
  api.listMyNotificationGroups.mockResolvedValueOnce([G2]);
  render(<MeNotifications />);
  await waitFor(() => expect(screen.getByText('Warehouse Alerts')).toBeTruthy());

  const row = screen.getByText('Warehouse Alerts').closest('.dir-row') as HTMLElement;
  expect(within(row).getByText('Forklift and stock alerts')).toBeTruthy();
  expect(within(row).getByText('5')).toBeTruthy();
  for (const text of ['Email', 'No email', 'Push', 'Daily', 'Learning']) {
    expect(within(row).queryByText(text)).toBeNull();
  }
  fireEvent.click(within(region('Join a group')).getByRole('button', { name: /Actions/ }));
  expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Ask to join']);
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
  // Group, Members, Status: three tracks of floors, then the 88px Actions track.
  const tracks = head.style.gridTemplateColumns.split(/\s(?=minmax|\d+px)/);
  expect(tracks).toHaveLength(4);
  expect(tracks[3]).toBe('88px');
  // Floors that hold the longest values: a name with its description, and the
  // longest request chip, "Leave requested" (the row's own header floor
  // covers the count).
  expect(head.style.gridTemplateColumns).toContain('minmax(200px, ');
  expect(head.style.gridTemplateColumns).toContain(' minmax(140px, ');
  // Every cell of the row lines up with a header cell.
  expect(main.children).toHaveLength(head.children.length);
});

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

it('a failed groups load says so, without touching the switch grid', async () => {
  api.listMyNotificationGroups.mockRejectedValueOnce(new ApiError(500, 'server_error'));
  render(<MeNotifications />);
  expect(await screen.findByText('Could not load notification groups.')).toBeTruthy();
  await loaded();
  expect(screen.queryByText('Could not load notification settings.')).toBeNull();
});
