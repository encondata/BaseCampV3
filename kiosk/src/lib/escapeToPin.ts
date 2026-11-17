/**
 * Esc → PIN pad, only when nothing else took that Esc. Most modals close on
 * Escape without preventDefault, so by the bubble phase the modal is already
 * gone. A capture-phase listener therefore notes whether a dialog was open
 * when the key went down, and the bubble-phase listener (on window, after
 * every document listener) opens the PIN pad only when none was and nothing
 * called preventDefault.
 */

import { openTakeovers } from './takeover';

const DIALOGS = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], .modal-scrim, .tcx-modal-scrim';

export function dialogOpen(doc: Document = document): boolean {
  return openTakeovers.length > 0 || doc.querySelector(DIALOGS) !== null;
}

export function installEscapeToPin(onEscape: () => void, win: Window = window): () => void {
  let busyAtCapture = false;
  const capture = (e: KeyboardEvent) => {
    if (e.key === 'Escape') busyAtCapture = dialogOpen(win.document);
  };
  const bubble = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const busy = busyAtCapture;
    busyAtCapture = false;
    if (busy || e.defaultPrevented || e.repeat) return;
    onEscape();
  };
  win.addEventListener('keydown', capture, true);
  win.addEventListener('keydown', bubble);
  return () => {
    win.removeEventListener('keydown', capture, true);
    win.removeEventListener('keydown', bubble);
  };
}
