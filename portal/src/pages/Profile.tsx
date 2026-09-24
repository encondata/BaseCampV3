/**
 * My profile & details — fibertrace user-menu-and-account.md §5, with full
 * edit-and-save of the signed-in person's details, plus live Active
 * sessions from auth_sessions (revoke = that login dies immediately).
 */

import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import ActivityHistory from '../components/ActivityHistory';
import AvatarUpload from '../components/AvatarUpload';
import ChangePasswordForm from '../components/ChangePasswordForm';
import RegenerateCodesModal from '../components/totp/RegenerateCodesModal';
import TotpEnrollModal from '../components/totp/TotpEnrollModal';
import {
  getMyActivityRequest,
  getProfileRequest,
  getSessionsRequest,
  revokeSessionRequest,
  updateProfileRequest,
  type MyActivityItem,
  type PersonDetail,
  type SessionInfo,
} from '../lib/api';
import { describeUserAgent, longDate, relativeTime } from '../lib/format';
import MeNotifications from './me/MeNotifications';
import MePreferences from './me/MePreferences';
import '../styles/directory.css';
import '../styles/profile.css';

const EDIT_FIELDS = [
  { key: 'first_name', label: 'First name', full: false, required: true },
  { key: 'last_name', label: 'Last name', full: false, required: true },
  { key: 'preferred_name', label: 'Preferred name', full: false, required: false },
  { key: 'job_title', label: 'Job title', full: false, required: false },
  { key: 'email', label: 'Contact email', full: false, required: false },
  { key: 'phone', label: 'Phone', full: false, required: false },
  { key: 'address_line1', label: 'Address line 1', full: true, required: false },
  { key: 'address_line2', label: 'Address line 2', full: true, required: false },
  { key: 'city', label: 'City', full: false, required: false },
  { key: 'region', label: 'State / region', full: false, required: false },
  { key: 'postal_code', label: 'Postal code', full: false, required: false },
  { key: 'country', label: 'Country (2-letter)', full: false, required: true },
] as const;

type EditKey = (typeof EDIT_FIELDS)[number]['key'];

function formStateFrom(p: PersonDetail): Record<EditKey, string> {
  const out = {} as Record<EditKey, string>;
  for (const f of EDIT_FIELDS) out[f.key] = (p[f.key] ?? '') as string;
  return out;
}

export default function Profile() {
  const { roles, applyProfile, totp, applyTotp, person } = useAuth();
  const navigate = useNavigate();
  const pathname = useLocation().pathname;
  const tab: 'profile' | 'preferences' | 'notifications' | 'history' = pathname.startsWith('/me/preferences')
    ? 'preferences' : pathname.startsWith('/me/notifications') ? 'notifications'
      : pathname.startsWith('/me/history') ? 'history' : 'profile';
  const onPrefs = tab !== 'profile'; // any non-profile tab hides profile-only chrome
  const [profile, setProfile] = useState<PersonDetail | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<Record<EditKey, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [changingPw, setChangingPw] = useState(false);
  const [pwChanged, setPwChanged] = useState(false);
  const [activity, setActivity] = useState<MyActivityItem[]>([]);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);

  useEffect(() => {
    void getProfileRequest().then(setProfile).catch(() => {});
    void getSessionsRequest().then(setSessions).catch(() => {});
    void getMyActivityRequest().then(setActivity).catch(() => {});
  }, []);

  const startEdit = () => {
    if (!profile) return;
    setForm(formStateFrom(profile));
    setError('');
    setEditing(true);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!form || !profile) return;
    setSaving(true);
    setError('');
    // send only changed fields; empty string on a nullable field = clear it
    const patch: Record<string, string | null> = {};
    for (const f of EDIT_FIELDS) {
      const now = form[f.key].trim();
      const before = (profile[f.key] ?? '') as string;
      if (now !== before) patch[f.key] = now === '' ? null : now;
    }
    try {
      if (Object.keys(patch).length > 0) {
        const updated = await updateProfileRequest(patch);
        setProfile(updated);
        applyProfile(updated); // nav chip updates immediately
      }
      setEditing(false);
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(code === 'email_in_use'
        ? 'That contact email is already in use by another person.'
        : 'Could not save — check the fields and try again.');
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (familyId: string) => {
    await revokeSessionRequest(familyId);
    setSessions((prev) => prev.filter((s) => s.family_id !== familyId));
  };

  if (!profile) {
    return <div className="portal-page"><div className="eyebrow">Account</div></div>;
  }

  return (
    <div className="portal-page">
      <div className="eyebrow">Account</div>

      <div className="profile-hero">
        <div className="profile-cover" />
        <div className="profile-id">
          <AvatarUpload
            name={profile.display_name}
            url={profile.avatar_url}
            entityType="person"
            entityId={profile.id}
            editable
            size={104}
            radius={26}
            onUploaded={(att) => {
              const updated = {
                ...profile,
                avatar_key: att.storage_key,
                avatar_url: att.url,
              };
              setProfile(updated);
              applyProfile(updated); // nav chip picks up the photo
            }}
          />
          <div className="profile-meta">
            <h1>
              {profile.display_name}
              <span className="chip c-green"><span className="dot" />Active</span>
            </h1>
            <div className="pm-role">
              {profile.job_title ?? 'No title set'} · {roles.join(', ') || 'no roles'}
            </div>
            <div className="pm-sub">
              {profile.email && <span>✉ {profile.email}</span>}
              {profile.phone && <span>☏ {profile.phone}</span>}
              {profile.city && <span>⌖ {profile.city}{profile.region ? `, ${profile.region}` : ''}</span>}
              <span>joined {longDate(profile.created_at)}</span>
            </div>
          </div>
          <div className="profile-actions">
            {!editing && !onPrefs && (
              <button className="btn-solid" onClick={startEdit}>Edit details</button>
            )}
          </div>
        </div>
      </div>

      <div className="segmented me-tabs" role="tablist">
        {([['profile', 'Profile', '/me'], ['preferences', 'Preferences', '/me/preferences'],
           ['notifications', 'Notifications', '/me/notifications'],
           ['history', 'History', '/me/history']] as const).map(([key, label, to]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''}
                  onClick={() => navigate(to)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'preferences' && <MePreferences />}
      {tab === 'notifications' && <MeNotifications />}
      {tab === 'profile' && (
      <>
      <div className="profile-grid">
        <div>
          <div className="panel">
            <div className="panel-head">
              <h3>{editing ? 'Edit details' : 'Profile'}</h3>
              {!editing && (
                <button className="mini-btn" onClick={startEdit}>Edit</button>
              )}
            </div>
            <div className="panel-body">
              {editing && form ? (
                <form className="pf-form" onSubmit={save} noValidate>
                  {EDIT_FIELDS.map((f) => (
                    <div key={f.key} className={f.full ? 'full' : ''}>
                      <label htmlFor={`pf-${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
                      <input
                        id={`pf-${f.key}`}
                        value={form[f.key]}
                        required={f.required}
                        onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
                      />
                    </div>
                  ))}
                  <div className="pf-form-actions">
                    <button className="btn-solid" type="submit" disabled={saving}>
                      {saving ? 'Saving…' : 'Save changes'}
                    </button>
                    <button className="mini-btn" type="button" disabled={saving}
                            onClick={() => setEditing(false)}>
                      Cancel
                    </button>
                    {error && <span className="pf-error">{error}</span>}
                  </div>
                </form>
              ) : (
                <dl className="kv">
                  <dt>Person ID</dt><dd className="mono">{profile.id}</dd>
                  <dt>Badge ID</dt><dd className="mono">{profile.badge_uid}</dd>
                  <dt>Preferred name</dt><dd>{profile.preferred_name ?? '—'}</dd>
                  <dt>Job title</dt><dd>{profile.job_title ?? '—'}</dd>
                  <dt>Contact email</dt><dd className="mono">{profile.email ?? '—'}</dd>
                  <dt>Phone</dt><dd className="mono">{profile.phone ?? '—'}</dd>
                  <dt>Address</dt>
                  <dd>
                    {[profile.address_line1, profile.address_line2,
                      [profile.city, profile.region, profile.postal_code].filter(Boolean).join(', '),
                      profile.country]
                      .filter((part) => part && String(part).length > 0)
                      .join(' · ') || '—'}
                  </dd>
                  <dt>Member since</dt><dd className="mono">{longDate(profile.created_at)}</dd>
                </dl>
              )}
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="panel-head">
              <h3>Security</h3>
              {!changingPw && (
                <button className="mini-btn" onClick={() => setChangingPw(true)}>
                  Change password
                </button>
              )}
            </div>
            <div className="panel-body">
              {changingPw ? (
                <>
                  <ChangePasswordForm onSuccess={() => {
                    setChangingPw(false);
                    setPwChanged(true);
                    // other sessions were revoked server-side — refresh the panel
                    void getSessionsRequest().then(setSessions).catch(() => {});
                  }} />
                  <p className="set-note" style={{ padding: '10px 0 0' }}>
                    <button className="link-plain" onClick={() => setChangingPw(false)}>
                      Cancel
                    </button>
                  </p>
                </>
              ) : (
                <dl className="kv">
                  <dt>Password</dt>
                  <dd>{pwChanged
                    ? <span className="chip c-green"><span className="dot" />changed — other sessions signed out</span>
                    : profile.password_updated_at
                      ? `Last reset ${longDate(profile.password_updated_at)}`
                      : 'set'}</dd>
                  <dt>Two-factor auth</dt>
                  <dd className="totp-line">
                    {totp?.enrolled ? (
                      <>
                        <span className="chip c-green"><span className="dot" />On{totp.enrolled_at ? ` since ${longDate(totp.enrolled_at)}` : ''}</span>
                        <span className="set-note">{totp.backup_codes_remaining} backup code{totp.backup_codes_remaining === 1 ? '' : 's'} left</span>
                        {totp.required && <span className="set-note">Required by policy</span>}
                        <button className="mini-btn" onClick={() => setRegenOpen(true)}>Regenerate backup codes</button>
                      </>
                    ) : (
                      <>
                        <span className="chip tag">Off{totp?.required ? ' · required by policy' : ''}</span>
                        <button className="mini-btn accent" onClick={() => setEnrollOpen(true)}>Set up 2FA</button>
                      </>
                    )}
                  </dd>
                </dl>
              )}
            </div>
          </div>
        </div>
      </div>
      <div className="profile-full">
        <div className="panel">
          <div className="panel-head">
            <h3>Active sessions</h3>
            <span className="result-count">{sessions.length} live</span>
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
                {s.current
                  ? <span className="chip c-green"><span className="dot" />Current</span>
                  : (
                    <button className="mini-btn" onClick={() => revoke(s.family_id)}>
                      Sign out
                    </button>
                  )}
              </div>
            ))}
            {sessions.length === 0 && (
              <p className="set-note" style={{ padding: 0 }}>No live sessions found.</p>
            )}
          </div>
        </div>
      </div>
      </>
      )}

      {tab === 'history' && <ActivityHistory rows={activity} />}

      {enrollOpen && person && (
        <TotpEnrollModal email={person.email ?? ''} onClose={() => setEnrollOpen(false)}
          onEnrolled={(n) => {
            setEnrollOpen(false);
            applyTotp({ enrolled: true, enrolled_at: new Date().toISOString(),
                        required: totp?.required ?? false, backup_codes_remaining: n });
          }} />
      )}
      {regenOpen && (
        <RegenerateCodesModal onClose={() => setRegenOpen(false)}
          onRegenerated={(n) => {
            setRegenOpen(false);
            if (totp) applyTotp({ ...totp, backup_codes_remaining: n });
          }} />
      )}
    </div>
  );
}
