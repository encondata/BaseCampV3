/** Exit the kiosk: the PIN (csg, the same on every Linux laptop: a barrier,
 *  not a secret) tells the laptop's kiosk helper to stop the watcher, close
 *  Chrome and put the desktop shortcuts back. The helper checks the PIN;
 *  this form only sends it. */

import { useEffect, useRef, useState, type FormEvent } from 'react';

import { exitKiosk, HelperError } from '../../lib/hostHelper';

export default function PinPadModal({ onClose }: { onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const locked = busy || done;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !locked) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [locked, onClose]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (inFlight.current || !pin) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    exitKiosk(pin).then(
      () => { setBusy(false); setDone(true); },
      (err: unknown) => {
        inFlight.current = false;
        setBusy(false);
        setPin('');
        setError(err instanceof HelperError && err.code === 'wrong_pin'
          ? "That PIN isn't right."
          : "Couldn't reach the kiosk helper on this laptop. Try again.");
      },
    );
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <form className="modal-card reports-modal-card rgm-card confirm-card" role="dialog" aria-modal="true"
            aria-label="Exit the kiosk" onSubmit={submit} noValidate>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">This laptop</div>
            <h3>Exit the kiosk</h3>
            <p className="page-hint">
              Enter the PIN to close the kiosk and go to the desktop. Start Kiosk on the desktop opens it again.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={locked}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="pf-form">
            <label htmlFor="kiosk-exit-pin">PIN</label>
            {/* "new-password": no "Save password?" offer on a shared station */}
            <input id="kiosk-exit-pin" type="password" autoFocus autoComplete="new-password" spellCheck={false}
                   maxLength={32} value={pin} disabled={locked} onChange={(e) => setPin(e.target.value)} />
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          {done && <p className="form-notice" role="status">Closing the kiosk…</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="mini-btn" disabled={locked} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-solid" disabled={locked || !pin}>Exit kiosk</button>
        </div>
      </form>
    </div>
  );
}
