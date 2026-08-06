/**
 * Shared directory-list toolbar controls: Filters (facets), Columns
 * picker, and CSV Export. Every record list uses these so the three
 * controls look and behave identically. Ref: fibertrace directory pattern.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

/* ── CSV export ─────────────────────────────────────────────────── */

export function exportCsv<T>(
  filename: string,
  columns: [string, (row: T) => string][],
  rows: T[],
): void {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [
    columns.map(([h]) => esc(h)).join(','),
    ...rows.map((r) => columns.map(([, fn]) => esc(fn(r))).join(',')),
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

/* ── advanced filters (facets) ──────────────────────────────────── */

interface FacetOption { value: string; label: string }
export interface FacetGroup { key: string; title: string; options: FacetOption[] }
export type FacetState = Record<string, Set<string>>;

const CHECK = (
  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.4"
       strokeLinecap="round" strokeLinejoin="round"><path d="M2 6.5 4.8 9.5 10 2.8" /></svg>
);

function useOutsideClose<T extends HTMLElement>(onClose: () => void) {
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

export function ColumnsButton({ columns, visible, onChange, godMode }: {
  columns: ColumnDef[];
  visible: Set<string>;
  onChange: (next: Set<string>) => void;
  godMode?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose<HTMLDivElement>(() => setOpen(false));

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
              <button key={c.key} className={`pop-item ${on ? 'on' : ''}`}
                      onClick={() => toggle(c.key)}>
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
