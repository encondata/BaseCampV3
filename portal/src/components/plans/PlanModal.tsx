/**
 * Every Project plan dialog's shell: the house modal-scrim/modal-card with
 * the report-generate header (eyebrow "Project plan", h3 title, one-line
 * description), sized to its content between the `size` bounds, rounded
 * like every modal card. Dropdowns inside it portal out of the card on
 * their own (ComboBox/TagInput via useMenuPlacement). Closing is blocked
 * while `busy` (a write is in flight). Modeled on LearningModal.
 */

import { useEffect, type ReactNode } from 'react';

import '../../styles/reports.css';   // .rgm-* — the roomy modal header
import '../../styles/plans.css';

export type PlanModalSize = 'normal' | 'wide' | 'xwide';

export default function PlanModal({
  eyebrow = 'Project plan', title, description, label, onClose, busy = false, size = 'normal',
  className = '', children, footer,
}: {
  eyebrow?: string;
  title: string;
  /** One line under the title. */
  description?: ReactNode;
  /** The dialog's accessible name; defaults to the title. */
  label?: string;
  onClose: () => void;
  busy?: boolean;
  /** The widest the card grows: normal 720px, wide 980px, xwide 1200px (all within 96vw). */
  size?: PlanModalSize;
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const sizeClass = size === 'normal' ? '' : ` pln-modal-${size}`;
  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !busy) onClose();
    }}>
      <div className={`modal-card reports-modal-card rgm-card pln-modal${sizeClass}${className ? ` ${className}` : ''}`}
           role="dialog" aria-modal="true" aria-label={label ?? title}>
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
