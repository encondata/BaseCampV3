/** Admin override: an admin types their own email and password (and the
 *  6-digit code once the portal asks for it) at the shared screen, picks
 *  why and how far it reaches, and the worker clocks in. The portal checks
 *  the credentials; nothing is signed in here, and nothing is remembered.
 *  The flow owns the request (`submit`); this owns the form and says, in
 *  plain words, why the portal refused. */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import {
  ApiError, CLOUD_SIGN_IN_TEXT, type LearningOverrideForm, type LearningOverrideReason,
} from '../../lib/api';
import { IconClose } from '../icons';

const REASONS: { value: LearningOverrideReason; label: string }[] = [
  { value: 'signing_on_break', label: 'Signing on break' },
  { value: 'signed_on_paper', label: 'Signed on paper' },
  { value: 'no_phone', label: 'No phone' },
  { value: 'other', label: 'Other' },
];
const SCOPES: { value: LearningOverrideForm['scope']; label: string }[] = [
  { value: 'punch', label: 'This punch only' },
  { value: 'day', label: 'Rest of today' },
];

const TOTP_PROMPT = "Enter the 6-digit code from the admin's authenticator app.";

/** What an override refusal says. `totp_required` is not an error: the code
 *  field appears and this is its prompt. */
export function overrideErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Try again.';
  switch (err.code) {
    case 'override_credentials_invalid': return "That email and password didn't work.";
    case 'totp_required': return TOTP_PROMPT;
    case 'totp_invalid': return "That code didn't work.";
    case 'totp_enroll_required': return 'This admin must set up two-factor sign-in first.';
    case 'override_rank': return 'Only an admin or above can override.';
    case 'totp_seed_unreadable': return "This admin's two-factor sign-in can't be read. Try another admin.";
    case 'reason_text_required': return 'Say why, in a few words.';
    case 'rate_limited': return 'Too many tries. Wait a few minutes.';
    case 'read_only_mode': return 'The portal is in read-only mode. Try again shortly.';
    case 'cloud_sign_in_required': return CLOUD_SIGN_IN_TEXT;
    case 'network': case 'edge_offline': return "Can't reach the portal. Try again.";
    default: return 'Something went wrong. Try again.';
  }
}

export interface LearningOverrideModalProps {
  /** Who the override clocks in, for the heading. */
  personName: string;
  /** Sends the override; resolves with its id, rejects with `ApiError`. */
  submit(form: LearningOverrideForm): Promise<{ override_id: string }>;
  onBack(): void;
  /** The override is made: clock the person in with it. */
  onDone(overrideId: string): void;
}

export default function LearningOverrideModal({
  personName, submit, onBack, onDone,
}: LearningOverrideModalProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [reason, setReason] = useState<LearningOverrideReason>('signing_on_break');
  const [reasonText, setReasonText] = useState('');
  const [scope, setScope] = useState<LearningOverrideForm['scope']>('punch');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  // One request at a time even if a second tap lands before React re-renders.
  const inFlight = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !sending) onBack(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onBack, sending]);

  useEffect(() => { if (needCode) codeRef.current?.focus(); }, [needCode]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current) return;
    const text = reasonText.trim();
    if (!email.trim() || !password) {
      setError("Enter the admin's email and password.");
      return;
    }
    if (needCode && !code.trim()) {
      setError(TOTP_PROMPT);
      return;
    }
    if (reason === 'other' && !text) {
      setError('Say why, in a few words.');
      return;
    }
    inFlight.current = true;
    setSending(true);
    setError(null);
    submit({
      admin_email: email.trim(),
      admin_password: password,
      ...(needCode ? { totp_code: code.trim() } : {}),
      reason,
      ...(reason === 'other' ? { reason_text: text } : {}),
      scope,
    }).then(
      (out) => { onDone(out.override_id); },
      (err: unknown) => {
        inFlight.current = false;
        setSending(false);
        setError(overrideErrorText(err));
        const c = err instanceof ApiError ? err.code : '';
        if (c === 'totp_required') setNeedCode(true);
        if (c === 'totp_invalid') setCode('');
        // a refused password is never worth keeping on the screen
        if (c === 'override_credentials_invalid' || c === 'override_rank') setPassword('');
      },
    );
  };

  return (
    <div className="tcx-modal-scrim">
      <form className="tcx-modal" role="dialog" aria-modal="true" aria-labelledby="tcx-ovr-title"
            onSubmit={onSubmit} noValidate>
        <div className="tcx-modal-head">
          <div className="tcx-eyebrow">Admin override</div>
          <h2 id="tcx-ovr-title" className="tcx-modal-title">Clock {personName} in</h2>
          <p className="tcx-modal-desc">
            The override is recorded on their history and the compliance report.
          </p>
          <button type="button" className="tcx-modal-close" aria-label="Close" disabled={sending} onClick={onBack}>
            <IconClose />
          </button>
        </div>
        <div className="tcx-modal-body">
          <label className="tcx-field">
            <span className="tcx-field-label">Admin email</span>
            <input
              className="tcx-input" type="email" autoFocus autoComplete="off" spellCheck={false}
              value={email} disabled={sending} onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="tcx-field">
            <span className="tcx-field-label">Password</span>
            <input
              className="tcx-input" type="password" autoComplete="off"
              value={password} disabled={sending} onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {needCode && (
            <label className="tcx-field">
              <span className="tcx-field-label">2FA code</span>
              <input
                ref={codeRef} className="tcx-input" inputMode="numeric" autoComplete="off" maxLength={12}
                placeholder="6-digit code" value={code} disabled={sending}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
          )}
          <div className="tcx-field" role="radiogroup" aria-label="Reason">
            <span className="tcx-field-label">Reason</span>
            <div className="tcx-chips">
              {REASONS.map((r) => (
                <button
                  key={r.value} type="button" role="radio" aria-checked={reason === r.value}
                  className={`tcx-chip${reason === r.value ? ' is-on' : ''}`} disabled={sending}
                  onClick={() => setReason(r.value)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {reason === 'other' && (
              <input
                className="tcx-input" aria-label="Why" placeholder="Why?" maxLength={500}
                autoComplete="off" value={reasonText} disabled={sending}
                onChange={(e) => setReasonText(e.target.value)}
              />
            )}
          </div>
          <div className="tcx-field" role="radiogroup" aria-label="Covers">
            <span className="tcx-field-label">Covers</span>
            <div className="tcx-chips">
              {SCOPES.map((s) => (
                <button
                  key={s.value} type="button" role="radio" aria-checked={scope === s.value}
                  className={`tcx-chip${scope === s.value ? ' is-on' : ''}`} disabled={sending}
                  onClick={() => setScope(s.value)}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          {error && <p className="tcx-modal-error" role="alert">{error}</p>}
        </div>
        <div className="tcx-modal-foot">
          <button type="button" className="tcx-btn is-ghost" disabled={sending} onClick={onBack}>Back</button>
          <button type="submit" className="tcx-btn is-primary" disabled={sending}>Override and clock in</button>
        </div>
      </form>
    </div>
  );
}
