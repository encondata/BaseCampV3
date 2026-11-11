/** Exit the kiosk: the PIN (csg, the same on every Linux laptop: a barrier,
 *  not a secret) tells the laptop's kiosk helper to stop the watcher, close
 *  Chrome and put the desktop shortcuts back. The helper checks the PIN;
 *  this form only sends it. */

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { exitKiosk, HelperError } from '../../lib/hostHelper';

/** How long "Closing the kiosk…" waits for Chrome to go before it gives the
 *  controls back. */
export const CLOSE_TIMEOUT_MS = 10_000;

const TABBABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function errorCopy(err: unknown): string {
  const code = err instanceof HelperError ? err.code : '';
  if (code === 'wrong_pin') return "That PIN isn't right.";
  // The helper restarted with a new token: retrying can't work. Closing the
  // window does, because the watcher reopens Chrome on the waiting page,
  // which hands over the fresh token.
  if (code === 'forbidden') return 'This kiosk window is out of date. Close it with Alt+F4 and it will reopen.';
  return "Couldn't reach the kiosk helper on this laptop. Try again.";
}

export default function PinPadModal({ onClose }: { onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const pinRef = useRef<HTMLInputElement>(null);
  const locked = busy || done;

  // Chrome should close within a moment of the helper's 200. If it doesn't,
  // give the controls back rather than leave a dead dialog on screen.
  useEffect(() => {
    if (!done) return undefined;
    const timer = window.setTimeout(() => {
      inFlight.current = false;
      setDone(false);
      setPin('');
      setError("The kiosk didn't close. Try again.");
      pinRef.current?.focus();
    }, CLOSE_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [done]);

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
        setError(errorCopy(err));
        // Submitting with the button leaves focus on it while it's disabled;
        // the retry belongs in the field, without a click.
        pinRef.current?.focus();
      },
    );
  };

  // Tab and Shift+Tab cycle inside the dialog.
  const trapTab = (e: ReactKeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Tab') return;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(TABBABLE));
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const at = items.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && at <= 0) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && (at === -1 || at === items.length - 1)) { e.preventDefault(); first.focus(); }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !locked) onClose(); }}>
      <form className="modal-card reports-modal-card rgm-card confirm-card" role="dialog" aria-modal="true"
            aria-label="Exit the kiosk" onSubmit={submit} onKeyDown={trapTab} noValidate>
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
            {/* "new-password": no "Save password?" offer on a shared station.
                readOnly, not disabled, while busy: a disabled field drops
                focus, and the Scan page would pull it to its scan box. */}
            <input id="kiosk-exit-pin" ref={pinRef} type="password" autoFocus autoComplete="new-password"
                   spellCheck={false} maxLength={32} value={pin} readOnly={locked} aria-disabled={locked}
                   onChange={(e) => { if (!locked) setPin(e.target.value); }} />
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
