/**
 * The completion check (spec Progress and completion checks): what the
 * plan's completion rules say when a task is about to reach 100%.
 *
 * - `confirm`: "Completing this will also complete N subtasks" (the open
 *   subtasks a summary takes along) and the open predecessors the plan
 *   warns about; Complete or Cancel.
 * - `blocked`: "These need to be complete first", each with Go to task;
 *   a single Close.
 *
 * Each task shows its ID and name; a blocked list says which rule names
 * it (Subtask, Predecessor). `lead` says what already went in before the
 * check stopped the rest (a paste's rows). useCompletion owns it.
 */
import type { CompletionBlocker } from '../../lib/plans/api';
import PlanModal from './PlanModal';
import type { CompletionStop } from './useCompletion';

import '../../styles/profile.css';   // .btn-solid

const REASONS: Record<CompletionBlocker['reason'], string> = { subtask: 'Subtask', predecessor: 'Predecessor' };

const byId = (tasks: readonly CompletionBlocker[]) => [...tasks].sort((a, b) => a.display_id - b.display_id);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function Tasks({ title, tasks, reasons = false, onGoTo }: {
  title: string;
  tasks: readonly CompletionBlocker[];
  reasons?: boolean;
  onGoTo?(taskId: string): void;
}) {
  return (
    <section className="pln-done-group" aria-label={title}>
      <h4 className="pln-done-title">{title}</h4>
      <ul className="pln-done-tasks">
        {byId(tasks).map((t) => (
          <li key={`${t.reason}:${t.task_id}`} className="pln-done-task">
            <span className="pln-done-id">{t.display_id}</span>
            <span className="pln-done-name">{t.name || 'Untitled task'}</span>
            {reasons && <span className="pln-done-why">{REASONS[t.reason]}</span>}
            {onGoTo && (
              <button type="button" className="mini-btn" aria-label={`Go to task ${t.display_id}`}
                      onClick={() => onGoTo(t.task_id)}>
                Go to task
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function CompletionDialog({ result, lead, busy = false, onConfirm, onGoTo, onClose }: {
  result: CompletionStop;
  /** What already went in before the check stopped the rest. */
  lead?: string;
  /** Complete is on its way. */
  busy?: boolean;
  onConfirm(): void;
  onGoTo(taskId: string): void;
  onClose(): void;
}) {
  if (result.kind === 'blocked') {
    const description = lead
      ? `${lead}The rest waits until these tasks are complete.`
      : 'The plan’s completion rules need these tasks complete first.';
    return (
      <PlanModal title="Can’t complete yet" description={description} onClose={onClose} busy={busy}
                 footer={<button type="button" className="btn-solid" onClick={onClose}>Close</button>}>
        <Tasks title="These need to be complete first" tasks={result.blockers}
               reasons={new Set(result.blockers.map((b) => b.reason)).size > 1} onGoTo={onGoTo} />
      </PlanModal>
    );
  }
  const along = result.willComplete;
  const before = result.openPredecessors;
  const description = lead
    ? `${lead}The rest waits on this check.`
    : 'The plan’s completion rules ask before this goes through.';
  return (
    <PlanModal title="Confirm completion" description={description} onClose={onClose} busy={busy}
               footer={(
                 <>
                   <button type="button" className="btn-solid" disabled={busy} onClick={onConfirm}>
                     {busy ? 'Completing…' : 'Complete'}
                   </button>
                   <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
                 </>
               )}>
      {along.length > 0 && (
        <Tasks title={`Completing this will also complete ${plural(along.length, 'subtask')}`} tasks={along} />
      )}
      {before.length > 0 && (
        <Tasks title={before.length === 1 ? 'This predecessor isn’t complete yet' : 'These predecessors aren’t complete yet'}
               tasks={before} />
      )}
    </PlanModal>
  );
}
