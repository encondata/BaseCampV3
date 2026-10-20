/**
 * The label builder's keyboard (spec §5, labels/builder/shortcuts.ts). One
 * listener on `document` in the capture phase, so the builder hears a key
 * before the Topbar's own `/` (a bubble-phase document listener) and before
 * the browser acts on ⌘S, ⌘P or ⌘R.
 *
 * A key runs the handler of the shortcut it matches. While focus is in a
 * text box only the `always` shortcuts (save, test print, the sheet) run.
 * A widget that runs its own keys (a menu, a listbox, tabs, a trigger that
 * opens a list, the placed-fields table) keeps the keys it uses — arrows,
 * Tab, Enter and Space, and inside an open menu or list its letters and
 * Escape — while `/`, Delete, Escape elsewhere and every ⌘ / ⌥ shortcut
 * still reach the builder (widgetKeeps). Enter and Tab stay with a focused
 * button or link. A handled key has its
 * default prevented and, Escape aside (the Topbar closes its popovers on
 * it), stops propagating. A handler that returns `false` declines: the key
 * then goes on as if nothing listened. Several hooks can listen at once
 * (the canvas and the page); the first to handle a key takes it.
 */

import { useEffect, useRef } from 'react';

import { detectPlatform, matchShortcut, type Platform } from '../../../labels/builder/shortcuts';

/** Runs a shortcut; returning `false` leaves the key unhandled. */
export type ShortcutHandler = (e: KeyboardEvent) => void | boolean;

/** Shortcut id (shortcuts.ts `SHORTCUTS`) → its handler. */
export type ShortcutHandlers = Partial<Record<string, ShortcutHandler>>;

export interface ShortcutOptions {
  /** Listen at all (default true). */
  enabled?: boolean;
  /** Defaults to the browser's (⌘ on a Mac, Ctrl elsewhere). */
  platform?: Platform;
}

/** Keys a focused button or link uses itself. */
const CONTROL_KEYS = new Set(['select.next', 'select.previous', 'edit.content']);

/** A key the Topbar must still see. */
const SHARED_KEYS = new Set(['tool.escape']);

/** Widgets that run their own keys: menus, listboxes, tabs, a trigger that
 *  opens one, and anything marked `data-builder-keys="own"` (the
 *  placed-fields table). Which keys they keep: widgetKeeps. */
const OWN_KEYS = [
  '[role="menu"]', '[role="menubar"]', '[role="menuitem"]', '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]', '[role="listbox"]', '[role="option"]', '[role="tablist"]', '[role="tab"]',
  '[role="grid"]', '[aria-haspopup="listbox"]', '[aria-haspopup="menu"]', '[aria-haspopup="true"]',
  '[data-builder-keys="own"]',
].join(', ');

/** An open menu or list, where letters jump and Escape closes it. */
const OPEN_LIST = '[role="menu"], [role="menubar"], [role="listbox"]';

export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

export function isControl(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest('button, a[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"]');
}

/** Focus is in a widget that runs its own plain keys (OWN_KEYS). */
export function ownsKeys(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof el.closest !== 'function') return false;
  return !!el.closest(OWN_KEYS);
}

/** Whether the widget focus is in keeps `shortcut`'s key: arrows (move),
 *  Tab and ⇧Tab (select.next / previous) and Enter (edit.content), plus the
 *  letters (tool.*) and Escape inside an open menu or list. Never a ⌘ /
 *  Ctrl / ⌥ shortcut, nor `/` (field search), Delete, or Escape outside a
 *  list (it deselects). */
export function widgetKeeps(shortcutId: string, e: Pick<KeyboardEvent, 'target' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || !ownsKeys(e.target)) return false;
  if (shortcutId.startsWith('move.') || CONTROL_KEYS.has(shortcutId)) return true;
  const inList = !!(e.target as Element).closest(OPEN_LIST);
  return inList && shortcutId.startsWith('tool.');
}

/** A button or link the keyboard reached (Tab), not one a click left focus
 *  on: Space is its own then (it presses it), not the canvas's pan. */
export function isKeyboardControl(target: EventTarget | null): boolean {
  if (!isControl(target)) return false;
  try {
    return (target as Element).matches(':focus-visible');
  } catch {
    return true;
  }
}

export function useBuilderShortcuts(handlers: ShortcutHandlers, options: ShortcutOptions = {}): void {
  const { enabled = true, platform } = options;
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (!enabled) return undefined;
    const os = platform ?? detectPlatform();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const shortcut = matchShortcut(e, os);
      if (!shortcut) return;
      if (shortcut.when !== 'always' && isTypingTarget(e.target)) return;
      if (shortcut.when !== 'always' && widgetKeeps(shortcut.id, e)) return;
      if (CONTROL_KEYS.has(shortcut.id) && isControl(e.target)) return;
      const run = latest.current[shortcut.id];
      if (!run || run(e) === false) return;
      e.preventDefault();
      if (!SHARED_KEYS.has(shortcut.id)) e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [enabled, platform]);
}
