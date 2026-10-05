/** Restore one of a VM environment's VM snapshots: a "Restore VM
 *  snapshot" deployment rolls the whole VM back (database, files, backups)
 *  and the running commit with it. Typed-name gate. */
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import {
  deployErrorText, startDeployment, type Deployment, type Environment, type VmSnapshot,
} from '../../lib/sirdarApi';

import { shortSha, when } from './labels';

export default function RestoreVmSnapshotModal({ env, snapshot, onStarted, onClose }: {
  env: Environment; snapshot: VmSnapshot; onStarted: (dep: Deployment) => void; onClose: () => void;
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

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    confirmInput.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const run = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      onStarted(await startDeployment(env.name, {
        mode: 'vm_restore', vm_snapshot: snapshot.name, confirm_name: confirm }));
    } catch (e) {
      setError(deployErrorText(e, "Couldn't start the restore."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const ready = confirm === env.name && !busy && can('deploy', 'add') && can('deploy', 'change');

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-deploy-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-vmrestore-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Backups</div>
            <h3 id="sirdar-vmrestore-title">Restore VM snapshot</h3>
            <p className="page-hint">
              Rolls {env.vm?.name ?? env.name}'s whole VM back to {snapshot.name} and starts it again. The running
              commit goes back to the one the snapshot holds.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-deploy-form">
          <dl className="sirdar-kv">
            <dt>Snapshot</dt><dd className="mono">{snapshot.name}</dd>
            <dt>Taken</dt><dd className="mono">{when(snapshot.taken_at)}</dd>
            <dt>Commit</dt><dd className="mono">{shortSha(snapshot.sha)}</dd>
          </dl>
          <p className="page-hint">
            Everything on the VM since then is lost: database writes, uploaded files and newer backups. This can't be
            undone.
          </p>
          <div>
            <label className="field-label" htmlFor="vmsnap-confirm">Type {env.name} to confirm</label>
            <input id="vmsnap-confirm" ref={confirmInput} type="text" value={confirm} maxLength={64}
                   autoComplete="off" spellCheck={false} disabled={busy}
                   onChange={(e) => setConfirm(e.target.value)} />
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn-solid" disabled={!ready} onClick={() => void run()}>
            {busy ? 'Starting…' : 'Restore VM snapshot'}
          </button>
        </div>
      </div>
    </div>
  );
}
