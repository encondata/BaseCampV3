/**
 * InitiativeHoverCard — the hover card behind a calendar bar on
 * /initiatives/timeline. Wraps a bar and, after a 180ms intent delay,
 * shows the initiative's high-level details: name, status and type
 * chips, client · site, the scheduled and actual ranges, a move's
 * origin → destination and, for a project-plan viewer, one "Plan:" line
 * (`planLine`). It replaces the native `title` the bars used to carry,
 * which could only print one flat line and arrived on the browser's own
 * schedule. The mechanics alone are `PointerHoverCard`, which the page's
 * plan milestones share.
 *
 * Mechanics follow components/StatusHover.tsx: the 180ms delay, a
 * position:fixed card portaled to <body> so it escapes the calendar
 * grid's `overflow: hidden`, and pointer-events:none so the card never
 * steals the hover that opened it. Unlike StatusHover nothing is
 * fetched — every field is already on the InitiativeItem the bar
 * renders.
 *
 * It also tracks the POINTER rather than the trigger. StatusHover points
 * at a chip, which is small enough that its center is near the cursor; a
 * calendar bar can span a whole week, so centering on it put the card
 * inches from the mouse. The card sits just below and right of the
 * cursor, follows it along the bar, and flips to the other side of the
 * cursor near a viewport edge.
 *
 * The wrapper is `display: contents` (see styles/initiative-hover.css):
 * the bar is a grid item placed by the week row, and a wrapper with a
 * box of its own would take that placement away from it. Tracking the
 * pointer rather than a rect means the wrapper never needs a box.
 */

import {
  useEffect, useRef, useState,
  type CSSProperties, type MouseEvent, type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import type { InitiativeItem } from '../../lib/api';
import { longDateOf } from '../../lib/format';
import { parseApiDay } from '../../lib/timeline';
import '../../styles/initiative-hover.css';

const HOVER_DELAY_MS = 180;

/** Gap between the cursor and the card's nearest corner. Big enough that
 *  the card never sits under the pointer itself. */
const CURSOR_GAP_X = 14;
const CURSOR_GAP_Y = 18;

/** Used only to decide which side of the cursor the card goes on, before
 *  it has rendered and can be measured. The width is the card's own
 *  max-width; the height is a generous estimate of its tallest form (a
 *  move with every line present, the plan line too, measures ~170px).
 *  Guessing high just flips it early near an edge, which is the safe
 *  direction to be wrong. */
const CARD_W = 280;
const CARD_H = 200;
const EDGE = 8;

/** Where the card's top-left goes for a cursor at (x, y): below-right by
 *  default, flipped to the opposite side of the cursor on whichever axis
 *  would otherwise run past the viewport, then clamped so it can never
 *  leave the screen entirely. A card that knows its size (a measured one)
 *  passes it as `w`/`h`, so a flip puts it right beside the cursor. */
export function cardPosition(
  x: number, y: number, vw: number, vh: number, w: number = CARD_W, h: number = CARD_H,
): { left: number; top: number } {
  let left = x + CURSOR_GAP_X;
  if (left + w > vw - EDGE) left = x - CURSOR_GAP_X - w;
  let top = y + CURSOR_GAP_Y;
  if (top + h > vh - EDGE) top = y - CURSOR_GAP_Y - h;
  return {
    left: Math.max(EDGE, Math.min(left, vw - w - EDGE)),
    top: Math.max(EDGE, top),
  };
}

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

/**
 * The mechanics on their own: wraps `children` and, after the intent
 * delay, shows `card()` in the same dark, pointer-tracking `.ihv-card`.
 * The timeline page's plan milestones use it for their diamonds (name,
 * date, Complete / Late); InitiativeHoverCard below is it with the
 * initiative's details.
 */
export function PointerHoverCard({
  card, className, style, children,
}: {
  /** The card's content, built only while the card is up. */
  card: () => ReactNode;
  /** Extra classes for the wrapper. */
  className?: string;
  /** Inline styles for the wrapper. */
  style?: CSSProperties;
  children: ReactNode;
}) {
  const timerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  // The latest cursor position, kept out of state: it changes on every
  // mousemove and only the visible card needs to re-render for it.
  const cursorRef = useRef({ x: 0, y: 0 });
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
  }, []);

  const place = () => {
    const { x, y } = cursorRef.current;
    setPos(cardPosition(x, y, window.innerWidth, window.innerHeight));
  };

  const onEnter = (e: MouseEvent<HTMLElement>) => {
    cursorRef.current = { x: e.clientX, y: e.clientY };
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(place, HOVER_DELAY_MS);
  };

  // While the card is up, follow the pointer along the bar. Coalesced to
  // one reposition per frame so a fast sweep does not queue a render per
  // pixel; before the delay elapses this only records where the cursor is.
  const onMove = (e: MouseEvent<HTMLElement>) => {
    cursorRef.current = { x: e.clientX, y: e.clientY };
    if (!pos || frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      place();
    });
  };

  const onLeave = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    setPos(null);
  };

  return (
    <span className={`ihv-wrap${className ? ` ${className}` : ''}`}
          style={style} onMouseEnter={onEnter} onMouseMove={onMove} onMouseLeave={onLeave}>
      {children}
      {/* portaled to <body>: the card must escape the calendar grid,
          which clips its own overflow to keep the month's corners. */}
      {pos && createPortal(
        <div className="ihv-card" role="tooltip"
             style={{ left: pos.left, top: pos.top }}>
          {card()}
        </div>,
        document.body,
      )}
    </span>
  );
}

export default function InitiativeHoverCard({
  item, name, planLine, className, style, children,
}: {
  item: InitiativeItem;
  /** The heading, when the caller has a better one than the plain name —
   *  the calendar passes `Parent › Child` so a child's provenance is
   *  on the card as well as on the bar. Defaults to `item.name`. */
  name?: string;
  /** The initiative's project plan in one line ("Plan: 42% complete ·
   *  next: Move day Nov 14"), when it has one and the viewer may see it. */
  planLine?: string;
  /** Extra classes for the wrapper. */
  className?: string;
  /** Inline styles for the wrapper. */
  style?: CSSProperties;
  children: ReactNode;
}) {
  const card = () => {
    const where = [item.client_name, item.site_name].filter(Boolean).join(' · ');
    const scheduled = item.scheduled_start
      ? range(item.scheduled_start, item.scheduled_end) : null;
    const actual = actualRange(item);
    const route = moveRoute(item);
    return (
      <>
        <span className="ihv-name">{name ?? item.name}</span>
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
        {planLine && <span className="ihv-line">{planLine}</span>}
      </>
    );
  };
  return (
    <PointerHoverCard card={card} className={className} style={style}>
      {children}
    </PointerHoverCard>
  );
}
