/** While `active` (the node's printing is off): ⌘P / Ctrl+P is stopped with
 *  a toast, and the page prints as a notice instead of its content —
 *  `body[data-no-print]` hides everything else when printing (wiki.css).
 *  The notice is a direct child of <body> so it survives that rule. Guards
 *  can overlap (a page inside another view), so the flag and the one notice
 *  are shared by a count of the active guards. A determined reader can still
 *  screenshot; the browser's own Print menu is covered by the same print CSS. */
import { useEffect } from 'react';

import { useToast } from '@portal/lib/notificationsContext';

export const PRINT_OFF_MESSAGE = 'Printing is turned off for this page.';

let activeGuards = 0;
let notice: HTMLDivElement | null = null;

function acquire() {
  activeGuards += 1;
  if (activeGuards !== 1) return;
  document.body.dataset.noPrint = '1';
  notice = document.createElement('div');
  notice.className = 'wiki-print-blocked';
  notice.textContent = PRINT_OFF_MESSAGE;
  document.body.appendChild(notice);
}

function release() {
  activeGuards = Math.max(0, activeGuards - 1);
  if (activeGuards !== 0) return;
  delete document.body.dataset.noPrint;
  notice?.remove();
  notice = null;
}

export default function PrintGuard({ active }: { active: boolean }) {
  const toast = useToast();

  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e: KeyboardEvent) => {
      // the code covers layouts where the key isn't a Latin letter (and ⌥⌘P,
      // which types "π"); a letter means the layout says what this key is
      // (Ctrl+L on Dvorak is the physical P key), so the code is ignored
      const isP = e.key === 'p' || e.key === 'P'
        || (!/^[A-Za-z]$/.test(e.key) && e.code === 'KeyP');
      // an overlapping guard has already handled it
      if (isP && (e.metaKey || e.ctrlKey) && !e.defaultPrevented) {
        e.preventDefault();
        toast(PRINT_OFF_MESSAGE);
      }
    };
    window.addEventListener('keydown', onKey, true);
    acquire();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      release();
    };
  }, [active, toast]);

  return null;
}
