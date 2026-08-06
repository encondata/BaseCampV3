/**
 * ChangePasswordForm — shared by the forced-change gate and the profile
 * Security panel. On success the server revokes every OTHER login.
 */

import { useState, type FormEvent } from 'react';

import { useAuth } from '../auth/AuthContext';
import { ApiError, changePasswordRequest } from '../lib/api';

const ERRORS: Record<string, string> = {
  invalid_current_password: 'Current password is incorrect.',
  same_as_current: 'The new password must be different from the current one.',
  password_too_short: 'The new password is too short.',
};

export default function ChangePasswordForm({ onSuccess }: { onSuccess: () => void }) {
  const { passwordMinLength } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (next.length < passwordMinLength) {
      setError(`New password must be at least ${passwordMinLength} characters.`);
      return;
    }
    if (next !== confirm) {
      setError('New passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      await changePasswordRequest(current, next);
      onSuccess();
    } catch (err) {
      const code = err instanceof ApiError ? err.code : 'network';
      setError(ERRORS[code] ?? 'Could not change the password — try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="pf-form" onSubmit={submit}>
      <div className="full">
        <label htmlFor="cp-current">Current password</label>
        <input id="cp-current" type="password" autoComplete="current-password"
               value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </div>
      <div>
        <label htmlFor="cp-new">New password ({passwordMinLength}+ characters)</label>
        <input id="cp-new" type="password" autoComplete="new-password"
               value={next} onChange={(e) => setNext(e.target.value)}
               required minLength={passwordMinLength} />
      </div>
      <div>
        <label htmlFor="cp-confirm">Confirm new password</label>
        <input id="cp-confirm" type="password" autoComplete="new-password"
               value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
      </div>
      <div className="pf-form-actions">
        <button className="btn-solid" type="submit" disabled={saving}>
          {saving ? 'Changing…' : 'Change password'}
        </button>
        {error && <span className="pf-error">{error}</span>}
      </div>
      <p className="set-note full" style={{ padding: 0, margin: 0 }}>
        Changing your password signs you out everywhere else.
      </p>
    </form>
  );
}
