/**
 * Developer → Database — reconcile view for the god-mode "pending delete"
 * registry (Task 1/2's mark/unmark flow, exposed everywhere via
 * GodDeleteButton). Lists every entity currently marked for hard-delete,
 * grouped by entity type, and offers the one action that actually deletes
 * anything: Reconcile.
 *
 * POST /devtools/pending-deletes/reconcile runs each marked target in its
 * own server-side savepoint (routes/devtools.py), so a handful of FK
 * violations don't block the rest of the batch — a failed row keeps its
 * marker for a later retry and comes back in the response's `failed` list.
 * Structure/styling follows pages/Variables.tsx, the other dev-page
 * exemplar.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  ApiError,
  listPendingDeletes,
  reconcilePendingDeletes,
  unmarkPendingDelete,
  type PendingDeleteItem,
  type PendingDeleteReconcileOut,
} from '../lib/api';
import { longDate, relativeTime } from '../lib/format';
import '../styles/directory.css';
import '../styles/profile.css'; /* .btn-solid */

// Server-side failure codes -> plain-English explanation. Anything not
// listed here still renders (falls back to the raw code) rather than
// disappearing, so a new failure mode is visible even before this map
// is taught about it.
const FAILURE_REASONS: Record<string, string> = {
  fk_violation: 'Still referenced by other records — remove those references first.',
};

function humanizeReason(reason: string): string {
  return FAILURE_REASONS[reason] ?? reason;
}

function typeLabel(entityType: string): string {
  return entityType.replace(/_/g, ' ');
}

const GRID = { gridTemplateColumns: '2fr 1fr 1.6fr 90px' };

export default function DevDatabase() {
  const [items, setItems] = useState<PendingDeleteItem[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [result, setResult] = useState<PendingDeleteReconcileOut | null>(null);

  const load = async () => {
    try {
      setItems(await listPendingDeletes());
      setError('');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view pending deletes.'
        : 'Failed to load pending deletes.');
    }
  };

  useEffect(() => { void load(); }, []);

  const groups = useMemo(() => {
    if (!items) return [];
    const byType = new Map<string, PendingDeleteItem[]>();
    for (const item of items) {
      const list = byType.get(item.entity_type) ?? [];
      list.push(item);
      byType.set(item.entity_type, list);
    }
    return [...byType.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [items]);

  const total = items?.length ?? 0;

  const handleUndo = async (item: PendingDeleteItem) => {
    setBusyId(item.id);
    try {
      await unmarkPendingDelete(item.id);
      setItems((cur) => (cur ?? []).filter((i) => i.id !== item.id));
    } catch {
      setError('Could not undo — try again.');
    } finally {
      setBusyId(null);
    }
  };

  const handleReconcile = async () => {
    if (total === 0) return;
    if (!confirm(
      `Permanently delete ${total} record${total === 1 ? '' : 's'}? This cannot be undone.`,
    )) {
      return;
    }
    setReconciling(true);
    setError('');
    setResult(null);
    try {
      const out = await reconcilePendingDeletes();
      setResult(out);
      await load(); // server clears every marker it resolved; reload to match
    } catch {
      setError('Reconcile failed — try again.');
    } finally {
      setReconciling(false);
    }
  };

  return (
    <div className="portal-page">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Developer</div>
          <h1 className="page-title">Database</h1>
          <p className="page-hint">
            Records marked for permanent deletion across the portal. Reconcile hard-deletes
            every marked record; anything still referenced elsewhere fails safely and stays
            listed here for a later retry.
          </p>
        </div>
      </div>

      <div className="dir-toolbar">
        <span className="result-count">{total} pending</span>
        <button
          type="button"
          className="btn-solid btn-danger"
          disabled={total === 0 || reconciling}
          onClick={() => void handleReconcile()}
        >
          {reconciling
            ? 'Reconciling…'
            : `Reconcile — permanently delete ${total} record${total === 1 ? '' : 's'}`}
        </button>
      </div>

      {error && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Cannot load pending deletes</b>{error}
        </div>
      )}

      {result && (
        <div className="dir-empty" style={{ marginBottom: 12 }}>
          <b>Reconcile complete</b>
          {result.deleted} deleted{result.failed.length > 0 && `, ${result.failed.length} failed`}.
          {result.failed.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, textAlign: 'left' }}>
              {result.failed.map((f) => (
                <li key={`${f.entity_type}:${f.entity_id}`}>
                  <b>{f.label}</b> — {humanizeReason(f.reason)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!error && items && total === 0 && (
        <div className="dir-empty"><b>Nothing pending delete.</b></div>
      )}

      {!error && groups.map(([entityType, rows]) => (
        <div key={entityType} className="dir-list" style={{ marginBottom: 20 }}>
          <div className="list-head" style={GRID}>
            <span>{typeLabel(entityType)} ({rows.length})</span>
            <span>Type</span>
            <span>Marked</span>
            <span />
          </div>
          {rows.map((item) => (
            <div key={item.id} className="dir-row">
              <div className="row-main" style={GRID}>
                <div className="cell"><span className="cell-top">{item.entity_label || '—'}</span></div>
                <div className="cell"><span className="chip tag">{typeLabel(item.entity_type)}</span></div>
                <div className="cell">
                  <span className="cell-top" title={longDate(item.marked_at)}>
                    {relativeTime(item.marked_at)}
                  </span>
                  <span className="cell-sub">{item.marked_by_name ?? 'Unknown'}</span>
                </div>
                <div className="cell">
                  <button
                    type="button"
                    className="mini-btn sm"
                    disabled={busyId === item.id}
                    onClick={() => void handleUndo(item)}
                  >
                    {busyId === item.id ? 'Undoing…' : 'Undo'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
