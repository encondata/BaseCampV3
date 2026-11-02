// @vitest-environment jsdom
/**
 * Notification groups list page — the directory-pattern list (model:
 * AssetModels.tsx). Covers what a unit test can see that the pure
 * lib/notifications.ts helpers can't: wiring of load/search/permission
 * gating and the navigate-on-row-click contract (no inline expansion).
 * Super admins and above (global access, rank 80+) also get a Groups |
 * Delivery log tab strip, kept in ?tab=log.
 */

import { cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ScopeInfo } from '../lib/access';
import { ApiError, type MembershipRequest, type NotificationGroup, type UiPreferences } from '../lib/api';
import { LIST_FIT } from '../lib/listTools';

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
  } = {
    can: () => true,
    maxRank: 60,
    scope: { global: true, client_ids: [], partner_ids: [] },
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
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', list_view: 'expanded',
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
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const GROUPS: NotificationGroup[] = [
  {
    id: 'g1', name: 'Ops Alerts', description: 'Operational issues',
    channels: ['email', 'push'], categories: ['approvals'], quiet_start: '21:00:00', quiet_end: '07:00:00',
    timezone: 'America/Chicago', active_days: ['mon', 'tue', 'wed', 'thu', 'fri'],
    dnd_behavior: 'defer', urgent_bypass: true, enabled: true, member_count: 5,
    created_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'g2', name: 'Weekend Oncall', description: '',
    channels: [], categories: [], quiet_start: null, quiet_end: null,
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
  at.url = '/system/notifications';
  api.listNotificationGroups.mockResolvedValue(GROUPS);
  api.listMembershipRequests.mockResolvedValue([]);
  api.approveMembershipRequest.mockResolvedValue(REQUESTS[0]);
  api.rejectMembershipRequest.mockResolvedValue(REQUESTS[0]);
  api.getDeliveryLogPage.mockResolvedValue({ rows: [], next_cursor: null, total: 0 });
});

afterEach(cleanup);

const { default: Notifications } = await import('./Notifications');

/* ── Groups | Delivery log (super admin and above) ─────────────────── */

const superAdmin = () => {
  auth.maxRank = 80;
  auth.scope = { global: true, client_ids: [], partner_ids: [] };
};

it('shows no tab strip to an admin (rank 60)', async () => {
  render(<Notifications />);
  await screen.findByText('Ops Alerts');
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.queryByRole('tab', { name: 'Delivery log' })).toBeNull();
});

it('shows Groups | Delivery log to a super admin with global access, Groups first', async () => {
  superAdmin();
  render(<Notifications />);
  await screen.findByText('Ops Alerts');
  const strip = screen.getByRole('tablist');
  expect(strip.classList.contains('subs-tabs')).toBe(true);
  expect(within(strip).getAllByRole('tab').map((t) => [t.textContent, t.getAttribute('aria-selected')]))
    .toEqual([['Groups', 'true'], ['Delivery log', 'false']]);
  expect(api.getDeliveryLogPage).not.toHaveBeenCalled();
});

it('shows no tab strip to a rank-80 role without global access', async () => {
  auth.maxRank = 80;
  auth.scope = { global: false, client_ids: ['c1'], partner_ids: [] };
  render(<Notifications />);
  await screen.findByText('Ops Alerts');
  expect(screen.queryByRole('tablist')).toBeNull();
});

it('?tab=log below super admin falls back to the groups list', async () => {
  at.url = '/system/notifications?tab=log';
  render(<Notifications />);
  expect(await screen.findByText('Ops Alerts')).toBeTruthy();
  expect(screen.queryByRole('tablist')).toBeNull();
  expect(screen.queryByText('Every notification and email decision — who, what and why.')).toBeNull();
  expect(api.getDeliveryLogPage).not.toHaveBeenCalled();
});

it('?tab=log opens the Delivery log for a super admin, and the header describes it', async () => {
  superAdmin();
  at.url = '/system/notifications?tab=log';
  api.getDeliveryLogPage.mockResolvedValue({ rows: [], next_cursor: null, total: 1234 });
  render(<Notifications />);
  expect(screen.getByRole('tab', { name: 'Delivery log' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText('Every notification and email decision — who, what and why.').className)
    .toContain('page-hint');
  expect(screen.queryByText('Notification groups — who gets notified, how, and when.')).toBeNull();
  await waitFor(() => expect(api.getDeliveryLogPage).toHaveBeenCalled());
  // the header count follows the log, not the groups
  await waitFor(() => expect(document.querySelector('.badge-count')?.textContent).toBe('1234'));
  expect(screen.queryByText('Ops Alerts')).toBeNull();
  expect(screen.queryByRole('button', { name: /New group/i })).toBeNull();
});

it('the tabs switch views and keep the choice in ?tab=log', async () => {
  superAdmin();
  const user = userEvent.setup();
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  await user.click(screen.getByRole('tab', { name: 'Delivery log' }));
  expect(screen.getByTestId('search').textContent).toBe('?tab=log');
  expect(screen.getByRole('tab', { name: 'Delivery log' }).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByRole('button', { name: 'Check delivery' })).toBeTruthy();
  expect(screen.queryByText('Ops Alerts')).toBeNull();

  await user.click(screen.getByRole('tab', { name: 'Groups' }));
  expect(screen.getByTestId('search').textContent).toBe('');
  expect(await screen.findByText('Ops Alerts')).toBeTruthy();
  expect(document.querySelector('.badge-count')?.textContent).toBe('2');
});

it('pending requests stay with the groups, under the page header', async () => {
  superAdmin();
  const user = userEvent.setup();
  api.listMembershipRequests.mockResolvedValue(REQUESTS);
  render(<Notifications />);
  const panel = (await screen.findByText('Pending requests')).closest('.panel') as HTMLElement;
  const head = document.querySelector('.dir-head') as HTMLElement;
  expect(head.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

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
  // The Categories column is on by default, so the fit above covers it.
  expect(within(head).getByRole('button', { name: 'Categories' })).not.toBeNull();
});

it('group-list floors hold their longest values at the 1512px reference width', async () => {
  const user = userEvent.setup();
  render(<Notifications />);
  const row = (await screen.findByText('Ops Alerts')).closest('.dir-row') as HTMLElement;
  const head = row.closest('.dir-list')?.querySelector('.list-head') as HTMLElement;
  const tracks = head.style.gridTemplateColumns;
  expect(tracks.startsWith('minmax(184px, 1.3fr) ')).toBe(true);   // Name: "Destination Side Ops Team"
  expect(tracks).toContain(' minmax(156px, 1.6fr) ');              // Categories: "Approvals & requests"
  expect(tracks).toContain(' minmax(168px, 1.2fr) ');              // Quiet hours: "12:00 AM – 12:00 AM CT"
  // Created is off by default, to leave Name the room; Columns still offers it.
  expect(within(head).queryByRole('button', { name: 'Created' })).toBeNull();
  expect(within(row).queryByText(new Date(GROUPS[0].created_at).toLocaleDateString())).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Columns' }));
  const popover = screen.getByText('Visible columns').parentElement as HTMLElement;
  const created = within(popover).getByRole('button', { name: 'Created' });
  expect(created.classList.contains('on')).toBe(false);
  await user.click(created);
  await waitFor(() => expect(within(head).getByRole('button', { name: 'Created' })).not.toBeNull());
});

/** A group row with a few fields overridden, for the channel/category tests. */
const group = (over: Partial<NotificationGroup>): NotificationGroup => ({ ...GROUPS[0], ...over });

/** The chip labels inside the chips container that holds `text` in `row`. */
const chipsHolding = (row: HTMLElement, text: string): (string | null)[] => {
  const chips = within(row).getByText(text).closest('.chips') as HTMLElement;
  return [...chips.children].map((c) => c.textContent);
};

const rowOf = async (name: string) => (await screen.findByText(name)).closest('.dir-row') as HTMLElement;

/** Names of the rendered rows, top to bottom. */
const rowNames = () => [...document.querySelectorAll('.dir-row .cell-top b')].map((b) => b.textContent);

it('lists each group\'s categories as chips in registry order, or says inbox only', async () => {
  api.listNotificationGroups.mockResolvedValue([
    group({ id: 'g3', name: 'Docs Team', categories: ['wiki', 'approvals'] }),
    group({ id: 'g4', name: 'Quiet Team', categories: [] }),
  ]);
  render(<Notifications />);

  const docs = await rowOf('Docs Team');
  expect(chipsHolding(docs, 'Wiki')).toEqual(['Approvals & requests', 'Wiki']);
  // A chip cut short at a narrow width still names its category on hover.
  expect(within(docs).getByText('Approvals & requests').title).toBe('Approvals & requests');
  expect(within(docs).getByText('Wiki').title).toBe('Wiki');
  const quiet = await rowOf('Quiet Team');
  expect(within(quiet).getByText('None — inbox only').className).toContain('c-slate');
  expect(within(quiet).getByText('None — inbox only').title).toBe('None — inbox only');
});

it('shows only the channels that can send, or a No email chip', async () => {
  api.listNotificationGroups.mockResolvedValue([
    group({ id: 'g3', name: 'Mixed Channels', channels: ['email', 'web', 'text'] }),
    group({ id: 'g4', name: 'Text Only', channels: ['text', 'push'] }),
  ]);
  render(<Notifications />);

  const mixed = await rowOf('Mixed Channels');
  expect(chipsHolding(mixed, 'Email')).toEqual(['Email']);
  expect(within(mixed).getByText('Email').className).toContain('c-blue');
  const textOnly = await rowOf('Text Only');
  expect(within(textOnly).getByText('No email').className).toContain('c-slate');
  for (const hidden of ['Text (SMS)', 'Push', 'Web']) {
    expect(screen.queryByText(hidden)).toBeNull();
  }
});

/** Open the toolbar Filters popover and return it. */
async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Filters/ }));
  return screen.getByText('Categories', { selector: '.pop-title' }).closest('.pop-menu') as HTMLElement;
}

it('Filters offers live channels plus No email, and every category plus None', async () => {
  const user = userEvent.setup();
  render(<Notifications />);
  await screen.findByText('Ops Alerts');

  const menu = await openFilters(user);
  const optionsAfter = (title: string) => {
    const options: (string | null)[] = [];
    for (let el = screen.getByText(title, { selector: '.pop-title' }).nextElementSibling;
      el && el.classList.contains('pop-item'); el = el.nextElementSibling) options.push(el.textContent);
    return options;
  };
  expect(optionsAfter('Channels')).toEqual(['Email', 'No email']);
  expect(optionsAfter('Categories')).toEqual([
    'Approvals & requests', 'Reports & labels', 'Wiki', 'Learning', 'Account security', 'None',
  ]);
  for (const hidden of ['Text (SMS)', 'Push', 'Web']) {
    expect(within(menu).queryByRole('button', { name: hidden })).toBeNull();
  }
});

it('the Categories filter keeps groups that cover a category, and None keeps those with none', async () => {
  const user = userEvent.setup();
  api.listNotificationGroups.mockResolvedValue([
    group({ id: 'g3', name: 'Docs Team', categories: ['wiki', 'approvals'] }),
    group({ id: 'g4', name: 'Learning Team', categories: ['learning'] }),
    group({ id: 'g5', name: 'Quiet Team', categories: [] }),
  ]);
  render(<Notifications />);
  await screen.findByText('Docs Team');

  const menu = await openFilters(user);
  await user.click(within(menu).getByRole('button', { name: 'Wiki' }));
  expect(rowNames()).toEqual(['Docs Team']);

  await user.click(within(menu).getByRole('button', { name: 'Wiki' })); // off again
  await user.click(within(menu).getByRole('button', { name: 'None' }));
  expect(rowNames()).toEqual(['Quiet Team']);
});

it('the Channels filter has No email for groups that cannot email, and ignores hidden channels', async () => {
  const user = userEvent.setup();
  api.listNotificationGroups.mockResolvedValue([
    group({ id: 'g3', name: 'Emailing Team', channels: ['email', 'web'] }),
    group({ id: 'g4', name: 'Pushing Team', channels: ['push'] }),
    group({ id: 'g5', name: 'Silent Team', channels: [] }),
  ]);
  render(<Notifications />);
  await screen.findByText('Emailing Team');

  const menu = await openFilters(user);
  await user.click(within(menu).getByRole('button', { name: 'No email' }));
  expect(rowNames()).toEqual(['Pushing Team', 'Silent Team']);

  await user.click(within(menu).getByRole('button', { name: 'No email' })); // off again
  await user.click(within(menu).getByRole('button', { name: 'Email' }));
  expect(rowNames()).toEqual(['Emailing Team']);
});

it('search finds a category by its label, and does not find a hidden channel', async () => {
  const user = userEvent.setup();
  api.listNotificationGroups.mockResolvedValue([
    group({ id: 'g3', name: 'Docs Team', categories: ['wiki'], channels: ['email', 'push'] }),
    group({ id: 'g4', name: 'Other Team', categories: ['learning'], channels: ['email'] }),
  ]);
  render(<Notifications />);
  await screen.findByText('Docs Team');

  const box = screen.getByPlaceholderText('Filter this list…');
  await user.type(box, 'wiki');
  expect(rowNames()).toEqual(['Docs Team']);

  await user.clear(box);
  await user.type(box, 'push');
  expect(rowNames()).toEqual([]);
  expect(screen.getByText('No matches')).not.toBeNull();
});

it('sorts by the Categories column', async () => {
  const user = userEvent.setup();
  api.listNotificationGroups.mockResolvedValue([
    group({ id: 'g3', name: 'Docs Team', categories: ['wiki'] }),
    group({ id: 'g4', name: 'Alpha Team', categories: ['approvals'] }),
    group({ id: 'g5', name: 'Quiet Team', categories: [] }),
  ]);
  render(<Notifications />);
  await screen.findByText('Docs Team');
  expect(rowNames()).toEqual(['Alpha Team', 'Docs Team', 'Quiet Team']); // by name

  // Held once: after a click the header's name gains the sort caret.
  const header = screen.getByRole('button', { name: 'Categories' });
  await user.click(header);
  expect(rowNames()).toEqual(['Quiet Team', 'Alpha Team', 'Docs Team']);

  await user.click(header);
  expect(rowNames()).toEqual(['Docs Team', 'Alpha Team', 'Quiet Team']);
});

it('exports live channels and a Categories column', async () => {
  api.listNotificationGroups.mockResolvedValue([
    group({ id: 'g3', name: 'Docs Team', channels: ['email', 'text'], categories: ['wiki', 'approvals'] }),
    group({ id: 'g4', name: 'Quiet Team', channels: ['push'], categories: [] }),
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
    await screen.findByText('Docs Team');
    await user.click(screen.getByRole('button', { name: /Export/ }));

    const text = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsText(blob as unknown as Blob);
    });
    const [header, ...rows] = text.split('\n').map((line) => line.split(','));
    const cell = (row: string[], name: string) => row[header.indexOf(name)];
    expect(cell(rows[0], 'Name')).toBe('Docs Team');
    expect(cell(rows[0], 'Channels')).toBe('Email');
    expect(cell(rows[0], 'Categories')).toBe('Approvals & requests; Wiki');
    expect(cell(rows[1], 'Name')).toBe('Quiet Team');
    expect(cell(rows[1], 'Channels')).toBe('No email');
    expect(cell(rows[1], 'Categories')).toBe('None');
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
  expect(within(dialog).getByText('Name the group. Delivery settings and members come next.').className)
    .toContain('page-hint');
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
