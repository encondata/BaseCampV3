/**
 * MS Project's Task Dependency dialog, opened by a click on a link in the
 * Gantt chart: the two tasks (From, To), the link's Type and Lag, Delete
 * and OK. OK sends `update_link` with only what changed (nothing changed
 * sends nothing); Delete sends `delete_link`. The lag is typed like a
 * duration with a sign (+2d, -4h, 1ed; blank is none) and checked here
 * first, its error under the field; what the API refuses (a cycle, a
 * summary's finish link) stays in the dialog with its reason. On a locked
 * plan, or for someone who may only read it, the dialog only shows the link.
 *
 * It holds editing while open (a refresh that finds someone else's change
 * waits), and OK sends before the hold is let go, as the sheet's editor
 * does. A link that goes away meanwhile (a reload) closes it.
 */
import { useEffect, useState, type FormEvent } from 'react';

import { ApiError } from '../../lib/api';
import type { Op, PlanLink, PlanTask } from '../../lib/plans/api';
import { asciiTrim, maxMinutes, parseLag, type Duration } from '../../lib/plans/durations';
import { completionText, planErrorText } from '../../lib/plans/errors';
import { planUnits } from '../../lib/plans/merge';
import { LINK_TYPES, type LinkType } from '../../lib/plans/predecessors';
import ComboBox, { type ComboOption } from '../ComboBox';
import PlanModal from './PlanModal';
import { SAID_ALREADY } from './useCompletion';
import type { PlanController } from './usePlan';

import '../../styles/profile.css';   // .pf-form, .btn-solid

/** MS Project's names for the link types. */
export const LINK_TYPE_LABELS: Record<LinkType, string> = {
  FS: 'Finish-to-Start (FS)',
  SS: 'Start-to-Start (SS)',
  FF: 'Finish-to-Finish (FF)',
  SF: 'Start-to-Finish (SF)',
};

const TYPE_OPTIONS: ComboOption[] = LINK_TYPES.map((t) => ({ value: t, label: LINK_TYPE_LABELS[t] }));

const HOLD_OWNER = 'task-dependency';
const FORM_ID = 'pln-dep-form';

const sameLag = (a: Duration, link: PlanLink): boolean =>
  a.minutes === link.lag_minutes && a.unit === link.lag_unit && a.elapsed === link.lag_elapsed;

function TaskName({ id, task }: { id: string; task: PlanTask | undefined }) {
  return (
    <output id={id} className="pln-dep-task">
      {task && <span className="pln-dep-num">{task.display_id}</span>}
      {task ? task.name || 'Untitled task' : 'A task no longer in the plan'}
    </output>
  );
}

export default function TaskDependencyModal({ ctl, linkId, onClose }: {
  ctl: PlanController;
  linkId: string;
  onClose(): void;
}) {
  const plan = ctl.plan;
  const link = plan?.links.find((l) => l.id === linkId) ?? null;
  const [type, setType] = useState<LinkType>(link?.link_type ?? 'FS');
  const [lag, setLag] = useState(link?.lag_text ?? '');
  const [lagError, setLagError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // a refresh waits while the dialog is open; the hold goes when it closes
  const { beginEditing } = ctl;
  useEffect(() => beginEditing(HOLD_OWNER), [beginEditing]);

  // the link went away under the dialog (a reload, someone else's delete)
  const gone = !plan || !link;
  useEffect(() => {
    if (gone && !busy) onClose();
  }, [gone, busy, onClose]);
  if (!plan || !link) return null;

  const readOnly = !plan.permissions.change || plan.locked_at !== null;
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const units = planUnits(plan);

  /** Sends `ops`; closes once they went through, else says why and stays. */
  const send = async (ops: Op[], label: string) => {
    setBusy(true);
    setError('');
    const result = await ctl.apply(ops, label);
    if (result.ok || (result.kind === 'error' && SAID_ALREADY.has(result.code))) {
      onClose();
      return;
    }
    setError(result.kind === 'error' ? result.message : completionText(result));
    setBusy(false);
  };

  const ok = () => {
    if (busy) return;
    const change: { link_type?: LinkType; lag?: string } = {};
    if (type !== link.link_type) change.link_type = type;
    const text = asciiTrim(lag) || '0';
    if (text !== asciiTrim(link.lag_text)) {
      let parsed: Duration;
      try {
        parsed = parseLag(text, units);
      } catch (err) {
        setLagError(planErrorText(err));
        return;
      }
      if (Math.abs(parsed.minutes) > maxMinutes(units, parsed.elapsed)) {
        // what the API would answer (bad_duration on the lag), said before sending
        setLagError(planErrorText(new ApiError(422, 'bad_duration', { code: 'bad_duration', field: 'lag' }, '')));
        return;
      }
      if (!sameLag(parsed, link)) change.lag = text;
    }
    setLagError('');
    if (change.link_type === undefined && change.lag === undefined) {
      onClose();
      return;
    }
    void send([{ op: 'update_link', id: link.id, ...change }], 'Edit Link');
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (readOnly) onClose();
    else ok();
  };

  const from = byId.get(link.predecessor_id);
  const to = byId.get(link.successor_id);
  let description = 'How the second task follows the first: change the type or lag, or delete the link.';
  if (!plan.permissions.change) description = 'You can see this link, but not change it.';
  else if (plan.locked_at) description = 'The schedule is locked, so this link can’t be changed until it’s unlocked.';

  return (
    <PlanModal title="Task Dependency" description={description} onClose={onClose} busy={busy}
               footer={readOnly ? undefined : (
                 <>
                   <button type="submit" form={FORM_ID} className="btn-solid" disabled={busy}>OK</button>
                   <button type="button" className="mini-btn" disabled={busy} onClick={onClose}>Cancel</button>
                   {error && <span className="pf-error" role="alert">{error}</span>}
                   <button type="button" className="btn-solid btn-danger pln-foot-end" disabled={busy}
                           onClick={() => void send([{ op: 'delete_link', id: link.id }], 'Delete Link')}>
                     Delete
                   </button>
                 </>
               )}>
      <form id={FORM_ID} className="pf-form pln-dep" onSubmit={onSubmit}>
        <div>
          <label htmlFor="pln-dep-from">From</label>
          <TaskName id="pln-dep-from" task={from} />
        </div>
        <div>
          <label htmlFor="pln-dep-to">To</label>
          <TaskName id="pln-dep-to" task={to} />
        </div>
        <div>
          <label htmlFor="pln-dep-type">Type</label>
          <ComboBox portal inputId="pln-dep-type" ariaLabel="Type" options={TYPE_OPTIONS} value={type}
                    disabled={readOnly || busy} onChange={(v) => setType(v as LinkType)} />
        </div>
        <div>
          <label htmlFor="pln-dep-lag">Lag</label>
          <input id="pln-dep-lag" type="text" value={lag} disabled={readOnly || busy} autoComplete="off"
                 spellCheck={false} aria-invalid={lagError ? true : undefined}
                 aria-describedby={lagError ? 'pln-dep-lag-error' : undefined}
                 onChange={(e) => { setLag(e.target.value); setLagError(''); }} />
          {lagError && <p id="pln-dep-lag-error" className="pf-error pln-dep-error" role="alert">{lagError}</p>}
        </div>
      </form>
    </PlanModal>
  );
}
