/**
 * SecurityControls — System settings › Security. Two-factor POLICY flags,
 * now enforced: enrollment challenges enrolled users at sign-in, and the
 * "require for everyone" flag forces enrollment at next sign-in. Also the
 * "End all sessions" action, which signs everyone out on every device
 * except the admin pressing it.
 */

import { useEffect, useState } from 'react';

import { ApiError, getSecurityConfig, revokeAllSessions, updateSecurityConfig,
  type SecurityConfig } from '../../lib/api';
import { getSystemStatus } from '../../lib/systemStatus';
import { Switch } from '../Switch';

export default function SecurityControls({ canChange = true }: { canChange?: boolean }) {
  const [cfg, setCfg] = useState<SecurityConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revoked, setRevoked] = useState<{ revoked_sessions: number; revoked_people: number } | null>(null);
  const [trustDays, setTrustDays] = useState<number | null>(null);

  useEffect(() => {
    void getSecurityConfig().then(setCfg).catch(() => setError('Could not load security settings.'));
    void getSystemStatus().then((s) => setTrustDays(s.totp_trust_days)).catch(() => {});
  }, []);

  const patch = async (p: Partial<SecurityConfig>) => {
    setBusy(true); setError('');
    try { setCfg(await updateSecurityConfig(p)); }
    catch (err) { setError(err instanceof ApiError ? (RANGE_ERRORS[err.code] ?? err.message) : 'Could not save.'); }
    finally { setBusy(false); }
  };

  const endAll = async () => {
    if (!window.confirm('Sign everyone out on every device? You will stay signed in here.')) return;
    setBusy(true); setError(''); setRevoked(null);
    try { setRevoked(await revokeAllSessions()); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not end sessions.'); }
    finally { setBusy(false); }
  };

  const locked = busy || !canChange || cfg === null;

  return (
    <>
      <div className="set-row">
        <div className="set-label">
          <b>Two-factor authentication</b>
          <span>Lets people enroll an authenticator app and challenges enrolled users at sign-in.</span>
        </div>
        <Switch checked={cfg?.two_factor_enabled ?? false} disabled={locked}
                onChange={(v) => void patch({ two_factor_enabled: v })} />
      </div>
      <div className="set-row">
        <div className="set-label">
          <b>Require two-factor for everyone</b>
          <span>Every user must enroll at their next sign-in. Turning this on also enables two-factor.</span>
        </div>
        <Switch checked={cfg?.two_factor_required ?? false} disabled={locked}
                onChange={(v) => void patch({ two_factor_required: v })} />
      </div>
      <div className="set-row">
        <div className="set-label">
          <b>Remembered browsers</b>
          <span>"Remember this browser" at the code step lets that browser skip the code for {trustDays ?? '…'} days (SS_TOTP_TRUST_DAYS).</span>
        </div>
      </div>
      <div className="set-row">
        <div className="set-label">
          <b>Password expiry</b>
          <span>Everyone must choose a new password after a set number of days, and can't reuse recent ones. The clock starts today.</span>
        </div>
        <Switch checked={cfg?.password_expiry_enabled ?? false} disabled={locked}
                onChange={(v) => void patch({ password_expiry_enabled: v })} />
      </div>
      <NumberSetting id="sec-expiry-days" label="Expires after" hint="Days a password stays valid." suffix="days"
                     value={cfg?.password_expiry_days ?? 90} min={1} max={365} disabled={locked}
                     onSave={(v) => void patch({ password_expiry_days: v })} />
      <NumberSetting id="sec-history-count" label="Prevent reuse of the last" hint="Passwords that can't be chosen again. 0 turns this off." suffix="passwords"
                     value={cfg?.password_history_count ?? 3} min={0} max={24} disabled={locked}
                     onSave={(v) => void patch({ password_history_count: v })} />
      <div className="set-row">
        <div className="set-label">
          <b>End all sessions</b>
          <span>Sign everyone out on every device. Your current session stays signed in.</span>
          {revoked && (
            <span className="set-ok">
              Signed out {revoked.revoked_sessions} session{revoked.revoked_sessions === 1 ? '' : 's'} across {revoked.revoked_people} {revoked.revoked_people === 1 ? 'person' : 'people'}.
            </span>
          )}
        </div>
        <button type="button" className="mini-btn danger" disabled={busy || !canChange} onClick={() => void endAll()}>
          End all sessions
        </button>
      </div>
      {error && <p className="pf-error" style={{ margin: '0 20px 14px' }}>{error}</p>}
    </>
  );
}

const RANGE_ERRORS: Record<string, string> = {
  password_expiry_days_out_of_range: 'Expires after must be between 1 and 365 days.',
  password_history_count_out_of_range: 'Prevent reuse must be between 0 and 24 passwords.',
};

/** A compact number field sat in a `.set-row`'s value slot (where a
 *  `Switch` usually goes). Note: this deliberately does NOT reuse the
 *  `.set-inline`/`input` classes AdminControls.tsx already defines for
 *  its full-width "message + Save button" rows — that rule targets any
 *  `input` inside a `.set-inline` (`flex: 1`, full width), which would
 *  stretch this field's fixed-width number box. `set-num-inline` keeps
 *  this compact right-hand pattern from fighting that one. */
function NumberSetting({ id, label, hint, suffix, value, min, max, disabled, onSave }: {
  id: string; label: string; hint: string; suffix: string; value: number;
  min: number; max: number; disabled: boolean; onSave: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n === value) { setDraft(String(value)); return; }
    onSave(n);
  };
  return (
    <div className="set-row">
      <div className="set-label">
        <b><label htmlFor={id}>{label}</label></b>
        <span>{hint}</span>
      </div>
      <span className="set-num-inline">
        <input id={id} className="set-number" type="number" min={min} max={max} value={draft} disabled={disabled}
               onChange={(e) => setDraft(e.target.value)} onBlur={commit}
               onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
        <span>{suffix}</span>
      </span>
    </div>
  );
}
