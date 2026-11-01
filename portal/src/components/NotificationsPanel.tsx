/**
 * The bell's popover: Settings-aware (list text size + density via the
 * directory list tokens), the shared inbox rows (components/notifications/
 * InboxRow — kind icons, unread marker, per-row Mark read / Mark unread /
 * Hide), header Mark all read / Clear read and a gear to the person's
 * notification settings, a footer link to the full /notifications page,
 * keyboard nav.
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';

import type { InboxItem } from '../lib/api';
import { leaveFor, resolveInboxLink } from '../lib/inboxLinks';
import { useNotifications } from '../lib/notificationsContext';
import InboxRow, { KindIcon, onRowKeys } from './notifications/InboxRow';
/* .portal-shell's --list-* tokens live in directory.css and the shell does
   not import it — without this the panel would lose Settings on any page
   that doesn't happen to load a directory list. */
import '../styles/directory.css';
import '../styles/toast.css';

export { relativeTime } from './notifications/InboxRow';

/** How many items the bell holds: the inbox endpoint's default page. A bell
 *  that is full says so, and the footer link is the way to the rest. */
export const INBOX_CAP = 50;

export default function NotificationsPanel({ onClose }: { onClose: () => void }) {
  const { items, unreadCount, markRead, markUnread, markAllRead, hide, clearRead, refresh } = useNotifications();
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const readCount = items.filter((i) => i.read_at).length;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** Close the popover and go to one of the portal's own pages. */
  const goTo = (to: string) => {
    onClose();
    navigate(to);
  };

  const open = (n: InboxItem) => {
    if (!n.read_at) void markRead(n.id);
    onClose();
    if (!n.link) return;
    // the portal's own paths navigate; another app's absolute links leave
    const target = resolveInboxLink(n.link);
    if (target.kind === 'app') navigate(target.to);
    else leaveFor(target.href);
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
          <button type="button" className="icon-btn" aria-label="Notification settings" data-tip="Settings"
                  onClick={() => goTo('/me/notifications')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
                 strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55h.09a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
            </svg>
          </button>
        </span>
      </div>

      {items.length === 0 ? (
        <div className="pop-empty notif-empty">
          <KindIcon kind="bell" />
          You&apos;re all caught up.
        </div>
      ) : (
        <div className="notif-list" role="list" ref={listRef}>
          {items.map((n) => (
            <InboxRow key={n.id} item={n} onOpen={open}
                      onMarkRead={markRead} onMarkUnread={markUnread} onHide={hide} onChanged={refresh}
                      onKeyDown={(e) => onRowKeys(e, listRef.current, () => open(n))} />
          ))}
        </div>
      )}

      <button type="button" className="notif-foot" onClick={() => goTo('/notifications')}>
        {items.length >= INBOX_CAP
          ? `View all notifications · showing the ${INBOX_CAP} most recent`
          : 'View all notifications'}
      </button>
    </div>
  );
}
