/** The devices app's top bar, in the portal's `topbar` markup: the
 *  hamburger while the nav is hidden, and crumbs (Devices / the page on
 *  screen). */
import { useLocation } from 'react-router-dom';

import type { NavSection } from '@portal/layout/navSections';

import { pageForPath } from './devicesNav';

export default function DevicesTopbar({ section, onOpenNav }: {
  section: NavSection;
  onOpenNav: (() => void) | null;
}) {
  const { pathname } = useLocation();
  const page = pageForPath(section, pathname);

  return (
    <header className="topbar">
      {onOpenNav && (
        <button type="button" className="icon-btn nav-hamburger" aria-label="Open navigation" onClick={onOpenNav}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
      )}
      <div className="crumbs">
        {page ? <span>{section.label}</span> : <b>{section.label}</b>}
        {page && <><span className="crumb-sep">/</span><b>{page.label}</b></>}
      </div>
    </header>
  );
}
