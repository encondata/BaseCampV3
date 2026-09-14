/**
 * The signed-in frame: one top bar over a full-width page. No side nav,
 * palette, or notifications — the kiosk is a single-purpose screen.
 * Wrapped in .portal-shell so the person's theme/accent/density
 * preferences apply exactly as in the portal (applyPreferences sets the
 * data-* attributes on it). Signed out (the Settings page), the bar
 * shows only the logo, mode chip, and kiosk name.
 */

import { useEffect, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { registrationLabel } from '@portal/lib/devices';
import { applyPreferences, DEFAULT_PREFERENCES } from '@portal/lib/settings';

import { useKioskAuth } from '../auth/KioskAuthContext';
import type { RegistrationState } from '../lib/api';
import { FEATURES } from '../lib/features';
import { getIdentity } from '../lib/identity';
import { platform } from '../lib/platform';

const REG_CHIP: Record<RegistrationState, string> = {
  ok: 'c-green', soon: 'c-amber', expired: 'c-red', none: 'c-slate',
};

export default function KioskShell({ children }: { children: ReactNode }) {
  const { status, person, registration, preferences, logout } = useKioskAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const authed = status === 'authed';

  useEffect(() => {
    applyPreferences(preferences ?? DEFAULT_PREFERENCES);
  }, [preferences]);

  const identity = getIdentity();
  const { label: modeLabel } = platform();
  const feature = FEATURES.find((f) => f.path === location.pathname);

  return (
    <div className="portal-shell kiosk-shell">
      <header className="kiosk-top">
        <div className="kiosk-brand">
          <img className="kiosk-logo" src="/images/serversherpa-logo.png" alt="" />
          <span className="kiosk-wordmark">Server<em>Sherpa</em></span>
          <span className="kiosk-mode">Kiosk · {modeLabel}</span>
          {feature && <span className="kiosk-section">{feature.title}</span>}
        </div>
        <button type="button" className="kiosk-name" title="Kiosk settings"
                onClick={() => navigate('/settings')}>
          {identity.name}
        </button>
        <div className="kiosk-user">
          {authed && registration && (
            <span className={`chip ${REG_CHIP[registration]}`}>
              <span className="dot" />{registrationLabel(registration)}
            </span>
          )}
          {authed && person && <span className="kiosk-person">{person.display_name}</span>}
          {authed && (
            <button type="button" className="mini-btn"
                    onClick={() => void logout().then(() => navigate('/login'))}>
              Sign out
            </button>
          )}
        </div>
      </header>
      <main className="kiosk-main">{children}</main>
    </div>
  );
}
