import { expect, it } from 'vitest';

import type { MatchingTraceStep } from './api';
import {
  addNode, connect, defaultSettings, formatSavedAt, litPath, moveNode, nodeTitle, outputsFor,
  removeEdge, removeNode, sameFlow, setSettings, type Flow, type FlowNode,
} from './matchingRules';

const at = { x: 0, y: 0 };
const n = (id: string, kind: FlowNode['kind'], settings: Record<string, string> = {}): FlowNode =>
  ({ id, kind, settings, position: at });

const base: Flow = {
  format: 1,
  nodes: [
    n('n1', 'scan_input'), n('n2', 'clean_up', { op: 'trim' }), n('n3', 'match', { field: 'serial' }),
    n('n4', 'found', { action: 'record_scan' }), n('n5', 'not_found', { message: 'No match' }),
  ],
  edges: [
    { id: 'e1', source: 'n1', output: 'out', target: 'n2' },
    { id: 'e2', source: 'n2', output: 'out', target: 'n3' },
    { id: 'e3', source: 'n3', output: 'found', target: 'n4' },
    { id: 'e4', source: 'n3', output: 'none', target: 'n5' },
  ],
};
const clean = n('c', 'clean_up');
const match = n('m', 'match');

const traceOf = (...steps: [string, string | null][]): MatchingTraceStep[] =>
  steps.map(([node_id, output]) => ({
    node_id, kind: 'x', value_in: '', value_out: null, output, hits: null,
  }));

it('connect replaces the wire on an output and refuses bad wires', () => {
  const f1 = connect(base, 'n3', 'none', 'n5');
  const f2 = connect(f1, 'n3', 'none', 'n4');
  expect(f2.edges.filter((e) => e.source === 'n3' && e.output === 'none').map((e) => e.target)).toEqual(['n4']);
  expect(connect(base, 'n3', 'none', 'n3')).toBe(base);
  expect(connect(base, 'n2', 'out', 'n1')).toBe(base);
  expect(connect(base, 'n4', 'out', 'n5')).toBe(base);
  expect(connect(base, 'n2', 'invalid', 'n5')).toBe(base);
});

it('connect gives a new wire the next edge id', () => {
  const f = connect(base, 'n2', 'out', 'n5');
  expect(f.edges.find((e) => e.source === 'n2')?.id).toBe('e5');
});

it('changing a clean-up from number to trim drops its invalid wire', () => {
  const f: Flow = {
    ...base,
    nodes: base.nodes.map((x) => (x.id === 'n2' ? n('n2', 'clean_up', { op: 'number' }) : x)),
    edges: [...base.edges, { id: 'e5', source: 'n2', output: 'invalid', target: 'n5' }],
  };
  const g = setSettings(f, 'n2', { op: 'trim' });
  expect(g.edges.map((e) => e.id)).toEqual(['e1', 'e2', 'e3', 'e4']);
  expect(g.nodes.find((x) => x.id === 'n2')?.settings).toEqual({ op: 'trim' });
});

it('removeNode drops its wires; addNode numbers after the highest id', () => {
  const g = removeNode(base, 'n3');
  expect(g.nodes.map((x) => x.id)).toEqual(['n1', 'n2', 'n4', 'n5']);
  expect(g.edges.map((e) => e.id)).toEqual(['e1']);
  const added = addNode(base, 'match', { x: 5, y: 6 });
  expect(added.id).toBe('n6');
  expect(added.flow.nodes.at(-1)).toEqual({
    id: 'n6', kind: 'match', position: { x: 5, y: 6 },
    settings: { table: 'assets', search_in: 'move', multiple: 'first' },
  });
});

it('moveNode and removeEdge', () => {
  expect(moveNode(base, 'n1', { x: 9, y: 9 }).nodes[0].position).toEqual({ x: 9, y: 9 });
  expect(removeEdge(base, 'e2').edges.map((e) => e.id)).toEqual(['e1', 'e3', 'e4']);
});

it('litPath lights the visited steps and the wires taken', () => {
  const lit = litPath(traceOf(['n1', 'out'], ['n2', 'out'], ['n3', 'none'], ['n5', null]), base);
  expect([...lit.nodes]).toEqual(['n1', 'n2', 'n3', 'n5']);
  expect([...lit.edges].sort()).toEqual(['e1', 'e2', 'e4']);
});

it('nodeTitle and outputsFor match the server', () => {
  expect(nodeTitle({ ...clean, settings: { op: 'trim' } })).toBe('Clean up (Trim)');
  expect(nodeTitle({ ...match, settings: {} })).toBe('Match');
  expect(nodeTitle({ ...match, settings: { field: 'rfid' } })).toBe('Match (RFID)');
  expect(outputsFor({ ...clean, settings: { op: 'pad_24' } })).toEqual(['out', 'invalid']);
  expect(outputsFor(match)).toEqual(['found', 'none']);
  expect(outputsFor(n('t', 'found'))).toEqual([]);
});

it('defaultSettings', () => {
  expect(defaultSettings('not_found')).toEqual({ message: '' });
  expect(defaultSettings('found')).toEqual({});
});

it('formatSavedAt is 24-hour', () => {
  expect(formatSavedAt(new Date(2026, 10, 10, 14, 2).toISOString())).toMatch(/, 14:02$/);
  expect(formatSavedAt(new Date(2026, 10, 10, 0, 5).toISOString())).toMatch(/, 00:05$/);
  expect(formatSavedAt(null)).toBe('—');
});

it('sameFlow compares by value', () => {
  expect(sameFlow(base, JSON.parse(JSON.stringify(base)))).toBe(true);
  expect(sameFlow(base, moveNode(base, 'n1', { x: 1, y: 1 }))).toBe(false);
});
