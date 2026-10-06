/**
 * useMenuPlacement — where a dropdown menu (ComboBox, TagInput) opens.
 *
 * Decides the drop-up flip from the room around the trigger, and whether
 * the menu portals: rendered under the enclosing .portal-shell (document.body
 * without one) with fixed positioning,
 * either because the caller asks (`portal`) or because the trigger sits
 * inside a `.modal-card`, whose `overflow-y: auto` would otherwise clip it.
 * The `.modal-card` check runs each time the menu opens (in a layout
 * effect, so the corrected render lands before the first paint) rather
 * than once on mount, since the component can be re-parented.
 *
 * The menu portals into the trigger's enclosing `.portal-shell` when there
 * is one (document.body otherwise): the theme tokens (--surface,
 * --paper-line, --text-dark, --accent-rgb, the dark palette) are declared on
 * the shell, not on :root, so a menu parked under document.body would lose
 * its border, its active highlight and its dark surface. A fixed-position
 * child of the shell is not clipped by the shell's overflow.
 *
 * A portaled menu is placed once per open (and again when `remeasure`
 * changes or it moves into the shell) and closes rather than tracking its
 * trigger: `onDismiss` is called for every resize, and for a window or
 * ancestor scroll that moved the trigger since the menu was placed. A
 * scroll that left the trigger where it was does not dismiss — focusing a
 * field below a scrolling dialog's visible part makes the browser scroll
 * the dialog during focus, and that scroll event arrives a frame after the
 * menu was already placed from the scrolled trigger. A scroll of the menu's
 * own list never dismisses.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';

/** Height (px) reserved for the menu when there's no room to measure it yet — mirrors .combo-menu's max-height. */
const MENU_NEEDED_HEIGHT = 260;
/** Gap (px) between the trigger and a portaled menu — mirrors .combo-menu's calc(100% + 6px). */
const MENU_GAP = 6;

/** Viewport placement of a portaled menu: below (top) or above (bottom) the trigger. */
interface Anchor { left: number; width: number; top?: number; bottom?: number }

/**
 * Pure flip decision: open the menu upward only when there isn't enough
 * room below the trigger AND there's more room above than below. Keeping
 * this pure (no DOM reads) makes it directly unit-testable.
 */
export function shouldDropUp({
  spaceBelow, spaceAbove, neededHeight = MENU_NEEDED_HEIGHT,
}: {
  spaceBelow: number;
  spaceAbove: number;
  neededHeight?: number;
}): boolean {
  return spaceBelow < neededHeight && spaceAbove > spaceBelow;
}

interface Options {
  /** the trigger's wrapper (its rect places the menu; its ancestry decides `.modal-card`) */
  wrapRef: RefObject<HTMLElement | null>;
  /** the rendered menu (measured for height; its own scroll never dismisses) */
  menuRef: RefObject<HTMLElement | null>;
  /** whether the menu is showing */
  open: boolean;
  /** always portal the menu, card or not */
  portal?: boolean;
  /** re-measure when this changes while open (the filter text: fewer matches, shorter menu) */
  remeasure?: unknown;
  /** close the menu: a portaled menu was scrolled away from or the window resized */
  onDismiss: () => void;
}

export interface MenuPlacement {
  /** render the menu through createPortal into `portalHost` */
  portaled: boolean;
  /** where a portaled menu goes: the enclosing .portal-shell (theme tokens), else document.body */
  portalHost: HTMLElement;
  /** add the `drop-up` class */
  dropUp: boolean;
  /** the menu's inline style: fixed placement when portaled, undefined in place */
  menuStyle: CSSProperties | undefined;
}

export function useMenuPlacement({
  wrapRef, menuRef, open, portal = false, remeasure, onDismiss,
}: Options): MenuPlacement {
  const [dropUp, setDropUp] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [inModalCard, setInModalCard] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);

  // The menu portals when asked to, or when it opened inside a modal card.
  const portaled = portal || inModalCard;

  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  // The trigger's viewport position when a portaled menu was last placed: a
  // scroll that leaves the trigger there hasn't moved it out from under the
  // menu, so it isn't a reason to close.
  const placedAt = useRef<{ top: number; left: number } | null>(null);

  // Decide the card question and the drop direction on open, and re-check
  // whenever `remeasure` changes while open (fewer/more matches can change
  // the menu's natural height). A portaled menu is also placed here, from
  // the same measurements. The first open of an explicit `portal` menu
  // renders under document.body before the shell is known; `host` in the
  // deps measures it again once it has moved into the shell (setting the
  // same host again is a no-op, so this can't loop).
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      placedAt.current = null;
      return;
    }
    const el = wrapRef.current;
    if (!el) return;
    const inCard = !!el.closest('.modal-card');
    setInModalCard(inCard);
    setHost(el.closest<HTMLElement>('.portal-shell'));
    const placed = portal || inCard;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    // Use the menu's actual rendered height when it's already in the DOM
    // with real content (shorter filtered lists need less room), capped at
    // the CSS max-height reference; fall back to the full reference height
    // if the list isn't measurable yet (e.g. momentarily empty).
    const actualHeight = menuRef.current?.getBoundingClientRect().height;
    const neededHeight = Math.min(MENU_NEEDED_HEIGHT, actualHeight || MENU_NEEDED_HEIGHT);
    const up = shouldDropUp({ spaceBelow, spaceAbove, neededHeight });
    setDropUp(up);
    placedAt.current = placed ? { top: rect.top, left: rect.left } : null;
    if (placed) {
      setAnchor(up
        ? { left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + MENU_GAP }
        : { left: rect.left, width: rect.width, top: rect.bottom + MENU_GAP });
    }
  }, [open, remeasure, portaled, portal, host, wrapRef, menuRef]);

  // A portaled menu does not follow its trigger, so a resize closes it, and
  // so does a scroll (the page or a scrolling ancestor — the capture phase
  // sees both) that moved the trigger since the menu was placed. A scroll
  // that left the trigger in place (the browser scrolling a dialog to bring
  // the focused field into view, its event arriving after the placement)
  // and a scroll of the menu's own list are not reasons to close.
  useEffect(() => {
    if (!open || !portaled) return undefined;
    const close = (e: Event) => {
      if (e.type === 'scroll') {
        const t = e.target;
        if (t instanceof Node && menuRef.current?.contains(t)) return;
        const at = placedAt.current;
        const r = wrapRef.current?.getBoundingClientRect();
        if (at && r && r.top === at.top && r.left === at.left) return;
      }
      dismiss.current();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, portaled, menuRef, wrapRef]);

  // Until the layout effect places it, a portaled menu renders hidden at
  // the viewport origin — so it can be measured just like the in-place one.
  const menuStyle: CSSProperties | undefined = !portaled ? undefined : anchor
    ? {
      position: 'fixed', left: anchor.left, width: anchor.width, right: 'auto',
      top: anchor.top ?? 'auto', bottom: anchor.bottom ?? 'auto', zIndex: 1200,
    }
    : { position: 'fixed', left: 0, top: 0, visibility: 'hidden', zIndex: 1200 };

  return { portaled, portalHost: host ?? document.body, dropUp, menuStyle };
}
