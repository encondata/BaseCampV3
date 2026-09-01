/** One compact row-actions trigger opening a pop-menu — replaces
 *  per-row button strips on the device lists. Items are supplied
 *  pre-gated (an item the user may not use is simply not passed), so
 *  an empty list means no trigger at all. Popover mechanics match the
 *  column menus (outside-click via listTools' useOutsideClose; Escape
 *  handled here). */

import { useEffect, useState } from 'react';

import { useOutsideClose } from '../../lib/listTools';
import '../../styles/column-menu.css';

export interface RowAction {
  key: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

export function RowActionsMenu({ label, actions }: {
  label?: string; actions: RowAction[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose<HTMLDivElement>(() => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (actions.length === 0) return null;
  return (
    <div className="row-actions" ref={ref} style={{ position: 'relative' }}>
      <button type="button" className="mini-btn" aria-haspopup="menu"
              aria-expanded={open}
              onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        {label ?? 'Actions'} ▾
      </button>
      {open && (
        <div className="pop-menu" role="menu">
          {actions.map((a) => (
            <button key={a.key} type="button" role="menuitem"
                    className={`pop-item${a.destructive ? ' danger' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setOpen(false); a.onSelect(); }}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
