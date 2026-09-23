/**
 * TotpEnrollModal — self-service enrollment from My Profile. Report-generate
 * header pattern (eyebrow / title / description + numbered steps), sized
 * to its content. The flow itself is EnrollFlow, shared with the login page.
 */
import { useState } from 'react';

import { totpEnrollConfirm, totpEnrollStart } from '../../lib/api';
import EnrollFlow from './EnrollFlow';
import '../../styles/reports.css';
import '../../styles/auth-theme.css';

export default function TotpEnrollModal({ email, onClose, onEnrolled }: {
  email: string;
  onClose: () => void;
  onEnrolled: (backupCodesRemaining: number) => void;
}) {
  const [count, setCount] = useState(0);
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card totp-modal-card">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Security</div>
            <h3>Set up two-factor authentication</h3>
            <p className="page-hint">Scan the code with an authenticator app, confirm a code, then save your backup codes.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body inline-card totp-modal-body">
          <EnrollFlow
            email={email}
            start={() => totpEnrollStart()}
            confirm={async (code) => {
              const r = await totpEnrollConfirm(code, {});
              setCount(r.backup_codes.length);
              return r;
            }}
            onDone={() => onEnrolled(count)}
            ackLabel="Done"
          />
        </div>
      </div>
    </div>
  );
}
