/**
 * Delete plan (More › Delete plan…, `project_plans:delete`): the whole
 * schedule — tasks, links, assignments and the baseline — goes, and it
 * can't be undone, so the initiative's name has to be typed exactly
 * (surrounding spaces aside) before Delete plan turns on. Once deleted the
 * tab shows the empty state. A refusal stays in the dialog; someone
 * else's change closes it quietly.
 */
import { useState, type FormEvent } from 'react';

import { useToast } from '../../lib/notificationsContext';
import { isPlanChanged, planErrorText } from '../../lib/plans/errors';
import PlanModal from './PlanModal';
import type { PlanController } from './usePlan';

import '../../styles/profile.css';   // .pf-form, .btn-solid

const FORM_ID = 'pln-delete-plan-form';
export const PLAN_DELETED = 'Project plan deleted.';

export default function DeletePlanModal({ ctl, initiativeName, onClose }: {
  ctl: PlanController;
  initiativeName: string;
  onClose(): void;
}) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const matches = typed.trim() === initiativeName.trim();

  const remove = async () => {
    if (!matches || busy) return;
    setBusy(true);
    setError('');
    try {
      await ctl.remove();
      toast(PLAN_DELETED);
      onClose();
    } catch (err) {
      if (isPlanChanged(err)) {
        onClose();
        return;
      }
      setError(planErrorText(err));
      setBusy(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void remove();
  };

  const count = ctl.plan?.tasks.length ?? 0;
  const baseline = ctl.plan?.baseline_set_at ? ' and the baseline' : '';
  const description = count === 0
    ? 'The plan has no tasks yet. This can’t be undone.'
    : `Its ${count} task${count === 1 ? '' : 's'}, their links${baseline} go with it. This can’t be undone.`;
  return (
    <PlanModal title="Delete the project plan?" busy={busy} onClose={onClose} description={description}
               footer={(
                 <>
                   <button type="submit" form={FORM_ID} className="btn-solid btn-danger" disabled={!matches || busy}>
                     {busy ? 'Deleting…' : 'Delete plan'}
                   </button>
                   <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
                   {error && <span className="pf-error" role="alert">{error}</span>}
                 </>
               )}>
      <form id={FORM_ID} className="pf-form pln-delete-plan" onSubmit={onSubmit}>
        <p className="full pln-note">To confirm, type the initiative’s name: <b>{initiativeName}</b></p>
        <div className="full">
          <label htmlFor="pln-delete-plan-name">Initiative name</label>
          <input id="pln-delete-plan-name" type="text" value={typed} autoComplete="off" spellCheck={false}
                 disabled={busy} onChange={(e) => setTyped(e.target.value)} />
        </div>
      </form>
    </PlanModal>
  );
}
