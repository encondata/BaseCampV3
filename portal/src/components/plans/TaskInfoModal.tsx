/**
 * MS Project's Task Information (Shift+F2, a double-click on a row's
 * number or a bar, the toolbar's Information; Notes opens it on the Notes
 * tab): the task's fields in five `.segmented` tabs — General,
 * Predecessors, Resources, Advanced, Notes (spec Dialogs). The form logic
 * is lib/plans/taskInfo.
 *
 * - OK sends one batch with every change (taskInfoOps); nothing changed
 *   closes without a write; Cancel discards. What is refused here (a bad
 *   duration or lag, a constraint with no date) shows by its field and the
 *   dialog goes to that tab; what the API refuses stays in the dialog with
 *   its reason.
 * - A 100% that the completion rules stop goes to the completion check
 *   over this dialog: Complete resends the same batch with confirm and
 *   closes both; Cancel comes back here with the edits.
 * - A summary's duration and dates show read-only; a locked plan edits
 *   only progress (% Complete, Notes); someone who may only read the plan
 *   sees it all, with Close.
 * - It holds editing while open, and a task that goes away (a reload)
 *   closes it.
 */
import { useEffect, useMemo, useState, type FormEvent } from 'react';

import { useToast } from '../../lib/notificationsContext';
import { completionText } from '../../lib/plans/errors';
import { planUnits } from '../../lib/plans/merge';
import {
  LABEL, TASK_INFO_TABS, canEditField, tabOfError, taskInfoForm, taskInfoOps, type InfoField, type TaskInfoErrors,
  type TaskInfoForm, type TaskInfoTab,
} from '../../lib/plans/taskInfo';
import PlanModal from './PlanModal';
import { AdvancedPanel, NotesPanel, ResourcesPanel } from './taskInfo/MorePanels';
import GeneralPanel from './taskInfo/GeneralPanel';
import PredecessorsPanel from './taskInfo/PredecessorsPanel';
import type { PanelProps } from './taskInfo/panel';
import { SAID_ALREADY, sayNotices, useCompletionAsk } from './useCompletion';
import type { PlanController } from './usePlan';

import '../../styles/profile.css';   // .pf-form, .btn-solid

const HOLD_OWNER = 'task-information';
const FORM_ID = 'pln-ti-form';

export default function TaskInfoModal({ ctl, taskId, tab = 'general', onClose }: {
  ctl: PlanController;
  taskId: string;
  tab?: TaskInfoTab;
  onClose(): void;
}) {
  const toast = useToast();
  const ask = useCompletionAsk();
  const plan = ctl.plan;
  const task = plan?.tasks.find((t) => t.id === taskId) ?? null;
  const [form, setForm] = useState<TaskInfoForm | null>(() => (plan && task ? taskInfoForm(task, plan) : null));
  const [shown, setShown] = useState<TaskInfoTab>(tab);
  const [errors, setErrors] = useState<TaskInfoErrors>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // a refresh waits while the dialog is open; the hold goes when it closes
  const { beginEditing } = ctl;
  useEffect(() => beginEditing(HOLD_OWNER), [beginEditing]);

  // the task went away under the dialog (a reload, someone else's delete)
  const gone = !plan || !task;
  useEffect(() => {
    if (gone && !busy) onClose();
  }, [gone, busy, onClose]);

  const units = useMemo(() => (plan ? planUnits(plan) : null), [plan]);
  if (!plan || !task || !form || !units) return null;

  const readOnly = !plan.permissions.change;
  const can = (field: InfoField) => !busy && canEditField(plan, task, field);
  const set = (patch: Partial<TaskInfoForm>) => {
    setForm((f) => (f ? { ...f, ...patch } : f));
    // a field's error goes once it is edited (the constraint's two fields share one)
    const touched = new Set<string>(Object.keys(patch));
    if (touched.has('constraintType') || touched.has('constraintDate')) touched.add('constraint');
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !touched.has(k)
      && !(touched.has('predecessors') && k.startsWith('pred:')))));
    setError('');
  };

  const send = async () => {
    const built = taskInfoOps(form, task, plan);
    if ('errors' in built) {
      setErrors(built.errors);
      const first = Object.keys(built.errors)[0];
      if (first) setShown(tabOfError(first));
      return;
    }
    setErrors({});
    if (!built.ops.length) {
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    const undo = () => void ctl.undo();
    let result = await ctl.apply(built.ops, LABEL);
    if (!result.ok && result.kind !== 'error') {
      const answer = await ask(result, () => ctl.apply(built.ops, LABEL, { confirm: true }));
      if (answer === null) {          // not completed: back to the dialog, edits kept
        setBusy(false);
        return;
      }
      result = answer;
    }
    if (result.ok) {
      sayNotices(toast, result.notices, undo);
      onClose();
      return;
    }
    if (result.kind === 'error' && SAID_ALREADY.has(result.code)) {
      onClose();                        // reloaded (or gone): usePlan said why
      return;
    }
    setError(result.kind === 'error' ? result.message : completionText(result));
    setBusy(false);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (readOnly) onClose();
    else if (!busy) void send();
  };

  const panel: PanelProps = { plan, task, form, set, errors, can, units };
  let note: string | null = null;
  if (readOnly) note = 'You can see this task, but not change it.';
  else if (plan.locked_at) note = 'Schedule is locked: only % Complete and Notes can change.';

  return (
    <PlanModal title="Task Information" size="wide" busy={busy} onClose={onClose}
               description={`Task ${task.display_id}: ${task.name || 'Untitled task'}`}
               footer={readOnly
                 ? <button type="button" className="btn-solid" onClick={onClose}>Close</button>
                 : (
                   <>
                     <button type="submit" form={FORM_ID} className="btn-solid" disabled={busy}>OK</button>
                     <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
                     {error && <span className="pf-error" role="alert">{error}</span>}
                   </>
                 )}>
      <div className="pln-ti">
        <div className="segmented pln-ti-tabs" role="group" aria-label="Task Information tabs">
          {TASK_INFO_TABS.map((t) => (
            <button key={t.key} type="button" aria-pressed={shown === t.key} className={shown === t.key ? 'on' : ''}
                    onClick={() => setShown(t.key)}>
              {t.label}
            </button>
          ))}
        </div>
        {note && <p className={`pln-note pln-ti-state${readOnly ? '' : ' pln-locked-note'}`}>{note}</p>}
        <form id={FORM_ID} className="pln-ti-body" onSubmit={onSubmit} noValidate>
          <div hidden={shown !== 'general'}><GeneralPanel {...panel} /></div>
          <div hidden={shown !== 'predecessors'}><PredecessorsPanel {...panel} /></div>
          <div hidden={shown !== 'resources'}><ResourcesPanel {...panel} /></div>
          <div hidden={shown !== 'advanced'}><AdvancedPanel {...panel} /></div>
          <div hidden={shown !== 'notes'}><NotesPanel {...panel} /></div>
        </form>
      </div>
    </PlanModal>
  );
}
