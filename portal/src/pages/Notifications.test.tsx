// @vitest-environment jsdom
/**
 * Notification groups list page — the directory-pattern list (model:
 * AssetModels.tsx). Covers what a unit test can see that the pure
 * lib/notifications.ts helpers can't: wiring of load/search/permission
 * gating and the navigate-on-row-click contract (no inline expansion).
 * Admins and above (global access, rank 60+) also get a Groups | Defaults tab
 * strip, kept in ?tab=defaults; super admins and above (rank 80+) a third tab,
 * Delivery log, kept in ?tab=log. The groups list carries no delivery columns:
 * groups only list their members.
 */

import { cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ScopeInfo } from '../lib/access';
import {
  ApiError, type MembershipRequest, type NotificationGroup, type NotificationSettings,
  type UiPreferences,
} from '../lib/api';
import { LIST_FIT, columnFloor, listScale } from '../lib/listTools';

const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importActual) => ({
  ...(await importActual<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const auth = vi.hoisted(() => {
  const state: {
    can: (resource: string, action: string) => boolean;
    maxRank: number;
    scope: ScopeInfo | null;
    listSize: 'small' | 'default' | 'large' | 'xlarge';
  } = {
    can: () => true,
    maxRank: 60,
    scope: { global: true, client_ids: [], partner_ids: [] },
    listSize: 'default',
  };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    maxRank: auth.maxRank,
    scope: auth.scope,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: auth.listSize, motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', list_view: 'expanded',
      notif: { sound: 'chime', switches: {}, schedule: { timezone: null, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], quiet_start: null, quiet_end: null } },
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
  getDeliveryLogPage: vi.fn(),
  getNotificationSettings: vi.fn(),
  updateNotificationSettings: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

/* A group is a name, a description, Active/Paused and its members. */
const GROUPS: NotificationGroup[] = [
  {
    id: 'g1', name: 'Ops Alerts', description: 'Operational issues',
    enabled: true, member_count: 5,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'g2', name: 'Weekend Oncall', description: '',
    enabled: false, member_count: 0,
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

/** What the Defaults tab loads (GET /notifications/settings). */
const SETTINGS: NotificationSettings = {
  defaults: {
    approvals: { inbox: true, email: true }, reports: { inbox: true, email: false },
    wiki: { inbox: true, email: true }, learning: { inbox: true, email: true },
    initiatives: { inbox: true, email: true }, trucks: { inbox: true, email: true },
  },
  critical_kinds: [],
  kinds: [
    { kind: 'report_ready', label: 'Report ready', category: 'reports', email: true,
      owner_always: false, critical: false, locked: false, watchable: false, everywhere: false, reaches: [] },
    { kind: 'password_expiring', label: 'Password expiring', category: 'security', email: true,
      owner_always: true, critical: true, locked: true, watchable: false, everywhere: false, reaches: [] },
  ],
};

/** Where the page opens: the router's starting URL (?tab=log, say). */
const at = { url: '/system/notifications' };

/** The current ?query, so a test can see what the tab strip wrote. */
function SearchProbe() {
  return <output data-testid="search">{useLocation().search}</output>;
}

/** Every render sits in a router (the page reads ?tab=; the log links people). */
const render = (ui: ReactElement) => rtlRender(
  <MemoryRouter initialEntries={[at.url]}>{ui}<SearchProbe /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  auth.maxRank = 60;
  auth.scope = { global: true, client_ids: [], partner_ids: [] };
  auth.listSize = 'default';
  at.url = '/system/notifications';
  api.listNotificationGroups.mockResolvedValue(GROUPS);
  api.listMembershipRequests.mockResolvedValue([]);
  api.approveMembershipRequest.mockResolvedValue(REQUESTS[0]);
  api.rejectMembershipRequest.mockResolvedValue(REQUESTS[0]);
  api.getDeliveryLogPage.mockResolvedValue({ rows: [], next_cursor: null, total: 0 });
  api.getNotificationSettings.mockResolvedValue(structuredClone(SETTINGS));
});

afterEach(cleanup);

const { default: Notifications } = await import('./Notifications');

/* ── Groups | Defaults | Delivery log ──────────────────────────────────
 * Admin and above (global access, rank 60+) see Groups and Defaults; super
 * admin and above (global access, rank 80+) also see Delivery log; everyone
 * else sees the groups with no strip. */

const GROUPS_HINT = "Notification groups and who's in them.";
const DEFAULTS_HINT = "What everyone gets until they change it, and which notifications can't wait.";
const LOG_HINT = 'Every notification and email decision — who, what and why.';

const DEFAULTS_CARD = 'What people get by default';

const superAdmin = () => {
  auth.maxRank = 80;
  auth.scope = { global: true, client_ids: [], partner_ids: [] };
};

/** [label, aria-selected] of every tab in the strip. */
const stripTabs = () => within(screen.getByRole('tablist')).getAllByRole('tab')
  .map((t) => [t.textContent, t.getAttribute('aria-selected')]);

it('admin (60, global) sees Groups and Defaults, Groups first', async () => {
  render(<Notifications />);
  await screen.findByText('Ops Alerts');
  const strip = screen.getByRole('tablist');
  expect(strip.classList.contains('subs-tabs')).toBe(true);
  expect(stripTabs()).toEqual([['Groups', 'true'], ['Defaults', 'false']]);
  expect(screen.queryByRole('tab', { name: 'Delivery log' })).toBeNull();
  expect(api.getDeliveryLogPage).not.toHaveBeenCalled();
  // the Defaults tab loads its settings only once it is opened
  expect(api.getNotificationSettings).not.toHaveBeenCalled();
});

it('a super admin with global access sees Groups, Defaults and Delivery log, in that order', async () => {
  superAdmin();
  render(<Notifications />);
  await screen.findByText('Ops Alerts');
  expect(screen.getByRole('tablist').classList.contains('subs-tabs')).toBe(true);
  expect(stripTabs()).toEqual([['Groups', 'true'], ['Defaults', 'false'], ['Delivery log', 'false']]);
  expect(api.getDeliveryLogPage).not.toHaveBeenCalled();
  expect(api.getNotificationSettings).not.toHaveBeenCalled();
});

it('rank 60 without global access sees no tab strip', async () => {
  auth.maxRank = 60;
  auth.scope = { global: false, client_ids: ['c1'], partner_ids: [] };
  render(<Notifications />);
  await screen.findByText('Ops Alerts');
  expect(screen.queryByRole('tablist')).toBeNull();
});

it('shows no tab strip to a rank-80 role without global access', async () => {
  auth.maxRank = 80;
  auth.scope = { global: false, client_ids: ['c1'], partner_ids: [] };
  render(<Notifications />);
  await screen.findByText('Ops Alerts');
  expect(screen.queryByRole('tablist')).toBeNull();
});

it('shows no tab strip below admin, even with global access', async () => {
  auth.maxRank = 40;
  render(<Notifications />);
  await screen.findByText('Ops Alerts');
  expect(screen.queryByRole('tablist')).toBeNull();
});

/** Who sees what: the strip's tabs (null: no strip) for each kind of person. */
const PEOPLE: { who: string; rank: number; global: boolean; strip: string[] | null }[] = [
  { who: 'staff (40, global)', rank: 40, global: true, strip: null },
  { who: 'admin (60) without global access', rank: 60, global: false, strip: null },
  { who: 'super admin (80) without global access', rank: 80, global: false, strip: null },
  { who: 'admin (60, global)', rank: 60, global: true, strip: ['Groups', 'Defaults'] },
  { who: 'super admin (80, global)', rank: 80, global: true, strip: ['Groups', 'Defaults', 'Delivery log'] },
  { who: 'top rank (100, global)', rank: 100, global: true, strip: ['Groups', 'Defaults', 'Delivery log'] },
];

/** The tab each ?tab value names, and a value no tab has. */
const TAB_VALUES: { value: string | null; tab: string }[] = [
  { value: null, tab: 'Groups' },
  { value: 'groups', tab: 'Groups' },
  { value: 'defaults', tab: 'Defaults' },
  { value: 'log', tab: 'Delivery log' },
  { value: 'bogus', tab: 'Groups' },
];

const HINT_OF: Record<string, string> = { Groups: GROUPS_HINT, Defaults: DEFAULTS_HINT, 'Delivery log': LOG_HINT };

it.each(PEOPLE)('$who: the strip and ?tab= (a tab they cannot see falls back to Groups)', async ({ rank, global, strip }) => {
  auth.maxRank = rank;
  auth.scope = { global, client_ids: global ? [] : ['c1'], partner_ids: [] };

  for (const { value, tab } of TAB_VALUES) {
    cleanup();
    vi.clearAllMocks();
    at.url = value === null ? '/system/notifications' : `/system/notifications?tab=${value}`;
    render(<Notifications />);

    const shown = strip?.includes(tab) ? tab : 'Groups';
    if (strip === null) expect(screen.queryByRole('tablist')).toBeNull();
    else expect(stripTabs()).toEqual(strip.map((label) => [label, String(label === shown)]));
    expect(screen.getByText(HINT_OF[shown]).className).toContain('page-hint');

    // and the tab's own content is what is on the page
    if (shown === 'Groups') {
      expect(await screen.findByText('Ops Alerts')).toBeTruthy();
      expect(screen.queryByRole('region', { name: DEFAULTS_CARD })).toBeNull();
      expect(api.getNotificationSettings).not.toHaveBeenCalled();
      expect(api.getDeliveryLogPage).not.toHaveBeenCalled();
    } else if (shown === 'Defaults') {
      expect(await screen.findByRole('region', { name: DEFAULTS_CARD })).toBeTruthy();
      expect(screen.queryByText('Ops Alerts')).toBeNull();
      expect(api.getDeliveryLogPage).not.toHaveBeenCalled();
    } else {
      expect(await screen.findByRole('button', { name: 'Check delivery' })).toBeTruthy();
      expect(screen.queryByText('Ops Alerts')).toBeNull();
      expect(api.getNotificationSettings).not.toHaveBeenCalled();
    }
  }
});

it('?tab=defaults for a non-admin falls back to the groups list', async () => {
  auth.maxRank = 40;
  at.url = '/system/notifications?tab=defaults';
  render(<Notifications />);
  expect(await screen.findByText('Ops Alerts')).toBeTruthy();
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.queryByRole('region', { name: DEFAULTS_CARD })).toBeNull();
  expect(screen.getByText(GROUPS_HINT)).toBeTruthy();
  expect(screen.queryByText(DEFAULTS_HINT)).toBeNull();
  expect(api.getNotificationSettings).not.toHaveBeenCalled();
});

it('?tab=log below super admin falls back to the groups list', async () => {
  at.url = '/system/notifications?tab=log';
  render(<Notifications />);
  expect(await screen.findByText('Ops Alerts')).toBeTruthy();
  expect(stripTabs()).toEqual([['Groups', 'true'], ['Defaults', 'false']]);
  expect(screen.queryByText(LOG_HINT)).toBeNull();
  expect(api.getDeliveryLogPage).not.toHaveBeenCalled();
});

it('?tab=defaults opens the Defaults tab for an admin, and the header describes it', async () => {
  at.url = '/system/notifications?tab=defaults';
  render(<Notifications />);
  expect(screen.getByRole('tab', { name: 'Defaults' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText(DEFAULTS_HINT).className).toContain('page-hint');
  expect(screen.queryByText(GROUPS_HINT)).toBeNull();
  expect(await screen.findByRole('region', { name: DEFAULTS_CARD })).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Critical notifications' })).toBeTruthy();
  // none of the groups list is on this tab
  expect(screen.queryByText('Ops Alerts')).toBeNull();
  expect(screen.queryByRole('button', { name: /New group/i })).toBeNull();
  expect(screen.queryByPlaceholderText('Filter this list…')).toBeNull();
  // there is no list to count here, so the header carries no count
  expect(document.querySelector('.badge-count')).toBeNull();
});

it('?tab=log opens the Delivery log for a super admin, and the header describes it', async () => {
  superAdmin();
  at.url = '/system/notifications?tab=log';
  api.getDeliveryLogPage.mockResolvedValue({ rows: [], next_cursor: null, total: 1234 });
  render(<Notifications />);
  expect(screen.getByRole('tab', { name: 'Delivery log' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText(LOG_HINT).className).toContain('page-hint');
  expect(screen.queryByText(GROUPS_HINT)).toBeNull();
  await waitFor(() => expect(api.getDeliveryLogPage).toHaveBeenCalled());
  // the header count follows the log, not the groups
  await waitFor(() => expect(document.querySelector('.badge-count')?.textContent).toBe('1234'));
  expect(screen.queryByText('Ops Alerts')).toBeNull();
  expect(screen.queryByRole('button', { name: /New group/i })).toBeNull();
});

it('the tabs switch views and keep the choice in ?tab=', async () => {
  superAdmin();
  const user = userEvent.setup();
  render(<Notifications />);
  await screen.findByText('Ops Alerts');
  expect(screen.getByText(GROUPS_HINT)).toBeTruthy();

  await user.click(screen.getByRole('tab', { name: 'Defaults' }));
  expect(screen.getByTestId('search').textContent).toBe('?tab=defaults');
  expect(screen.getByRole('tab', { name: 'Defaults' }).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByRole('region', { name: DEFAULTS_CARD })).toBeTruthy();
  expect(screen.getByText(DEFAULTS_HINT)).toBeTruthy();
  expect(screen.queryByText('Ops Alerts')).toBeNull();
  expect(document.querySelector('.badge-count')).toBeNull();

  await user.click(screen.getByRole('tab', { name: 'Delivery log' }));
  expect(screen.getByTestId('search').textContent).toBe('?tab=log');
  expect(screen.getByRole('tab', { name: 'Delivery log' }).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByRole('button', { name: 'Check delivery' })).toBeTruthy();
  expect(screen.getByText(LOG_HINT)).toBeTruthy();
  expect(screen.queryByRole('region', { name: DEFAULTS_CARD })).toBeNull();
  expect(screen.queryByText('Ops Alerts')).toBeNull();

  await user.click(screen.getByRole('tab', { name: 'Groups' }));
  expect(screen.getByTestId('search').textContent).toBe('');
  expect(await screen.findByText('Ops Alerts')).toBeTruthy();
  expect(screen.getByText(GROUPS_HINT)).toBeTruthy();
  expect(document.querySelector('.badge-count')?.textContent).toBe('2');
});

it('an admin switches between Groups and Defaults', async () => {
  const user = userEvent.setup();
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('tab', { name: 'Defaults' }));
  expect(screen.getByTestId('search').textContent).toBe('?tab=defaults');
  expect(await screen.findByRole('region', { name: DEFAULTS_CARD })).toBeTruthy();

  await user.click(screen.getByRole('tab', { name: 'Groups' }));
  expect(screen.getByTestId('search').textContent).toBe('');
  expect(await screen.findByText('Ops Alerts')).toBeTruthy();
  expect(screen.queryByRole('region', { name: DEFAULTS_CARD })).toBeNull();
});

it('pending requests stay with the groups, under the page header', async () => {
  superAdmin();
  const user = userEvent.setup();
  api.listMembershipRequests.mockResolvedValue(REQUESTS);
  render(<Notifications />);
  const panel = (await screen.findByText('Pending requests')).closest('.panel') as HTMLElement;
  const head = document.querySelector('.dir-head') as HTMLElement;
  expect(head.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  await user.click(screen.getByRole('tab', { name: 'Defaults' }));
  expect(screen.queryByText('Pending requests')).toBeNull();

  await user.click(screen.getByRole('tab', { name: 'Delivery log' }));
  expect(screen.queryByText('Pending requests')).toBeNull();
});

it('renders rows from the loaded groups', async () => {
  render(<Notifications />);
  expect(await screen.findByText('Ops Alerts')).not.toBeNull();
  expect(screen.getByText('Weekend Oncall')).not.toBeNull();
});

it('notification groups: column floors, shared template + minimum, sideways-scroll card', async () => {
  render(<Notifications />);
  const row = (await screen.findByText('Ops Alerts')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
  // Every default column's header sits in the template, so the fit above covers them all.
  expect(within(head).getByRole('button', { name: 'Status' })).not.toBeNull();
});

it('group-list floors hold their longest values at the 1512px reference width', async () => {
  const user = userEvent.setup();
  render(<Notifications />);
  const row = (await screen.findByText('Ops Alerts')).closest('.dir-row') as HTMLElement;
  const head = row.closest('.dir-list')?.querySelector('.list-head') as HTMLElement;
  const tracks = head.style.gridTemplateColumns;
  expect(tracks.startsWith('minmax(184px, 1.3fr) ')).toBe(true);   // Name: "Destination Side Ops Team"
  // The Categories (156px) and Quiet hours (168px) floors went with their columns.
  expect(tracks).not.toContain('156px');
  expect(tracks).not.toContain('168px');
  // Created is off by default (spec §6); Columns still offers it.
  expect(within(head).queryByRole('button', { name: 'Created' })).toBeNull();
  expect(within(row).queryByText(new Date(GROUPS[0].created_at).toLocaleDateString())).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Columns' }));
  const popover = screen.getByText('Visible columns').parentElement as HTMLElement;
  const created = within(popover).getByRole('button', { name: 'Created' });
  expect(created.classList.contains('on')).toBe(false);
  await user.click(created);
  await waitFor(() => expect(within(head).getByRole('button', { name: 'Created' })).not.toBeNull());
});

/** The Members track's floor in px: Name, Description and Members are the three
 *  `minmax(floor, fr)` tracks (Status and the chevron are fixed). */
async function membersFloor(): Promise<{ floor: number; head: HTMLElement }> {
  const row = (await screen.findByText('Ops Alerts')).closest('.dir-row') as HTMLElement;
  const head = row.closest('.dir-list')?.querySelector('.list-head') as HTMLElement;
  const tracks = [...head.style.gridTemplateColumns.matchAll(/minmax\((\d+)px, ([\d.]+)fr\)/g)];
  expect(tracks).toHaveLength(3);
  return { floor: Number(tracks[2][1]), head };
}

it('the Members track holds its header: a 60px track clipped it to "MEMBE"', async () => {
  render(<Notifications />);
  const { floor, head } = await membersFloor();

  // Measured in Chromium at the default list size, with the real fonts: "MEMBERS" and the
  // column menu's funnel need 75px, and 87px once the list is sorted by Members (the sort caret
  // joins the label). columnFloor's own 82px cuts the caret, so the floor must clear 87px.
  expect(floor).toBeGreaterThanOrEqual(87);
  expect(floor).toBeGreaterThanOrEqual(columnFloor({ key: 'members', label: 'Members', width: '', default: true }));
  // ...and the list still fits the 1512px reference width.
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

it('the Members floor grows with the list size, so the header holds at the larger sizes too', async () => {
  auth.listSize = 'xlarge';
  render(<Notifications />);
  const { floor } = await membersFloor();

  // Measured at xlarge: the sorted header needs 105px. A fixed px track would stay at its default width.
  expect(floor).toBe(Math.ceil(92 * listScale('xlarge')));
  expect(floor).toBeGreaterThanOrEqual(105);
});

/** A group row with a few fields overridden. */
const group = (over: Partial<NotificationGroup>): NotificationGroup => ({ ...GROUPS[0], ...over });

const rowOf = async (name: string) => (await screen.findByText(name)).closest('.dir-row') as HTMLElement;

/** Names of the rendered rows, top to bottom. */
const rowNames = () => [...document.querySelectorAll('.dir-row .cell-top b')].map((b) => b.textContent);

/** The header labels of the shown columns, left to right (without the sort caret). */
const headerLabels = (head: HTMLElement) =>
  [...head.querySelectorAll('button.sortable')].map((b) => b.textContent?.replace(/[▲▼]/, '').trim());

const DELIVERY_COLUMNS = ['Categories', 'Channels', 'Quiet hours', 'Days'];

it('the columns are Name, Description, Members and Status: none of the delivery columns', async () => {
  const user = userEvent.setup();
  render(<Notifications />);
  const row = await rowOf('Ops Alerts');
  const head = row.closest('.dir-list')?.querySelector('.list-head') as HTMLElement;

  const labels = headerLabels(head);
  expect(labels).toEqual(['Name', 'Description', 'Members', 'Status']);
  for (const label of DELIVERY_COLUMNS) expect(labels).not.toContain(label);
  expect(within(head).queryByRole('button', { name: /Categories|Channels|Quiet hours|Days/ })).toBeNull();

  // the Columns menu offers the same set, plus Created (off by default)
  await user.click(screen.getByRole('button', { name: 'Columns' }));
  const popover = screen.getByText('Visible columns').parentElement as HTMLElement;
  expect(within(popover).getAllByRole('button').map((b) => b.textContent?.trim()))
    .toEqual(['Name', 'Description', 'Members', 'Status', 'Created']);
});

it('a group row shows its name, description, members and status, and no chips', async () => {
  render(<Notifications />);
  const row = await rowOf('Ops Alerts');
  expect(row.querySelector('.chips')).toBeNull();
  // what is left: name, description, members, status
  expect(row.textContent).toContain('Operational issues');
  expect(within(row).getByText('5')).not.toBeNull();
  expect(within(row).getByText('Enabled')).not.toBeNull();
});

/** Open the toolbar Filters popover and return it. */
async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Filters/ }));
  return screen.getByText('Status', { selector: '.pop-title' }).closest('.pop-menu') as HTMLElement;
}

it('Filters offers Status only: no Channels or Categories', async () => {
  const user = userEvent.setup();
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  const menu = await openFilters(user);
  expect([...menu.querySelectorAll('.pop-title')].map((t) => t.textContent)).toEqual(['Status']);
  expect([...menu.querySelectorAll('.pop-item')].map((i) => i.textContent)).toEqual(['Enabled', 'Paused']);
});

it('the Status filter keeps the enabled or the paused groups', async () => {
  const user = userEvent.setup();
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  const menu = await openFilters(user);
  await user.click(within(menu).getByRole('button', { name: 'Paused' }));
  expect(rowNames()).toEqual(['Weekend Oncall']);

  await user.click(within(menu).getByRole('button', { name: 'Paused' })); // off again
  await user.click(within(menu).getByRole('button', { name: 'Enabled' }));
  expect(rowNames()).toEqual(['Ops Alerts']);
});

it('search matches the name, the description and the status', async () => {
  const user = userEvent.setup();
  api.listNotificationGroups.mockResolvedValue([
    group({ id: 'g3', name: 'Group A', description: 'Description A', enabled: true }),
    group({ id: 'g4', name: 'Group B', description: 'Description B', enabled: false }),
  ]);
  render(<Notifications />);
  await screen.findByText('Group A');

  const box = screen.getByPlaceholderText('Filter this list…');
  await user.type(box, 'description a');
  expect(rowNames()).toEqual(['Group A']);

  await user.clear(box);
  await user.type(box, 'paused');
  expect(rowNames()).toEqual(['Group B']);

  // a term in none of the three
  await user.clear(box);
  await user.type(box, 'Group C');
  expect(rowNames()).toEqual([]);
  expect(screen.getByText('No matches')).not.toBeNull();
});

it('exports ID, Name, Description, Members, Status and Created, and nothing of delivery', async () => {
  api.listNotificationGroups.mockResolvedValue([
    group({ id: 'g3', name: 'Group A', description: 'Description A', member_count: 3, enabled: true,
      created_at: '2026-03-01T00:00:00Z' }),
    group({ id: 'g4', name: 'Group B', description: '', member_count: 0, enabled: false,
      created_at: '2026-04-01T00:00:00Z' }),
  ]);
  let blob: Blob | null = null;
  const prevCreate = URL.createObjectURL;
  const prevRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn((b: Blob) => { blob = b; return 'blob:groups'; }) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  try {
    const user = userEvent.setup();
    render(<Notifications />);
    await screen.findByText('Group A');
    await user.click(screen.getByRole('button', { name: /Export/ }));

    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob as unknown as Blob);
    });
    const [header, ...rows] = text.split('\n').map((line) => line.split(','));
    expect(header).toEqual(['ID', 'Name', 'Description', 'Members', 'Status', 'Created']);
    for (const label of [...DELIVERY_COLUMNS, 'Timezone']) expect(header).not.toContain(label);
    expect(rows).toEqual([
      ['g3', 'Group A', 'Description A', '3', 'Enabled', '2026-03-01T00:00:00Z'],
      ['g4', 'Group B', '', '0', 'Paused', '2026-04-01T00:00:00Z'],
    ]);
  } finally {
    clickSpy.mockRestore();
    URL.createObjectURL = prevCreate;
    URL.revokeObjectURL = prevRevoke;
  }
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

it('New group opens a dialog with the standard header', async () => {
  const user = userEvent.setup();
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('button', { name: /New group/i }));
  const dialog = screen.getByRole('dialog', { name: 'New notification group' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Notifications');
  expect(within(dialog).getByRole('heading', { name: 'New notification group' })).not.toBeNull();
  expect(within(dialog).getByText('Name the group. Members come next.').className)
    .toContain('page-hint');
  expect(within(dialog).queryByText(/delivery settings/i)).toBeNull();
  expect(dialog.classList.contains('rgm-card')).toBe(true);
  expect(within(dialog).getByRole('button', { name: 'Create group' })).not.toBeNull();
});

it('creating a group posts the trimmed name and description, then opens its page', async () => {
  const user = userEvent.setup();
  api.createNotificationGroup.mockResolvedValue({ ...GROUPS[0], id: 'g9', name: 'Night Desk' });
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('button', { name: /New group/i }));
  const dialog = screen.getByRole('dialog', { name: 'New notification group' });
  await user.type(within(dialog).getByLabelText('Name *'), '  Night Desk ');
  await user.type(within(dialog).getByLabelText('Description'), 'After hours');
  await user.click(within(dialog).getByRole('button', { name: 'Create group' }));

  await waitFor(() => expect(api.createNotificationGroup)
    .toHaveBeenCalledWith({ name: 'Night Desk', description: 'After hours' }));
  await waitFor(() => expect(navigate).toHaveBeenCalledWith('/system/notifications/g9'));
  expect(screen.queryByRole('dialog', { name: 'New notification group' })).toBeNull();
});

it('the Create button submits the form, so a name is required and Enter in a field creates', async () => {
  const user = userEvent.setup();
  api.createNotificationGroup.mockResolvedValue({ ...GROUPS[0], id: 'g9', name: 'Night Desk' });
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('button', { name: /New group/i }));
  const dialog = screen.getByRole('dialog', { name: 'New notification group' });
  const name = within(dialog).getByLabelText('Name *');
  const create = within(dialog).getByRole('button', { name: 'Create group' }) as HTMLButtonElement;
  // The button lives in the dialog's footer, outside the form; the `form`
  // attribute makes it the form's default button (what Enter presses).
  const form = name.closest('form') as HTMLFormElement;
  expect(form.contains(create)).toBe(false);
  expect(create.type).toBe('submit');
  expect(create.getAttribute('form')).toBe(form.id);
  expect(form.id).not.toBe('');

  await user.click(create);
  expect(api.createNotificationGroup).not.toHaveBeenCalled();   // Name is required

  await user.type(name, 'Night Desk');
  await user.click(create);
  await waitFor(() => expect(api.createNotificationGroup)
    .toHaveBeenCalledWith({ name: 'Night Desk', description: '' }));
});

it('a duplicate name shows the server error beside the buttons and keeps the dialog open', async () => {
  const user = userEvent.setup();
  api.createNotificationGroup.mockRejectedValue(new ApiError(409, 'group_exists'));
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('button', { name: /New group/i }));
  const dialog = screen.getByRole('dialog', { name: 'New notification group' });
  await user.type(within(dialog).getByLabelText('Name *'), 'Ops Alerts');
  await user.click(within(dialog).getByRole('button', { name: 'Create group' }));

  const message = await within(dialog).findByText('A group with that name already exists.');
  expect(message.closest('.modal-foot')).not.toBeNull();
  expect(navigate).not.toHaveBeenCalled();
});

it('Cancel closes the New group dialog without creating anything', async () => {
  const user = userEvent.setup();
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('button', { name: /New group/i }));
  await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.createNotificationGroup).not.toHaveBeenCalled();
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

it('the empty state is the bold title alone: a group no longer defines who is notified or how', async () => {
  api.listNotificationGroups.mockResolvedValue([]);
  render(<Notifications />);
  const title = await screen.findByText('No notification groups yet');

  expect(title.tagName).toBe('B');
  expect((title.closest('.dir-empty') as HTMLElement).textContent).toBe('No notification groups yet');
  expect(screen.queryByText(/define who gets notified/i)).toBeNull();
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
