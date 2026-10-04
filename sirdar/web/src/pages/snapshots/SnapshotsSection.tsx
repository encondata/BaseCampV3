/** The Snapshots section on /deploy: every snapshot, Upload, Take snapshot
 *  and Delete. A snapshot being taken links to its job and the list reloads
 *  until it ends. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import {
  deleteSnapshot, errorText, listEnvironments, listSnapshots, type Environment, type Snapshot,
} from '../../lib/sirdarApi';
import { SNAPSHOT_STATUS, StatusChip, formatBytes, when } from '../environments/labels';

import TakeSnapshotModal from './TakeSnapshotModal';
import UploadSnapshotModal from './UploadSnapshotModal';

/** While a snapshot is being taken the list reloads this often. */
export const SNAPSHOTS_POLL_MS = 5000;

export default function SnapshotsSection() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [rows, setRows] = useState<Snapshot[] | null>(null);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [taking, setTaking] = useState<Environment[] | null>(null);
  const seq = useRef(0);

  // Only the newest request's answer lands; nothing lands after unmount.
  const load = useCallback(() => {
    const n = ++seq.current;
    return listSnapshots()
      .then((r) => { if (n === seq.current) { setRows(r.snapshots); setError(''); } })
      .catch((e) => { if (n === seq.current) setError(errorText(e, "Couldn't load snapshots.")); });
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => () => { seq.current += 1; }, []);
  const pending = !!rows?.some((s) => s.status === 'pending');
  useEffect(() => {
    if (!pending) return undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(() => { void load().finally(() => { if (live) schedule(); }); }, SNAPSHOTS_POLL_MS);
    };
    schedule();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [pending, load]);

  const openTake = async () => {
    try {
      const r = await listEnvironments();
      setTaking(r.environments.filter((e) => e.current_sha !== null));
    } catch (e) { setError(errorText(e, "Couldn't load environments.")); }
  };

  const remove = async (s: Snapshot) => {
    if (!window.confirm(`Delete the snapshot ${s.name}? Its bundle is removed from Sirdar. This can't be undone.`)) return;
    try {
      await deleteSnapshot(s.id);
      await load();
    } catch (e) { setError(errorText(e, "Couldn't delete that snapshot.")); }
  };

  const status = (s: Snapshot) => (s.status === 'pending' && s.deployment_id
    ? <><StatusChip map={SNAPSHOT_STATUS} status={s.status} />{' '}
        <Link to={`/deploy/environments/${encodeURIComponent(s.source)}?deployment=${encodeURIComponent(s.deployment_id)}`}>
          View the job</Link></>
    : <StatusChip map={SNAPSHOT_STATUS} status={s.status} />);

  return (
    <section className="sirdar-section">
      <div className="sirdar-section-head">
        <h2>Snapshots</h2>
        {can('deploy', 'add') && (
          <div className="sirdar-target-actions">
            <button type="button" className="btn-ghost" onClick={() => void openTake()}>Take snapshot</button>
            <button type="button" className="btn-solid" onClick={() => setUploading(true)}>Upload</button>
          </div>
        )}
      </div>
      <p className="page-hint">
        A snapshot holds an environment's database, its files and the keys its users sign in with. New
        environments and Reset data can start from one.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <DataTable
        ariaLabel="Snapshots"
        columns={[
          { key: 'name', label: 'Name' }, { key: 'source', label: 'Source' }, { key: 'created', label: 'Created', mono: true },
          { key: 'rev', label: 'Migration', mono: true }, { key: 'size', label: 'Size' }, { key: 'objects', label: 'Files' },
          { key: 'status', label: 'Status' }, { key: 'act', label: '', align: 'right' },
        ]}
        rows={(rows ?? []).map((s) => ({
          key: s.id,
          cells: [
            <><b className="cell-top">{s.name}</b>{s.notes && <div className="cell-sub">{s.notes}</div>}</>,
            s.origin === 'upload' ? `Upload · ${s.source}` : s.source,
            when(s.created_at),
            s.alembic_revision ?? '—',
            formatBytes(s.size_bytes),
            s.object_count === null ? '—' : s.object_count.toLocaleString(),
            status(s),
            can('deploy', 'change') && s.status !== 'pending'
              ? <button type="button" className="mini-btn" aria-label={`Delete ${s.name}`}
                        onClick={() => void remove(s)}>Delete</button>
              : '',
          ],
        }))}
        emptyText={rows === null ? 'Loading…' : 'No snapshots yet.'}
      />
      {uploading && (
        <UploadSnapshotModal onUploaded={() => { setUploading(false); void load(); }}
                             onClose={() => setUploading(false)} />
      )}
      {taking && (
        <TakeSnapshotModal envs={taking} onClose={() => setTaking(null)}
                           onStarted={({ deployment }) => {
                             setTaking(null);
                             navigate(`/deploy/environments/${encodeURIComponent(deployment.environment)}`
                                      + `?deployment=${encodeURIComponent(deployment.id)}`);
                           }} />
      )}
    </section>
  );
}
