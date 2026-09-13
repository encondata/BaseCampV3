/**
 * /link and /link/:code — the phone side of the kiosk's "Link with
 * phone" sign-in. The kiosk shows a QR of /link/<code> (plus the code in
 * text); the signed-in person confirms here and the kiosk's next poll
 * signs it in as them. Sits behind ProtectedRoute like every page, so an
 * anonymous phone bounces through /login and comes straight back.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { ApiError, approvePair, denyPair, getPairInfo, type PairInfo } from '../lib/api';
import '../styles/link.css';

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
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
      setPhase(next);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'pair_not_pending' || err.code === 'pair_not_found')) {
        setPhase('gone');
      } else {
        setError('Something went wrong. Try again.');
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
          <p className="link-error" role="alert">Something went wrong. Try again.</p>
          <button type="button" className="mini-btn" onClick={retry}>Retry</button>
        </>
      )}
      {phase === 'approved' && (
        <p className="page-hint">Done. {name} is signing in — you can put your phone away.</p>
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
