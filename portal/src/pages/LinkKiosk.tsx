/**
 * /link and /link/:code — the phone side of the kiosk's "Link with
 * phone" sign-in. The kiosk shows a QR of /link/<code> (plus the code in
 * text); the signed-in person confirms here and the kiosk's next poll
 * signs it in as them. Sits behind ProtectedRoute like every page, so an
 * anonymous phone bounces through /login and comes straight back.
 *
 * Right after approving, the page offers to sign this phone out (the
 * phone was usually borrowed for one approval). Doing nothing for 15
 * seconds signs it out; Stay signed in cancels. Only the phone's own
 * login ends — the kiosk got its own session when it was approved — and
 * the countdown lives in this page alone, so sign-in and the normal
 * session timers are untouched.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { ApiError, approvePair, denyPair, getPairInfo, type PairInfo } from '../lib/api';
import '../styles/link.css';

export function normalizeCode(raw: string): string {
  // Fold Crockford look-alikes the way a person actually types them
  // (O/0, I/L/1, U/V are easy to mis-key or mis-read) before stripping
  // punctuation and truncating to the code length.
  const folded = raw
    .toUpperCase()
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
  return folded.replace(/[^0-9A-Z]/g, '').slice(0, 8);
}

export default function LinkKiosk() {
  const { code } = useParams<{ code?: string }>();
  const { can, person } = useAuth();
  if (!can('kiosk', 'view')) {
    return (
      <div className="portal-page link-page">
        <div className="eyebrow">Kiosk</div>
        <h1 className="page-title">Not allowed</h1>
        <p className="page-hint">Your account isn&apos;t allowed to sign in to kiosks.</p>
      </div>
    );
  }
  return code
    ? <PairDecision code={code} displayName={person?.display_name ?? ''} />
    : <CodeEntry />;
}

function CodeEntry() {
  const navigate = useNavigate();
  const [value, setValue] = useState('');
  const code = normalizeCode(value);
  const ready = code.length === 8;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (ready) navigate(`/link/${code}`);
  };
  return (
    <div className="portal-page link-page">
      <div className="eyebrow">Kiosk</div>
      <h1 className="page-title">Link a kiosk</h1>
      <p className="page-hint">Enter the 8-character code shown under the kiosk&apos;s QR code.</p>
      <form className="pf-form" onSubmit={submit} noValidate>
        <div className="full">
          <label htmlFor="link-code">Code</label>
          <input
            id="link-code"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="XXXX-XXXX"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            autoFocus
          />
        </div>
        <div className="pf-form-actions full">
          <button type="submit" className="btn-solid" disabled={!ready}>Continue</button>
        </div>
      </form>
    </div>
  );
}

const GENERIC_ERROR = 'Something went wrong. Try again.';

/** Seconds the person has to choose before this phone is signed out. */
export const SIGN_OUT_SECONDS = 15;

/** Shown under "Done." after an approval made on this visit. Counts down
 *  against a fixed deadline (not by counting ticks), so a phone that was
 *  locked mid-countdown still signs out on time when it wakes. */
function SignOutPrompt() {
  const { logout } = useAuth();
  const navigate = useNavigate();
  const [deadline] = useState(() => Date.now() + SIGN_OUT_SECONDS * 1000);
  const [left, setLeft] = useState(SIGN_OUT_SECONDS);
  const [choice, setChoice] = useState<'waiting' | 'stay' | 'leaving'>('waiting');
  const leaving = useRef(false);

  const signOut = useCallback(async () => {
    if (leaving.current) return;
    leaving.current = true;
    setChoice('leaving');
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  }, [logout, navigate]);

  useEffect(() => {
    if (choice !== 'waiting') return undefined;
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setLeft(remaining);
      if (remaining === 0) void signOut();
    };
    const id = window.setInterval(tick, 250);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [choice, deadline, signOut]);

  if (choice === 'stay') {
    return <p className="page-hint" role="status">You&apos;re still signed in on this phone.</p>;
  }
  return (
    <div className="link-card">
      <div className="link-prompt-title">Stay signed in on this phone?</div>
      <p className="page-hint">
        {choice === 'leaving'
          ? 'Signing you out…'
          : `You'll be signed out in ${left} second${left === 1 ? '' : 's'}.`}
      </p>
      <div className="link-actions">
        <button type="button" className="btn-solid" disabled={choice === 'leaving'}
                onClick={() => void signOut()}>Sign out now</button>
        <button type="button" className="mini-btn" disabled={choice === 'leaving'}
                onClick={() => setChoice('stay')}>Stay signed in</button>
      </div>
    </div>
  );
}

type Phase = 'loading' | 'pending' | 'busy' | 'approved' | 'denied' | 'gone' | 'error';

function phaseFor(status: PairInfo['status']): Phase {
  if (status === 'pending') return 'pending';
  if (status === 'approved') return 'approved';
  if (status === 'denied') return 'denied';
  return 'gone';
}

function PairDecision({ code, displayName }: { code: string; displayName: string }) {
  const [info, setInfo] = useState<PairInfo | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  // Only an approval made on this visit offers the sign-out prompt —
  // reopening an already-approved code just shows the done copy.
  const [approvedHere, setApprovedHere] = useState(false);

  const load = useCallback((cancelledRef: { cancelled: boolean }) => {
    setPhase('loading');
    getPairInfo(code)
      .then((i) => { if (!cancelledRef.cancelled) { setInfo(i); setPhase(phaseFor(i.status)); } })
      .catch((err) => {
        if (cancelledRef.cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.code === 'pair_not_found' || err.code === 'pair_not_pending')) {
          setPhase('gone');
        } else {
          setPhase('error');
        }
      });
  }, [code]);

  useEffect(() => {
    const cancelledRef = { cancelled: false };
    load(cancelledRef);
    return () => { cancelledRef.cancelled = true; };
  }, [load, reloadKey]);

  const retry = () => setReloadKey((k) => k + 1);

  const decide = async (fn: (c: string) => Promise<void>, next: Phase) => {
    setPhase('busy');
    setError('');
    try {
      await fn(code);
      if (next === 'approved') setApprovedHere(true);
      setPhase(next);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'pair_not_pending' || err.code === 'pair_not_found')) {
        setPhase('gone');
      } else {
        setError(GENERIC_ERROR);
        setPhase('pending');
      }
    }
  };

  const name = info?.kiosk_name ?? 'this kiosk';
  return (
    <div className="portal-page link-page">
      <div className="eyebrow">Kiosk</div>
      <h1 className="page-title">Link a kiosk</h1>
      {phase === 'loading' && <p className="page-hint">Checking the code…</p>}
      {phase === 'gone' && (
        <>
          <p className="page-hint">This code has expired or was already used. Ask the kiosk for a new one.</p>
          <Link to="/link">Enter a different code</Link>
        </>
      )}
      {phase === 'error' && (
        <>
          <p className="link-error" role="alert">{GENERIC_ERROR}</p>
          <button type="button" className="mini-btn" onClick={retry}>Retry</button>
        </>
      )}
      {phase === 'approved' && (
        <>
          <p className="page-hint">Done. {name} is signing in — you can put your phone away.</p>
          {approvedHere && <SignOutPrompt />}
        </>
      )}
      {phase === 'denied' && <p className="page-hint">Declined.</p>}
      {(phase === 'pending' || phase === 'busy') && info && (
        <div className="link-card">
          <div>Sign in to <span className="link-kiosk-name">{info.kiosk_name}</span>?</div>
          <div className="link-serial">{info.serial}</div>
          <p className="page-hint">
            This signs the kiosk in as {displayName}. Anyone at that kiosk will act as you until they sign out.
          </p>
          {error && <div className="link-error" role="alert">{error}</div>}
          <div className="link-actions">
            <button type="button" className="btn-solid" disabled={phase === 'busy'}
                    onClick={() => void decide(approvePair, 'approved')}>Approve</button>
            <button type="button" className="mini-btn" disabled={phase === 'busy'}
                    onClick={() => void decide(denyPair, 'denied')}>Deny</button>
          </div>
        </div>
      )}
    </div>
  );
}
