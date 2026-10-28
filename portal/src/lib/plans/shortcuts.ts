/**
 * The plan's keyboard map (spec "Keyboard map", MS Project's keys): what
 * each shortcut does, its keys as Windows and a Mac show them (⌘ for Ctrl,
 * ⌥ for Alt), and the matcher components/plans/usePlanShortcuts uses.
 * The toolbar's tooltips and the Keyboard shortcuts dialog read the same
 * table, so they never disagree with what a key does.
 *
 * A Mac's delete key is Backspace, which the sheet keeps (it clears the
 * cell and starts editing, as in Excel); deleting tasks is the forward
 * delete (fn ⌫). A PC keyboard's Insert key arrives on a Mac as Help.
 */
import type { Platform } from '../../labels/builder/shortcuts';

export type { Platform } from '../../labels/builder/shortcuts';
export { detectPlatform } from '../../labels/builder/shortcuts';

export type PlanShortcutId =
  | 'insert' | 'delete' | 'indent' | 'outdent' | 'link' | 'unlink' | 'info' | 'undo' | 'redo'
  | 'scrollToTask' | 'collapse' | 'expand' | 'find' | 'help' | 'copy' | 'cut' | 'paste' | 'exitFullScreen';

export interface PlanShortcut {
  id: PlanShortcutId;
  label: string;
  win: string;
  mac: string;
}

export const PLAN_SHORTCUTS: readonly PlanShortcut[] = [
  { id: 'insert', label: 'Insert a task above', win: 'Insert', mac: 'Insert' },
  { id: 'delete', label: 'Delete the selected tasks', win: 'Delete', mac: '⌦ (fn ⌫)' },
  { id: 'indent', label: 'Indent', win: 'Alt+Shift+→', mac: '⌥⇧→' },
  { id: 'outdent', label: 'Outdent', win: 'Alt+Shift+←', mac: '⌥⇧←' },
  { id: 'link', label: 'Link the selected tasks', win: 'Ctrl+F2', mac: '⌘F2' },
  { id: 'unlink', label: 'Unlink the selected tasks', win: 'Ctrl+Shift+F2', mac: '⌘⇧F2' },
  { id: 'info', label: 'Task Information', win: 'Shift+F2', mac: '⇧F2' },
  { id: 'undo', label: 'Undo', win: 'Ctrl+Z', mac: '⌘Z' },
  { id: 'redo', label: 'Redo', win: 'Ctrl+Y or Ctrl+Shift+Z', mac: '⌘Y or ⌘⇧Z' },
  { id: 'scrollToTask', label: 'Scroll to task', win: 'Ctrl+Shift+F5', mac: '⌘⇧F5' },
  { id: 'collapse', label: 'Hide subtasks', win: 'Alt+Shift+−', mac: '⌥⇧−' },
  { id: 'expand', label: 'Show subtasks', win: 'Alt+Shift++', mac: '⌥⇧+' },
  { id: 'find', label: 'Find a task', win: 'Ctrl+F', mac: '⌘F' },
  { id: 'copy', label: 'Copy the selected tasks', win: 'Ctrl+C', mac: '⌘C' },
  { id: 'cut', label: 'Cut the selected tasks', win: 'Ctrl+X', mac: '⌘X' },
  { id: 'paste', label: 'Paste tasks, or cells from Excel', win: 'Ctrl+V', mac: '⌘V' },
  { id: 'help', label: 'Keyboard shortcuts', win: '?', mac: '?' },
  // PlanTab's own key (full screen), not the matcher's
  { id: 'exitFullScreen', label: 'Exit full screen', win: 'Esc', mac: 'Esc' },
];

/** The sheet's own keys, for the dialog (lib/plans/sheetKeys does them). */
export const SHEET_KEYS: readonly { label: string; win: string; mac: string }[] = [
  { label: 'Move the active cell', win: '↑ ↓ ← →', mac: '↑ ↓ ← →' },
  { label: 'Edit the cell', win: 'F2, or start typing', mac: 'F2, or start typing' },
  { label: 'Save and move down / up', win: 'Enter / Shift+Enter', mac: '⏎ / ⇧⏎' },
  { label: 'Save and move right / left', win: 'Tab / Shift+Tab', mac: '⇥ / ⇧⇥' },
  { label: 'Cancel the edit', win: 'Esc', mac: 'Esc' },
  { label: 'Select rows', win: 'Click an ID; Shift or Ctrl to add', mac: 'Click an ID; ⇧ or ⌘ to add' },
];

const BY_ID = new Map(PLAN_SHORTCUTS.map((s) => [s.id, s]));

/** A shortcut's keys as `platform` shows them ("" for none). */
export function planShortcutKeys(id: PlanShortcutId, platform: Platform): string {
  const s = BY_ID.get(id);
  return s ? s[platform] : '';
}

/** What the matcher reads from a keydown. */
export type ShortcutKey = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>;

/** The shortcut a key press is on `platform`, or null. Ctrl (⌘ on a Mac)
 *  must match exactly; the other one must not be held. Letters read the
 *  character typed; Alt+Shift+− and + read the physical key, since ⌥⇧
 *  turns them into other characters on a Mac. */
export function matchPlanShortcut(e: ShortcutKey, platform: Platform): PlanShortcutId | null {
  const mod = platform === 'mac' ? e.metaKey : e.ctrlKey;
  if (platform === 'mac' ? e.ctrlKey : e.metaKey) return null;
  const { key, code, shiftKey: shift, altKey: alt } = e;
  if (!mod && !alt) {
    if (key === '?') return 'help';
    if (shift) return key === 'F2' ? 'info' : null;
    if (key === 'Insert' || key === 'Help') return 'insert';
    if (key === 'Delete') return 'delete';
    return null;
  }
  if (alt) {
    if (mod || !shift) return null;
    if (key === 'ArrowRight') return 'indent';
    if (key === 'ArrowLeft') return 'outdent';
    if (code === 'Minus' || code === 'NumpadSubtract') return 'collapse';
    if (code === 'Equal' || code === 'NumpadAdd') return 'expand';
    return null;
  }
  if (key === 'F2') return shift ? 'unlink' : 'link';
  if (key === 'F5') return shift ? 'scrollToTask' : null;
  const letter = key.length === 1 ? key.toLowerCase() : '';
  if (letter === 'z') return shift ? 'redo' : 'undo';
  if (shift) return null;
  switch (letter) {
    case 'y': return 'redo';
    case 'f': return 'find';
    case 'c': return 'copy';
    case 'x': return 'cut';
    case 'v': return 'paste';
    default: return null;
  }
}
