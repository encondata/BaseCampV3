/**
 * The signed-in frame: one top bar over a full-width page. No side nav,
 * palette, or notifications — the kiosk is a single-purpose screen.
 * Wrapped in .portal-shell so the person's theme/accent/density
 * preferences apply exactly as in the portal (applyPreferences sets the
 * data-* attributes on it). Signed out (the Kiosk Setup page), the bar
 * shows only the logo, mode chip, and kiosk name.
 */

import { Fragment, useEffect, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { registrationLabel } from '@portal/lib/devices';
import { applyPreferences, DEFAULT_PREFERENCES } from '@portal/lib/settings';

import { useKioskAuth } from '../auth/KioskAuthContext';
import type { RegistrationState } from '../lib/api';
import { kioskVersion } from '../lib/config';
import { useDevMode } from '../lib/devMode';
import { FEATURES } from '../lib/features';
import { getIdentity } from '../lib/identity';
import { platform } from '../lib/platform';
import { setupStateLabel, useKioskSetupState, type KioskSetupState } from '../lib/setupState';

const REG_CHIP: Record<RegistrationState, string> = {
  ok: 'c-green', soon: 'c-amber', expired: 'c-red', none: 'c-slate',
};

interface FootItem { label: string; value: string; className?: string }

const SETUP_FOOT_CLASS: Record<KioskSetupState, string> = {
  complete: 'kiosk-foot-setup is-complete',
  incomplete: 'kiosk-foot-setup is-incomplete',
  failed: 'kiosk-foot-setup is-failed',
};

export default function KioskShell({ children }: { children: ReactNode }) {
  const { status, person, registration, preferences, sessionExpiresAt, logout } = useKioskAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const authed = status === 'authed';
  const [devMode] = useDevMode();
  const [setupState] = useKioskSetupState();

  useEffect(() => {
    applyPreferences(preferences ?? DEFAULT_PREFERENCES);
  }, [preferences]);

  const identity = getIdentity();
  const { label: modeLabel } = platform();
  const feature = FEATURES.find((f) => f.path === location.pathname);

  const footItems: FootItem[] = [
    { label: 'Kiosk', value: identity.name },
    { label: 'Mode', value: modeLabel },
    { label: 'Version', value: kioskVersion() },
  ];
  if (authed) {
    footItems.push(
      { label: 'Signed in as', value: person?.display_name ?? '—' },
      {
        label: 'Session ends',
        value: sessionExpiresAt ? new Date(sessionExpiresAt).toLocaleString() : '—',
      },
      { label: 'Registration', value: registration ? registrationLabel(registration) : 'Checking…' },
    );
  }
  footItems.push({ label: 'Setup', value: setupStateLabel(setupState), className: SETUP_FOOT_CLASS[setupState] });

  return (
    <div className="portal-shell kiosk-shell">
      <header className="kiosk-top">
        <div className="kiosk-brand">
          <img className="kiosk-logo" src="/images/serversherpa-logo.png" alt="" />
          <span className="kiosk-wordmark">Server<em>Sherpa</em></span>
          <span className="kiosk-mode">Kiosk · {modeLabel}</span>
          {feature && <span className="kiosk-section">{feature.title}</span>}
        </div>
        <button type="button" className="kiosk-name" title="Kiosk setup"
                onClick={() => navigate('/setup')}>
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
      <footer className="kiosk-foot">
        {footItems.map((item, i) => (
          <Fragment key={item.label}>
            {i > 0 && <span className="kiosk-foot-sep" aria-hidden="true">·</span>}
            <span className={`kiosk-foot-item${item.className ? ` ${item.className}` : ''}`}>
              <b>{item.label}</b><span>{item.value}</span>
            </span>
          </Fragment>
        ))}
        {devMode && (
          <Fragment>
            <span className="kiosk-foot-sep" aria-hidden="true">·</span>
            <span className="kiosk-foot-item kiosk-foot-dev">
              <b>Dev mode</b><span>On</span>
            </span>
          </Fragment>
        )}
      </footer>
    </div>
  );
}
