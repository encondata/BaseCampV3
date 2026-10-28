/**
 * The plan's MS Project keyboard map (lib/plans/shortcuts), heard on the
 * tab root in the capture phase: before the sheet's own keys (the grid's
 * onKeyDown, which would start editing on `?`), after a field's own
 * capture handlers. Modeled on components/labels/builder/
 * useBuilderShortcuts.ts.
 *
 * Review Focus 3: a shortcut acts on the sheet only when nothing else owns
 * the key. It is skipped while
 *  - a dialog is open (`.modal-scrim`: the dialog has the keyboard);
 *  - focus is in a field (`isTypingTarget`: input, select, textarea,
 *    contenteditable) or anywhere in a cell editor or the Resource Names
 *    picker — there Delete, Insert, the arrows and Alt+Shift+→ type;
 *  - focus is in an open menu or list (it runs its own keys);
 *  - the key belongs to an IME composition (`isComposing`, or Safari's
 *    keyCode 229).
 *
 * A handler that returns `false` declines: the key goes on as if nobody
 * listened (Ctrl+F before the search box exists keeps the browser's find).
 * A handled key has its default prevented and goes no further — except
 * Ctrl+C / X / V, which run their handler and leave the browser its own
 * copy, cut and paste event (the clipboard's sure path; see usePlanCommands).
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

import { isTypingTarget } from '../labels/builder/useBuilderShortcuts';
import { detectPlatform, matchPlanShortcut, type PlanShortcutId, type Platform } from '../../lib/plans/shortcuts';

export type PlanShortcutHandler = (e: KeyboardEvent) => void | boolean;
export type PlanShortcutHandlers = Partial<Record<PlanShortcutId, PlanShortcutHandler>>;

export interface PlanShortcutOptions {
  /** The tab root: the listener's element. */
  root: RefObject<HTMLElement | null>;
  /** Listen at all (default true). */
  enabled?: boolean;
  /** Defaults to the browser's (⌘ on a Mac, Ctrl elsewhere). */
  platform?: Platform;
}

/** The browser's clipboard event follows these. */
const PASSIVE: ReadonlySet<PlanShortcutId> = new Set(['copy', 'cut', 'paste']);

/** Where the keys are someone else's: a cell editor, the Resource Names
 *  picker, an open menu or list. */
const OWNS_KEYS = '.pln-editor, .pln-respick, [role="menu"], [role="menuitem"], [role="listbox"], [role="option"]';

/** True when a key at `target` is not the plan's to take (see the header). */
export function keysBelongElsewhere(target: EventTarget | null): boolean {
  if (document.querySelector('.modal-scrim')) return true;
  if (isTypingTarget(target)) return true;
  const el = target as Element | null;
  return !!el && typeof el.closest === 'function' && !!el.closest(OWNS_KEYS);
}

export function usePlanShortcuts(handlers: PlanShortcutHandlers, options: PlanShortcutOptions): void {
  const { root, enabled = true, platform } = options;
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });

  useEffect(() => {
    const el = root.current;
    if (!enabled || !el) return undefined;
    const os = platform ?? detectPlatform();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      const id = matchPlanShortcut(e, os);
      if (!id || keysBelongElsewhere(e.target)) return;
      const run = latest.current[id];
      if (!run || run(e) === false || PASSIVE.has(id)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener('keydown', onKey, true);
    return () => el.removeEventListener('keydown', onKey, true);
  }, [root, enabled, platform]);
}
