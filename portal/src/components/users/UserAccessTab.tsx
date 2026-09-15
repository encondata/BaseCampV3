/**
 * UserAccessTab — Roles / Access groups / Overrides / Effective permissions
 * for one user, each a real table with its own head button. The access
 * block is null below rank 60 (server rule): then only Roles renders and the
 * other three collapse into one note.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import DataTable from '../DataTable';
import { ManageRolesModal } from '../UserAdminModals';
import MatrixTable from '../access/MatrixTable';
import OverrideEditor from '../access/OverrideEditor';
import ManageGroupsModal from './ManageGroupsModal';
import { getAccessSummary, type AccessSummary, type UserDetailOut } from '../../lib/api';
import { longDate } from '../../lib/format';
import { ROLE_CLS, toManagedUser, toMemberItem } from '../../lib/users';

type Open = 'roles' | 'groups' | 'overrides' | null;

export default function UserAccessTab({ detail, canManageAccess, selfId, maxRank, onChanged }: {
  detail: UserDetailOut;
  canManageAccess: boolean;
  selfId: string | null;
  maxRank: number;
  onChanged: () => void;
}) {
  const [summary, setSummary] = useState<AccessSummary | null>(null);
  const [open, setOpen] = useState<Open>(null);
  const { roles, access } = detail;

  useEffect(() => {
    let cancelled = false;
    void getAccessSummary().then((s) => { if (!cancelled) setSummary(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const who = (p: { display_name: string } | null) => p?.display_name ?? '—';
  const scopeLine = access
    ? access.scope.global ? 'Sees: everything'
      : access.scope_orgs.length ? `Sees: ${access.scope_orgs.map((o) => o.name).join(', ')} only`
        : 'Sees: own records only'
    : '';

  return (
    <div className="ud-panels">
      <div className="panel">
        <div className="panel-head">
          <h3>Roles</h3>
          {canManageAccess && <button className="mini-btn" onClick={() => setOpen('roles')}>Manage roles</button>}
        </div>
        <div className="panel-body">
          <DataTable ariaLabel="Roles" emptyText="No roles granted"
            columns={[
              { key: 'role', label: 'Role' }, { key: 'label', label: 'Label' },
              { key: 'rank', label: 'Rank', align: 'right' }, { key: 'scope', label: 'Scope' },
              { key: 'by', label: 'Granted by' }, { key: 'at', label: 'Granted on', mono: true },
            ]}
            rows={roles.map((r) => ({
              key: `${r.role}:${r.org?.id ?? 'global'}`,
              cells: [
                <span key="role" className={`chip ${ROLE_CLS[r.role] ?? 'tag'}`}>{r.role}</span>,
                r.label, String(r.rank),
                r.org ? <Link key="scope" to={`/stakeholders/${r.org.kind}s/${r.org.id}`}>{r.org.name}</Link> : 'Global',
                who(r.granted_by), longDate(r.granted_at),
              ],
            }))} />
        </div>
      </div>

      {access === null ? (
        <div className="ud-rank-note">
          Resolved access (groups, overrides, effective permissions) is visible to admins at rank 60 and above.
        </div>
      ) : (
        <>
          <div className="panel">
            <div className="panel-head">
              <h3>Access groups</h3>
              {canManageAccess && summary && (
                <button className="mini-btn" onClick={() => setOpen('groups')}>Manage groups</button>
              )}
            </div>
            <div className="panel-body">
              <DataTable ariaLabel="Access groups" emptyText="Not in any access groups"
                columns={[
                  { key: 'group', label: 'Group' }, { key: 'desc', label: 'Description' },
                  { key: 'gates', label: 'Pages gated', align: 'right' },
                  { key: 'by', label: 'Added by' }, { key: 'at', label: 'Added on', mono: true },
                ]}
                rows={access.groups.map((g) => ({
                  key: g.id,
                  cells: [
                    <Link key="group" to={`/access?tab=groups&group=${g.id}`}>{g.name}</Link>,
                    g.description || '—',
                    <span key="gates" title={g.gated_pages.join(', ')}>{String(g.gate_count)}</span>,
                    who(g.added_by), longDate(g.added_at),
                  ],
                }))} />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Overrides</h3>
              {canManageAccess && summary && (
                <button className="mini-btn" onClick={() => setOpen('overrides')}>Edit overrides</button>
              )}
            </div>
            <div className="panel-body">
              <DataTable ariaLabel="Overrides" emptyText="No overrides"
                columns={[
                  { key: 'page', label: 'Page' }, { key: 'action', label: 'Action' },
                  { key: 'effect', label: 'Effect' }, { key: 'by', label: 'Set by' },
                  { key: 'at', label: 'Set on', mono: true },
                ]}
                rows={access.overrides.map((o) => ({
                  key: `${o.resource}:${o.action}`,
                  cells: [
                    o.resource_label, o.action,
                    <span key="effect" className={`chip ${o.allow ? 'c-green' : 'c-red'}`}><span className="dot" />{o.allow ? 'allow' : 'deny'}</span>,
                    who(o.set_by), longDate(o.set_at),
                  ],
                }))} />
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Effective permissions</h3>
              <span className="exp-scope">{scopeLine}</span>
            </div>
            <div className="panel-body">
              {summary
                ? <MatrixTable mode="effective" resources={summary.resources} cells={access.cells} editable={false} />
                : <p className="set-note" style={{ padding: 0 }}>Loading…</p>}
            </div>
          </div>
        </>
      )}

      {open === 'roles' && (
        <ManageRolesModal user={toManagedUser(detail)}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); onChanged(); }} />
      )}
      {open === 'groups' && summary && access && (
        <ManageGroupsModal user={{ person_id: detail.person.id, display_name: detail.person.display_name, max_rank: detail.max_rank }}
          summary={summary} currentIds={access.groups.map((g) => g.id)}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); onChanged(); }} />
      )}
      {open === 'overrides' && summary && (
        <OverrideEditor summary={summary} member={toMemberItem(detail)}
          canEdit={canManageAccess} maxRank={maxRank} selfId={selfId}
          onClose={() => setOpen(null)}
          onSaved={() => { setOpen(null); onChanged(); }} />
      )}
    </div>
  );
}
