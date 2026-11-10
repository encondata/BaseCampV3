// @vitest-environment jsdom
/**
 * /dev/matching-rules/versions/:id — the flow editor page: the top bar,
 * save and discard, live warnings, the leave guard, settings and the
 * palette. The canvas is a stub (FlowCanvas has its own test with the real
 * React Flow): one button per node selects it, `stub-connect` wires n3's
 * spare `none` output to the spare Not found n6, and `stub-move` moves n2.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { MatchingCheck, MatchingVersionDetail } from '../lib/api';
import type { Flow } from '../lib/matchingRules';
import MatchingRuleEditor from './MatchingRuleEditor';

const api = vi.hoisted(() => ({
  getMatchingVersion: vi.fn(),
  updateMatchingDraft: vi.fn(),
  createMatchingDraft: vi.fn(),
  checkMatchingFlow: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

vi.mock('../components/matching/FlowCanvas', async () => {
  const { connect, moveNode } = await vi.importActual<typeof import('../lib/matchingRules')>('../lib/matchingRules');
  return {
    default: ({ flow, warnings, onChange, onSelect }: {
      flow: Flow;
      warnings: Set<string>;
      onChange: (f: Flow) => void;
      onSelect: (s: { kind: 'node' | 'edge'; id: string } | null) => void;
    }) => (
      <div data-testid="canvas">
        {flow.nodes.map((n) => (
          <button key={n.id} type="button" data-warned={warnings.has(n.id) ? 'yes' : 'no'}
                  onClick={() => onSelect({ kind: 'node', id: n.id })}>
            {`node ${n.id}`}
          </button>
        ))}
        <button type="button" onClick={() => onChange(connect(flow, 'n3', 'none', 'n6'))}>stub-connect</button>
        <button type="button" onClick={() => onChange(moveNode(flow, 'n2', { x: 5, y: 5 }))}>stub-move</button>
        <output data-testid="edges">{flow.edges.map((e) => `${e.source}.${e.output}>${e.target}`).join(' ')}</output>
      </div>
    ),
  };
});

const FLOW: Flow = {
  format: 1,
  nodes: [
    { id: 'n1', kind: 'scan_input', settings: {}, position: { x: 0, y: 0 } },
    { id: 'n2', kind: 'clean_up', settings: { op: 'trim' }, position: { x: 220, y: 0 } },
    {
      id: 'n3', kind: 'match',
      settings: { table: 'assets', field: 'asset_tag', compare: 'ignore_case', search_in: 'move', multiple: 'first' },
      position: { x: 440, y: 0 },
    },
    { id: 'n4', kind: 'found', settings: { action: 'print_label' }, position: { x: 660, y: -60 } },
    { id: 'n6', kind: 'not_found', settings: { message: 'No match' }, position: { x: 660, y: 60 } },
  ],
  edges: [
    { id: 'e1', source: 'n1', output: 'out', target: 'n2' },
    { id: 'e2', source: 'n2', output: 'out', target: 'n3' },
    { id: 'e3', source: 'n3', output: 'found', target: 'n4' },
  ],
};

function check(overrides: Partial<MatchingCheck> = {}): MatchingCheck {
  return {
    ok: true, structure_ok: true, tests_ok: true, passed: 9, total: 9,
    structure: [{ code: 'wired', label: 'Every output is wired to one step', ok: true, problems: [] }],
    tests: [],
    ...overrides,
  };
}

function detail(overrides: Partial<MatchingVersionDetail> = {}): MatchingVersionDetail {
  return {
    id: 'v2id', place: 'printing', version: 2, state: 'draft', based_on_version: 1,
    saved_by_name: null, saved_at: '2026-11-10T09:00:00Z', state_changed_at: null,
    checked: null, current: { passed: 9, total: 9, ok: true, checked_at: null },
    flow: FLOW, check: check(),
    ...overrides,
  };
}

function Where() {
  const loc = useLocation();
  return <div data-testid="where">{loc.pathname}</div>;
}

function renderAt(id: string) {
  return render(
    <MemoryRouter initialEntries={[`/dev/matching-rules/versions/${id}`]}>
      <Link to="/dev">Developer</Link>
      <Where />
      <Routes>
        <Route path="/dev/matching-rules/versions/:id" element={<MatchingRuleEditor />} />
        <Route path="/dev" element={<div>Developer page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
  Object.values(api).forEach((f) => f.mockReset());
  api.getMatchingVersion.mockResolvedValue(detail());
  api.checkMatchingFlow.mockResolvedValue(check());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('loads the version and shows the palette and top bar', async () => {
  renderAt('v2id');
  expect(await screen.findByRole('heading', { name: /v2/ })).toBeTruthy();
  expect(screen.getByText('Draft')).toBeTruthy();
  expect(screen.getByText('Matching rules · Printing')).toBeTruthy();
  expect(api.getMatchingVersion).toHaveBeenCalledWith('v2id');
  for (const label of ['Scan input', 'Clean up', 'Match', 'Found', 'Not found']) {
    expect(screen.getByRole('button', { name: label })).toBeTruthy();
  }
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.queryByText(/Saving makes a new draft/)).toBeNull();
});

it('editing a Match field and saving a draft', async () => {
  const user = userEvent.setup();
  renderAt('v2id');
  await user.click(await screen.findByRole('button', { name: 'node n3' }));
  await user.click(screen.getByRole('combobox', { name: 'Field' }));
  await user.click(await screen.findByRole('button', { name: 'serial' }));
  expect(screen.getByText('When two or more match: Take the first, by asset tag order')).toBeTruthy();

  const saved = detail({ flow: { ...FLOW, nodes: FLOW.nodes.map((n) => (n.id === 'n3' ? { ...n, settings: { ...n.settings, field: 'serial' } } : n)) } });
  api.updateMatchingDraft.mockResolvedValue(saved);
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(api.updateMatchingDraft).toHaveBeenCalledTimes(1);
  const [id, flow] = api.updateMatchingDraft.mock.calls[0] as [string, Flow];
  expect(id).toBe('v2id');
  expect(flow.nodes.find((n) => n.id === 'n3')?.settings.field).toBe('serial');
  expect(await screen.findByText('Saved v2.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
});

it('saving a live version makes a new draft', async () => {
  const user = userEvent.setup();
  api.getMatchingVersion.mockResolvedValue(detail({ id: 'v1id', version: 1, state: 'live', based_on_version: null }));
  renderAt('v1id');
  expect(await screen.findByText('Saving makes a new draft from v1.')).toBeTruthy();
  expect(screen.getByText('Live')).toBeTruthy();

  await user.click(screen.getByRole('button', { name: 'stub-connect' }));
  api.createMatchingDraft.mockResolvedValue(detail({ id: 'v3id', version: 3, state: 'draft', based_on_version: 1 }));
  await user.click(screen.getByRole('button', { name: 'Save' }));

  expect(api.updateMatchingDraft).not.toHaveBeenCalled();
  expect(api.createMatchingDraft).toHaveBeenCalledTimes(1);
  const body = api.createMatchingDraft.mock.calls[0][0] as { place: string; flow: Flow; based_on_id: string };
  expect(body.place).toBe('printing');
  expect(body.based_on_id).toBe('v1id');
  expect(body.flow.edges.some((e) => e.source === 'n3' && e.output === 'none' && e.target === 'n6')).toBe(true);
  await waitFor(() => expect(screen.getByTestId('where').textContent).toBe('/dev/matching-rules/versions/v3id'));
  expect(await screen.findByText('Saved v3.')).toBeTruthy();
  expect(screen.getByRole('heading', { name: /v3/ })).toBeTruthy();
  expect(screen.queryByText(/Saving makes a new draft/)).toBeNull();
});

it('Discard restores the loaded flow', async () => {
  const user = userEvent.setup();
  renderAt('v2id');
  await user.click(await screen.findByRole('button', { name: 'stub-connect' }));
  expect(screen.getByTestId('edges').textContent).toContain('n3.none>n6');
  const discard = screen.getByRole('button', { name: 'Discard' }) as HTMLButtonElement;
  expect(discard.disabled).toBe(false);

  await user.click(discard);

  expect(screen.getByTestId('edges').textContent).not.toContain('n3.none>n6');
  expect(discard.disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
});

it('live check runs after edits and marks warnings', async () => {
  api.checkMatchingFlow.mockResolvedValue(check({
    ok: false, structure_ok: false, passed: 7, total: 9,
    structure: [{
      code: 'wired', label: 'Every output is wired to one step', ok: false,
      problems: [{ message: 'Match (asset tag) has no wire on found.', node_ids: ['n3'] }],
    }],
  }));
  renderAt('v2id');
  const connectBtn = await screen.findByRole('button', { name: 'stub-connect' });
  expect(screen.getByText('Test set: 9 of 9')).toBeTruthy();   // the loaded version's own check
  vi.useFakeTimers();
  fireEvent.click(connectBtn);
  act(() => { vi.advanceTimersByTime(200); });
  fireEvent.click(screen.getByRole('button', { name: 'stub-move' }));
  act(() => { vi.advanceTimersByTime(399); });
  expect(api.checkMatchingFlow).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(api.checkMatchingFlow).toHaveBeenCalledTimes(1);
  const [place, flow] = api.checkMatchingFlow.mock.calls[0] as [string, Flow];
  expect(place).toBe('printing');
  expect(flow.nodes.find((n) => n.id === 'n2')?.position).toEqual({ x: 5, y: 5 });
  expect(flow.edges.some((e) => e.source === 'n3' && e.output === 'none')).toBe(true);

  expect(screen.getByText('Match (asset tag) has no wire on found.')).toBeTruthy();
  expect(screen.getByText('Test set: 7 of 9')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'node n3' }).getAttribute('data-warned')).toBe('yes');
  expect(screen.getByRole('button', { name: 'node n2' }).getAttribute('data-warned')).toBe('no');
});

it('drops a late check answer for an older flow', async () => {
  let answerFirst: (c: MatchingCheck) => void = () => {};
  api.checkMatchingFlow
    .mockImplementationOnce(() => new Promise<MatchingCheck>((r) => { answerFirst = r; }))
    .mockResolvedValueOnce(check({ passed: 8, total: 9, tests_ok: false }));
  renderAt('v2id');
  const connectBtn = await screen.findByRole('button', { name: 'stub-connect' });
  vi.useFakeTimers();
  fireEvent.click(connectBtn);
  await act(async () => { vi.advanceTimersByTime(400); });
  fireEvent.click(screen.getByRole('button', { name: 'stub-move' }));
  await act(async () => { vi.advanceTimersByTime(400); });
  expect(api.checkMatchingFlow).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Test set: 8 of 9')).toBeTruthy();

  await act(async () => {
    answerFirst(check({
      ok: false, structure_ok: false, passed: 1, total: 9,
      structure: [{ code: 'wired', label: 'x', ok: false, problems: [{ message: 'Old problem.', node_ids: ['n3'] }] }],
    }));
  });
  expect(screen.queryByText('Old problem.')).toBeNull();
  expect(screen.getByText('Test set: 8 of 9')).toBeTruthy();
});

it('asks before leaving with unsaved changes', async () => {
  const user = userEvent.setup();
  renderAt('v2id');
  await user.click(await screen.findByRole('button', { name: 'stub-connect' }));
  await user.click(screen.getByRole('link', { name: 'Developer' }));

  expect(await screen.findByRole('heading', { name: 'Leave without saving?' })).toBeTruthy();
  expect(screen.getByText("Your changes to v2 aren't saved.")).toBeTruthy();
  expect(screen.getByTestId('where').textContent).toBe('/dev/matching-rules/versions/v2id');

  await user.click(screen.getByRole('button', { name: 'Stay' }));
  expect(screen.queryByRole('heading', { name: 'Leave without saving?' })).toBeNull();
  expect(screen.getByTestId('where').textContent).toBe('/dev/matching-rules/versions/v2id');

  await user.click(screen.getByRole('link', { name: 'Developer' }));
  await user.click(await screen.findByRole('button', { name: 'Leave' }));
  expect(await screen.findByText('Developer page')).toBeTruthy();
  expect(screen.getByTestId('where').textContent).toBe('/dev');
});

it('Delete step removes the node and its wires', async () => {
  const user = userEvent.setup();
  renderAt('v2id');
  await user.click(await screen.findByRole('button', { name: 'node n2' }));
  await user.click(screen.getByRole('button', { name: 'Delete step' }));

  expect(screen.queryByRole('button', { name: 'node n2' })).toBeNull();
  const edges = screen.getByTestId('edges').textContent ?? '';
  expect(edges).not.toContain('n2');
  expect(edges).toContain('n3.found>n4');
  expect(screen.getByText('Select a step or a wire to see its settings.')).toBeTruthy();
});

it('Scan input has no settings and no Delete step', async () => {
  const user = userEvent.setup();
  renderAt('v2id');
  await user.click(await screen.findByRole('button', { name: 'node n1' }));
  expect(screen.getByText('No settings.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Delete step' })).toBeNull();
});

it('Scan input is disabled in the palette when the flow has one', async () => {
  const user = userEvent.setup();
  renderAt('v2id');
  const scanInput = await screen.findByRole('button', { name: 'Scan input' }) as HTMLButtonElement;
  expect(scanInput.disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Match' }) as HTMLButtonElement).disabled).toBe(false);

  // a click adds the kind (at the canvas's center) and selects it
  await user.click(screen.getByRole('button', { name: 'Match' }));
  expect(screen.getByRole('button', { name: 'node n7' })).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Field' })).toBeTruthy();
});

it('Scan input is enabled in the palette when the flow has none', async () => {
  api.getMatchingVersion.mockResolvedValue(detail({
    flow: { ...FLOW, nodes: FLOW.nodes.filter((n) => n.id !== 'n1'), edges: FLOW.edges.filter((e) => e.source !== 'n1') },
  }));
  renderAt('v2id');
  const scanInput = await screen.findByRole('button', { name: 'Scan input' }) as HTMLButtonElement;
  expect(scanInput.disabled).toBe(false);
});

it('wires an output from the settings panel', async () => {
  const user = userEvent.setup();
  renderAt('v2id');
  await user.click(await screen.findByRole('button', { name: 'node n3' }));
  await user.click(screen.getByRole('combobox', { name: 'none goes to' }));
  // the palette has a "Not found" button too; the list's entry is the portaled one
  const entry = screen.getAllByRole('button', { name: 'Not found' }).find((b) => b.classList.contains('kbar-item'));
  await user.click(entry!);
  expect(screen.getByTestId('edges').textContent).toContain('n3.none>n6');
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
});
