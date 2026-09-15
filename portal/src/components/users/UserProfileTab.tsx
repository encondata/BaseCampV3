/**
 * UserProfileTab — the /me-shaped Profile tab for another user: Profile +
 * Account kv panels, then Memberships (worker profile, org affiliations,
 * notification groups) and Active sessions (admin view).
 */
import { Link } from 'react-router-dom';

import type { UserDetailOut } from '../../lib/api';
import { describeUserAgent, longDate, relativeTime } from '../../lib/format';
import { STATUS_META } from '../../lib/users';
import type { DetailMode } from '../../pages/UserDetail';

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Added manually',
  v2_import: 'Imported from V2',
};

export default function UserProfileTab({ detail, mode, onEdit, onReset, onSignOutAll }: {
  detail: UserDetailOut;
  mode: DetailMode;
  onEdit: () => void;
  onReset: () => void;
  onSignOutAll: () => void;
}) {
  const { person, account, roles, worker, notification_groups: groups, sessions } = detail;
  const status = STATUS_META[account.status] ?? { label: account.status, cls: 'tag' };
  const canManage = mode === 'manage';
  const address = [person.address_line1, person.address_line2,
    [person.city, person.region, person.postal_code].filter(Boolean).join(', '),
    person.country]
    .filter((part) => part && String(part).length > 0)
    .join(' · ') || '—';
  const orgRoles = roles.filter((r) => r.org !== null);

  return (
    <>
      <div className="profile-grid">
        <div>
          <div className="panel">
            <div className="panel-head">
              <h3>Profile</h3>
              {canManage && <button className="mini-btn" onClick={onEdit}>Edit</button>}
            </div>
            <div className="panel-body">
              <dl className="kv">
                <dt>Person ID</dt><dd className="mono">{person.id}</dd>
                <dt>Badge ID</dt><dd className="mono">{person.badge_uid}</dd>
                <dt>Preferred name</dt><dd>{person.preferred_name ?? '—'}</dd>
                <dt>Job title</dt><dd>{person.job_title ?? '—'}</dd>
                <dt>Contact email</dt><dd className="mono">{person.email ?? '—'}</dd>
                <dt>Phone</dt><dd className="mono">{person.phone ?? '—'}</dd>
                <dt>Address</dt><dd>{address}</dd>
                <dt>Source</dt>
                <dd>
                  {SOURCE_LABEL[person.source] ?? person.source}
                  {person.source_ref && <span className="mono ud-source-ref">{person.source_ref}</span>}
                </dd>
                <dt>Member since</dt><dd className="mono">{longDate(person.created_at)}</dd>
              </dl>
            </div>
          </div>
        </div>
        <div>
          <div className="panel">
            <div className="panel-head">
              <h3>Account</h3>
              {canManage && <button className="mini-btn" onClick={onReset}>Reset password</button>}
            </div>
            <div className="panel-body">
              <dl className="kv">
                <dt>Login email</dt><dd className="mono">{account.login_email ?? '—'}</dd>
                <dt>Status</dt>
                <dd><span className={`chip ${status.cls}`}><span className="dot" />{status.label}</span></dd>
                <dt>Password</dt>
                <dd>{account.must_change_password
                  ? <span className="chip c-amber"><span className="dot" />change required</span>
                  : account.password_updated_at
                    ? `Last reset ${longDate(account.password_updated_at)}`
                    : 'set'}</dd>
                <dt>Last sign-in</dt>
                <dd className="mono" title={account.last_login_at ? new Date(account.last_login_at).toLocaleString() : undefined}>
                  {relativeTime(account.last_login_at)}
                </dd>
                <dt>Account created</dt><dd className="mono">{longDate(account.created_at)}</dd>
              </dl>
            </div>
          </div>
        </div>
      </div>

      <div className="profile-full">
        <div className="panel">
          <div className="panel-head"><h3>Memberships</h3></div>
          <div className="panel-body">
            <div className="ud-membership-head"><p className="eyebrow-sm" style={{ margin: 0 }}>Worker profile</p></div>
            {worker ? (
              <div className="mini-list">
                <div className="mini-row">
                  <div className="ud-row">
                    <span className="cell-top">{worker.trade ?? 'No trade set'}</span>
                    <span className="cell-sub">{worker.level_title ?? 'Unleveled'}</span>
                    <span className="cell-sub">{worker.partner?.name ?? 'Direct hire'}</span>
                    <Link className="mini-btn" to={`/people/workers/${person.id}`}>Open worker page</Link>
                  </div>
                </div>
              </div>
            ) : <p className="ud-note">Not a worker</p>}

            <div className="ud-membership-head"><p className="eyebrow-sm" style={{ margin: 0 }}>Org affiliations</p></div>
            {orgRoles.length === 0 ? <p className="ud-note">No client or partner roles</p> : (
              <div className="mini-list">
                {orgRoles.map((r) => (
                  <div key={`${r.role}:${r.org!.id}`} className="mini-row">
                    <div className="ud-row-2">
                      <Link className="cell-top" to={`/stakeholders/${r.org!.kind}s/${r.org!.id}`}>{r.org!.name}</Link>
                      <span className="chip tag">{r.label}</span>
                      <span className="mono">{longDate(r.granted_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="ud-membership-head"><p className="eyebrow-sm" style={{ margin: 0 }}>Notification groups</p></div>
            {groups.length === 0 ? <p className="ud-note">Not in any notification groups</p> : (
              <div className="mini-list">
                {groups.map((g) => (
                  <div key={g.id} className="mini-row">
                    <div className="ud-row-2">
                      <Link className="cell-top" to={`/system/notifications/${g.id}`}>{g.name}</Link>
                      <span className="chips">
                        {g.channels.length === 0 ? <span className="chip tag">muted</span>
                          : g.channels.map((c) => <span key={c} className="chip tag">{c}</span>)}
                      </span>
                      <span className="mono">{longDate(g.added_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {sessions !== null && (
        <div className="profile-full">
          <div className="panel">
            <div className="panel-head">
              <h3>Active sessions</h3>
              <span className="activity-tools">
                <span className="result-count">{sessions.length} live</span>
                {canManage && sessions.length > 0 && (
                  <button className="mini-btn danger" onClick={onSignOutAll}>Sign out everywhere</button>
                )}
              </span>
            </div>
            <div className="panel-body">
              {sessions.map((s) => (
                <div className="session-item" key={s.family_id}>
                  <div className="session-icon">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                         strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="4" width="20" height="13" rx="2" />
                      <path d="M8 21h8M12 17v4" />
                    </svg>
                  </div>
                  <div className="session-main cell">
                    <div className="cell-top"><b>{describeUserAgent(s.user_agent)}</b></div>
                    <div className="mono">
                      {s.ip_address ?? 'unknown ip'} · started {relativeTime(s.started_at)} ·
                      expires {relativeTime(s.expires_at)}
                    </div>
                  </div>
                </div>
              ))}
              {sessions.length === 0 && (
                <p className="set-note" style={{ padding: 0 }}>No live sessions found.</p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
