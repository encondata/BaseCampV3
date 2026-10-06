/** Blue/Green: activate a slot (Sirdar smoke-tests it on its droplet, adds it
 *  to the load balancer next to the live one, checks it through the load
 *  balancer, then sends every request to it), or deactivate a retiring
 *  production. A deployment, so it shows up in Deployments and can be
 *  retried. Production needs its name typed. Used by the environment page
 *  and the dashboard spotlight. */
import { useEffect, useRef, useState } from 'react';

import { deployErrorText, activateSlot, type Deployment } from '../lib/sirdarApi';
import { slotTitle } from '../pages/environments/labels';

export default function ActivateModal({ envName, production, slot, fromSlot, version, onStarted, onClose }: {
  envName: string; production: boolean; slot: string | null; fromSlot: string | null; version: string | null;
  onStarted: (dep: Deployment) => void; onClose: () => void;
}) {
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const title = slot ? `Activate ${slotTitle(slot)}` : 'Deactivate';
  const ready = !production || confirm === envName;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    cardRef.current?.querySelector<HTMLElement>('.modal-body input, .modal-foot .btn-solid')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const go = async () => {
    if (busyRef.current || !ready) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      onStarted(await activateSlot(envName, slot, production ? confirm : undefined));
    } catch (err) {
      setError(deployErrorText(err, slot ? "Couldn't activate that slot." : "Couldn't deactivate it."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const from = fromSlot ? slotTitle(fromSlot) : null;
  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busyRef.current) onClose(); }}>
      <div ref={cardRef} className="modal-card reports-modal-card rgm-card sirdar-activate-card" role="dialog"
           aria-modal="true" aria-labelledby="sirdar-activate-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Blue/Green</div>
            <h3 id="sirdar-activate-title">{title}</h3>
            <p className="page-hint">
              {slot
                ? `Sirdar smoke-tests ${slotTitle(slot)}${version ? ` (${version})` : ''} on its droplet, adds it to the `
                  + `load balancer${from ? ` next to ${from}` : ''}, checks it through the load balancer, then sends every `
                  + 'request to it. For a minute or two both answer.'
                  + (from ? ` ${from} keeps running: activate it again to switch back.` : '')
                : `The load balancer stops sending traffic to ${from ?? 'any slot'}. Do this only once another environment `
                  + "serves production's names; then Delete can remove it."}
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form">
          {production && (
            <div>
              <label className="field-label" htmlFor="sirdar-activate-confirm">Type {envName} to confirm</label>
              <input id="sirdar-activate-confirm" type="text" value={confirm} maxLength={64} autoComplete="off"
                     spellCheck={false} disabled={busy} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className={slot ? 'btn-solid' : 'btn-solid btn-danger'} disabled={busy || !ready}
                  onClick={() => void go()}>{busy ? 'Starting…' : title}</button>
        </div>
      </div>
    </div>
  );
}
