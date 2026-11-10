/** The editor's settings panel: the selected step's settings, or the
 *  selected wire. Delete step and Delete wire are the visible controls for
 *  the Delete key on the canvas; a flow's Scan input can't be deleted. The
 *  lists portal their menus, so the panel's scroll box doesn't clip them. */

import ComboBox, { type ComboOption } from '../ComboBox';
import {
  CLEAN_OPS, COMPARES, FIELDS, FOUND_ACTIONS, nodeTitle, SEARCH_IN,
  type FlowEdge, type FlowNode, type Labeled,
} from '../../lib/matchingRules';

const opts = (table: Labeled[]): ComboOption[] => table.map((t) => ({ value: t.key, label: t.label }));
const TABLES: ComboOption[] = [{ value: 'assets', label: 'Assets' }];

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

export default function NodeSettings({ node, edge, titleOf, onChange, onDeleteNode, onDeleteEdge }: {
  node: FlowNode | null;
  edge: FlowEdge | null;
  /** A step's title by id, for the wire's ends. */
  titleOf?: (id: string) => string;
  onChange: (settings: Record<string, string>) => void;
  onDeleteNode: () => void;
  onDeleteEdge: () => void;
}) {
  if (edge) {
    const name = titleOf ?? ((id: string) => id);
    return (
      <section className="mr-side mr-settings-panel mr-scroll" aria-labelledby="mr-settings-title">
        <h2 className="mr-panel-title" id="mr-settings-title">Wire</h2>
        <p className="page-hint">
          {name(edge.source)}, <span className="mono">{edge.output}</span>, to {name(edge.target)}
        </p>
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
  return (
    <section className="mr-side mr-settings-panel mr-scroll" aria-labelledby="mr-settings-title">
      <h2 className="mr-panel-title" id="mr-settings-title">{nodeTitle(node)}</h2>
      {node.kind === 'scan_input' && <p className="page-hint">No settings.</p>}
      {node.kind !== 'scan_input' && (
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
          <div>
            <button type="button" className="mini-btn danger" onClick={onDeleteNode}>Delete step</button>
          </div>
        </div>
      )}
    </section>
  );
}
