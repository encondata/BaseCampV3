/** Home launcher — a tile per kiosk feature. The identity facts that used
 *  to live here now live in the shell's footer (KioskShell). */

import { Link } from 'react-router-dom';

import { useDevMode } from '../lib/devMode';
import { featureAvailable, FEATURES, type KioskFeature } from '../lib/features';
import { useKioskSetupState } from '../lib/setupState';

const ICONS: Record<KioskFeature['id'], JSX.Element> = {
  setup: (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="20" cy="20" r="4.5" stroke="currentColor" strokeWidth="2.5" />
      <path
        d="M32.3 23.3a2.8 2.8 0 0 0 .6 3.1l.2.2a3.3 3.3 0 1 1-4.7 4.7l-.2-.2a2.8 2.8 0 0 0-3.1-.6 2.8 2.8 0 0 0-1.7 2.6V34a3.3 3.3 0 1 1-6.6 0v-.3a2.8 2.8 0 0 0-1.8-2.6 2.8 2.8 0 0 0-3.1.6l-.2.2a3.3 3.3 0 1 1-4.7-4.7l.2-.2a2.8 2.8 0 0 0 .6-3.1 2.8 2.8 0 0 0-2.6-1.7H4.7a3.3 3.3 0 1 1 0-6.6H5a2.8 2.8 0 0 0 2.6-1.8 2.8 2.8 0 0 0-.6-3.1l-.2-.2a3.3 3.3 0 1 1 4.7-4.7l.2.2a2.8 2.8 0 0 0 3.1.6H15a2.8 2.8 0 0 0 1.7-2.6V4.7a3.3 3.3 0 1 1 6.6 0V5a2.8 2.8 0 0 0 1.7 2.6 2.8 2.8 0 0 0 3.1-.6l.2-.2a3.3 3.3 0 1 1 4.7 4.7l-.2.2a2.8 2.8 0 0 0-.6 3.1V15a2.8 2.8 0 0 0 2.6 1.7h.3a3.3 3.3 0 1 1 0 6.6h-.3a2.8 2.8 0 0 0-2.6 1.7Z"
        stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round"
      />
    </svg>
  ),
  scan: (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="5" y="8" width="3" height="24" fill="currentColor" />
      <rect x="11" y="8" width="1.5" height="24" fill="currentColor" />
      <rect x="15" y="8" width="4" height="24" fill="currentColor" />
      <rect x="22" y="8" width="1.5" height="24" fill="currentColor" />
      <rect x="26" y="8" width="3" height="24" fill="currentColor" />
      <rect x="32" y="8" width="3" height="24" fill="currentColor" />
    </svg>
  ),
  // A luggage-tag outline with an antenna's waves coming off it: the
  // tag is the asset's label, the waves are what the reader hears.
  enroll: (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M4 9h11l9 11-9 11H4V9z"
        stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round"
      />
      <circle cx="10.5" cy="15.5" r="2" fill="currentColor" />
      <path
        d="M29 14a8 8 0 0 1 0 12M33.5 10a13.5 13.5 0 0 1 0 20"
        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
      />
    </svg>
  ),
  // A crate seen head-on: a lidded box with its two strapping bands —
  // the shape someone standing at the kiosk is holding.
  containers: (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect
        x="4" y="11" width="32" height="23" rx="2"
        stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round"
      />
      <path d="M4 17h32" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <path
        d="M14 17v17M26 17v17" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
      />
      <path
        d="M13 11V8a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"
        stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round"
      />
    </svg>
  ),
  // A tractor unit and its box trailer seen from the side, on two
  // wheels: what the operator walks up to on the dock.
  trucks: (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M2 10h19v17H2V10z"
        stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round"
      />
      <path
        d="M21 16h7l5 6v5h-12v-11z"
        stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round"
      />
      <circle cx="12" cy="30" r="3.5" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="28" cy="30" r="3.5" stroke="currentColor" strokeWidth="2.5" />
      <path d="M2 27h6.5M15.5 27h9M31.5 27H38" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  ),
  labels: (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="M6 6h15l13 13-15 15L6 21V6z"
        stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round"
      />
      <circle cx="14" cy="14" r="2.5" fill="currentColor" />
    </svg>
  ),
  timeclock: (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="20" cy="20" r="15" stroke="currentColor" strokeWidth="2.5" />
      <path d="M20 11v9l7 4" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M6 12h20M31 12h3" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="26" cy="12" r="3.5" stroke="currentColor" strokeWidth="2.5" />
      <path d="M6 28h9M20 28h14" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="15" cy="28" r="3.5" stroke="currentColor" strokeWidth="2.5" />
    </svg>
  ),
};

export default function Home() {
  const [setupState] = useKioskSetupState();
  const [devMode] = useDevMode();
  const complete = setupState === 'complete';
  const failed = setupState === 'failed';

  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk</div>
      <h1 className="page-title">What would you like to do?</h1>
      {!complete && devMode && (
        <div className="portal-banner kiosk-setup-banner is-dev">
          Developer mode: all features are available while kiosk setup is {setupState}.
        </div>
      )}
      {!complete && !devMode && (
        <div className="portal-banner kiosk-setup-banner">
          {failed
            ? 'Kiosk setup failed. Open Kiosk Setup to try again.'
            : 'Kiosk setup is incomplete. Only Kiosk Setup and Settings are available.'}
        </div>
      )}
      <nav className="kiosk-launcher" aria-label="Kiosk features">
        {FEATURES.map((f) => {
          const available = featureAvailable(f, setupState, devMode);
          const tile = (
            <>
              {ICONS[f.id]}
              <span className="kiosk-tile-title">{f.title}</span>
              <span className="kiosk-tile-blurb">{f.blurb}</span>
              {!available && (
                <span className="kiosk-tile-lock">
                  {failed ? 'Kiosk setup failed — open Kiosk Setup.' : 'Finish Kiosk Setup first.'}
                </span>
              )}
            </>
          );
          if (!available) {
            return (
              <a
                key={f.id}
                className="kiosk-tile is-disabled"
                aria-disabled="true"
                role="link"
                tabIndex={-1}
                href={f.path}
                onClick={(e) => e.preventDefault()}
              >
                {tile}
              </a>
            );
          }
          return (
            <Link key={f.id} className="kiosk-tile" to={f.path}>
              {tile}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
