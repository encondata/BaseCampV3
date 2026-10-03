/**
 * Forgot password — the login page's recovery card. With email on it
 * sends a reset link; with email off it asks the administrators (an inbox
 * card for users:change holders). Either way the answer is one fixed
 * message: it never says whether the account exists.
 */

import { useState, type FormEvent } from 'react';

import { ApiError, requestPasswordReset } from '../../lib/api';

interface Props {
  initialEmail: string;
  emailEnabled: boolean;
  ttlMinutes: number;
  onClose: () => void;
}

export default function ForgotPasswordCard({ initialEmail, emailEnabled, ttlMinutes, onClose }: Props) {
  const [email, setEmail] = useState(initialEmail);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!email.trim()) { setError('Enter your email.'); return; }
    setSending(true);
    setError('');
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'rate_limited'
        ? 'Too many requests. Try again later.'
        : 'Could not send the request. Try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="auth-scrim" role="dialog" aria-modal="true" aria-labelledby="forgot-title"
         onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="otp-card centered">
        <button className="otp-close" type="button" aria-label="Close" onClick={onClose}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
        </button>
        <div className="eyebrow">Account recovery</div>
        {sent ? (
          <>
            <h3 className="otp-title" id="forgot-title">{emailEnabled ? 'Check your email' : 'Request sent'}</h3>
            <p className="otp-text" role="status">
              {emailEnabled
                ? `If an account exists for that email, a reset link is on its way. It expires in ${ttlMinutes} minutes.`
                : "If an account exists for that email, your administrators have been asked to reset it. They'll be in touch."}
            </p>
            <button className="btn otp-verify" type="button" onClick={onClose}><span>Done</span></button>
          </>
        ) : (
          <form onSubmit={submit} noValidate>
            <h3 className="otp-title" id="forgot-title">Reset your password</h3>
            <p className="otp-text">
              {emailEnabled
                ? "Enter your account email and we'll send you a link to choose a new password."
                : "Enter your account email and we'll ask your administrators to reset your password."}
            </p>
            <div className="field">
              <label htmlFor="forgot-email">Email</label>
              <div className="control">
                <input id="forgot-email" type="email" autoComplete="username" autoFocus
                       placeholder="you@company.com" value={email}
                       onChange={(e) => { setEmail(e.target.value); setError(''); }} />
              </div>
            </div>
            <p className={`otp-error ${error ? 'show' : ''}`} role={error ? 'alert' : undefined}>{error}</p>
            <button className={`btn otp-verify ${sending ? 'loading' : ''}`} type="submit" disabled={sending}>
              <span>{emailEnabled ? 'Send reset link' : 'Ask for a reset'}</span>
              <span className="spinner"></span>
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
