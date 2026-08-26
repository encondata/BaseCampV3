/**
 * Command palette (⌘K) — Navigate / Actions / People groups, substring
 * filter, full keyboard control. Ref: fibertrace search-and-hotkeys.md §3.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext';
import { apiFetch, unlockGodMode } from '../lib/api';
import { avatarGradient, initials } from '../lib/format';
import { isNavItemVisible } from '../lib/godmode';
import { useTopbar } from '../lib/topbar';

interface Command {
  group: string;
  label: string;
  sub?: string;
  icon: ReactNode;
  run: () => void;
}

interface PaletteUser {
  person_id: string;
  display_name: string;
  login_email: string | null;
  job_title: string | null;
}

const NAV_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
const ACTION_ICON = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
);

export default function CommandPalette() {
  const { paletteOpen, setPaletteOpen } = useTopbar();
  const { can, preferences, updatePreferences, godMode, enableGodMode, maxRank } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [users, setUsers] = useState<PaletteUser[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!paletteOpen) return;
    setQ('');
    setActive(0);
    const t = setTimeout(() => inputRef.current?.focus(), 50);
    if (can('users', 'view')) {
      void apiFetch('/users').then(async (r) => {
        if (r.ok) setUsers(await r.json());
      }).catch(() => {});
    }
    return () => clearTimeout(t);
  }, [paletteOpen, can]);

  const close = () => setPaletteOpen(false);
  const runLater = (fn: () => void) => { close(); setTimeout(fn, 30); };

  const commands = useMemo<Command[]>(() => {
    const nav = (label: string, to: string): Command => ({
      group: 'Navigate', label: `Go to ${label}`, icon: NAV_ICON,
      run: () => navigate(to),
    });
    const navGated = (label: string, to: string, resource: string,
                      godOnly = false): Command[] =>
      isNavItemVisible({ resource, godOnly }, can, godMode, maxRank) ? [nav(label, to)] : [];
    const cmds: Command[] = [
      ...navGated('Dashboard', '/', 'dashboard'),
      ...navGated('Sites', '/sites', 'sites'),
      ...navGated('Assets', '/assets', 'assets'),
      ...navGated('Containers', '/logistics/containers', 'containers'),
      ...navGated('Initiatives', '/initiatives', 'initiatives'),
      ...navGated('Users', '/people/users', 'users'),
      ...navGated('Workers', '/people/workers', 'workers'),
      ...navGated('External', '/people/external', 'users'),
      ...navGated('Clients', '/stakeholders/clients', 'clients'),
      ...navGated('Partners', '/stakeholders/partners', 'partners'),
      ...navGated('Makes / Models', '/admin/asset-models', 'asset_models'),
      ...navGated('Access control', '/access', 'access'),
      ...navGated('Settings', '/settings', 'settings'),
      ...navGated('Developer tools', '/dev', 'devtools', true),
      ...navGated('Database', '/dev/database', 'devtools', true),
      ...navGated('Variables', '/dev/database/variables', 'devtools', true),
      { group: 'Navigate', label: 'View my profile', icon: NAV_ICON, run: () => navigate('/me') },
      ...(can('users', 'add') ? [{
        group: 'Actions', label: 'Add person', sub: 'Users', icon: ACTION_ICON,
        run: () => navigate('/people/users', { state: { openAdd: true } }),
      } as Command] : []),
      {
        group: 'Actions',
        label: `Switch to ${preferences.theme === 'light' ? 'dark' : 'light'} theme`,
        icon: ACTION_ICON,
        run: () => void updatePreferences({
          ...preferences,
          theme: preferences.theme === 'light' ? 'dark' : 'light',
        }),
      },
    ];
    for (const u of users) {
      cmds.push({
        group: 'People',
        label: u.display_name,
        sub: u.job_title ?? u.login_email ?? '',
        icon: (
          <span style={{
            width: '100%', height: '100%', borderRadius: 'inherit', display: 'grid',
            placeItems: 'center', color: '#fff', fontSize: 10.5, fontWeight: 600,
            background: avatarGradient(u.display_name),
          }}>
            {initials(u.display_name)}
          </span>
        ),
        run: () => navigate('/people/users', { state: { openRow: u.person_id } }),
      });
    }
    return cmds;
  }, [users, navigate, preferences, updatePreferences, can, godMode, maxRank]);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.sub ?? ''}`.toLowerCase().includes(needle));
  }, [commands, q]);

  useEffect(() => { setActive(0); }, [q]);

  useEffect(() => {
    listRef.current
      ?.querySelector('.kbar-item.active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!paletteOpen) return null;

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(results.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + results.length) % Math.max(results.length, 1));
    } else if (e.key === 'Enter' && results[active]) {
      runLater(results[active].run);
    } else if (e.key === 'Enter' && !results.length && q.trim()) {
      // The palette's dead path: Enter with no matches. A refusal is silent —
      // the palette keeps showing "no results", exactly as for any other
      // unmatched text. Never surface an error here.
      const word = q.trim();
      void unlockGodMode(word).then((color) => {
        if (color) {
          enableGodMode(color);
          close();
        }
      });
    } else if (e.key === 'Escape') {
      close();
    }
  };

  let lastGroup = '';

  return (
    <div className="kbar-scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) close();
    }}>
      <div className="kbar" onKeyDown={onKey}>
        <div className="kbar-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
          </svg>
          <input ref={inputRef} value={q} placeholder="Search commands and people…"
                 onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="kbar-list" ref={listRef}>
          {results.length === 0 && (
            <div className="kbar-empty">No matches for “{q}”.</div>
          )}
          {results.map((c, i) => {
            const header = c.group !== lastGroup
              ? <div className="kbar-group">{c.group}</div> : null;
            lastGroup = c.group;
            return (
              <span key={`${c.group}:${c.label}:${c.sub ?? ''}`} style={{ display: 'contents' }}>
                {header}
                <button
                  className={`kbar-item ${i === active ? 'active' : ''}`}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => runLater(c.run)}
                >
                  <span className="ic">{c.icon}</span>
                  {c.label}
                  {c.sub && <span className="sub">{c.sub}</span>}
                </button>
              </span>
            );
          })}
        </div>
        <div className="kbar-foot">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
