/**
 * UserDetail — full page for one login user (/people/users/:personId),
 * styled like /me: eyebrow + hero, segmented tabs (Profile / Access /
 * History), profile-grid panels. Every admin action reuses the Users
 * directory's modals; the payload is one GET /users/{id}.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AvatarUpload from '../components/AvatarUpload';
import GodDeleteButton from '../components/GodDeleteButton';
import {
  AccountStateModal, AdminEditProfileModal, ResetPasswordModal,
} from '../components/UserAdminModals';
import UserAccessTab from '../components/users/UserAccessTab';
import UserProfileTab from '../components/users/UserProfileTab';
import { canTouchRank, RANK_LABELS } from '../lib/access';
import { ApiError, getUserDetail, revokeAllUserSessions, type UserDetailOut } from '../lib/api';
import { longDate } from '../lib/format';
import { usePendingDeletes } from '../lib/pendingDeletes';
import { ROLE_CLS, STATUS_META, toManagedUser } from '../lib/users';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/access.css';
import '../styles/reports.css';
import '../styles/user-detail.css';

/** self = it's you; readonly = they outrank you; manage = full admin actions;
 *  view = you can see the row but hold no users:change / access:change. */
export type DetailMode = 'self' | 'readonly' | 'manage' | 'view';

type Tab = 'profile' | 'access' | 'history';
type Action =
  | { kind: 'edit' | 'reset' | 'signout' }
  | { kind: 'state'; action: 'disable' | 'enable' | 'unlock' };

export function rankLabel(rank: number): string | null {
  const hit = RANK_LABELS.find(([r]) => r === rank);
  return hit ? hit[1] : rank > 0 ? `Rank ${rank}` : null;
}

export default function UserDetail() {
  const { personId = '' } = useParams<{ personId: string }>();
  const { person: me, can, maxRank, godMode } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pd = usePendingDeletes(godMode);

  const tab: Tab = pathname.endsWith('/access') ? 'access'
    : pathname.endsWith('/history') ? 'history' : 'profile';
  const base = `/people/users/${personId}`;

  const [detail, setDetail] = useState<UserDetailOut | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const reqSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoadError('');
    try {
      const next = await getUserDetail(personId);
      if (seq !== reqSeq.current) return;      // a newer load superseded this one
      setDetail(next);
      setMissing(false);
    } catch (err) {
      if (seq !== reqSeq.current) return;
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) setMissing(true);
      else setLoadError('Could not load this user.');
    }
  }, [personId]);

  useEffect(() => { void load(); }, [load]);

  const back = <Link to="/people/users" className="idet-back">← Users</Link>;

  if (missing) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>User not found</b>This person does not exist or has no login account.
        </div>
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="portal-page">
        {back}
        <div className="dir-empty" style={{ marginTop: 16 }}>
          <b>{loadError}</b>
          <button className="mini-btn" style={{ marginTop: 8 }} onClick={() => void load()}>Retry</button>
        </div>
      </div>
    );
  }
  if (!detail) {
    return <div className="portal-page">{back}<p className="page-hint">Loading…</p></div>;
  }

  const { person, account, roles } = detail;
  const isSelf = person.id === me?.id;
  const canTouch = !isSelf && canTouchRank(maxRank, detail.max_rank);
  const canManageUsers = canTouch && can('users', 'change');
  const canManageAccess = canTouch && can('access', 'change');
  const mode: DetailMode = isSelf ? 'self' : !canTouch ? 'readonly'
    : (canManageUsers || canManageAccess || godMode) ? 'manage' : 'view';
  const status = STATUS_META[account.status] ?? { label: account.status, cls: 'tag' };
  const rank = rankLabel(detail.max_rank);
  const managed = toManagedUser(detail);
  const showHistory = can('audit', 'view');
  const joined = [person.city, person.region].filter(Boolean).join(', ');

  const signOutAll = async () => {
    setSigningOut(true);
    try {
      await revokeAllUserSessions(person.id);
      setAction(null);
      await load();
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="portal-page">
      {back}
      <div className="eyebrow">People › Users</div>

      <div className="profile-hero">
        <div className="profile-cover" />
        <div className="profile-id">
          <AvatarUpload
            name={person.display_name}
            url={person.avatar_url}
            entityType="person"
            entityId={person.id}
            editable={canManageUsers}
            size={104}
            radius={26}
            onUploaded={() => void load()}
          />
          <div className="profile-meta">
            <h1>
              {person.display_name}
              <span className="ud-hero-chips">
                <span className={`chip ${status.cls}`}><span className="dot" />{status.label}</span>
                {rank && <span className="chip tag">{rank}</span>}
              </span>
            </h1>
            <div className="pm-role">
              {person.job_title ?? 'No title set'} · {roles.length
                ? roles.map((r) => (
                  <span key={r.role} className={`chip ${ROLE_CLS[r.role] ?? 'tag'}`}
                        style={{ marginRight: 4 }}>{r.label}</span>))
                : 'no roles'}
            </div>
            <div className="pm-sub">
              {person.email && <span>✉ {person.email}</span>}
              {person.phone && <span>☏ {person.phone}</span>}
              {joined && <span>⌖ {joined}</span>}
              <span>joined {longDate(account.created_at)}</span>
            </div>
          </div>
          <div className="profile-actions">
            {mode === 'self' && (
              <button className="btn-solid" onClick={() => navigate('/me')}>Go to My profile</button>
            )}
            {mode === 'readonly' && (
              <span className="ro-chip">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                     strokeLinecap="round" strokeLinejoin="round">
                  <rect x="5" y="11" width="14" height="9" rx="2" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
                Read-only · their rank is at or above yours
              </span>
            )}
            {mode === 'manage' && canManageUsers && (
              <>
                <button className="btn-solid" onClick={() => setAction({ kind: 'edit' })}>Edit profile</button>
                <button className="mini-btn" onClick={() => setAction({ kind: 'reset' })}>Reset password</button>
                {account.status === 'locked' && (
                  <button className="mini-btn" onClick={() => setAction({ kind: 'state', action: 'unlock' })}>Unlock</button>
                )}
                {account.status === 'disabled' ? (
                  <button className="mini-btn" onClick={() => setAction({ kind: 'state', action: 'enable' })}>Enable account</button>
                ) : (
                  <button className="mini-btn danger" onClick={() => setAction({ kind: 'state', action: 'disable' })}>Disable account</button>
                )}
              </>
            )}
            {mode === 'manage' && (
              <GodDeleteButton visible={godMode} entityType="person"
                               entityId={person.id} label={person.display_name}
                               pending={pd.pendingIds.has(person.id)}
                               onChange={pd.pendingIds.has(person.id)
                                 ? () => pd.unmark(person.id)
                                 : () => pd.mark('person', person.id, person.display_name)} />
            )}
          </div>
        </div>
      </div>

      <div className="segmented me-tabs" role="tablist">
        {([['profile', 'Profile', base], ['access', 'Access', `${base}/access`],
           ['history', 'History', `${base}/history`]] as const)
          .filter(([key]) => key !== 'history' || showHistory)
          .map(([key, label, to]) => (
            <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''}
                    onClick={() => navigate(to)}>
              {label}
            </button>
          ))}
      </div>

      {tab === 'profile' && (
        <UserProfileTab detail={detail} mode={mode}
                        onEdit={() => setAction({ kind: 'edit' })}
                        onReset={() => setAction({ kind: 'reset' })}
                        onSignOutAll={() => setAction({ kind: 'signout' })} />
      )}
      {tab === 'access' && (
        <UserAccessTab detail={detail} canManageAccess={canManageAccess}
                       selfId={me?.id ?? null} maxRank={maxRank} onChanged={() => void load()} />
      )}
      {/* Task 8 adds: tab === 'history' && showHistory && <UserHistoryTab … /> */}

      {action?.kind === 'edit' && (
        <AdminEditProfileModal user={managed}
          onClose={() => setAction(null)}
          onSaved={() => { setAction(null); void load(); }}
          onAvatarChanged={() => void load()} />
      )}
      {action?.kind === 'reset' && (
        <ResetPasswordModal user={managed}
          onClose={() => setAction(null)}
          onDone={() => { setAction(null); void load(); }} />
      )}
      {action?.kind === 'state' && (
        <AccountStateModal user={managed} action={action.action}
          onClose={() => setAction(null)}
          onDone={() => { setAction(null); void load(); }} />
      )}
      {action?.kind === 'signout' && (
        <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !signingOut) setAction(null); }}>
          <div className="modal-card reports-modal-card rgm-card ud-confirm-card" role="dialog" aria-label="Sign out everywhere">
            <div className="modal-head">
              <div className="rgm-head-text">
                <div className="eyebrow">Sessions</div>
                <h3>Sign out everywhere</h3>
                <p className="page-hint">
                  Every live sign-in for {person.display_name} is revoked immediately. Their account stays enabled and they can sign in again with their password.
                </p>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn-solid" onClick={() => void signOutAll()} disabled={signingOut}>
                {signingOut ? 'Signing out…' : 'Sign out all sessions'}
              </button>
              <button className="mini-btn" onClick={() => setAction(null)} disabled={signingOut}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
