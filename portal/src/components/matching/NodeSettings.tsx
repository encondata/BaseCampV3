/** The editor's settings panel: the selected step's settings, or the
 *  selected wire. Each control is the visible one for a canvas gesture:
 *  Wires ("{output} goes to", for a step with outputs) for dragging a wire
 *  between ports, Delete step and Delete wire for the Delete key. A flow's
 *  Scan input can't be deleted. The lists portal their menus, so the
 *  panel's scroll box doesn't clip them. */

import ComboBox, { type ComboOption } from '../ComboBox';
import {
  canConnect, CLEAN_OPS, COMPARES, connect, FIELDS, FOUND_ACTIONS, nodeTitle, outputsFor, removeEdge, SEARCH_IN,
  type Flow, type FlowEdge, type FlowNode, type Labeled,
} from '../../lib/matchingRules';

const opts = (table: Labeled[]): ComboOption[] => table.map((t) => ({ value: t.key, label: t.label }));
const TABLES: ComboOption[] = [{ value: 'assets', label: 'Assets' }];
/** The Wires lists' "Not wired" entry (no step id looks like this). */
const NOT_WIRED = ' none';

function Pick({ id, label, options, value, onPick }: {
  id: string;
  label: string;
  options: ComboOption[];
  value: string | undefined;
  onPick: (v: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id}>{label}</label>
      <ComboBox inputId={id} options={options} value={value ?? ''} onChange={onPick} portal />
    </div>
  );
}

/** One list per output: the steps it may wire to (connect()'s rules), by title. */
function Wires({ flow, node, onFlowChange }: { flow: Flow; node: FlowNode; onFlowChange: (f: Flow) => void }) {
  return (
    <>
      <h3 className="mr-panel-title mr-wires-title">Wires</h3>
      {outputsFor(node).map((out) => {
        const wire = flow.edges.find((e) => e.source === node.id && e.output === out);
        const targets = flow.nodes.filter((t) => canConnect(flow, node.id, out, t.id));
        const titles = targets.map(nodeTitle);
        const options: ComboOption[] = [
          { value: NOT_WIRED, label: 'Not wired' },
          // two steps with one title (two Not found) tell apart by id
          ...targets.map((t, i) => ({
            value: t.id,
            label: titles[i],
            sub: titles.indexOf(titles[i]) !== titles.lastIndexOf(titles[i]) ? t.id : null,
          })),
        ];
        return (
          <Pick key={out} id={`mr-wire-${out}`} label={`${out} goes to`} options={options}
                value={wire?.target ?? NOT_WIRED}
                onPick={(v) => {
                  if (v === NOT_WIRED) {
                    if (wire) onFlowChange(removeEdge(flow, wire.id));
                  } else if (v !== wire?.target) {
                    onFlowChange(connect(flow, node.id, out, v));
                  }
                }} />
        );
      })}
    </>
  );
}

export default function NodeSettings({ flow, node, edge, onChange, onFlowChange, onDeleteNode, onDeleteEdge }: {
  flow: Flow;
  node: FlowNode | null;
  edge: FlowEdge | null;
  /** The selected step's new settings. */
  onChange: (settings: Record<string, string>) => void;
  /** A wire made or removed from the Wires lists. */
  onFlowChange: (flow: Flow) => void;
  onDeleteNode: () => void;
  onDeleteEdge: () => void;
}) {
  const titleOf = (id: string) => {
    const n = flow.nodes.find((x) => x.id === id);
    return n ? nodeTitle(n) : id;
  };

  if (edge) {
    return (
      <section className="mr-side mr-settings-panel mr-scroll" aria-labelledby="mr-settings-title">
        <h2 className="mr-panel-title" id="mr-settings-title">Wire</h2>
        <p className="page-hint">{`From ${titleOf(edge.source)} (${edge.output}) to ${titleOf(edge.target)}`}</p>
        <button type="button" className="mini-btn danger" onClick={onDeleteEdge}>Delete wire</button>
      </section>
    );
  }
  if (!node) {
    return (
      <section className="mr-side mr-settings-panel mr-scroll" aria-labelledby="mr-settings-title">
        <h2 className="mr-panel-title" id="mr-settings-title">Settings</h2>
        <p className="page-hint">Select a step or a wire to see its settings.</p>
      </section>
    );
  }

  const set = (key: string) => (v: string) => onChange({ ...node.settings, [key]: v });
  const s = node.settings;
  const hasOutputs = outputsFor(node).length > 0;
  return (
    <section className="mr-side mr-settings-panel mr-scroll" aria-labelledby="mr-settings-title">
      <h2 className="mr-panel-title" id="mr-settings-title">{nodeTitle(node)}</h2>
      {node.kind === 'scan_input' && <p className="page-hint">No settings.</p>}
      <div className="pf-form mr-settings-form">
        {node.kind === 'clean_up' && (
          <Pick id="mr-set-op" label="Clean up" options={opts(CLEAN_OPS)} value={s.op} onPick={set('op')} />
        )}
        {node.kind === 'match' && (
          <>
            <Pick id="mr-set-table" label="Table" options={TABLES} value={s.table} onPick={set('table')} />
            <Pick id="mr-set-field" label="Field" options={opts(FIELDS)} value={s.field} onPick={set('field')} />
            <Pick id="mr-set-compare" label="Compare" options={opts(COMPARES)} value={s.compare}
                  onPick={set('compare')} />
            <Pick id="mr-set-search" label="Search in" options={opts(SEARCH_IN)} value={s.search_in}
                  onPick={set('search_in')} />
            <p className="mr-fixed">When two or more match: Take the first, by asset tag order</p>
          </>
        )}
        {node.kind === 'found' && (
          <Pick id="mr-set-action" label="What happens" options={opts(FOUND_ACTIONS)} value={s.action}
                onPick={set('action')} />
        )}
        {node.kind === 'not_found' && (
          <div>
            <label htmlFor="mr-set-message">Message</label>
            <input id="mr-set-message" value={s.message ?? ''} onChange={(e) => set('message')(e.target.value)} />
          </div>
        )}
        {hasOutputs && <Wires flow={flow} node={node} onFlowChange={onFlowChange} />}
        {node.kind !== 'scan_input' && (
          <div>
            <button type="button" className="mini-btn danger" onClick={onDeleteNode}>Delete step</button>
          </div>
        )}
      </div>
    </section>
  );
}
