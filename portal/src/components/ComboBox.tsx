/**
 * ComboBox — the standard dropdown for data-backed lists: type to filter,
 * ↑↓/Enter keyboard control, click to select, Esc/outside-click to close.
 * House rule: any dropdown over records (people, orgs, …) uses this;
 * native <select> is only for tiny fixed enums.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

export interface ComboOption {
  value: string;
  label: string;
  sub?: string | null;
}

/** Height (px) reserved for the menu when there's no room to measure it yet — mirrors .combo-menu's max-height. */
const MENU_NEEDED_HEIGHT = 260;

/**
 * Pure flip decision: open the menu upward only when there isn't enough
 * room below the trigger AND there's more room above than below. Keeping
 * this pure (no DOM reads) makes it directly unit-testable.
 */
export function shouldDropUp({
  spaceBelow, spaceAbove, neededHeight = MENU_NEEDED_HEIGHT,
}: {
  spaceBelow: number;
  spaceAbove: number;
  neededHeight?: number;
}): boolean {
  return spaceBelow < neededHeight && spaceAbove > spaceBelow;
}

interface Props {
  options: ComboOption[];
  value: string;                       // '' = nothing selected
  onChange: (value: string) => void;
  placeholder?: string;
  onOpen?: () => void;                 // lazy-load hook
  clearable?: boolean;
  disabled?: boolean;
  inputId?: string;
  ariaLabel?: string;
}

export default function ComboBox({
  options, value, onChange, placeholder = 'Select…',
  onOpen, clearable = false, disabled = false, inputId, ariaLabel,
}: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(q));
  }, [options, filter]);

  useEffect(() => { setActive(0); }, [filter, open]);

  // Decide drop direction on open, and re-check whenever the filter changes
  // while open (fewer/more matches can change the menu's natural height).
  useLayoutEffect(() => {
    if (!open) return;
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    // Use the menu's actual rendered height when it's already in the DOM
    // with real content (shorter filtered lists need less room), capped at
    // the CSS max-height reference; fall back to the full reference height
    // if the list isn't measurable yet (e.g. momentarily empty).
    const actualHeight = listRef.current?.getBoundingClientRect().height;
    const neededHeight = Math.min(MENU_NEEDED_HEIGHT, actualHeight || MENU_NEEDED_HEIGHT);
    setDropUp(shouldDropUp({ spaceBelow, spaceAbove, neededHeight }));
  }, [open, filter]);

  useEffect(() => {
    listRef.current
      ?.querySelector('.kbar-item.active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // outside click closes
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setFilter('');
      }
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  const openList = () => {
    if (disabled) return;
    onOpen?.();
    setOpen(true);
  };

  const select = (v: string) => {
    onChange(v);
    setOpen(false);
    setFilter('');
    inputRef.current?.blur();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      e.preventDefault();
      openList();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % Math.max(visible.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + visible.length) % Math.max(visible.length, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (visible[active]) select(visible[active].value);
    } else if (e.key === 'Escape') {
      // Scope Escape to the open list: preventDefault so a host modal's own
      // Escape-closes-the-dialog listener (which checks defaultPrevented,
      // GenerateReportModal's convention) sees this Escape as "handled
      // here" and doesn't also dismiss the whole dialog. Nothing to scope
      // when the list is already closed, so default proceeds untouched.
      if (open) e.preventDefault();
      setOpen(false);
      setFilter('');
      inputRef.current?.blur();
    }
  };

  return (
    <div className="combo-wrap" ref={wrapRef}>
      <input
        ref={inputRef}
        id={inputId}
        className="org-select combo-input"
        value={open ? filter : (selected?.label ?? '')}
        placeholder={selected && !open ? selected.label : placeholder}
        disabled={disabled}
        onFocus={openList}
        onClick={openList}
        onChange={(e) => { setFilter(e.target.value); setOpen(true); }}
        onKeyDown={onKey}
        role="combobox"
        aria-expanded={open}
        aria-label={ariaLabel}
      />
      {clearable && value && !open ? (
        <button type="button" className="combo-caret" aria-label="Clear"
                onClick={() => onChange('')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
               strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
        </button>
      ) : (
        <span className="combo-caret" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </span>
      )}

      {open && (
        <div className={`combo-menu ${dropUp ? 'drop-up' : ''}`} ref={listRef}>
          {visible.length === 0 && (
            <div className="pop-empty">No matches{filter ? ` for “${filter.trim()}”` : ''}.</div>
          )}
          {visible.map((o, i) => (
            <button
              key={o.value}
              type="button"
              className={`kbar-item ${i === active ? 'active' : ''} ${o.value === value ? 'selected' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); select(o.value); }}
            >
              {o.label}
              {o.sub && <span className="sub">{o.sub}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
