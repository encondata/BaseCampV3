// @vitest-environment jsdom
/**
 * The editor's test bar: runs a value through the current flow (saved or
 * not), shows the result line and the trace, and hands the run up so the
 * canvas can light its path. Editing the flow clears the run.
 */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type InitiativeItem, type MatchingRun } from '../../lib/api';
import type { Flow } from '../../lib/matchingRules';
import TestBar from './TestBar';

const api = vi.hoisted(() => ({
  testRunMatchingFlow: vi.fn(),
  listInitiatives: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const FLOW: Flow = {
  format: 1,
  nodes: [
    { id: 'n1', kind: 'scan_input', settings: {}, position: { x: 0, y: 0 } },
    { id: 'n3', kind: 'match', settings: { table: 'assets', field: 'rfid', compare: 'exact', search_in: 'move', multiple: 'first' }, position: { x: 200, y: 0 } },
    { id: 'n4', kind: 'found', settings: { action: 'record_scan' }, position: { x: 400, y: 0 } },
  ],
  edges: [],
};

const hit = (tag: number) => ({ id: `a${tag}`, asset_tag: tag, name: `Test asset ${tag - 100}`, rfid: null, serial: null, sits: 'move' as const });

function run(overrides: Partial<MatchingRun> = {}): MatchingRun {
  return {
    outcome: 'found', stop_reason: null, end_node_id: 'n4', asset: hit(103), field: 'rfid', action: 'record_scan',
    message: null,
    trace: [
      { node_id: 'n1', kind: 'scan_input', value_in: '102', value_out: '102', output: 'out', hits: null },
      { node_id: 'n3', kind: 'match', value_in: '102', value_out: null, output: 'found', hits: [hit(103)] },
    ],
    ...overrides,
  };
}

const move = (id: string, name: string, type = 'move') => ({ id, name, initiative_type: type }) as unknown as InitiativeItem;

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  Object.values(api).forEach((f) => f.mockReset());
  api.listInitiatives.mockResolvedValue([move('m1', 'Move A'), move('p1', 'Project X', 'project'), move('m2', 'Move B')]);
});
afterEach(cleanup);

it('runs against the test set', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  const result = run();
  api.testRunMatchingFlow.mockResolvedValue(result);
  render(<TestBar place="scanning" flow={FLOW} onRun={onRun} />);

  expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true);
  await user.type(screen.getByLabelText('Value to test'), '102');
  await user.click(screen.getByRole('button', { name: 'Run' }));

  expect(api.testRunMatchingFlow).toHaveBeenCalledWith({ place: 'scanning', flow: FLOW, value: '102', against: 'test_set' });
  expect(await screen.findByText('Found by RFID: Test asset 3 (asset tag 103) · Record the scan')).toBeTruthy();
  expect(onRun).toHaveBeenCalledWith(result);
});

it('against a move needs a move', async () => {
  const user = userEvent.setup();
  api.testRunMatchingFlow.mockResolvedValue(run());
  render(<TestBar place="printing" flow={FLOW} onRun={vi.fn()} />);

  await user.type(screen.getByLabelText('Value to test'), '102');
  await user.click(screen.getByRole('button', { name: 'A move' }));
  const runBtn = screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement;
  expect(runBtn.disabled).toBe(true);

  await user.click(screen.getByRole('combobox', { name: 'Move' }));
  expect(screen.queryByRole('button', { name: 'Project X' })).toBeNull();
  await user.click(await screen.findByRole('button', { name: 'Move A' }));
  expect(runBtn.disabled).toBe(false);
  await user.click(runBtn);

  expect(api.testRunMatchingFlow).toHaveBeenCalledWith({
    place: 'printing', flow: FLOW, value: '102', against: 'move', initiative_id: 'm1',
  });
});

it('shows the trace with hits and the first taken', async () => {
  const user = userEvent.setup();
  api.testRunMatchingFlow.mockResolvedValue(run({
    trace: [
      { node_id: 'n1', kind: 'scan_input', value_in: '106', value_out: '106', output: 'out', hits: null },
      { node_id: 'n3', kind: 'match', value_in: '106', value_out: null, output: 'found', hits: [hit(106), hit(107)] },
    ],
  }));
  render(<TestBar place="scanning" flow={FLOW} onRun={vi.fn()} />);
  await user.type(screen.getByLabelText('Value to test'), '106');
  await user.click(screen.getByRole('button', { name: 'Run' }));

  expect(await screen.findByText(/2 hits: 106, 107 · took 106/)).toBeTruthy();
  expect(screen.getByText(/1\. Scan input\s+"106" → "106"\s+out/)).toBeTruthy();
});

it('a stopped run names the step and the reason', async () => {
  const user = userEvent.setup();
  api.testRunMatchingFlow.mockResolvedValue(run({
    outcome: 'stopped', stop_reason: 'unwired', end_node_id: 'n3', asset: null, field: null, action: null,
    trace: [{ node_id: 'n1', kind: 'scan_input', value_in: '5', value_out: '5', output: 'out', hits: null }],
  }));
  render(<TestBar place="scanning" flow={FLOW} onRun={vi.fn()} />);
  await user.type(screen.getByLabelText('Value to test'), '5');
  await user.click(screen.getByRole('button', { name: 'Run' }));

  expect(await screen.findByText("Stopped at Match (RFID): the output it took isn't wired")).toBeTruthy();
});

it('shows not found with the message', async () => {
  const user = userEvent.setup();
  api.testRunMatchingFlow.mockResolvedValue(run({
    outcome: 'not_found', asset: null, field: null, action: null, message: 'No match',
  }));
  render(<TestBar place="scanning" flow={FLOW} onRun={vi.fn()} />);
  await user.type(screen.getByLabelText('Value to test'), '5');
  await user.click(screen.getByRole('button', { name: 'Run' }));

  expect(await screen.findByText('Not found · No match')).toBeTruthy();
});

it('error codes map to copy', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  api.testRunMatchingFlow.mockRejectedValue(new ApiError(404, 'initiative_not_found'));
  render(<TestBar place="scanning" flow={FLOW} onRun={onRun} />);
  await user.type(screen.getByLabelText('Value to test'), '5');
  await user.click(screen.getByRole('button', { name: 'Run' }));
  expect((await screen.findByRole('alert')).textContent).toBe('That move no longer exists.');

  api.testRunMatchingFlow.mockRejectedValue(new ApiError(500, 'boom'));
  await user.click(screen.getByRole('button', { name: 'Run' }));
  expect((await screen.findByRole('alert')).textContent).toBe('The test run failed. Try again.');
});

it('editing the flow clears the result and the highlight', async () => {
  const user = userEvent.setup();
  const onRun = vi.fn();
  api.testRunMatchingFlow.mockResolvedValue(run());
  const { rerender } = render(<TestBar place="scanning" flow={FLOW} onRun={onRun} />);
  await user.type(screen.getByLabelText('Value to test'), '102');
  await user.click(screen.getByRole('button', { name: 'Run' }));
  await screen.findByText(/Found by RFID/);

  rerender(<TestBar place="scanning" flow={{ ...FLOW, nodes: [...FLOW.nodes] }} onRun={onRun} />);

  expect(screen.queryByText(/Found by RFID/)).toBeNull();
  expect(onRun).toHaveBeenLastCalledWith(null);
});

it('a run stopped before any step says only why', async () => {
  const user = userEvent.setup();
  api.testRunMatchingFlow.mockResolvedValue(run({
    outcome: 'stopped', stop_reason: 'no_scan_input', end_node_id: null, asset: null, field: null, action: null,
    trace: [],
  }));
  render(<TestBar place="scanning" flow={FLOW} onRun={vi.fn()} />);
  await user.type(screen.getByLabelText('Value to test'), '5');
  await user.click(screen.getByRole('button', { name: 'Run' }));

  expect(await screen.findByText('Stopped: the flow needs exactly one Scan input')).toBeTruthy();
  expect(screen.queryByText(/Stopped at/)).toBeNull();
});

it('a found asset with no asset tag leaves the tag out', async () => {
  const user = userEvent.setup();
  api.testRunMatchingFlow.mockResolvedValue(run({ asset: { ...hit(103), asset_tag: null } }));
  render(<TestBar place="scanning" flow={FLOW} onRun={vi.fn()} />);
  await user.type(screen.getByLabelText('Value to test'), '102');
  await user.click(screen.getByRole('button', { name: 'Run' }));

  expect(await screen.findByText('Found by RFID: Test asset 3 · Record the scan')).toBeTruthy();
});

it("moves that fail to load say so, with Retry; Test set clears it", async () => {
  const user = userEvent.setup();
  api.listInitiatives.mockRejectedValueOnce(new Error('down'));
  render(<TestBar place="printing" flow={FLOW} onRun={vi.fn()} />);

  await user.click(screen.getByRole('button', { name: 'A move' }));
  expect((await screen.findByRole('alert')).textContent).toContain("Couldn't load the moves.");
  await user.click(screen.getByRole('button', { name: 'Test set' }));
  expect(screen.queryByText("Couldn't load the moves.")).toBeNull();

  api.listInitiatives.mockRejectedValueOnce(new Error('down'));
  await user.click(screen.getByRole('button', { name: 'A move' }));
  await screen.findByText("Couldn't load the moves.");
  expect(api.listInitiatives).toHaveBeenCalledTimes(2);

  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(api.listInitiatives).toHaveBeenCalledTimes(3);
  await user.click(screen.getByRole('combobox', { name: 'Move' }));
  expect(await screen.findByRole('button', { name: 'Move A' })).toBeTruthy();
  expect(screen.queryByText("Couldn't load the moves.")).toBeNull();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});
