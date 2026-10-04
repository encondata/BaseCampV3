/** Restore one of the environment's pre-deploy dumps: a "Restore backup"
 *  deployment (start the data services, put the dump back into an empty
 *  database, migrate and start the app). Uploaded files are not rolled back. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import { deployErrorText, startDeployment, type Backup, type Deployment, type Environment } from '../../lib/sirdarApi';

import { formatBytes, when } from './labels';

type Attempt = { backup: string; confirm: string };

export default function RestoreBackupModal({ env, backup, onStarted, onClose }: {
  env: Environment; backup: Backup; onStarted: (dep: Deployment) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const confirmInput = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const hostKey = useHostKeyTrust<Attempt>({
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and restore',
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

  // Replays exactly the attempt that hit the host-key prompt.
  const run = async (attempt: Attempt) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      onStarted(await startDeployment(env.name, {
        mode: 'restore_dump', backup: attempt.backup, confirm_name: attempt.confirm }));
    } catch (e) {
      if (!hostKey.handle(e, env.target, attempt)) setError(deployErrorText(e, "Couldn't start the restore."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const ready = confirm === env.name && !busy && can('deploy', 'change');

  return (
    <>
      <div className="modal-scrim" ref={scrimRef} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal-card reports-modal-card rgm-card sirdar-deploy-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-restore-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Backups</div>
              <h3 id="sirdar-restore-title">Restore backup</h3>
              <p className="page-hint">
                Puts {env.name}'s database back to {backup.name}, then migrates it to the running commit and starts
                the app again.
              </p>
            </div>
            <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="modal-body pf-form sirdar-deploy-form">
            <dl className="sirdar-kv">
              <dt>Backup</dt><dd className="mono">{backup.name}</dd>
              <dt>Taken</dt><dd className="mono">{when(backup.modified_at)}</dd>
              <dt>Size</dt><dd>{formatBytes(backup.size_bytes)}</dd>
            </dl>
            <p className="page-hint">
              Everything written to the database since this backup is lost. Uploaded files are not rolled back: files
              added since stay, and files deleted since stay deleted. This can't be undone.
            </p>
            <div>
              <label className="field-label" htmlFor="restore-confirm">Type {env.name} to confirm</label>
              <input id="restore-confirm" ref={confirmInput} type="text" value={confirm} maxLength={64}
                     autoComplete="off" spellCheck={false} disabled={busy}
                     onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="btn-solid" disabled={!ready}
                    onClick={() => void run({ backup: backup.name, confirm })}>
              {busy ? 'Starting…' : 'Restore backup'}
            </button>
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
