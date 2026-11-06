/** Clean up after a failed first deploy (the Deployments view's Clean up section).
 *  keep: a "cleanup" deployment removes what the attempt built and keeps the
 *  environment and its settings; otherwise a "teardown" removes everything,
 *  the environment too. A never-deployed environment has no data, so there is
 *  no snapshot choice. Production keeps Delete's rules: retiring, no live slot,
 *  and "delete production <name>" typed as well. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import { deployErrorText, startDeployment, type Deployment, type Environment } from '../../lib/sirdarApi';

import { onDo } from './labels';

/** phrase: production's "delete production <name>". */
type Attempt = { confirm: string; phrase: string | null };

export default function CleanupModal({ env, keep, onStarted, onClose }: {
  env: Environment; keep: boolean; onStarted: (dep: Deployment) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  const [confirm, setConfirm] = useState('');
  const production = onDo(env) && env.type === 'production';
  const [phrase, setPhrase] = useState('');
  const phraseWanted = `delete production ${env.name}`;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const confirmInput = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hostKey = useHostKeyTrust<Attempt>({
    canTrust: can('deploy', 'change'), trustLabel: keep ? 'Trust and clean up' : 'Trust and remove',
    onTrusted: (attempt) => { void run(attempt); }, onProblem: setError,
  });
  const hostKeyOpen = useRef(false);
  hostKeyOpen.current = hostKey.open;
  const scrimRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => { scrimRef.current?.toggleAttribute('inert', hostKey.open); }, [hostKey.open]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    confirmInput.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current && !hostKeyOpen.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  // Replays exactly the attempt that hit the host-key prompt. No snapshot is sent: never deployed, nothing to save.
  const run = async (attempt: Attempt) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      onStarted(await startDeployment(env.name, {
        mode: keep ? 'cleanup' : 'teardown', confirm_name: attempt.confirm,
        ...(attempt.phrase ? { confirm_production: attempt.phrase } : {}),
      }));
    } catch (e) {
      if (!hostKey.handle(e, env.target, attempt)) {
        setError(deployErrorText(e, keep ? "Couldn't start the clean-up." : "Couldn't start removing it."));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // Production goes only once it is retiring and no slot is live.
  const blocked = production && (!env.retiring || env.active_slot !== null);
  // Both modes need deploy:add and deploy:change.
  const ready = confirm === env.name && !busy && can('deploy', 'add') && can('deploy', 'change') && !blocked
    && (!production || phrase === phraseWanted);
  const label = keep ? 'Clean up' : 'Remove everything';

  return (
    <>
      <div className="modal-scrim" ref={scrimRef} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal-card reports-modal-card rgm-card sirdar-deploy-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-cleanup-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Deployments</div>
              <h3 id="sirdar-cleanup-title">{keep ? `Clean up ${env.name}` : `Remove ${env.name}`}</h3>
              {keep ? (
                <p className="page-hint">
                  Removes the servers, VMs, cloud resources, proxy hosts and DNS records this attempt made. The
                  {' '}environment and its settings stay, and Deploy starts fresh.
                </p>
              ) : (
                <p className="page-hint">
                  Removes the servers, VMs, cloud resources, proxy hosts and DNS records this attempt made, and deletes
                  {' '}the environment from Sirdar.
                </p>
              )}
            </div>
            <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="modal-body pf-form sirdar-deploy-form">
            <p className="page-hint">This can't be undone.</p>
            {production && !env.retiring && (
              <p className="form-error">Mark this production environment retiring first (Settings).</p>
            )}
            {production && env.retiring && env.active_slot !== null && (
              <p className="form-error">Deactivate it first (Overview › DigitalOcean): a live slot can't be deleted.</p>
            )}
            <div>
              <label className="field-label" htmlFor="cleanup-confirm">Type {env.name} to confirm</label>
              <input id="cleanup-confirm" ref={confirmInput} type="text" value={confirm} maxLength={64}
                     autoComplete="off" spellCheck={false} disabled={busy}
                     onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {production && !blocked && (
              <div>
                <label className="field-label" htmlFor="cleanup-phrase">Type {phraseWanted} to confirm</label>
                <input id="cleanup-phrase" type="text" value={phrase} maxLength={100} autoComplete="off"
                       spellCheck={false} disabled={busy} onChange={(e) => setPhrase(e.target.value)} />
              </div>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className={keep ? 'btn-solid' : 'btn-solid btn-danger'} disabled={!ready}
                    onClick={() => void run({ confirm, phrase: production ? phrase : null })}>
              {busy ? 'Starting…' : label}
            </button>
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
