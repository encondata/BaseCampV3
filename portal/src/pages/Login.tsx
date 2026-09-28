/**
 * Login page — the light ServerSherpa sign-in (mockup approved 2026-09-28):
 * a static scene (LoginScene: topo lines, route map, headline, features,
 * mountain art) with the form floating on the right. Rewired for the V3 API
 * (email login, cookie-based sessions); the form shakes on error unless
 * reduced motion is set.
 *
 * Two-factor verify/enrollment is built in (the code card and EnrollFlow
 * below); only the SSO flow remains deferred (button kept as a hint).
 */

import { gsap } from 'gsap';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import SystemBanners from '../components/SystemBanners';
import LoginScene from '../components/login/LoginScene';
import { IconArrow, IconEye, IconEyeOff, IconLink } from '../components/login/loginIcons';
import EnrollFlow from '../components/totp/EnrollFlow';
import OtpInput from '../components/totp/OtpInput';
import { ApiError, isTotpChallenge, totpEnrollConfirm, totpEnrollStart, totpVerify, type TotpChallenge } from '../lib/api';
import { getSystemStatus } from '../lib/systemStatus';
import '../styles/auth-theme.css';
import '../styles/login-light.css';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Invalid email or password.',
  account_locked: 'Too many failed attempts — this account is temporarily locked. Try again in about 15 minutes.',
  account_disabled: 'This account is disabled. Contact your coordinator.',
};

const CODE_ERRORS: Record<string, string> = {
  totp_invalid: "That code didn't match. Try the next one.",
  account_locked: 'Too many failed attempts — this account is temporarily locked. Try again in about 15 minutes.',
  invalid_challenge: 'This sign-in expired. Start again.',
};

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, completeLogin } = useAuth();

  // Get the redirect destination from state (set by ProtectedRoute)
  // Only use if we have a valid pathname (not undefined, not /login paths)
  const fromState = (location.state as { from?: { pathname?: string; search?: string } } | null)?.from;
  const fromPath = fromState?.pathname;
  const from = fromPath && !fromPath.startsWith('/login')
    ? fromPath + (fromState?.search || '')
    : null;

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState({ email: false, password: false });
  const [loading, setLoading] = useState(false);
  const [ssoHint, setSsoHint] = useState(false);
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);

  const [challenge, setChallenge] = useState<TotpChallenge | null>(null);
  const [code, setCode] = useState('');
  const [backupMode, setBackupMode] = useState(false);
  const [rememberBrowser, setRememberBrowser] = useState(false);
  const [codeError, setCodeError] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [trustDays, setTrustDays] = useState(7);
  // Bumped on a wrong-code error so <OtpInput> remounts with autoFocus,
  // putting the caret back in box 1 instead of leaving it in the last box.
  const [otpAttempt, setOtpAttempt] = useState(0);

  useEffect(() => {
    getSystemStatus().then((s) => setTrustDays(s.totp_trust_days)).catch(() => {});
  }, []);

  const formWrapRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const shakeForm = () => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    gsap.fromTo(formWrapRef.current, { x: 0 }, { x: -7, duration: 0.07, repeat: 5, yoyo: true, clearProps: 'x', ease: 'power1.inOut' });
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    if (!email || !password) {
      setInvalid({ email: !email, password: !password });
      setError('Please enter both email and password');
      setLoading(false);
      shakeForm();
      (!email ? emailRef : passwordRef).current?.focus();
      return;
    }

    try {
      const result = await login(email, password);
      if (isTotpChallenge(result)) {
        setChallenge(result);
        setPassword('');
        return;
      }
      navigate(from ?? '/', { replace: true });
    } catch (err) {
      const errCode = err instanceof ApiError ? err.code : 'network';
      setError(ERROR_MESSAGES[errCode] ?? 'Login failed. Please try again.');
      setInvalid({ email: true, password: true });
      setPassword('');
      shakeForm();
    } finally {
      setLoading(false);
    }
  };

  const finish = useCallback(() => navigate(from ?? '/', { replace: true }), [navigate, from]);

  const submitCode = async (value: string) => {
    if (!challenge || verifying) return;
    setVerifying(true);
    setCodeError('');
    try {
      const session = await totpVerify(challenge.challenge_token, value, rememberBrowser);
      completeLogin(session);
      finish();
    } catch (err) {
      const c = err instanceof ApiError ? err.code : 'network';
      const message = CODE_ERRORS[c] ?? 'Could not verify the code. Try again.';
      setCode('');
      shakeForm();
      if (c === 'invalid_challenge' || c === 'account_locked') {
        // The card is about to unmount — carry the message back to the
        // password form instead of losing it along with codeError.
        setChallenge(null);
        setCodeError('');
        setError(message);
      } else {
        setCodeError(message);
        setOtpAttempt((n) => n + 1);
      }
    } finally {
      setVerifying(false);
    }
  };

  const backToSignIn = () => {
    setChallenge(null); setCode(''); setBackupMode(false); setCodeError(''); setError('');
  };

  return (
    <div className="login-shell login-light">
      <LoginScene />

      {/* ============ SIGN-IN FORM ============ */}
      <main className="lx-form-col">
        <div className="form-wrap" ref={formWrapRef}>
          <div className="eyebrow">ServerSherpa Portal</div>
          <div className="login-banners"><SystemBanners /></div>
          <h2 className="form-title">Sign in</h2>
          <p className="form-hint">Use the account credentials provided by your migration coordination team.</p>

          {!challenge && (
            <>
              <form onSubmit={handleSubmit} noValidate>
                <div className="field">
                  <label htmlFor="login-email">Email</label>
                  <div className="control">
                    <input
                      id="login-email"
                      ref={emailRef}
                      name="email"
                      type="email"
                      placeholder="you@company.com"
                      autoComplete="username"
                      autoFocus
                      className={invalid.email ? 'invalid' : ''}
                      value={email}
                      onChange={(e) => {
                        setEmail(e.target.value);
                        setInvalid((v) => ({ ...v, email: false }));
                        setError('');
                      }}
                    />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="login-password">
                    Password
                    {/* out of the Tab order so email → password → Sign in is
                        uninterrupted; keyboard users reach the same card via
                        "Contact support" below the form */}
                    <button type="button" className="link" tabIndex={-1} onClick={() => setForgotPasswordOpen(true)}>Forgot password?</button>
                  </label>
                  <div className="control">
                    <input
                      id="login-password"
                      ref={passwordRef}
                      name="password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="••••••••••••"
                      autoComplete="current-password"
                      className={invalid.password ? 'invalid' : ''}
                      value={password}
                      onChange={(e) => {
                        setPassword(e.target.value);
                        setInvalid((v) => ({ ...v, password: false }));
                        setError('');
                      }}
                    />
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`peek ${showPassword ? 'on' : ''}`}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? <IconEyeOff /> : <IconEye />}
                    </button>
                  </div>
                </div>

                <p className={`error-msg ${error ? 'show' : ''}`}>{error}</p>

                <button className={`btn ${loading ? 'loading' : ''}`} type="submit" disabled={loading}>
                  <span>{loading ? 'Signing in…' : 'Sign in'}</span>
                  <IconArrow className="arrow" />
                  <span className="spinner"></span>
                </button>
              </form>

              <div className="divider">OR</div>

              <button className="btn-sso" type="button" onClick={() => setSsoHint(true)}>
                <IconLink />
                Continue with SSO
              </button>
              {ssoHint && (
                <p className="sso-hint">Company SSO isn't enabled yet — sign in with your email and password.</p>
              )}

              <p className="form-foot">
                Trouble signing in? <button type="button" className="link" onClick={() => setForgotPasswordOpen(true)}>Contact support</button>
              </p>
            </>
          )}

          {challenge?.status === 'totp_verify' && (
            <div className="otp-card inline-card">
              <div className="eyebrow">Two-factor</div>
              <h3 className="otp-title">Enter your code</h3>
              <p className="otp-text">{backupMode
                ? 'Enter one of your backup codes. Each one works once.'
                : 'Open your authenticator app and enter the 6-digit code.'}</p>
              {backupMode ? (
                <form onSubmit={(e) => { e.preventDefault(); void submitCode(code); }}>
                  <div className="code-input field">
                    <div className="control">
                      <input id="backup-code" aria-label="Backup code" placeholder="xxxxx-xxxxx"
                             autoComplete="off" autoFocus value={code}
                             onChange={(e) => { setCode(e.target.value); setCodeError(''); }} />
                    </div>
                  </div>
                </form>
              ) : (
                <OtpInput key={otpAttempt} value={code} onChange={(v) => { setCode(v); setCodeError(''); }}
                          onComplete={(v) => void submitCode(v)} disabled={verifying}
                          invalid={!!codeError} autoFocus idPrefix="login-otp" />
              )}
              <p className={`otp-error ${codeError ? 'show' : ''}`} role={codeError ? 'alert' : undefined}>{codeError}</p>
              <div className="otp-row">
                <label className="remember">
                  <input type="checkbox" checked={rememberBrowser} onChange={(e) => setRememberBrowser(e.target.checked)} />
                  <span className="box">
                    <svg viewBox="0 0 12 12" fill="none" stroke="#0c1117" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
                  </span>
                  Remember this browser for {trustDays} days
                </label>
              </div>
              <button className={`btn otp-verify ${verifying ? 'loading' : ''}`} type="button"
                      disabled={verifying || (backupMode ? code.replace(/[^a-z0-9]/gi, '').length < 10 : code.length < 6)}
                      onClick={() => void submitCode(code)}>
                <span>{verifying ? 'Verifying…' : 'Verify'}</span>
                <span className="spinner"></span>
              </button>
              <p className="otp-foot">
                <button type="button" className="link" tabIndex={-1}
                        onClick={() => { setBackupMode((b) => !b); setCode(''); setCodeError(''); }}>
                  {backupMode ? 'Use my authenticator app' : 'Use a backup code'}
                </button>
                {' · '}
                <button type="button" className="link" tabIndex={-1} onClick={backToSignIn}>Back to sign in</button>
              </p>
            </div>
          )}

          {challenge?.status === 'totp_enroll' && (
            <div className="otp-card inline-card">
              <div className="eyebrow">Two-factor required</div>
              <h3 className="otp-title">Set up your authenticator</h3>
              <EnrollFlow
                email={email}
                start={() => totpEnrollStart(challenge.challenge_token)}
                confirm={async (c) => {
                  const r = await totpEnrollConfirm(c, { token: challenge.challenge_token, remember: rememberBrowser });
                  if (r.session) completeLogin(r.session);
                  return r;
                }}
                remember={{ checked: rememberBrowser, onChange: setRememberBrowser, days: trustDays }}
                onDone={finish}
                onError={(c) => {
                  shakeForm();
                  if (c === 'invalid_challenge' || c === 'account_locked') {
                    // Same drop-back as the verify card: don't strand the
                    // user on a blank form with no explanation.
                    setChallenge(null);
                    setError(CODE_ERRORS[c] ?? 'Something went wrong. Try again.');
                  }
                }}
              />
              <p className="otp-foot">
                <button type="button" className="link" tabIndex={-1} onClick={backToSignIn}>Back to sign in</button>
              </p>
            </div>
          )}
        </div>
      </main>

      {/* Forgot Password / Contact Support card */}
      {forgotPasswordOpen && (
        <div
          className="auth-scrim"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setForgotPasswordOpen(false); }}
        >
          <div className="otp-card centered">
            <button className="otp-close" type="button" aria-label="Close" onClick={() => setForgotPasswordOpen(false)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
            <div className="eyebrow">Account Recovery</div>
            <div className="phone-badge">📞</div>
            <h3 className="otp-title">Call Jimmy</h3>
            <p className="otp-text">He'll help you get back in.</p>
            <button className="btn otp-verify" type="button" onClick={() => setForgotPasswordOpen(false)}>
              <span>Got it</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
