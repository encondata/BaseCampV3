/**
 * Shared directory-list toolbar controls: Filters (facets), Columns
 * picker, and CSV Export. Every record list uses these so the three
 * controls look and behave identically. Ref: fibertrace directory pattern.
 */

import {
  useEffect, useLayoutEffect, useMemo, useRef, useState,
  type DragEvent, type ReactNode, type RefObject,
} from 'react';

/* ── CSV export ─────────────────────────────────────────────────── */

/** Encode one CSV field. Values starting with = + - @ get a leading
 *  single quote (OWASP CSV-injection guard) so Excel/Sheets treat them
 *  as text, not formulas — except purely numeric values ("-5", "+1.5"),
 *  which are legitimate data. Then the usual quote/comma/newline quoting. */
export function csvCell(v: string): string {
  if (/^[=+\-@]/.test(v) && !/^[+-]?\d+(\.\d+)?$/.test(v)) v = `'${v}`;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function exportCsv<T>(
  filename: string,
  columns: [string, (row: T) => string][],
  rows: T[],
): void {
  const lines = [
    columns.map(([h]) => csvCell(h)).join(','),
    ...rows.map((r) => columns.map(([, fn]) => csvCell(fn(r))).join(',')),
  ];
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${filename}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ── column registry ────────────────────────────────────────────── */

export interface ColumnDef {
  key: string;
  label: string;
  width: string;   // grid-template fraction/px for this column
  default: boolean;
  godOnly?: boolean; // only offered/shown once god mode is active
  /** Header label shown when the long `label` would overflow its track
   *  (see ColHead / useFitLabel). Also the label the derived floor is
   *  sized from, since the floor only has to fit the short form. */
  short?: string;
  /** px floor for the track (see listGridStyle). Derived from the label
   *  when absent; an explicit value below the derived floor is raised
   *  to it so the short label can never overflow. */
  min?: number;
}

/** Columns to actually render: visible, and — for godOnly columns — only
 *  while god mode is on. Lets a page drop god columns from the live grid
 *  the instant god mode toggles off, without touching the `visible` set
 *  (so re-enabling god mode restores the user's picks). */
export function visibleColumnsFor(
  columns: ColumnDef[], visible: Set<string>, godMode: boolean,
): ColumnDef[] {
  return columns.filter((c) => visible.has(c.key) && (!c.godOnly || godMode));
}

/* ── column floors + sideways scroll (spec: 2026-09-23-list-column-floors) ──
 * `fr` tracks shrink to zero when a window is narrow, and any content
 * that cannot wrap then paints across its neighbor. Every column
 * therefore carries a px floor, the grid becomes `minmax(floor, fr)`,
 * and the header + rows carry the summed minimum so the card
 * (`.dir-list.list-scroll`, directory.css) scrolls sideways below it
 * instead of colliding. Above the sum nothing changes. */

/** 10px mono header glyph (directory.css --list-fs-head) plus 0.14em
 *  tracking, at list scale 1. */
const FLOOR_PX_PER_CHAR = 7.4;
/** Sort caret + the column-menu funnel button beside the label. */
const FLOOR_CHROME_PX = 30;
/** Nothing narrower than this reads as a column. */
const FLOOR_MIN_PX = 72;
/** .list-head / .row-main horizontal padding, 20px a side. */
const LIST_PAD_X = 40;
/** .dir-list.list-scroll track gap. */
const LIST_SCROLL_GAP = 12;

/** Mirror of directory.css's --list-scale per list_size preference
 *  (.portal-shell[data-list-size]). Floors are px at scale 1; a list
 *  passes this to listGridStyle so a larger type size gets wider floors
 *  and the short label still fits its track. */
export function listScale(listSize: string | undefined): number {
  switch (listSize) {
    case 'small': return 0.9;
    case 'large': return 1.15;
    case 'xlarge': return 1.3;
    default: return 1;
  }
}

/** The px floor for one column: the larger of its explicit `min` and the
 *  floor derived from the label that has to fit (short when present). */
export function columnFloor(col: ColumnDef): number {
  const label = col.short ?? col.label;
  const derived = Math.max(
    FLOOR_MIN_PX, Math.ceil(label.length * FLOOR_PX_PER_CHAR) + FLOOR_CHROME_PX,
  );
  return Math.max(col.min ?? 0, derived);
}

export interface ListGridStyle {
  gridTemplateColumns: string;
  /** px: floors + fixed tracks + gaps + padding. Numbers render as px. */
  minWidth: number;
}

const FR_RE = /^\d*\.?\d+fr$/;
const PX_RE = /^(\d*\.?\d+)px$/;

/** Grid template + row minimum width for a shown column set. `trailing`
 *  are the fixed tracks a page appends after its columns (an actions
 *  track, a chevron track); only px trailing tracks count toward the
 *  minimum. `scale` (from `listScale(list_size)`) widens every derived
 *  floor for a larger list type size; fixed px tracks are never scaled.
 *  Spread the result onto `.list-head`, and put `minWidth` on each
 *  `.dir-row` too so hover paint and borders span the scrolled width
 *  (see InitiativeDetail.tsx for the reference wiring). */
export function listGridStyle(
  cols: ColumnDef[], trailing: string[] = [], gap: number = LIST_SCROLL_GAP, scale: number = 1,
): ListGridStyle {
  const tracks: string[] = [];
  let min = 0;
  for (const c of cols) {
    const floor = Math.ceil(columnFloor(c) * scale);
    if (FR_RE.test(c.width)) {
      tracks.push(`minmax(${floor}px, ${c.width})`);
      min += floor;
    } else {
      tracks.push(c.width);
      const px = PX_RE.exec(c.width);
      min += px ? Number(px[1]) : floor;
    }
  }
  for (const t of trailing) {
    tracks.push(t);
    const px = PX_RE.exec(t);
    min += px ? Number(px[1]) : 0;
  }
  const gaps = Math.max(0, tracks.length - 1) * gap;
  return { gridTemplateColumns: tracks.join(' '), minWidth: min + gaps + LIST_PAD_X };
}

/* ── adaptive header label ──────────────────────────────────────────
 * A header cell renders its long label while the track has room and its
 * `short` label once the long one would overflow. The cell is a grid
 * item, so its width is the track's — independent of which label is
 * showing — and the floor guarantees the short label fits, so the swap
 * can never oscillate. A hidden clone of the long label (plus caret) is
 * what gets measured; observing it too means a late font load re-checks. */

/** column-menu.css `.list-head .col-head { gap: 2px }`. */
const COL_HEAD_GAP = 2;

export function useFitLabel(long: string, short?: string): {
  cellRef: RefObject<HTMLSpanElement>;
  measureRef: RefObject<HTMLSpanElement>;
  label: string;
} {
  const cellRef = useRef<HTMLSpanElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);

  useLayoutEffect(() => {
    if (!short || typeof ResizeObserver === 'undefined') return;
    const cell = cellRef.current;
    const measure = measureRef.current;
    if (!cell || !measure) return;
    const check = () => {
      const trigger = cell.querySelector<HTMLElement>('.colmenu-trigger');
      const available = cell.clientWidth - (trigger ? trigger.offsetWidth + COL_HEAD_GAP : 0);
      setFits(measure.offsetWidth <= available);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(cell);
    ro.observe(measure);
    return () => ro.disconnect();
  }, [long, short]);

  return { cellRef, measureRef, label: short && !fits ? short : long };
}

export type HeaderDragProps = ReturnType<ReturnType<typeof useReorderDrag>['dragProps']>;

/** One list header cell: sortable label (long/short per useFitLabel),
 *  sort caret, and the page's ColumnMenu as `children`. Same markup every
 *  page already renders inline (`span.col-head > button.sortable`), so
 *  existing header CSS applies unchanged. */
export function ColHead({ col, sortDir, onToggleSort, className, dragProps, children }: {
  col: ColumnDef;
  sortDir: 1 | -1 | null;
  onToggleSort: () => void;
  className?: string;
  dragProps?: HeaderDragProps;
  children?: ReactNode;
}): JSX.Element {
  const { cellRef, measureRef, label } = useFitLabel(col.label, col.short);
  const caret = sortDir
    ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;
  return (
    <span ref={cellRef} className={`col-head${className ? ` ${className}` : ''}`} {...dragProps}>
      <button type="button" className="sortable" onClick={onToggleSort}
              title={label === col.label ? undefined : col.label}>
        {label} {caret}
      </button>
      {col.short && (
        <span ref={measureRef} className="col-head-measure" aria-hidden="true">
          {col.label} {caret}
        </span>
      )}
      {children}
    </span>
  );
}

/** Reorder `columns` by a persisted key order. Keys in `order` come first,
 *  in that order; columns the order doesn't mention (e.g. added to the
 *  codebase after the user saved) keep their default relative order,
 *  appended after the ordered ones. Unknown keys in `order` are skipped.
 *  Empty order = default order. */
export function applyColumnOrder(columns: ColumnDef[], order: string[]): ColumnDef[] {
  if (order.length === 0) return columns;
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const ordered = order
    .map((k) => byKey.get(k))
    .filter((c): c is ColumnDef => Boolean(c));
  const placed = new Set(order);
  return [...ordered, ...columns.filter((c) => !placed.has(c.key))];
}

/** Move `src` to sit before/after `dst` in a full ordered key list. Both
 *  reorder surfaces (Columns-menu rows, header dragging) commit through
 *  this, always over the COMPLETE key list — so one reorder converges a
 *  partial stored order into a full one, and moving a visible column never
 *  loses the position of hidden ones. */
export function moveKey(keys: string[], src: string, dst: string, before: boolean): string[] {
  if (src === dst || !keys.includes(src)) return keys;
  const without = keys.filter((k) => k !== src);
  const at = without.indexOf(dst);
  if (at < 0) return keys;
  const next = [...without];
  next.splice(before ? at : at + 1, 0, src);
  return next;
}

/** HTML5 drag-and-drop reordering shared by both reorder surfaces: rows in
 *  the Columns popover (axis 'y') and the list header cells (axis 'x').
 *  The hook only tracks the gesture and reports (src, dst, before) on
 *  drop — callers commit via moveKey over their full ordered key list.
 *
 *  `opts.ignoreFrom`: a CSS selector; a drag starting inside a matching
 *  ancestor is cancelled. Headers pass '.pop-menu' so dragging inside an
 *  open column-funnel popover (rendered within the header span) never
 *  hijacks the pointer. Plain clicks are untouched either way — HTML5
 *  drag only engages on actual drag movement. */
export function useReorderDrag(
  onMove: (src: string, dst: string, before: boolean) => void,
  axis: 'x' | 'y',
  opts?: { ignoreFrom?: string },
) {
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ key: string; before: boolean } | null>(null);

  const dragProps = (key: string) => ({
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      if (opts?.ignoreFrom && (e.target as HTMLElement).closest?.(opts.ignoreFrom)) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', key); // Firefox refuses to start a drag with no data
      setDrag(key);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!drag || drag === key) return;
      e.preventDefault(); // required for the element to be a drop target
      e.dataTransfer.dropEffect = 'move';
      const rect = e.currentTarget.getBoundingClientRect();
      const before = axis === 'x'
        ? e.clientX < rect.left + rect.width / 2
        : e.clientY < rect.top + rect.height / 2;
      setOver((prev) => (prev?.key === key && prev.before === before ? prev : { key, before }));
    },
    onDragLeave: () => {
      setOver((prev) => (prev?.key === key ? null : prev));
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      if (drag && drag !== key && over?.key === key) onMove(drag, key, over.before);
      setDrag(null);
      setOver(null);
    },
    onDragEnd: () => {
      setDrag(null);
      setOver(null);
    },
  });

  const dropClass = (key: string) => {
    if (key === drag) return 'drag-src';
    if (over?.key === key) return over.before ? 'drop-before' : 'drop-after';
    return '';
  };

  return { dragProps, dropClass };
}

/* ── advanced filters (facets) ──────────────────────────────────── */

interface FacetOption { value: string; label: string }
export interface FacetGroup { key: string; title: string; options: FacetOption[] }
export type FacetState = Record<string, Set<string>>;

const CHECK = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4"
       strokeLinecap="round" strokeLinejoin="round"><path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
);

export function useOutsideClose<T extends HTMLElement>(onClose: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [onClose]);
  return ref;
}

export function FilterButton({ groups, state, onChange }: {
  groups: FacetGroup[];
  state: FacetState;
  onChange: (next: FacetState) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose<HTMLDivElement>(() => setOpen(false));
  const active = Object.values(state).reduce((n, s) => n + s.size, 0);

  const toggle = (groupKey: string, value: string) => {
    const set = new Set(state[groupKey] ?? []);
    if (set.has(value)) set.delete(value); else set.add(value);
    onChange({ ...state, [groupKey]: set });
  };

  return (
    <div className="pop-wrap" ref={ref}>
      <button className="btn-ghost" onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 3H2l8 9.5V19l4 2v-8.5z" />
        </svg>
        Filters
        {active > 0 && <span className="fbadge">{active}</span>}
      </button>
      {open && (
        <div className="pop-menu">
          {groups.map((g, i) => (
            <div key={g.key}>
              {i > 0 && <div className="pop-sep" />}
              <div className="pop-title">{g.title}</div>
              {g.options.map((o) => {
                const on = state[g.key]?.has(o.value) ?? false;
                return (
                  <button key={o.value} className={`pop-item ${on ? 'on' : ''}`}
                          onClick={() => toggle(g.key, o.value)}>
                    <span className="pop-check">{CHECK}</span>
                    {o.label}
                  </button>
                );
              })}
            </div>
          ))}
          {active > 0 && (
            <>
              <div className="pop-sep" />
              <button className="pop-item" onClick={() => onChange({})}>
                Clear all filters
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Does a row pass the facet filter? `values(groupKey)` returns the row's
 *  value(s) for a group; a group with selections passes if any overlaps. */
export function passesFacets(
  state: FacetState,
  values: (groupKey: string) => string[],
): boolean {
  for (const [groupKey, selected] of Object.entries(state)) {
    if (selected.size === 0) continue;
    const rowVals = values(groupKey);
    if (!rowVals.some((v) => selected.has(v))) return false;
  }
  return true;
}

/* ── column filters (Excel-style per-header menus) ──────────────────
 * Types + the pure count live here alongside facetCount (their toolbar-
 * chip cousin); the menu UI, matcher, and persistence hook live in
 * lib/columnMenu.tsx, which re-exports these two for one-stop importing. */

export interface ColumnFilter { text?: string; values?: string[] }
export type ColumnFilters = Record<string, ColumnFilter>;

export function activeFilterCount(filters: ColumnFilters): number {
  return Object.keys(filters).length;
}

export function ColumnsButton({ columns, visible, onChange, godMode, onReorder }: {
  columns: ColumnDef[];
  visible: Set<string>;
  onChange: (next: Set<string>) => void;
  godMode?: boolean;
  /** When set, rows are drag-reorderable; a drop emits the FULL new key
   *  order of `columns` (offered or not), so a partial persisted order
   *  becomes complete on the first reorder. Pass display-ordered columns
   *  so the list reads in on-screen order. */
  onReorder?: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose<HTMLDivElement>(() => setOpen(false));
  const { dragProps, dropClass } = useReorderDrag(
    (src, dst, before) => onReorder?.(moveKey(columns.map((c) => c.key), src, dst, before)),
    'y',
  );

  const toggle = (key: string) => {
    const next = new Set(visible);
    if (next.has(key)) next.delete(key); else next.add(key);
    onChange(next);
  };

  const offered = columns.filter((c) => !c.godOnly || godMode);

  return (
    <div className="pop-wrap" ref={ref}>
      <button className="btn-ghost" onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
             strokeLinecap="round"><path d="M9 3v18M15 3v18M3 5.5h18M3 5.5v13a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-13a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2Z" /></svg>
        Columns
      </button>
      {open && (
        <div className="pop-menu">
          <div className="pop-title">Visible columns</div>
          {offered.map((c) => {
            const on = visible.has(c.key);
            return (
              <button key={c.key}
                      className={`pop-item ${on ? 'on' : ''} ${onReorder ? dropClass(c.key) : ''}`}
                      {...(onReorder ? dragProps(c.key) : {})}
                      onClick={() => toggle(c.key)}>
                {onReorder && (
                  <span className="pop-grip" aria-hidden="true">
                    <svg viewBox="0 0 8 12" fill="currentColor">
                      <circle cx="2.5" cy="2" r="1.1" /><circle cx="5.5" cy="2" r="1.1" />
                      <circle cx="2.5" cy="6" r="1.1" /><circle cx="5.5" cy="6" r="1.1" />
                      <circle cx="2.5" cy="10" r="1.1" /><circle cx="5.5" cy="10" r="1.1" />
                    </svg>
                  </span>
                )}
                <span className="pop-check">{CHECK}</span>
                {c.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function ExportButton({ onExport }: { onExport: () => void }) {
  return (
    <button className="btn-ghost" onClick={onExport}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
      </svg>
      Export
    </button>
  );
}

/** Render a value cell node from an unknown-typed cell producer. */
export type CellRenderer<T> = (row: T, key: string) => ReactNode;

/* ── search memoization ─────────────────────────────────────────── */

/** Precomputed lowercase search haystacks — one build per rows array
 *  instead of one per row per keystroke (matters at 100k rows).
 *  `text` must be referentially stable (module-level function, or a
 *  `useCallback`-wrapped lambda) — an inline lambda recreated every
 *  render defeats the memoization and can also bake in stale closed-over
 *  values if it changes identity without `rows` changing. */
export function useSearchHaystacks<T>(
  rows: T[] | null, text: (row: T) => string,
): (row: T) => string {
  return useMemo(() => {
    const m = new Map<T, string>();
    rows?.forEach((r) => m.set(r, text(r)));
    return (row: T) => m.get(row) ?? text(row);
  }, [rows, text]);
}
