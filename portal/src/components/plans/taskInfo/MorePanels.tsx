/**
 * Task Information's smaller tabs:
 *  - Resources: the Resource Names ChipPicker over the plan's resources,
 *    and who among the assigned won't get reminders (no email, no
 *    portal account), as the sheet's picker says.
 *  - Advanced: the constraint (type and date; a summary takes only As
 *    Soon As Possible and Start No Earlier Than) and Elapsed duration,
 *    which rewrites the Duration's `e` ("3 days" ⇄ "3 edays").
 *  - Notes: the multi-line note (the sheet's Notes cell edits one line;
 *    a note with line breaks is edited here).
 */
import { CONSTRAINT_LABELS } from '../../../lib/plans/indicators';
import { SUMMARY_CONSTRAINTS, elapsedOf, withElapsed } from '../../../lib/plans/taskInfo';
import type { ConstraintType } from '../../../lib/plans/api';
import ChipPicker from '../../ChipPicker';
import ComboBox, { type ComboOption } from '../../ComboBox';
import { Switch } from '../../Switch';
import { resourceOptions } from '../ResourcePicker';
import { FieldError } from './GeneralPanel';
import { dateType, errorId, type PanelProps } from './panel';

/** "Lee Park won’t get reminders", or for several "Lee Park and Ann Bo won’t…". */
function silentNote(names: string[]): string | null {
  if (!names.length) return null;
  const who = names.length === 1 ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${who} won’t get reminders: no email and no portal account.`;
}

export function ResourcesPanel({ plan, task, form, set, can }: PanelProps) {
  const options = resourceOptions(plan.resources, task.assignees);
  const silent = form.resources
    .map((key) => plan.resources.find((r) => `${r.kind}:${r.id}` === key))
    .filter((r) => r && r.kind === 'person' && !r.has_email && !r.has_account)
    .map((r) => r!.name);
  return (
    <div className="pln-ti-panel">
      <span className="pln-ti-label" aria-hidden="true">Resource Names</span>
      <ChipPicker options={options} selected={form.resources} ariaLabel="Resource Names" placeholder="Add a resource…"
                  disabled={!can('resources')} onChange={(keys) => set({ resources: keys })}
                  note={silentNote(silent)} />
      <p className="pln-note">The initiative’s team, staff and the partners on the initiative. Partners get no reminders.</p>
    </div>
  );
}

export function AdvancedPanel({ plan, task, form, set, errors, can, units }: PanelProps) {
  const types: ComboOption[] = (task.is_summary ? SUMMARY_CONSTRAINTS : Object.keys(CONSTRAINT_LABELS) as ConstraintType[])
    .map((t) => ({ value: t, label: CONSTRAINT_LABELS[t] }));
  const elapsed = elapsedOf(form.duration, units);
  const err = errors.constraint;
  return (
    <div className="pf-form pln-ti-form">
      <div>
        <label htmlFor="pln-ti-ctype">Constraint type</label>
        <ComboBox inputId="pln-ti-ctype" ariaLabel="Constraint type" options={types} value={form.constraintType}
                  disabled={!can('constraint')}
                  onChange={(v) => set({ constraintType: v as ConstraintType, ...(v === 'asap' ? { constraintDate: '' } : {}) })} />
      </div>
      <div>
        <label htmlFor="pln-ti-cdate">Constraint date</label>
        <input id="pln-ti-cdate" type={dateType(plan)} value={form.constraintDate}
               disabled={!can('constraint') || form.constraintType === 'asap'}
               aria-invalid={err ? true : undefined} aria-describedby={err ? errorId('constraint') : undefined}
               onChange={(e) => set({ constraintDate: e.target.value })} />
        <FieldError field="constraint" errors={errors} />
      </div>
      <div className="full pln-switch-line">
        <span className="pln-switch-text">
          <b>Elapsed duration</b>
          <span>Counts every hour on the clock, nights and weekends too (3 edays).</span>
        </span>
        <Switch checked={elapsed ?? task.elapsed} label="Elapsed duration"
                disabled={!can('duration') || elapsed === null}
                onChange={(on) => {
                  const text = withElapsed(form.duration, units, on);
                  if (text !== null) set({ duration: text });
                }} />
      </div>
    </div>
  );
}

export function NotesPanel({ form, set, can }: PanelProps) {
  return (
    <div className="pf-form pln-ti-form">
      <div className="full">
        <label htmlFor="pln-ti-notes">Notes</label>
        <textarea id="pln-ti-notes" className="pln-ti-notes" rows={10} value={form.notes} disabled={!can('notes')}
                  onChange={(e) => set({ notes: e.target.value })} />
      </div>
    </div>
  );
}
