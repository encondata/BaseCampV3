/**
 * ComboBox — the standard dropdown for data-backed lists: type to filter,
 * ↑↓/Enter keyboard control, click to select, Esc/outside-click to close.
 * House rule: any dropdown over records (people, orgs, …) uses this;
 * native <select> is only for tiny fixed enums.
 *
 * `portal` (opt-in) renders the menu under document.body with fixed
 * positioning, so a ComboBox inside a sideways-scrolling container (a
 * DataTable cell) is not clipped by it. A portaled menu is placed once per
 * open and closes on any scroll or resize rather than tracking its trigger.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';

export interface ComboOption {
  value: string;
  label: string;
  sub?: string | null;
}

/** Height (px) reserved for the menu when there's no room to measure it yet — mirrors .combo-menu's max-height. */
const MENU_NEEDED_HEIGHT = 260;
/** Gap (px) between the trigger and a portaled menu — mirrors .combo-menu's calc(100% + 6px). */
const MENU_GAP = 6;

/** Viewport placement of a portaled menu: below (top) or above (bottom) the trigger. */
interface Anchor { left: number; width: number; top?: number; bottom?: number }

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
  portal?: boolean;                    // menu under document.body — escapes overflow clipping
}

export default function ComboBox({
  options, value, onChange, placeholder = 'Select…',
  onOpen, clearable = false, disabled = false, inputId, ariaLabel, portal = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const [dropUp, setDropUp] = useState(false);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
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
  // A portaled menu is also placed here, from the same measurements.
  useLayoutEffect(() => {
    if (!open) {
      if (portal) setAnchor(null);
      return;
    }
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
    const up = shouldDropUp({ spaceBelow, spaceAbove, neededHeight });
    setDropUp(up);
    if (portal) {
      setAnchor(up
        ? { left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + MENU_GAP }
        : { left: rect.left, width: rect.width, top: rect.bottom + MENU_GAP });
    }
  }, [open, filter, portal]);

  // A portaled menu does not follow its trigger, so any scroll (the page or
  // a scrolling ancestor — the capture phase sees both) or resize closes
  // it. Scrolling the menu's own list is not a reason to close.
  useEffect(() => {
    if (!open || !portal) return;
    const close = (e: Event) => {
      const t = e.target;
      if (e.type === 'scroll' && t instanceof Node && listRef.current?.contains(t)) return;
      setOpen(false);
      setFilter('');
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, portal]);

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

  // Until the layout effect places it, a portaled menu renders hidden at
  // the viewport origin — so it can be measured just like the in-place one.
  const portalStyle: CSSProperties | undefined = !portal ? undefined : anchor
    ? {
      position: 'fixed', left: anchor.left, width: anchor.width, right: 'auto',
      top: anchor.top ?? 'auto', bottom: anchor.bottom ?? 'auto', zIndex: 1200,
    }
    : { position: 'fixed', left: 0, top: 0, visibility: 'hidden', zIndex: 1200 };

  const menu = (
    <div className={`combo-menu ${dropUp ? 'drop-up' : ''}`} ref={listRef} style={portalStyle}>
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

      {open && (portal ? createPortal(menu, document.body) : menu)}
    </div>
  );
}
