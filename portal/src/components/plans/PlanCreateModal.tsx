/**
 * New project plan (Blank plan): the project start date, then
 * `ctl.create`. The plan's own zone is unknown until it exists, so the
 * date defaults to the browser's today; a date alone starts at the
 * calendar's default start time (the API applies it). The calendar is the
 * system one and the owner is set later in Plan settings.
 *
 * A 409 `plan_exists` (someone else made one meanwhile) closes on their
 * plan, which usePlan has already loaded, and says so; any other refusal
 * stays open with the reason.
 */

import { useState } from 'react';

import { longDateOf } from '../../lib/format';
import { useToast } from '../../lib/notificationsContext';
import { planErrorDetail, planErrorText, isPlanChanged } from '../../lib/plans/errors';
import { fromDateInput } from '../../lib/plans/floatingTime';
import PlanModal from './PlanModal';
import type { PlanController } from './usePlan';

export interface PlanInitiative {
  name: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
}

const FORM_ID = 'pln-create-form';

const pad = (n: number) => String(n).padStart(2, '0');

/** The browser's own calendar day as `YYYY-MM-DD`. Local getters on purpose:
 *  this is "today where the planner sits", not a plan time. */
function browserToday(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** An initiative's date-only field (`YYYY-MM-DD`, or midnight UTC) as
 *  "Nov 14, 2026", read from its digits so no zone shifts the day. */
function initiativeDay(value: string | null): string | null {
  const m = value ? /^(\d{4})-(\d{2})-(\d{2})/.exec(value) : null;
  return m ? longDateOf(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : null;
}

/** "The initiative is scheduled Nov 14, 2026 – Nov 16, 2026." or null. */
function scheduledText(initiative: PlanInitiative): string | null {
  const start = initiativeDay(initiative.scheduled_start);
  const end = initiativeDay(initiative.scheduled_end);
  if (start && end) return `The initiative is scheduled ${start} – ${end}.`;
  if (start) return `The initiative is scheduled to start ${start}.`;
  if (end) return `The initiative is scheduled to end ${end}.`;
  return null;
}

export default function PlanCreateModal({ ctl, initiative, onClose }: {
  ctl: PlanController;
  initiative: PlanInitiative;
  onClose: () => void;
}) {
  const toast = useToast();
  const [start, setStart] = useState(() => browserToday());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const scheduled = scheduledText(initiative);

  const create = async () => {
    const day = fromDateInput(start);
    if (!day) {
      setError('Pick the project start date.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await ctl.create({ project_start: day });
      onClose();
    } catch (err) {
      if (isPlanChanged(err)) {
        onClose();
        return;
      }
      if (planErrorDetail(err)?.code === 'plan_exists') {
        toast(planErrorText(err));
        onClose();
        return;
      }
      setError(planErrorText(err));
      setSaving(false);
    }
  };

  return (
    <PlanModal title="New project plan"
               description="An empty schedule on the system working calendar. Add tasks once it’s created."
               onClose={onClose} busy={saving}
               footer={(
                 <>
                   <button type="submit" form={FORM_ID} className="btn-solid" disabled={saving}>
                     {saving ? 'Creating…' : 'Create plan'}
                   </button>
                   <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
                   {error && <span className="pf-error" role="alert">{error}</span>}
                 </>
               )}>
      <form id={FORM_ID} className="pf-form"
            onSubmit={(e) => { e.preventDefault(); if (!saving) void create(); }}>
        <div>
          <label htmlFor="pln-create-start">Project start</label>
          <input id="pln-create-start" type="date" value={start} disabled={saving}
                 onChange={(e) => setStart(e.target.value)} />
        </div>
        {scheduled && <p className="full pln-note">{scheduled}</p>}
      </form>
    </PlanModal>
  );
}
