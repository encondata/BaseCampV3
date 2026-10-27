/**
 * Confirm before issuing new sign-in codes (Regenerate code, Resend to
 * selected): each person gets a new emailed code and link, and the old
 * ones stop working, so anyone partway through their training is signed
 * out. `run` does the call and throws on failure (shown here, dialog stays
 * open). Needs learning:change.
 */

import { useState } from 'react';

import { tabErrorText } from './initiativeLearning';
import LearningModal from './LearningModal';

export default function ConfirmNewCodesModal({ title, description, note, confirmLabel, run, onClose }: {
  title: string;
  description: string;
  note: string;
  confirmLabel: string;
  run: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      await run();
    } catch (e) {
      setError(tabErrorText(e));
      setBusy(false);
    }
  };

  return (
    <LearningModal eyebrow="Learning" title={title} description={description}
                   onClose={onClose} busy={busy}
                   footer={(
                     <>
                       <button type="button" className="btn-solid" onClick={() => void confirm()} disabled={busy}>
                         {busy ? 'Working…' : confirmLabel}
                       </button>
                       <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
                       {error && <span className="pf-error" role="alert">{error}</span>}
                     </>
                   )}>
      <p className="page-hint">{note}</p>
    </LearningModal>
  );
}
