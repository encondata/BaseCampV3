/**
 * Login page — ported from BaseCampV2/portal-v2 (ServerSherpa design):
 * brand panel with GSAP ridgeline terrain, origin→destination migration
 * route and sherpa/truck traveler, form shake on error, reduced-motion
 * support. Rewired for the V3 API (email login, cookie-based sessions).
 *
 * Deferred from V2 until TOTP enrollment ships server-side:
 * TwoFAVerifyModal / TwoFASetupModal and the SSO flow (button kept).
 */

import { gsap } from 'gsap';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import SystemBanners from '../components/SystemBanners';
import { ApiError } from '../lib/api';
import { buildBrandScene } from '../lib/brandScene';
import '../styles/auth-theme.css';

const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: 'Invalid email or password.',
  account_locked: 'Too many failed attempts — this account is temporarily locked. Try again in about 15 minutes.',
  account_disabled: 'This account is disabled. Contact your coordinator.',
  totp_required: 'This account requires a verification code. 2FA sign-in is coming soon — contact support.',
};

const FEATURES = [
  { label: 'Track assets', icon: (
    <><path d="M12 3 20 7.5v9L12 21 4 16.5v-9Z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></>
  ) },
  { label: 'Monitor progress', icon: (
    <><path d="M4 20h16" /><path d="M7 20v-7M12 20V6M17 20v-10" /></>
  ) },
  { label: 'Verify work', icon: (
    <><path d="M12 3 19 6v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6Z" /><path d="m8.8 12 2.3 2.3L15.5 9.8" /></>
  ) },
  { label: 'Complete on time', icon: (
    <><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r=".6" fill="currentColor" /></>
  ) },
];

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();

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
  const [remember, setRemember] = useState(false); // cosmetic; sessions persist via tokens
  const [ssoHint, setSsoHint] = useState(false);
  const [forgotPasswordOpen, setForgotPasswordOpen] = useState(false);

  const brandRef = useRef<HTMLElement>(null);
  const terrainSvgRef = useRef<SVGSVGElement>(null);
  const formWrapRef = useRef<HTMLDivElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!brandRef.current || !terrainSvgRef.current) return;
    return buildBrandScene(brandRef.current, terrainSvgRef.current, reduceMotion, { layout: 'map' });
  }, []);

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
      const session = await login(email, password);
      // password-change-required flow lands with account management;
      // until then the dashboard shows a banner via must_change_password
      navigate(from ?? '/', { replace: true });
      void session;
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

  return (
    <div className="login-shell login-map">

      {/* ============ BRAND PANEL ============ */}
      <section className="brand brand-map" ref={brandRef}>
        <div className="terrain" aria-hidden="true">
          <svg ref={terrainSvgRef} preserveAspectRatio="xMidYMax slice"></svg>
        </div>

        <header className="brand-top">
          <div className="logo">
            <img
              className="logo-mark"
              src="/images/serversherpa-logo.png"
              alt="ServerSherpa logo"
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            <div>
              <div className="logo-name">Server<em>Sherpa</em></div>
              <div className="logo-tag">Datacenter Relocation Tools</div>
            </div>
          </div>
        </header>

        <div className="brand-mid">
          <h1 className="headline">
            <span className="line"><span>Migration Control.</span></span>
            <span className="line"><span><span className="accent">From First Scan to Final Rack.</span></span></span>
          </h1>
          <p className="sub">
            Track relocation progress, review manifests, verify assets,
            and access complete migration records.
          </p>
          <ul className="features">
            {FEATURES.map(({ label, icon }) => (
              <li key={label}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icon}</svg>
                <span>{label}</span>
              </li>
            ))}
          </ul>
        </div>

        <img className="brand-mountains" src="/images/login-mountains.png" alt="" aria-hidden="true" />

        <div className="brand-aside aside-values" aria-hidden="true">
          People<br />Process<br />Technology<br />Smoother<br />moves.
        </div>
        <div className="brand-aside aside-motto" aria-hidden="true">
          <span>Higher standards</span>
          <span>For a more connected world.</span>
        </div>

        <footer className="brand-bottom">
          <span className="live-dot"></span>
          <span className="ticker"><b>ALL SYSTEMS OPERATIONAL</b> · STATUS.SERVERSHERPA.COM</span>
        </footer>
      </section>

      {/* ============ LOGIN PANEL ============ */}
      <section className="pane pane-topo">
        <div className="form-wrap" ref={formWrapRef}>
          <div className="eyebrow" data-reveal="">ServerSherpa Portal</div>
          <div className="login-banners"><SystemBanners /></div>
          <h2 className="form-title" data-reveal="">Sign in</h2>
          <p className="form-hint" data-reveal="">Use the account credentials provided by your migration coordination team.</p>

          <form onSubmit={handleSubmit} noValidate>
            <div className="field" data-reveal="">
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

            <div className="field" data-reveal="">
              <label htmlFor="login-password">
                Password
                <button type="button" className="link" onClick={() => setForgotPasswordOpen(true)}>Forgot?</button>
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
                  className={`peek ${showPassword ? 'on' : ''}`}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword(!showPassword)}
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              </div>
            </div>

            <p className={`error-msg ${error ? 'show' : ''}`}>{error}</p>

            <div className="row-between" data-reveal="">
              <label className="remember">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                <span className="box">
                  <svg viewBox="0 0 12 12" fill="none" stroke="#0c1117" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
                </span>
                Keep me signed in
              </label>
            </div>

            <button className={`btn ${loading ? 'loading' : ''}`} type="submit" disabled={loading} data-reveal="">
              <span>{loading ? 'Signing in…' : 'Sign in'}</span>
              <svg className="arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
              <span className="spinner"></span>
            </button>
          </form>

          <div className="divider" data-reveal="">OR</div>

          <button className="btn-sso" type="button" data-reveal="" onClick={() => setSsoHint(true)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="10" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
            Login with SSO
          </button>
          {ssoHint && (
            <p className="sso-hint">Company SSO isn't enabled yet — sign in with your email and password.</p>
          )}

          <p className="form-foot" data-reveal="">
            Trouble signing in? <button type="button" className="link" onClick={() => setForgotPasswordOpen(true)}>Contact support</button>
          </p>
        </div>
      </section>

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
