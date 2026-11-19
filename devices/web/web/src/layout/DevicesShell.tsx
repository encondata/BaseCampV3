/** The signed-in devices app in the portal's shell (modeled on the
 *  portal's AppShell, without its search, notifications or god mode): the
 *  portal's NavPanel docked on the left (tag "Devices", one section), the
 *  user chip and its menu in the nav's footer, the top bar, and the routed
 *  page in `.portal-main`. Rendered inside ThemedRoot's `.portal-shell`,
 *  whose `data-nav-mode` applyPreferences sets from the user's nav_mode
 *  preference: expanded or rail on desktop. At the portal's mobile
 *  breakpoint (or with the hidden preference) the nav hides and the
 *  hamburger opens it as an overlay (the scrim, Escape and following a
 *  link close it). */
import { useEffect, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import SystemBanners from '@portal/components/SystemBanners';
import NavPanel from '@portal/layout/NavPanel';
import { initials } from '@portal/lib/format';
import type { NavMode } from '@portal/lib/settings';

import { portalOrigin } from '../lib/origins';
import { devicesNavSections, SECTION_LABEL } from './devicesNav';
import DevicesTopbar from './DevicesTopbar';

const MOBILE_QUERY = '(max-width: 900px)';

/** jsdom-safe: matchMedia is absent in some test environments. */
function matchesMobile(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(MOBILE_QUERY).matches;
}

/** A line icon in the portal's style: one 24×24 stroke path. */
function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
  );
}

export default function DevicesShell() {
  const { person, roles, can, preferences, logout } = useAuth();
  const navigate = useNavigate();
  const sections = devicesNavSections(can);

  const [mobile, setMobile] = useState(matchesMobile);
  const mode: NavMode = mobile ? 'hidden' : preferences.nav_mode;
  // the rail opens a section as a flyout on click only, never by itself
  const [openSection, setOpenSection] = useState(mode === 'rail' ? '' : SECTION_LABEL);
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // the viewport crossing the mobile breakpoint hides or docks the nav
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    onChange();
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  // entering the rail closes the section; leaving it opens it again. The
  // overlay only exists while the nav is hidden.
  useEffect(() => {
    setOpenSection(mode === 'rail' ? '' : SECTION_LABEL);
    if (mode !== 'hidden') setOverlayOpen(false);
  }, [mode]);

  // Escape closes the overlay and the rail's flyout
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOverlayOpen(false);
      if (mode === 'rail') setOpenSection('');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode]);

  // the rail's flyout closes on an outside click
  useEffect(() => {
    if (mode !== 'rail' || !openSection) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest('.nav-flyout') || e.target.closest('.nav-sec-head')) return;
      setOpenSection('');
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [mode, openSection]);

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
    try {
      await logout();
    } catch {
      // offline: the server couldn't be told, but the session still ends here
    } finally {
      navigate('/login', { replace: true });
    }
  };

  const name = person?.display_name ?? '';
  const role = roles.join(' · ') || '—';
  const avatar = (
    <div className="user-avatar">
      {person?.avatar_url ? <img src={person.avatar_url} alt="" /> : (initials(name) || '·')}
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
              <div className="user-role">{person?.email ?? role}</div>
            </div>
          </div>
          <a className="um-item" role="menuitem" href={portalOrigin()}>
            <Icon d="M19 12H5M11 6l-6 6 6 6" />
            Back to portal
          </a>
          <div className="um-sep" />
          <button type="button" className="um-item danger" role="menuitem" onClick={() => void signOut()}>
            <Icon d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
            Sign out
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
    onToggleSection: (label: string) => setOpenSection((cur) => (cur === label ? '' : label)),
    onNavigate: () => {
      setOverlayOpen(false);
      if (mode === 'rail') setOpenSection('');
    },
    footer,
    tag: 'Devices',
  };

  return (
    <>
      <NavPanel className="docked" mode={mode} {...panel} />
      {overlayOpen && (
        <>
          <div className="nav-overlay-scrim" onClick={() => setOverlayOpen(false)} />
          <NavPanel className="overlay" mode="expanded" {...panel} />
        </>
      )}
      <div className="portal-main-col">
        <SystemBanners />
        <DevicesTopbar section={sections[0]} onOpenNav={mode === 'hidden' ? () => setOverlayOpen(true) : null} />
        <main className="portal-main">
          <Outlet />
        </main>
      </div>
    </>
  );
}
