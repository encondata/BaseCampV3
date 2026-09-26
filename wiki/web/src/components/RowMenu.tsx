/** The ⋯ menu on a tree row (also opened by right-clicking the row) and in
 *  a page's header: New page/folder here, Rename, Move…, Copy…, Copy link,
 *  (a page's header only: Save as template…, Review schedule…),
 *  Permissions…, Delete — each shown only at the level it needs. Move,
 *  Copy, Permissions and Delete open the shell's dialogs. The menu is
 *  position:fixed so the sidebar's scroll box never clips it; it closes on
 *  any outside click, scroll, resize or Escape. */
import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode,
} from 'react';

import { useToast } from '@portal/lib/notificationsContext';

import { useWikiShell } from '../layout/shellContext';
import type { Level, NodeOut } from '../lib/types';

const RANK: Record<Level, number> = { view: 1, edit: 2, manage: 3 };

/** Whether `level` reaches `needed` (null = no access). */
export function atLeast(level: Level | null | undefined, needed: Level): boolean {
  return (level ? RANK[level] : 0) >= RANK[needed];
}

export interface RowMenuProps {
  node: NodeOut;
  onNewChild?: (kind: 'page' | 'folder') => void;
  onRename?: () => void;
  /** Only offered where the caller passes it — a page's own header. */
  onSaveAsTemplate?: () => void;
  /** Likewise (a page's header; manage). */
  onReviewSchedule?: () => void;
}

export interface RowMenuHandle {
  /** Opens the menu at a viewport point (a right-click). */
  openAt: (x: number, y: number) => void;
}

const MENU_WIDTH = 210;

const RowMenu = forwardRef<RowMenuHandle, RowMenuProps>(function RowMenu(
  { node, onNewChild, onRename, onSaveAsTemplate, onReviewSchedule }, ref,
) {
  const toast = useToast();
  const shell = useWikiShell();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const openAt = useCallback((x: number, y: number) => {
    setPos({ x: Math.max(8, Math.min(x, window.innerWidth - MENU_WIDTH - 8)), y });
  }, []);
  useImperativeHandle(ref, () => ({ openAt }), [openAt]);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); btnRef.current?.focus(); }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  // keyboard users land on the first item
  useEffect(() => {
    if (pos) menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [pos]);

  const toggle = () => {
    if (pos) { setPos(null); return; }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) openAt(r.right - MENU_WIDTH, r.bottom + 4);
  };

  const run = (fn: () => void) => () => { setPos(null); fn(); };

  const copyLink = () => {
    const url = `${location.origin}/n/${node.id}`;
    const done = () => toast('Link copied.');
    const failed = () => toast(`Couldn't copy the link: ${url}`);
    try {
      navigator.clipboard.writeText(url).then(done, failed);
    } catch {
      failed();
    }
  };

  const canEdit = atLeast(node.my_level, 'edit');
  const canManage = atLeast(node.my_level, 'manage');
  const isHome = !!node.page?.is_home;
  const items: { label: string; action: () => void; danger?: boolean; icon: ReactNode }[] = [];
  if (canEdit && node.kind !== 'file' && onNewChild) {
    items.push({ label: 'New page here', action: () => onNewChild('page'), icon: <path d="M12 5v14M5 12h14" /> });
    items.push({ label: 'New folder here', action: () => onNewChild('folder'), icon: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 10.5v5M9.5 13h5" /> });
  }
  if (canEdit && onRename) {
    items.push({ label: 'Rename', action: onRename, icon: <path d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4" /> });
  }
  if (canEdit) {
    items.push({ label: 'Move…', action: () => shell.requestMove(node), icon: <path d="M5 12h14M13 6l6 6-6 6" /> });
  }
  items.push({ label: 'Copy…', action: () => shell.requestCopy(node), icon: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></> });
  items.push({ label: 'Copy link', action: copyLink, icon: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /> });
  if (node.kind === 'page' && canEdit && onSaveAsTemplate) {
    items.push({
      label: 'Save as template…', action: onSaveAsTemplate,
      icon: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M10.5 15.5a2 2 0 0 0 2.8 0l1.5-1.5a2 2 0 0 0-2.8-2.8l-.5.5" /></>,
    });
  }
  if (node.kind === 'page' && canManage && onReviewSchedule) {
    items.push({
      label: 'Review schedule…', action: onReviewSchedule,
      icon: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16M9.5 15l2 2 3.5-3.5" /></>,
    });
  }
  if (canManage) {
    items.push({ label: 'Permissions…', action: () => shell.requestPermissions(node), icon: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></> });
  }
  if (canEdit && !isHome) {
    items.push({ label: 'Delete', action: () => shell.requestDelete(node), danger: true, icon: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /> });
  }

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`wiki-row-menu-btn${pos ? ' open' : ''}`}
        aria-label={`Actions for ${node.title}`}
        aria-haspopup="menu"
        aria-expanded={!!pos}
        draggable={false}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggle(); }}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5.5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18.5" cy="12" r="1.6" />
        </svg>
      </button>
      {pos && (
        <div
          ref={menuRef}
          className="pop-menu wiki-row-menu"
          role="menu"
          aria-label={`Actions for ${node.title}`}
          style={{ position: 'fixed', top: pos.y, left: pos.x, right: 'auto', width: MENU_WIDTH, minWidth: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`pop-item${it.danger ? ' wiki-danger' : ''}`}
              onClick={run(it.action)}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{it.icon}</svg>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </>
  );
});

export default RowMenu;
