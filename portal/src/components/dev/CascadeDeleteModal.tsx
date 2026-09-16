/**
 * CascadeDeleteModal — the override behind Reconcile's "Cannot force" dead
 * end. It shows every row that will be destroyed before it will destroy
 * any of them, and the destroy button stays inert until the operator types
 * the record's own name back.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';

import DataTable from '../DataTable';
import {
  ApiError, cascadeDelete, getCascadePreview,
  type CascadePlan, type CascadeStep, type PendingDeleteReconcileOut,
} from '../../lib/api';

const ACTION_LABEL: Record<CascadeStep['action'], string> = {
  purge: 'Deleted',
  clear: 'Reference cleared',
  db_cascade: 'Handled by the database',
  db_set_null: 'Handled by the database',
};

const ERRORS: Record<string, string> = {
  label_mismatch: 'That name did not match this record — nothing was deleted.',
  label_unavailable: 'This record has no name to confirm against, so it cannot be deleted here.',
  cascade_blocked: 'The plan changed and now includes something that cannot be deleted. Review it and try again.',
  marker_not_found: 'This record is no longer pending deletion.',
};

export default function CascadeDeleteModal({ markerId, label, onClose, onDeleted }: {
  markerId: string;
  label: string;
  onClose: () => void;
  onDeleted: (result: PendingDeleteReconcileOut) => void;
}) {
  const [plan, setPlan] = useState<CascadePlan | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      setPlan(await getCascadePreview(markerId));
    } catch {
      setLoadError(true);
    }
  }, [markerId]);

  useEffect(() => { void load(); }, [load]);

  const blocked = (plan?.blocked.length ?? 0) > 0;
  const confirmed = typed.trim() === label.trim() && label.trim() !== '';
  const tables = new Set(plan?.steps.filter((s) => s.action === 'purge')
    .map((s) => s.table)).size;

  const destroy = async () => {
    setBusy(true);
    setError('');
    try {
      onDeleted(await cascadeDelete(markerId, typed.trim()));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : '';
      setError(ERRORS[code] ?? 'Could not delete — try again.');
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !busy) onClose();
    }}>
      <div className="modal-card reports-modal-card rgm-card dev-cascade-card"
           role="dialog" aria-label="Cascade delete">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Database</div>
            <h3>Delete {label} and everything attached</h3>
            <p className="page-hint">
              This cannot be undone. Every row listed below is destroyed permanently.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close"
                  onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>

        <div className="modal-body">
          {loadError && (
            <div className="dir-empty">
              <b>Could not build the delete plan.</b>
              <button type="button" className="mini-btn" style={{ marginTop: 8 }}
                      onClick={() => void load()}>Retry</button>
            </div>
          )}

          {!loadError && plan === null && (
            <p className="set-note" style={{ padding: 0 }}>Building the plan…</p>
          )}

          {plan !== null && (
            <>
              <div className="dev-cascade-summary">
                <span className="chip c-red">
                  <span className="dot" />
                  {plan.total_rows_deleted} row{plan.total_rows_deleted === 1 ? '' : 's'}
                  {' '}in {tables} table{tables === 1 ? '' : 's'} will be permanently deleted
                </span>
                {plan.total_rows_cleared > 0 && (
                  <span className="chip tag">
                    {plan.total_rows_cleared} reference
                    {plan.total_rows_cleared === 1 ? '' : 's'} will be cleared
                  </span>
                )}
              </div>

              {blocked && (
                <div className="dir-empty" style={{ marginBottom: 12 }}>
                  <b>This record cannot be deleted yet</b>
                  <ul className="dev-cascade-blocked">
                    {plan.blocked.map((reason) => <li key={reason}>{reason}</li>)}
                  </ul>
                </div>
              )}

              <DataTable ariaLabel="Cascade delete plan" emptyText="Nothing else references this record"
                columns={[
                  { key: 'table', label: 'Table' },
                  { key: 'action', label: 'What happens' },
                  { key: 'count', label: 'Rows', align: 'right' },
                  { key: 'examples', label: 'Examples' },
                ]}
                rows={plan.steps.map((s) => ({
                  key: `${s.table}.${s.column}`,
                  cells: [
                    <Fragment key="table"><span className="mono">{s.table}</span></Fragment>,
                    <Fragment key="action">{ACTION_LABEL[s.action]}</Fragment>,
                    <Fragment key="count">{String(s.count)}</Fragment>,
                    <Fragment key="examples">{s.labels.length > 0 ? s.labels.join(', ') : '—'}</Fragment>,
                  ],
                }))} />

              <div className="pf-form dev-cascade-confirm">
                <div className="full">
                  <label htmlFor="cascade-confirm">Type {label} to confirm</label>
                  <input id="cascade-confirm" value={typed} autoComplete="off"
                         disabled={busy || blocked}
                         onChange={(e) => setTyped(e.target.value)} />
                </div>
              </div>
            </>
          )}
        </div>

        <div className="modal-foot">
          <button type="button" className="btn-solid btn-danger"
                  disabled={busy || blocked || !confirmed || plan === null}
                  onClick={() => void destroy()}>
            {busy ? 'Deleting…' : 'Delete permanently'}
          </button>
          <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </div>
    </div>
  );
}
