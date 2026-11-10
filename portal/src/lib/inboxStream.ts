import { useEffect, useRef, useState } from 'react';
import {
  getAccessTokenForStream,
  inboxStreamUrl,
  logStreamProtocols,
  refreshSession,
} from './api';
import { nextBackoff } from './logViewer';

const SESSION_ENDED_CODE = 4401;

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
    let backoff = 0;

    const retryLater = () => {
      if (cancelled) return;
      backoff = nextBackoff(backoff);
      timer = setTimeout(connect, backoff);
    };

    function connect() {
      timer = null;
      if (cancelled) return;
      const token = getAccessTokenForStream();
      if (!token) {
        retryLater();
        return;
      }
      // token rides the subprotocol list, never the URL
      const socket = new WebSocket(inboxStreamUrl(), logStreamProtocols(token));
      ws = socket;
      let settled = false;

      socket.onopen = () => {
        if (cancelled) return;
        backoff = 0;
        setOpen(true);
        onChangeRef.current();
      };
      socket.onmessage = (event) => {
        if (cancelled) return;
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
        setOpen(false);
        if (code === SESSION_ENDED_CODE) {
          let session = null;
          try {
            session = await refreshSession();
          } catch {
            session = null;
          }
          if (cancelled) return;
          if (session) {
            connect();
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

    connect();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
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
