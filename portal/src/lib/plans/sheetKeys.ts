/**
 * The task sheet's keyboard, as MS Project and a spreadsheet have it. Pure:
 * the sheet maps a keydown to one of these actions and acts on it.
 *
 * With the grid focused (no editor open): arrows, Enter and Tab move the
 * active cell; F2 edits its value; a printable key starts editing with that
 * key (Backspace with nothing). Inside an editor: Enter and Tab commit and
 * move, Escape cancels, everything else types (arrows move the caret).
 * Anything with Ctrl, ⌘ or Alt is a shortcut, left to the toolbar's keyboard
 * map (Task 7), as are Delete and Insert.
 */
import type { MoveDir } from './selection';

/** The parts of a keydown these read. */
export interface KeyLike {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

export type GridAction =
  | { kind: 'move'; dir: MoveDir }
  /** `seed` null: start from the cell's value (F2); else from this text. */
  | { kind: 'edit'; seed: string | null }
  | { kind: 'none' };

export type EditorAction =
  /** `dir` null: commit and stay (the editor lost focus). */
  | { kind: 'commit'; dir: MoveDir | null }
  | { kind: 'cancel' }
  | { kind: 'none' };

const ARROWS: Readonly<Record<string, MoveDir>> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
};

const shortcut = (e: KeyLike) => e.ctrlKey || e.metaKey || e.altKey;

/** A key on the focused grid. */
export function gridKey(e: KeyLike): GridAction {
  if (e.isComposing || shortcut(e)) return { kind: 'none' };
  const arrow = ARROWS[e.key];
  if (arrow) return { kind: 'move', dir: arrow };
  if (e.key === 'Enter') return { kind: 'move', dir: e.shiftKey ? 'up' : 'down' };
  if (e.key === 'Tab') return { kind: 'move', dir: e.shiftKey ? 'left' : 'right' };
  if (e.key === 'F2' && !e.shiftKey) return { kind: 'edit', seed: null };
  if (e.key === 'Backspace') return { kind: 'edit', seed: '' };
  // one character (named keys like "Shift" or "F5" are longer)
  if ([...e.key].length === 1) return { kind: 'edit', seed: e.key };
  return { kind: 'none' };
}

/** A key inside a cell editor. */
export function editorKey(e: KeyLike): EditorAction {
  if (e.isComposing) return { kind: 'none' };
  if (e.key === 'Escape') return { kind: 'cancel' };
  if (shortcut(e)) return { kind: 'none' };
  if (e.key === 'Enter') return { kind: 'commit', dir: e.shiftKey ? 'up' : 'down' };
  if (e.key === 'Tab') return { kind: 'commit', dir: e.shiftKey ? 'left' : 'right' };
  return { kind: 'none' };
}

/**
 * The scroll position that brings `[start, start + size)` into a box
 * scrolled to `scroll` and `view` long, whose first `inset` pixels are
 * covered (the sticky header); null when it is already in view. Content
 * coordinates, so it works for rows (down) and columns (across).
 */
export function scrollToShow(start: number, size: number, scroll: number, view: number, inset: number): number | null {
  if (start < scroll + inset) return Math.max(0, start - inset);
  if (start + size > scroll + view) return start + size - view;
  return null;
}
