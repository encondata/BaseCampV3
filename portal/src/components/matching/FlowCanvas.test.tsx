// @vitest-environment jsdom
/**
 * FlowCanvas — the real React Flow in jsdom, with the React Flow testing
 * recipe's stubs (ResizeObserver, DOMMatrixReadOnly, a 500 px element size).
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';

import type { Flow } from '../../lib/matchingRules';
import FlowCanvas from './FlowCanvas';

beforeAll(() => {
  class ResizeObserverStub {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  class DOMMatrixReadOnlyStub {
    m22: number;
    constructor(transform?: string) {
      const scale = transform?.match(/scale\(([1-9.])\)/)?.[1];
      this.m22 = scale !== undefined ? Number(scale) : 1;
    }
  }
  Object.assign(globalThis, { ResizeObserver: ResizeObserverStub, DOMMatrixReadOnly: DOMMatrixReadOnlyStub });
  Object.defineProperties(HTMLElement.prototype, {
    offsetHeight: { configurable: true, get() { return 500; } },
    offsetWidth: { configurable: true, get() { return 500; } },
  });
});

afterEach(cleanup);

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
    { id: 'n5', kind: 'not_found', settings: { message: 'No match' }, position: { x: 660, y: 60 } },
  ],
  edges: [
    { id: 'e1', source: 'n1', output: 'out', target: 'n2' },
    { id: 'e2', source: 'n2', output: 'out', target: 'n3' },
    { id: 'e3', source: 'n3', output: 'found', target: 'n4' },
    { id: 'e4', source: 'n3', output: 'none', target: 'n5' },
  ],
};

function renderCanvas(props: Partial<Parameters<typeof FlowCanvas>[0]> = {}) {
  return render(
    <div style={{ width: 800, height: 500 }}>
      <button type="button">outside</button>
      <FlowCanvas flow={FLOW} selected={null} warnings={new Set()} lit={null}
                  onChange={vi.fn()} onSelect={vi.fn()} onDropKind={vi.fn()} {...props} />
    </div>,
  );
}

const nodeEl = (container: HTMLElement, id: string): HTMLElement => {
  const el = container.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] .mr-node`);
  if (!el) throw new Error(`no node ${id}`);
  return el;
};

it('renders each step with its title and output labels', () => {
  renderCanvas();
  expect(screen.getByText('Clean up (Trim)')).toBeTruthy();
  expect(screen.getByText('Match (asset tag)')).toBeTruthy();
  expect(screen.getByText('found')).toBeTruthy();
  expect(screen.getByText('none')).toBeTruthy();
});

it('shows no React Flow credit link', () => {
  const { container } = renderCanvas();
  expect(container.querySelector('.react-flow__attribution')).toBeNull();
  expect(screen.queryByRole('link', { name: /react flow/i })).toBeNull();
});

it('marks warned and lit steps', () => {
  const { container, unmount } = renderCanvas({ warnings: new Set(['n3']) });
  expect(nodeEl(container, 'n3').classList.contains('mr-warn')).toBe(true);
  expect(nodeEl(container, 'n2').classList.contains('mr-warn')).toBe(false);
  unmount();

  const lit = renderCanvas({ lit: { nodes: new Set(['n1', 'n2']), edges: new Set(['e1']) } });
  expect(nodeEl(lit.container, 'n2').classList.contains('mr-lit')).toBe(true);
  expect(nodeEl(lit.container, 'n4').classList.contains('mr-dim')).toBe(true);
  expect(nodeEl(lit.container, 'n2').classList.contains('mr-dim')).toBe(false);
});

it('shows labeled zoom buttons and the zoom level', async () => {
  const { container } = renderCanvas();
  for (const label of ['Zoom in', 'Zoom out', 'Fit view']) {
    expect(screen.getByRole('button', { name: label }).textContent).toBe(label);
  }
  // React Flow's icon-only controls are gone
  expect(container.querySelector('.react-flow__controls')).toBeNull();
  const level = screen.getByTitle('Zoom level');
  const before = level.textContent;
  expect(before).toMatch(/^\d+%$/);
  fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
  await waitFor(() => expect(level.textContent).not.toBe(before));
  expect(Number(level.textContent!.replace('%', ''))).toBeGreaterThan(Number(before!.replace('%', '')));
});

const lastFlow = (onChange: ReturnType<typeof vi.fn>): Flow => onChange.mock.calls.at(-1)?.[0] as Flow;

it('the Delete key removes the selected step and its wires, with focus in the canvas', async () => {
  const onChange = vi.fn();
  const { container } = renderCanvas({ selected: { kind: 'node', id: 'n2' }, onChange });
  const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="n2"]')!;
  node.focus();
  fireEvent.keyDown(node, { key: 'Delete', code: 'Delete' });
  fireEvent.keyUp(node, { key: 'Delete', code: 'Delete' });
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  const flow = lastFlow(onChange);
  expect(flow.nodes.map((n) => n.id)).toEqual(['n1', 'n3', 'n4', 'n5']);
  expect(flow.edges.map((e) => e.id)).toEqual(['e3', 'e4']);
});

it('the Delete key removes the selected wire', async () => {
  const onChange = vi.fn();
  const { container } = renderCanvas({ selected: { kind: 'edge', id: 'e4' }, onChange });
  const pane = container.querySelector<HTMLElement>('.react-flow__node[data-id="n1"]')!;
  pane.focus();
  fireEvent.keyDown(pane, { key: 'Backspace', code: 'Backspace' });
  fireEvent.keyUp(pane, { key: 'Backspace', code: 'Backspace' });
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  const flow = lastFlow(onChange);
  expect(flow.nodes).toHaveLength(5);
  expect(flow.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3']);
});

it('the Delete key does nothing while focus is outside the canvas', async () => {
  const onChange = vi.fn();
  renderCanvas({ selected: { kind: 'node', id: 'n2' }, onChange });
  const outside = screen.getByRole('button', { name: 'outside' });
  outside.focus();
  fireEvent.keyDown(outside, { key: 'Backspace', code: 'Backspace' });
  fireEvent.keyUp(outside, { key: 'Backspace', code: 'Backspace' });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(onChange).not.toHaveBeenCalled();
});

it('Scan input is not deletable from the keyboard', async () => {
  const onChange = vi.fn();
  const { container } = renderCanvas({ selected: { kind: 'node', id: 'n1' }, onChange });
  const node = container.querySelector<HTMLElement>('.react-flow__node[data-id="n1"]')!;
  node.focus();
  fireEvent.keyDown(node, { key: 'Delete', code: 'Delete' });
  fireEvent.keyUp(node, { key: 'Delete', code: 'Delete' });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(onChange).not.toHaveBeenCalled();
});
