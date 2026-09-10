/**
 * System settings — console-wide controls that affect every user, in
 * tabs: Administration (live), Security / Maintenance / About
 * (placeholders until their content lands). Gated on `settings:view`;
 * Administration's controls are interactive only with `settings:change`
 * (see AdminControls' `canChange` prop). Personal preferences live on
 * /me — see pages/me/MePreferences.tsx.
 */

import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import AdminControls from '../components/settings/AdminControls';
import '../styles/settings.css';

type Tab = 'administration' | 'security' | 'maintenance' | 'about';

const TABS: { key: Tab; label: string; to: string }[] = [
  { key: 'administration', label: 'Administration', to: '/settings' },
  { key: 'security', label: 'Security', to: '/settings/security' },
  { key: 'maintenance', label: 'Maintenance', to: '/settings/maintenance' },
  { key: 'about', label: 'About', to: '/settings/about' },
];

const PLACEHOLDERS: Record<Exclude<Tab, 'administration'>, { title: string; hint: string }> = {
  security: { title: 'Security', hint: 'Password policy, session limits, and sign-in protection.' },
  maintenance: { title: 'Maintenance', hint: 'Backups, housekeeping, and scheduled maintenance windows.' },
  about: { title: 'About', hint: 'Version, build, environment, and licence details.' },
};

export function settingsTabFor(pathname: string): Tab {
  if (pathname.startsWith('/settings/security')) return 'security';
  if (pathname.startsWith('/settings/maintenance')) return 'maintenance';
  if (pathname.startsWith('/settings/about')) return 'about';
  return 'administration';
}

export default function Settings() {
  const { can } = useAuth();
  const canChange = can('settings', 'change');
  const navigate = useNavigate();
  const tab = settingsTabFor(useLocation().pathname);

  return (
    <div className="portal-page">
      <div className="eyebrow">System</div>
      <h1 className="page-title">System settings</h1>
      <p className="page-hint">
        Console-wide controls that affect every user.
        {!canChange && ' Read-only — you can see the current state but changing it needs the settings permission.'}
      </p>

      <div className="segmented me-tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key}
                  className={tab === t.key ? 'on' : ''} onClick={() => navigate(t.to)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="set-stack">
        {tab === 'administration' ? (
          <section className="set-section">
            <div className="set-head">
              <h3>Administration</h3>
              <p>Read-only maintenance mode, background services, and the broadcast banner.</p>
            </div>
            <AdminControls canChange={canChange} />
          </section>
        ) : (
          <section className="set-section">
            <div className="set-head">
              <h3>{PLACEHOLDERS[tab].title}</h3>
              <p>{PLACEHOLDERS[tab].hint}</p>
            </div>
            <p className="set-note">Nothing to configure here yet — this tab is a placeholder.</p>
          </section>
        )}
      </div>
    </div>
  );
}
