// @vitest-environment jsdom
/**
 * /admin/status-rules — page shell + Rules tab. Covers what a unit test
 * can see: schema-resolved trigger chip labels, priority sort, the add
 * button's permission gate, the enabled switch's toggle+reload round
 * trip, and the load-error banner; and the tab bar: the tab and the rule
 * the Executions tab lists live in the URL (?tab=executions&rule=<id>), and
 * follow it when it moves. The editor modal itself (create/edit,
 * schema-driven condition/action builder) is covered in
 * components/statusRules/RuleEditorModal.test.tsx.
 */

import { act, cleanup, render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError,
  type NotificationGroup, type NotificationRecipient, type StatusRule, type StatusRuleExecStat,
  type StatusRuleExecution, type StatusRuleSchema, type UiPreferences,
} from '../lib/api';
import { LIST_FIT } from '../lib/listTools';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action: string) => boolean } = {
    can: () => true,
  };
  return state;
});

const updatePreferences = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', list_view: 'expanded',
      notif: { sound: 'chime', switches: {}, schedule: { timezone: null, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], quiet_start: null, quiet_end: null } },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences,
  }),
}));

const api = vi.hoisted(() => ({
  listStatusRules: vi.fn(),
  listStatusRuleExecutions: vi.fn(),
  getStatusRuleSchema: vi.fn(),
  getStatusRuleExecStats: vi.fn(),
  toggleStatusRule: vi.fn(),
  createStatusRule: vi.fn(),
  deleteStatusRule: vi.fn(),
  listNotificationRecipients: vi.fn(),
  listNotificationGroups: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const SCHEMA: StatusRuleSchema = {
  trigger_statuses: [
    { value: 'in_transit', label: 'In Transit', color: '#3b82f6' },
    { value: 'delivered', label: 'Delivered', color: '#22c55e' },
  ],
  match_types: [
    { value: 'exact', label: 'Exact' },
    { value: 'fuzzy', label: 'Fuzzy' },
  ],
  operators: [{ key: 'eq', label: 'is', needs_value: true }],
  condition_fields: [{ key: 'site', label: 'Site', type: 'string' }],
  actions: [{
    key: 'notify', label: 'Send a notification',
    params: [
      { name: 'people', type: 'people' },
      { name: 'groups', type: 'groups' },
      { name: 'watchers', type: 'bool' },
    ],
  }],
  sites: [],
};

const PEOPLE: NotificationRecipient[] = [{
  person_id: 'p1', display_name: 'Person A', job_title: null, avatar_url: null, email: null,
  phone: null, has_account: true, can_email: true, can_text: false, can_push: true, can_web: true,
}];
const GROUPS: NotificationGroup[] = [{
  id: 'g1', name: 'Group A', description: '', enabled: true, member_count: 2,
  created_at: '2026-01-01T00:00:00Z',
}];

const RULES: StatusRule[] = [
  {
    id: 'r1', name: 'High priority', description: 'A rule',
    trigger_status: 'in_transit', trigger_match_type: 'fuzzy',
    priority: 1, enabled: true, conditions: [], actions: [], names: {},
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'r2', name: 'Low priority', description: 'B rule',
    trigger_status: 'delivered', trigger_match_type: 'exact',
    priority: 5, enabled: false, conditions: [], actions: [], names: {},
    created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  },
];

const STATS: StatusRuleExecStat[] = [
  { rule_id: 'r1', run_count: 3, met_count: 2, last_run_at: '2026-01-05T00:00:00Z', avg_duration_ms: 12 },
];

const EXECUTIONS: StatusRuleExecution[] = [
  {
    id: 1, rule_id: 'r1', rule_name: 'High priority',
    processed_scan_id: 'scan-1', conditions_met: true, match: null,
    actions_applied: [{ action_type: 'notify', applied: true }],
    error: null, executed_at: '2026-01-05T00:00:00Z', duration_ms: 42,
    scanned_value: 'ABC123', scan_status: 'in_transit',
  },
];

/** Where the page opens: the router's starting URL (?tab=executions&rule=r2, say). */
const at = { url: '/admin/status-rules' };

/** The current ?query, so a test can see what the page wrote. */
function SearchProbe() {
  return <output data-testid="search">{useLocation().search}</output>;
}

/** A link elsewhere in the app (a notice in the inbox): it moves the router while the page is open. */
function GoTo({ to, label }: { to: string; label: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>{label}</button>;
}

/** Every render sits in a router (the page reads ?tab= and ?rule=). */
const render = (ui: ReactElement) => rtlRender(
  <MemoryRouter initialEntries={[at.url]}>{ui}<SearchProbe /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  at.url = '/admin/status-rules';
  auth.can = () => true;
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions.mockResolvedValue(EXECUTIONS);
  api.getStatusRuleSchema.mockResolvedValue(SCHEMA);
  api.getStatusRuleExecStats.mockResolvedValue(STATS);
  api.toggleStatusRule.mockResolvedValue(RULES[0]);
  api.listNotificationRecipients.mockResolvedValue(PEOPLE);
  api.listNotificationGroups.mockResolvedValue(GROUPS);
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
});

afterEach(cleanup);

const { default: StatusRules } = await import('./StatusRules');

it('renders rule rows sorted by priority with trigger chip labels resolved from the schema', async () => {
  render(<StatusRules />);

  expect(await screen.findByText('High priority')).not.toBeNull();
  expect(screen.getByText('Low priority')).not.toBeNull();
  expect(screen.getByText('In Transit')).not.toBeNull();
  expect(screen.getByText('Delivered')).not.toBeNull();
  expect(screen.getByText('Fuzzy')).not.toBeNull();
  expect(screen.getByText('Exact')).not.toBeNull();

  const names = screen.getAllByText(/High priority|Low priority/).map((n) => n.textContent);
  expect(names).toEqual(['High priority', 'Low priority']);
});

it('hides the + New rule button when can(status_rules, add) is false', async () => {
  auth.can = () => false;
  render(<StatusRules />);
  await screen.findByText('High priority');

  expect(screen.queryByRole('button', { name: /New rule/i })).toBeNull();
});

it('shows the + New rule button when can(status_rules, add) is true', async () => {
  render(<StatusRules />);
  await screen.findByText('High priority');

  expect(screen.getByRole('button', { name: /New rule/i })).not.toBeNull();
});

it('toggling the enabled switch calls toggleStatusRule and reloads', async () => {
  const user = userEvent.setup();
  render(<StatusRules />);
  await screen.findByText('High priority');

  const row = screen.getByText('High priority').closest('.dir-row') as HTMLElement;
  const toggle = within(row).getByRole('checkbox');
  await user.click(toggle);

  await waitFor(() => expect(api.toggleStatusRule).toHaveBeenCalledWith('r1', false));
  await waitFor(() => expect(api.listStatusRules).toHaveBeenCalledTimes(2));
});

it('shows the load-error banner when listStatusRules rejects', async () => {
  api.listStatusRules.mockRejectedValue(new Error('boom'));
  render(<StatusRules />);

  expect(await screen.findByText(/Couldn.t load status rules/i)).not.toBeNull();
});

it('surfaces a mutation failure instead of leaving it unhandled', async () => {
  const user = userEvent.setup();
  api.toggleStatusRule.mockRejectedValue(new Error('network down'));
  render(<StatusRules />);
  await screen.findByText('High priority');

  const row = screen.getByText('High priority').closest('.dir-row') as HTMLElement;
  const toggle = within(row).getByRole('checkbox');
  await user.click(toggle);

  expect(await screen.findByText(/Couldn.t update the rule/i)).not.toBeNull();
  // The list should not be re-fetched off a failed mutation — only the
  // initial load call should have happened.
  expect(api.listStatusRules).toHaveBeenCalledTimes(1);
  // The rule list itself should still be visible — a mutation failure
  // must not blank out the already-loaded table.
  expect(screen.getByText('Low priority')).not.toBeNull();
});

it('splits trigger into two cells: trigger status and match type', async () => {
  render(<StatusRules />);
  await screen.findByText('High priority');

  const row = screen.getByText('High priority').closest('.dir-row') as HTMLElement;
  // Two separate elements — one per column — rather than a single chip
  // group carrying both labels.
  expect(within(row).getByText('In Transit')).not.toBeNull();
  expect(within(row).getByText('Fuzzy')).not.toBeNull();
});

it('search filters by resolved trigger label', async () => {
  const user = userEvent.setup();
  render(<StatusRules />);
  await screen.findByText('High priority');
  expect(screen.getByText('Low priority')).not.toBeNull();

  const input = screen.getByPlaceholderText('Filter this list…');
  await user.type(input, 'in transit');

  await waitFor(() => expect(screen.queryByText('Low priority')).toBeNull());
  expect(screen.getByText('High priority')).not.toBeNull();
  expect(screen.getByText('1 of 2 shown')).not.toBeNull();
});

it('columns button hides a column', async () => {
  const user = userEvent.setup();
  render(<StatusRules />);
  await screen.findByText('High priority');

  const header = document.querySelector('.list-head') as HTMLElement;
  expect(within(header).queryByText(/Priority/)).not.toBeNull();

  await user.click(screen.getByRole('button', { name: 'Columns' }));
  const popover = screen.getByText('Visible columns').parentElement as HTMLElement;
  await user.click(within(popover).getByRole('button', { name: 'Priority' }));

  await waitFor(() => expect(within(header).queryByText(/Priority/)).toBeNull());
  // Unrelated columns stay put.
  expect(within(header).queryByText('Name')).not.toBeNull();
});

// ── Rules tab row actions (Task 3) ──────────────────────────────────

/** Open one rule row's Actions menu. Items are then queried via
 *  `screen`, NOT `within(row)`: RowActionsMenu portals the open menu to
 *  document.body (see RowActionsMenu.tsx and the note at
 *  KioskDevices.test.tsx:178), so they leave the row's DOM subtree once
 *  open. Only one menu is open at a time here. */
async function openRuleMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  const row = screen.getByText(name).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  return row;
}

it('rule row: one Actions trigger replaces the inline Edit/Duplicate/Delete buttons', async () => {
  const user = userEvent.setup();
  render(<StatusRules />);
  await screen.findByText('High priority');

  const row = screen.getByText('High priority').closest('.dir-row') as HTMLElement;
  expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(within(row).queryByRole('button', { name: 'Duplicate' })).toBeNull();
  expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull();

  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Edit' })).not.toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Duplicate' })).not.toBeNull();
  const del = screen.getByRole('menuitem', { name: 'Delete' });
  expect(del.className).toContain('danger');
});

it('rule row: Actions → Edit opens the rule editor modal', async () => {
  const user = userEvent.setup();
  render(<StatusRules />);
  await screen.findByText('High priority');

  await openRuleMenu(user, 'High priority');
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

  expect(await screen.findByRole('heading', { name: /edit — high priority/i })).not.toBeNull();
});

// ── the Send a notification action in the list ──────────────────────

const NOTIFY_RULE: StatusRule = {
  ...RULES[0], id: 'r3', name: 'Tells people',
  actions: [
    { action_type: 'notify', params: { people: ['p1'], groups: ['g1'], watchers: true } },
  ],
};

/** The Actions cell of a rule's row, found by its tooltip (the summary): its text is the count. */
const actionsCell = (name: string, title: string) =>
  (screen.getByText(name).closest('.dir-row') as HTMLElement).querySelector(`[title^="${title}"]`);

it('rule list: a Send a notification action reads "Notify Person A, Group A and watchers" in its tooltip', async () => {
  api.listStatusRules.mockResolvedValue([NOTIFY_RULE]);
  render(<StatusRules />);
  await screen.findByText('Tells people');

  await waitFor(() => expect(actionsCell('Tells people', 'Notify')?.getAttribute('title'))
    .toBe('Notify Person A, Group A and watchers'));
  expect(api.listNotificationRecipients).toHaveBeenCalledTimes(1);
  expect(api.listNotificationGroups).toHaveBeenCalledTimes(1);
  // the cell itself still shows the count
  expect(actionsCell('Tells people', 'Notify')?.textContent).toBe('1');
});

it('rule list: the tooltip names the ids when the lists cannot be had (they need notification permissions)', async () => {
  api.listStatusRules.mockResolvedValue([NOTIFY_RULE]);
  api.listNotificationRecipients.mockRejectedValue(new ApiError(403, 'forbidden'));
  api.listNotificationGroups.mockRejectedValue(new ApiError(403, 'forbidden'));
  render(<StatusRules />);
  await screen.findByText('Tells people');
  await waitFor(() => expect(api.listNotificationRecipients).toHaveBeenCalledTimes(1));

  expect(actionsCell('Tells people', 'Notify')?.getAttribute('title')).toBe('Notify p1, g1 and watchers');
  // and the list is not blanked out by it
  expect(screen.queryByText(/Couldn.t load status rules/i)).toBeNull();
});

it('rule list: a viewer without notification permissions makes no list calls, and the tooltip names the ids', async () => {
  auth.can = (resource) => resource === 'status_rules';
  api.listStatusRules.mockResolvedValue([NOTIFY_RULE]);
  render(<StatusRules />);
  await screen.findByText('Tells people');

  expect(actionsCell('Tells people', 'Notify')?.getAttribute('title')).toBe('Notify p1, g1 and watchers');
  expect(api.listNotificationRecipients).not.toHaveBeenCalled();
  expect(api.listNotificationGroups).not.toHaveBeenCalled();
  expect(screen.queryByText(/Couldn.t load status rules/i)).toBeNull();
});

it('rules list names notify recipients from the rule for a viewer', async () => {
  auth.can = (resource) => resource === 'status_rules';
  api.listStatusRules.mockResolvedValue([
    { ...NOTIFY_RULE, names: { p1: 'Pat Doe', g1: 'Group A' } },
    {
      ...NOTIFY_RULE, id: 'r4', name: 'Tells someone else',
      actions: [{ action_type: 'notify', params: { people: ['p2'], groups: [], watchers: false } }],
      names: { p2: 'Sam Roe' },
    },
  ]);
  render(<StatusRules />);
  await screen.findByText('Tells people');

  // each rule's summary names its recipients from the names the rules carry, not the ids
  expect(actionsCell('Tells people', 'Notify')?.getAttribute('title'))
    .toBe('Notify Pat Doe, Group A and watchers');
  expect(actionsCell('Tells someone else', 'Notify')?.getAttribute('title')).toBe('Notify Sam Roe');
  expect(api.listNotificationRecipients).not.toHaveBeenCalled();
  expect(api.listNotificationGroups).not.toHaveBeenCalled();
});

it('rules list: a rule answered without names still lists, and its summary names the ids', async () => {
  // an older API slot, during a deploy, answers a rule with no `names` at all
  auth.can = (resource) => resource === 'status_rules';
  const unnamed: Partial<StatusRule> = { ...NOTIFY_RULE };
  delete unnamed.names;
  api.listStatusRules.mockResolvedValue([unnamed]);
  render(<StatusRules />);

  expect(await screen.findByText('Tells people')).not.toBeNull();
  expect(actionsCell('Tells people', 'Notify')?.getAttribute('title')).toBe('Notify p1, g1 and watchers');
  expect(screen.queryByText(/Couldn.t load status rules/i)).toBeNull();
});

it('rules list: a list the viewer may ask for names its own recipients, and the other takes the names from the rule', async () => {
  auth.can = (resource, action) => resource === 'status_rules'
    || (resource === 'notifications' && action === 'view');
  api.listStatusRules.mockResolvedValue([
    { ...NOTIFY_RULE, names: { p1: 'Pat Doe', g1: 'Group From The Rule' } },
  ]);
  render(<StatusRules />);
  await screen.findByText('Tells people');

  // the groups are the loaded list's (Group A), the people the rule's
  await waitFor(() => expect(actionsCell('Tells people', 'Notify')?.getAttribute('title'))
    .toBe('Notify Pat Doe, Group A and watchers'));
  expect(api.listNotificationGroups).toHaveBeenCalledTimes(1);
  expect(api.listNotificationRecipients).not.toHaveBeenCalled();
});

it('rule list: each list is asked for by its own permission, the people by notifications:change and the groups by notifications:view', async () => {
  auth.can = (resource, action) => resource === 'status_rules'
    || (resource === 'notifications' && action === 'view');
  api.listStatusRules.mockResolvedValue([NOTIFY_RULE]);
  render(<StatusRules />);
  await screen.findByText('Tells people');

  await waitFor(() => expect(actionsCell('Tells people', 'Notify')?.getAttribute('title'))
    .toBe('Notify p1, Group A and watchers'));
  expect(api.listNotificationGroups).toHaveBeenCalledTimes(1);
  expect(api.listNotificationRecipients).not.toHaveBeenCalled();
});

it('rule list: the notification lists are asked for only when some rule notifies', async () => {
  render(<StatusRules />);
  await screen.findByText('High priority');

  expect(api.listNotificationRecipients).not.toHaveBeenCalled();
  expect(api.listNotificationGroups).not.toHaveBeenCalled();
  expect(actionsCell('High priority', 'No actions')).not.toBeNull();
});

it('rule list: Edit on a rule that notifies shows its people and groups by name', async () => {
  const user = userEvent.setup();
  api.listStatusRules.mockResolvedValue([NOTIFY_RULE]);
  render(<StatusRules />);
  await screen.findByText('Tells people');

  await openRuleMenu(user, 'Tells people');
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

  expect(await screen.findByRole('button', { name: 'Remove Person A' })).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Remove Group A' })).not.toBeNull();
  expect((screen.getByRole('checkbox', { name: 'Also people watching the initiative or site' }) as HTMLInputElement).checked)
    .toBe(true);
  expect(document.querySelectorAll('select')).toHaveLength(0);
});

it('rule row: Actions → Duplicate posts a disabled copy and reloads', async () => {
  const user = userEvent.setup();
  api.createStatusRule.mockResolvedValue(RULES[0]);
  render(<StatusRules />);
  await screen.findByText('High priority');

  await openRuleMenu(user, 'High priority');
  await user.click(screen.getByRole('menuitem', { name: 'Duplicate' }));

  await waitFor(() => expect(api.createStatusRule).toHaveBeenCalledWith(
    expect.objectContaining({ name: 'High priority (Copy)', enabled: false }),
  ));
  await waitFor(() => expect(api.listStatusRules).toHaveBeenCalledTimes(2));
});

it('rule row: Actions → Delete still confirms first', async () => {
  const user = userEvent.setup();
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  api.deleteStatusRule.mockResolvedValue(undefined);
  render(<StatusRules />);
  await screen.findByText('High priority');

  await openRuleMenu(user, 'High priority');
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
  expect(confirmSpy).toHaveBeenCalled();
  expect(api.deleteStatusRule).not.toHaveBeenCalled();

  confirmSpy.mockReturnValue(true);
  await openRuleMenu(user, 'High priority');
  await user.click(screen.getByRole('menuitem', { name: 'Delete' }));

  await waitFor(() => expect(api.deleteStatusRule).toHaveBeenCalledWith('r1'));
  confirmSpy.mockRestore();
});

it('rule row: each item keeps its own permission gate', async () => {
  const user = userEvent.setup();
  auth.can = (resource, action) => resource === 'status_rules' && action === 'delete';
  render(<StatusRules />);
  await screen.findByText('High priority');

  await openRuleMenu(user, 'High priority');
  expect(screen.getByRole('menuitem', { name: 'Delete' })).not.toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Duplicate' })).toBeNull();
});

/** Tracks in a grid-template-columns string: a `minmax(floor, fr)` counts
 *  once (its inner px is part of the track, not a track of its own), and so
 *  does a bare `<n>px` fixed track. */
function trackCount(template: string): number {
  return (template.match(/minmax\([^)]*\)|[\d.]+px/g) ?? []).length;
}

it('rule row: no trigger and no action track when no permission applies', async () => {
  auth.can = () => false;
  render(<StatusRules />);
  await screen.findByText('High priority');

  const row = screen.getByText('High priority').closest('.dir-row') as HTMLElement;
  expect(within(row).queryByRole('button', { name: /Actions/ })).toBeNull();
  const card = row.closest('.dir-list') as HTMLElement;
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  // One track per shown column and nothing after them: no Actions track, and
  // no leftover fixed button strip either (the old assertion pinned that
  // strip's literal 200px, which no longer appears in any template).
  const shownCols = head.querySelectorAll('.col-head').length;
  expect(trackCount(main.style.gridTemplateColumns)).toBe(shownCols);
  expect(main.style.gridTemplateColumns.endsWith('88px')).toBe(false);
});

it('rule list: the action track is trigger-sized', async () => {
  render(<StatusRules />);
  await screen.findByText('High priority');

  const row = screen.getByText('High priority').closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  // One track per shown column plus the single trailing Actions track; the
  // header renders its own spacer cell for that track, so the counts match.
  const shownCols = head.querySelectorAll('.col-head').length;
  expect(trackCount(main.style.gridTemplateColumns)).toBe(shownCols);
  expect(main.style.gridTemplateColumns.endsWith('88px')).toBe(true);
});

// ── Column floors + sideways scroll (Task 8) ────────────────────────

it('rules list: column floors, shared template + minimum, sideways-scroll card', async () => {
  render(<StatusRules />);
  const row = (await screen.findByText('High priority')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  // Fit: default columns + trailing (the 88px Actions track) ≤ LIST_FIT.page
  // (1172px — .portal-page at a 1512px window, nav expanded).
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

it('executions list: column floors, shared template + minimum, sideways-scroll card', async () => {
  const user = userEvent.setup();
  render(<StatusRules />);
  await screen.findByText('High priority');
  await user.click(screen.getByRole('tab', { name: 'Executions' }));

  const row = (await screen.findByText('ABC123')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^160px/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  // Fit: default columns ≤ LIST_FIT.page (1172px — .portal-page at a 1512px
  // window, nav expanded; ExecutionsTab has no trailing track).
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

// ── the URL: ?tab=executions&rule=<id> ──────────────────────────────
// A grouped rule notice links to /admin/status-rules?tab=executions&rule=<rule id>. The tab
// and the rule the Executions tab lists are the URL's, and follow it when it moves.

const EXEC_R2: StatusRuleExecution = {
  ...EXECUTIONS[0], id: 2, rule_id: 'r2', rule_name: 'Low priority', scanned_value: 'DEF456',
};

/** The API filters by rule: r1's run, r2's run, or both. */
function serveExecutions() {
  api.listStatusRuleExecutions.mockImplementation(({ ruleId }: { ruleId?: string }) =>
    Promise.resolve([EXECUTIONS[0], EXEC_R2].filter((e) => ruleId === undefined || e.rule_id === ruleId)));
}

const tab = (name: string) => screen.getByRole('tab', { name });
const ruleFilter = () => screen.getByRole('combobox', { name: 'Filter by rule' }) as HTMLInputElement;
const search = () => screen.getByTestId('search').textContent;
const badge = () => document.querySelector('.badge-count')?.textContent;

async function pickRule(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(ruleFilter());
  await user.click(await screen.findByRole('button', { name }));
}

it('?tab=executions&rule= opens the Executions tab on that rule\'s executions', async () => {
  serveExecutions();
  at.url = '/admin/status-rules?tab=executions&rule=r2';
  render(<StatusRules />);

  expect(tab('Executions').getAttribute('aria-selected')).toBe('true');
  expect(tab('Rules').getAttribute('aria-selected')).toBe('false');
  expect(await screen.findByText('DEF456')).not.toBeNull();
  expect(screen.queryByText('ABC123')).toBeNull();
  // asked for once, and for that rule only
  expect(api.listStatusRuleExecutions).toHaveBeenCalledTimes(1);
  expect(api.listStatusRuleExecutions).toHaveBeenCalledWith({ ruleId: 'r2', limit: 100 });
  expect(ruleFilter().value).toBe('Low priority');
  expect(search()).toBe('?tab=executions&rule=r2');   // opening it rewrites nothing
});

it('?tab=executions opens the Executions tab on every rule\'s executions', async () => {
  serveExecutions();
  at.url = '/admin/status-rules?tab=executions';
  render(<StatusRules />);

  expect(await screen.findByText('ABC123')).not.toBeNull();
  expect(screen.getByText('DEF456')).not.toBeNull();
  expect(api.listStatusRuleExecutions).toHaveBeenCalledWith({ limit: 100 });
  expect(ruleFilter().value).toBe('All rules');
});

it('?rule= without ?tab=executions is just the Rules tab', async () => {
  at.url = '/admin/status-rules?rule=r2';
  render(<StatusRules />);

  expect(await screen.findByText('High priority')).not.toBeNull();
  expect(tab('Rules').getAttribute('aria-selected')).toBe('true');
  expect(api.listStatusRuleExecutions).not.toHaveBeenCalled();
});

it('the tabs keep the choice in ?tab=, and Rules, the default, leaves it out', async () => {
  const user = userEvent.setup();
  render(<StatusRules />);
  await screen.findByText('High priority');
  expect(search()).toBe('');

  await user.click(tab('Executions'));
  expect(search()).toBe('?tab=executions');
  expect(tab('Executions').getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('ABC123')).not.toBeNull();

  await user.click(tab('Rules'));
  expect(search()).toBe('');
  expect(tab('Rules').getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('Low priority')).not.toBeNull();
});

it('picking a rule keeps it in ?rule=, and All rules takes it out', async () => {
  serveExecutions();
  at.url = '/admin/status-rules?tab=executions';
  const user = userEvent.setup();
  render(<StatusRules />);
  await screen.findByText('DEF456');

  await pickRule(user, 'Low priority');
  expect(search()).toBe('?tab=executions&rule=r2');
  await waitFor(() => expect(screen.queryByText('ABC123')).toBeNull());
  expect(api.listStatusRuleExecutions).toHaveBeenLastCalledWith({ ruleId: 'r2', limit: 100 });
  expect(ruleFilter().value).toBe('Low priority');

  await pickRule(user, 'All rules');
  expect(search()).toBe('?tab=executions');
  expect(await screen.findByText('ABC123')).not.toBeNull();
  expect(api.listStatusRuleExecutions).toHaveBeenLastCalledWith({ limit: 100 });
  expect(ruleFilter().value).toBe('All rules');
});

it('leaving Executions forgets the rule: Rules and back lists every rule\'s runs', async () => {
  serveExecutions();
  at.url = '/admin/status-rules?tab=executions&rule=r2';
  const user = userEvent.setup();
  render(<StatusRules />);
  await screen.findByText('DEF456');

  await user.click(tab('Rules'));
  expect(search()).toBe('');
  await screen.findByText('High priority');

  await user.click(tab('Executions'));
  expect(search()).toBe('?tab=executions');
  expect(await screen.findByText('ABC123')).not.toBeNull();
  expect(screen.getByText('DEF456')).not.toBeNull();
  expect(ruleFilter().value).toBe('All rules');
});

it('clicking the tab already open changes nothing, rule included', async () => {
  serveExecutions();
  at.url = '/admin/status-rules?tab=executions&rule=r2';
  const user = userEvent.setup();
  render(<StatusRules />);
  await screen.findByText('DEF456');

  await user.click(tab('Executions'));
  expect(search()).toBe('?tab=executions&rule=r2');
  expect(ruleFilter().value).toBe('Low priority');
  expect(api.listStatusRuleExecutions).toHaveBeenCalledTimes(1);
});

it('follows the URL when a link moves it under the open page', async () => {
  serveExecutions();
  const user = userEvent.setup();
  render(<>
    <StatusRules />
    <GoTo to="/admin/status-rules?tab=executions&rule=r1" label="to r1" />
    <GoTo to="/admin/status-rules?tab=executions&rule=r2" label="to r2" />
    <GoTo to="/admin/status-rules" label="to rules" />
  </>);
  await screen.findByText('High priority');
  expect(tab('Rules').getAttribute('aria-selected')).toBe('true');

  await user.click(screen.getByRole('button', { name: 'to r1' }));
  expect(tab('Executions').getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('ABC123')).not.toBeNull();
  expect(screen.queryByText('DEF456')).toBeNull();
  expect(ruleFilter().value).toBe('High priority');
  expect(api.listStatusRuleExecutions).toHaveBeenLastCalledWith({ ruleId: 'r1', limit: 100 });

  await user.click(screen.getByRole('button', { name: 'to r2' }));
  expect(await screen.findByText('DEF456')).not.toBeNull();
  await waitFor(() => expect(screen.queryByText('ABC123')).toBeNull());
  expect(ruleFilter().value).toBe('Low priority');
  expect(api.listStatusRuleExecutions).toHaveBeenLastCalledWith({ ruleId: 'r2', limit: 100 });

  await user.click(screen.getByRole('button', { name: 'to rules' }));
  expect(tab('Rules').getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('Low priority')).not.toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Filter by rule' })).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

it('the header count is the count of the tab on show: "…" until its own arrives', async () => {
  at.url = '/admin/status-rules?tab=executions';
  const user = userEvent.setup();
  render(<StatusRules />);
  await screen.findByText('ABC123');
  await waitFor(() => expect(badge()).toBe('1'));   // one execution

  const rules = deferred<StatusRule[]>();
  api.listStatusRules.mockReturnValueOnce(rules.promise);
  await user.click(tab('Rules'));
  expect(badge()).toBe('…');                        // not the executions' 1 while the rules are on their way
  rules.resolve(RULES);
  await waitFor(() => expect(badge()).toBe('2'));   // two rules
});

it('a count that arrives from the tab left behind is not shown on the new one', async () => {
  at.url = '/admin/status-rules?tab=executions';
  const executions = deferred<StatusRuleExecution[]>();
  api.listStatusRuleExecutions.mockReturnValueOnce(executions.promise);
  const user = userEvent.setup();
  render(<StatusRules />);
  await waitFor(() => expect(api.listStatusRuleExecutions).toHaveBeenCalled());

  await user.click(tab('Rules'));
  await waitFor(() => expect(badge()).toBe('2'));   // two rules

  await act(async () => { executions.resolve(EXECUTIONS); });   // the left-behind tab's answer, late
  expect(api.listStatusRuleExecutions).toHaveBeenCalledTimes(1);
  expect(badge()).toBe('2');
});
