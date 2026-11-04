/**
 * Task Information › Predecessors: MS Project's grid of the links into the
 * task — ID, Task Name (a ComboBox over the tasks it may follow: not
 * itself, its summaries or its subtasks), Type and Lag — with Add and
 * Remove. A summary takes only Finish-to-Start and Start-to-Start links
 * into it. OK sends link ops (taskInfoOps), never the Predecessors text.
 * A CSS grid, not a table.
 */
import { useRef } from 'react';

import { predecessorChoices, SUMMARY_LINK_TYPES, type PredecessorLine } from '../../../lib/plans/taskInfo';
import { LINK_TYPES, type LinkType } from '../../../lib/plans/predecessors';
import ComboBox, { type ComboOption } from '../../ComboBox';
import { LINK_TYPE_LABELS } from '../TaskDependencyModal';
import { errorId, type PanelProps } from './panel';

export default function PredecessorsPanel({ plan, task, form, set, errors, can }: PanelProps) {
  const seq = useRef(0);
  const editable = can('predecessors');
  const lines = form.predecessors;
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const choices = predecessorChoices(task, plan);
  const types = (task.is_summary ? SUMMARY_LINK_TYPES : LINK_TYPES)
    .map((t): ComboOption => ({ value: t, label: LINK_TYPE_LABELS[t] }));

  const change = (key: string, patch: Partial<PredecessorLine>) =>
    set({ predecessors: lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });
  const remove = (key: string) => set({ predecessors: lines.filter((l) => l.key !== key) });
  const add = () => {
    seq.current += 1;
    set({ predecessors: [...lines, { key: `new-${seq.current}`, linkId: null, taskId: '', type: 'FS', lag: '' }] });
  };

  return (
    <div className="pln-ti-panel">
      {lines.length > 0 ? (
        <div className="pln-ti-preds" role="group" aria-label="Predecessors">
          <div className="pln-ti-pred-cols" aria-hidden="true">
            <span>ID</span><span>Task Name</span><span>Type</span><span>Lag</span><span />
          </div>
          {lines.map((line, i) => {
            const n = i + 1;
            const picked = byId.get(line.taskId);
            const taken = new Set(lines.filter((l) => l.key !== line.key).map((l) => l.taskId));
            const options = choices.filter((t) => !taken.has(t.id))
              .map((t): ComboOption => ({ value: t.id, label: t.name || 'Untitled task', sub: `ID ${t.display_id}` }));
            // a summary's existing finish link still shows its type
            const typeOptions = types.some((t) => t.value === line.type)
              ? types : [...types, { value: line.type, label: LINK_TYPE_LABELS[line.type] }];
            const err = errors[`pred:${line.key}`];
            return (
              <div key={line.key} className="pln-ti-pred" role="group" aria-label={`Predecessor ${n}`}>
                <span className="pln-ti-pred-id mono">{picked?.display_id ?? ''}</span>
                <ComboBox options={options} value={line.taskId} ariaLabel={`Predecessor task ${n}`}
                          placeholder="Pick a task…" disabled={!editable}
                          onChange={(v) => change(line.key, { taskId: v })} />
                <ComboBox options={typeOptions} value={line.type} ariaLabel={`Type ${n}`} disabled={!editable}
                          onChange={(v) => change(line.key, { type: v as LinkType })} />
                <input type="text" className="pln-ti-lag" aria-label={`Lag ${n}`} value={line.lag} placeholder="0d"
                       autoComplete="off" spellCheck={false} disabled={!editable}
                       aria-invalid={err ? true : undefined} aria-describedby={err ? errorId(`pred:${line.key}`) : undefined}
                       onChange={(e) => change(line.key, { lag: e.target.value })} />
                <button type="button" className="mini-btn pln-icon-btn" aria-label={`Remove predecessor ${n}`}
                        title="Remove" disabled={!editable} onClick={() => remove(line.key)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                       strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
                </button>
                {err && <p id={errorId(`pred:${line.key}`)} className="pf-error pln-ti-pred-error" role="alert">{err}</p>}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="pln-note">No predecessors: this task can start with the project.</p>
      )}
      <div>
        <button type="button" className="mini-btn" disabled={!editable} onClick={add}>Add predecessor</button>
      </div>
    </div>
  );
}
