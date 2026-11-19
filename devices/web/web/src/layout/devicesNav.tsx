/** The devices app's left nav: one "Devices" section, its pages in the
 *  portal's line-icon style. Apple settings only for roles that may change
 *  app distribution. */
import type { ReactNode } from 'react';

import type { NavSection } from '@portal/layout/navSections';

export const SECTION_LABEL = 'Devices';

const icon = (paths: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
       strokeLinecap="round" strokeLinejoin="round">{paths}</svg>
);

type Can = (resource: string, action?: 'view' | 'add' | 'change' | 'delete') => boolean;

export function devicesNavSections(can: Can): NavSection[] {
  const items = [
    { to: '/', label: 'Apps', resource: 'app_distribution',
      icon: icon(<><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>) },
    { to: '/devices', label: 'Devices', resource: 'app_distribution',
      icon: icon(<><rect x="7" y="2.5" width="10" height="19" rx="2.2" /><path d="M11 18.5h2" /></>) },
  ];
  if (can('app_distribution', 'change')) {
    items.push({ to: '/apple', label: 'Apple settings', resource: 'app_distribution',
      icon: icon(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>) });
  }
  return [{
    label: SECTION_LABEL,
    icon: icon(<><rect x="3" y="4" width="13" height="10" rx="1.5" /><path d="M7 18h5" /><rect x="15.5" y="9" width="5.5" height="11" rx="1.3" /></>),
    items,
  }];
}

/** The nav item a path belongs to: an app's detail page sits under Apps. */
export function pageForPath(section: NavSection, pathname: string) {
  return section.items.find((item) => (item.to === '/'
    ? pathname === '/' || pathname.startsWith('/apps/')
    : pathname === item.to || pathname.startsWith(`${item.to}/`)));
}
