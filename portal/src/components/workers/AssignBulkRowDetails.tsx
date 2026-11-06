/**
 * AssignBulkRowDetails — the Details cell of one AssignBulkUpload preview
 * line: the row's errors (.pf-error), each flag's sentence (amber for a
 * discrepancy, red when a pick is needed) with its "Label: value" lines in
 * a .bulk-diff block, the flag buttons (Update / Ignore, Accept, Ignore)
 * with a pressed state for the current choice, then the worker dropdown
 * (+ Create new worker first, then every matchable person with their
 * partner) and the Role dropdown. Both menus are portaled so the preview
 * table keeps its sideways scroll. Pure rendering; the pane owns the
 * decisions and re-previews.
 */
import { useId } from 'react';

import type { AssignDecision, AssignFlagKind, AssignPreview, AssignRow } from '../../lib/api';
import { FLAG_TEXT } from '../../lib/assignBulk';
import ComboBox, { type ComboOption } from '../ComboBox';

/** Flags one Update / Ignore choice (`decisions.change`) answers. */
export const CHANGE_KINDS: AssignFlagKind[] = ['contact', 'partner', 'assignment'];
/** Flags cleared by adding their kind to `decisions.acknowledged`. */
const IGNORE_KINDS: AssignFlagKind[] = ['status', 'shared_contact', 'no_contact', 'phone_invalid'];
/** Flags only a pick (worker or role) resolves — shown red, not amber. */
const PICK_KINDS: AssignFlagKind[] = ['needs_match', 'role_unknown'];

const IGNORE_LABEL: Partial<Record<AssignFlagKind, string>> = {
  status: 'the status',
  shared_contact: 'the shared contact',
  no_contact: 'the missing contact',
  phone_invalid: 'the phone',
};

interface Props {
  row: AssignRow;
  people: AssignPreview['people'];
  roles: AssignPreview['roles'];
  decision: AssignDecision;
  disabled: boolean;
  onChange(next: AssignDecision): void;
  onPickPerson(id: string): void;
}

export default function AssignBulkRowDetails({
  row, people, roles, decision, disabled, onChange, onPickPerson,
}: Props) {
  const n = row.row;
  const roleId = useId();
  const acknowledged = decision.acknowledged ?? [];
  const hasChange = row.flags.some((f) => CHANGE_KINDS.includes(f.kind));
  const ackKinds = row.flags.map((f) => f.kind).filter((k) => IGNORE_KINDS.includes(k));
  const nameDiffers = row.flags.some((f) => f.kind === 'name_differs');

  const setChange = (change: 'update' | 'ignore') => {
    const next = { ...decision };
    if (decision.change === change) delete next.change;
    else next.change = change;
    onChange(next);
  };
  const toggleAck = (kind: AssignFlagKind) => {
    const list = acknowledged.includes(kind)
      ? acknowledged.filter((k) => k !== kind)
      : [...acknowledged, kind];
    const next: AssignDecision = { ...decision, acknowledged: list };
    if (list.length === 0) delete next.acknowledged;
    onChange(next);
  };

  const workerOptions: ComboOption[] = [
    { value: 'new', label: `+ Create new worker "${row.name}"` },
    ...people.map((p) => ({ value: p.id, label: p.label, sub: p.detail || null })),
  ];
  const workerValue = decision.person ?? (row.create ? 'new' : row.person_id ?? '');
  const roleOptions: ComboOption[] = roles.map((r) => ({ value: r.key, label: r.label }));

  const pressed = (on: boolean) => ({ 'aria-pressed': on });

  return (
    <>
      {row.errors.map((e) => <span key={e} className="pf-error">{e}</span>)}
      {row.flags.map((f) => (
        <div key={f.kind}>
          <span className={`pf-error${PICK_KINDS.includes(f.kind) ? '' : ' bulk-warn'}`}>
            {FLAG_TEXT[f.kind]}
          </span>
          {(f.lines.length > 0 || f.other_person) && (
            <div className="bulk-diff">
              {f.lines.map((l) => <span key={l.label}>{l.label}: {l.value}</span>)}
              {f.other_person && <span>Shared with: {f.other_person}</span>}
            </div>
          )}
        </div>
      ))}
      {(hasChange || nameDiffers || ackKinds.length > 0) && (
        <div className="bulk-actions bulk-choice">
          {hasChange && (
            <>
              <button type="button" className="mini-btn" disabled={disabled}
                      aria-label={`Update row ${n}`} {...pressed(decision.change === 'update')}
                      onClick={() => setChange('update')}>
                Update
              </button>
              <button type="button" className="mini-btn" disabled={disabled}
                      aria-label={`Ignore the discrepancy on row ${n}`}
                      {...pressed(decision.change === 'ignore')}
                      onClick={() => setChange('ignore')}>
                Ignore
              </button>
            </>
          )}
          {nameDiffers && (
            <button type="button" className="mini-btn" disabled={disabled}
                    aria-label={`Accept the name on row ${n}`}
                    {...pressed(acknowledged.includes('name_differs'))}
                    onClick={() => toggleAck('name_differs')}>
              Accept
            </button>
          )}
          {ackKinds.map((k) => (
            <button key={k} type="button" className="mini-btn" disabled={disabled}
                    aria-label={`Ignore ${IGNORE_LABEL[k]} on row ${n}`}
                    {...pressed(acknowledged.includes(k))}
                    onClick={() => toggleAck(k)}>
              Ignore
            </button>
          ))}
        </div>
      )}
      <div className="bulk-pick">
        <ComboBox
          portal
          ariaLabel={`Worker for row ${n}`}
          options={workerOptions}
          value={workerValue}
          placeholder="Pick a worker…"
          disabled={disabled}
          onChange={(id) => { if (id) onPickPerson(id); }}
        />
      </div>
      <div className="bulk-pick bulk-role">
        <label className="bulk-sub" htmlFor={roleId}>Role</label>
        <ComboBox
          portal
          inputId={roleId}
          ariaLabel={`Role for row ${n}`}
          options={roleOptions}
          value={decision.role ?? row.role_key}
          placeholder="Pick a role…"
          disabled={disabled}
          onChange={(key) => { if (key) onChange({ ...decision, role: key }); }}
        />
      </div>
    </>
  );
}
