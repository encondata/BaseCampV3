// @vitest-environment jsdom
/**
 * ExecutionsTab — per-fire status-rule execution log. Covers: newest-first
 * row rendering (time/rule/scan/result chip), error-row rendering (error
 * text + red chip, scan cell collapsed to '—'), the rule filter select
 * re-fetching from offset 0, "Load more" pagination (append + hide on a
 * short page), the in-flight guard against a double-click on "Load more",
 * and ignoring a stale (superseded) filter response.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { StatusRule, StatusRuleExecution } from '../../lib/api';

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
});

afterEach(cleanup);

const { default: ExecutionsTab } = await import('./ExecutionsTab');

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

  const { container } = render(<ExecutionsTab onCount={onCount} />);

  await screen.findByText('NEWEST');
  await screen.findByText('MID');
  await screen.findByText('OLDEST');

  // newest-first: rendering order must match the order the API returned.
  const text = container.querySelector('.dir-list')!.textContent!;
  expect(text.indexOf('NEWEST')).toBeLessThan(text.indexOf('MID'));
  expect(text.indexOf('MID')).toBeLessThan(text.indexOf('OLDEST'));

  // time — locale date+time, same formatting the component uses
  expect(screen.getByText(new Date('2026-08-30T12:03:00Z').toLocaleString())).not.toBeNull();

  // rule name (2nd cell of the first row; the filter <select> also has an
  // option with this same text, so scope to the row instead of the page)
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

  render(<ExecutionsTab onCount={vi.fn()} />);

  const chip = await screen.findByText('Error');
  expect(chip.className).toContain('c-red');
  expect(screen.getByText('Boom: invalid action')).not.toBeNull();

  // error rows collapse the Scan cell to '—' instead of the scanned value
  expect(screen.queryByText('ERRVAL')).toBeNull();
});

it('rule filter select re-calls listStatusRuleExecutions with { ruleId } when changed', async () => {
  api.listStatusRules.mockResolvedValue(RULES);
  api.listStatusRuleExecutions.mockResolvedValue([mkExec()]);
  const user = userEvent.setup();

  render(<ExecutionsTab onCount={vi.fn()} />);
  await screen.findAllByText('Rule One');

  api.listStatusRuleExecutions.mockClear();
  api.listStatusRuleExecutions.mockResolvedValue([
    mkExec({ id: 9, rule_id: 'rule-2', rule_name: 'Rule Two' }),
  ]);

  await user.selectOptions(screen.getByLabelText(/rule/i), 'rule-2');

  await waitFor(() => expect(api.listStatusRuleExecutions).toHaveBeenCalledWith({
    ruleId: 'rule-2', limit: PAGE,
  }));
  await screen.findAllByText('Rule Two');
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

  render(<ExecutionsTab onCount={onCount} />);

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

it('double-clicking "Load more" only appends one page (in-flight guard)', async () => {
  const firstPage = Array.from({ length: PAGE }, (_, i) => mkExec({ id: i + 1, scanned_value: `V${i}` }));
  const secondPage = Array.from({ length: 30 }, (_, i) => mkExec({ id: PAGE + i + 1, scanned_value: `W${i}` }));
  api.listStatusRules.mockResolvedValue(RULES);
  const more = deferred<StatusRuleExecution[]>();
  api.listStatusRuleExecutions
    .mockResolvedValueOnce(firstPage)
    .mockReturnValueOnce(more.promise);
  const user = userEvent.setup();

  render(<ExecutionsTab onCount={vi.fn()} />);

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

  render(<ExecutionsTab onCount={vi.fn()} />);
  await screen.findAllByText('Rule One');

  const older = deferred<StatusRuleExecution[]>();
  const newer = deferred<StatusRuleExecution[]>();
  api.listStatusRuleExecutions.mockClear();
  api.listStatusRuleExecutions
    .mockReturnValueOnce(older.promise)
    .mockReturnValueOnce(newer.promise);

  const select = screen.getByLabelText(/rule/i);
  await user.selectOptions(select, 'rule-2'); // fires the "older" request
  await user.selectOptions(select, 'rule-1'); // fires the "newer" request

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
