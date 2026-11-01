/**
 * The Learning dialogs' shell: StandardModal (the house modal-scrim/modal-card
 * with the report-generate header — eyebrow, title, description) at Learning's
 * card size (`lrn-modal`, and `lrn-modal-wide` for the roomy ones). Closing is
 * blocked while `busy` (a save is in flight).
 */

import type { ReactNode } from 'react';

import StandardModal from '../StandardModal';
import '../../styles/learning.css';

export default function LearningModal({
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
  return (
    <StandardModal eyebrow={eyebrow} title={title} description={description} label={label}
                   onClose={onClose} busy={busy} footer={footer}
                   cardClass={`lrn-modal${wide ? ' lrn-modal-wide' : ''}${className ? ` ${className}` : ''}`}>
      {children}
    </StandardModal>
  );
}
