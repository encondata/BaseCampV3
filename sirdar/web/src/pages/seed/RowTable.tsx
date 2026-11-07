/** A DataTable with a checkbox per row. A click ticks or unticks one row;
 *  a shift-click gives every enabled row between the last click and this
 *  one the state of this one. Rows are the visible page only. */
import { useRef, type ReactNode } from 'react';

import DataTable, { type DataTableColumn } from '@portal/components/DataTable';

export interface CheckRow {
  key: string;
  cells: ReactNode[];
  checked: boolean;
  disabled?: boolean;
  /** The checkbox's accessible name ("Row …" is prefixed). */
  label: string;
  /** Hover text on a disabled checkbox. */
  title?: string;
}

export default function RowTable({ columns, rows, onToggle, onRange, ariaLabel, emptyText }: {
  columns: DataTableColumn[];
  rows: CheckRow[];
  onToggle: (key: string, on: boolean) => void;
  onRange: (keys: string[], on: boolean) => void;
  ariaLabel: string;
  emptyText?: string;
}) {
  const last = useRef<string | null>(null);

  const click = (idx: number, on: boolean, shift: boolean) => {
    const row = rows[idx];
    const from = last.current === null ? -1 : rows.findIndex((r) => r.key === last.current);
    last.current = row.key;
    if (shift && from >= 0 && from !== idx) {
      const lo = Math.min(from, idx);
      const hi = Math.max(from, idx);
      onRange(rows.slice(lo, hi + 1).filter((r) => !r.disabled).map((r) => r.key), on);
    } else {
      onToggle(row.key, on);
    }
  };

  return (
    <DataTable
      ariaLabel={ariaLabel}
      className="sirdar-seed-rows"
      emptyText={emptyText}
      columns={[{ key: '__tick', label: '', width: '40px' }, ...columns]}
      rows={rows.map((r, i) => ({
        key: r.key,
        selected: r.checked,
        cells: [
          <input type="checkbox" checked={r.checked} disabled={r.disabled} aria-label={`Row ${r.label}`}
                 title={r.disabled ? r.title : undefined}
                 onChange={() => { /* handled on click, which carries the shift key */ }}
                 onClick={(e) => click(i, e.currentTarget.checked, e.shiftKey)} />,
          ...r.cells,
        ],
      }))}
    />
  );
}
