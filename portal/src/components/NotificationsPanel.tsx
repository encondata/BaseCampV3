/**
 * The bell's popover: Settings-aware (list text size + density via the
 * directory list tokens), kind icons, unread marker, per-row Mark read /
 * Mark unread / Hide, header Mark all read / Clear read, keyboard nav.
 * "Hide" is a soft dismiss (dismissed_at) — rows are kept server-side.
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import { useNotifications } from '../lib/notificationsContext';
import type { InboxItem } from '../lib/api';
/* .portal-shell's --list-* tokens live in directory.css and the shell does
   not import it — without this the panel would lose Settings on any page
   that doesn't happen to load a directory list. */
import '../styles/directory.css';
import '../styles/toast.css';

export const INBOX_CAP = 50;

export function relativeTime(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function KindIcon({ kind }: { kind: string }) {
  const cls = `notif-icon notif-icon-${kind}`;
  if (kind === 'report_ready') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><path d="M14 3v6h6" /><path d="M8 13h8M8 17h5" />
      </svg>
    );
  }
  if (kind === 'report_failed') {
    return (
      <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3 2 20h20z" /><path d="M12 9v5M12 17h.01" />
      </svg>
    );
  }
  return (
    <svg className={cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </svg>
  );
}

export default function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const { items, unreadCount, markRead, markUnread, markAllRead, hide, clearRead } = useNotifications();
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const readCount = items.filter((i) => i.read_at).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const open = (n: InboxItem) => {
    void markRead(n.id);
    onClose();
    if (n.link) navigate(n.link);
  };

  const onRowKey = (e: React.KeyboardEvent<HTMLDivElement>, n: InboxItem, idx: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLElement>('[role="listitem"]');
    if (e.key === 'ArrowDown') { e.preventDefault(); rows?.[idx + 1]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); rows?.[idx - 1]?.focus(); }
    else if (e.key === 'Enter') { e.preventDefault(); open(n); }
  };

  return (
    <div className="pop-menu notif-panel" role="dialog" aria-label="Notifications">
      <div className="notif-head">
        <span className="pop-title">Notifications</span>
        {unreadCount > 0 && <span className="notif-chip">{unreadCount} unread</span>}
        <span className="notif-head-actions">
          <button type="button" className="btn-ghost" disabled={unreadCount === 0}
                  onClick={() => void markAllRead()}>Mark all read</button>
          <button type="button" className="btn-ghost" disabled={readCount === 0}
                  onClick={() => void clearRead()}>Clear read</button>
        </span>
      </div>

      {items.length === 0 ? (
        <div className="pop-empty notif-empty">
          <KindIcon kind="bell" />
          You&apos;re all caught up.
        </div>
      ) : (
        <div className="notif-list" role="list" ref={listRef}>
          {items.map((n, idx) => (
            <div key={n.id} role="listitem" tabIndex={0}
                 className={`notif-row ${n.read_at ? '' : 'unread'}`}
                 onClick={() => open(n)} onKeyDown={(e) => onRowKey(e, n, idx)}>
              <KindIcon kind={n.kind} />
              <span className="notif-text">
                <span className="notif-title">
                  {!n.read_at && <span className="notif-dot" aria-hidden="true" />}
                  {n.title}
                </span>
                {n.body && <span className="notif-body">{n.body}</span>}
                <span className="notif-time">{relativeTime(n.created_at)}</span>
              </span>
              <span className="notif-actions" onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}>
                {n.read_at ? (
                  <button type="button" className="icon-btn" aria-label="Mark unread" title="Mark unread"
                          onClick={() => void markUnread(n.id)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="4" /></svg>
                  </button>
                ) : (
                  <button type="button" className="icon-btn" aria-label="Mark read" title="Mark read"
                          onClick={() => void markRead(n.id)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4L19 6" /></svg>
                  </button>
                )}
                <button type="button" className="icon-btn" aria-label="Hide" title="Hide"
                        onClick={() => void hide(n.id)}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {items.length >= INBOX_CAP && <div className="notif-foot">Showing the {INBOX_CAP} most recent</div>}
    </div>
  );
}
