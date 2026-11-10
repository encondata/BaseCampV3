// @vitest-environment jsdom
/** NodeSettings — the Wires section: one "{output} goes to" list per output,
 *  offering only the steps connect() allows, plus Not wired. The lists'
 *  menus are portaled, so their options are queried through `screen`. */

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { Flow } from '../../lib/matchingRules';
import NodeSettings from './NodeSettings';

const FLOW: Flow = {
  format: 1,
  nodes: [
    { id: 'n1', kind: 'scan_input', settings: {}, position: { x: 0, y: 0 } },
    { id: 'n2', kind: 'clean_up', settings: { op: 'trim' }, position: { x: 0, y: 0 } },
    {
      id: 'n3', kind: 'match',
      settings: { table: 'assets', field: 'asset_tag', compare: 'ignore_case', search_in: 'move', multiple: 'first' },
      position: { x: 0, y: 0 },
    },
    { id: 'n4', kind: 'found', settings: { action: 'print_label' }, position: { x: 0, y: 0 } },
    { id: 'n6', kind: 'not_found', settings: { message: 'No match' }, position: { x: 0, y: 0 } },
  ],
  edges: [
    { id: 'e1', source: 'n1', output: 'out', target: 'n2' },
    { id: 'e2', source: 'n2', output: 'out', target: 'n3' },
    { id: 'e3', source: 'n3', output: 'found', target: 'n4' },
  ],
};

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; ComboBox scrolls its active option
});
afterEach(cleanup);

function renderFor(id: string, onFlowChange = vi.fn()) {
  const node = FLOW.nodes.find((n) => n.id === id) ?? null;
  render(<NodeSettings flow={FLOW} node={node} edge={null} onChange={vi.fn()} onFlowChange={onFlowChange}
                       onDeleteNode={vi.fn()} onDeleteEdge={vi.fn()} />);
  return onFlowChange;
}

const optionNames = () => screen.getAllByRole('button')
  .filter((b) => b.classList.contains('kbar-item'))
  .map((b) => b.textContent);

it('one list per output, showing where each goes now', () => {
  renderFor('n3');
  expect((screen.getByRole('combobox', { name: 'found goes to' }) as HTMLInputElement).value).toBe('Found');
  expect((screen.getByRole('combobox', { name: 'none goes to' }) as HTMLInputElement).value).toBe('Not wired');
});

it('picking a step wires the output to it', async () => {
  const user = userEvent.setup();
  const onFlowChange = renderFor('n3');
  await user.click(screen.getByRole('combobox', { name: 'none goes to' }));
  await user.click(screen.getByRole('button', { name: 'Not found' }));
  expect(onFlowChange).toHaveBeenCalledTimes(1);
  const flow = onFlowChange.mock.calls[0][0] as Flow;
  expect(flow.edges.filter((e) => e.source === 'n3' && e.output === 'none').map((e) => e.target)).toEqual(['n6']);
  expect(flow.edges).toHaveLength(4);
});

it('Not wired removes the output\'s wire', async () => {
  const user = userEvent.setup();
  const onFlowChange = renderFor('n3');
  await user.click(screen.getByRole('combobox', { name: 'found goes to' }));
  await user.click(screen.getByRole('button', { name: 'Not wired' }));
  const flow = onFlowChange.mock.calls[0][0] as Flow;
  expect(flow.edges.some((e) => e.source === 'n3' && e.output === 'found')).toBe(false);
  expect(flow.edges.map((e) => e.id)).toEqual(['e1', 'e2']);
});

it('never offers a Scan input or the step itself', async () => {
  const user = userEvent.setup();
  renderFor('n2');
  await user.click(screen.getByRole('combobox', { name: 'out goes to' }));
  expect(optionNames()).toEqual(['Not wired', 'Match (asset tag)', 'Found', 'Not found']);
});

it('a Scan input has no settings but does have its wire', () => {
  renderFor('n1');
  expect(screen.getByText('No settings.')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'out goes to' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Delete step' })).toBeNull();
});

it('a step without outputs has no Wires section', () => {
  renderFor('n4');
  expect(screen.queryByText('Wires')).toBeNull();
  expect(screen.getByRole('button', { name: 'Delete step' })).toBeTruthy();
});

it('a selected wire reads From … to …', () => {
  render(<NodeSettings flow={FLOW} node={null} edge={FLOW.edges[2]} onChange={vi.fn()} onFlowChange={vi.fn()}
                       onDeleteNode={vi.fn()} onDeleteEdge={vi.fn()} />);
  expect(screen.getByText('From Match (asset tag) (found) to Found')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Delete wire' })).toBeTruthy();
});
