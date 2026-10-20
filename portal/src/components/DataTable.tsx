/**
 * DataTable — the ONE sanctioned <table> in the portal (guardrail:
 * styles/listTypography.test.ts). Genuinely tabular data (matrices,
 * leases, import previews) renders here so header/cell typography comes
 * from directory.css's list tokens; callers pass layout (widths,
 * alignment, mono) as props and never style td/th themselves.
 *
 * The ONE semantic rule (also stated above `.mini-row` in directory.css)
 * for what a cell's content should be classed by what KIND of datum it
 * holds, not by which page renders it:
 *   - names / titles / the thing the row is about →
 *     `cell-primary > .pn > b` (`.pn span` underneath for an identifier
 *     sub-line only — not prose); single-line cells use
 *     `<b className="cell-top">`.
 *   - descriptive prose / secondary text → `cell-sub`.
 *   - identifiers, serials, EPCs, dates, times, durations, counts,
 *     sizes, IPs/MACs → `mono` (or a column's own `mono: true`).
 *   - statuses / kinds / categories → `chip` (`chip c-*`/`chip custom`
 *     when the vocabulary has a color, `chip tag` for a neutral kind).
 *   - type / sub-type / kind as the primary row's second line lives in
 *     `.pn span` (the established directory shape: Home.tsx:289,
 *     Initiatives.tsx:480, Containers.tsx:362, RawScansTab.tsx:240,
 *     ProcessedScansTab.tsx:348).
 *   - never combine `cell-sub` with `mono` on the same element.
 */
import type { MouseEvent, ReactNode } from 'react';

export interface DataTableColumn {
  key: string; label: ReactNode; align?: 'left' | 'right' | 'center'; mono?: boolean; width?: string;
}
/** `onClick` and `selected` make a row pickable (the label builder's placed
 *  fields); `selected` sets aria-selected, left off when undefined. */
export interface DataTableRow {
  key: string; cells: ReactNode[]; className?: string;
  onClick?: (e: MouseEvent<HTMLTableRowElement>) => void; selected?: boolean;
}

export default function DataTable({ columns, rows, className, emptyText, ariaLabel }: {
  columns: DataTableColumn[]; rows: DataTableRow[]; className?: string;
  emptyText?: string; ariaLabel?: string;
}) {
  const cls = (c: DataTableColumn) => [c.align ?? 'left', c.mono ? 'mono' : ''].join(' ').trim();
  return (
    <div className="data-table-scroll">
      <table className={`data-table ${className ?? ''}`.trim()} aria-label={ariaLabel}>
        <colgroup>
          {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
        </colgroup>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} scope="col" className={c.align ?? 'left'}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td className="data-table-empty" colSpan={columns.length}>{emptyText ?? 'Nothing here yet.'}</td></tr>
          ) : rows.map((r) => (
            <tr key={r.key} className={r.className} onClick={r.onClick} aria-selected={r.selected}>
              {r.cells.map((cell, i) => <td key={columns[i]?.key ?? i} className={columns[i] ? cls(columns[i]) : ''}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
