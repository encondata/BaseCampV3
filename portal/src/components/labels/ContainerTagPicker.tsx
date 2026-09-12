/**
 * ContainerTagPicker — the per-row (and bulk) "Tag" control for Container
 * Labels: one of the six V2 `TAG_TYPES` choices (None, Priority, Vendor,
 * Accessories, E-Waste, Warehouse). A compact trigger shows the current
 * choice as a `chip custom` in the tag's own color (or a plain "No tag"
 * when unset) and opens a small `pop-menu` of the six choices — same
 * portaled-popover shape as `RowActionsMenu` (a `.dir-list`/`.mini-list`
 * row clips overflow, so the menu can't simply nest under the trigger).
 * The trigger stops propagation so clicking it inside a row never also
 * toggles that row's own selection.
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { TAG_CHOICES } from '../../lib/containerLabels';
import { TAG_TYPES, type TagKey } from '../../labels/tagTypes';
import '../../styles/column-menu.css';

const OPEN_UPWARD_THRESHOLD = 200;
const GAP = 4;

interface MenuPos { top: number | 'auto'; bottom: number | 'auto'; left: number }

export default function ContainerTagPicker({ value, onChange, disabled = false, label }: {
  value: TagKey | null;
  onChange: (tag: TagKey | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) { setPos(null); return; }
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    if (spaceBelow < OPEN_UPWARD_THRESHOLD) {
      setPos({ bottom: window.innerHeight - rect.top + GAP, top: 'auto', left: rect.left });
    } else {
      setPos({ top: rect.bottom + GAP, bottom: 'auto', left: rect.left });
    }
    const onScroll = () => setOpen(false);
    window.addEventListener('scroll', onScroll, true);
    return () => window.removeEventListener('scroll', onScroll, true);
  }, [open]);

  const current = value ? TAG_TYPES[value] : null;

  const pick = (tag: TagKey | null) => {
    setOpen(false);
    onChange(tag);
  };

  return (
    <div className="tag-picker" ref={triggerRef} style={{ position: 'relative' }}>
      <button type="button" className="mini-btn tag-picker-trigger" disabled={disabled}
              aria-haspopup="menu" aria-expanded={open} aria-label={label ?? 'Tag'}
              onClick={(e) => { e.stopPropagation(); if (!disabled) setOpen((v) => !v); }}>
        {current
          ? (
            <span className="chip custom" style={{ '--chip': current.color } as CSSProperties}>
              <span className="dot" />{current.label}
            </span>
          )
          : <span className="cell-sub">No tag</span>}
      </button>
      {open && pos && createPortal(
        <div className="pop-menu" role="menu" ref={menuRef}
             style={{ position: 'fixed', top: pos.top, bottom: pos.bottom, left: pos.left, zIndex: 1200 }}>
          <button type="button" role="menuitem" className="pop-item"
                  onClick={(e) => { e.stopPropagation(); pick(null); }}>
            None
          </button>
          {TAG_CHOICES.map((key) => {
            const def = TAG_TYPES[key];
            return (
              <button key={key} type="button" role="menuitem" className="pop-item"
                      onClick={(e) => { e.stopPropagation(); pick(key); }}>
                <span className="chip custom" style={{ '--chip': def.color } as CSSProperties}>
                  <span className="dot" />{def.label}
                </span>
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
}
