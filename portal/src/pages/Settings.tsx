/**
 * System settings — console-wide controls (Administration) that affect
 * every user. Gated on `settings:view`; controls are interactive only
 * with `settings:change` (see AdminControls' `canChange` prop). Personal
 * preferences (Appearance, Notifications) live on /me — see
 * pages/me/MePreferences.tsx.
 */

import { useAuth } from '../auth/AuthContext';
import AdminControls from '../components/settings/AdminControls';
import '../styles/settings.css';

export default function Settings() {
  const { can } = useAuth();
  const canChange = can('settings', 'change');

  return (
    <div className="portal-page">
      <div className="eyebrow">System</div>
      <h1 className="page-title">System settings</h1>
      <p className="page-hint">
        Console-wide controls that affect every user.
        {!canChange && ' Read-only — you can see the current state but changing it needs the settings permission.'}
      </p>

      <div className="set-stack">
        <section className="set-section">
          <div className="set-head">
            <h3>Administration</h3>
            <p>Read-only maintenance mode, background services, and the broadcast banner.</p>
          </div>
          <AdminControls canChange={canChange} />
        </section>
      </div>
    </div>
  );
}
