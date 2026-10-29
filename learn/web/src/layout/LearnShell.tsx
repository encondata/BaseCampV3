/** The signed-in learn site in the portal's shell (modeled on the portal's
 *  AppShell, without its preferences, search or god mode): the portal's
 *  NavPanel docked on the left (tag "Learning", one section), the user
 *  chip and its menu in the nav's footer, the top bar, and the routed page
 *  in `.portal-main`. At the portal's mobile breakpoint the nav hides and
 *  the hamburger opens it as an overlay (the scrim, Escape and following
 *  a link close it). Provides the learner's shared training and history. */
import { useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import NavPanel from '@portal/layout/NavPanel';
import { initials } from '@portal/lib/format';
import { siblingOrigin } from '@portal/lib/siblingOrigin';

import { t, useLang } from '../lib/i18n';
import { LearnerDataProvider, learnerName, useLearnerData } from '../lib/learner';
import { getToken, learnSignOut } from '../lib/session';
import Icon from './Icon';
import { learnNavSections } from './learnNav';
import LearnTopbar from './LearnTopbar';

const MOBILE_QUERY = '(max-width: 900px)';

/** jsdom-safe: matchMedia is absent in some test environments. */
function matchesMobile(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches;
}

/** portal.<domain> beside learn.<domain>; localhost and LAN addresses
 *  fall back to the portal's dev port on the same host. */
function portalOrigin(): string {
  return siblingOrigin('portal', location) ?? `${location.protocol}//${location.hostname}:5173`;
}

export default function LearnShell() {
  return (
    <LearnerDataProvider>
      <Shell />
    </LearnerDataProvider>
  );
}

function Shell() {
  useLang();
  const { person, logout } = useAuth();
  const navigate = useNavigate();
  const { training } = useLearnerData();
  // a learn token wins over an account, as it does for every call
  const account = getToken() ? null : person;
  const role = account ? t('shell.account') : t('shell.codeSession');
  const { full } = learnerName(account);
  // a code session may have no name: the chip says "Learning code" then
  const name = full || role;

  const [mobile, setMobile] = useState(matchesMobile);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  const sections = learnNavSections({ showTimeClock: !!(training.data?.complete && training.data.badge_uid) });
  const openSection = sectionOpen ? sections[0].label : '';

  // the viewport crossing the mobile breakpoint hides or docks the nav
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  useEffect(() => { if (!mobile) setOverlayOpen(false); }, [mobile]);

  // Escape closes the overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOverlayOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // the user menu closes on an outside click or Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.user-wrap')) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const signOut = async () => {
    setMenuOpen(false);
    setOverlayOpen(false);
    if (account) await logout();
    // the token is gone at once (the server revoke needn't hold the page); an
    // account also signed in in this browser then takes over at `/` (accepted)
    else void learnSignOut();
    navigate('/', { replace: true });
  };

  const avatar = (
    <div className="user-avatar">
      {account?.avatar_url ? <img src={account.avatar_url} alt="" /> : (initials(full) || '·')}
    </div>
  );

  const footer = (
    <div className="user-wrap">
      {menuOpen && (
        <div className="user-menu" role="menu">
          <div className="um-head">
            {avatar}
            <div className="user-meta">
              <div className="user-name">{name}</div>
              <div className="user-role">{account?.email ?? role}</div>
            </div>
          </div>
          {account && (
            <>
              <a className="um-item" role="menuitem" href={portalOrigin()}>
                <Icon d="M19 12H5M11 6l-6 6 6 6" />
                {t('shell.backToPortal')}
              </a>
              <div className="um-sep" />
            </>
          )}
          <button type="button" className="um-item danger" role="menuitem" onClick={() => void signOut()}>
            <Icon d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            {t('shell.signOut')}
          </button>
        </div>
      )}
      <button type="button" className={`user-chip ${menuOpen ? 'open' : ''}`} aria-haspopup="menu"
              aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
        {avatar}
        <div className="user-meta">
          <div className="user-name">{name}</div>
          <div className="user-role">{role}</div>
        </div>
        <svg className="chip-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m8 15 4-4 4 4" />
        </svg>
      </button>
    </div>
  );

  const panel = {
    sections,
    openSection,
    onToggleSection: () => setSectionOpen((v) => !v),
    onNavigate: () => setOverlayOpen(false),
    footer,
    tag: t('nav.tag'),
  };

  return (
    <div className="portal-shell learn-shell" data-nav-mode={mobile ? 'hidden' : 'expanded'}>
      <NavPanel className="docked" mode={mobile ? 'hidden' : 'expanded'} {...panel} />
      {overlayOpen && (
        <>
          <div className="nav-overlay-scrim" onClick={() => setOverlayOpen(false)} />
          <NavPanel className="overlay" mode="expanded" {...panel} />
        </>
      )}
      <div className="portal-main-col">
        <LearnTopbar onOpenNav={mobile ? () => setOverlayOpen(true) : null} />
        <main className="portal-main">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
