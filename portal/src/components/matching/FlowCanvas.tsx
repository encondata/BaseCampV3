/**
 * FlowCanvas — the flow editor's canvas on React Flow (@xyflow/react). The
 * only file that imports the library: the page and the other editor parts
 * work on `Flow` (lib/matchingRules) and never see React Flow's types.
 *
 * The flow is the source of truth. Steps map to React Flow nodes (type
 * `mr`), wires to edges (`sourceHandle` = the output, `targetHandle` =
 * `in`). Every edit goes back through the Task 8 helpers: a new wire is
 * `connect()` (and `isValidConnection` is `canConnect()`, the same rules),
 * a move is `moveNode()` once the drag ends or an arrow key moves a step
 * (both arrive as a position change with `dragging: false`), and the
 * Delete or Backspace key is `removeNode()` / `removeEdge()` — only while
 * focus is inside the canvas, so Backspace on a palette button or Save
 * deletes nothing. While a step is being dragged the canvas keeps its own
 * copy of the nodes, so it can follow the pointer; a new `flow` rebuilds
 * that copy (keeping each node's measured size, so React Flow needn't
 * measure it again, and a step mid-drag where the pointer has it).
 *
 * Visible controls for the gestures: zoom in, zoom out and fit view (with
 * the zoom level) for the wheel and pinch; the palette's click to add for
 * dragging a kind in; the settings panel's Wires lists for dragging a wire,
 * and its Delete step and Delete wire for the keys. Selection comes back through `onSelect`, from a click or the
 * keyboard (Enter on a focused step or wire).
 *
 * `handle` (opt-in) gives the page `center()`: the canvas's center in flow
 * coordinates, where a palette click adds its step.
 */

import {
  applyNodeChanges, Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  useViewport,
  type Connection, type Edge, type EdgeChange, type IsValidConnection, type Node, type NodeChange,
  type NodeProps, type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useImperativeHandle, useMemo, useRef, useState, type DragEvent, type Ref } from 'react';

import {
  canConnect, connect, DRAG_TYPE, moveNode, removeEdge, removeNode, type Flow, type FlowNode, type NodeKind,
} from '../../lib/matchingRules';
import FlowNodeView, { type FlowNodeLook, type HandleSlot } from './FlowNodeView';

export type CanvasSelection = { kind: 'node' | 'edge'; id: string };
export type LitPath = { nodes: Set<string>; edges: Set<string> };

export interface FlowCanvasHandle {
  /** The middle of the visible canvas, in flow coordinates. */
  center: () => { x: number; y: number };
}

const KIND_KEYS: NodeKind[] = ['scan_input', 'clean_up', 'match', 'found', 'not_found'];

type MrData = { node: FlowNode; look: FlowNodeLook };
type MrNode = Node<MrData, 'mr'>;

const handle: HandleSlot = (kind, id) => (
  <Handle key={`${kind}:${id}`} type={kind} id={id} position={kind === 'target' ? Position.Left : Position.Right}
          className={`mr-port mr-port-${kind}`} />
);

function MrNodeType({ data }: NodeProps<MrNode>) {
  return <FlowNodeView node={data.node} look={data.look} handle={handle} />;
}

const NODE_TYPES: NodeTypes = { mr: MrNodeType };

function toNodes(
  flow: Flow, selected: CanvasSelection | null, warnings: Set<string>, lit: LitPath | null, prev: MrNode[],
): MrNode[] {
  const before = new Map(prev.map((n) => [n.id, n]));
  return flow.nodes.map((n) => {
    const old = before.get(n.id);
    return {
      id: n.id,
      type: 'mr',
      // a step mid-drag stays under the pointer; its drop commits the position
      position: old?.dragging ? old.position : n.position,
      dragging: old?.dragging,
      data: {
        node: n,
        look: { warn: warnings.has(n.id), lit: !!lit?.nodes.has(n.id), dim: !!lit && !lit.nodes.has(n.id) },
      },
      selected: selected?.kind === 'node' && selected.id === n.id,
      deletable: n.kind !== 'scan_input',
      measured: old?.measured,
    };
  });
}

interface Props {
  flow: Flow;
  selected: CanvasSelection | null;
  warnings: Set<string>;
  lit: LitPath | null;
  onChange: (flow: Flow) => void;
  onSelect: (sel: CanvasSelection | null) => void;
  onDropKind: (kind: NodeKind, position: { x: number; y: number }) => void;
  handle?: Ref<FlowCanvasHandle>;
}

function ZoomLevel() {
  const { zoom } = useViewport();
  return <div className="mr-zoom-level" title="Zoom level">{Math.round(zoom * 100)}%</div>;
}

function Canvas({ flow, selected, warnings, lit, onChange, onSelect, onDropKind, handle: canvasHandle }: Props) {
  const { screenToFlowPosition } = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);
  // The latest flow, so two edits in one tick (a node's delete, then its
  // wires') build on each other instead of on the same render's flow.
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const commit = useCallback((next: Flow) => {
    flowRef.current = next;
    onChange(next);
  }, [onChange]);

  // React Flow's copy of the nodes: rebuilt when an input changes, and
  // carrying the in-between positions of a drag and the measured sizes.
  const [inputs, setInputs] = useState({ flow, selected, warnings, lit });
  const [nodes, setNodes] = useState<MrNode[]>(() => toNodes(flow, selected, warnings, lit, []));
  if (inputs.flow !== flow || inputs.selected !== selected || inputs.warnings !== warnings || inputs.lit !== lit) {
    setInputs({ flow, selected, warnings, lit });
    setNodes((prev) => toNodes(flow, selected, warnings, lit, prev));
  }

  const edges: Edge[] = useMemo(() => flow.edges.map((e) => ({
    id: e.id,
    source: e.source,
    sourceHandle: e.output,
    target: e.target,
    targetHandle: 'in',
    selected: selected?.kind === 'edge' && selected.id === e.id,
    className: lit?.edges.has(e.id) ? 'mr-lit-edge' : undefined,
  })), [flow, selected, lit]);

  useImperativeHandle(canvasHandle, () => ({
    center: () => {
      const r = wrapRef.current?.getBoundingClientRect();
      if (!r) return { x: 0, y: 0 };
      return screenToFlowPosition({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    },
  }), [screenToFlowPosition]);

  const onNodesChange = useCallback((changes: NodeChange<MrNode>[]) => {
    // Selection is the page's (from `selected`), so select changes only
    // report a keyboard pick; removals come through onNodesDelete.
    const kept = changes.filter((c) => c.type === 'position' || c.type === 'dimensions');
    if (kept.length) setNodes((prev) => applyNodeChanges(kept, prev));
    const picked = changes.filter((c) => c.type === 'select' && c.selected);
    if (picked.length === 1 && picked[0].type === 'select') onSelect({ kind: 'node', id: picked[0].id });
    // the one place a move commits: a drag's end and an arrow key's move
    // both report the step's position with `dragging: false`
    let next = flowRef.current;
    for (const c of changes) {
      if (c.type === 'position' && c.dragging === false && c.position) next = moveNode(next, c.id, c.position);
    }
    if (next !== flowRef.current) commit(next);
  }, [onSelect, commit]);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    const picked = changes.filter((c) => c.type === 'select' && c.selected);
    if (picked.length === 1 && picked[0].type === 'select') onSelect({ kind: 'edge', id: picked[0].id });
  }, [onSelect]);

  const isValidConnection: IsValidConnection = useCallback((c: Edge | Connection) => (
    !!c.sourceHandle && canConnect(flowRef.current, c.source, c.sourceHandle, c.target)
  ), []);

  // React Flow hears the delete keys on the whole document; act on them
  // only while focus is inside the canvas.
  const onBeforeDelete = useCallback(async () => !!wrapRef.current?.contains(document.activeElement), []);

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onDrop = (e: DragEvent) => {
    const kind = e.dataTransfer.getData(DRAG_TYPE) as NodeKind;
    if (!KIND_KEYS.includes(kind)) return;
    e.preventDefault();
    onDropKind(kind, screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  return (
    // tabIndex -1: a click on the pane focuses the canvas (so the delete
    // keys work after picking a wire), without adding a tab stop
    <div className="mr-canvas-inner" ref={wrapRef} tabIndex={-1}>
      <ReactFlow<MrNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={(c) => {
          if (c.sourceHandle) commit(connect(flowRef.current, c.source, c.sourceHandle, c.target));
        }}
        isValidConnection={isValidConnection}
        onNodeClick={(_, n) => onSelect({ kind: 'node', id: n.id })}
        onNodeDragStart={(_, n) => onSelect({ kind: 'node', id: n.id })}
        onEdgeClick={(_, e) => onSelect({ kind: 'edge', id: e.id })}
        onPaneClick={() => onSelect(null)}
        onNodesDelete={(gone) => commit(gone.reduce((f, n) => removeNode(f, n.id), flowRef.current))}
        onEdgesDelete={(gone) => commit(gone.reduce((f, e) => removeEdge(f, e.id), flowRef.current))}
        deleteKeyCode={['Backspace', 'Delete']}
        onBeforeDelete={onBeforeDelete}
        onDragOver={onDragOver}
        onDrop={onDrop}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        minZoom={0.25}
        maxZoom={2}
      >
        <Background />
        <Controls showInteractive={false}>
          <ZoomLevel />
        </Controls>
      </ReactFlow>
    </div>
  );
}

export default function FlowCanvas(props: Props) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
