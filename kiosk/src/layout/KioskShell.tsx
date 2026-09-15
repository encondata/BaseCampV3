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
import ScanFlash from '../components/ScanFlash';
import type { RegistrationState } from '../lib/api';
import { kioskVersion } from '../lib/config';
import { useDevMode } from '../lib/devMode';
import { FEATURES } from '../lib/features';
import { getIdentity } from '../lib/identity';
import { useKioskSetup } from '../lib/kioskSetup';
import { platform } from '../lib/platform';
import { useSyncStatus } from '../lib/sync';

const REG_CHIP: Record<RegistrationState, string> = {
  ok: 'c-green', soon: 'c-amber', expired: 'c-red', none: 'c-slate',
};

/** A footer entry. `value` alone renders as a labelled pair; `status`
 *  renders as one coloured word — the word names the thing, the colour
 *  answers it, which is all a glance needs across a cage. `title` carries
 *  the detail that used to sit in the footer itself. */
interface FootItem {
  label: string;
  value?: string;
  status?: 'good' | 'bad';
  title?: string;
  className?: string;
}

/** Hover detail for the footer's one-word statuses and the top bar's
 *  person — everything the footer used to spell out inline. */
function registrationTitle(reg: RegistrationState | null): string {
  if (!reg) return 'Checking registration with the portal…';
  if (reg === 'ok') return 'Registered with the portal';
  if (reg === 'soon') return 'Registered — expires within a week; signing in renews it';
  if (reg === 'expired') return 'Registration expired — sign in again to renew it';
  return 'Not registered — sign in on this kiosk to register it';
}

function syncTitle(sync: ReturnType<typeof useSyncStatus>): string {
  if (sync.phase === 'running') return 'Downloading move data…';
  if (sync.phase === 'error') return `Last sync failed (${sync.error ?? 'unknown'}) — re-sync from Kiosk Setup`;
  if (sync.assets === undefined) return 'No move data on this kiosk — sync it from Kiosk Setup';
  const parts = [`${sync.assets} assets`, `${sync.people} people`, `${sync.containers ?? 0} containers`];
  if (sync.trucks !== undefined) parts.push(`${sync.trucks} trucks`);
  return `${parts.join(' · ')}${sync.syncedAt ? ` · synced ${new Date(sync.syncedAt).toLocaleString()}` : ''}`;
}

function sessionTitle(expiresAt: string | null): string | undefined {
  return expiresAt ? `Session ends ${new Date(expiresAt).toLocaleString()}` : undefined;
}

export default function KioskShell({ children }: { children: ReactNode }) {
  const { status, person, registration, preferences, sessionExpiresAt, logout } = useKioskAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const authed = status === 'authed';
  const [devMode] = useDevMode();
  const [kioskSetup] = useKioskSetup();
  const sync = useSyncStatus();

  useEffect(() => {
    applyPreferences(preferences ?? DEFAULT_PREFERENCES);
  }, [preferences]);

  const identity = getIdentity();
  const { label: modeLabel } = platform();
  const feature = FEATURES.find(
    (f) => location.pathname === f.path || location.pathname.startsWith(`${f.path}/`),
  );

  // The kiosk name and the signed-in person are already in the top bar, so
  // the footer doesn't repeat them; the session's end moved to a hover on
  // that person. What's left is either context (mode, version, what this
  // kiosk is set up for) or a status word carrying its own colour.
  const footItems: FootItem[] = [
    { label: 'Mode', value: modeLabel },
    { label: 'Version', value: kioskVersion() },
  ];
  if (authed) {
    footItems.push({
      label: 'Registered',
      status: registration === 'ok' || registration === 'soon' ? 'good' : 'bad',
      title: registrationTitle(registration),
    });
  }
  if (kioskSetup) {
    footItems.push(
      { label: 'Move', value: kioskSetup.initiativeName },
      { label: 'Site', value: kioskSetup.siteName },
      { label: 'Scan', value: kioskSetup.scanLabel },
    );
  }
  footItems.push({
    label: 'Data',
    status: sync.phase === 'done' ? 'good' : 'bad',
    title: syncTitle(sync),
  });

  return (
    <div className="portal-shell kiosk-shell">
      <header className="kiosk-top">
        <div className="kiosk-brand">
          <img className="kiosk-logo" src="/images/serversherpa-logo.png" alt="" />
          <span className="kiosk-wordmark">Server<em>Sherpa</em></span>
          <span className="kiosk-mode">Kiosk · {modeLabel}</span>
          {feature && <span className="kiosk-section">{feature.title}</span>}
        </div>
        <button type="button" className="kiosk-name" title="This kiosk"
                onClick={() => navigate('/settings?tab=this-kiosk')}>
          {identity.name}
        </button>
        <div className="kiosk-user">
          {authed && registration && (
            <span className={`chip ${REG_CHIP[registration]}`}>
              <span className="dot" />{registrationLabel(registration)}
            </span>
          )}
          {authed && person && (
            <span className="kiosk-person" title={sessionTitle(sessionExpiresAt)}>
              {person.display_name}
            </span>
          )}
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
            <span
              className={`kiosk-foot-item${item.status ? ` is-status is-${item.status}` : ''}`
                + `${item.className ? ` ${item.className}` : ''}`}
              title={item.title}
            >
              {item.status
                ? <b>{item.label}</b>
                : <><b>{item.label}</b><span>{item.value}</span></>}
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
      {/* One overlay for the whole kiosk: scan feedback fires from the
          Scanning page but has to paint over the shell, not inside it. */}
      <ScanFlash />
    </div>
  );
}
