/**
 * The notification dialogs' shell: the house modal-scrim/modal-card with the
 * report-generate header (eyebrow, title, description). Closing — the ×, the
 * scrim, Escape — is blocked while `busy` (a save is in flight). An Escape
 * that a ComboBox list inside the dialog already took (it marks the keydown
 * handled) closes only the list, not the dialog.
 */

import { useEffect, type ReactNode } from 'react';

import '../../styles/reports.css';         // .rgm-* — the roomy modal header
import '../../styles/notifications.css';   // .nm-* — the card's size and the hint under a control

export default function NotificationModal({
  eyebrow, title, description, label, onClose, busy = false, wide = false, className = '',
  children, footer,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  /** The dialog's accessible name; defaults to the title. */
  label?: string;
  onClose: () => void;
  busy?: boolean;
  wide?: boolean;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !busy) onClose();
    }}>
      <div className={`modal-card reports-modal-card rgm-card nm-card${wide ? ' nm-card-wide' : ''}${className ? ` ${className}` : ''}`}
           role="dialog" aria-label={label ?? title}>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">{eyebrow}</div>
            <h3>{title}</h3>
            {description && <p className="page-hint">{description}</p>}
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
