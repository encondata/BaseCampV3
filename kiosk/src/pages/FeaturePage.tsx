/** Placeholder screen for a feature that doesn't exist yet — shown for
 *  every route in FEATURES until each one gets its real build. */

import { Link } from 'react-router-dom';

import type { KioskFeature } from '../lib/features';

export default function FeaturePage({ feature }: { feature: KioskFeature }) {
  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · {feature.title}</div>
      <h1 className="page-title">{feature.title}</h1>
      <p className="page-hint">Coming soon. {feature.blurb}</p>
      <div className="kiosk-placeholder">
        <p>This feature is not available yet.</p>
        <Link className="mini-btn" to="/">Back to home</Link>
      </div>
    </div>
  );
}
