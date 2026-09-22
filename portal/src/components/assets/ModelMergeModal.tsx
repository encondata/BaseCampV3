/**
 * ModelMergeModal — fold one catalog model (the duplicate) into another.
 * Picking the target runs a dry run; the side-by-side table shows what the
 * target keeps, what the duplicate has, and the result. Merge sends the
 * identical request for real. Conflicts (an alias a third model owns)
 * block the merge until they are fixed on that model.
 */
import { useEffect, useState } from 'react';

import {
  ApiError, mergeAssetModel, type AssetModelItem, type MergePlanOut,
} from '../../lib/api';
import { MODEL_ERRORS, mergeFieldRows } from '../../lib/assets';
import ComboBox from '../ComboBox';
import DataTable, { type DataTableColumn, type DataTableRow } from '../DataTable';

const msgFor = (err: unknown): string =>
  err instanceof ApiError ? (MODEL_ERRORS[err.code] ?? `Request failed (${err.code}).`)
    : 'Network error — nothing was changed.';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export default function ModelMergeModal({ source, models, presetTargetId, onClose, onMerged }: {
  source: AssetModelItem;
  models: AssetModelItem[];
  presetTargetId?: string | null;
  onClose: () => void;
  onMerged: (plan: MergePlanOut) => void;
}) {
  const [targetId, setTargetId] = useState(presetTargetId ?? '');
  const [plan, setPlan] = useState<MergePlanOut | null>(null);
  const [busy, setBusy] = useState<'plan' | 'merge' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setPlan(null);
    setError('');
    if (!targetId) return;
    let live = true;
    setBusy('plan');
    mergeAssetModel(targetId, source.id, true)
      .then((p) => { if (live) setPlan(p); })
      .catch((e) => { if (live) setError(msgFor(e)); })
      .finally(() => { if (live) setBusy(null); });
    return () => { live = false; };
  }, [targetId, source.id]);

  const merge = async () => {
    if (!plan) return;
    setBusy('merge');
    setError('');
    try {
      onMerged(await mergeAssetModel(targetId, source.id, false));
    } catch (e) {
      setError(msgFor(e));
      setBusy(null);
    }
  };

  const options = models.filter((m) => m.id !== source.id)
    .map((m) => ({ value: m.id, label: `${m.make} ${m.model}`, sub: m.category_label }));
  const rows = plan ? mergeFieldRows(plan.target, plan.source, plan.fills) : [];
  const columns: DataTableColumn[] = plan ? [
    { key: 'field', label: 'Field' },
    { key: 'keep', label: `Keep · ${plan.target.make} ${plan.target.model}` },
    { key: 'dup', label: `${plan.source.make} ${plan.source.model}` },
    { key: 'result', label: 'Result' },
  ] : [];
  const tableRows: DataTableRow[] = plan ? [
    ...rows.map((r): DataTableRow => ({
      key: r.key, className: r.result !== r.keep ? 'filled' : '',
      cells: [r.label, r.keep, r.dup, r.result],
    })),
    { key: 'notes', cells: ['Notes', plan.target.knowledge || '—', plan.source.knowledge || '—', 'appended'] },
  ] : [];

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card model-merge-card" role="dialog" aria-label="Merge into another model">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Catalog</div>
            <h3>Merge into another model</h3>
            <p className="page-hint">Assets, stock lines and aliases move to the model you pick. The duplicate is deleted and its name becomes an alias.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={!!busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <div className="full"><label>Duplicate</label>
              <div className="mm-source"><b>{source.make} {source.model}</b>
                {plan && <span> · {plural(plan.source.asset_count, 'asset', 'assets')}</span>}</div></div>
            <div className="full"><label>Merge into</label>
              <ComboBox options={options} value={targetId} placeholder="Type to search models…"
                        disabled={busy === 'merge'} onChange={setTargetId} /></div>
          </div>

          {busy === 'plan' && <p className="set-note">Working out what would move…</p>}
          {plan && (
            <div className="mm-plan">
              <DataTable columns={columns} rows={tableRows} className="mm-table"
                         ariaLabel="Merge field comparison" />
              <p className="set-note">
                {plural(plan.moves.assets, 'asset', 'assets')} and {plural(plan.moves.stock_lines, 'stock line', 'stock lines')} move;
                {' '}{plan.moves.aliases} aliases move; alias added: {plan.alias_added ?? 'none'}
              </p>
              <div className="chips">
                {plan.aliases_after.length
                  ? plan.aliases_after.map((a) => <span key={a} className="chip tag">{a}</span>)
                  : <span className="chip tag">no aliases</span>}
              </div>
              {plan.conflicts.length > 0 && (
                <ul className="mm-conflicts">
                  {plan.conflicts.map((c) => (
                    <li key={c.alias}>‘{c.alias}’ already belongs to {c.make} {c.model} — remove it there first.</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn-solid" disabled={!plan || !plan.can_merge || !!busy} onClick={() => void merge()}>
            {busy === 'merge' ? 'Merging…' : 'Merge'}
          </button>
          <button className="mini-btn" onClick={onClose} disabled={!!busy}>Cancel</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
