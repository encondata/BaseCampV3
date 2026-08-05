/** Access control — roles, groups, member overrides and the effective-access
 *  explorer. This frame loads the summary and lays out the tab shell; the
 *  tab bodies themselves (Roles/Groups/Members/Explorer) land in later tasks. */

import { useCallback, useEffect, useState } from 'react';

import { useAuth } from '../auth/AuthContext';
import ExplorerTab from '../components/access/ExplorerTab';
import GroupsTab from '../components/access/GroupsTab';
import MembersTab from '../components/access/MembersTab';
import RolesTab from '../components/access/RolesTab';
import { getAccessSummary, type AccessSummary } from '../lib/api';
import '../styles/directory.css'; /* .portal-shell tokens (surfaces, c-* palette) used by access.css */
import '../styles/profile.css';   /* .pf-form, .pf-error, .btn-solid */
import '../styles/settings.css';  /* .set-note */
import '../styles/access.css';

type Tab = 'roles' | 'groups' | 'members' | 'explorer';

const TABS: { key: Tab; label: string }[] = [
  { key: 'roles', label: 'Roles' },
  { key: 'groups', label: 'Groups' },
  { key: 'members', label: 'Members' },
  { key: 'explorer', label: 'Explorer' },
];

export default function Access() {
  const { can, maxRank, person } = useAuth();
  const canEdit = can('access', 'change');

  const [summary, setSummary] = useState<AccessSummary | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('roles');

  const load = useCallback(async () => {
    try {
      setSummary(await getAccessSummary());
    } catch {
      setError('Failed to load access summary.');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="portal-page">
      <div className="access-head">
        <div>
          <div className="eyebrow">System</div>
          <h1 className="page-title">Access control</h1>
          <p className="page-hint">Roles, groups, member permissions and effective access.</p>
        </div>
        {!canEdit && (
          <span className="ro-chip">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 strokeLinecap="round" strokeLinejoin="round">
              <rect x="5" y="11" width="14" height="9" rx="2" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            Read-only · admin required to edit
          </span>
        )}
      </div>

      {error && <div className="access-empty"><b>Cannot load access data</b>{error}</div>}

      {summary && (
        <>
          <div className="stat-strip">
            <div className="stat-tile">
              <div className="stat-label">Members</div>
              <div className="stat-value">{summary.stats.members}</div>
              <div className="stat-sub">with access</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Roles</div>
              <div className="stat-value">{summary.stats.roles}</div>
              <div className="stat-sub">defined</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Groups</div>
              <div className="stat-value">{summary.stats.groups}</div>
              <div className="stat-sub">gates {summary.stats.gated_resources} pages</div>
            </div>
            <div className="stat-tile">
              <div className="stat-label">Overrides</div>
              <div className="stat-value">{summary.stats.overrides}</div>
              <div className="stat-sub">active</div>
            </div>
          </div>

          <div className="subs-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key}
                      className={tab === t.key ? 'on' : ''}
                      onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>

          <div className="access-tab-panel">
            {tab === 'roles' && (
              <RolesTab summary={summary} canEdit={canEdit} maxRank={maxRank}
                        onChanged={load} />
            )}
            {tab === 'groups' && (
              <GroupsTab summary={summary} canEdit={canEdit}
                         onChanged={() => void load()} />
            )}
            {tab === 'members' && (
              <MembersTab summary={summary} canEdit={canEdit} maxRank={maxRank}
                          onChanged={() => void load()} />
            )}
            {tab === 'explorer' && person && (
              <ExplorerTab summary={summary} canEdit={canEdit} maxRank={maxRank}
                           selfId={person.id} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
