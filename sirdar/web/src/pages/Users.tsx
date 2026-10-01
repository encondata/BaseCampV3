import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';

import ImportSummaryModal from '../components/ImportSummaryModal';
import {
  errorText, getImportSource, listUsers, runImport, type ImportRun, type UserRow,
} from '../lib/sirdarApi';

function fmt(ts: string | null): string {
  return ts ? new Date(ts).toLocaleString() : '—';
}

function status(u: UserRow): string {
  if (u.disabled_at) return u.disabled_reason === 'not_eligible' ? 'Disabled (no longer eligible)' : 'Disabled';
  return 'Active';
}

export default function Users() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [configured, setConfigured] = useState(true);
  const [sourceFailed, setSourceFailed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [run, setRun] = useState<ImportRun | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    listUsers().then(setUsers).catch((e) => setError(errorText(e, "Couldn't load users.")));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const canAdd = can('users', 'add');
  useEffect(() => {
    if (!canAdd) return;
    getImportSource()
      .then((s) => { setConfigured(s.configured); setSourceFailed(false); })
      .catch(() => { setConfigured(false); setSourceFailed(true); });
  }, [canAdd]);

  const doImport = async () => {
    setImporting(true);
    setError('');
    try {
      setRun(await runImport());
      load();
    } catch (e) {
      setError(errorText(e, 'The import failed.'));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="portal-page">
      <div className="eyebrow">Administration</div>
      <div className="dir-head">
        <h1>Users</h1>
        <p>Everyone who can sign in to Sirdar: portal admins (copied by the import) and local users.</p>
      </div>
      <div className="dir-toolbar">
        {canAdd && (
          <button type="button" className="btn-solid" onClick={doImport}
                  disabled={importing || !configured}>
            {importing ? 'Importing…' : 'Import from portal'}
          </button>
        )}
        {!configured && (
          <span className="page-hint">
            {sourceFailed ? "Couldn't check the portal database." : 'Portal database not configured.'}
          </span>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {users && (
        <DataTable
          ariaLabel="Users"
          columns={[
            { key: 'name', label: 'Name' }, { key: 'email', label: 'Email', mono: true },
            { key: 'roles', label: 'Roles' }, { key: 'source', label: 'Source' },
            { key: 'totp', label: '2FA' }, { key: 'last', label: 'Last sign-in' },
            { key: 'status', label: 'Status' },
          ]}
          rows={users.map((u) => ({
            key: u.person_id,
            cells: [
              <button type="button" className="link-btn" onClick={() => navigate(`/admin/users/${u.person_id}`)}>
                {u.display_name}
              </button>,
              u.email, u.roles.join(', ') || '—', u.source === 'portal' ? 'Portal' : 'Local',
              u.totp_enrolled ? 'On' : u.totp_required ? 'Required — not set up' : 'Off',
              fmt(u.last_login_at), status(u),
            ],
          }))}
          emptyText="No users yet. Import from the portal or run sirdar create-admin."
        />
      )}
      {run && <ImportSummaryModal run={run} onClose={() => setRun(null)} />}
    </div>
  );
}
