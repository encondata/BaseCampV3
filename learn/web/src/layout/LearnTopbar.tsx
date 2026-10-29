/** The learn site's top bar, in the portal's `topbar` markup: the
 *  hamburger while the nav is hidden, crumbs (Learning / the page on
 *  screen; a document and its quiz sit under My training) and the
 *  language menu, shown when more than one language is offered. */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { setLang, t, useLang, useOffered } from '../lib/i18n';
import { learnNavSections } from './learnNav';

const Icon = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

function LanguageMenu() {
  const lang = useLang();
  const offered = useOffered();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // closes on an outside click or Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (offered.length < 2) return null;
  return (
    <div className="pop-wrap" ref={ref}>
      <button type="button" className="icon-btn" aria-label={t('shell.language')} data-tip={t('shell.language')}
              aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <Icon d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
      </button>
      {open && (
        <div className="pop-menu learn-lang-menu" role="menu" aria-label={t('shell.language')}>
          {offered.map((l) => (
            <button key={l.code} type="button" role="menuitemradio" aria-checked={l.code === lang} lang={l.code}
                    className={`pop-item ${l.code === lang ? 'on' : ''}`}
                    onClick={() => { setLang(l.code); setOpen(false); }}>
              <span className="pop-check" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5"
                     strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
              </span>
              {l.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function LearnTopbar({ onOpenNav }: { onOpenNav: (() => void) | null }) {
  useLang();
  const { pathname } = useLocation();
  const [section] = learnNavSections({ showTimeClock: true });
  const page = section.items.find((item) => pathname.startsWith(item.to));

  return (
    <header className="topbar">
      {onOpenNav && (
        <button type="button" className="icon-btn nav-hamburger" aria-label={t('nav.open')} onClick={onOpenNav}>
          <Icon d="M4 7h16M4 12h16M4 17h16" />
        </button>
      )}
      <div className="crumbs">
        {page ? <span>{section.label}</span> : <b>{section.label}</b>}
        {page && <><span className="crumb-sep">/</span><b>{page.label}</b></>}
      </div>
      <div className="tb-actions">
        <LanguageMenu />
      </div>
    </header>
  );
}
