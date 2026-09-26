/** The wiki's top bar: the wiki mark, the library switcher, the search box
 *  (instant results, ⌘K / Ctrl+K focuses it — see SearchBox.tsx), Reviews
 *  (with a count of the reviews waiting on me — see ReviewsLink.tsx), the
 *  New menu (Page, Folder, Upload files, Library), and the avatar menu
 *  (Analytics for wiki admins and library managers, Back to portal, Sign
 *  out). */
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode, type RefObject } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { avatarGradient, initials } from '@portal/lib/format';

import { portalOrigin } from '../lib/origins';
import { clearSessionCaches } from '../lib/sessionCaches';
import { NEW_LIBRARY_PATH } from '../lib/paths';
import type { MeOut, SpaceOut } from '../lib/types';
import ReviewsLink from '../reviews/ReviewsLink';
import SearchBox from '../search/SearchBox';
import SpaceSwitcher from './SpaceSwitcher';

interface Props {
  me: MeOut | null;
  spaces: SpaceOut[] | null;
  currentSpace: SpaceOut | null;
  sidebarCollapsed: boolean;
  onShowSidebar: () => void;
  /** null when there's nowhere to create (no space yet, or no edit access). */
  onNew: ((kind: 'page' | 'folder') => void) | null;
  /** Opens a new page straight on the template picker; null when there's nowhere to create. */
  onNewFromTemplate: (() => void) | null;
  /** Uploads picked files where New would create; null when there's nowhere to. */
  onUpload: ((files: File[]) => void) | null;
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

export default function TopBar({
  me, spaces, currentSpace, sidebarCollapsed, onShowSidebar, onNew, onNewFromTemplate, onUpload,
}: Props) {
  const { person, logout } = useAuth();
  const navigate = useNavigate();
  const uploadRef = useRef<HTMLInputElement>(null);
  const [newOpen, setNewOpen, newRef] = usePopover();
  const [userOpen, setUserOpen, userRef] = usePopover();
  const name = person?.display_name ?? me?.person.name ?? '';
  // wiki admins, and anyone who manages a space
  const canSeeAnalytics = !!me?.is_admin || !!spaces?.some((s) => s.my_level === 'manage');

  const pick = (kind: 'page' | 'folder') => { setNewOpen(false); onNew?.(kind); };
  const pickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length) onUpload?.(files);
  };

  const signOut = async () => {
    setUserOpen(false);
    clearSessionCaches();
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

      <SearchBox />

      <div className="tb-actions">
        <ReviewsLink />
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
                        hint={onNew ? undefined : 'Open a library you can edit first'}>Page</MenuItem>
              <MenuItem icon={<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />}
                        onClick={() => pick('folder')} disabled={!onNew}
                        hint={onNew ? undefined : 'Open a library you can edit first'}>Folder</MenuItem>
              <MenuItem icon={<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M10.5 15.5a2 2 0 0 0 2.8 0l1.5-1.5a2 2 0 0 0-2.8-2.8l-.5.5" /></>}
                        onClick={() => { setNewOpen(false); onNewFromTemplate?.(); }} disabled={!onNewFromTemplate}
                        hint={onNewFromTemplate ? undefined : 'Open a library you can edit first'}>From template…</MenuItem>
              <MenuItem icon={<path d="M12 16V4M7 9l5-5 5 5M5 20h14" />}
                        onClick={() => { setNewOpen(false); uploadRef.current?.click(); }} disabled={!onUpload}
                        hint={onUpload ? undefined : 'Open a library you can edit first'}>
                Upload files
              </MenuItem>
              {me?.can_create_spaces && (
                <>
                  <div className="pop-sep" />
                  <MenuItem icon={<><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><path d="M17 14v6M14 17h6" /></>}
                            onClick={() => { setNewOpen(false); navigate(NEW_LIBRARY_PATH); }}>Library</MenuItem>
                </>
              )}
            </div>
          )}
          {onUpload && (
            <input ref={uploadRef} type="file" multiple hidden aria-label="Choose files to upload"
                   onChange={pickFiles} />
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
              {canSeeAnalytics && (
                <Link role="menuitem" className="pop-item" to="/analytics" onClick={() => setUserOpen(false)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></svg>
                  Analytics
                </Link>
              )}
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
