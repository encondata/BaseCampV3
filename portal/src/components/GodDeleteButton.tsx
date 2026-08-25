/**
 * Row-level god-mode control for marking/unmarking a directory row in the
 * Task 1 pending-deletes registry. Pure UI: the actual mark()/unmark() API
 * calls (and the entityId -> markerId bookkeeping the unmark side needs)
 * live in usePendingDeletes — this component just renders the right state
 * and asks its caller (via `onChange`) to run one of the two.
 */

import { useState } from 'react';
import { ApiError } from '../lib/api';

export default function GodDeleteButton({
  entityType, entityId, label, pending, onChange, visible,
}: {
  entityType: string;
  entityId: string;
  label: string;
  pending: boolean;
  onChange: () => Promise<void>;
  visible: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!visible) return null;

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await onChange();
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'already_pending'
        ? 'Already pending delete.' : 'Could not update.');
    } finally {
      setBusy(false);
    }
  };

  if (pending) {
    return (
      <span className="god-delete" data-entity-id={entityId} data-entity-type={entityType}>
        <span className="chip tag">Pending delete</span>
        <button type="button" className="mini-btn sm" disabled={busy} onClick={() => void run()}>
          {busy ? 'Undoing…' : 'Undo'}
        </button>
        {error && <span className="pf-error">{error}</span>}
      </span>
    );
  }

  return (
    <span className="god-delete" data-entity-id={entityId} data-entity-type={entityType}>
      <button type="button" className="mini-btn sm danger" disabled={busy}
              onClick={() => {
                if (!confirm(`Mark "${label}" for deletion?`)) return;
                void run();
              }}>
        {busy ? 'Marking…' : 'Delete'}
      </button>
      {error && <span className="pf-error">{error}</span>}
    </span>
  );
}
