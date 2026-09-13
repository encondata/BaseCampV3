/**
 * "Link with phone": ask the API for a pairing code, show it as a QR of
 * the portal's /link/<code> URL (and as text for manual entry), count
 * down its 5-minute life, and poll every 2 s until the phone approves
 * (→ onApproved with the minted session), denies, or the code expires.
 * Polling pauses while the tab is hidden and never overlaps itself.
 */

import QRCode from 'qrcode';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiError, createPairRequest, pollPair, type PairCreated, type SessionData } from '../lib/api';
import { portalUrl } from '../lib/config';
import { getIdentity } from '../lib/identity';

export const POLL_MS = 2000;

type Phase = 'requesting' | 'showing' | 'denied' | 'expired' | 'error';

export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function portalHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function describe(err: unknown): string {
  if (err instanceof ApiError && err.code === 'pair_rate_limited') {
    return 'too many codes requested — wait a few minutes';
  }
  if (err instanceof ApiError && err.code === 'network') return 'network error';
  return 'server error';
}

export default function PairPanel({ onApproved }: { onApproved: (session: SessionData) => void }) {
  const [phase, setPhase] = useState<Phase>('requesting');
  const [pair, setPair] = useState<PairCreated | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Bumped on every request() call. The actual network call and any state
  // update are deferred to a microtask that re-checks this generation —
  // so a call superseded before that microtask runs (React 18 StrictMode's
  // synthetic mount→cleanup→mount invokes the mount effect twice, back to
  // back, in the same synchronous pass) never hits the API or touches
  // state at all. The later call always wins.
  const generationRef = useRef(0);

  const request = useCallback(() => {
    const generation = ++generationRef.current;
    setPhase('requesting');
    setError('');
    queueMicrotask(async () => {
      if (generationRef.current !== generation) return;
      try {
        const { serial, name } = getIdentity();
        const created = await createPairRequest({ serial, name });
        if (generationRef.current !== generation) return;
        setPair(created);
        setNow(Date.now());
        setPhase('showing');
      } catch (err) {
        if (generationRef.current !== generation) return;
        setError(describe(err));
        setPhase('error');
      }
    });
  }, []);

  useEffect(() => { request(); }, [request]);

  // QR of the link URL, drawn once per code.
  useEffect(() => {
    if (phase !== 'showing' || !pair || !canvasRef.current) return;
    try {
      void QRCode.toCanvas(canvasRef.current, pair.link_url, {
        width: 220, margin: 1, errorCorrectionLevel: 'M',
        color: { dark: '#1b2129', light: '#fbfcfd' },
      }).catch(() => { /* canvas unavailable: the text code still works */ });
    } catch {
      /* same */
    }
  }, [phase, pair]);

  // Countdown clock + poll loop.
  useEffect(() => {
    if (phase !== 'showing' || !pair) return;
    let stopped = false;
    let inFlight = false;
    const deadline = new Date(pair.expires_at).getTime();
    const tick = async () => {
      if (stopped || inFlight) return;
      if (Date.now() >= deadline) {
        setPhase('expired');
        return;
      }
      if (document.visibilityState === 'hidden') return;
      inFlight = true;
      try {
        const result = await pollPair(pair.code, pair.poll_token);
        if (stopped) return;
        if (result.status === 'approved' && result.session) {
          stopped = true;
          onApproved(result.session);
        } else if (result.status === 'denied') {
          setPhase('denied');
        } else if (result.status === 'expired') {
          setPhase('expired');
        }
      } catch {
        /* transient — next tick retries */
      } finally {
        inFlight = false;
      }
    };
    const poll = setInterval(() => void tick(), POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stopped = true;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [phase, pair, onApproved]);

  if (phase === 'requesting') {
    return <div className="pair-panel"><p className="form-hint">Getting a code…</p></div>;
  }
  if (phase === 'error') {
    return (
      <div className="pair-panel">
        <p className="form-error" role="alert">Couldn&apos;t get a code ({error}). Try again.</p>
        <button type="button" className="btn" onClick={() => void request()}>Try again</button>
      </div>
    );
  }
  if (phase === 'denied' || phase === 'expired') {
    return (
      <div className="pair-panel">
        <p className="form-error" role="alert">
          {phase === 'denied' ? 'Sign-in was declined on the phone.' : 'This code expired.'}
        </p>
        <button type="button" className="btn" onClick={() => void request()}>Get a new code</button>
      </div>
    );
  }

  const remaining = Math.max(0, Math.floor((new Date(pair!.expires_at).getTime() - now) / 1000));
  const mm = Math.floor(remaining / 60);
  const ss = String(remaining % 60).padStart(2, '0');
  return (
    <div className="pair-panel">
      <canvas ref={canvasRef} className="pair-qr" width={220} height={220}
              aria-label="QR code to link this kiosk" />
      <div className="pair-code" aria-label="Link code">{formatCode(pair!.code)}</div>
      <p className="form-hint">
        Scan the code, or open <b>{portalHost(portalUrl())}/link</b> on your phone and enter it.
      </p>
      <p className="pair-countdown">Expires in {mm}:{ss}</p>
      <button type="button" className="btn-link" onClick={() => void request()}>Get a new code</button>
    </div>
  );
}
