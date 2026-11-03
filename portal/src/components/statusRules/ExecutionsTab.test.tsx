// @vitest-environment jsdom
/**
 * ExecutionsTab — per-fire status-rule execution log. Covers: newest-first
 * row rendering (time/rule/scan/result chip), error-row rendering (error
 * text + red chip, scan cell collapsed to '—'), the rule filter (the house
 * ComboBox; the page owns the rule, since it keeps it in the URL) asking for
 * that rule's executions from offset 0 — on a pick, and whenever the rule it
 * is given changes — "Load more" pagination (append + hide on a short page,
 * keeping the rule), the in-flight guard against a double-click on "Load
 * more", ignoring a stale (superseded) filter response, and the reasons an
 * action was not applied (a repeat reads "Notified within the hour").
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { StatusRule, StatusRuleExecution } from '../../lib/api';

/** ExecutionsTab reads `preferences.list_size` for the shared column floors
 *  (listScale, lib/listTools); nothing else in this tree touches auth. */
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ preferences: { list_size: 'default' } }),
}));

const api = vi.hoisted(() => ({
  listStatusRules: vi.fn(),
  listStatusRuleExecutions: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const PAGE = 100;

const RULES: StatusRule[] = [
  {
    id: 'rule-1', name: 'Rule One', description: '',
    trigger_status: 'in_transit', trigger_match_type: 'exact',
    priority: 10, enabled: true, conditions: [], actions: [],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: 'rule-2', name: 'Rule Two', description: '',
    trigger_status: 'delivered', trigger_match_type: 'exact',
    priority: 20, enabled: true, conditions: [], actions: [],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function mkExec(overrides: Partial<StatusRuleExecution> = {}): StatusRuleExecution {
  return {
    id: 1, rule_id: 'rule-1', rule_name: 'Rule One',
    processed_scan_id: 'scan-1', conditions_met: true,
    actions_applied: [{ action_type: 'set_asset_status', applied: true }],
    error: null, executed_at: '2026-08-30T12:00:00Z', duration_ms: 42,
    scanned_value: 'ABC123', scan_status: 'in_transit',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
});

afterEach(cleanup);

const { default: ExecutionsTab } = await import('./ExecutionsTab');

/** The page owns the rule (it keeps it in the URL); this holds it the same way, from `start`. */
function Held({ start = '', onCount = vi.fn() }: {
  start?: string; onCount?: (n: number | null) => void;
}) {
  const [ruleId, setRuleId] = useState(start);
  return <ExecutionsTab onCount={onCount} ruleId={ruleId} onRuleChange={setRuleId} />;
}

type User = ReturnType<typeof userEvent.setup>;

const filter = () => screen.getByRole('combobox', { name: 'Filter by rule' }) as HTMLInputElement;

/** Open the rule filter and click one of its options. */
async function pickRule(user: User, name: string) {
  await user.click(filter());
  await user.click(await screen.findByRole('button', { name }));
}

it('renders execution rows newest-first: time, rule name, scanned value, and result chip text', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  const execs = [
    mkExec({
      id: 3, rule_name: 'Rule Two', scanned_value: 'NEWEST',
      conditions_met: true, error: null, executed_at: '2026-08-30T12:03:00Z',
    }),
    mkExec({
      id: 2, rule_name: 'Rule One', scanned_value: 'MID',
      conditions_met: false, error: null, executed_at: '2026-08-30T12:02:00Z',
    }),
    mkExec({
      id: 1, rule_name: 'Rule One', scanned_value: 'OLDEST',
      conditions_met: true, error: null, executed_at: '2026-08-30T12:01:00Z',
    }),
  ];
  api.listStatusRuleExecutions.mockResolvedValue(execs);
  const onCount = vi.fn();

  const { container } = render(<Held onCount={onCount} />);

  await screen.findByText('NEWEST');
  await screen.findByText('MID');
  await screen.findByText('OLDEST');

  // newest-first: rendering order must match the order the API returned.
  const text = container.querySelector('.dir-list')!.textContent!;
  expect(text.indexOf('NEWEST')).toBeLessThan(text.indexOf('MID'));
  expect(text.indexOf('MID')).toBeLessThan(text.indexOf('OLDEST'));

  // time — locale date+time, same formatting the component uses
  expect(screen.getByText(new Date('2026-08-30T12:03:00Z').toLocaleString())).not.toBeNull();

  // rule name (2nd cell of the first row)
  expect(container.querySelector('.dir-row .row-main .cell:nth-child(2)')!.textContent)
    .toBe('Rule Two');

  // result chips (NEWEST + OLDEST are both "Executed"; MID is not)
  expect(screen.getAllByText('Executed').length).toBe(2);
  expect(screen.getByText('Conditions not met')).not.toBeNull();

  await waitFor(() => expect(onCount).toHaveBeenCalledWith(3));
});

it('error rows render the error text and an Error chip with class c-red', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions.mockResolvedValue([
    mkExec({
      id: 5, error: 'Boom: invalid action', conditions_met: false,
      scanned_value: 'ERRVAL', scan_status: null,
    }),
  ]);

  render(<Held />);

  const chip = await screen.findByText('Error');
  expect(chip.className).toContain('c-red');
  expect(screen.getByText('Boom: invalid action')).not.toBeNull();

  // error rows collapse the Scan cell to '—' instead of the scanned value
  expect(screen.queryByText('ERRVAL')).toBeNull();
});

it('the rule filter is the house dropdown: All rules, then every rule, and no native select', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions.mockResolvedValue([mkExec()]);
  const user = userEvent.setup();

  const { container } = render(<Held />);
  await screen.findByText('ABC123');

  expect(container.querySelector('select')).toBeNull();
  expect(filter().classList.contains('org-select')).toBe(true);
  expect(filter().value).toBe('All rules');

  await user.click(filter());
  const menu = await screen.findAllByRole('button');
  expect(menu.filter((b) => b.classList.contains('kbar-item')).map((b) => b.textContent))
    .toEqual(['All rules', 'Rule One', 'Rule Two']);
});

it('picking a rule asks for that rule\'s executions, from the start', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions.mockResolvedValue([mkExec()]);
  const user = userEvent.setup();

  render(<Held />);
  await screen.findByText('ABC123');

  api.listStatusRuleExecutions.mockClear();
  api.listStatusRuleExecutions.mockResolvedValue([
    mkExec({ id: 9, rule_id: 'rule-2', rule_name: 'Rule Two', scanned_value: 'TWO' }),
  ]);

  await pickRule(user, 'Rule Two');

  await waitFor(() => expect(api.listStatusRuleExecutions).toHaveBeenCalledWith({
    ruleId: 'rule-2', limit: PAGE,
  }));
  await screen.findByText('TWO');
  expect(screen.queryByText('ABC123')).toBeNull();
  expect(filter().value).toBe('Rule Two');
});

it('picking All rules asks for every rule\'s executions again', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions.mockResolvedValue([mkExec({ rule_id: 'rule-2', scanned_value: 'TWO' })]);
  const user = userEvent.setup();

  render(<Held start="rule-2" />);
  await screen.findByText('TWO');
  expect(filter().value).toBe('Rule Two');

  api.listStatusRuleExecutions.mockClear();
  api.listStatusRuleExecutions.mockResolvedValue([mkExec({ scanned_value: 'ALL' })]);

  await pickRule(user, 'All rules');

  await waitFor(() => expect(api.listStatusRuleExecutions).toHaveBeenCalledWith({ limit: PAGE }));
  await screen.findByText('ALL');
  expect(filter().value).toBe('All rules');
});

it('lists the executions of the rule it is given, and shows that rule in the filter', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions.mockResolvedValue([
    mkExec({ id: 9, rule_id: 'rule-2', rule_name: 'Rule Two', scanned_value: 'TWO' }),
  ]);

  render(<ExecutionsTab onCount={vi.fn()} ruleId="rule-2" onRuleChange={vi.fn()} />);

  await screen.findByText('TWO');
  // one request, for that rule: the first page is never fetched unfiltered
  expect(api.listStatusRuleExecutions).toHaveBeenCalledTimes(1);
  expect(api.listStatusRuleExecutions).toHaveBeenCalledWith({ ruleId: 'rule-2', limit: PAGE });
  expect(api.listStatusRules).toHaveBeenCalledTimes(1);
  expect(filter().value).toBe('Rule Two');
});

it('asks again when the rule it is given changes, and not for the rules again', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions.mockResolvedValue([mkExec({ scanned_value: 'ONE' })]);

  const view = render(<ExecutionsTab onCount={vi.fn()} ruleId="rule-1" onRuleChange={vi.fn()} />);
  await screen.findByText('ONE');
  expect(filter().value).toBe('Rule One');

  api.listStatusRuleExecutions.mockClear();
  api.listStatusRuleExecutions.mockResolvedValue([
    mkExec({ id: 9, rule_id: 'rule-2', rule_name: 'Rule Two', scanned_value: 'TWO' }),
  ]);
  view.rerender(<ExecutionsTab onCount={vi.fn()} ruleId="rule-2" onRuleChange={vi.fn()} />);

  await screen.findByText('TWO');
  expect(api.listStatusRuleExecutions).toHaveBeenCalledTimes(1);
  expect(api.listStatusRuleExecutions).toHaveBeenCalledWith({ ruleId: 'rule-2', limit: PAGE });
  expect(screen.queryByText('ONE')).toBeNull();
  expect(filter().value).toBe('Rule Two');

  api.listStatusRuleExecutions.mockClear();
  api.listStatusRuleExecutions.mockResolvedValue([mkExec({ id: 10, scanned_value: 'ALL' })]);
  view.rerender(<ExecutionsTab onCount={vi.fn()} ruleId="" onRuleChange={vi.fn()} />);

  await screen.findByText('ALL');
  expect(api.listStatusRuleExecutions).toHaveBeenCalledWith({ limit: PAGE });
  expect(filter().value).toBe('All rules');
  // the rules came once, with the first page
  expect(api.listStatusRules).toHaveBeenCalledTimes(1);
});

it('tells the page which rule was picked, and changes nothing itself', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions.mockResolvedValue([mkExec()]);
  const onRuleChange = vi.fn();
  const user = userEvent.setup();

  render(<ExecutionsTab onCount={vi.fn()} ruleId="" onRuleChange={onRuleChange} />);
  await screen.findByText('ABC123');
  api.listStatusRuleExecutions.mockClear();

  await pickRule(user, 'Rule Two');

  expect(onRuleChange).toHaveBeenCalledTimes(1);
  expect(onRuleChange).toHaveBeenCalledWith('rule-2');
  // the page has not moved the rule, so neither has the list
  expect(filter().value).toBe('All rules');
  expect(api.listStatusRuleExecutions).not.toHaveBeenCalled();
});

it('shows no filter until the rules have come, so a rule it is given never flashes as nothing picked', async () => {
  const rules = deferred<StatusRule[]>();
  api.listStatusRules.mockReturnValue(rules.promise);
  api.listStatusRuleExecutions.mockResolvedValue([mkExec({ rule_id: 'rule-2', scanned_value: 'TWO' })]);

  render(<ExecutionsTab onCount={vi.fn()} ruleId="rule-2" onRuleChange={vi.fn()} />);
  await waitFor(() => expect(api.listStatusRuleExecutions).toHaveBeenCalled());
  expect(screen.queryByRole('combobox', { name: 'Filter by rule' })).toBeNull();

  rules.resolve(RULES);
  await screen.findByText('TWO');
  expect(filter().value).toBe('Rule Two');
});

it('a rule the list does not have (deleted since a notice named it) is still asked for, and nothing reads as picked', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions.mockResolvedValue([]);

  render(<ExecutionsTab onCount={vi.fn()} ruleId="gone" onRuleChange={vi.fn()} />);

  await screen.findByText('No executions yet');
  expect(api.listStatusRuleExecutions).toHaveBeenCalledWith({ ruleId: 'gone', limit: PAGE });
  expect(filter().value).toBe('');
});

it('"Load more" appends the next offset page and disappears when a short page returns', async () => {
  const firstPage = Array.from({ length: PAGE }, (_, i) => mkExec({ id: i + 1, scanned_value: `V${i}` }));
  const secondPage = Array.from({ length: 30 }, (_, i) => mkExec({ id: PAGE + i + 1, scanned_value: `W${i}` }));
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions
    .mockResolvedValueOnce(firstPage)
    .mockResolvedValueOnce(secondPage);
  const user = userEvent.setup();
  const onCount = vi.fn();

  render(<Held onCount={onCount} />);

  const loadMore = await screen.findByRole('button', { name: 'Load more' });
  await user.click(loadMore);

  await waitFor(() => expect(api.listStatusRuleExecutions).toHaveBeenNthCalledWith(2, {
    ruleId: undefined, limit: PAGE, offset: PAGE,
  }));
  await screen.findByText('W0');
  expect(screen.getByText('V0')).not.toBeNull();

  await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
  await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(PAGE + 30));
});

it('"Load more" keeps asking for the rule that is chosen', async () => {
  const firstPage = Array.from({ length: PAGE }, (_, i) => mkExec({ id: i + 1, rule_id: 'rule-2', scanned_value: `V${i}` }));
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions
    .mockResolvedValueOnce(firstPage)
    .mockResolvedValueOnce([mkExec({ id: PAGE + 1, rule_id: 'rule-2', scanned_value: 'LAST' })]);
  const user = userEvent.setup();

  render(<Held start="rule-2" />);
  await user.click(await screen.findByRole('button', { name: 'Load more' }));

  await screen.findByText('LAST');
  expect(api.listStatusRuleExecutions).toHaveBeenNthCalledWith(1, { ruleId: 'rule-2', limit: PAGE });
  expect(api.listStatusRuleExecutions).toHaveBeenNthCalledWith(2, {
    ruleId: 'rule-2', limit: PAGE, offset: PAGE,
  });
});

it('double-clicking "Load more" only appends one page (in-flight guard)', async () => {
  const firstPage = Array.from({ length: PAGE }, (_, i) => mkExec({ id: i + 1, scanned_value: `V${i}` }));
  const secondPage = Array.from({ length: 30 }, (_, i) => mkExec({ id: PAGE + i + 1, scanned_value: `W${i}` }));
  api.listStatusRules.mockResolvedValue(RULES);
  const more = deferred<StatusRuleExecution[]>();
  api.listStatusRuleExecutions
    .mockResolvedValueOnce(firstPage)
    .mockReturnValueOnce(more.promise);
  const user = userEvent.setup();

  render(<Held />);

  const loadMore = await screen.findByRole('button', { name: 'Load more' });
  await user.click(loadMore);

  // button is disabled while the request is in flight — a second click is a no-op
  const loadingBtn = await screen.findByRole('button', { name: /loading/i });
  await waitFor(() => expect((loadingBtn as HTMLButtonElement).disabled).toBe(true));
  await user.click(loadingBtn);

  more.resolve(secondPage);
  await screen.findByText('W0');

  // only the initial load + a single "load more" call, never two
  expect(api.listStatusRuleExecutions).toHaveBeenCalledTimes(2);
  expect(screen.getAllByText('V0')).toHaveLength(1);
  expect(screen.getAllByText('W0')).toHaveLength(1);
});

it('ignores a stale filter response that resolves after a newer one', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions.mockResolvedValue([mkExec()]);
  const user = userEvent.setup();

  render(<Held />);
  await screen.findByText('ABC123');

  const older = deferred<StatusRuleExecution[]>();
  const newer = deferred<StatusRuleExecution[]>();
  api.listStatusRuleExecutions.mockClear();
  api.listStatusRuleExecutions
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(newer.promise);

  await pickRule(user, 'Rule Two'); // fires the "older" request
  await pickRule(user, 'Rule One'); // fires the "newer" request

  // resolve out of order: newer request settles first, older settles after
  newer.resolve([mkExec({ id: 9, rule_id: 'rule-1', rule_name: 'Rule One', scanned_value: 'NEWER' })]);
  await screen.findByText('NEWER');

  older.resolve([mkExec({ id: 8, rule_id: 'rule-2', rule_name: 'Rule Two', scanned_value: 'STALE' })]);

  // give the stale promise's .then a turn, then assert it never overwrote state
  await Promise.resolve();
  await Promise.resolve();
  expect(screen.queryByText('STALE')).toBeNull();
  expect(screen.getByText('NEWER')).not.toBeNull();
});

// ── why an action was not applied ───────────────────────────────────

/** The tooltip on an actions cell (its summary text finds the cell). */
const tooltip = (summary: string) => screen.getByText(summary).getAttribute('title') ?? '';

it('a repeat reads "Notified within the hour" in the actions tooltip, and other reasons stay as they are', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions.mockResolvedValue([
    mkExec({
      id: 4, scanned_value: 'REPEAT',
      actions_applied: [
        { action_type: 'notify', applied: false, reason: 'notified_within_hour' },
        { action_type: 'set_asset_status', applied: false, reason: 'no_asset' },
        { action_type: 'set_asset_status', applied: true },
      ],
    }),
  ]);

  render(<Held />);
  await screen.findByText('REPEAT');

  const title = tooltip('1 applied · skipped 2');
  expect(JSON.parse(title)).toEqual([
    { action_type: 'notify', applied: false, reason: 'Notified within the hour' },
    { action_type: 'set_asset_status', applied: false, reason: 'no_asset' },
    { action_type: 'set_asset_status', applied: true },
  ]);
  expect(title).not.toContain('notified_within_hour');
});

it('an action with no reason shows in the tooltip exactly as it came', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  const actions = [{ action_type: 'set_asset_status', applied: true }];
  api.listStatusRuleExecutions.mockResolvedValue([mkExec({ scanned_value: 'PLAIN', actions_applied: actions })]);

  render(<Held />);
  await screen.findByText('PLAIN');

  expect(tooltip('1 applied')).toBe(JSON.stringify(actions, null, 2));
});
