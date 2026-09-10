/**
 * DataTable — the ONE sanctioned <table> in the portal (guardrail:
 * styles/listTypography.test.ts). Genuinely tabular data (matrices,
 * leases, import previews) renders here so header/cell typography comes
 * from directory.css's list tokens; callers pass layout (widths,
 * alignment, mono) as props and never style td/th themselves.
 */
import type { ReactNode } from 'react';

export interface DataTableColumn {
  key: string; label: ReactNode; align?: 'left' | 'right' | 'center'; mono?: boolean; width?: string;
}
export interface DataTableRow { key: string; cells: ReactNode[]; className?: string; }

export default function DataTable({ columns, rows, className, emptyText, ariaLabel }: {
  columns: DataTableColumn[]; rows: DataTableRow[]; className?: string;
  emptyText?: string; ariaLabel?: string;
}) {
  const cls = (c: DataTableColumn) => [c.align ?? 'left', c.mono ? 'mono' : ''].join(' ').trim();
  return (
    <table className={`data-table ${className ?? ''}`.trim()} aria-label={ariaLabel}>
      <colgroup>
        {columns.map((c) => <col key={c.key} style={c.width ? { width: c.width } : undefined} />)}
      </colgroup>
      <thead>
        <tr>{columns.map((c) => <th key={c.key} className={c.align ?? 'left'}>{c.label}</th>)}</tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr><td className="data-table-empty" colSpan={columns.length}>{emptyText ?? 'Nothing here yet.'}</td></tr>
        ) : rows.map((r) => (
          <tr key={r.key} className={r.className}>
            {r.cells.map((cell, i) => <td key={columns[i]?.key ?? i} className={cls(columns[i])}>{cell}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
