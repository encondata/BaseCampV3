// @vitest-environment jsdom
/**
 * /admin/status-rules — page shell + Rules tab. Covers what a unit test
 * can see: schema-resolved trigger chip labels, priority sort, the add
 * button's permission gate, the enabled switch's toggle+reload round
 * trip, and the load-error banner. The editor modal itself (create/edit,
 * schema-driven condition/action builder) is covered in
 * components/statusRules/RuleEditorModal.test.tsx.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type {
  StatusRule, StatusRuleExecStat, StatusRuleSchema, UiPreferences,
} from '../lib/api';

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

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
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: true },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences,
  }),
}));

const api = vi.hoisted(() => ({
  listStatusRules: vi.fn(),
  getStatusRuleSchema: vi.fn(),
  getStatusRuleExecStats: vi.fn(),
  toggleStatusRule: vi.fn(),
  createStatusRule: vi.fn(),
  deleteStatusRule: vi.fn(),
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
  actions: [{ key: 'notify', label: 'Notify', params: [] }],
  sites: [],
};

const RULES: StatusRule[] = [
  {
    id: 'r1', name: 'High priority', description: 'A rule',
    trigger_status: 'in_transit', trigger_match_type: 'fuzzy',
    priority: 1, enabled: true, conditions: [], actions: [],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'r2', name: 'Low priority', description: 'B rule',
    trigger_status: 'delivered', trigger_match_type: 'exact',
    priority: 5, enabled: false, conditions: [], actions: [],
    created_at: '2026-01-02T00:00:00Z', updated_at: '2026-01-02T00:00:00Z',
  },
];

const STATS: StatusRuleExecStat[] = [
  { rule_id: 'r1', run_count: 3, met_count: 2, last_run_at: '2026-01-05T00:00:00Z', avg_duration_ms: 12 },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.listStatusRules.mockResolvedValue(RULES);
  api.getStatusRuleSchema.mockResolvedValue(SCHEMA);
  api.getStatusRuleExecStats.mockResolvedValue(STATS);
  api.toggleStatusRule.mockResolvedValue(RULES[0]);
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
