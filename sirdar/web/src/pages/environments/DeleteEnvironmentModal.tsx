/** Delete environment: a "teardown" deployment that stops the stacks and
 *  deletes the data and folder on the host (step 15), removes the proxy
 *  hosts, certificates and DNS records Sirdar created (16, 17), leaves the
 *  claimed ones in place, then removes the environment from Sirdar. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import {
  deployErrorText, startDeployment, type Deployment, type Environment, type ManagedRecordRef,
} from '../../lib/sirdarApi';

type Attempt = { confirm: string };
const NOUN: Record<ManagedRecordRef['kind'], string> = {
  dns_record: 'DNS record', proxy_host: 'Proxy host', certificate: 'Certificate',
};
const line = (r: ManagedRecordRef) => `${NOUN[r.kind]} ${r.name}`;

export default function DeleteEnvironmentModal({ env, onStarted, onClose }: {
  env: Environment; onStarted: (dep: Deployment) => void; onClose: () => void;
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
    canTrust: can('deploy', 'change'), trustLabel: 'Trust and delete',
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
      onStarted(await startDeployment(env.name, { mode: 'teardown', confirm_name: attempt.confirm }));
    } catch (e) {
      if (!hostKey.handle(e, env.target, attempt)) setError(deployErrorText(e, "Couldn't start deleting it."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const made = env.managed_records.filter((r) => r.origin === 'created');
  const claimed = env.managed_records.filter((r) => r.origin === 'claimed');
  // The API's teardown needs deploy:add and deploy:change.
  const ready = confirm === env.name && !busy && can('deploy', 'add') && can('deploy', 'change');

  return (
    <>
      <div className="modal-scrim" ref={scrimRef} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal-card reports-modal-card rgm-card sirdar-deploy-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-delete-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Settings</div>
              <h3 id="sirdar-delete-title">Delete {env.name}</h3>
              {env.target_kind === 'proxmox' && env.vm ? (
                <p className="page-hint">
                  Destroys the VM {env.vm.name}{env.vm.vmid !== null ? ` (VM ${env.vm.vmid})` : ''} on Proxmox with
                  everything on it: the database, files, backups and VM snapshots. Snapshots taken from {env.name}
                  {' '}are kept in Sirdar. Then Sirdar forgets the environment.
                </p>
              ) : (
                <p className="page-hint">
                  Stops every container of {env.name}, deletes its database and files, and removes the whole
                  {' '}{env.env_dir} folder from the host, backups included. Snapshots taken from {env.name} are kept,
                  and so are Docker images. Then Sirdar forgets the environment.
                </p>
              )}
            </div>
            <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                   strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
            </button>
          </div>
          <div className="modal-body pf-form sirdar-deploy-form">
            {made.length > 0 && (
              <div>
                <span className="field-label" id="delete-removes-label">Sirdar removes</span>
                <ul className="sirdar-plain-list" aria-labelledby="delete-removes-label">
                  {made.map((r) => <li key={`${r.kind}:${r.name}`}>{line(r)}</li>)}
                </ul>
              </div>
            )}
            {claimed.length > 0 && (
              <div>
                <span className="field-label" id="delete-stays-label">Left in place</span>
                <ul className="sirdar-plain-list" aria-labelledby="delete-stays-label">
                  {claimed.map((r) => <li key={`${r.kind}:${r.name}`}>{line(r)}</li>)}
                </ul>
                <p className="page-hint">Claimed: they were made by hand, so Sirdar never deletes them.</p>
              </div>
            )}
            {made.length === 0 && claimed.length === 0 && (
              <p className="page-hint">Sirdar manages no DNS records or proxy hosts for it.</p>
            )}
            <p className="page-hint">This can't be undone.</p>
            <div>
              <label className="field-label" htmlFor="delete-confirm">Type {env.name} to confirm</label>
              <input id="delete-confirm" ref={confirmInput} type="text" value={confirm} maxLength={64}
                     autoComplete="off" spellCheck={false} disabled={busy}
                     onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="btn-solid btn-danger" disabled={!ready}
                    onClick={() => void run({ confirm })}>
              {busy ? 'Starting…' : 'Delete environment'}
            </button>
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
