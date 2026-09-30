/**
 * Kiosk login — the SAME sign-in page the portal and the wiki show
 * (light mockup, 2026-09-28): the shared `LoginScene` (topo lines, logo,
 * Dallas → Las Vegas map, headline, features, mountain art) with the form
 * floating on the right. One page across the three apps was the point, so
 * the scene is imported from the portal rather than copied, and
 * `login-light.css` styles it exactly as it styles the portal's.
 *
 * What stays the kiosk's own is the form column: which kiosk this is,
 * the settings gear, the kiosk banners, and the three ways in. Email &
 * password is the normal, default form (same API, tagged client=kiosk);
 * the alternates (link with phone via PairPanel, move password) sit
 * behind an "Other ways to sign in" button below it.
 *
 * The old split-screen brand panel and its animated terrain
 * (`buildBrandScene`) are gone — the portal dropped them on 2026-09-28
 * and this was the last caller.
 */

import { gsap } from 'gsap';
import { useCallback, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import LoginScene from '@portal/components/login/LoginScene';
import { IconArrow } from '@portal/components/login/loginIcons';
import '@portal/styles/login-light.css';

import { useKioskAuth } from '../auth/KioskAuthContext';
import KioskBanners from '../components/KioskBanners';
import PairPanel from '../components/PairPanel';
import { ApiError, type SessionData } from '../lib/api';
import { getIdentity } from '../lib/identity';

type View = 'password' | 'chooser' | 'link' | 'move';

/** The kiosk's own line under its headline. It is repeated as the form's
 *  hint for narrow screens, where login-light.css hides the whole story
 *  block — kiosk.css hides the hint again once the story is visible. */
const KIOSK_SUB = 'Sign in to start scanning. Link this kiosk with your phone'
  + ' or use your ServerSherpa credentials.';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Invalid email or password.',
  account_locked: 'Too many failed attempts — this account is temporarily locked. Try again in about 15 minutes.',
  account_disabled: 'This account is disabled. Contact your coordinator.',
  totp_required: 'This account requires a verification code. 2FA sign-in is coming soon — contact support.',
  kiosk_not_allowed: "This account isn't allowed to use kiosks. Ask your coordinator to grant kiosk access.",
  invalid_move_password: "That move password isn't right.",
  move_not_active: "That move password isn't active.",
  move_login_rate_limited: 'Too many tries. Wait a few minutes.',
  network: "Can't reach the server. Check the kiosk's network connection.",
};

/** The move form's own wording where a code means something else there:
 *  kiosk_not_allowed on a move sign-in is the move's kiosk identity, not
 *  the person's account. */
const MOVE_ERROR_MESSAGES: Record<string, string> = {
  ...ERROR_MESSAGES,
  kiosk_not_allowed: "That move can't sign in to kiosks right now. Ask a coordinator.",
};

/** jsdom-safe: matchMedia is absent in some test environments. */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="6" height="6" rx="1" /><rect x="15" y="3" width="6" height="6" rx="1" />
      <rect x="3" y="15" width="6" height="6" rx="1" /><rect x="15" y="15" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="15.5" r="4.5" /><path d="M11 12 20 3M16 8l3-3M20 3l1 1" />
    </svg>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login, loginWithMovePassword, completePair } = useKioskAuth();
  const fromState = (location.state as { from?: { pathname?: string } } | null)?.from;
  const from = fromState?.pathname && !fromState.pathname.startsWith('/login') ? fromState.pathname : '/';

  const [view, setView] = useState<View>('password');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [invalid, setInvalid] = useState({ email: false, password: false });
  const [loading, setLoading] = useState(false);

  const [movePassword, setMovePassword] = useState('');
  const [showMove, setShowMove] = useState(false);
  const [moveError, setMoveError] = useState('');
  const [moveLoading, setMoveLoading] = useState(false);

  const formWrapRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  const shakeForm = () => {
    if (prefersReducedMotion()) return;
    gsap.fromTo(formWrapRef.current, { x: 0 }, { x: -7, duration: 0.07, repeat: 5, yoyo: true, clearProps: 'x', ease: 'power1.inOut' });
  };

  const handlePassword = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email || !password) {
      setInvalid({ email: !email, password: !password });
      setError('Please enter both email and password');
      shakeForm();
      (!email ? emailRef : passwordRef).current?.focus();
      return;
    }
    setLoading(true);
    try {
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'network';
      setError(ERROR_MESSAGES[code] ?? 'Login failed. Please try again.');
      setInvalid({ email: true, password: true });
      setPassword('');
      shakeForm();
    } finally {
      setLoading(false);
    }
  };

  const handleMove = async (e: FormEvent) => {
    e.preventDefault();
    setMoveError('');
    if (!movePassword.trim()) {
      setMoveError('Enter the move password.');
      shakeForm();
      return;
    }
    setMoveLoading(true);
    try {
      await loginWithMovePassword(movePassword);
      setMovePassword('');
      navigate(from, { replace: true });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'network';
      setMoveError(MOVE_ERROR_MESSAGES[code] ?? 'Login failed. Please try again.');
      setMovePassword('');
      shakeForm();
    } finally {
      setMoveLoading(false);
    }
  };

  const onApproved = useCallback((session: SessionData) => {
    completePair(session);
    navigate(from, { replace: true });
  }, [completePair, navigate, from]);

  const identity = getIdentity();

  return (
    <div className="login-shell login-light">
      {/* The scene is shared; only the headline names the app. The kiosk's
          is the single accent word it has always been, over the same line
          the retired brand panel carried. */}
      <LoginScene
        lead={null}
        accent="Kiosk"
        sub={KIOSK_SUB}
      />

      <main className="lx-form-col">
        <button type="button" className="kiosk-login-gear" aria-label="Kiosk settings"
                onClick={() => navigate('/settings?tab=this-kiosk')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
          </svg>
        </button>
        <div className="form-wrap" ref={formWrapRef}>
          <div className="eyebrow-row">
            <div className="eyebrow">ServerSherpa Kiosk</div>
            <div className="eyebrow-kiosk">{identity.name}</div>
          </div>
          <div className="login-banners"><KioskBanners /></div>
          <h2 className="form-title">Sign in</h2>

          {(view === 'password' || view === 'chooser') && (
            <div>
              {/* the same line the scene shows, repeated for the narrow
                  layout where the scene's story block is hidden */}
              <p className="form-hint kiosk-login-sub">{KIOSK_SUB}</p>
              <form onSubmit={handlePassword} noValidate>
                <div className="field">
                  <label htmlFor="login-email">Email</label>
                  <div className="control">
                    <input id="login-email" ref={emailRef} name="email" type="email"
                           placeholder="you@company.com" autoComplete="username" autoFocus
                           className={invalid.email ? 'invalid' : ''} value={email}
                           onChange={(e) => { setEmail(e.target.value); setInvalid((v) => ({ ...v, email: false })); setError(''); }} />
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="login-password">Password</label>
                  <div className="control">
                    <input id="login-password" ref={passwordRef} name="password"
                           type={showPassword ? 'text' : 'password'} placeholder="••••••••••••"
                           autoComplete="current-password" className={invalid.password ? 'invalid' : ''}
                           value={password}
                           onChange={(e) => { setPassword(e.target.value); setInvalid((v) => ({ ...v, password: false })); setError(''); }} />
                    <button type="button" className={`peek ${showPassword ? 'on' : ''}`}
                            aria-label={showPassword ? 'Hide password' : 'Show password'}
                            onClick={() => setShowPassword(!showPassword)}><EyeIcon /></button>
                  </div>
                </div>
                <p className={`error-msg ${error ? 'show' : ''}`} role={error ? 'alert' : undefined}>{error}</p>
                <button type="submit" className={`btn ${loading ? 'loading' : ''}`} disabled={loading}>
                  <span>{loading ? 'Signing in…' : 'Sign in'}</span>
                  <IconArrow className="arrow" />
                  <span className="spinner" />
                </button>
                <p className="form-foot">Forgot your password? Reset it in the portal.</p>
              </form>

              <div className="divider">or</div>

              {view === 'password' ? (
                <button type="button" className="btn-alt" onClick={() => setView('chooser')}>
                  Other ways to sign in
                </button>
              ) : (
                <div className="alt-methods">
                  <button type="button" className="btn-alt" onClick={() => setView('link')}>
                    <LinkIcon />
                    Link with phone
                  </button>
                  <button type="button" className="btn-alt" onClick={() => setView('move')}>
                    <KeyIcon />
                    Move password
                  </button>
                </div>
              )}
            </div>
          )}

          {view === 'link' && (
            <div>
              <p className="form-hint">Link this kiosk with your phone.</p>
              <PairPanel onApproved={onApproved} />
              <p className="form-foot">
                <button type="button" className="link" onClick={() => setView('password')}>Back to email &amp; password</button>
              </p>
            </div>
          )}

          {view === 'move' && (
            <div>
              <p className="form-hint">Sign in with a move password.</p>
              <form onSubmit={handleMove} noValidate>
                <div className="field">
                  <label htmlFor="login-move">Move password</label>
                  <div className="control">
                    <input id="login-move" name="move-password" type={showMove ? 'text' : 'password'}
                           placeholder="••••••••" autoComplete="off" value={movePassword}
                           onChange={(e) => { setMovePassword(e.target.value); setMoveError(''); }} />
                    <button type="button" className={`peek ${showMove ? 'on' : ''}`}
                            aria-label={showMove ? 'Hide password' : 'Show password'}
                            onClick={() => setShowMove(!showMove)}><EyeIcon /></button>
                  </div>
                </div>
                <p className={`error-msg ${moveError ? 'show' : ''}`} role={moveError ? 'alert' : undefined}>{moveError}</p>
                <button type="submit" className={`btn ${moveLoading ? 'loading' : ''}`} disabled={moveLoading}>
                  <span>{moveLoading ? 'Signing in…' : 'Sign in'}</span>
                  <IconArrow className="arrow" />
                  <span className="spinner" />
                </button>
              </form>
              <p className="form-foot">
                <button type="button" className="link" onClick={() => setView('password')}>Back to email &amp; password</button>
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
