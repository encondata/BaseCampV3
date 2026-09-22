/**
 * CopyAccessModal — copy one member's global roles, access groups and
 * overrides to one or many members. Preview (dry run) first, then Apply
 * sends the identical request for real. Replace is V2's behavior; Add
 * only unions.
 */
import { useState } from 'react';

import {
  ApiError, copyAccess,
  type CopyAccessOut, type CopyMode, type CopyPart, type CopyPlanRow, type MemberItem,
} from '../../lib/api';
import ComboBox from '../ComboBox';
import PersonChipPicker from './PersonChipPicker';

const PART_LABELS: Record<CopyPart, string> = {
  roles: 'Role', groups: 'Access groups', overrides: 'Overrides',
};
const MODE_HINT: Record<CopyMode, string> = {
  replace: 'Targets end up with exactly what the source has. Anything they had that the source lacks is removed.',
  add: 'Targets keep what they have and gain what the source has. Nothing is removed.',
};
const SKIP_REASONS: Record<NonNullable<CopyPlanRow['reason']>, string> = {
  cannot_target_self: "that's you",
  rank_too_low: 'their rank is at or above yours',
  no_account: 'they have no login account',
  role_rank_too_low: "the source holds a role you can't grant",
};
const ERRORS: Record<string, string> = {
  person_not_found: 'The source person no longer exists — refresh and try again.',
  global_only: 'Only staff with global access can copy access.',
  no_targets: 'Add at least one person to copy to.',
  no_parts: 'Pick at least one thing to copy.',
};

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? (ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was changed.';

const setList = (from: string[], to: string[]): string => {
  const added = to.filter((x) => !from.includes(x)).map((x) => `+${x}`);
  const removed = from.filter((x) => !to.includes(x)).map((x) => `−${x}`);
  return [...added, ...removed].join(', ');
};

export function planLine(row: CopyPlanRow, part: CopyPart): string {
  if (part === 'roles') {
    return row.roles ? `Role: ${row.roles.from.join(', ') || 'none'} → ${row.roles.to.join(', ') || 'none'}` : 'Role: no change';
  }
  if (part === 'groups') {
    return row.groups ? `Groups: ${setList(row.groups.from, row.groups.to)}` : 'Groups: no change';
  }
  if (!row.overrides) return 'Overrides: no change';
  const bits = [];
  if (row.overrides.added) bits.push(`${row.overrides.added} added`);
  if (row.overrides.removed) bits.push(`${row.overrides.removed} removed`);
  if (row.overrides.changed) bits.push(`${row.overrides.changed} changed`);
  return `Overrides: ${bits.join(', ')}`;
}

export default function CopyAccessModal({ members, sourceId, onClose, onApplied }: {
  members: MemberItem[];
  sourceId?: string | null;
  onClose: () => void;
  onApplied: (result: CopyAccessOut) => void;
}) {
  const [source, setSource] = useState(sourceId ?? '');
  const [targets, setTargets] = useState<string[]>([]);
  const [parts, setParts] = useState<Set<CopyPart>>(new Set(['roles', 'groups', 'overrides']));
  const [mode, setMode] = useState<CopyMode>('replace');
  const [plan, setPlan] = useState<CopyAccessOut | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const options = members.map((m) => ({
    value: m.person_id, label: m.display_name, sub: m.roles.join(', ') || 'no roles',
  }));
  const partList = (['roles', 'groups', 'overrides'] as CopyPart[]).filter((p) => parts.has(p));
  const ready = !!source && targets.length > 0 && partList.length > 0 && !busy;

  const reset = <T,>(setter: (v: T) => void) => (v: T) => { setter(v); setPlan(null); setError(''); };

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError('');
    try {
      const result = await copyAccess({
        source_id: source, target_ids: targets, parts: partList, mode, dry_run: dryRun,
      });
      if (dryRun) setPlan(result);
      else onApplied(result);
    } catch (e) {
      setError(msgFor(e));
    } finally {
      setBusy(false);
    }
  };

  const willChange = plan?.targets.filter((t) => t.status === 'ok'
    && (t.roles || t.groups || t.overrides)).length ?? 0;
  const skipped = plan?.targets.filter((t) => t.status === 'skipped').length ?? 0;

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card copy-access-card" role="dialog" aria-label="Copy access">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Access</div>
            <h3>Copy access</h3>
            <p className="page-hint">Use one person's setup as the starting point for others. Preview first; nothing changes until you apply.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <div className="full"><label>Source</label>
              <ComboBox options={options} value={source} placeholder="Copy from…" disabled={busy}
                        onChange={reset(setSource)} /></div>
            <div className="full"><label>Copy to</label>
              <PersonChipPicker options={options.filter((o) => o.value !== source)}
                                selected={targets} disabled={busy}
                                onChange={reset(setTargets)} placeholder="Add person…" /></div>
            <div><label>Copy</label>
              <div className="copy-parts">
                {(Object.keys(PART_LABELS) as CopyPart[]).map((p) => (
                  <label key={p} className="init-check">
                    <input type="checkbox" checked={parts.has(p)} disabled={busy}
                           onChange={() => reset(setParts)(new Set(
                             parts.has(p) ? [...parts].filter((x) => x !== p) : [...parts, p]))} />
                    {PART_LABELS[p]}
                  </label>
                ))}
              </div></div>
            <div><label>Mode</label>
              <div className="segmented" role="group" aria-label="Copy mode">
                <button type="button" className={mode === 'replace' ? 'on' : ''} disabled={busy}
                        aria-pressed={mode === 'replace'} onClick={() => reset(setMode)('replace')}>Replace</button>
                <button type="button" className={mode === 'add' ? 'on' : ''} disabled={busy}
                        aria-pressed={mode === 'add'} onClick={() => reset(setMode)('add')}>Add only</button>
              </div>
              <p className="set-note">{MODE_HINT[mode]}</p></div>
          </div>

          {plan && (
            <div className="copy-plan">
              {plan.targets.map((t) => (
                <div key={t.person_id} className={`copy-plan-row ${t.status}`}>
                  <b>{t.display_name}</b>
                  {t.status === 'skipped' ? (
                    <span className="copy-skip">Skipped — {SKIP_REASONS[t.reason ?? 'rank_too_low']}</span>
                  ) : (
                    <ul>{partList.map((p) => <li key={p}>{planLine(t, p)}</li>)}</ul>
                  )}
                </div>
              ))}
              <p className="set-note">{willChange} will change, {skipped} skipped</p>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-solid" disabled={!plan || willChange === 0 || busy}
                  onClick={() => void run(false)}>
            {busy && plan ? 'Applying…' : 'Apply'}
          </button>
          <button className="mini-btn accent" disabled={!ready} onClick={() => void run(true)}>
            {busy && !plan ? 'Previewing…' : 'Preview'}
          </button>
          <button className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
