/** A yes/no confirmation in the portal's modal header pattern (eyebrow,
 *  title, one-line description), sized to its content. Escape and the
 *  scrim cancel, except while the action is running. */
import { useEffect, type ReactNode } from 'react';

interface Props {
  eyebrow: string;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  busyLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  eyebrow, title, description, confirmLabel, cancelLabel = 'Cancel', busyLabel = 'Working…', danger = false, busy = false,
  error, onConfirm, onCancel,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-dialog-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-confirm-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">{eyebrow}</div>
            <h3 id="wiki-confirm-title">{title}</h3>
            <p className="page-hint">{description}</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onCancel} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        {error && <div className="modal-body"><p className="pf-error">{error}</p></div>}
        <div className="modal-foot">
          <button type="button" className={`btn-solid${danger ? ' btn-danger' : ''}`} disabled={busy}
                  onClick={onConfirm} autoFocus>
            {busy ? busyLabel : confirmLabel}
          </button>
          <button type="button" className="mini-btn" onClick={onCancel} disabled={busy}>{cancelLabel}</button>
        </div>
      </div>
    </div>
  );
}
