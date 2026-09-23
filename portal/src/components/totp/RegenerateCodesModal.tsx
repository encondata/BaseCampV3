/**
 * RegenerateCodesModal — asks for a current authenticator code, then shows
 * the fresh backup codes once (the old ones stop working immediately).
 */
import { useState } from 'react';

import { ApiError, totpRegenerateBackupCodes } from '../../lib/api';
import BackupCodesPanel from './BackupCodesPanel';
import OtpInput from './OtpInput';
import '../../styles/reports.css';
import '../../styles/auth-theme.css';

const ERRORS: Record<string, string> = {
  totp_invalid: "That code didn't match. Try the next one.",
  account_locked: 'Too many attempts — your account is temporarily locked.',
};

export default function RegenerateCodesModal({ onClose, onRegenerated }: {
  onClose: () => void;
  onRegenerated: (count: number) => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const r = await totpRegenerateBackupCodes(value);
      setCodes(r.backup_codes);
    } catch (err) {
      setError(ERRORS[err instanceof ApiError ? err.code : ''] ?? 'Could not regenerate the codes.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !codes) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card totp-modal-card">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Security</div>
            <h3>Regenerate backup codes</h3>
            <p className="page-hint">{codes ? 'Your old codes no longer work.' : 'Confirm with a code from your authenticator app first.'}</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body inline-card totp-modal-body">
          {codes ? (
            <BackupCodesPanel codes={codes} ackLabel="Done" onAcknowledged={() => onRegenerated(codes.length)} />
          ) : (
            <>
              <OtpInput value={code} onChange={(v) => { setCode(v); setError(''); }}
                        onComplete={(v) => void submit(v)} disabled={busy} invalid={!!error}
                        autoFocus idPrefix="regen-otp" />
              <p className={`otp-error ${error ? 'show' : ''}`} role={error ? 'alert' : undefined}>{error}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
