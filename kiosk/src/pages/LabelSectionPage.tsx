/** Placeholder screen for one Label Printing section — Printing Station,
 *  Bulk Print, or Printer Setup / Troubleshooting — shown until each one
 *  gets its real build. Mirrors `FeaturePage`, scoped to `/labels/*`. */

import { Link } from 'react-router-dom';

import type { LabelSection } from '../lib/labelSections';

export default function LabelSectionPage({ section }: { section: LabelSection }) {
  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Label Printing</div>
      <h1 className="page-title">{section.title}</h1>
      <p className="page-hint">Coming soon. {section.blurb}</p>
      <div className="kiosk-placeholder">
        <p>This section is not available yet.</p>
        <Link className="mini-btn" to="/labels">Back to Label Printing</Link>
      </div>
    </div>
  );
}
