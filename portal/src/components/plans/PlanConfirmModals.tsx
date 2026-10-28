/**
 * The plan's confirm dialogs (spec Lock, baseline, status date), each a
 * PlanModal that asks once and then writes through the PlanController:
 *  - ReplaceBaselineModal: Set baseline met one already there (409
 *    `baseline_exists`): "Replace the baseline set on <date>?". The date is
 *    an instant, read in the browser's zone like the lock banner's.
 *  - ClearBaselineModal: empties every task's baseline; can't be undone.
 *  - LockModal: "Only progress can be updated until someone unlocks it."
 * A refusal stays in the dialog with its reason; someone else's change
 * (409 plan_changed) closes it quietly — usePlan reloaded and said so.
 */
import { useState, type ReactNode } from 'react';

import { longDate } from '../../lib/format';
import { useToast } from '../../lib/notificationsContext';
import type { ApplyResult } from '../../lib/plans/applyResult';
import { isPlanChanged, planErrorText } from '../../lib/plans/errors';
import PlanModal from './PlanModal';
import { SAID_ALREADY } from './useCompletion';
import { BASELINE_SET } from './usePlanCommands';
import type { PlanController } from './usePlan';

import '../../styles/profile.css';   // .btn-solid

export const BASELINE_CLEARED = 'Baseline cleared.';
export const LOCK_DESCRIPTION = 'Only progress can be updated until someone unlocks it.';

/** A one-question dialog: `write` runs on the action; true closes it. */
function Confirm({ title, description, action, danger = false, write, onClose, children }: {
  title: string;
  description: string;
  action: string;
  danger?: boolean;
  write(): Promise<string | null>;       // the refusal to show, or null when done
  onClose(): void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    setBusy(true);
    setError('');
    const refused = await write();
    if (refused === null) {
      onClose();
      return;
    }
    setError(refused);
    setBusy(false);
  };
  return (
    <PlanModal title={title} description={description} busy={busy} onClose={onClose}
               footer={(
                 <>
                   <button type="button" className={`btn-solid${danger ? ' btn-danger' : ''}`} disabled={busy}
                           onClick={() => void go()}>{action}</button>
                   <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
                   {error && <span className="pf-error" role="alert">{error}</span>}
                 </>
               )}>
      {children}
    </PlanModal>
  );
}

/** A void write's refusal in words; null once done or when someone else's change closed it. */
async function attempt(write: () => Promise<void>): Promise<string | null> {
  try {
    await write();
    return null;
  } catch (err) {
    return isPlanChanged(err) ? null : planErrorText(err);
  }
}

export function ReplaceBaselineModal({ ctl, setAt, onClose }: {
  ctl: PlanController;
  setAt: string | null;
  onClose(): void;
}) {
  const toast = useToast();
  const when = setAt ?? ctl.plan?.baseline_set_at ?? null;
  const title = when ? `Replace the baseline set on ${longDate(when)}?` : 'Replace the baseline?';
  return (
    <Confirm title={title} action="Replace baseline" onClose={onClose}
             description="Every task’s baseline Start, Finish and Duration get the schedule as it stands now."
             write={async () => {
               const result: ApplyResult = await ctl.setBaseline(true);
               if (result.ok) {
                 toast(BASELINE_SET);
                 return null;
               }
               if (result.kind === 'error' && SAID_ALREADY.has(result.code)) return null;
               return result.kind === 'error' ? result.message : 'The baseline couldn’t be set.';
             }} />
  );
}

export function ClearBaselineModal({ ctl, onClose }: { ctl: PlanController; onClose(): void }) {
  const toast = useToast();
  const when = ctl.plan?.baseline_set_at ?? null;
  return (
    <Confirm title="Clear the baseline?" action="Clear baseline" danger onClose={onClose}
             description={`Every task’s baseline${when ? ` (set ${longDate(when)})` : ''} is emptied. This can’t be undone.`}
             write={async () => {
               try {
                 await ctl.clearBaseline();
               } catch (err) {
                 return isPlanChanged(err) ? null : planErrorText(err);
               }
               toast(BASELINE_CLEARED);
               return null;
             }} />
  );
}

export function LockModal({ ctl, onClose }: { ctl: PlanController; onClose(): void }) {
  return (
    <Confirm title="Lock the schedule?" description={LOCK_DESCRIPTION} action="Lock schedule" onClose={onClose}
             write={() => attempt(() => ctl.lock())} />
  );
}
