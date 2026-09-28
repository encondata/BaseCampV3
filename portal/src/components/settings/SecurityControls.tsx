/**
 * SecurityControls — System settings › Security, as three cards: the
 * two-factor POLICY flags (enforced: enrollment challenges enrolled users
 * at sign-in, "require for everyone" forces enrollment at next sign-in),
 * the password expiry policy, and the "End all sessions" action that signs
 * everyone out on every device except the admin pressing it. A failed save
 * reports in the card it came from.
 */

import { useEffect, useState } from 'react';

import { ApiError, getSecurityConfig, revokeAllSessions, updateSecurityConfig,
  type SecurityConfig } from '../../lib/api';
import { getSystemStatus } from '../../lib/systemStatus';
import { Switch } from '../Switch';

export default function SecurityControls({ canChange = true }: { canChange?: boolean }) {
  const [cfg, setCfg] = useState<SecurityConfig | null>(null);
  const [busy, setBusy] = useState(false);
  type Card = 'totp' | 'expiry' | 'sessions';
  const [error, setError] = useState<{ card: Card; text: string } | null>(null);
  const errorIn = (card: Card) => error?.card === card && (
    <p className="pf-error" style={{ margin: '0 20px 14px' }}>{error.text}</p>
  );
  const [revoked, setRevoked] = useState<{ revoked_sessions: number; revoked_people: number } | null>(null);
  const [trustDays, setTrustDays] = useState<number | null>(null);

  useEffect(() => {
    void getSecurityConfig().then(setCfg)
      .catch(() => setError({ card: 'totp', text: 'Could not load security settings.' }));
    void getSystemStatus().then((s) => setTrustDays(s.totp_trust_days)).catch(() => {});
  }, []);

  const patch = async (p: Partial<SecurityConfig>, card: Card) => {
    setBusy(true); setError(null);
    try { setCfg(await updateSecurityConfig(p)); return true; }
    catch (err) {
      setError({ card, text: err instanceof ApiError ? (RANGE_ERRORS[err.code] ?? err.message) : 'Could not save.' });
      return false;
    }
    finally { setBusy(false); }
  };

  const endAll = async () => {
    if (!window.confirm('Sign everyone out on every device? You will stay signed in here.')) return;
    setBusy(true); setError(null); setRevoked(null);
    try { setRevoked(await revokeAllSessions()); }
    catch (err) { setError({ card: 'sessions', text: err instanceof ApiError ? err.message : 'Could not end sessions.' }); }
    finally { setBusy(false); }
  };

  const locked = busy || !canChange || cfg === null;

  return (
    <>
      <section className="set-section">
        <div className="set-head">
          <h3>Two-factor authentication</h3>
          <p>Enrollment and the sign-in challenge for every account.</p>
        </div>
      <div className="set-row">
        <div className="set-label">
          <b>Two-factor authentication</b>
          <span>Lets people enroll an authenticator app and challenges enrolled users at sign-in.</span>
        </div>
        <Switch checked={cfg?.two_factor_enabled ?? false} disabled={locked}
                onChange={(v) => void patch({ two_factor_enabled: v }, 'totp')} />
      </div>
      <div className="set-row">
        <div className="set-label">
          <b>Require two-factor for everyone</b>
          <span>Every user must enroll at their next sign-in. Turning this on also enables two-factor.</span>
        </div>
        <Switch checked={cfg?.two_factor_required ?? false} disabled={locked}
                onChange={(v) => void patch({ two_factor_required: v }, 'totp')} />
      </div>
      <div className="set-row">
        <div className="set-label">
          <b>Remembered browsers</b>
          <span>"Remember this browser" at the code step lets that browser skip the code for {trustDays ?? '…'} days (SS_TOTP_TRUST_DAYS).</span>
        </div>
      </div>
      {errorIn('totp')}
      </section>

      <section className="set-section">
        <div className="set-head">
          <h3>Password expiry</h3>
          <p>How long a password stays valid and which old ones can't come back.</p>
        </div>
      <div className="set-row">
        <div className="set-label">
          <b>Password expiry</b>
          <span>Everyone must choose a new password after a set number of days, and can't reuse recent ones. The clock starts today.</span>
        </div>
        <Switch checked={cfg?.password_expiry_enabled ?? false} disabled={locked}
                onChange={(v) => void patch({ password_expiry_enabled: v }, 'expiry')} />
      </div>
      <NumberSetting id="sec-expiry-days" label="Expires after" hint="Days a password stays valid." suffix="days"
                     value={cfg?.password_expiry_days ?? 90} min={1} max={365} disabled={locked}
                     onSave={(v) => patch({ password_expiry_days: v }, 'expiry')} />
      <NumberSetting id="sec-history-count" label="Prevent reuse of the last" hint="Passwords that can't be chosen again. 0 turns this off." suffix="passwords"
                     value={cfg?.password_history_count ?? 3} min={0} max={24} disabled={locked}
                     onSave={(v) => patch({ password_history_count: v }, 'expiry')} />
      {errorIn('expiry')}
      </section>

      <section className="set-section">
        <div className="set-head">
          <h3>Sessions</h3>
          <p>Sign-in sessions across every device.</p>
        </div>
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
      {errorIn('sessions')}
      </section>
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
  min: number; max: number; disabled: boolean; onSave: (v: number) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const trimmed = draft.trim();
    const n = Number(trimmed);
    if (trimmed === '' || !Number.isInteger(n) || n === value) { setDraft(String(value)); return; }
    void onSave(n).then((ok) => { if (!ok) setDraft(String(value)); });
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
