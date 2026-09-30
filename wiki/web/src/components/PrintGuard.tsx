/** While `active` (the node's printing is off): ⌘P / Ctrl+P is stopped with
 *  a toast, and the page prints as a notice instead of its content —
 *  `body[data-no-print]` hides everything else when printing (wiki.css).
 *  The notice is portaled to <body> so it survives that rule. A determined
 *  reader can still screenshot; the browser's own Print menu is covered by
 *  the same print CSS. */
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

import { useToast } from '@portal/lib/notificationsContext';

export const PRINT_OFF_MESSAGE = 'Printing is turned off for this page.';

export default function PrintGuard({ active }: { active: boolean }) {
  const toast = useToast();

  useEffect(() => {
    if (!active) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'p' || e.key === 'P') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toast(PRINT_OFF_MESSAGE);
      }
    };
    window.addEventListener('keydown', onKey, true);
    document.body.dataset.noPrint = '1';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      delete document.body.dataset.noPrint;
    };
  }, [active, toast]);

  if (!active) return null;
  return createPortal(<div className="wiki-print-blocked">{PRINT_OFF_MESSAGE}</div>, document.body);
}
