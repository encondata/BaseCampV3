/** Matching rules: the flow's types, the label tables and the pure helpers the editor builds on.
 *  The keys, labels and rules mirror api/src/serversherpa/matching_rules/flow.py. */
import type { MatchingState, MatchingTraceStep } from './api';
import { longDate } from './format';

export type NodeKind = 'scan_input' | 'clean_up' | 'match' | 'found' | 'not_found';

export interface FlowNode {
  id: string;
  kind: NodeKind;
  settings: Record<string, string>;
  position: { x: number; y: number };
}

export interface FlowEdge {
  id: string;
  source: string;
  output: string;
  target: string;
}

export interface Flow {
  format: 1;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface Labeled { key: string; label: string }

export const PLACES: Labeled[] = [
  { key: 'printing', label: 'Printing' },
  { key: 'scanning', label: 'Scanning' },
];
export const KINDS: Labeled[] = [
  { key: 'scan_input', label: 'Scan input' },
  { key: 'clean_up', label: 'Clean up' },
  { key: 'match', label: 'Match' },
  { key: 'found', label: 'Found' },
  { key: 'not_found', label: 'Not found' },
];
export const CLEAN_OPS: Labeled[] = [
  { key: 'trim', label: 'Trim' },
  { key: 'upper', label: 'Upper-case' },
  { key: 'lower', label: 'Lower-case' },
  { key: 'strip_zeros', label: 'Strip leading zeros' },
  { key: 'pad_24', label: 'Pad to 24' },
  { key: 'number', label: 'Read as a number' },
];
export const FIELDS: Labeled[] = [
  { key: 'asset_tag', label: 'asset tag' },
  { key: 'serial', label: 'serial' },
  { key: 'rfid', label: 'RFID' },
  { key: 'name', label: 'name' },
];
export const COMPARES: Labeled[] = [
  { key: 'exact', label: 'Exact' },
  { key: 'ignore_case', label: 'Ignore case' },
  { key: 'strip_zeros', label: 'Strip leading zeros on both sides' },
  { key: 'contains', label: 'Contains' },
];
export const SEARCH_IN: Labeled[] = [
  { key: 'move', label: 'This move' },
  { key: 'move_and_client', label: "This move plus the client's other devices" },
];
export const FOUND_ACTIONS: Labeled[] = [
  { key: 'print_label', label: 'Print the label' },
  { key: 'record_scan', label: 'Record the scan' },
];
export const EXPECTED_LABELS: Labeled[] = [
  { key: 'asset_tag', label: 'Found by asset tag' },
  { key: 'serial', label: 'Found by serial' },
  { key: 'rfid', label: 'Found by RFID' },
  { key: 'name', label: 'Found by name' },
  { key: 'not_found', label: 'Not found' },
];
export const STATE_LABELS: Labeled[] = [
  { key: 'draft', label: 'Draft' },
  { key: 'standby', label: 'Standby' },
  { key: 'live', label: 'Live' },
  { key: 'retired', label: 'Retired' },
];

/** Each state's chip classes (directory.css), on the versions table and the editor's top bar. */
export const STATE_CHIP: Record<MatchingState, string> = {
  draft: 'chip tag',
  standby: 'chip c-amber',
  live: 'chip c-green',
  retired: 'chip c-slate',
};

/** The drag-and-drop type a palette entry carries onto the canvas (its value is the kind). */
export const DRAG_TYPE = 'application/x-matching-node';

const labelOf = (table: Labeled[], key: string | undefined): string | undefined =>
  table.find((t) => t.key === key)?.label;

export function outputsFor(node: FlowNode): string[] {
  if (node.kind === 'scan_input') return ['out'];
  if (node.kind === 'clean_up') {
    return node.settings.op === 'pad_24' || node.settings.op === 'number' ? ['out', 'invalid'] : ['out'];
  }
  if (node.kind === 'match') return ['found', 'none'];
  return [];
}

export function nodeTitle(node: FlowNode): string {
  const base = labelOf(KINDS, node.kind) ?? node.kind;
  if (node.kind === 'clean_up') {
    const op = labelOf(CLEAN_OPS, node.settings.op);
    if (op) return `${base} (${op})`;
  } else if (node.kind === 'match') {
    const field = labelOf(FIELDS, node.settings.field);
    if (field) return `${base} (${field})`;
  }
  return base;
}

export function defaultSettings(kind: NodeKind): Record<string, string> {
  if (kind === 'match') return { table: 'assets', search_in: 'move', multiple: 'first' };
  if (kind === 'not_found') return { message: '' };
  return {};
}

const suffix = (id: string): number => {
  const m = /(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
};
const nextId = (prefix: string, ids: string[]): string => `${prefix}${Math.max(0, ...ids.map(suffix)) + 1}`;

export function addNode(flow: Flow, kind: NodeKind, position: { x: number; y: number }): { flow: Flow; id: string } {
  const id = nextId('n', flow.nodes.map((n) => n.id));
  const node: FlowNode = { id, kind, settings: defaultSettings(kind), position };
  return { flow: { ...flow, nodes: [...flow.nodes, node] }, id };
}

/** Whether `connect` would wire `source`'s `output` to `target`: both steps
 *  exist, they differ, the target isn't a Scan input, and the output is one
 *  the source has. (The canvas's isValidConnection and the settings panel's
 *  Wires lists use it.) */
export function canConnect(flow: Flow, source: string, output: string, target: string): boolean {
  const from = flow.nodes.find((n) => n.id === source);
  const to = flow.nodes.find((n) => n.id === target);
  if (!from || !to || source === target || to.kind === 'scan_input') return false;
  return outputsFor(from).includes(output);
}

export function connect(flow: Flow, source: string, output: string, target: string): Flow {
  if (!canConnect(flow, source, output, target)) return flow;
  const kept = flow.edges.filter((e) => !(e.source === source && e.output === output));
  const id = nextId('e', flow.edges.map((e) => e.id));
  return { ...flow, edges: [...kept, { id, source, output, target }] };
}

export function setSettings(flow: Flow, id: string, settings: Record<string, string>): Flow {
  const nodes = flow.nodes.map((n) => (n.id === id ? { ...n, settings } : n));
  const node = nodes.find((n) => n.id === id);
  if (!node) return flow;
  const outs = outputsFor(node);
  return { ...flow, nodes, edges: flow.edges.filter((e) => e.source !== id || outs.includes(e.output)) };
}

export function moveNode(flow: Flow, id: string, position: { x: number; y: number }): Flow {
  return { ...flow, nodes: flow.nodes.map((n) => (n.id === id ? { ...n, position } : n)) };
}

export function removeNode(flow: Flow, id: string): Flow {
  return {
    ...flow,
    nodes: flow.nodes.filter((n) => n.id !== id),
    edges: flow.edges.filter((e) => e.source !== id && e.target !== id),
  };
}

export function removeEdge(flow: Flow, id: string): Flow {
  return { ...flow, edges: flow.edges.filter((e) => e.id !== id) };
}

/** The nodes a test run visited and the wires it took between them.
 *  `endNodeId` (the run's `end_node_id`) is where the run ended: it is lit
 *  too, with the wire into it from the last step's output. That covers a
 *  stop the trace has no step for (bad settings: the engine stops before
 *  recording the step) and the closing wire of a loop. */
export function litPath(
  trace: MatchingTraceStep[], flow: Flow, endNodeId?: string | null,
): { nodes: Set<string>; edges: Set<string> } {
  const nodes = new Set(trace.map((s) => s.node_id));
  const edges = new Set<string>();
  const wire = (from: MatchingTraceStep, to: string) => {
    if (from.output == null) return;
    for (const e of flow.edges) {
      if (e.source === from.node_id && e.output === from.output && e.target === to) edges.add(e.id);
    }
  };
  trace.forEach((step, i) => {
    const next = trace[i + 1];
    if (next) wire(step, next.node_id);
  });
  const last = trace.at(-1);
  if (endNodeId) {
    nodes.add(endNodeId);
    if (last) wire(last, endNodeId);
  }
  return { nodes, edges };
}

const two = (n: number): string => String(n).padStart(2, '0');

export function formatSavedAt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${longDate(iso)}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function sameFlow(a: Flow, b: Flow): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
