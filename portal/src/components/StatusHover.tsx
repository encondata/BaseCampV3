/**
 * StatusHover — global hover popup for status chips. Wrap any list
 * row's status chip and hovering it shows when that status became
 * active and what set it: a scan (with its rfid/barcode/manual type,
 * device, and site) or a person's edit.
 *
 * Provenance is fetched lazily on first hover (180ms intent delay) from
 * GET /status/provenance and cached for a minute per (entity, status),
 * so hovering down a list stays cheap and an auto-refreshing dashboard
 * still picks up changes. The card is position:fixed so it escapes
 * overflow-clipped list containers.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { getStatusProvenance, type StatusProvenance } from '../lib/api';
import '../styles/status-hover.css';

const HOVER_DELAY_MS = 180;
const CACHE_TTL_MS = 60_000;

const cache = new Map<string, { at: number; promise: Promise<StatusProvenance> }>();

function fetchCached(entityType: string, entityId: string, status: string) {
  const key = `${entityType}:${entityId}:${status}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = getStatusProvenance(entityType, entityId, status);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

function fmtSince(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const day = d.toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }),
  });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

type CardState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; data: StatusProvenance };

export default function StatusHover({ entityType, entityId, status, children }: {
  entityType: string;
  entityId: string;
  status: string;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [card, setCard] = useState<CardState | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const show = () => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const below = rect.top < 96;
    setPos({
      left: Math.min(Math.max(rect.left + rect.width / 2, 140), window.innerWidth - 140),
      top: below ? rect.bottom + 8 : rect.top - 8,
      below,
    });
    setCard({ kind: 'loading' });
    let alive = true;
    fetchCached(entityType, entityId, status)
      .then((data) => { if (alive) setCard((c) => (c ? { kind: 'ready', data } : c)); })
      .catch(() => { if (alive) setCard((c) => (c ? { kind: 'error' } : c)); });
    return () => { alive = false; };
  };

  const onEnter = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(show, HOVER_DELAY_MS);
  };
  const onLeave = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setCard(null);
    setPos(null);
  };

  return (
    <span ref={wrapRef} className="status-hover"
          onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {children}
      {/* portaled to <body>: position:fixed must escape transformed
          ancestors (virtualized rows translate), which would otherwise
          re-anchor the card */}
      {card && pos && createPortal(
        <span className={`status-hover-card${pos.below ? ' below' : ''}`}
              role="tooltip"
              style={{ left: pos.left, top: pos.top }}>
          {card.kind === 'loading' && <span className="sh-muted">Checking history…</span>}
          {card.kind === 'error' && <span className="sh-muted">History unavailable.</span>}
          {card.kind === 'ready' && (
            card.data.changed_at === null ? (
              <span className="sh-muted">No recorded history for this status.</span>
            ) : (
              <>
                <span className="sh-since">Since {fmtSince(card.data.changed_at)}</span>
                <span className="sh-via">
                  {card.data.source === 'scan' ? (
                    <>
                      <span className="sh-kind">{card.data.scan_type_label ?? 'Scan'} scan</span>
                      {card.data.device_id && <> · {card.data.device_id}</>}
                      {card.data.site_name && <> · {card.data.site_name}</>}
                      {card.data.actor_name && <> · by <span className="sh-kind">{card.data.actor_name}</span></>}
                    </>
                  ) : (
                    <>Edited{card.data.actor_name ? <> by <span className="sh-kind">{card.data.actor_name}</span></> : ''}</>
                  )}
                </span>
              </>
            )
          )}
        </span>,
        document.body,
      )}
    </span>
  );
}
