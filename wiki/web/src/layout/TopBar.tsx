/** The wiki's top bar: the wiki mark, the space switcher, the search box
 *  (⌘K / Ctrl+K focuses it; searching itself arrives with Task 15), the
 *  New menu, and the avatar menu (Back to portal, Sign out). */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { avatarGradient, initials } from '@portal/lib/format';

import { portalOrigin } from '../lib/origins';
import type { MeOut, SpaceOut } from '../lib/types';
import { clearWikiMe } from '../lib/useWikiMe';
import SpaceSwitcher from './SpaceSwitcher';

interface Props {
  me: MeOut | null;
  spaces: SpaceOut[] | null;
  currentSpace: SpaceOut | null;
  sidebarCollapsed: boolean;
  onShowSidebar: () => void;
  /** null when there's nowhere to create (no space yet, or no edit access). */
  onNew: ((kind: 'page' | 'folder') => void) | null;
}

/** Closes a popover on an outside mousedown or Escape. */
function usePopover(): [boolean, (v: boolean) => void, RefObject<HTMLDivElement>] {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
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
  return [open, setOpen, ref];
}

function MenuItem({ icon, children, onClick, disabled, hint }: {
  icon: ReactNode; children: ReactNode; onClick?: () => void; disabled?: boolean; hint?: string;
}) {
  return (
    <button type="button" role="menuitem" className="pop-item" onClick={onClick} disabled={disabled} title={hint}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icon}</svg>
      {children}
    </button>
  );
}

export default function TopBar({ me, spaces, currentSpace, sidebarCollapsed, onShowSidebar, onNew }: Props) {
  const { person, logout } = useAuth();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [newOpen, setNewOpen, newRef] = usePopover();
  const [userOpen, setUserOpen, userRef] = usePopover();
  const name = person?.display_name ?? me?.person.name ?? '';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const pick = (kind: 'page' | 'folder') => { setNewOpen(false); onNew?.(kind); };

  const signOut = async () => {
    setUserOpen(false);
    clearWikiMe();
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <header className="topbar wiki-topbar">
      {sidebarCollapsed && (
        <button type="button" className="icon-btn" aria-label="Show sidebar" data-tip="Show sidebar (Ctrl/⌘+B)"
                onClick={onShowSidebar}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M9 4.5v15M13 10l2 2-2 2" />
          </svg>
        </button>
      )}
      <Link to="/" className="wiki-mark" aria-label="ServerSherpa Wiki home">
        <img src="/images/serversherpa-logo.png" alt="" className="wiki-mark-img"
             onError={(e) => { e.currentTarget.style.display = 'none'; }} />
        <span className="wiki-mark-text">
          <span className="wiki-mark-name">Server<em>Sherpa</em></span>
          <span className="wiki-mark-tag">Wiki</span>
        </span>
      </Link>

      <SpaceSwitcher spaces={spaces} current={currentSpace} />

      <div className="tb-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input ref={searchRef} type="search" placeholder="Search the wiki…" aria-label="Search the wiki" />
        <kbd>⌘K</kbd>
      </div>

      <div className="tb-actions">
        <div className="pop-wrap" ref={newRef}>
          <button type="button" className="btn-solid wiki-new-btn" aria-haspopup="menu" aria-expanded={newOpen}
                  onClick={() => setNewOpen(!newOpen)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round" aria-hidden="true" width="14" height="14"><path d="M12 5v14M5 12h14" /></svg>
            New
          </button>
          {newOpen && (
            <div className="pop-menu" role="menu" aria-label="New">
              <MenuItem icon={<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>}
                        onClick={() => pick('page')} disabled={!onNew}
                        hint={onNew ? undefined : 'Open a space you can edit first'}>Page</MenuItem>
              <MenuItem icon={<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />}
                        onClick={() => pick('folder')} disabled={!onNew}
                        hint={onNew ? undefined : 'Open a space you can edit first'}>Folder</MenuItem>
              <MenuItem icon={<path d="M12 16V4M7 9l5-5 5 5M5 20h14" />} disabled hint="Uploads are coming soon">
                Upload files
              </MenuItem>
              {me?.can_create_spaces && (
                <>
                  <div className="pop-sep" />
                  <MenuItem icon={<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><path d="M17 14v6M14 17h6" /></>}
                            onClick={() => { setNewOpen(false); navigate('/spaces/new'); }}>Space</MenuItem>
                </>
              )}
            </div>
          )}
        </div>

        <div className="pop-wrap" ref={userRef}>
          <button type="button" className="wiki-avatar-btn" aria-label="Account menu" aria-haspopup="menu"
                  aria-expanded={userOpen} onClick={() => setUserOpen(!userOpen)}
                  style={{ background: person?.avatar_url ? undefined : avatarGradient(name || '?') }}>
            {person?.avatar_url ? <img src={person.avatar_url} alt="" /> : initials(name || '?')}
          </button>
          {userOpen && (
            <div className="pop-menu" role="menu" aria-label="Account">
              <div className="pop-title">{name || 'Signed in'}</div>
              <a role="menuitem" className="pop-item" href={portalOrigin()}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                     strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
                Back to portal
              </a>
              <div className="pop-sep" />
              <MenuItem icon={<><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5M21 12H9" /></>}
                        onClick={() => void signOut()}>Sign out</MenuItem>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
