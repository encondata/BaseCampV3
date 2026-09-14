/** Label Printing launcher — a tile per section (Printing Station, Bulk
 *  Print, Printer Setup / Troubleshooting). Mirrors Home's `.kiosk-tile`
 *  markup, scoped to `/labels/*`. */

import { Link } from 'react-router-dom';

import { LABEL_SECTIONS, type LabelSection } from '../lib/labelSections';

const ICONS: Record<LabelSection['id'], JSX.Element> = {
  station: (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M10 15V7h20v8" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      <rect x="5" y="15" width="30" height="14" rx="2.5" stroke="currentColor" strokeWidth="2.5" />
      <rect x="12" y="24" width="16" height="9" fill="currentColor" />
      <circle cx="29" cy="20" r="1.6" fill="currentColor" />
    </svg>
  ),
  bulk: (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M11 5h11l9 9-10 10-10-10V5z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="17.5" cy="11.5" r="1.7" fill="currentColor" />
      <path d="M6 15h11l9 9-10 10-10-10V15z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <circle cx="12.5" cy="21.5" r="1.7" fill="currentColor" />
    </svg>
  ),
  printers: (
    <svg viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        d="m24.5 8.5 3.4-3.4a3 3 0 0 1 4.2 4.2l-3.4 3.4m-4.2-4.2-13 13a4.2 4.2 0 0 0-1.1 2l-1.6 6.6 6.6-1.6a4.2 4.2 0 0 0 2-1.1l13-13m-4.2-4.2 4.2 4.2"
        stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  ),
};

export default function Labels() {
  return (
    <div className="portal-page">
      <div className="eyebrow">Kiosk · Label Printing</div>
      <h1 className="page-title">Label Printing</h1>
      <p className="page-hint">Choose what you want to do.</p>
      <nav className="kiosk-launcher label-sections" aria-label="Label printing sections">
        {LABEL_SECTIONS.map((s) => (
          <Link key={s.id} className="kiosk-tile" to={s.path}>
            {ICONS[s.id]}
            <span className="kiosk-tile-title">{s.title}</span>
            <span className="kiosk-tile-blurb">{s.blurb}</span>
          </Link>
        ))}
      </nav>
    </div>
  );
}
