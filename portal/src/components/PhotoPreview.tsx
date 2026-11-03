/**
 * PhotoPreview — wraps a person's avatar and, after a 300 ms hover, shows
 * a larger copy of their photo with their name underneath. The inline
 * avatar is a small circle or rounded square that crops the photo; the
 * preview shows the whole stored image (`object-fit: contain` in a
 * fixed 240 px box) so nothing is cut off.
 *
 *   <PhotoPreview src={p.avatar_url} name={p.name}>{avatar}</PhotoPreview>
 *
 * With no `src` (an initials avatar) it renders its children unchanged —
 * no wrapper element at all — so call sites can wrap unconditionally.
 *
 * Mechanics follow the portal's other hover cards:
 *  - the wrapper is `display: contents` (styles/photo-preview.css), so it
 *    has no box and the avatar's layout is exactly what it was; it still
 *    receives the mouseenter/mouseleave that bubble up from the avatar.
 *    The card anchors off the avatar's own rect (the wrapper's first
 *    element child).
 *  - portaled into `trigger.closest('.portal-shell') ?? document.body`,
 *    the same rule as `usePortaledMenu`: the theme tokens live on
 *    `.portal-shell`, so a body-level card would lose them and go white
 *    in the dark theme, while portaling still escapes `overflow: hidden`
 *    parents.
 *  - closes on mouse leave, any scroll (capture, so scrolling a list
 *    inside the page counts), Escape, and unmount; `pointer-events: none`
 *    so it never takes the hover from, or blocks clicks on, the row.
 *  - it never touches click handling: no handler here stops or consumes
 *    an event.
 */

import {
  useCallback, useEffect, useLayoutEffect, useRef, useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import '../styles/photo-preview.css';

export const PREVIEW_DELAY_MS = 300;
/** Space between the avatar and the card. */
const GAP = 10;
/** Keep the card at least this far inside the viewport. */
const EDGE = 8;
/** Card box before it has been measured: 240 px image + 6 px padding and
 *  1 px border either side, and the caption line under it. Only decides
 *  which side to open on for the first paint; the real size replaces it
 *  as soon as the card is laid out. */
const EST_W = 254;
const EST_H = 282;

export interface PreviewAnchor {
  left: number; right: number; top: number; bottom: number;
}

/** Where the card's top-left goes: right of the avatar by default,
 *  flipped to its left when the card would run past the viewport's right
 *  edge, vertically centered on the avatar and clamped inside the
 *  viewport. */
export function previewPosition(
  a: PreviewAnchor, vw: number, vh: number, w: number, h: number,
): { left: number; top: number } {
  let left = a.right + GAP;
  if (left + w > vw - EDGE) left = a.left - GAP - w;
  const centered = (a.top + a.bottom) / 2 - h / 2;
  return {
    left: Math.max(EDGE, Math.min(left, vw - w - EDGE)),
    top: Math.max(EDGE, Math.min(centered, vh - h - EDGE)),
  };
}

export default function PhotoPreview({ src, name, children }: {
  src: string | null | undefined;
  name: string;
  children: ReactNode;
}) {
  if (!src) return <>{children}</>;
  return <Preview src={src} name={name}>{children}</Preview>;
}

function Preview({ src, name, children }: {
  src: string; name: string; children: ReactNode;
}) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const [open, setOpen] = useState<{ host: HTMLElement } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const anchorRect = (): DOMRect | null => {
    const wrap = wrapRef.current;
    if (!wrap) return null;
    return ((wrap.firstElementChild as HTMLElement | null) ?? wrap).getBoundingClientRect();
  };

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  const close = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    setOpen(null);
    setPos(null);
  }, []);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  const show = () => {
    const wrap = wrapRef.current;
    const rect = anchorRect();
    if (!wrap || !rect) return;
    const host = (wrap.closest('.portal-shell') as HTMLElement | null) ?? document.body;
    setPos(previewPosition(rect, window.innerWidth, window.innerHeight, EST_W, EST_H));
    setOpen({ host });
  };

  const onEnter = () => {
    clearTimer();
    timerRef.current = window.setTimeout(show, PREVIEW_DELAY_MS);
  };

  // Once the card is laid out, replace the estimate with its measured
  // size (the caption row can differ from the estimate) before the
  // browser paints.
  useLayoutEffect(() => {
    if (!open) return;
    const card = cardRef.current;
    const rect = anchorRect();
    if (!card || !rect) return;
    const { width, height } = card.getBoundingClientRect();
    if (!width || !height) return;
    const next = previewPosition(rect, window.innerWidth, window.innerHeight, width, height);
    setPos((cur) => (cur && cur.left === next.left && cur.top === next.top ? cur : next));
  }, [open, src]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
    };
  }, [open, close]);

  return (
    <span ref={wrapRef} className="pp-wrap"
          onMouseEnter={onEnter} onMouseLeave={close}>
      {children}
      {open && pos && createPortal(
        <div ref={cardRef} className="pp-card" role="tooltip"
             style={{ left: pos.left, top: pos.top }}>
          <img className="pp-img" src={src} alt="" />
          <span className="pp-name">{name}</span>
        </div>,
        open.host,
      )}
    </span>
  );
}
