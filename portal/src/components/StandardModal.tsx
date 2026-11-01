/**
 * StandardModal — the house dialog shell under LearningModal and
 * NotificationModal: the modal-scrim/modal-card with the report-generate
 * header (eyebrow, title, description), a body, and an optional footer.
 *
 * Closing — the ×, the scrim, Escape — is blocked while `busy` (a save is in
 * flight). An Escape that something inside the dialog already took (a ComboBox
 * list marks its keydown handled) closes only that, not the dialog.
 *
 * The card is `modal-card reports-modal-card rgm-card` plus the caller's
 * `cardClass`, which is how a wrapper sets its size and look; each wrapper
 * imports its own stylesheet. The wrappers keep their own public props.
 */

import { useEffect, type ReactNode } from 'react';

import '../styles/reports.css';   // .rgm-* — the roomy modal header

export default function StandardModal({
  eyebrow, title, description, label, onClose, busy = false, cardClass = '', children, footer,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  /** The dialog's accessible name; defaults to the title. */
  label?: string;
  onClose: () => void;
  busy?: boolean;
  /** Extra class(es) for the card, after the house ones. */
  cardClass?: string;
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
      <div className={`modal-card reports-modal-card rgm-card${cardClass ? ` ${cardClass}` : ''}`}
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
