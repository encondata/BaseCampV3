/**
 * GrantAccessModal — give an existing person (an external contact, or a
 * worker with no login) a portal login through POST /users/{id}/account.
 * Shared by People › External and the worker page's "Give portal login".
 */
import { useState, type FormEvent } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { adminCreateAccountRequest, ApiError } from '../../lib/api';
import { generateTempPassword } from '../../lib/format';
import { useSystemStatus } from '../../lib/systemStatusContext';
import { tempPasswordLength, tempPasswordTooShort } from '../../lib/users';
import { INVITE_OPTIONS, SignInChoice } from './SignInChoice';
import '../../styles/profile.css';   /* .pf-form, .btn-solid */
import '../../styles/reports.css';   /* .rgm-head-text — the modal header */

const GRANT_ERRORS: Record<string, string> = {
  account_exists: 'This person already has a login account.',
  email_in_use: 'That login email is already in use.',
  rank_too_low: 'Their rank is at or above yours.',
  person_not_found: 'That person no longer exists.',
  login_details_required: 'A login email is required to create an account.',
  mail_not_configured: "Email isn't set up, so an invite can't be sent. Set a temporary password instead.",
  person_archived: 'This person is archived.',
};

export interface GrantAccessPerson {
  person_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
}

export function GrantAccessModal({ person, onClose, onDone }: {
  person: GrantAccessPerson;
  onClose: () => void;
  onDone: () => void;
}) {
  const { passwordMinLength } = useAuth();
  const { status: system } = useSystemStatus();
  const emailOn = !!system.email_enabled;
  // unpicked follows the default (invite when email is on), so a status
  // that arrives after the dialog opens still lands on the right choice
  const [picked, setSignIn] = useState<'invite' | 'password' | null>(null);
  const signIn = picked ?? (emailOn ? 'invite' : 'password');
  // the choice is hidden without email, so 'invite' can never be sent then
  const inviting = emailOn && signIn === 'invite';
  const name = `${person.first_name} ${person.last_name}`.trim();
  const [loginEmail, setLoginEmail] = useState(person.email ?? '');
  const [tempPassword, setTempPassword] = useState(
    () => generateTempPassword(tempPasswordLength(passwordMinLength)));
  const [mustChange, setMustChange] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const close = () => { if (!saving) onClose(); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!loginEmail.trim()) {
      setError(GRANT_ERRORS.login_details_required);
      return;
    }
    setSaving(true);
    setError('');
    try {
      await adminCreateAccountRequest(person.person_id, inviting
        ? { login_email: loginEmail.trim(), temp_password: null, must_change_password: false,
            invite: true }
        : { login_email: loginEmail.trim(), temp_password: tempPassword,
            must_change_password: mustChange });
      onDone();
    } catch (err) {
      setError(!(err instanceof ApiError)
        ? 'Network error.'
        : err.code === 'password_too_short'
          ? tempPasswordTooShort(err.detail, passwordMinLength)
          : (GRANT_ERRORS[err.code] ?? 'Could not create the account — check the fields.'));
      setSaving(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) close();
    }}>
      <div className="modal-card reports-modal-card rgm-card" role="dialog"
           aria-label="Grant portal access" style={{ width: 'min(600px, 96vw)' }}>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Users</div>
            <h3>{`Grant portal access — ${name}`}</h3>
            <p className="page-hint">Creates a login so they can sign in to the portal.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={close}
                  disabled={saving}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            <div className="pf-form">
              {emailOn && (
                <div className="full"><label>Sign-in</label>
                  <SignInChoice label="Sign-in" options={INVITE_OPTIONS} value={signIn}
                                onChange={setSignIn} disabled={saving} /></div>
              )}
              <div><label htmlFor="ga-email">Login email *</label>
                <input id="ga-email" type="email" value={loginEmail} required
                       onChange={(e) => setLoginEmail(e.target.value)} /></div>
              {!inviting && (
                <>
                  <div><label htmlFor="ga-temp">Temporary password *</label>
                    <input id="ga-temp" value={tempPassword} required minLength={passwordMinLength}
                           onChange={(e) => setTempPassword(e.target.value)} /></div>
                  <div className="full">
                    <label style={{ margin: 0 }}>
                      <input type="checkbox" checked={mustChange}
                             onChange={(e) => setMustChange(e.target.checked)}
                             style={{ marginRight: 7 }} />
                      Must change password at first sign-in
                    </label>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={saving}>
              {saving ? 'Creating…' : 'Create account'}
            </button>
            <button className="mini-btn" type="button" onClick={close} disabled={saving}>
              Cancel
            </button>
            {error && <span className="pf-error">{error}</span>}
          </div>
        </form>
      </div>
    </div>
  );
}
