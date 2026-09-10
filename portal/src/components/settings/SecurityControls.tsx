/**
 * SecurityControls — System settings › Security. Two-factor POLICY flags
 * (stored + audited now; enforced once the enrolment flow ships) and the
 * "End all sessions" action, which signs everyone out on every device
 * except the admin pressing it.
 */

import { useEffect, useState } from 'react';

import { ApiError, getSecurityConfig, revokeAllSessions, updateSecurityConfig,
  type SecurityConfig } from '../../lib/api';
import { Switch } from '../Switch';

export default function SecurityControls({ canChange = true }: { canChange?: boolean }) {
  const [cfg, setCfg] = useState<SecurityConfig | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revoked, setRevoked] = useState<{ revoked_sessions: number; revoked_people: number } | null>(null);

  useEffect(() => {
    void getSecurityConfig().then(setCfg).catch(() => setError('Could not load security settings.'));
  }, []);

  const patch = async (p: Partial<SecurityConfig>) => {
    setBusy(true); setError('');
    try { setCfg(await updateSecurityConfig(p)); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not save.'); }
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
          <span>Let people enrol a second factor on their account. Enrolment itself arrives with the 2FA feature; this sets the policy now.</span>
        </div>
        <Switch checked={cfg?.two_factor_enabled ?? false} disabled={locked}
                onChange={(v) => void patch({ two_factor_enabled: v })} />
      </div>
      <div className="set-row">
        <div className="set-label">
          <b>Require two-factor for everyone</b>
          <span>Every account must enrol before using the portal. Turning this on also enables two-factor.</span>
        </div>
        <Switch checked={cfg?.two_factor_required ?? false} disabled={locked}
                onChange={(v) => void patch({ two_factor_required: v })} />
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
      {error && <p className="pf-error" style={{ margin: '0 20px 14px' }}>{error}</p>}
    </>
  );
}
