/** WizardFooter — Back, Skip this step (only when the step can be skipped),
 *  an optional hint, the error line, and the primary Next on the right. */
import type { ReactNode } from 'react';

import '../../styles/wizard.css';

interface Props {
  onBack?: () => void;
  onSkip?: () => void;
  onNext: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  busy?: boolean;
  error?: string;
  note?: ReactNode;
}

export default function WizardFooter({
  onBack, onSkip, onNext, nextLabel = 'Next', nextDisabled = false, busy = false, error, note,
}: Props) {
  return (
    <div className="wiz-foot">
      {onBack && <button className="mini-btn" type="button" disabled={busy} onClick={onBack}>Back</button>}
      {onSkip && <button className="mini-btn" type="button" disabled={busy} onClick={onSkip}>Skip this step</button>}
      {note && <span className="page-hint">{note}</span>}
      {error && <span className="pf-error">{error}</span>}
      <button className="btn-solid wiz-next" type="button" disabled={busy || nextDisabled}
              onClick={onNext}>
        {nextLabel}
      </button>
    </div>
  );
}
