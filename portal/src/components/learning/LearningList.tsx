/**
 * LearningList — a small standard house list (list-head with ColHead cells,
 * dir-rows, floors and sideways scroll from listGridStyle) for the Learning
 * document tabs: versions, sign-offs, quiz questions, translations. Cells
 * come from the caller (cell-top / cell-sub / chip / mono, never bare
 * text). A row with `onRowClick` is a keyboard-reachable button-row.
 */

import type { KeyboardEvent, ReactNode } from 'react';

import { useAuth } from '../../auth/AuthContext';
import { ColHead, listGridStyle, listScale, type ColumnDef } from '../../lib/listTools';
import '../../styles/directory.css';

export interface LearningColumn<T> {
  def: ColumnDef;
  cell: (row: T) => ReactNode;
}

export default function LearningList<T>({
  columns, rows, rowKey, onRowClick, selectedKey, ariaLabel, empty,
}: {
  columns: LearningColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** The row to show as open. */
  selectedKey?: string | null;
  ariaLabel: string;
  empty?: ReactNode;
}) {
  const { preferences } = useAuth();
  const grid = listGridStyle(columns.map((c) => c.def), [], undefined, listScale(preferences?.list_size));
  const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: grid.minWidth };
  const keyDown = (e: KeyboardEvent, row: T) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onRowClick?.(row);
    }
  };

  return (
    <div className="dir-list list-scroll" role="group" aria-label={ariaLabel}>
      <div className="list-head" style={rowStyle}>
        {columns.map((c) => <ColHead key={c.def.key} col={c.def} />)}
      </div>
      {rows.length === 0 && empty && <div className="dir-empty">{empty}</div>}
      {rows.map((row) => {
        const key = rowKey(row);
        return (
          <div key={key} className={`dir-row${selectedKey === key ? ' open' : ''}`}
               style={{ minWidth: rowStyle.minWidth }}>
            <div className="row-main" style={rowStyle}
                 {...(onRowClick ? {
                   role: 'button', tabIndex: 0, onClick: () => onRowClick(row),
                   onKeyDown: (e: KeyboardEvent) => keyDown(e, row),
                 } : {})}>
              {columns.map((c) => <div className="cell" key={c.def.key}>{c.cell(row)}</div>)}
            </div>
          </div>
        );
      })}
    </div>
  );
}
