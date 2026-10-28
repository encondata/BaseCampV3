/**
 * Every Project plan dialog's shell: the house modal-scrim/modal-card with
 * the report-generate header (eyebrow "Project plan", h3 title, one-line
 * description), sized to its content between the `size` bounds, rounded
 * like every modal card. Dropdowns inside it portal out of the card on
 * their own (ComboBox/TagInput via useMenuPlacement). Modeled on
 * LearningModal.
 *
 * Focus moves in on open — to the body's first field that can be seen
 * (a tabbed dialog's hidden panels are passed over, and so is a ComboBox:
 * focus opens its list), else the dialog itself — and goes back to what
 * had it when the dialog closes (when that can't take it, to the dialog
 * still open under this one). Escape closes it unless a control inside
 * already handled that Escape (a ComboBox closing its list marks it
 * `defaultPrevented`) or another dialog sits on top of it (the completion
 * check over Task Information: the top one takes the key); neither Escape
 * nor the scrim closes it while `busy` (a write is in flight).
 */

import { useEffect, useRef, type ReactNode } from 'react';

import '../../styles/reports.css';   // .rgm-* — the roomy modal header
import '../../styles/plans.css';

export type PlanModalSize = 'normal' | 'wide' | 'xwide';

/** The body's first field that takes focus. Not a ComboBox: focusing one
 *  opens its list, which would cover the dialog the moment it opens. */
const FIRST_FIELD = '.modal-body :is(input:not([type="hidden"]), select, textarea):not(:disabled):not([role="combobox"]), '
  + '.modal-body [contenteditable]:not([contenteditable="false"])';
/** Where a field can't be seen: a tab panel not shown. */
const UNSEEN = '[hidden], [inert], [aria-hidden="true"]';

/** True when `scrim` is the last dialog open: the one on top. */
function onTop(scrim: HTMLElement | null): boolean {
  const scrims = document.querySelectorAll('.modal-scrim');
  return scrim !== null && scrims[scrims.length - 1] === scrim;
}

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
  /** The body; a one-question dialog (its title and description say it all) has none. */
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy && onTop(scrimRef.current)) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // focus in on open, back out on close
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const card = cardRef.current;
    const field = [...(card?.querySelectorAll<HTMLElement>(FIRST_FIELD) ?? [])].find((el) => !el.closest(UNSEEN));
    (field ?? card)?.focus();
    return () => {
      if (opener?.isConnected && opener !== document.body && !opener.matches(':disabled')) {
        opener.focus();
        return;
      }
      // nothing to go back to (the page had focus: a busy OK under a check
      // over Task Information gave it up): the dialog still open under this one
      const cards = document.querySelectorAll<HTMLElement>('.modal-scrim > .modal-card');
      cards[cards.length - 1]?.focus();
    };
  }, []);

  const sizeClass = size === 'normal' ? '' : ` pln-modal-${size}`;
  return (
    <div className="modal-scrim" ref={scrimRef} onMouseDown={(e) => {
      if (e.target === e.currentTarget && !busy) onClose();
    }}>
      <div className={`modal-card reports-modal-card rgm-card pln-modal${sizeClass}${className ? ` ${className}` : ''}`}
           role="dialog" aria-modal="true" aria-label={label ?? title} tabIndex={-1} ref={cardRef}>
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
        {children !== undefined && children !== null && children !== false && (
          <div className="modal-body">{children}</div>
        )}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}
