/**
 * Topbar — crumbs, GLOBAL search (as-you-type dropdown over pages +
 * records, click-through to the record), AI (coming soon), notifications,
 * and the ⌘K commands button. Hotkeys per fibertrace search-and-hotkeys.md.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { apiFetch } from '../lib/api';
import { avatarGradient, initials } from '../lib/format';
import { useTopbar } from '../lib/topbar';

const CRUMBS: Record<string, string[]> = {
  '/': ['Dashboards', 'Main Dashboard'],
  '/dashboards/move': ['Dashboards', 'Move Dashboard'],
  '/dashboards/people': ['Dashboards', 'People Dashboard'],
  '/dashboards/clients': ['Dashboards', 'Client Dashboard'],
  '/assets': ['Assets', 'Assets'],
  '/logistics/containers': ['Logistics', 'Containers'],
  '/logistics/trucks': ['Logistics', 'Trucks / Shipments'],
  '/logistics/warehouse': ['Logistics', 'Warehouse'],
  '/sites': ['Sites', 'Sites'],
  '/people/users': ['People', 'Users'],
  '/people/workers': ['People', 'Workers'],
  '/people/time': ['People', 'Time Management'],
  '/stakeholders/clients': ['Stakeholders', 'Clients'],
  '/stakeholders/partners': ['Stakeholders', 'Partners'],
  '/admin/asset-models': ['Admin', 'Makes / Models'],
  '/admin/status-rules': ['Admin', 'Status rules'],
  '/settings': ['System', 'Settings'],
  '/system/notifications': ['System', 'Notifications'],
  '/me': ['Account', 'My profile'],
  '/dev': ['Portal', 'Developer tools'],
  '/dev/database/variables': ['Portal', 'Developer tools', 'Database', 'Variables'],
};

const G_CHORD: Record<string, string> = {
  d: '/', u: '/people/users', s: '/settings', p: '/me',
};

const PAGES = [
  { label: 'Main Dashboard', to: '/' },
  { label: 'Move Dashboard', to: '/dashboards/move' },
  { label: 'People Dashboard', to: '/dashboards/people' },
  { label: 'Client Dashboard', to: '/dashboards/clients' },
  { label: 'Assets', to: '/assets' },
  { label: 'Initiatives', to: '/initiatives' },
  { label: 'Containers', to: '/logistics/containers' },
  { label: 'Sites', to: '/sites' },
  { label: 'Users', to: '/people/users' },
  { label: 'Workers', to: '/people/workers' },
  { label: 'Time Management', to: '/people/time' },
  { label: 'Clients', to: '/stakeholders/clients' },
  { label: 'Partners', to: '/stakeholders/partners' },
  { label: 'Makes / Models', to: '/admin/asset-models' },
  { label: 'Status rules', to: '/admin/status-rules' },
  { label: 'Settings', to: '/settings' },
  { label: 'Notifications', to: '/system/notifications' },
  { label: 'My profile', to: '/me' },
];

interface Hit {
  kind: 'page' | 'user' | 'client' | 'partner' | 'site' | 'asset' | 'asset_model' | 'container' | 'initiative';
  id: string;
  label: string;
  sub?: string | null;
  to?: string;
}

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  return !!t?.closest('input, textarea, [contenteditable]');
}

export default function Topbar() {
  const { setPaletteOpen, searchRef } = useTopbar();
  const location = useLocation();
  const navigate = useNavigate();
  const [pop, setPop] = useState<'ai' | 'notif' | null>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const gPrime = useRef(0);

  // ── global search state ──────────────────────────────────
  const [q, setQ] = useState('');
  const [serverHits, setServerHits] = useState<Hit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const searchWrapRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const trail = CRUMBS[location.pathname] ?? ['Portal'];

  // fetch record hits as you type (debounced)
  useEffect(() => {
    clearTimeout(debounceRef.current);
    const needle = q.trim();
    if (needle.length < 2) {
      setServerHits([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const resp = await apiFetch(`/search?q=${encodeURIComponent(needle)}`);
        if (resp.ok) {
          const body = await resp.json() as { results: Hit[] };
          setServerHits(body.results);
        }
      } catch { /* network hiccup — keep previous hits */ }
    }, 150);
    return () => clearTimeout(debounceRef.current);
  }, [q]);

  const hits = useMemo<Hit[]>(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    const pages: Hit[] = PAGES
      .filter((p) => p.label.toLowerCase().includes(needle))
      .map((p) => ({ kind: 'page', id: p.to, label: p.label, to: p.to }));
    return [...pages, ...serverHits];
  }, [q, serverHits]);

  useEffect(() => { setActive(0); }, [hits.length, q]);

  const select = (hit: Hit) => {
    setOpen(false);
    setQ('');
    searchRef.current?.blur();
    if (hit.kind === 'page' && hit.to) {
      navigate(hit.to);
    } else if (hit.kind === 'user') {
      navigate('/people/users', { state: { openRow: hit.id } });
    } else if (hit.kind === 'client') {
      // Clients have a full detail page — go straight there, not the list.
      navigate(`/stakeholders/clients/${hit.id}`);
    } else if (hit.kind === 'partner') {
      // Partners have a full detail page — go straight there, not the list.
      navigate(`/stakeholders/partners/${hit.id}`);
    } else if (hit.kind === 'site') {
      // Sites have a full detail page — go straight there, not the list.
      navigate(`/sites/${hit.id}`);
    } else if (hit.kind === 'asset') {
      navigate('/assets', { state: { openRow: hit.id } });
    } else if (hit.kind === 'container') {
      navigate('/logistics/containers', { state: { openRow: hit.id } });
    } else if (hit.kind === 'initiative') {
      // Initiatives have a full detail page — go straight there, not the
      // list. Other kinds follow as their detail pages get built.
      navigate(`/initiatives/${hit.id}`);
    } else if (hit.kind === 'asset_model') {
      navigate('/admin/asset-models', { state: { openRow: hit.id } });
    }
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(hits.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + hits.length) % Math.max(hits.length, 1));
    } else if (e.key === 'Enter' && hits[active]) {
      select(hits[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      searchRef.current?.blur();
    }
  };

  // close the dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!searchWrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  // global hotkeys: ⌘K palette, / focus search, Esc, g-chord nav
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape') {
        setPop(null);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;

      if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (e.key === 'g') {
        gPrime.current = Date.now();
        return;
      }
      if (gPrime.current && Date.now() - gPrime.current < 800 && G_CHORD[e.key]) {
        navigate(G_CHORD[e.key]);
      }
      gPrime.current = 0;
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [navigate, setPaletteOpen, searchRef]);

  // close popovers on outside click
  useEffect(() => {
    if (!pop) return;
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setPop(null);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [pop]);

  const showResults = open && q.trim().length > 0;
  let lastKind: string | null = null;

  return (
    <header className="topbar">
      <div className="crumbs">
        {trail.map((part, i) => (
          // key by position: a section and page can share a name ("Assets / Assets")
          <span key={`${i}-${part}`} style={{ display: 'contents' }}>
            {i > 0 && <span className="crumb-sep">/</span>}
            {i === trail.length - 1 ? <b>{part}</b> : <span>{part}</span>}
          </span>
        ))}
      </div>

      <div className="tb-search" ref={searchWrapRef}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input
          ref={searchRef}
          value={q}
          placeholder="Search everywhere…"
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={onSearchKey}
        />
        <kbd>/</kbd>

        {showResults && (
          <div className="tb-results">
            {hits.length === 0 && (
              <div className="pop-empty">No matches for “{q.trim()}”.</div>
            )}
            {hits.map((h, i) => {
              const GROUPS: Record<string, string> = {
                page: 'Pages', user: 'People', client: 'Clients', partner: 'Partners',
                site: 'Sites', asset: 'Assets', asset_model: 'Makes / Models',
                container: 'Containers',
              };
              const header = h.kind !== lastKind ? (
                <div className="kbar-group">{GROUPS[h.kind]}</div>
              ) : null;
              lastKind = h.kind;
              return (
                <span key={`${h.kind}:${h.id}`} style={{ display: 'contents' }}>
                  {header}
                  <button
                    className={`kbar-item ${i === active ? 'active' : ''}`}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => { e.preventDefault(); select(h); }}
                  >
                    <span className="ic">
                      {h.kind === 'user' ? (
                        <span style={{
                          width: '100%', height: '100%', borderRadius: 'inherit',
                          display: 'grid', placeItems: 'center', color: '#fff',
                          fontSize: 10.5, fontWeight: 600,
                          background: avatarGradient(h.label),
                        }}>
                          {initials(h.label)}
                        </span>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M5 12h14M13 6l6 6-6 6" />
                        </svg>
                      )}
                    </span>
                    {h.label}
                    {h.sub && <span className="sub">{h.sub}</span>}
                  </button>
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div className="tb-actions" ref={popRef}>
        <div className="pop-wrap">
          <button className="icon-btn ai-glow" title="AI assistant (coming soon)"
                  onClick={() => setPop(pop === 'ai' ? null : 'ai')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v2M12 19v2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M3 12h2M19 12h2M5.6 18.4 7 17M17 7l1.4-1.4" />
              <circle cx="12" cy="12" r="4" />
            </svg>
          </button>
          {pop === 'ai' && (
            <div className="pop-menu">
              <div className="pop-title">AI Assistant</div>
              <div className="pop-empty">
                Ask-the-portal AI is coming soon — natural-language answers
                about your moves, assets, and people.
              </div>
            </div>
          )}
        </div>

        <div className="pop-wrap">
          <button className="icon-btn" title="Notifications"
                  onClick={() => setPop(pop === 'notif' ? null : 'notif')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                 strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
              <path d="M13.7 21a2 2 0 0 1-3.4 0" />
            </svg>
          </button>
          {pop === 'notif' && (
            <div className="pop-menu">
              <div className="pop-title">Notifications</div>
              <div className="pop-empty">
                You're all caught up. Notification delivery lands with the
                notification service.
              </div>
            </div>
          )}
        </div>

        <button className="icon-btn" title="Command palette (⌘K)"
                onClick={() => setPaletteOpen((v) => !v)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
               strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
          </svg>
        </button>
      </div>
    </header>
  );
}
