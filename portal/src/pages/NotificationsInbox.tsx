/**
 * Notifications — the person's full inbox (/notifications), newest first, any
 * signed-in user. The rows and their actions are the bell's (InboxRow,
 * approve/reject strips included), grouped Today / Yesterday / Earlier by the
 * local date of created_at, filtered All | Unread and by category, and paged
 * with "Load more" (usePagedList over GET /notifications/inbox) instead of
 * the bell's 50-item cap.
 *
 * Row actions go through the shared inbox context so the bell's badge and
 * list follow, and show on this page at once through a local overlay (a row's
 * read_at, or hidden by id) — no reload, so the list keeps its place. Mark all
 * read, Clear read and a decided approval reload page 1. The overlay's read
 * part lasts until the fresh rows LAND (not until they are asked for: the old
 * rows stay on screen while page 1 loads, and keep what was painted on them),
 * and then the server's word wins.
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import ComboBox, { type ComboOption } from '../components/ComboBox';
import InboxRow, { KindIcon, onRowKeys } from '../components/notifications/InboxRow';
import {
  ApiError, listInboxPage, type InboxItem, type InboxPageQuery, type NotificationCategory,
} from '../lib/api';
import { leaveFor, resolveInboxLink } from '../lib/inboxLinks';
import { NOTIFICATION_CATEGORIES } from '../lib/notificationKinds';
import { useNotifications } from '../lib/notificationsContext';
import { usePagedList } from '../lib/usePagedList';
import '../styles/directory.css';
import '../styles/profile.css';
import '../styles/notifications.css';

const CATEGORY_OPTIONS: ComboOption[] = [
  { value: '', label: 'All categories' },
  ...NOTIFICATION_CATEGORIES.map((c) => ({ value: c.key, label: c.label })),
];

const loadErrorMsg = (err: unknown): string =>
  err instanceof ApiError ? `Request failed (${err.code}).` : 'Network error — try again.';

type DayLabel = 'Today' | 'Yesterday' | 'Earlier';
const DAY_LABELS: DayLabel[] = ['Today', 'Yesterday', 'Earlier'];

const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** The heading an item sits under: by the LOCAL calendar date of `iso`, so a
 *  late-evening item is still "Today" in the person's own evening. (Day
 *  starts, not 24-hour spans, and rounded, so a daylight-saving day is still
 *  one day.) */
function dayLabelOf(iso: string, now: Date): DayLabel {
  const days = Math.round((startOfDay(now) - startOfDay(new Date(iso))) / 86_400_000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return 'Earlier';
}

export default function NotificationsInbox() {
  const { unreadCount, markRead, markUnread, hide, markAllRead, clearRead, refresh } = useNotifications();
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);

  const [unreadOnly, setUnreadOnly] = useState(false);
  const [category, setCategory] = useState<NotificationCategory | null>(null);
  /** What the page knows that its loaded rows don't yet: a row's read_at
   *  (null = marked unread here) and the rows hidden here. */
  const [readOverlay, setReadOverlay] = useState<Record<string, string | null>>({});
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());

  const list = usePagedList<InboxItem, InboxPageQuery>({
    query: { category, unreadOnly },
    fetchPage: async (params, signal) => {
      try {
        return await listInboxPage(params, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        throw new Error(loadErrorMsg(err));
      }
    },
  });

  const shown = useMemo(() => list.rows
    .filter((r) => !hidden.has(r.id))
    .map((r) => (r.id in readOverlay ? { ...r, read_at: readOverlay[r.id] } : r)),
  [list.rows, hidden, readOverlay]);

  const now = new Date();
  const groups = DAY_LABELS
    .map((label) => ({ label, rows: shown.filter((r) => dayLabelOf(r.created_at, now) === label) }))
    .filter((g) => g.rows.length > 0);

  // The read overlay ends when the fresh rows LAND, not when page 1 is asked
  // for: while it loads (a reload, a new view) the hook keeps the old rows on
  // screen, and they keep what the page painted on them. So it goes on the
  // falling edge of `loading`, in a layout effect so the old patches are never
  // painted over the fresh rows. "Load more" does not touch `loading`, so
  // paging keeps the overlay. A decision waits on the same edge (afterDecision).
  const wasLoading = useRef(list.loading);
  const waitingForRows = useRef<Array<() => void>>([]);
  useLayoutEffect(() => {
    if (wasLoading.current && !list.loading) {
      setReadOverlay((o) => (Object.keys(o).length ? {} : o));
      waitingForRows.current.splice(0).forEach((release) => release());
    }
    wasLoading.current = list.loading;
  }, [list.loading]);

  const pickCategory = (value: string) => setCategory(value === '' ? null : value as NotificationCategory);

  // Paint first, like the bell does: the server (through the context) catches up.
  const paintRead = (ids: string[]) => {
    const at = new Date().toISOString();
    setReadOverlay((o) => ({ ...o, ...Object.fromEntries(ids.map((id) => [id, at])) }));
  };
  const paintHidden = (ids: string[]) => setHidden((h) => new Set([...h, ...ids]));

  const markRowRead = (id: string) => {
    paintRead([id]);
    void markRead(id);
  };
  const markRowUnread = (id: string) => {
    setReadOverlay((o) => ({ ...o, [id]: null }));
    void markUnread(id);
  };
  const hideRow = (id: string) => {
    paintHidden([id]);
    void hide(id);
  };

  /** Opening a row behaves like the bell: mark it read, then an app link
   *  navigates and another app's absolute link leaves the portal. */
  const open = (n: InboxItem) => {
    if (!n.read_at) markRowRead(n.id);
    if (!n.link) return;
    const target = resolveInboxLink(n.link);
    if (target.kind === 'app') navigate(target.to);
    else leaveFor(target.href);
  };

  // Both act on the whole inbox, whatever the filters (the API has no scoped
  // form): the loaded rows change at once, then page 1 comes back from the server.
  const markAll = async () => {
    paintRead(shown.filter((r) => !r.read_at).map((r) => r.id));
    await markAllRead();
    list.reload();
  };
  const clearAllRead = async () => {
    paintHidden(shown.filter((r) => r.read_at).map((r) => r.id));
    await clearRead();
    list.reload();
  };
  // A decided approval changed the row server-side: repaint the bell, then load
  // page 1 and wait for the fresh rows, so the strip that asked stays busy until
  // they land (the stale pending row would offer a second click on a request that
  // is already decided).
  const afterDecision = async () => {
    await refresh();
    const landed = new Promise<void>((resolve) => waitingForRows.current.push(resolve));
    list.reload();
    await landed;
  };

  // Off only when the page KNOWS there is nothing to do: unread is the bell's
  // own overall count; read rows can hide behind a filter or a later page.
  const hasUnread = unreadCount > 0 || shown.some((r) => !r.read_at);
  const filtered = unreadOnly || category !== null;
  const nothingToClear = !filtered && !list.hasMore && !shown.some((r) => r.read_at);

  const failed = list.error !== null && list.rows.length === 0;
  const moreFailed = list.error !== null && list.rows.length > 0;

  let body: ReactNode;
  if (failed) {
    body = (
      <div className="dir-empty">
        <b>Couldn&apos;t load notifications</b>{list.error}
        <div className="audit-more">
          <button type="button" className="mini-btn" onClick={list.reload}>Try again</button>
        </div>
      </div>
    );
  } else if (list.loading && list.rows.length === 0) {
    body = <div className="dir-empty" role="status">Loading…</div>;
  } else if (shown.length === 0) {
    // Hid every loaded row while older ones wait: no claim about the inbox, just "Load more".
    body = list.hasMore ? null : (
      <div className="dir-empty notif-empty">
        <KindIcon kind="bell" />
        <b>{unreadOnly ? "You're all caught up." : 'No notifications yet.'}</b>
      </div>
    );
  } else {
    body = groups.map((g) => (
      <div key={g.label} className="notif-day-group">
        <h2 className="notif-day" id={`notif-day-${g.label}`}>{g.label}</h2>
        <div role="list" aria-labelledby={`notif-day-${g.label}`}>
          {g.rows.map((n) => (
            <InboxRow key={n.id} item={n} onOpen={open}
                      onMarkRead={markRowRead} onMarkUnread={markRowUnread} onHide={hideRow}
                      onChanged={afterDecision}
                      onKeyDown={(e) => onRowKeys(e, listRef.current, () => open(n))} />
          ))}
        </div>
      </div>
    ));
  }

  return (
    <div className="portal-page notif-inbox">
      <div className="dir-head">
        <div>
          <div className="eyebrow">Account</div>
          <h1 className="page-title">Notifications</h1>
          <p className="page-hint">Everything sent to you, newest first.</p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="segmented" role="group" aria-label="Show">
          <button type="button" className={unreadOnly ? '' : 'on'} aria-pressed={!unreadOnly}
                  onClick={() => setUnreadOnly(false)}>All</button>
          <button type="button" className={unreadOnly ? 'on' : ''} aria-pressed={unreadOnly}
                  onClick={() => setUnreadOnly(true)}>Unread</button>
        </div>
        <div className="notif-category">
          <ComboBox ariaLabel="Category" options={CATEGORY_OPTIONS} value={category ?? ''}
                    onChange={pickCategory} />
        </div>
        <div className="toolbar-right">
          <button type="button" className="mini-btn" disabled={!hasUnread}
                  onClick={() => void markAll()}>Mark all read</button>
          <button type="button" className="mini-btn" disabled={nothingToClear}
                  onClick={() => void clearAllRead()}>Clear read</button>
          <Link className="mini-btn" to="/me/notifications">Settings</Link>
        </div>
      </div>

      {body && <div className="dir-list" ref={listRef} aria-busy={list.loading}>{body}</div>}

      {moreFailed && (
        <div className="audit-more notif-more">
          <span className="pf-error" role="alert">{list.error}</span>
          <button type="button" className="mini-btn" onClick={list.retry}>Retry</button>
        </div>
      )}
      {list.hasMore && !moreFailed && (
        <div className="audit-more">
          <button type="button" className="mini-btn" disabled={list.loadingMore} onClick={list.loadMore}>
            {list.loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}
