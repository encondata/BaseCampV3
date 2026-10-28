/**
 * MS Project's Update Project (More › Update project…): the status date
 * (today in plan time by default: `plan.now`'s day; blank sends null, so
 * the status date is always now) and "Update work as
 * complete through" a date — every task finishing by then goes to 100%,
 * every task spanning it is marked on track (spec Progress). The date
 * goes only while its switch is on. A date alone is the calendar's
 * default end that day (the API's rule).
 *
 * A 100% the completion rules stop goes through the completion check over
 * this dialog: Complete resends with confirm and closes both; Cancel
 * comes back here. A progress edit, so it works on a locked plan too.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useToast } from '../../lib/notificationsContext';
import type { UpdateProjectBody } from '../../lib/plans/api';
import { PARTIAL_DATE } from '../../lib/plans/editOps';
import { completionText } from '../../lib/plans/errors';
import { dayOf, fromDateInput } from '../../lib/plans/floatingTime';
import { Switch } from '../Switch';
import PlanModal from './PlanModal';
import { SAID_ALREADY, sayNotices, useCompletionAsk } from './useCompletion';
import type { PlanController } from './usePlan';

import '../../styles/profile.css';   // .pf-form, .btn-solid

const HOLD_OWNER = 'update-project';
const FORM_ID = 'pln-update-form';

export default function UpdateProjectModal({ ctl, onClose }: { ctl: PlanController; onClose(): void }) {
  const toast = useToast();
  const ask = useCompletionAsk();
  const plan = ctl.plan;
  const today = plan ? dayOf(plan.now) : '';
  const [status, setStatus] = useState(today);
  const [through, setThrough] = useState(false);
  const [throughDate, setThroughDate] = useState(today);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const statusRef = useRef<HTMLInputElement>(null);

  const { beginEditing } = ctl;
  useEffect(() => beginEditing(HOLD_OWNER), [beginEditing]);

  useEffect(() => {
    if (!plan && !busy) onClose();
  }, [plan, busy, onClose]);
  if (!plan) return null;

  const update = async () => {
    // blank is now (null); part of a date reads as blank too, so it's refused instead
    if (statusRef.current?.validity?.badInput) {
      setError(PARTIAL_DATE);
      return;
    }
    const body: UpdateProjectBody = { status_date: fromDateInput(status) };
    if (through) {
      const day = fromDateInput(throughDate);
      if (!day) {
        setError('Enter the date work is complete through.');
        return;
      }
      body.complete_through = day;
    }
    setBusy(true);
    setError('');
    let result = await ctl.updateProject(body);
    if (!result.ok && result.kind !== 'error') {
      const answer = await ask(result, () => ctl.updateProject({ ...body, confirm: true }));
      if (answer === null) {
        setBusy(false);
        return;
      }
      result = answer;
    }
    if (result.ok) {
      sayNotices(toast, result.notices, () => void ctl.undo());
      onClose();
      return;
    }
    if (result.kind === 'error' && SAID_ALREADY.has(result.code)) {
      onClose();
      return;
    }
    setError(result.kind === 'error' ? result.message : completionText(result));
    setBusy(false);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) void update();
  };

  return (
    <PlanModal title="Update project" busy={busy} onClose={onClose}
               description="Set the status date and, if you like, mark the work up to a date as done."
               footer={(
                 <>
                   <button type="submit" form={FORM_ID} className="btn-solid" disabled={busy}>
                     {busy ? 'Updating…' : 'Update'}
                   </button>
                   <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
                   {error && <span className="pf-error" role="alert">{error}</span>}
                 </>
               )}>
      <form id={FORM_ID} className="pf-form pln-update" onSubmit={onSubmit} noValidate>
        <div className="full">
          <label htmlFor="pln-update-status">Status date</label>
          <input ref={statusRef} id="pln-update-status" type="date" value={status} disabled={busy}
                 onChange={(e) => setStatus(e.target.value)} />
          <p className="pln-note pln-set-hint">Blank: the status date is always now.</p>
        </div>
        <div className="full pln-switch-line">
          <span className="pln-switch-text">
            <b>Update work as complete through</b>
            <span>Tasks finishing by then go to 100%; tasks spanning it are marked on track.</span>
          </span>
          <Switch checked={through} label="Update work as complete through" disabled={busy}
                  onChange={(on) => {
                    setThrough(on);
                    if (on && !throughDate) setThroughDate(status);
                  }} />
        </div>
        <div className="full">
          <label htmlFor="pln-update-through">Complete through</label>
          <input id="pln-update-through" type="date" value={throughDate} disabled={busy || !through}
                 onChange={(e) => setThroughDate(e.target.value)} />
        </div>
      </form>
    </PlanModal>
  );
}
