/** A VM environment's VM snapshots (read live from Proxmox or ESXi): the ones
 *  Sirdar took in step 0 of a deploy, each restorable with the typed-name
 *  gate unless a snapshot restore changed the sign-in keys since. */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import {
  deployErrorText, listVmSnapshots, type Deployment, type Environment, type VmSnapshot,
} from '../../lib/sirdarApi';

import { deploymentRunning, hostLabel, shortSha, when } from './labels';
import RestoreVmSnapshotModal from './RestoreVmSnapshotModal';

export default function VmSnapshots({ env, onStarted }: {
  env: Environment; onStarted: (dep: Deployment) => void;
}) {
  const { can } = useAuth();
  const [rows, setRows] = useState<VmSnapshot[] | null>(null);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState<VmSnapshot | null>(null);
  const seq = useRef(0);

  // Only the newest request's answer lands.
  const load = useCallback(() => {
    const n = ++seq.current;
    return listVmSnapshots(env.name)
      .then((r) => { if (n === seq.current) { setRows(r.snapshots); setError(''); } })
      .catch((e) => {
        if (n === seq.current) { setRows([]); setError(deployErrorText(e, "Couldn't list the VM snapshots.")); }
      });
  }, [env.name]);
  // A deploy that ends may add one (and prune the oldest).
  useEffect(() => { void load(); }, [load, env.status]);
  useEffect(() => () => { seq.current += 1; }, []);

  const running = deploymentRunning(env);
  const mayRestore = can('deploy', 'add') && can('deploy', 'change');
  return (
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>VM snapshots</h2>
        <button type="button" className="mini-btn" onClick={() => void load()}>Refresh</button>
      </div>
      <p className="page-hint">
        Step 0 of each Update, Reset, Restore backup and Roll back snapshots the whole VM before anything changes;
        the newest {env.vm?.keep_snapshots ?? 3} stay on {hostLabel(env)}. Restoring one puts the VM back: database, files and
        backups.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!(error && (rows ?? []).length === 0) && <DataTable
        ariaLabel="VM snapshots"
        columns={[
          { key: 'name', label: 'Snapshot', mono: true }, { key: 'when', label: 'Taken', mono: true },
          { key: 'sha', label: 'Commit', mono: true }, { key: 'act', label: '', align: 'right' },
        ]}
        rows={(rows ?? []).map((s) => ({
          key: s.name,
          cells: [
            s.name, when(s.taken_at), shortSha(s.sha),
            !s.restorable
              ? <span className="sirdar-backup-blocked">{s.reason ?? "Can't be restored."}</span>
              : mayRestore
              ? <button type="button" className="mini-btn" aria-label={`Restore ${s.name}`} disabled={running}
                        title={running ? 'A deployment is running.' : undefined}
                        onClick={() => setRestoring(s)}>Restore</button>
              : '',
          ],
        }))}
        emptyText={rows === null ? 'Loading…' : 'No VM snapshots yet. The next Update of a deployed VM takes one.'}
      />}
      {restoring && (
        <RestoreVmSnapshotModal env={env} snapshot={restoring} onClose={() => setRestoring(null)}
                                onStarted={(dep) => { setRestoring(null); onStarted(dep); }} />
      )}
    </section>
  );
}
