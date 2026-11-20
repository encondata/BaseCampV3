/** Troubleshooting — the list of bundled how-to guides for kiosk hardware. */

import { Link } from 'react-router-dom';

import { TOPICS } from '../troubleshooting/topics';

export default function Troubleshooting() {
  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk</div>
      <h1 className="page-title">Troubleshooting</h1>
      <nav className="kiosk-launcher" aria-label="Troubleshooting topics">
        {TOPICS.map((t) => (
          <Link key={t.id} className="kiosk-tile" to={`/troubleshooting/${t.id}`}>
            <span className="kiosk-tile-title">{t.title}</span>
            <span className="kiosk-tile-blurb">{t.blurb}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
