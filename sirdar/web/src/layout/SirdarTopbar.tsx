import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { PAGE_TITLES } from './sirdarNav';

/** Crumb + Sirdar badge. The portal Topbar's search, AI and notifications
 *  are portal-data features and are not part of Sirdar. */
export default function SirdarTopbar({ leading }: { leading?: ReactNode }) {
  const { pathname } = useLocation();
  const title = PAGE_TITLES[pathname]
    ?? (pathname.startsWith('/admin/users/') ? 'User'
      : pathname.startsWith('/deploy/environments/') ? 'Environment' : 'Sirdar');
  return (
    <header className="topbar">
      {leading}
      <div className="crumbs">
        <span>Sirdar</span>
        <span className="crumb-sep">/</span>
        <span>{title}</span>
      </div>
      <div className="tb-actions">
        <span className="sirdar-badge">Sirdar</span>
      </div>
    </header>
  );
}
