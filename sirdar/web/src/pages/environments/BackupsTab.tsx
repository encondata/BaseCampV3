/** Backups tab: the environment's pre-deploy dumps (read from the target
 *  over SSH), each restorable with the typed-name gate. */
import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import { deployErrorText, listBackups, type Backup, type Deployment, type Environment } from '../../lib/sirdarApi';

import { formatBytes, when } from './labels';
import RestoreBackupModal from './RestoreBackupModal';

export default function BackupsTab({ env, onStarted }: {
  env: Environment; onStarted: (dep: Deployment) => void;
}) {
  const { can } = useAuth();
  const [rows, setRows] = useState<Backup[] | null>(null);
  const [error, setError] = useState('');
  const [restoring, setRestoring] = useState<Backup | null>(null);
  const seq = useRef(0);

  // Only the newest request's answer lands.
  const load = useCallback(() => {
    const n = ++seq.current;
    return listBackups(env.name)
      .then((r) => { if (n === seq.current) { setRows(r.backups); setError(''); } })
      .catch((e) => { if (n === seq.current) { setRows([]); setError(deployErrorText(e, "Couldn't list the backups.")); } });
  }, [env.name]);
  // A deploy that ends adds a dump (and rotates the oldest out).
  useEffect(() => { void load(); }, [load, env.status]);
  useEffect(() => () => { seq.current += 1; }, []);

  const running = env.status === 'deploying';
  const mayRestore = can('deploy', 'change');
  return (
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>Backups</h2>
        <button type="button" className="mini-btn" onClick={() => void load()}>Refresh</button>
      </div>
      <p className="page-hint">
        Each Update dumps the database before it migrates; the newest {env.keep_dumps} stay in {env.env_dir}/backups.
        Restoring one puts the database back. Uploaded files are not rolled back.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {!(error && (rows ?? []).length === 0) && <DataTable
        ariaLabel="Backups"
        columns={[
          { key: 'name', label: 'File', mono: true }, { key: 'when', label: 'Taken', mono: true },
          { key: 'size', label: 'Size' }, { key: 'act', label: '', align: 'right' },
        ]}
        rows={(rows ?? []).map((b) => ({
          key: b.name,
          cells: [
            b.name, when(b.modified_at), formatBytes(b.size_bytes),
            !b.restorable
              ? <span className="sirdar-backup-blocked">{b.reason ?? "Can't be restored."}</span>
              : mayRestore
              ? <button type="button" className="mini-btn" aria-label={`Restore ${b.name}`} disabled={running}
                        title={running ? 'A deployment is running.' : undefined}
                        onClick={() => setRestoring(b)}>Restore</button>
              : '',
          ],
        }))}
        emptyText={rows === null ? 'Loading…' : 'No backups yet. Each Update takes one before it migrates.'}
      />}
      {restoring && (
        <RestoreBackupModal env={env} backup={restoring} onClose={() => setRestoring(null)}
                            onStarted={(dep) => { setRestoring(null); onStarted(dep); }} />
      )}
    </section>
  );
}
