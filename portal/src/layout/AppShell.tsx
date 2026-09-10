/**
 * Portal shell — collapsible left nav (expanded accordion / icon rail with
 * a flyout / hidden-with-overlay, one section open at a time in the
 * accordion, fibertrace-style), topbar (crumbs / search / AI /
 * notifications / ⌘K), user chip with account menu, and the command
 * palette. The nav's own markup lives in NavPanel.tsx; this file owns mode
 * state (preference + viewport), the overlay, the rail flyout, the
 * account menu, and the Ctrl/⌘+B shortcut.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import CommandPalette from '../components/CommandPalette';
import SystemBanners from '../components/SystemBanners';
import ToastHost from '../components/ToastHost';
import Topbar from '../components/Topbar';
import { isNavItemVisible } from '../lib/godmode';
import { applyPreferences, nextNavMode, type NavMode } from '../lib/settings';
import { TopbarProvider, useTopbar } from '../lib/topbar';
import NavPanel from './NavPanel';
import { NAV_SECTIONS, type NavSection } from './navSections';
import '../styles/portal-theme.css';
import '../styles/chrome.css';

const MOBILE_QUERY = '(max-width: 900px)';
const MODE_LABEL: Record<NavMode, string> = { expanded: 'Collapse', rail: 'Hide', hidden: 'Expand' };

function sectionForPath(sections: NavSection[], pathname: string): string {
  for (const s of sections) {
    if (s.items.some((i) => (i.to === '/' ? pathname === '/' : pathname.startsWith(i.to)))) {
      return s.label;
    }
  }
  return sections[0]?.label ?? '';
}

function initials(name: string | undefined): string {
  if (!name) return '·';
  return name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
}

function ChipAvatar({ name, url }: { name?: string; url?: string | null }) {
  return (
    <div className="user-avatar">
      {url ? <img src={url} alt="" /> : initials(name)}
    </div>
  );
}

/** jsdom-safe: matchMedia is absent in some test environments. */
function matchesMobile(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.target;
  if (!(t instanceof Element)) return false;
  return !!t.closest('input, textarea, select, [contenteditable]');
}

export default function AppShell({ children }: { children: ReactNode }) {
  return (
    <TopbarProvider>
      <AppShellInner>{children}</AppShellInner>
    </TopbarProvider>
  );
}

function AppShellInner({ children }: { children: ReactNode }) {
  const { person, roles, logout, preferences, updatePreferences, can, godMode, godNavColor, exitGodMode, maxRank, scope } = useAuth();
  const { setLeading, paletteOpen } = useTopbar();
  const navigate = useNavigate();
  const location = useLocation();
  const isGlobal = scope?.global ?? true;
  const visibleSections = NAV_SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((i) => isNavItemVisible(i, can, godMode, maxRank, isGlobal)) }))
    .filter((s) => s.items.length > 0);

  const [mobile, setMobile] = useState(matchesMobile);
  const mode: NavMode = mobile ? 'hidden' : preferences.nav_mode;

  const [menuOpen, setMenuOpen] = useState(false);
  const [openSection, setOpenSection] = useState(() =>
    mode === 'rail' ? '' : sectionForPath(visibleSections, location.pathname));
  const [overlayOpen, setOverlayOpen] = useState(false);

  // account preferences arrive with the session — apply on mount and on change
  useEffect(() => { applyPreferences(preferences); }, [preferences]);

  // viewport crosses the mobile breakpoint — the nav behaves as hidden
  // regardless of the stored preference; the preference itself is untouched.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = () => setMobile(mq.matches);
    onChange();
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  }, []);

  // navigating into a section opens it in the accordion (rail's flyout is a
  // separate, click-driven concept — it does not track the route).
  useEffect(() => {
    if (mode === 'rail') return;
    setOpenSection(sectionForPath(visibleSections, location.pathname));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, mode]);

  // overlay only makes sense in hidden mode — close it the moment the mode
  // changes away (toggle, preference change, or the viewport widening back out).
  useEffect(() => {
    if (mode !== 'hidden') setOverlayOpen(false);
  }, [mode]);

  // hamburger — Topbar renders whatever AppShell hands it via `leading`,
  // with no nav-mode awareness of its own.
  useEffect(() => {
    setLeading(mode === 'hidden' ? (
      <button
        type="button"
        className="icon-btn nav-hamburger"
        aria-label="Open navigation"
        onClick={() => setOverlayOpen(true)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>
    ) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // user menu closes on outside click or Escape
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

  // rail flyout closes on outside click
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

  // overlay + rail flyout close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOverlayOpen(false);
      if (mode === 'rail') setOpenSection('');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [mode]);

  const cycleMode = () => {
    void updatePreferences({ ...preferences, nav_mode: nextNavMode(preferences.nav_mode) });
  };

  // Ctrl/⌘+B — cycles the mode, or in hidden mode toggles the overlay.
  // Ignored while typing, or while the command palette is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'b') return;
      if (paletteOpen || isTypingTarget(e)) return;
      e.preventDefault();
      if (mode === 'hidden') {
        setOverlayOpen((v) => !v);
        return;
      }
      cycleMode();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, paletteOpen, preferences]);

  const toggleSection = (label: string) => setOpenSection((cur) => (cur === label ? '' : label));

  const handleNavigate = () => {
    setOpenSection((s) => (mode === 'rail' ? '' : s));
    setOverlayOpen(false);
  };

  const go = (to: string) => {
    setMenuOpen(false);
    navigate(to);
  };

  const handleLogout = async () => {
    setMenuOpen(false);
    await logout();
    navigate('/login', { replace: true });
  };

  const footer = (
    <>
      {godMode && (
        <button className="god-exit" type="button" onClick={exitGodMode}>
          Exit god mode
        </button>
      )}
      <button
        type="button"
        className="nav-toggle"
        aria-label={MODE_LABEL[preferences.nav_mode]}
        onClick={cycleMode}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 4v16M4 4h16v16H4z" />
        </svg>
        <span className="nav-toggle-label">{MODE_LABEL[preferences.nav_mode]}</span>
      </button>
      <div className="user-wrap">
        {menuOpen && (
          <div className="user-menu" role="menu">
            <div className="um-head">
              <ChipAvatar name={person?.display_name} url={person?.avatar_url} />
              <div className="user-meta">
                <div className="user-name">{person?.display_name}</div>
                <div className="user-role">{person?.email ?? roles.join(' · ')}</div>
              </div>
            </div>
            <button className="um-item" role="menuitem" onClick={() => go('/me')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                   strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
              </svg>
              My profile &amp; details
            </button>
            <button className="um-item" role="menuitem" onClick={() => go('/settings')}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                   strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3" />
                <path d="M1 14h6M9 8h6M17 16h6" />
              </svg>
              Settings
            </button>
            <div className="um-sep" />
            <button className="um-item danger" role="menuitem" onClick={handleLogout}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                   strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <path d="M16 17l5-5-5-5M21 12H9" />
              </svg>
              Sign out
            </button>
          </div>
        )}
        <button
          className={`user-chip ${menuOpen ? 'open' : ''}`}
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <ChipAvatar name={person?.display_name} url={person?.avatar_url} />
          <div className="user-meta">
            <div className="user-name">{person?.display_name}</div>
            <div className="user-role">{roles.join(' · ') || '—'}</div>
          </div>
          <svg className="chip-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m8 15 4-4 4 4" />
          </svg>
        </button>
      </div>
    </>
  );

  return (
    <>
      <div className="portal-shell">
        <NavPanel
          className="docked"
          mode={mode}
          sections={visibleSections}
          openSection={openSection}
          onToggleSection={toggleSection}
          onNavigate={handleNavigate}
          footer={footer}
          godMode={godMode}
          godNavColor={godNavColor}
        />

        {overlayOpen && (
          <>
            <div className="nav-overlay-scrim" onClick={() => setOverlayOpen(false)} />
            <NavPanel
              className="overlay"
              mode="expanded"
              sections={visibleSections}
              openSection={openSection}
              onToggleSection={toggleSection}
              onNavigate={handleNavigate}
              footer={footer}
              godMode={godMode}
              godNavColor={godNavColor}
            />
          </>
        )}

        <div className="portal-main-col">
          <SystemBanners />
          <ToastHost />
          <Topbar />
          <main className="portal-main">{children}</main>
        </div>
      </div>
      <CommandPalette />
    </>
  );
}
