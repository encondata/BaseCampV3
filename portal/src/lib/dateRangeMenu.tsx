/**
 * Column header menu for a date column that filters by a From / To day range
 * instead of text or values (omit `range` for a sort-only menu). Same trigger, popover and sort rows as
 * lib/columnMenu.tsx's ColumnMenu (same classes, same portaling), so it sits
 * in a list header beside the ordinary column menus.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import { usePortaledMenu } from './listTools';
import type { DayRange } from './rawScanQuery';
import '../styles/column-menu.css';

const MENU_WIDTH = 220;
const MENU_HEIGHT = 260;

export function DateRangeMenu({ label, range, onChange, sortDir, onSort }: {
  label: string;
  /** Current range; omit it (and `onChange`) for a sort-only menu. */
  range?: DayRange;
  onChange?: (range: DayRange) => void;
  sortDir: 1 | -1 | null;
  /** 1 = oldest first, -1 = newest first. */
  onSort: (dir: 1 | -1) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const { triggerRef: ref, menuRef, pos, host } = usePortaledMenu(
    open, () => setOpen(false), { width: MENU_WIDTH, height: MENU_HEIGHT });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const filtered = Boolean(range && (range.from || range.to));

  // A start after the end would match nothing: move the other end with it.
  const setFrom = (from: string) => range && onChange?.({
    from, to: from && range.to && from > range.to ? from : range.to });
  const setTo = (to: string) => range && onChange?.({
    from: to && range.from && to < range.from ? to : range.from, to });

  return (
    <div className="pop-wrap colmenu" ref={ref}>
      <button type="button" className={`colmenu-trigger ${filtered ? 'filtered' : ''}`}
              aria-label={`${label} column menu`} aria-pressed={filtered}
              onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 5h18l-7 8.5V19l-4 2v-7.5L3 5z" />
        </svg>
      </button>
      {open && pos && host && createPortal(
        <div className="pop-menu colmenu-menu colmenu-portaled" ref={menuRef}
             style={{
               top: pos.top, left: pos.left, right: pos.right, bottom: pos.bottom,
               maxHeight: pos.maxHeight, overflowY: 'auto',
             }}>
          <div className="colmenu-sort">
            <button type="button" className={`pop-item ${sortDir === 1 ? 'on' : ''}`}
                    onClick={() => onSort(1)}>
              Oldest first
            </button>
            <button type="button" className={`pop-item ${sortDir === -1 ? 'on' : ''}`}
                    onClick={() => onSort(-1)}>
              Newest first
            </button>
          </div>
          {range && (
            <>
              <div className="pop-sep" />
              <label className="colmenu-field">
                <span>From</span>
                <input className="colmenu-search" type="date" aria-label={`${label} from date`}
                       value={range.from} max={range.to || undefined}
                       onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label className="colmenu-field">
                <span>To</span>
                <input className="colmenu-search" type="date" aria-label={`${label} to date`}
                       value={range.to} min={range.from || undefined}
                       onChange={(e) => setTo(e.target.value)} />
              </label>
              <div className="pop-sep" />
              <div className="colmenu-actions">
                <button type="button" className="pop-item"
                        onClick={() => onChange?.({ from: '', to: '' })}>
                  Clear filter
                </button>
              </div>
            </>
          )}
        </div>,
        host,
      )}
    </div>
  );
}
