/**
 * TimeBulkDialog — the Timesheet's two bulk confirmations, in the report
 * Generate modal's header pattern (eyebrow, title, one-line description).
 * "Reject selected" asks for the one reason every selected entry gets;
 * "Approve all pending in this view" confirms the dry-run count before the
 * filter is sent. The page owns the API calls; this is only the form.
 */
import { useState, type FormEvent } from 'react';

import { approveAllQuestion, entriesText } from '../../lib/timeBulk';
import '../../styles/reports.css';

interface Props {
  mode: 'reject' | 'approve-all';
  count: number;
  busy: boolean;
  error: string;
  onCancel(): void;
  onConfirm(reason: string): void;
}

export default function TimeBulkDialog({ mode, count, busy, error, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState('');
  const rejecting = mode === 'reject';
  const action = rejecting ? `Reject ${entriesText(count)}` : `Approve ${entriesText(count)}`;
  const blocked = busy || (rejecting && !reason.trim());

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!blocked) onConfirm(reason.trim());
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="modal-card reports-modal-card rgm-card time-bulk-card" role="dialog"
           aria-modal="true" aria-labelledby="time-bulk-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Timesheet</div>
            <h3 id="time-bulk-title">{rejecting ? action : 'Approve pending entries'}</h3>
            <p className="page-hint">
              {rejecting ? 'One reason is saved on every selected entry.' : approveAllQuestion(count)}
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onCancel} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            {rejecting ? (
              <div className="pf-form">
                <div className="full">
                  <label htmlFor="time-bulk-reason">Rejection reason *</label>
                  <input id="time-bulk-reason" value={reason} disabled={busy} autoFocus
                         onChange={(e) => setReason(e.target.value)} />
                </div>
              </div>
            ) : (
              <p className="set-note">
                The count leaves out your own entries, which you cannot approve. Anything approved
                or rejected in the meantime is skipped.
              </p>
            )}
            {error && <p className="pf-error">{error}</p>}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={blocked}>
              {busy ? 'Working…' : action}
            </button>
            <button className="mini-btn" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
