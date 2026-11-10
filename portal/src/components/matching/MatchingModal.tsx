/** The dialog shell every Matching rules modal shares: the report-generate
 *  header (eyebrow "Matching rules", title, one-line description), a body
 *  and a footer. The head and foot are the card's first and last children,
 *  so chrome.css rounds their corners (styles/modalCorners.test.ts). */

import { useEffect, useId, type ReactNode } from 'react';

import '../../styles/reports.css'; /* .reports-modal-card, .rgm-card, .rgm-head-text */
import '../../styles/profile.css'; /* .btn-solid, .pf-form, .pf-error */
import '../../styles/directory.css'; /* .btn-danger, .mini-btn */
import '../../styles/matching-rules.css';

export default function MatchingModal({
  title, hint, cardClass, busy, onClose, children, footer,
}: {
  title: string;
  hint: ReactNode;
  cardClass: string;
  busy: boolean;
  onClose: () => void;
  children?: ReactNode;
  footer: ReactNode;
}) {
  const titleId = useId();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && !busy) onClose();
    }}>
      <div className={`modal-card reports-modal-card rgm-card ${cardClass}`} role="dialog"
           aria-modal="true" aria-labelledby={titleId}>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Matching rules</div>
            <h3 id={titleId}>{title}</h3>
            <p className="page-hint">{hint}</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        {children && <div className="modal-body">{children}</div>}
        <div className="modal-foot">{footer}</div>
      </div>
    </div>
  );
}
