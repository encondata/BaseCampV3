/**
 * UserProfileTab — the /me-shaped Profile tab for another user: Profile +
 * Account kv panels, then Memberships (worker profile, org affiliations,
 * notification groups) and Active sessions (admin view).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';

import DataTable from '../DataTable';
import { ApiError, type UserDetailOut } from '../../lib/api';
import { statusChip } from '../../lib/chips';
import { describeUserAgent, longDate, relativeTime } from '../../lib/format';
import { STATUS_META, type DetailMode } from '../../lib/users';
import { Switch } from '../Switch';

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Added manually',
  v2_import: 'Imported from V2',
  import: 'Imported from V2',
};

// `mode` is accepted (not just canManageUsers) so callers keep passing the
// same DetailMode they compute for the rest of the page; this component
// only needs canManageUsers to gate its own buttons.
export default function UserProfileTab({
  detail, canManageUsers, onEdit, onReset, onSignOutAll, onResetTotp, onToggleTotpRequired,
}: {
  detail: UserDetailOut;
  mode: DetailMode;
  canManageUsers: boolean;
  onEdit: () => void;
  onReset: () => void;
  onSignOutAll: () => void;
  onResetTotp: () => void;
  onToggleTotpRequired: (v: boolean) => Promise<void>;
}) {
  const { person, account, roles, worker, notification_groups: groups, sessions } = detail;
  const status = STATUS_META[account.status] ?? { label: account.status, cls: 'tag' };
  const canManage = canManageUsers;
  const [toggling, setToggling] = useState(false);
  const [totpError, setTotpError] = useState('');
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
                <dt>Two-factor</dt>
                <dd className="totp-line">
                  {account.totp_enrolled
                    ? <span className="chip c-green"><span className="dot" />Enrolled{account.totp_enrolled_at ? ` ${longDate(account.totp_enrolled_at)}` : ''}</span>
                    : <span className="chip tag">Not enrolled</span>}
                  {account.totp_effective_required && !account.totp_required && (
                    <span className="set-note">Required by policy</span>
                  )}
                  {canManage && (
                    <label className="totp-require">
                      <Switch label="Require 2FA" checked={account.totp_required || account.totp_effective_required}
                              disabled={account.totp_effective_required && !account.totp_required || toggling}
                              onChange={(v) => {
                                setToggling(true);
                                void (async () => {
                                  try {
                                    await onToggleTotpRequired(v);
                                    setTotpError('');
                                  } catch (err) {
                                    setTotpError(err instanceof ApiError
                                      ? `Could not update (${err.code}).`
                                      : 'Network error — nothing was saved.');
                                  } finally {
                                    setToggling(false);
                                  }
                                })();
                              }} />
                      <span>Require 2FA</span>
                    </label>
                  )}
                  {canManage && account.totp_enrolled && (
                    <button className="mini-btn danger" onClick={onResetTotp}>Reset 2FA</button>
                  )}
                  {totpError && <span className="pf-error">{totpError}</span>}
                </dd>
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
            {worker
              ? (
                <DataTable ariaLabel="Worker profile" emptyText="Not a worker"
                  columns={[
                    { key: 'trade', label: 'Trade' }, { key: 'level', label: 'Level' },
                    { key: 'partner', label: 'Partner' }, { key: 'status', label: 'Status' },
                    { key: 'actions', label: '' },
                  ]}
                  rows={[{
                    key: 'worker',
                    cells: [
                      worker.trade ?? '—', worker.level_title ?? 'Unleveled',
                      worker.partner?.name ?? 'Direct hire',
                      statusChip(worker.status_label, worker.status_color),
                      <Link key="open" className="mini-btn" to={`/people/workers/${person.id}`}>Open worker page</Link>,
                    ],
                  }]} />
              )
              : <p className="set-note" style={{ padding: 0 }}>Not a worker</p>}

            <div className="ud-membership-head"><p className="eyebrow-sm" style={{ margin: 0 }}>Org affiliations</p></div>
            <DataTable ariaLabel="Org affiliations" emptyText="No client or partner roles"
              columns={[
                { key: 'org', label: 'Organization' }, { key: 'role', label: 'Role' },
                { key: 'at', label: 'Granted on', mono: true },
              ]}
              rows={orgRoles.map((r) => ({
                key: `${r.role}:${r.org!.id}`,
                cells: [
                  <Link key="org" to={`/stakeholders/${r.org!.kind}s/${r.org!.id}`}>{r.org!.name}</Link>,
                  <span key="role" className="chip tag">{r.label}</span>,
                  longDate(r.granted_at),
                ],
              }))} />

            <div className="ud-membership-head"><p className="eyebrow-sm" style={{ margin: 0 }}>Notification groups</p></div>
            <DataTable ariaLabel="Notification groups" emptyText="Not in any notification groups"
              columns={[
                { key: 'group', label: 'Group' }, { key: 'channels', label: 'Channels' },
                { key: 'at', label: 'Member since', mono: true },
              ]}
              rows={groups.map((g) => ({
                key: g.id,
                cells: [
                  <Link key="group" to={`/system/notifications/${g.id}`}>{g.name}</Link>,
                  <span key="channels" className="chips">
                    {g.channels.length === 0 ? <span className="chip tag">muted</span>
                      : g.channels.map((c) => <span key={c} className="chip tag">{c}</span>)}
                  </span>,
                  longDate(g.added_at),
                ],
              }))} />
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
