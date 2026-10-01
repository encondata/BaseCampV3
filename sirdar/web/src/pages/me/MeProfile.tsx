/** /me › Profile — details (view + edit), security (password + 2FA for
 *  local users; read-only for portal users) and active sessions. Built
 *  from the portal's client functions and shared components, laid out like
 *  the portal's My profile page. */
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { useAuth } from '@portal/auth/AuthContext';
import ChangePasswordForm from '@portal/components/ChangePasswordForm';
import RegenerateCodesModal from '@portal/components/totp/RegenerateCodesModal';
import TotpEnrollModal from '@portal/components/totp/TotpEnrollModal';
import {
  ApiError, getSessionsRequest, revokeSessionRequest, updateProfileRequest, type SessionInfo,
} from '@portal/lib/api';
import { describeUserAgent, longDate, relativeTime } from '@portal/lib/format';

import type { SirdarProfile } from '../../lib/sirdarApi';

/** The portal's EDIT_FIELDS (pages/Profile.tsx), field for field. */
const EDIT_FIELDS = [
  { key: 'first_name', label: 'First name', name: 'First name', full: false, required: true },
  { key: 'last_name', label: 'Last name', name: 'Last name', full: false, required: true },
  { key: 'preferred_name', label: 'Preferred name', name: 'Preferred name', full: false, required: false },
  { key: 'job_title', label: 'Job title', name: 'Job title', full: false, required: false },
  { key: 'email', label: 'Contact email', name: 'Contact email', full: false, required: false },
  { key: 'phone', label: 'Phone', name: 'Phone', full: false, required: false },
  { key: 'address_line1', label: 'Address line 1', name: 'Address line 1', full: true, required: false },
  { key: 'address_line2', label: 'Address line 2', name: 'Address line 2', full: true, required: false },
  { key: 'city', label: 'City', name: 'City', full: false, required: false },
  { key: 'region', label: 'State / region', name: 'State / region', full: false, required: false },
  { key: 'postal_code', label: 'Postal code', name: 'Postal code', full: false, required: false },
  { key: 'country', label: 'Country (2-letter)', name: 'Country', full: false, required: true },
] as const;

type EditKey = (typeof EDIT_FIELDS)[number]['key'];

const PORTAL_NOTE = 'The next import from the portal overwrites these until two-way sync exists.';
const MANAGED = 'Managed in the portal';

function formStateFrom(p: SirdarProfile): Record<EditKey, string> {
  const out = {} as Record<EditKey, string>;
  for (const f of EDIT_FIELDS) out[f.key] = (p[f.key] ?? '') as string;
  return out;
}

function saveError(err: unknown): string {
  const code = err instanceof ApiError ? err.code : '';
  const field = EDIT_FIELDS.find((f) => code === `${f.key}_required`);
  return field ? `${field.name} is required.` : 'Could not save — check the fields and try again.';
}

export default function MeProfile({ profile, onProfile, editing, onEditingChange }: {
  profile: SirdarProfile;
  onProfile: (p: SirdarProfile) => void;
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
}) {
  const { applyProfile, totp, applyTotp, clearMustChange, passwordExpiresAt } = useAuth();
  const local = profile.source === 'local';
  const [form, setForm] = useState<Record<EditKey, string>>(() => formStateFrom(profile));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [changingPw, setChangingPw] = useState(false);
  const [pwChanged, setPwChanged] = useState(false);
  const [enrollOpen, setEnrollOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);

  const loadSessions = useCallback(() => {
    getSessionsRequest().then(setSessions).catch(() => {});
  }, []);
  useEffect(loadSessions, [loadSessions]);

  // entering edit mode (from the panel or the hero) starts from the saved values
  useEffect(() => {
    if (editing) { setForm(formStateFrom(profile)); setError(''); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    // send only changed fields; blank on a field = clear it (null)
    const patch: Record<string, string | null> = {};
    for (const f of EDIT_FIELDS) {
      const now = form[f.key].trim();
      const before = (profile[f.key] ?? '') as string;
      if (now !== before) patch[f.key] = now === '' ? null : now;
    }
    try {
      if (Object.keys(patch).length > 0) {
        const updated = await updateProfileRequest(patch) as SirdarProfile;
        onProfile(updated);
        applyProfile(updated); // nav chip updates immediately
      }
      onEditingChange(false);
    } catch (err) {
      setError(saveError(err));
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (familyId: string) => {
    try {
      await revokeSessionRequest(familyId);
    } finally {
      loadSessions();
    }
  };

  const enrolled = !!totp?.enrolled;
  const totpChip = enrolled
    ? <span className="chip c-green"><span className="dot" />On{totp?.enrolled_at ? ` since ${longDate(totp.enrolled_at)}` : ''}</span>
    : <span className="chip tag">Off{totp?.required ? ' · required by policy' : ''}</span>;
  const lastChanged = profile.password_updated_at ? `Last changed ${longDate(profile.password_updated_at)}` : 'Set';

  return (
    <>
      <div className="profile-grid">
        <div>
          <div className="panel">
            <div className="panel-head">
              <h3>{editing ? 'Edit details' : 'Profile'}</h3>
              {!editing && <button type="button" className="mini-btn" onClick={() => onEditingChange(true)}>Edit</button>}
            </div>
            <div className="panel-body">
              {!local && <p className="pf-notice">{PORTAL_NOTE}</p>}
              {editing ? (
                <form className="pf-form" onSubmit={save} noValidate>
                  <div className="full">
                    <label htmlFor="pf-login-email">Sign-in email</label>
                    <input id="pf-login-email" value={profile.login_email} readOnly disabled />
                  </div>
                  {EDIT_FIELDS.map((f) => (
                    <div key={f.key} className={f.full ? 'full' : ''}>
                      <label htmlFor={`pf-${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
                      <input id={`pf-${f.key}`} value={form[f.key]} required={f.required}
                             onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
                    </div>
                  ))}
                  <div className="pf-form-actions">
                    <button className="btn-solid" type="submit" disabled={saving}>
                      {saving ? 'Saving…' : 'Save changes'}
                    </button>
                    <button className="mini-btn" type="button" disabled={saving}
                            onClick={() => onEditingChange(false)}>Cancel</button>
                    {error && <span className="pf-error" role="alert">{error}</span>}
                  </div>
                </form>
              ) : (
                <dl className="kv">
                  <dt>Sign-in email</dt><dd className="mono">{profile.login_email}</dd>
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
            <div className="panel-head"><h3>Security</h3></div>
            <div className="panel-body">
              {changingPw ? (
                <>
                  <ChangePasswordForm onSuccess={() => {
                    setChangingPw(false);
                    setPwChanged(true);
                    clearMustChange();
                    loadSessions();   // other sessions were signed out server-side
                  }} />
                  <p className="set-note" style={{ padding: '10px 0 0' }}>
                    <button type="button" className="link-plain" onClick={() => setChangingPw(false)}>Cancel</button>
                  </p>
                </>
              ) : (
                <dl className="kv">
                  <dt>Password</dt>
                  <dd className="totp-line">
                    {pwChanged
                      ? <span className="chip c-green"><span className="dot" />changed — other sessions signed out</span>
                      : <span>{lastChanged}{local && passwordExpiresAt ? ` · expires ${longDate(passwordExpiresAt)}` : ''}</span>}
                    {local
                      ? <button type="button" className="mini-btn" onClick={() => setChangingPw(true)}>Change password</button>
                      : <span className="set-note">{MANAGED}</span>}
                  </dd>
                  <dt>Two-factor auth</dt>
                  <dd className="totp-line">
                    {totpChip}
                    {enrolled && <span className="set-note">{`${totp!.backup_codes_remaining} backup code${totp!.backup_codes_remaining === 1 ? '' : 's'} left`}</span>}
                    {local && enrolled && (
                      <button type="button" className="mini-btn" onClick={() => setRegenOpen(true)}>Regenerate backup codes</button>
                    )}
                    {local && !enrolled && (
                      <button type="button" className="mini-btn accent" onClick={() => setEnrollOpen(true)}>Set up 2FA</button>
                    )}
                    {!local && <span className="set-note">{MANAGED}</span>}
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
                    {s.ip_address ?? 'unknown IP'} · started {relativeTime(s.started_at)} · expires {relativeTime(s.expires_at)}
                  </div>
                </div>
                {s.current
                  ? <span className="chip c-green"><span className="dot" />Current</span>
                  : <button type="button" className="mini-btn" onClick={() => void revoke(s.family_id)}>Sign out</button>}
              </div>
            ))}
            {sessions.length === 0 && <p className="set-note" style={{ padding: 0 }}>No live sessions found.</p>}
          </div>
        </div>
      </div>

      {enrollOpen && (
        <TotpEnrollModal email={profile.login_email} onClose={() => setEnrollOpen(false)}
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
    </>
  );
}
