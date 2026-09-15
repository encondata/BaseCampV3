/**
 * InitiativeHoverCard — the hover card behind a calendar bar on
 * /initiatives/timeline. Wraps a bar and, after a 180ms intent delay,
 * shows the initiative's high-level details: name, status and type
 * chips, client · site, the scheduled and actual ranges, and a move's
 * origin → destination. It replaces the native `title` the bars used to
 * carry, which could only print one flat line and arrived on the
 * browser's own schedule.
 *
 * Mechanics follow components/StatusHover.tsx: the 180ms delay, a
 * position:fixed card portaled to <body> so it escapes the calendar
 * grid's `overflow: hidden`, positioned from the trigger's
 * getBoundingClientRect(), and pointer-events:none so the card never
 * steals the hover that opened it. Unlike StatusHover nothing is
 * fetched — every field is already on the InitiativeItem the bar
 * renders.
 *
 * The wrapper is `display: contents` (see styles/initiative-hover.css):
 * the bar is a grid item placed by the week row, and a wrapper with a
 * box of its own would take that placement away from it. So the wrapper
 * generates no box, and the rect comes from the trigger child instead.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import type { InitiativeItem } from '../../lib/api';
import { longDateOf } from '../../lib/format';
import { parseApiDay } from '../../lib/timeline';
import '../../styles/initiative-hover.css';

const HOVER_DELAY_MS = 180;

/** A date-only API field as the local calendar day it names. Not
 *  `longDate(iso)`: these arrive as midnight UTC, which `new Date(iso)`
 *  renders as the previous day anywhere west of UTC. */
function day(iso: string): string {
  return longDateOf(parseApiDay(iso));
}

/** `start → end`, or the single day when both name the same one. */
function range(startIso: string, endIso: string | null): string {
  const start = day(startIso);
  if (!endIso) return start;
  const end = day(endIso);
  return end === start ? start : `${start} → ${end}`;
}

/** The actual run: started but not finished reads as still running,
 *  rather than borrowing today's date as an end it doesn't have. */
function actualRange(i: InitiativeItem): string | null {
  if (!i.real_start_at) return null;
  if (!i.real_end_at) return `${day(i.real_start_at)} → still running`;
  return range(i.real_start_at, i.real_end_at);
}

/** A move's route, as far as it is known. */
function moveRoute(i: InitiativeItem): string | null {
  if (i.initiative_type !== 'move') return null;
  const from = i.origin_site_name;
  const to = i.destination_site_name;
  if (from && to) return `${from} → ${to}`;
  if (from) return `From ${from}`;
  if (to) return `To ${to}`;
  return null;
}

function chipStyle(color: string): CSSProperties {
  return { '--chip': color } as CSSProperties;
}

export default function InitiativeHoverCard({ item, className, style, children }: {
  item: InitiativeItem;
  /** Extra classes for the wrapper. */
  className?: string;
  /** Inline styles for the wrapper. */
  style?: CSSProperties;
  children: ReactNode;
}) {
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const show = () => {
    // The wrapper has no box of its own (display: contents), so the
    // trigger it wraps is what the card points at.
    const anchor = (wrapRef.current?.firstElementChild as HTMLElement | null)
      ?? wrapRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    // Near the top of the viewport the card would be cut off above the
    // bar, so it flips underneath instead.
    const below = rect.top < 180;
    setPos({
      left: Math.min(Math.max(rect.left + rect.width / 2, 150), window.innerWidth - 150),
      top: below ? rect.bottom + 8 : rect.top - 8,
      below,
    });
  };

  const onEnter = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(show, HOVER_DELAY_MS);
  };
  const onLeave = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setPos(null);
  };

  const where = [item.client_name, item.site_name].filter(Boolean).join(' · ');
  const scheduled = item.scheduled_start
    ? range(item.scheduled_start, item.scheduled_end) : null;
  const actual = actualRange(item);
  const route = moveRoute(item);

  return (
    <span ref={wrapRef} className={`ihv-wrap${className ? ` ${className}` : ''}`}
          style={style} onMouseEnter={onEnter} onMouseLeave={onLeave}>
      {children}
      {/* portaled to <body>: the card must escape the calendar grid,
          which clips its own overflow to keep the month's corners. */}
      {pos && createPortal(
        <div className={`ihv-card${pos.below ? ' below' : ''}`} role="tooltip"
             style={{ left: pos.left, top: pos.top }}>
          <span className="ihv-name">{item.name}</span>
          <span className="ihv-tags">
            <span className="chip custom" style={chipStyle(item.status_color)}>
              <span className="dot" />{item.status_label}
            </span>
            <span className="chip custom" style={chipStyle(item.type_color)}>
              <span className="dot" />{item.type_label}
            </span>
          </span>
          {where && <span className="ihv-line">{where}</span>}
          {scheduled && (
            <span className="ihv-line">
              <span className="ihv-label">Scheduled:</span>{' '}{scheduled}
            </span>
          )}
          {actual && (
            <span className="ihv-line">
              <span className="ihv-label">Actual:</span>{' '}{actual}
            </span>
          )}
          {route && <span className="ihv-line ihv-route">{route}</span>}
        </div>,
        document.body,
      )}
    </span>
  );
}
