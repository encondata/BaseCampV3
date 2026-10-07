/** Delete environment: a "teardown" deployment that stops the stacks and
 *  deletes the data and folder on the host (step 15), removes the proxy
 *  hosts, certificates and DNS records Sirdar created (16, 17), leaves the
 *  claimed ones in place, then removes the environment from Sirdar.
 *  DigitalOcean: removes everything Sirdar built there, after a snapshot
 *  (optional, except for production); production must be retiring and
 *  deactivated, and needs "delete production <name>" typed as well.
 *  LAN Blue/Green: destroys the data VM and both app VMs, after an optional snapshot. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import { Switch } from '@portal/components/Switch';

import { useHostKeyTrust } from '../../components/useHostKeyTrust';
import {
  deployErrorText, startDeployment, type Deployment, type Environment, type ManagedRecordRef,
} from '../../lib/sirdarApi';

import { DO_RESOURCE_LABEL, hostLabel, onBluegreen, onDo, onVmHost, vmRef, vmStage } from './labels';

/** snapshot: null when the environment doesn't choose; phrase: production's "delete production <name>". */
type Attempt = { confirm: string; snapshot: boolean | null; phrase: string | null };
const NOUN: Record<ManagedRecordRef['kind'], string> = {
  dns_record: 'DNS record', proxy_host: 'Proxy host', certificate: 'Certificate',
};
const line = (r: ManagedRecordRef) => `${NOUN[r.kind]} ${r.name}`;

export default function DeleteEnvironmentModal({ env, onStarted, onClose }: {
  env: Environment; onStarted: (dep: Deployment) => void; onClose: () => void;
}) {
  const { can } = useAuth();
  const [confirm, setConfirm] = useState('');
  const cloud = onDo(env);
  const bluegreen = onBluegreen(env);
  // DigitalOcean and Blue/Green save a snapshot of the shared data first (optional, except for production).
  const snapshots = cloud || bluegreen;
  const production = cloud && env.type === 'production';
  const deployed = env.current_sha !== null;
  const [snapshot, setSnapshot] = useState(true);
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
      onStarted(await startDeployment(env.name, {
        mode: 'teardown', confirm_name: attempt.confirm,
        ...(attempt.snapshot === false ? { snapshot: false } : {}),
        ...(attempt.phrase ? { confirm_production: attempt.phrase } : {}),
      }));
    } catch (e) {
      if (!hostKey.handle(e, env.target, attempt)) setError(deployErrorText(e, "Couldn't start deleting it."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const made = env.managed_records.filter((r) => r.origin === 'created');
  const claimed = env.managed_records.filter((r) => r.origin === 'claimed');
  const doLines = cloud ? (env.do?.resources ?? []).map((r) => `${DO_RESOURCE_LABEL[r.kind] ?? r.kind} ${r.name}`)
    : bluegreen ? env.machines.map((m) => `VM ${m.name}`) : [];
  // Production goes only once it is retiring and no slot is live.
  const blocked = production && (!env.retiring || env.active_slot !== null);
  // The API's teardown needs deploy:add and deploy:change.
  const ready = confirm === env.name && !busy && can('deploy', 'add') && can('deploy', 'change') && !blocked
    && (!production || phrase === phraseWanted);

  return (
    <>
      <div className="modal-scrim" ref={scrimRef} onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="modal-card reports-modal-card rgm-card sirdar-deploy-card" role="dialog" aria-modal="true"
             aria-labelledby="sirdar-delete-title">
          <div className="modal-head">
            <div className="rgm-head-text">
              <div className="eyebrow">Settings</div>
              <h3 id="sirdar-delete-title">Delete {env.name}</h3>
              {cloud ? (
                <p className="page-hint">
                  Removes everything Sirdar built for {env.name} on DigitalOcean (droplets, the managed database, the
                  {' '}bucket and its files, the load balancer, the certificate and the firewall), after its DNS
                  {' '}records. Snapshots taken from {env.name} are kept in Sirdar. Then Sirdar forgets the environment.
                </p>
              ) : bluegreen ? (
                <p className="page-hint">
                  Destroys the data VM and both app VMs on {hostLabel(env)} with everything on them: the database,
                  {' '}files and backups. Then removes the proxy hosts and DNS records Sirdar made. Snapshots taken from
                  {' '}{env.name} are kept in Sirdar. Then Sirdar forgets the environment.
                </p>
              ) : onVmHost(env) && env.vm && vmStage(env.vm) === 'none' ? (
                <p className="page-hint">
                  No VM was created yet; nothing on {hostLabel(env)} is removed. Snapshots taken from {env.name} are kept in
                  {' '}Sirdar. Then Sirdar forgets the environment.
                </p>
              ) : onVmHost(env) && env.vm && vmStage(env.vm) === 'partial' ? (
                <p className="page-hint">
                  Removes the partly built VM {env.vm.name}{vmRef(env.vm) ? ` (${vmRef(env.vm)})` : ''} if
                  {' '}{hostLabel(env)} has it. Snapshots taken
                  {' '}from {env.name} are kept in Sirdar. Then Sirdar forgets the environment.
                </p>
              ) : onVmHost(env) && env.vm ? (
                <p className="page-hint">
                  Destroys the VM {env.vm.name}{vmRef(env.vm) ? ` (${vmRef(env.vm)})` : ''} on {hostLabel(env)} with
                  {' '}everything on it: the database, files, backups and VM snapshots. Snapshots taken from {env.name}
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
            {(made.length > 0 || doLines.length > 0) && (
              <div>
                <span className="field-label" id="delete-removes-label">Sirdar removes</span>
                <ul className="sirdar-plain-list" aria-labelledby="delete-removes-label">
                  {made.map((r) => <li key={`${r.kind}:${r.name}`}>{line(r)}</li>)}
                  {doLines.map((l) => <li key={l}>{l}</li>)}
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
            {!snapshots && made.length === 0 && claimed.length === 0 && (
              <p className="page-hint">Sirdar manages no DNS records or proxy hosts for it.</p>
            )}
            {snapshots && (production && deployed ? (
              <p className="page-hint">A snapshot is always saved first for production.</p>
            ) : deployed ? (
              <div className="sirdar-switch-row">
                <Switch checked={snapshot} disabled={busy} onChange={setSnapshot} label="Save a snapshot first" />
                <span aria-hidden="true">Save a snapshot first (named {env.name}-before-delete-…, kept in Sirdar)</span>
              </div>
            ) : (
              <p className="page-hint">Nothing was deployed, so there is no snapshot to save.</p>
            ))}
            <p className="page-hint">This can't be undone.</p>
            {production && !env.retiring && (
              <p className="form-error">Mark this production environment retiring first (Settings).</p>
            )}
            {production && env.retiring && env.active_slot !== null && (
              <p className="form-error">Deactivate it first (Overview › DigitalOcean): a live slot can't be deleted.</p>
            )}
            <div>
              <label className="field-label" htmlFor="delete-confirm">Type {env.name} to confirm</label>
              <input id="delete-confirm" ref={confirmInput} type="text" value={confirm} maxLength={64}
                     autoComplete="off" spellCheck={false} disabled={busy}
                     onChange={(e) => setConfirm(e.target.value)} />
            </div>
            {production && !blocked && (
              <div>
                <label className="field-label" htmlFor="delete-phrase">Type {phraseWanted} to confirm</label>
                <input id="delete-phrase" type="text" value={phrase} maxLength={100} autoComplete="off"
                       spellCheck={false} disabled={busy} onChange={(e) => setPhrase(e.target.value)} />
              </div>
            )}
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
            <button type="button" className="btn-solid btn-danger" disabled={!ready}
                    onClick={() => void run({
                      confirm, snapshot: snapshots && !production && deployed ? snapshot : null,
                      phrase: production ? phrase : null,
                    })}>
              {busy ? 'Starting…' : 'Delete environment'}
            </button>
          </div>
        </div>
      </div>
      {hostKey.modal}
    </>
  );
}
