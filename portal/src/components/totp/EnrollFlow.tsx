/**
 * EnrollFlow — Scan → Confirm → Save codes. `start` and `confirm` are
 * injected so the login page (challenge token) and the My Profile modal
 * (signed-in session) share one flow.
 */
import { useEffect, useState } from 'react';

import { ApiError } from '../../lib/api';
import { qrDataUrl } from '../../lib/qr';
import BackupCodesPanel from './BackupCodesPanel';
import OtpInput from './OtpInput';

type Step = 'scan' | 'codes';

const CONFIRM_ERRORS: Record<string, string> = {
  totp_invalid: "That code didn't match. Wait for a new code in the app and try again.",
  account_locked: 'Too many attempts — this account is temporarily locked. Try again in about 15 minutes.',
  invalid_challenge: 'This sign-in expired. Go back and sign in again.',
};

// `err instanceof ApiError` covers the real client; a duck-typed `.code`
// fallback covers callers (and tests) that throw an error-shaped object
// without going through the ApiError class.
function errorCode(err: unknown): string {
  if (err instanceof ApiError) return err.code;
  if (err && typeof err === 'object' && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return 'network';
}

export function groupSecret(secret: string): string {
  return secret.replace(/(.{4})/g, '$1 ').trim();
}

export default function EnrollFlow({ email, start, confirm, remember = null, onDone, onError, ackLabel }: {
  email: string;
  start: () => Promise<{ secret: string; otpauth_uri: string }>;
  confirm: (code: string) => Promise<{ backup_codes: string[] }>;
  remember?: { checked: boolean; onChange: (v: boolean) => void; days: number } | null;
  onDone: () => void;
  onError?: (code: string) => void;
  ackLabel?: string;
}) {
  const [step, setStep] = useState<Step>('scan');
  const [secret, setSecret] = useState('');
  const [qr, setQr] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [codes, setCodes] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    start().then((r) => {
      if (cancelled) return;
      setSecret(r.secret);
      setQr(qrDataUrl(r.otpauth_uri));
    }).catch((err) => {
      const c = errorCode(err);
      setError(CONFIRM_ERRORS[c] ?? 'Could not start enrollment. Try again.');
      onError?.(c);
    });
    return () => { cancelled = true; };
  // start is stable for the life of the flow
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (value: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const r = await confirm(value);
      setCodes(r.backup_codes);
      setStep('codes');
    } catch (err) {
      const c = errorCode(err);
      setError(CONFIRM_ERRORS[c] ?? 'Something went wrong. Try again.');
      setCode('');
      onError?.(c);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="steps" aria-hidden="true">
        <span className={`step ${step === 'scan' ? 'active' : 'done'}`}>1 · Scan</span>
        <span className={`step ${step === 'scan' ? 'active' : 'done'}`}>2 · Confirm</span>
        <span className={`step ${step === 'codes' ? 'active' : ''}`}>3 · Save codes</span>
      </div>

      {step === 'scan' && (
        <>
          <p className="otp-text">Open your authenticator app (Google Authenticator, Apple Passwords, 1Password…) and scan this code for <b>{email}</b>.</p>
          <div className="qr-frame">
            {qr ? <img src={qr} alt="Scan this QR code with your authenticator app" width={180} height={180} /> : <div className="card-spinner" />}
          </div>
          {secret && (
            <>
              <p className="otp-info">Can't scan? Enter this key by hand:</p>
              <div className="secret-box">{groupSecret(secret)}</div>
            </>
          )}
          <p className="otp-info">Then enter the 6-digit code the app shows.</p>
          <OtpInput value={code} onChange={setCode} onComplete={(v) => void submit(v)}
                    disabled={busy || !secret} invalid={!!error} idPrefix="enroll-otp" />
          <p className={`otp-error ${error ? 'show' : ''}`} role={error ? 'alert' : undefined}>{error}</p>
          {remember && (
            <div className="otp-row">
              <label className="remember">
                <input type="checkbox" checked={remember.checked} onChange={(e) => remember.onChange(e.target.checked)} />
                <span className="box">
                  <svg viewBox="0 0 12 12" fill="none" stroke="#0c1117" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
                </span>
                Remember this browser for {remember.days} days
              </label>
            </div>
          )}
        </>
      )}

      {step === 'codes' && (
        <>
          <p className="otp-info success-note">Two-factor authentication is on.</p>
          <BackupCodesPanel codes={codes} onAcknowledged={onDone} ackLabel={ackLabel} />
        </>
      )}
    </>
  );
}
