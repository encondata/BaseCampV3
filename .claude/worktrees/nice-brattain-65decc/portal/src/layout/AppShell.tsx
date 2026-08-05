/**
 * Portal shell — collapsible accordion left nav (one section open at a
 * time, fibertrace-style), topbar (crumbs / search / AI / notifications /
 * ⌘K), user chip with account menu, and the command palette.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import CommandPalette from '../components/CommandPalette';
import Topbar from '../components/Topbar';
import { applyPreferences } from '../lib/settings';
import { TopbarProvider } from '../lib/topbar';
import '../styles/portal-theme.css';
import '../styles/chrome.css';

interface NavItem { to: string; label: string; resource: string; icon: ReactNode }
interface NavSection { label: string; items: NavItem[] }

const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Operations',
    items: [
      {
        to: '/',
        label: 'Dashboard',
        resource: 'dashboard',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="7" height="9" rx="1.5" />
            <rect x="14" y="3" width="7" height="5" rx="1.5" />
            <rect x="14" y="12" width="7" height="9" rx="1.5" />
            <rect x="3" y="16" width="7" height="5" rx="1.5" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'People',
    items: [
      {
        to: '/people/users',
        label: 'Users',
        resource: 'users',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
            <circle cx="9.5" cy="7" r="4" />
            <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
        ),
      },
      {
        to: '/people/workers',
        label: 'Workers',
        resource: 'workers',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 18a10 10 0 0 1 20 0Z" />
            <path d="M9 9V4.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 4.5V9" />
            <path d="M2 18h20" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Stakeholders',
    items: [
      {
        to: '/stakeholders/clients',
        label: 'Clients',
        resource: 'clients',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="7" width="20" height="14" rx="2" />
            <path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
          </svg>
        ),
      },
      {
        to: '/stakeholders/partners',
        label: 'Partners',
        resource: 'partners',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 17 7.5 20.5a2.1 2.1 0 0 1-3-3L8 14" />
            <path d="m14 7 4.9-4.9a2.1 2.1 0 0 1 3 3L17 10l3 3a2.1 2.1 0 0 1-3 3l-6-6-3.5 3.5a2.1 2.1 0 0 1-3-3L9 6 6 3" />
          </svg>
        ),
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        to: '/access',
        label: 'Access control',
        resource: 'access',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
        ),
      },
      {
        to: '/settings',
        label: 'Settings',
        resource: 'settings',
        icon: (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
               strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
          </svg>
        ),
      },
    ],
  },
];

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

export default function AppShell({ children }: { children: ReactNode }) {
  const { person, roles, logout, preferences, can } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const visibleSections = NAV_SECTIONS
    .map((s) => ({ ...s, items: s.items.filter((i) => can(i.resource, 'view')) }))
    .filter((s) => s.items.length > 0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [openSection, setOpenSection] = useState(() => sectionForPath(visibleSections, location.pathname));
  const menuWrapRef = useRef<HTMLDivElement>(null);

  // account preferences arrive with the session — apply on mount and on change
  useEffect(() => { applyPreferences(preferences); }, [preferences]);

  // navigating into a section opens it (and closes the others)
  useEffect(() => {
    setOpenSection(sectionForPath(visibleSections, location.pathname));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // user menu closes on outside click or Escape
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuWrapRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const go = (to: string) => {
    setMenuOpen(false);
    navigate(to);
  };

  const handleLogout = async () => {
    setMenuOpen(false);
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <TopbarProvider>
      <div className="portal-shell">
        <nav className="portal-nav" aria-label="Primary">
          <div className="logo">
            <img
              className="logo-mark"
              src="/images/serversherpa-logo.png"
              alt=""
              onError={(e) => { e.currentTarget.style.display = 'none'; }}
            />
            <div>
              <div className="logo-name">Server<em>Sherpa</em></div>
              <div className="logo-tag">Portal</div>
            </div>
          </div>

          <ul className="nav-list">
            {visibleSections.map((section) => {
              const open = openSection === section.label;
              return (
                <li className={`nav-sec ${open ? 'open' : ''}`} key={section.label}>
                  <button
                    className="nav-sec-head"
                    aria-expanded={open}
                    onClick={() => setOpenSection(open ? '' : section.label)}
                  >
                    {section.label}
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                         strokeLinecap="round" strokeLinejoin="round"><path d="m9 6 6 6-6 6" /></svg>
                  </button>
                  <div className="nav-sec-body">
                    <div className="nav-sec-clip">
                      <ul className="nav-list">
                        {section.items.map((item) => (
                          <li className="nav-item" key={item.to}>
                            <NavLink to={item.to} end={item.to === '/'}>
                              {item.icon}
                              {item.label}
                            </NavLink>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          <div className="user-wrap" ref={menuWrapRef}>
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
        </nav>

        <div className="portal-main-col">
          <Topbar />
          <main className="portal-main">{children}</main>
        </div>
      </div>
      <CommandPalette />
    </TopbarProvider>
  );
}
