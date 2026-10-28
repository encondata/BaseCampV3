/**
 * The task sheet: MS Project's Gantt Chart table, as a CSS grid
 * (`role="grid"`). The columns are the person's choice (lib/plans/columns,
 * changed in ColumnsModal or by dragging a header border); the rows are
 * the ones the tab gives it (`rows`: the outline minus collapsed subtasks),
 * plus the blank new-task row at the bottom when the plan is editable.
 *
 * Rows are virtualized against `scrollRef`, the tab's scroll box: the
 * header sits sticky at its top and the body starts below it
 * (`scrollMargin`). The Gantt (Task 8) virtualizes against the same
 * element with the same row height, so the two panes scroll as one and a
 * collapsed summary leaves both (Review Focus 5).
 *
 * Display only: a click selects a cell (`onSelect`), a summary's chevron
 * asks the tab to collapse or expand it. Editing arrives in Task 6.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject,
} from 'react';

import type { PlanTask } from '../../lib/plans/api';
import {
  COLUMN_BY_KEY, SHEET_HEAD_PX, SHEET_ROW_PX, STATUS_CHIP, columnPrefsSnapshot, columnWidth, saveColumnPrefs,
  subscribeColumnPrefs, type PlanColumn, type SheetContext,
} from '../../lib/plans/columns';
import { indicatorsOf, type IndicatorKind } from '../../lib/plans/indicators';
import { planUnits } from '../../lib/plans/merge';
import { selectCell, type Selection } from '../../lib/plans/selection';
import type { PlanController } from './usePlan';

import '../../styles/plan-sheet.css';

export interface PlanSheetProps {
  ctl: PlanController;
  /** The task ids to show, in order (the outline less collapsed subtasks). */
  rows: string[];
  /** The summaries shown collapsed (their chevron points right). */
  collapsed: ReadonlySet<string>;
  rowHeight: number;
  /** The scroll box the sheet (and the Gantt) virtualize against. */
  scrollRef: RefObject<HTMLDivElement | null>;
  selection: Selection;
  onSelect(sel: Selection): void;
  onToggleCollapse(id: string): void;
  /** The plan takes edits: the blank new-task row is shown. */
  editable: boolean;
}

const OVERSCAN = 20;
const MAX_WIDTH = 1200;
const KEY_STEP_PX = 8;
const TITLED = new Set(['predecessors', 'successors']);

const alignClass = (col: PlanColumn) => (col.align === 'start' ? '' : ` pln-${col.align}`);

export default function PlanSheet({
  ctl, rows, collapsed, rowHeight, scrollRef, selection, onSelect, onToggleCollapse, editable,
}: PlanSheetProps) {
  const plan = ctl.plan;
  const prefs = useSyncExternalStore(subscribeColumnPrefs, columnPrefsSnapshot);
  const [drag, setDrag] = useState<{ key: string; width: number } | null>(null);
  const showTimes = plan?.settings.show_times ?? false;
  const scale = rowHeight / SHEET_ROW_PX;

  const columns = useMemo(
    () => prefs.visible.map((k) => COLUMN_BY_KEY.get(k)).filter((c): c is PlanColumn => c !== undefined),
    [prefs.visible],
  );
  const widthOf = useCallback((col: PlanColumn) => (drag?.key === col.key
    ? drag.width : columnWidth(col, prefs.widths, scale, showTimes)), [drag, prefs.widths, scale, showTimes]);
  const widths = columns.map(widthOf);
  const template = widths.map((w) => `${w}px`).join(' ');

  // only what cells read, so an edit elsewhere in the plan redraws no other row
  const calendar = plan?.calendar;
  const timeZone = plan?.timezone;
  const locked = (plan?.locked_at ?? null) !== null;
  const ctx = useMemo<SheetContext | null>(() => (calendar && timeZone !== undefined ? {
    showTimes, units: planUnits({ calendar }), timeZone, locked,
  } : null), [calendar, timeZone, locked, showTimes]);
  const tasks = plan?.tasks;
  const tasksById = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);

  const count = rows.length + (editable ? 1 : 0);
  const itemKey = useCallback((i: number) => rows[i] ?? 'blank', [rows]);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: OVERSCAN,
    scrollMargin: SHEET_HEAD_PX,
    getItemKey: itemKey,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  // ── column borders: drag, or arrows on the focused border ──
  const resizing = useRef<{ col: PlanColumn; startX: number; startWidth: number } | null>(null);
  const clampWidth = (col: PlanColumn, px: number) => Math.min(Math.max(Math.round(px), col.min), MAX_WIDTH);
  const saveWidth = (col: PlanColumn, px: number) => {
    const current = columnPrefsSnapshot();
    saveColumnPrefs({ visible: current.visible, widths: { ...current.widths, [col.key]: clampWidth(col, px) } });
  };
  const border = (col: PlanColumn, width: number) => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // no capture (an inactive pointer id): moves over the border still resize
      }
      resizing.current = { col, startX: e.clientX, startWidth: width };
      setDrag({ key: col.key, width });
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const r = resizing.current;
      if (r) setDrag({ key: r.col.key, width: clampWidth(r.col, r.startWidth + e.clientX - r.startX) });
    },
    onPointerUp: (e: PointerEvent<HTMLDivElement>) => {
      const r = resizing.current;
      if (!r) return;
      resizing.current = null;
      saveWidth(r.col, r.startWidth + e.clientX - r.startX);
      setDrag(null);
    },
    onPointerCancel: () => {
      resizing.current = null;
      setDrag(null);
    },
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      const step = e.key === 'ArrowRight' ? KEY_STEP_PX : e.key === 'ArrowLeft' ? -KEY_STEP_PX : 0;
      if (!step) return;
      e.preventDefault();
      saveWidth(col, width + step);
    },
  });

  if (!plan || !ctx) return null;

  const total = widths.reduce((a, b) => a + b, 0);
  const gridStyle = {
    '--pln-cols': template,
    '--pln-row-h': `${rowHeight}px`,
    '--pln-head-h': `${SHEET_HEAD_PX}px`,
    width: `max(100%, ${total}px)`,
  } as CSSProperties;
  const active = selection.active;
  const blankIndex = rows.length;

  return (
    <div className="pln-sheet" role="grid" aria-label="Task sheet" aria-rowcount={count + 1}
         aria-colcount={columns.length} aria-multiselectable="true" style={gridStyle}>
      <div className="pln-sheet-head" role="row" aria-rowindex={1}>
        {columns.map((col, i) => (
          <div key={col.key} role="columnheader" aria-colindex={i + 1} data-col={col.key}
               className={`cell pln-hcell${alignClass(col)}${drag?.key === col.key ? ' on' : ''}`}
               title={col.label}>
            {col.key === 'indicators'
              ? <><InfoIcon /><span className="pln-sr">{col.label}</span></>
              : <span className="mono cell-line">{col.label}</span>}
            <div role="separator" aria-orientation="vertical" aria-label={`Resize ${col.label}`}
                 aria-valuenow={widths[i]} aria-valuemin={col.min} aria-valuemax={MAX_WIDTH} tabIndex={0}
                 className="pln-resize" {...border(col, widths[i])} />
          </div>
        ))}
      </div>

      <div className="pln-sheet-body" role="rowgroup" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const y = item.start - SHEET_HEAD_PX;
          if (item.index === blankIndex) {
            return (
              <BlankRow key="blank" index={item.index} y={y} columns={columns}
                        activeCol={active?.id === 'blank' ? active.col : null} onSelect={onSelect} />
            );
          }
          const task = tasksById.get(rows[item.index]);
          if (!task) return null;
          return (
            <SheetRow key={task.id} task={task} index={item.index} y={y} columns={columns} ctx={ctx}
                      collapsed={collapsed.has(task.id)} selected={selection.rows.has(task.id)}
                      activeCol={active?.id === task.id ? active.col : null}
                      onSelect={onSelect} onToggleCollapse={onToggleCollapse} />
          );
        })}
      </div>
    </div>
  );
}

interface SheetRowProps {
  task: PlanTask;
  index: number;
  y: number;
  columns: PlanColumn[];
  ctx: SheetContext;
  collapsed: boolean;
  selected: boolean;
  activeCol: string | null;
  onSelect(sel: Selection): void;
  onToggleCollapse(id: string): void;
}

/** One task's row; redraws only when its task object, place or state changes. */
const SheetRow = memo(function SheetRow({
  task, index, y, columns, ctx, collapsed, selected, activeCol, onSelect, onToggleCollapse,
}: SheetRowProps) {
  return (
    <div role="row" aria-rowindex={index + 2} aria-selected={selected} data-task={task.id}
         className={`pln-row${task.is_summary ? ' pln-summary' : ''}`}
         style={{ transform: `translateY(${y}px)` }}>
      {columns.map((col, i) => (
        <div key={col.key} role="gridcell" aria-colindex={i + 1} aria-selected={activeCol === col.key}
             data-col={col.key}
             className={`cell pln-cell${alignClass(col)}${col.key === 'id' ? ' pln-idcell' : ''}${col.key === 'name' ? ' pln-namecell' : ''}`}
             style={col.key === 'name' ? { '--pln-level': task.outline_level } as CSSProperties : undefined}
             onMouseDown={() => onSelect(selectCell(task.id, col.key))}>
          <CellContent col={col} task={task} ctx={ctx} collapsed={collapsed} onToggleCollapse={onToggleCollapse} />
        </div>
      ))}
    </div>
  );
});

function CellContent({ col, task, ctx, collapsed, onToggleCollapse }: {
  col: PlanColumn; task: PlanTask; ctx: SheetContext; collapsed: boolean; onToggleCollapse(id: string): void;
}): ReactNode {
  switch (col.text ?? 'top') {
    case 'name': {
      const name = task.name;
      return (
        <>
          <span className="pln-twisty-slot">
            {task.is_summary && (
              <button type="button" className="pln-twisty" aria-expanded={!collapsed}
                      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={() => onToggleCollapse(task.id)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"
                     strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
              </button>
            )}
          </span>
          {task.is_summary
            ? <b className="cell-top cell-line" title={name}>{name}</b>
            : <span className="cell-top cell-line" title={name}>{name}</span>}
        </>
      );
    }
    case 'icons':
      return col.key === 'mode' ? <ModeIcon manual={task.mode === 'manual'} /> : <Indicators task={task} ctx={ctx} />;
    case 'chip':
      return <span className={`chip ${STATUS_CHIP[task.status]}`}>{col.value(task, ctx)}</span>;
    default: {
      const text = col.value(task, ctx);
      if (!text) return null;
      const kind = col.text === 'mono' ? 'mono' : col.text === 'sub' ? 'cell-sub' : 'cell-top';
      const title = kind !== 'mono' || TITLED.has(col.key) ? text : undefined;
      return <span className={`${kind} cell-line`} title={title}>{text}</span>;
    }
  }
}

/** The new-task row under the last task (typing into it arrives in Task 6). */
function BlankRow({ index, y, columns, activeCol, onSelect }: {
  index: number; y: number; columns: PlanColumn[]; activeCol: string | null; onSelect(sel: Selection): void;
}) {
  return (
    <div role="row" aria-rowindex={index + 2} aria-selected={activeCol !== null} data-blank=""
         className="pln-row pln-blank" style={{ transform: `translateY(${y}px)` }}>
      {columns.map((col, i) => (
        <div key={col.key} role="gridcell" aria-colindex={i + 1} aria-selected={activeCol === col.key}
             data-col={col.key} className={`cell pln-cell${col.key === 'id' ? ' pln-idcell' : ''}`}
             onMouseDown={() => onSelect(selectCell('blank', col.key))} />
      ))}
    </div>
  );
}

const INDICATOR_PATHS: Record<IndicatorKind, ReactNode> = {
  complete: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  constraint: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M9 3v4M15 3v4" /></>,
  conflict: <><path d="M12 4 2.8 19.5h18.4z" /><path d="M12 10v4M12 16.8v.2" /></>,
  deadline: <><path d="M12 2.8 21.2 12 12 21.2 2.8 12z" /><path d="M12 8v4.5M12 15.8v.2" /></>,
  note: <><path d="M6 3h8.5L19 7.5V21H6z" /><path d="M9 11.5h7M9 15.5h7" /></>,
  locked: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
};

function Indicators({ task, ctx }: { task: PlanTask; ctx: SheetContext }) {
  return (
    <>
      {indicatorsOf(task, ctx).map((ind) => (
        <span key={ind.kind} className={`pln-ind pln-ind-${ind.kind}`} role="img" title={ind.title}
              aria-label={ind.title}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
               strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{INDICATOR_PATHS[ind.kind]}</svg>
        </span>
      ))}
    </>
  );
}

function ModeIcon({ manual }: { manual: boolean }) {
  const label = manual ? 'Manually Scheduled' : 'Auto Scheduled';
  return (
    <span className={`pln-ind pln-mode-${manual ? 'manual' : 'auto'}`} role="img" title={label} aria-label={label}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
           strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {manual
          ? <><path d="M9 3h6l-1 6 3 3H7l3-3z" /><path d="M12 12v9" /></>
          : <><rect x="3" y="9" width="12" height="6" rx="1.5" /><path d="M18 8.5l3.5 3.5-3.5 3.5" /></>}
      </svg>
    </span>
  );
}

/** The Indicators column's header: MS Project's "i". */
function InfoIcon() {
  return (
    <svg className="pln-hicon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
         strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.2" />
    </svg>
  );
}
