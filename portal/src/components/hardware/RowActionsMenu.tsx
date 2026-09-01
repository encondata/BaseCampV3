/** One compact row-actions trigger opening a pop-menu — replaces
 *  per-row button strips on the device lists. Items are supplied
 *  pre-gated (an item the user may not use is simply not passed), so
 *  an empty list means no trigger at all.
 *
 *  The open menu is portaled to document.body (see StatusHover for the
 *  same pattern) rather than nested under the trigger: list containers
 *  (.dir-list) clip overflow for their rounded corners, which would
 *  otherwise clip/eat clicks on the menu whenever it opens on the last
 *  row of a list. Position is computed from the trigger's
 *  getBoundingClientRect — below and right-aligned to the trigger by
 *  default, flipped upward when there isn't ~200px of viewport space
 *  below it. */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import '../../styles/column-menu.css';

export interface RowAction {
  key: string;
  label: string;
  onSelect: () => void;
  destructive?: boolean;
}

interface MenuPos { top: number | 'auto'; bottom: number | 'auto'; right: number }

const OPEN_UPWARD_THRESHOLD = 200;
const GAP = 6;

export function RowActionsMenu({ label, actions }: {
  label?: string; actions: RowAction[];
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Outside-mousedown close, hand-rolled rather than listTools'
  // useOutsideClose: once open, the menu lives in a portal under
  // document.body, outside the trigger's DOM subtree. A single
  // containment ref would see every mousedown on a menu item as
  // "outside" and close the menu before the item's own onClick (select
  // + close) runs, so both the trigger and the portaled menu are
  // checked here.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Anchor the portaled menu to the trigger's current position. A
  // window scroll closes the menu rather than re-tracking position —
  // simple, and matches the "escape overflow" scope of this fix without
  // adding scroll-follow complexity.
  useEffect(() => {
    if (!open) { setPos(null); return; }
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const right = window.innerWidth - rect.right;
    if (spaceBelow < OPEN_UPWARD_THRESHOLD) {
      setPos({ bottom: window.innerHeight - rect.top + GAP, top: 'auto', right });
    } else {
      setPos({ top: rect.bottom + GAP, bottom: 'auto', right });
    }
    const onScroll = () => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open]);

  if (actions.length === 0) return null;
  return (
    <div className="row-actions" ref={triggerRef} style={{ position: 'relative' }}>
      <button type="button" className="mini-btn" aria-haspopup="menu"
              aria-expanded={open}
              onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}>
        {label ?? 'Actions'} ▾
      </button>
      {open && pos && createPortal(
        <div className="pop-menu" role="menu" ref={menuRef}
             style={{
               position: 'fixed', top: pos.top, bottom: pos.bottom, right: pos.right,
               zIndex: 1200,
             }}>
          {actions.map((a) => (
            <button key={a.key} type="button" role="menuitem"
                    className={`pop-item${a.destructive ? ' danger' : ''}`}
                    onClick={(e) => { e.stopPropagation(); setOpen(false); a.onSelect(); }}>
              {a.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
