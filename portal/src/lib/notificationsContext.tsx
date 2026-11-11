/**
 * In-app inbox provider: re-reads /notifications/inbox when the live stream
 * signals a change (useInboxStream), and polls as the fallback: every 30 s
 * while the stream is down, every 120 s while it is live, and on tab focus.
 * Items that appear after the first successful poll are "new" —
 * ToastHost shows those. An address block still waiting on a decision is
 * new on the first poll too (an admin who signs in during one gets the
 * toast), and every poll drops an address-block toast once it is decided
 * or has run out, so one admin's decision clears every admin's toast.
 * Also hosts short-lived local message toasts (useToast) so pages don't
 * each grow their own.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';

import { useAuth } from '../auth/AuthContext';
import {
  clearReadInbox, hideInboxItem, listInbox, markAllInboxRead, markInboxRead, markInboxUnread,
} from './api';
import type { InboxItem } from './api';
import { ADDRESS_BLOCKED_KIND, addressBlockOpen } from './addressBlocked';
import { useInboxStream } from './inboxStream';
import { installAudioUnlock, playNotificationSound } from './notificationSounds';

export const INBOX_POLL_MS = 30_000;
/** Safety-net poll while the stream is live (signals do the real work). */
export const INBOX_POLL_LIVE_MS = 120_000;
export const LOCAL_TOAST_MS = 4_000;
/** A local toast with an action (Undo) stays as long as an inbox toast
 *  with one (ToastHost's INBOX_TOAST_MS), so there is time to reach it. */
export const ACTION_TOAST_MS = 10_000;

/** A button on a local toast: clicking it runs `onClick` and dismisses it. */
export interface ToastAction { label: string; onClick: () => void }

interface LocalToast { id: number; message: string; action?: ToastAction }

interface Value {
  unreadCount: number;
  items: InboxItem[];
  newItems: InboxItem[];
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markUnread: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  hide: (id: string) => Promise<void>;
  clearRead: () => Promise<void>;
  dismissNew: (id: string) => void;
  toast: (message: string, action?: ToastAction) => void;
  localToasts: LocalToast[];
  dismissLocal: (id: number) => void;
}

const Ctx = createContext<Value | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { person, preferences } = useAuth();
  // read inside the poll callback without re-creating it on every preference save
  const soundRef = useRef(preferences?.notif?.sound ?? 'chime');
  soundRef.current = preferences?.notif?.sound ?? 'chime';
  useEffect(() => installAudioUnlock(), []);
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [newItems, setNewItems] = useState<InboxItem[]>([]);
  const [localToasts, setLocalToasts] = useState<LocalToast[]>([]);
  const seen = useRef<Set<string> | null>(null);          // null until the first poll lands
  const nextLocalId = useRef(1);

  const readInbox = useCallback(async () => {
    if (!person) return;
    try {
      const inbox = await listInbox();
      setItems(inbox.items);
      setUnreadCount(inbox.unread_count);
      const latest = new Map(inbox.items.map((i) => [i.id, i]));
      const settled = (i: InboxItem) => {
        if (i.kind !== ADDRESS_BLOCKED_KIND) return false;
        const now = latest.get(i.id) ?? i;
        return !!now.read_at || !addressBlockOpen(now);
      };
      let fresh: InboxItem[];
      if (seen.current === null) {
        // first poll: only an undecided block toasts; the rest is history
        seen.current = new Set(inbox.items.map((i) => i.id));
        fresh = inbox.items.filter((i) => !i.read_at && addressBlockOpen(i));
      } else {
        // a block that ended before this poll saw it has nothing left to decide
        fresh = inbox.items.filter((i) => !i.read_at && !seen.current!.has(i.id) && !settled(i));
        inbox.items.forEach((i) => seen.current!.add(i.id));
        if (fresh.length) playNotificationSound(soundRef.current);
      }
      // A block that moved up a rung comes back as a fresh card (the API
      // replaces the old one): its toast takes the old card's place.
      const blockKey = (i: InboxItem) => (i.kind === ADDRESS_BLOCKED_KIND
        ? `${String(i.payload.address)}|${String(i.payload.blocked_at)}` : null);
      const replaced = new Set(fresh.map(blockKey).filter((k): k is string => k !== null));
      const gone = (i: InboxItem) => settled(i) || (!fresh.includes(i) && replaced.has(blockKey(i) ?? ''));
      setNewItems((cur) => {
        const kept = cur.some(gone) ? cur.filter((i) => !gone(i)) : cur;
        return fresh.length ? [...fresh, ...kept].slice(0, 3) : kept;
      });
    } catch {
      /* transient: keep the last value */
    }
  }, [person]);

  // Coalesce reads. At most one read is in flight and at most one follow-up
  // is queued behind it, so a burst of signals costs two reads, not N. A call
  // made while a read is in flight gets the follow-up's promise, not the
  // in-flight one: the in-flight read may have started before the caller's
  // mutation or signal, so only a read that starts afterward shows the truth.
  const inFlight = useRef<Promise<void> | null>(null);
  const followUp = useRef<Promise<void> | null>(null);
  const refresh = useCallback((): Promise<void> => {
    if (followUp.current) return followUp.current;
    const start = () => {
      const p: Promise<void> = readInbox().finally(() => {
        if (inFlight.current === p) inFlight.current = null;
      });
      inFlight.current = p;
      return p;
    };
    if (!inFlight.current) return start();
    // run on either outcome, so a read that rejects can't wedge refresh()
    const run = () => {
      followUp.current = null;
      return start();
    };
    followUp.current = inFlight.current.then(run, run);
    return followUp.current;
  }, [readInbox]);

  const live = useInboxStream(person?.id, () => { void refresh(); });

  // The provider sits above the router and never unmounts, so a sign-out
  // (or sign-in as someone else) must reset all of this by hand — otherwise
  // the next person's first poll compares against the previous person's
  // `seen` set and treats their unread items as "new" (spurious toasts).
  useEffect(() => {
    seen.current = null;
    setItems([]);
    setUnreadCount(0);
    setNewItems([]);
  }, [person?.id]);

  useEffect(() => {
    if (!person) return;
    void refresh();
    const t = setInterval(
      () => { void refresh(); }, live ? INBOX_POLL_LIVE_MS : INBOX_POLL_MS,
    );
    const onVis = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [person, refresh, live]);

  // Every mutation paints locally first (the popover must feel instant
  // between reads) and then re-reads the inbox so the server stays the truth.
  // `wasUnread` is read from the rendered `items`, not from inside a
  // setState updater: StrictMode double-invokes updaters, so a count
  // change nested in one would decrement twice.
  const markRead = useCallback(async (id: string) => {
    const wasUnread = items.some((i) => i.id === id && !i.read_at);
    const now = new Date().toISOString();
    setItems((cur) => cur.map((i) => (i.id === id && !i.read_at ? { ...i, read_at: now } : i)));
    if (wasUnread) setUnreadCount((n) => Math.max(0, n - 1));
    setNewItems((cur) => cur.filter((i) => i.id !== id));
    await markInboxRead(id).catch(() => undefined);
    await refresh();
  }, [items, refresh]);
  const markUnread = useCallback(async (id: string) => {
    const wasRead = !!items.find((i) => i.id === id)?.read_at;
    setItems((cur) => cur.map((i) => (i.id === id ? { ...i, read_at: null } : i)));
    if (wasRead) setUnreadCount((n) => n + 1);
    await markInboxUnread(id).catch(() => undefined);
    await refresh();
  }, [items, refresh]);
  const hide = useCallback(async (id: string) => {
    const wasUnread = items.some((i) => i.id === id && !i.read_at);
    setItems((cur) => cur.filter((i) => i.id !== id));
    if (wasUnread) setUnreadCount((n) => Math.max(0, n - 1));
    setNewItems((cur) => cur.filter((i) => i.id !== id));
    await hideInboxItem(id).catch(() => undefined);
    await refresh();
  }, [items, refresh]);
  const clearRead = useCallback(async () => {
    setItems((cur) => cur.filter((i) => !i.read_at));
    await clearReadInbox().catch(() => undefined);
    await refresh();
  }, [refresh]);
  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    setItems((cur) => cur.map((i) => (i.read_at ? i : { ...i, read_at: now })));
    setUnreadCount(0);
    await markAllInboxRead().catch(() => undefined);
    setNewItems([]);
    await refresh();
  }, [refresh]);
  const dismissNew = useCallback((id: string) => setNewItems((cur) => cur.filter((i) => i.id !== id)), []);
  const dismissLocal = useCallback((id: number) => setLocalToasts((cur) => cur.filter((t) => t.id !== id)), []);
  const toast = useCallback((message: string, action?: ToastAction) => {
    const id = nextLocalId.current++;
    setLocalToasts((cur) => [...cur, action ? { id, message, action } : { id, message }]);
    setTimeout(() => dismissLocal(id), action ? ACTION_TOAST_MS : LOCAL_TOAST_MS);
  }, [dismissLocal]);

  const value = useMemo<Value>(() => ({
    unreadCount, items, newItems, refresh, markRead, markUnread, markAllRead, hide, clearRead,
    dismissNew, toast, localToasts, dismissLocal,
  }), [unreadCount, items, newItems, refresh, markRead, markUnread, markAllRead, hide, clearRead,
    dismissNew, toast, localToasts, dismissLocal]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const EMPTY: Value = {
  unreadCount: 0, items: [], newItems: [], refresh: async () => {}, markRead: async () => {},
  markUnread: async () => {}, markAllRead: async () => {}, hide: async () => {}, clearRead: async () => {},
  dismissNew: () => {}, toast: () => {}, localToasts: [], dismissLocal: () => {},
};

export function useNotifications(): Value {
  return useContext(Ctx) ?? EMPTY;
}

export function useToast(): (message: string, action?: ToastAction) => void {
  return useNotifications().toast;
}

export function useLocalToasts(): { toasts: LocalToast[]; dismiss: (id: number) => void } {
  const n = useNotifications();
  return { toasts: n.localToasts, dismiss: n.dismissLocal };
}
