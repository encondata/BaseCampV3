/** Developer log viewer: live WS tail + paged history for one process.
 *  All state renders from server data; reconnects resync via GET. */

import {
  useCallback, useEffect, useRef, useState,
} from 'react';
import { Link, useParams } from 'react-router-dom';

import {
  clearProcessLogs, getAccessTokenForStream, getProcessLogs,
  logStreamUrl, type SystemLogEntry,
} from '../lib/api';
import {
  levelClass, mergeEntries, nextBackoff, splitMessage,
} from '../lib/logViewer';
import '../styles/directory.css';
import '../styles/system.css';

const LEVELS = ['DEBUG', 'INFO', 'WARNING', 'ERROR'] as const;
const PAGE_LIMIT = 200;
const SCROLL_AWAY_PX = 40;
const DEBOUNCE_MS = 300;

function formatTime(at: string): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function ProcessLogs() {
  const { name = '' } = useParams<{ name: string }>();
  const [entries, setEntries] = useState<SystemLogEntry[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [minLevel, setMinLevel] = useState<string>('DEBUG');
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [follow, setFollow] = useState(true);
  const [wsState, setWsState] = useState<'live' | 'connecting'>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [clearing, setClearing] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  /* debounce search input (300 ms) → debouncedQuery */
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  /* initial + filter-change load: GET latest page (reversed into
     ascending order), setEntries/setHasMore */
  useEffect(() => {
    let alive = true;
    getProcessLogs(name, {
      minLevel, q: debouncedQuery || undefined, limit: PAGE_LIMIT,
    })
      .then((page) => {
        if (!alive) return;
        setEntries([...page.entries].reverse());
        setHasMore(page.has_more);
        setError(null);
      })
      .catch(() => { if (alive) setError('Cannot load logs.'); });
    return () => { alive = false; };
  }, [name, minLevel, debouncedQuery]);

  /* WS effect keyed on [name, minLevel, debouncedQuery]:
       - close any previous socket
       - connect logStreamUrl(name, token, {minLevel, q}); token from
         getAccessTokenForStream(); missing token → error state
       - onmessage: parse; ignore {ping}; merge entries via mergeEntries
       - onclose/onerror: schedule reconnect via nextBackoff(backoffRef),
         re-running the GET on success to fill any gap; wsState tracks it
       - cleanup closes the socket */
  useEffect(() => {
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isReconnect = false;

    const resync = () => {
      getProcessLogs(name, {
        minLevel, q: debouncedQuery || undefined, limit: PAGE_LIMIT,
      })
        .then((page) => {
          if (cancelled) return;
          setEntries((prev) => mergeEntries(prev, [...page.entries].reverse()));
          setHasMore(page.has_more);
        })
        .catch(() => {});
    };

    const connect = () => {
      if (cancelled) return;
      const token = getAccessTokenForStream();
      if (!token) {
        setWsState('connecting');
        setError('Not authenticated for live logs.');
        return;
      }
      setWsState('connecting');
      const url = logStreamUrl(name, token, {
        minLevel, q: debouncedQuery || undefined,
      });
      const ws = new WebSocket(url);
      wsRef.current = ws;
      let settled = false;

      ws.onopen = () => {
        if (cancelled) return;
        backoffRef.current = 0;
        setWsState('live');
        setError(null);
        if (isReconnect) resync();
        isReconnect = true;
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        let data: unknown;
        try {
          data = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (!data || typeof data !== 'object' || 'ping' in data) return;
        const incoming = (data as { entries?: SystemLogEntry[] }).entries;
        if (incoming && incoming.length > 0) {
          setEntries((prev) => mergeEntries(prev, incoming));
        }
      };

      const scheduleReconnect = () => {
        if (settled || cancelled) return;
        settled = true;
        wsRef.current = null;
        setWsState('connecting');
        const delay = nextBackoff(backoffRef.current);
        backoffRef.current = delay;
        reconnectTimer = setTimeout(connect, delay);
      };
      ws.onclose = scheduleReconnect;
      ws.onerror = scheduleReconnect;
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      const ws = wsRef.current;
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        wsRef.current = null;
      }
    };
  }, [name, minLevel, debouncedQuery]);

  /* follow effect: when follow && new entries, scroll bodyRef to bottom;
     an onScroll handler that detects a user scroll away from the bottom
     (scrollHeight - scrollTop - clientHeight > 40) turns follow off */
  useEffect(() => {
    if (!follow) return;
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries, follow]);

  const handleScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const awayFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight > SCROLL_AWAY_PX;
    if (awayFromBottom) setFollow(false);
  }, []);

  /* loadOlder(): GET with before_id = entries[0]?.id, prepend via
     mergeEntries, keep scroll position stable */
  const loadOlder = useCallback(() => {
    if (loadingOlder || entries.length === 0) return;
    const beforeId = entries[0].id;
    const el = bodyRef.current;
    const prevScrollHeight = el?.scrollHeight ?? 0;
    const prevScrollTop = el?.scrollTop ?? 0;
    setLoadingOlder(true);
    getProcessLogs(name, {
      minLevel, q: debouncedQuery || undefined, beforeId, limit: PAGE_LIMIT,
    })
      .then((page) => {
        setEntries((prev) => mergeEntries(prev, [...page.entries].reverse()));
        setHasMore(page.has_more);
        requestAnimationFrame(() => {
          const body = bodyRef.current;
          if (!body) return;
          body.scrollTop = prevScrollTop + (body.scrollHeight - prevScrollHeight);
        });
      })
      .catch(() => setError('Cannot load older logs.'))
      .finally(() => setLoadingOlder(false));
  }, [entries, loadingOlder, name, minLevel, debouncedQuery]);

  /* clear(): confirm dialog → clearProcessLogs(name) → empty entries */
  const handleClear = useCallback(() => {
    if (!confirm(`Clear all logs for "${name}"? This cannot be undone.`)) return;
    setClearing(true);
    clearProcessLogs(name)
      .then(() => {
        setEntries([]);
        setHasMore(false);
        setExpanded(new Set());
      })
      .catch(() => setError('Could not clear logs.'))
      .finally(() => setClearing(false));
  }, [name]);

  const toggleExpanded = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="portal-page sys-logs-page">
      {/* header: back Link to /system/processes, eyebrow "Process logs",
          title {name}, right side: connection chip
          (wsState === 'live' ? 'Live' : 'Reconnecting…'), Clear logs
          button (mini-btn danger) */}
      <div className="sys-log-header">
        <div>
          <Link to="/system/processes" className="mini-btn sm">&larr; Processes</Link>
          <div className="eyebrow">Process logs</div>
          <h1 className="page-title">{name}</h1>
        </div>
        <div className="sys-log-header-actions">
          <span className={`chip ${wsState === 'live' ? 'c-green' : 'c-amber'}`}>
            {wsState === 'live' ? 'Live' : 'Reconnecting…'}
          </span>
          <button type="button" className="mini-btn danger" disabled={clearing}
                  onClick={handleClear}>
            {clearing ? 'Clearing…' : 'Clear logs'}
          </button>
        </div>
      </div>

      {/* toolbar: segmented level buttons (LEVELS, active = minLevel),
          search input, Follow toggle button (active state visible) */}
      <div className="sys-log-toolbar">
        <div className="sys-log-levels">
          {LEVELS.map((lvl) => (
            <button
              key={lvl}
              type="button"
              className={`mini-btn sm${minLevel === lvl ? ' active' : ''}`}
              onClick={() => setMinLevel(lvl)}
            >
              {lvl}
            </button>
          ))}
        </div>
        <input
          type="search"
          className="sys-log-search"
          placeholder="Search messages…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button
          type="button"
          className={`mini-btn${follow ? ' active' : ''}`}
          onClick={() => setFollow((f) => !f)}
        >
          {follow ? 'Following' : 'Follow'}
        </button>
      </div>

      {/* error banner (dir-empty) when error */}
      {error && <div className="dir-empty"><b>{error}</b></div>}

      {/* body: div ref=bodyRef className="sys-log-body" — for each entry:
          <div className={`sys-log-line ${levelClass(entry.level)}`}>
            gutter: level tag + time (HH:MM:SS), logger, head of
            splitMessage; when rest !== null a "+N lines" expander toggling
            entry.id in `expanded`, showing <pre> with the rest.
          "Load older" button at top when hasMore.
          Empty state: "No log entries yet — they appear live." */}
      <div ref={bodyRef} className="sys-log-body" onScroll={handleScroll}>
        {hasMore && (
          <div className="sys-log-load-older">
            <button type="button" className="mini-btn sm" disabled={loadingOlder}
                    onClick={loadOlder}>
              {loadingOlder ? 'Loading…' : 'Load older'}
            </button>
          </div>
        )}
        {entries.length === 0 && !error && (
          <div className="dir-empty">No log entries yet — they appear live.</div>
        )}
        {entries.map((e) => {
          const { head, rest } = splitMessage(e.message);
          const isExpanded = expanded.has(e.id);
          return (
            <div key={e.id} className={`sys-log-line ${levelClass(e.level)}`}>
              <span className="sys-log-level-tag">{e.level}</span>
              <span className="sys-log-time">{formatTime(e.at)}</span>
              <span className="sys-log-logger">{e.logger}</span>
              <span className="sys-log-msg">
                {head}
                {rest !== null && (
                  <button
                    type="button"
                    className="sys-log-expand"
                    onClick={() => toggleExpanded(e.id)}
                  >
                    {isExpanded ? 'Hide' : `+${rest.split('\n').length} lines`}
                  </button>
                )}
              </span>
              {rest !== null && isExpanded && <pre>{rest}</pre>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
