import { useEffect, useRef, useState } from 'react';
import {
  getFreshAccessTokenForStream,
  inboxStreamUrl,
  logStreamProtocols,
  refreshSession,
} from './api';
import { nextBackoff } from './logViewer';

const SESSION_ENDED_CODE = 4401;
// A socket counts as stable once it has been up this long. Only a stable
// socket resets the backoff, and only a stable one may reconnect at once
// after a 4401; otherwise an open-then-drop loop would never slow down.
const MIN_STABLE_MS = 5000;
// The server pings every 30 s. Hearing nothing at all for this long means
// the socket is half-open (laptop sleep, NAT drop): close it and reconnect.
export const INBOX_STREAM_STALE_MS = 75_000;

/**
 * Opens the inbox change-signal WebSocket for the signed-in person and calls
 * `onChange` whenever the inbox may have changed: on every {"inbox": true}
 * message and once after every successful open (covers anything missed while
 * disconnected). Reconnects with backoff. Returns true while the socket is
 * open, so callers can fall back to polling when it is false.
 */
export function useInboxStream(
  personId: string | null | undefined,
  onChange: () => void,
): boolean {
  const [open, setOpen] = useState(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!personId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ws: WebSocket | null = null;
    let stale: ReturnType<typeof setTimeout> | null = null;
    let backoff = 0;

    const clearStale = () => {
      if (stale) clearTimeout(stale);
      stale = null;
    };

    const retryLater = () => {
      if (cancelled) return;
      backoff = nextBackoff(backoff);
      timer = setTimeout(() => void connect(), backoff);
    };

    async function connect() {
      timer = null;
      if (cancelled) return;
      let token: string | null = null;
      try {
        token = await getFreshAccessTokenForStream();
      } catch {
        token = null;
      }
      if (cancelled) return;
      if (!token) {
        retryLater();
        return;
      }
      // token rides the subprotocol list, never the URL
      const socket = new WebSocket(inboxStreamUrl(), logStreamProtocols(token));
      ws = socket;
      let settled = false;
      let openedAt = 0;

      // Re-armed on open and on every message, pings included.
      const heard = () => {
        clearStale();
        stale = setTimeout(() => {
          stale = null;
          void settle();
          socket.close();
        }, INBOX_STREAM_STALE_MS);
      };

      socket.onopen = () => {
        if (cancelled) return;
        openedAt = Date.now();
        heard();
        setOpen(true);
        onChangeRef.current();
      };
      socket.onmessage = (event) => {
        if (cancelled) return;
        heard();
        let data: unknown;
        try {
          data = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (data && typeof data === 'object' && 'inbox' in data) {
          onChangeRef.current();
        }
      };
      const settle = async (code?: number) => {
        if (settled || cancelled) return;
        settled = true;
        ws = null;
        clearStale();
        setOpen(false);
        const stable = openedAt > 0 && Date.now() - openedAt >= MIN_STABLE_MS;
        if (stable) backoff = 0;
        if (code === SESSION_ENDED_CODE) {
          let session = null;
          try {
            session = await refreshSession();
          } catch {
            session = null;
          }
          if (cancelled) return;
          if (session && stable) {
            void connect();
            return;
          }
        }
        retryLater();
      };
      socket.onclose = (event) => {
        void settle((event as CloseEvent | undefined)?.code);
      };
      socket.onerror = () => {
        void settle();
      };
    }

    void connect();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      clearStale();
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        ws = null;
      }
      setOpen(false);
    };
  }, [personId]);

  return open;
}
