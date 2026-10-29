/** The learn site's left nav: one "Learning" section, its pages in the
 *  portal's line-icon style. Labels come from `t()`, so call this while
 *  rendering. */
import type { ReactNode } from 'react';

import type { NavSection } from '@portal/layout/navSections';

import { t } from '../lib/i18n';

const icon = (paths: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
       strokeLinecap="round" strokeLinejoin="round">{paths}</svg>
);

export function learnNavSections({ showTimeClock }: { showTimeClock: boolean }): NavSection[] {
  const items = [
    { to: '/home', label: t('nav.home'), resource: 'learn',
      icon: icon(<><path d="M4 11 12 4l8 7" /><path d="M6 9.5V20h12V9.5" /><path d="M10 20v-6h4v6" /></>) },
    { to: '/training', label: t('nav.training'), resource: 'learn',
      icon: icon(<><path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z" /><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z" /></>) },
    { to: '/history', label: t('nav.history'), resource: 'learn',
      icon: icon(<><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12.2 2.4 2.4 4.7-4.9" /></>) },
  ];
  if (showTimeClock) {
    items.push({ to: '/done', label: t('nav.timeClock'), resource: 'learn',
      icon: icon(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>) });
  }
  return [{
    label: t('nav.section'),
    icon: icon(<><path d="m2.5 9 9.5-4.5L21.5 9 12 13.5z" /><path d="M6.5 11v4.5c1.5 1.5 3.5 2.2 5.5 2.2s4-.7 5.5-2.2V11" /><path d="M21.5 9v5" /></>),
    items,
  }];
}
