/**
 * In-app inbox provider: polls /notifications/inbox every 30 s and on tab
 * focus. Items that appear after the first successful poll are "new" —
 * ToastHost shows those. Also hosts short-lived local message toasts
 * (useToast) so pages don't each grow their own.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';

import { useAuth } from '../auth/AuthContext';
import { listInbox, markAllInboxRead, markInboxRead } from './api';
import type { InboxItem } from './api';

export const INBOX_POLL_MS = 30_000;
export const LOCAL_TOAST_MS = 4_000;

interface LocalToast { id: number; message: string }

interface Value {
  unreadCount: number;
  items: InboxItem[];
  newItems: InboxItem[];
  refresh: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
  dismissNew: (id: string) => void;
  toast: (message: string) => void;
  localToasts: LocalToast[];
  dismissLocal: (id: number) => void;
}

const Ctx = createContext<Value | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { person } = useAuth();
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [newItems, setNewItems] = useState<InboxItem[]>([]);
  const [localToasts, setLocalToasts] = useState<LocalToast[]>([]);
  const seen = useRef<Set<string> | null>(null);          // null until the first poll lands
  const nextLocalId = useRef(1);

  const refresh = useCallback(async () => {
    if (!person) return;
    try {
      const inbox = await listInbox();
      setItems(inbox.items);
      setUnreadCount(inbox.unread_count);
      if (seen.current === null) {
        seen.current = new Set(inbox.items.map((i) => i.id));
      } else {
        const fresh = inbox.items.filter((i) => !i.read_at && !seen.current!.has(i.id));
        inbox.items.forEach((i) => seen.current!.add(i.id));
        if (fresh.length) setNewItems((cur) => [...fresh, ...cur].slice(0, 3));
      }
    } catch {
      /* transient: keep the last value */
    }
  }, [person]);

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
    const t = setInterval(() => { void refresh(); }, INBOX_POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [person, refresh]);

  const markRead = useCallback(async (id: string) => {
    await markInboxRead(id).catch(() => undefined);
    setNewItems((cur) => cur.filter((i) => i.id !== id));
    await refresh();
  }, [refresh]);
  const markAllRead = useCallback(async () => {
    await markAllInboxRead().catch(() => undefined);
    setNewItems([]);
    await refresh();
  }, [refresh]);
  const dismissNew = useCallback((id: string) => setNewItems((cur) => cur.filter((i) => i.id !== id)), []);
  const dismissLocal = useCallback((id: number) => setLocalToasts((cur) => cur.filter((t) => t.id !== id)), []);
  const toast = useCallback((message: string) => {
    const id = nextLocalId.current++;
    setLocalToasts((cur) => [...cur, { id, message }]);
    setTimeout(() => dismissLocal(id), LOCAL_TOAST_MS);
  }, [dismissLocal]);

  const value = useMemo<Value>(() => ({
    unreadCount, items, newItems, refresh, markRead, markAllRead, dismissNew, toast, localToasts, dismissLocal,
  }), [unreadCount, items, newItems, refresh, markRead, markAllRead, dismissNew, toast, localToasts, dismissLocal]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const EMPTY: Value = {
  unreadCount: 0, items: [], newItems: [], refresh: async () => {}, markRead: async () => {},
  markAllRead: async () => {}, dismissNew: () => {}, toast: () => {}, localToasts: [], dismissLocal: () => {},
};

export function useNotifications(): Value {
  return useContext(Ctx) ?? EMPTY;
}

export function useToast(): (message: string) => void {
  return useNotifications().toast;
}

export function useLocalToasts(): { toasts: LocalToast[]; dismiss: (id: number) => void } {
  const n = useNotifications();
  return { toasts: n.localToasts, dismiss: n.dismissLocal };
}
