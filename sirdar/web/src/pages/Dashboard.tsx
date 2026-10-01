import { useEffect, useState } from 'react';

import { useAuth } from '@portal/auth/AuthContext';

import { listImportRuns, listUsers, type ImportRun, type UserRow } from '../lib/sirdarApi';

export default function Dashboard() {
  const { person, roles, can } = useAuth();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [lastRun, setLastRun] = useState<ImportRun | null | undefined>(undefined);

  useEffect(() => {
    if (!can('users', 'view')) return;
    listUsers().then(setUsers).catch(() => {});
    listImportRuns().then((r) => setLastRun(r[0] ?? null)).catch(() => {});
  }, [can]);

  const active = users?.filter((u) => !u.disabled_at).length;

  return (
    <div className="portal-page">
      <div className="eyebrow">Sirdar</div>
      <div className="dir-head">
        <h1>Dashboard</h1>
        <p>Build, install and manage ServerSherpa environments.</p>
      </div>
      <div className="sirdar-cards">
        <div className="sirdar-card">
          <h3>Signed in as</h3>
          <p>{person?.display_name}</p>
          <p className="page-hint">{roles.join(', ')}</p>
        </div>
        {users && (
          <div className="sirdar-card">
            <h3>Users</h3>
            <p>{active} active of {users.length}</p>
          </div>
        )}
        {lastRun !== undefined && (
          <div className="sirdar-card">
            <h3>Last import</h3>
            {lastRun
              ? <p>{lastRun.status === 'ok' ? 'Finished' : 'Failed'} · {new Date(lastRun.started_at).toLocaleString()}</p>
              : <p>Never run</p>}
          </div>
        )}
      </div>
    </div>
  );
}
