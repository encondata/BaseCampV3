/**
 * Print code sheet: a PDF of fresh sign-in codes for people who can't be
 * emailed — by default just the people without an email, or everyone with
 * open training. Every code printed replaces that person's earlier one, so
 * this says so before it downloads. Needs learning:change.
 */

import { useState } from 'react';

import { downloadCodeSheet } from '../../lib/learning';
import { tabErrorText } from './initiativeLearning';
import LearningModal from './LearningModal';

export default function CodeSheetModal({ initiativeId, onClose, onDownloaded }: {
  initiativeId: string;
  onClose: () => void;
  onDownloaded: (everyone: boolean) => void;
}) {
  const [everyone, setEveryone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const download = async () => {
    setBusy(true);
    setError('');
    try {
      await downloadCodeSheet(initiativeId, everyone);
      onDownloaded(everyone);
    } catch (e) {
      setError(tabErrorText(e));
      setBusy(false);
    }
  };

  return (
    <LearningModal eyebrow="Learning" title="Print code sheet"
                   description="One page of sign-in codes and links to hand out on paper."
                   onClose={onClose} busy={busy}
                   footer={(
                     <>
                       <button type="button" className="btn-solid" onClick={() => void download()} disabled={busy}>
                         {busy ? 'Preparing…' : 'Download PDF'}
                       </button>
                       <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Cancel</button>
                       {error && <span className="pf-error" role="alert">{error}</span>}
                     </>
                   )}>
      <div className="lrn-set">
        <span className="lrn-lbl">Who gets a code</span>
        <div className="segmented" role="group" aria-label="Who gets a code">
          <button type="button" aria-pressed={!everyone} className={!everyone ? 'on' : ''}
                  disabled={busy} onClick={() => setEveryone(false)}>People without email</button>
          <button type="button" aria-pressed={everyone} className={everyone ? 'on' : ''}
                  disabled={busy} onClick={() => setEveryone(true)}>Everyone with open training</button>
        </div>
        <p className="lrn-hint">
          {everyone
            ? 'Everyone who still has training to do gets a printed code.'
            : 'Only people with no email on file get a printed code.'}
        </p>
        <p className="lrn-note-mute">
          Each code on the sheet replaces that person’s earlier one, so a code
          already emailed to them stops working.
        </p>
      </div>
    </LearningModal>
  );
}
