/**
 * UserDetail — full page for one login user (/people/users/:personId),
 * styled like /me: eyebrow + hero, segmented tabs (Profile / Access /
 * History), profile-grid panels. Every admin action reuses the Users
 * directory's modals; the payload is one GET /users/{id}.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import ActivityHistory from '../components/ActivityHistory';
import AvatarUpload from '../components/AvatarUpload';
import GodDeleteButton from '../components/GodDeleteButton';
import {
  AccountStateModal, AdminEditProfileModal, ResetPasswordModal, ResetTotpModal,
} from '../components/UserAdminModals';
import UserAccessTab from '../components/users/UserAccessTab';
import UserProfileTab from '../components/users/UserProfileTab';
import { canTouchRank, RANK_LABELS } from '../lib/access';
import {
  adminSetTotpRequired, ApiError, getUserActivity, getUserDetail, revokeAllUserSessions,
  type MyActivityItem, type UserDetailOut,
} from '../lib/api';
import { longDate } from '../lib/format';
import { usePendingDeletes } from '../lib/pendingDeletes';
import { type DetailMode, ROLE_CLS, STATUS_META, toManagedUser } from '../lib/users';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/settings.css';
import '../styles/access.css';
import '../styles/reports.css';
import '../styles/user-detail.css';

type Tab = 'profile' | 'access' | 'history';
type Action =
  | { kind: 'edit' | 'reset' | 'signout' }
  | { kind: 'state'; action: 'disable' | 'enable' | 'unlock' }
  | { kind: 'totp-reset' };

/** Tier label for the hero chip — shown only for the global admin tiers
 *  (Staff and above, rank >= 40). Below that, RANK_LABELS entries describe
 *  org-scoped role ranks (10 -> "Org viewer", 5 -> "External") that a
 *  member's max_rank can coincide with for unrelated reasons — e.g. a
 *  plain worker's role rank is 10, so the chip would misleadingly read
 *  "Org viewer". The per-role chips on the next line already say what
 *  applies, so below the admin tiers this returns null and the chip is
 *  simply omitted. */
export function rankLabel(rank: number): string | null {
  if (rank < 40) return null;
  const hit = RANK_LABELS.find(([r]) => r === rank);
  return hit ? hit[1] : `Rank ${rank}`;
}

export default function UserDetail() {
  const { personId = '' } = useParams<{ personId: string }>();
  const { person: me, can, maxRank, godMode } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const pd = usePendingDeletes(godMode);
  // `can` is not guaranteed to be referentially stable across renders (it
  // isn't in these tests' auth mock), so the history effect below depends on
  // this boolean rather than on `can` itself.
  const showHistory = can('audit', 'view');

  const tab: Tab = pathname.endsWith('/access') ? 'access'
    : pathname.endsWith('/history') ? 'history' : 'profile';
  // A direct link to .../history without audit:view (the History tab button
  // is hidden in that case, but the URL itself is still reachable) falls
  // back to the Profile body rather than rendering nothing.
  const effectiveTab: Tab = tab === 'history' && !showHistory ? 'profile' : tab;
  const base = `/people/users/${personId}`;

  const [detail, setDetail] = useState<UserDetailOut | null>(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // History is lazy-loaded (only once the tab is opened) and refreshed after
  // any mutation on this page, but only once it has already been fetched —
  // `activityRef` mirrors `activity` so `load` can check that without taking
  // a dependency on the state itself (which would recreate `load` on every
  // history refresh and re-trigger the mount effect in a loop).
  const [activity, setActivity] = useState<MyActivityItem[] | null>(null);
  const [activityError, setActivityError] = useState('');
  const activityRef = useRef<MyActivityItem[] | null>(null);
  const actSeq = useRef(0);
  const loadActivity = useCallback(async () => {
    const seq = ++actSeq.current;
    setActivityError('');
    try {
      const rows = await getUserActivity(personId);
      if (seq !== actSeq.current) return;
      activityRef.current = rows;
      setActivity(rows);
    } catch {
      if (seq !== actSeq.current) return;
      activityRef.current = [];
      setActivity([]);
      setActivityError('Could not load history.');
    }
  }, [personId]);

  useEffect(() => {
    setActivity(null);
    activityRef.current = null;
    setActivityError('');
  }, [personId]);

  const reqSeq = useRef(0);
  const load = useCallback(async () => {
    const seq = ++reqSeq.current;
    setLoadError('');
    try {
      const next = await getUserDetail(personId);
      if (seq !== reqSeq.current) return;      // a newer load superseded this one
      setDetail(next);
      setMissing(false);
      if (activityRef.current !== null) void loadActivity();
    } catch (err) {
      if (seq !== reqSeq.current) return;
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) setMissing(true);
      else setLoadError('Could not load this user.');
    }
  }, [personId, loadActivity]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (tab === 'history' && activity === null && showHistory) void loadActivity();
  }, [tab, personId, activity, showHistory, loadActivity]);

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
            <button key={key} role="tab" aria-selected={effectiveTab === key}
                    className={effectiveTab === key ? 'on' : ''}
                    onClick={() => navigate(to)}>
              {label}
            </button>
          ))}
      </div>

      {effectiveTab === 'profile' && (
        <UserProfileTab detail={detail} mode={mode} canManageUsers={canManageUsers}
                        onEdit={() => setAction({ kind: 'edit' })}
                        onReset={() => setAction({ kind: 'reset' })}
                        onSignOutAll={() => setAction({ kind: 'signout' })}
                        onResetTotp={() => setAction({ kind: 'totp-reset' })}
                        onToggleTotpRequired={async (v) => { await adminSetTotpRequired(personId, v); await load(); }} />
      )}
      {effectiveTab === 'access' && (
        <UserAccessTab detail={detail} canManageAccess={canManageAccess}
                       selfId={me?.id ?? null} maxRank={maxRank} onChanged={() => void load()} />
      )}
      {effectiveTab === 'history' && showHistory && (
        activityError
          ? (
            <div className="dir-empty" style={{ marginTop: 16 }}>
              <b>{activityError}</b>
              <button className="mini-btn" style={{ marginTop: 8 }} onClick={() => void loadActivity()}>Retry</button>
            </div>
          )
          : <ActivityHistory rows={activity ?? []} subjectName={person.display_name} />
      )}

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
      {action?.kind === 'totp-reset' && managed && (
        <ResetTotpModal user={managed}
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
