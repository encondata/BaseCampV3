/**
 * ComboBox — the standard dropdown for data-backed lists: type to filter,
 * ↑↓/Enter keyboard control, click to select, Esc/outside-click to close.
 * House rule: any dropdown over records (people, orgs, …) uses this;
 * native <select> is only for tiny fixed enums.
 *
 * The menu portals — renders under document.body with fixed positioning —
 * when `portal` is set (opt-in, for a ComboBox inside a sideways-scrolling
 * container such as a DataTable cell) OR automatically when the ComboBox
 * sits inside a `.modal-card`, whose `overflow-y: auto` would otherwise clip
 * it. A portaled menu is placed once per open and closes on any scroll or
 * resize rather than tracking its trigger.
 *
 * `onSearch` (opt-in) hands the typed text to the caller, who searches the
 * server and passes the matches back as `options`; the list then shows
 * them as given instead of filtering them again (a match on a field the
 * label doesn't show — an email — would otherwise disappear).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useMenuPlacement } from './useMenuPlacement';

// The flip decision lives with the shared placement hook; re-exported here
// for the callers and tests that import it from ComboBox.
export { shouldDropUp } from './useMenuPlacement';

export interface ComboOption {
  value: string;
  label: string;
  sub?: string | null;
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
  portal?: boolean;                    // always portal the menu (it portals by itself inside a .modal-card)
  onSearch?: (text: string) => void;   // the caller filters `options` (server search)
}

export default function ComboBox({
  options, value, onChange, placeholder = 'Select…',
  onOpen, clearable = false, disabled = false, inputId, ariaLabel, portal = false, onSearch,
}: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Drop-up flip, plus the portal (asked for, or inside a modal card) and
  // its placement and close-on-scroll/resize.
  const { portaled, dropUp, menuStyle } = useMenuPlacement({
    wrapRef, menuRef: listRef, open, portal, remeasure: filter,
    onDismiss: () => { setOpen(false); setFilter(''); },
  });

  const selected = options.find((o) => o.value === value);

  const searched = !!onSearch;
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q || searched) return options;
    return options.filter((o) =>
      `${o.label} ${o.sub ?? ''}`.toLowerCase().includes(q));
  }, [options, filter, searched]);

  useEffect(() => { setActive(0); }, [filter, open]);

  // every change of the typed text (including the reset on close) reaches onSearch
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  const lastSearch = useRef(filter);
  useEffect(() => {
    if (filter === lastSearch.current) return;
    lastSearch.current = filter;
    onSearchRef.current?.(filter);
  }, [filter]);

  useEffect(() => {
    listRef.current
      ?.querySelector('.kbar-item.active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  // outside click closes — a portaled menu lives outside wrapRef, so a
  // mousedown on it counts as inside too (otherwise this capture-phase
  // listener would close the menu before an option's mousedown selects).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (!wrapRef.current?.contains(target) && !listRef.current?.contains(target)) {
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

  const menu = (
    <div className={`combo-menu ${dropUp ? 'drop-up' : ''}`} ref={listRef} style={menuStyle}>
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
  );

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

      {open && (portaled ? createPortal(menu, document.body) : menu)}
    </div>
  );
}
