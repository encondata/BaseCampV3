/**
 * Tip — a styled hover tip for one trigger element (a toolbar button), in
 * place of the browser's native `title`.
 *
 * - Shows 350 ms into a hover, and at once on keyboard focus (the
 *   `:focus-visible` rule: focus that came from the keyboard, never the
 *   focus a mouse click gives). Hides on pointer leave, blur, Escape, Enter
 *   or Space on the trigger (it was used), any pointer press, a scroll or
 *   a resize, and when the trigger turns disabled while it shows (its
 *   state changed under the tip; a fresh hover shows the new reason). One
 *   tip shows at a time.
 * - Content: a label, the shortcut as keycaps (`keys`, one keycap per
 *   binding of the builder's "⌘⇧Z" / "Delete / Backspace" strings), and an
 *   optional second line (`note`: why a button is off).
 * - Portals into the trigger's enclosing `.portal-shell` (its theme tokens;
 *   document.body without one) with `position: fixed`, below the trigger
 *   and centered on it, flipped above when there's no room below, kept
 *   inside the viewport horizontally (`placeTip`). The tip itself takes no
 *   pointer events.
 * - The trigger sits in an inline-flex `.tip-trigger` span that takes the
 *   pointer events, so a disabled button (which gets none of its own;
 *   styles/tip.css lets them through to the span) still shows its tip.
 *   While the tip shows, the trigger carries `aria-describedby` naming it
 *   (`role="tooltip"`); the trigger's own `title` is dropped, so there are
 *   never two tooltips.
 */

import {
  cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
} from 'react';
import type { FocusEvent, ReactElement, ReactNode } from 'react';
import { createPortal } from 'react-dom';

import '../styles/tip.css';

/** How long a hover rests on the trigger before the tip shows. */
export const TIP_DELAY_MS = 350;
/** Gap (px) between the trigger and the tip. */
const GAP = 6;
/** The tip keeps this far (px) inside the viewport's edges. */
const MARGIN = 8;

interface Rect { left: number; top: number; width: number; bottom: number }
interface Size { width: number; height: number }
export interface TipPlacement { left: number; top: number; placement: 'below' | 'above' }

/** Where the tip goes: below the trigger and centered on it, above when
 *  there's no room below (and room above, or more of it than below), its
 *  left edge kept inside the viewport. Pure, for the tests. */
export function placeTip(trigger: Rect, tip: Size, viewport: Size): TipPlacement {
  const belowTop = trigger.bottom + GAP;
  const aboveTop = trigger.top - GAP - tip.height;
  const fitsBelow = belowTop + tip.height <= viewport.height - MARGIN;
  const fitsAbove = aboveTop >= MARGIN;
  const roomBelow = viewport.height - trigger.bottom;
  const above = !fitsBelow && (fitsAbove || trigger.top > roomBelow);
  const centered = trigger.left + trigger.width / 2 - tip.width / 2;
  const left = Math.max(MARGIN, Math.min(centered, viewport.width - MARGIN - tip.width));
  return { left: Math.round(left), top: Math.round(above ? aboveTop : belowTop), placement: above ? 'above' : 'below' };
}

// Keyboard or pointer: whichever the person used last. A focus that
// follows a key press is a keyboard focus (what :focus-visible matches);
// one that follows a pointer press isn't. `presses` counts pointer
// presses: one during a hover's delay cancels its tip.
let keyboardModality = false;
let presses = 0;
let watching = false;

function watchModality(): void {
  if (watching || typeof document === 'undefined') return;
  watching = true;
  document.addEventListener('keydown', (e) => {
    if (!e.metaKey && !e.ctrlKey && !e.altKey) keyboardModality = true;
  }, true);
  document.addEventListener('pointerdown', () => { keyboardModality = false; presses += 1; }, true);
  document.addEventListener('mousedown', () => { keyboardModality = false; }, true);
}

// The tip on screen now: showing another closes it.
let closeShown: (() => void) | null = null;

export default function Tip({ label, keys, note, children }: {
  label: string;
  /** The shortcut as the platform shows it ("⌘⇧Z", "Ctrl+Shift+Z"); several
   *  bindings separated by " / ". */
  keys?: string | null;
  /** A second line, e.g. why the trigger is off. */
  note?: ReactNode;
  /** The one trigger element (a button). */
  children: ReactElement;
}) {
  const tipId = `tip-${useId().replace(/:/g, '')}`;
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<TipPlacement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => { watchModality(); }, []);

  const clearTimer = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const hide = useCallback(() => {
    clearTimer();
    if (closeShown === hide) closeShown = null;
    setOpen(false);
    setPos(null);
  }, []);

  const show = useCallback(() => {
    clearTimer();
    if (closeShown && closeShown !== hide) closeShown();
    closeShown = hide;
    setHost(wrapRef.current?.closest<HTMLElement>('.portal-shell') ?? document.body);
    setOpen(true);
  }, [hide]);

  useEffect(() => () => {
    clearTimer();
    if (closeShown === hide) closeShown = null;
  }, [hide]);

  // Place it once it has rendered (hidden) and can be measured; before the
  // first paint, so it never shows in the wrong place.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = wrapRef.current?.getBoundingClientRect();
    const box = tipRef.current?.getBoundingClientRect();
    if (!trigger || !box) return;
    setPos(placeTip(trigger, box, { width: window.innerWidth, height: window.innerHeight }));
  }, [open, host, label, keys, note]);

  // While it shows: Escape, any pointer press, a scroll or a resize hide it.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', hide, true);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [open, hide]);

  // the trigger turned off while its tip showed: the tip is stale
  const disabled = !!(children.props as { disabled?: boolean }).disabled;
  const wasDisabled = useRef(disabled);
  useEffect(() => {
    if (disabled && !wasDisabled.current) hide();
    wasDisabled.current = disabled;
  }, [disabled, hide]);

  const onPointerEnter = () => {
    clearTimer();
    const at = presses;
    timer.current = window.setTimeout(() => { if (presses === at) show(); }, TIP_DELAY_MS);
  };
  const onFocus = (e: FocusEvent) => {
    if (keyboardModality && e.target !== wrapRef.current) show();
  };

  const own = (children.props as { 'aria-describedby'?: string })['aria-describedby'];
  const trigger = cloneElement(children as ReactElement<Record<string, unknown>>, {
    title: undefined,
    'aria-describedby': open ? [own, tipId].filter(Boolean).join(' ') : own,
  });
  const keycaps = keys ? keys.split(' / ').filter(Boolean) : [];

  return (
    <span ref={wrapRef} className="tip-trigger" onPointerEnter={onPointerEnter} onPointerLeave={hide}
      onPointerDown={hide} onFocus={onFocus} onBlur={hide}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') hide(); }}>
      {trigger}
      {open && createPortal(
        <div ref={tipRef} id={tipId} role="tooltip" className={`tip${pos ? ` is-${pos.placement}` : ''}`}
          data-placement={pos?.placement}
          style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: 'hidden' }}>
          <span className="tip-main">
            <span className="tip-label">{label}</span>
            {keycaps.map((k) => <kbd key={k} className="tip-kbd">{k}</kbd>)}
          </span>
          {note ? <span className="tip-note">{note}</span> : null}
        </div>,
        host ?? document.body,
      )}
    </span>
  );
}
