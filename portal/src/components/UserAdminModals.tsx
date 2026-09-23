/**
 * Admin account-management modals for the Users directory:
 * edit profile, reset password, manage roles, and account-state
 * confirmations (disable / enable / unlock).
 */

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

import { useAuth } from '../auth/AuthContext';
import { canTouchRank } from '../lib/access';
import {
  adminAccountStateRequest,
  adminResetPasswordRequest,
  adminResetTotp,
  adminSetRolesRequest,
  adminUpdateProfileRequest,
  ApiError,
  getAccessSummary,
} from '../lib/api';
import { generateTempPassword } from '../lib/format';
import AvatarUpload from './AvatarUpload';

export interface ManagedUser {
  person_id: string;
  display_name: string;
  first_name: string;
  last_name: string;
  preferred_name: string | null;
  job_title: string | null;
  contact_email: string | null;
  phone: string | null;
  roles: string[];
  status: string;
  max_rank: number;
  avatar_url: string | null;
}

const GUARD_ERRORS: Record<string, string> = {
  cannot_target_self: "That's you — use My profile instead.",
  rank_too_low: 'Your rank is too low for that change.',
  role_requires_org: 'That role needs a client or partner to scope to — grant it from the org contacts instead.',
  email_in_use: 'That contact email is already in use.',
};

function errText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : '';
  return GUARD_ERRORS[code] ?? 'Action failed — try again.';
}

function Modal({ title, onClose, children }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="modal-card" style={{ width: 'min(520px, 96vw)' }}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="modal-close" aria-label="Close" onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ── edit profile ───────────────────────────────────────────────── */

const EDIT_FIELDS = [
  { key: 'first_name', label: 'First name', required: true },
  { key: 'last_name', label: 'Last name', required: true },
  { key: 'preferred_name', label: 'Preferred name', required: false },
  { key: 'job_title', label: 'Job title', required: false },
  { key: 'contact_email', label: 'Contact email', required: false },
  { key: 'phone', label: 'Phone', required: false },
] as const;

// portal field -> API field (contact email lives at people.email)
const API_FIELD: Record<string, string> = { contact_email: 'email' };

export function AdminEditProfileModal({ user, onClose, onSaved, onAvatarChanged }: {
  user: ManagedUser;
  onClose: () => void;
  onSaved: () => void;
  onAvatarChanged?: () => void;
}) {
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(EDIT_FIELDS.map((f) => [f.key, (user[f.key] ?? '') as string])));
  const [avatarUrl, setAvatarUrl] = useState(user.avatar_url);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    const patch: Record<string, string | null> = {};
    for (const f of EDIT_FIELDS) {
      const now = form[f.key].trim();
      const before = (user[f.key] ?? '') as string;
      if (now !== before) patch[API_FIELD[f.key] ?? f.key] = now === '' ? null : now;
    }
    try {
      if (Object.keys(patch).length > 0) {
        await adminUpdateProfileRequest(user.person_id, patch);
      }
      onSaved();
    } catch (err) {
      setError(errText(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={`Edit ${user.display_name}`} onClose={onClose}>
      <form onSubmit={submit}>
        <div className="modal-body">
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 18 }}>
            <AvatarUpload
              name={user.display_name}
              url={avatarUrl}
              entityType="person"
              entityId={user.person_id}
              editable
              size={72}
              radius={20}
              onUploaded={(att) => {
                setAvatarUrl(att.url);
                onAvatarChanged?.();
              }}
            />
          </div>
          <div className="pf-form">
            {EDIT_FIELDS.map((f) => (
              <div key={f.key}>
                <label htmlFor={`ae-${f.key}`}>{f.label}{f.required ? ' *' : ''}</label>
                <input id={`ae-${f.key}`} value={form[f.key]} required={f.required}
                       onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} />
              </div>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn-solid" type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save changes'}
          </button>
          <button className="mini-btn" type="button" onClick={onClose} disabled={saving}>Cancel</button>
          {error && <span className="pf-error">{error}</span>}
        </div>
      </form>
    </Modal>
  );
}

/* ── reset password ─────────────────────────────────────────────── */

export function ResetPasswordModal({ user, onClose, onDone }: {
  user: ManagedUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [temp, setTemp] = useState(generateTempPassword);
  const [mustChange, setMustChange] = useState(true);
  const [phase, setPhase] = useState<'confirm' | 'done'>('confirm');
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const run = async () => {
    setSaving(true);
    setError('');
    try {
      await adminResetPasswordRequest(user.person_id, temp, mustChange);
      setPhase('done');
    } catch (err) {
      setError(errText(err));
    } finally {
      setSaving(false);
    }
  };

  const copy = () => {
    void navigator.clipboard.writeText(temp).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <Modal title={`Reset password — ${user.display_name}`} onClose={onClose}>
      <div className="modal-body">
        {phase === 'confirm' ? (
          <>
            <p className="set-note" style={{ padding: 0, marginTop: 0 }}>
              This signs {user.first_name} out everywhere and replaces their
              password with the temporary one below. Share it through a secure
              channel.
            </p>
            <div className="pf-form" style={{ marginTop: 14 }}>
              <div className="full">
                <label htmlFor="rp-temp">Temporary password</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input id="rp-temp" value={temp} style={{ fontFamily: 'var(--font-mono)' }}
                         onChange={(e) => setTemp(e.target.value)} minLength={12} />
                  <button className="mini-btn" type="button"
                          onClick={() => setTemp(generateTempPassword())}>↻</button>
                  <button className="mini-btn" type="button" onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
              </div>
              <div className="full">
                <label style={{ textTransform: 'none', letterSpacing: 0, fontFamily: 'var(--font-display)', fontSize: 13 }}>
                  <input type="checkbox" checked={mustChange}
                         onChange={(e) => setMustChange(e.target.checked)}
                         style={{ marginRight: 7 }} />
                  Require a new password at next sign-in
                </label>
              </div>
            </div>
          </>
        ) : (
          <>
            <p className="set-note" style={{ padding: 0, marginTop: 0 }}>
              Done — {user.first_name}'s sessions are revoked. Their temporary
              password (copy it now; it won't be shown again):
            </p>
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <input readOnly value={temp}
                     style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 14,
                              padding: '10px 12px', borderRadius: 9,
                              border: '1px solid var(--paper-line)',
                              background: 'var(--surface-2)', color: 'var(--text-dark)' }} />
              <button className="mini-btn" type="button" onClick={copy}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </>
        )}
      </div>
      <div className="modal-foot">
        {phase === 'confirm' ? (
          <>
            <button className="btn-solid" onClick={() => void run()}
                    disabled={saving || temp.length < 12}>
              {saving ? 'Resetting…' : 'Reset password'}
            </button>
            <button className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
          </>
        ) : (
          <button className="btn-solid" onClick={onDone}>Done</button>
        )}
        {error && <span className="pf-error">{error}</span>}
      </div>
    </Modal>
  );
}

/* ── manage roles ───────────────────────────────────────────────── */

const ALL_ROLES = ['admin', 'staff', 'worker', 'client', 'vendor', 'external'];

export function ManageRolesModal({ user, onClose, onSaved }: {
  user: ManagedUser;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { maxRank } = useAuth();
  const [roles, setRoles] = useState<Set<string>>(new Set(user.roles));
  const [roleRanks, setRoleRanks] = useState<Record<string, number>>({});
  const [ranksLoaded, setRanksLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    void getAccessSummary()
      .then((summary) => {
        if (cancelled) return;
        setRoleRanks(Object.fromEntries(summary.roles.map((r) => [r.name, r.rank])));
      })
      .finally(() => { if (!cancelled) setRanksLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  // The row's own rank gates whether this actor can touch the member at
  // all; per-role rank gates whether a *new* grant is allowed (revoking an
  // already-held role is always permitted once the row itself is touchable
  // — mirrors the server's `set_roles` check).
  const actorCanTouch = canTouchRank(maxRank, user.max_rank);
  const canGrant = (r: string) =>
    ranksLoaded && roleRanks[r] !== undefined && canTouchRank(maxRank, roleRanks[r]);

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await adminSetRolesRequest(user.person_id, [...roles]);
      onSaved();
    } catch (err) {
      setError(errText(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={`Roles — ${user.display_name}`} onClose={onClose}>
      <div className="modal-body">
        <div className="role-picks">
          {ALL_ROLES.map((r) => {
            const held = roles.has(r);
            const disabled =
              r === 'client' ||
              !actorCanTouch ||
              (!held && !canGrant(r));
            const title = r === 'client'
              ? 'Needs client scoping — coming with client management'
              : !actorCanTouch
                ? `${user.display_name}'s rank is at or above yours`
                : (!held && !canGrant(r))
                  ? 'Your rank is too low to grant this role'
                  : undefined;
            return (
              <button key={r} type="button"
                      className={`role-pick ${held ? 'on' : ''}`}
                      disabled={disabled}
                      title={title}
                      onClick={() => setRoles((prev) => {
                        const next = new Set(prev);
                        if (next.has(r)) next.delete(r); else next.add(r);
                        return next;
                      })}>
                {r}
              </button>
            );
          })}
        </div>
        <p className="set-note" style={{ padding: '12px 0 0' }}>
          Revoked roles keep their grant history — nothing is deleted.
        </p>
      </div>
      <div className="modal-foot">
        <button className="btn-solid" onClick={() => void save()} disabled={saving || !actorCanTouch}>
          {saving ? 'Saving…' : 'Save roles'}
        </button>
        <button className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
        {error && <span className="pf-error">{error}</span>}
      </div>
    </Modal>
  );
}

/* ── account state (disable / enable / unlock) ──────────────────── */

const STATE_COPY: Record<string, { title: string; body: string; confirm: string }> = {
  disable: {
    title: 'Disable account',
    body: 'They are signed out everywhere immediately and cannot sign in until re-enabled. Their record and history are untouched.',
    confirm: 'Disable account',
  },
  enable: {
    title: 'Enable account',
    body: 'Sign-in is restored with their existing password. The lockout counter is also cleared.',
    confirm: 'Enable account',
  },
  unlock: {
    title: 'Unlock account',
    body: 'Clears the failed-attempt lockout so they can try signing in again now.',
    confirm: 'Unlock',
  },
};

export function AccountStateModal({ user, action, onClose, onDone }: {
  user: ManagedUser;
  action: 'disable' | 'enable' | 'unlock';
  onClose: () => void;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const copy = STATE_COPY[action];

  const run = async () => {
    setSaving(true);
    setError('');
    try {
      await adminAccountStateRequest(user.person_id, action);
      onDone();
    } catch (err) {
      setError(errText(err));
      setSaving(false);
    }
  };

  return (
    <Modal title={`${copy.title} — ${user.display_name}`} onClose={onClose}>
      <div className="modal-body">
        <p className="set-note" style={{ padding: 0, margin: 0 }}>{copy.body}</p>
      </div>
      <div className="modal-foot">
        <button className={action === 'disable' ? 'btn-solid btn-danger' : 'btn-solid'}
                onClick={() => void run()} disabled={saving}>
          {saving ? 'Working…' : copy.confirm}
        </button>
        <button className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
        {error && <span className="pf-error">{error}</span>}
      </div>
    </Modal>
  );
}

/* ── reset two-factor ───────────────────────────────────────────── */

export function ResetTotpModal({ user, onClose, onDone }: {
  user: ManagedUser;
  onClose: () => void;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setSaving(true); setError('');
    try {
      await adminResetTotp(user.person_id);
      onDone();
    } catch (err) {
      setError(errText(err));
      setSaving(false);
    }
  };
  return (
    <Modal title={`Reset two-factor — ${user.display_name}`} onClose={onClose}>
      <div className="modal-body">
        <p className="set-note" style={{ padding: 0, margin: 0 }}>
          Their authenticator, backup codes and remembered browsers are forgotten. If policy requires two-factor they set it up again at their next sign-in.
        </p>
      </div>
      <div className="modal-foot">
        <button className="btn-solid btn-danger" onClick={() => void run()} disabled={saving}>
          {saving ? 'Working…' : 'Reset two-factor'}
        </button>
        <button className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
        {error && <span className="pf-error">{error}</span>}
      </div>
    </Modal>
  );
}
