/** Home launcher — a tile per kiosk feature. The identity facts that used
 *  to live here now live in the shell's footer (KioskShell). */

import { Link } from 'react-router-dom';

import { FEATURES, type KioskFeature } from '../lib/features';

const ICONS: Record<KioskFeature['id'], JSX.Element> = {
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
};

export default function Home() {
  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk</div>
      <h1 className="page-title">What would you like to do?</h1>
      <nav className="kiosk-launcher" aria-label="Kiosk features">
        {FEATURES.map((f) => (
          <Link key={f.id} className="kiosk-tile" to={f.path}>
            {ICONS[f.id]}
            <span className="kiosk-tile-title">{f.title}</span>
            <span className="kiosk-tile-blurb">{f.blurb}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
