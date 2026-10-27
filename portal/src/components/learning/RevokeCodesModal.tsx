/**
 * Revoke a person's codes on one initiative: their emailed link and sign-in
 * code stop working until you resend or regenerate. Asks first. Needs
 * learning:change.
 */

import { useState } from 'react';

import { revokeLearningCodes } from '../../lib/learning';
import { tabErrorText } from './initiativeLearning';
import LearningModal from './LearningModal';

export default function RevokeCodesModal({ initiativeId, personId, name, onClose, onRevoked }: {
  initiativeId: string;
  personId: string;
  name: string;
  onClose: () => void;
  onRevoked: (revoked: number) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const revoke = async () => {
    setBusy(true);
    setError('');
    try {
      const { revoked } = await revokeLearningCodes(initiativeId, personId);
      onRevoked(revoked);
    } catch (e) {
      setError(tabErrorText(e));
      setBusy(false);
    }
  };

  return (
    <LearningModal eyebrow="Learning" title="Revoke codes"
                   description={`${name} can no longer sign in to this initiative’s training with the codes they were given. Send a new invite to let them back in.`}
                   onClose={onClose} busy={busy}
                   footer={(
                     <>
                       <button type="button" className="btn-solid btn-danger" onClick={() => void revoke()} disabled={busy}>
                         {busy ? 'Revoking…' : 'Revoke codes'}
                       </button>
                       <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
                       {error && <span className="pf-error" role="alert">{error}</span>}
                     </>
                   )}>
      <p className="page-hint">Work they already finished stays signed.</p>
    </LearningModal>
  );
}
