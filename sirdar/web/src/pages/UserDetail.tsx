import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import DataTable from '@portal/components/DataTable';
import MatrixTable from '@portal/components/access/MatrixTable';
import type { Action } from '@portal/lib/access';
import type { AccessResourceOut } from '@portal/lib/api';

import OverridesModal from '../components/OverridesModal';
import {
  errorText, getAccessSummary, getUser, revokeSessions, type UserDetail as Detail,
} from '../lib/sirdarApi';

export default function UserDetail() {
  const { personId = '' } = useParams();
  const { can, person } = useAuth();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [resources, setResources] = useState<AccessResourceOut[]>([]);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const loadSeq = useRef(0);

  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    getUser(personId)
      .then((d) => { if (seq === loadSeq.current) setDetail(d); })
      .catch((e) => {
        if (seq === loadSeq.current) setError(errorText(e, "Couldn't load this user."));
      });
  }, [personId]);

  useEffect(() => {
    setDetail(null);
    setError('');
    setActionError('');
    setNotice('');
    load();
    let cancelled = false;
    getAccessSummary().then((s) => { if (!cancelled) setResources(s.resources); }).catch(() => {});
    return () => { cancelled = true; loadSeq.current++; };
  }, [load]);

  if (error) return <div className="portal-page"><p className="form-error" role="alert">{error}</p></div>;
  if (!detail) return null;
  const u = detail.user;
  const isSelf = person?.id === u.person_id;
  const inherited = Object.fromEntries(Object.entries(detail.cells).map(([res, acts]) => [
    res, Object.fromEntries(Object.entries(acts).map(([a, c]) => [a, c.value])) as Record<Action, boolean>,
  ]));

  const revoke = async () => {
    setActionError('');
    setNotice('');
    try {
      const r = await revokeSessions(u.person_id);
      setNotice(`Signed out of ${r.revoked} session${r.revoked === 1 ? '' : 's'}.`);
      load();
    } catch (e) {
      setActionError(errorText(e, "Couldn't revoke sessions."));
    }
  };

  return (
    <div className="portal-page">
      <div className="eyebrow"><Link to="/admin/users">Users</Link></div>
      <div className="dir-head">
        <h1>{u.display_name}</h1>
        <p>{u.email} · {u.source === 'portal' ? 'Copied from the portal' : 'Local Sirdar user'}
          {u.disabled_at ? ' · Disabled' : ''}</p>
      </div>
      {notice && <p className="page-hint" role="status">{notice}</p>}

      <section className="sirdar-section">
        <h2>Roles</h2>
        <p>{u.roles.length ? u.roles.join(', ') : 'No roles'} {u.source === 'portal' && <span className="page-hint">(managed in the portal)</span>}</p>
      </section>

      <section className="sirdar-section">
        <div className="sirdar-section-head">
          <h2>Access</h2>
          {can('access', 'change') && detail.can_manage && !isSelf && (
            <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>Edit overrides</button>
          )}
        </div>
        {resources.length > 0 && (
          <MatrixTable mode="effective" resources={resources} cells={detail.cells} editable={false} />
        )}
      </section>

      <section className="sirdar-section">
        <div className="sirdar-section-head">
          <h2>Sessions</h2>
          {can('users', 'change') && detail.can_manage && detail.sessions.length > 0 && (
            <button type="button" className="btn-ghost danger" onClick={revoke}>Sign out everywhere</button>
          )}
        </div>
        {actionError && <p className="form-error" role="alert">{actionError}</p>}
        <DataTable
          ariaLabel="Active sessions"
          columns={[{ key: 'started', label: 'Started' }, { key: 'expires', label: 'Expires' },
                    { key: 'ip', label: 'IP', mono: true }, { key: 'agent', label: 'Browser' }]}
          rows={detail.sessions.map((s) => ({
            key: s.id,
            cells: [new Date(s.created_at).toLocaleString(), new Date(s.expires_at).toLocaleString(),
                    s.ip_address ?? '—', s.user_agent ?? '—'],
          }))}
          emptyText="No active sessions."
        />
      </section>

      {editing && (
        <OverridesModal personId={u.person_id} name={u.display_name} resources={resources}
                        inherited={inherited} onClose={() => setEditing(false)}
                        onSaved={() => { setEditing(false); load(); }} />
      )}
    </div>
  );
}
