/**
 * The task sheet: MS Project's Gantt Chart table, as a CSS grid
 * (`role="grid"`). The columns are the person's choice (lib/plans/columns,
 * changed in ColumnsModal or by dragging a header border); the rows are
 * the ones the tab gives it (`rows`: the outline minus collapsed subtasks,
 * filtered, maybe grouped: useSheetView), plus the blank new-task row at
 * the bottom while tasks can be added. A row's key is its task's id, or
 * under Group by its group and task (lib/plans/filters `taskOfRow`), so a
 * task with two resources has two rows, each selected on its own. A
 * filter's context rows (`context`: the summaries that place a match) are
 * dimmed and inert — no selection, no editing, no chevron; a group's band
 * (`bands`) spans the row with its name and count. Neither is a stop for
 * the arrow keys.
 *
 * Rows are virtualized against `scrollRef`, the tab's scroll box: the
 * header sits sticky at its top and the body starts below it
 * (`scrollMargin`). The Gantt (Task 8) virtualizes against the same
 * element with the same row height, so the two panes scroll as one and a
 * collapsed summary leaves both (Review Focus 5).
 *
 * A click selects a cell (`onSelect`); a click on a row number selects the
 * row, Shift extends from the anchor and Ctrl/⌘ toggles. A summary's
 * chevron asks the tab to collapse or expand it. A row number dragged
 * moves the row with its subtasks, or the selection it is part of
 * (useRowDrag; `onMoveTasks` sends it), the drop line marking where. Rows
 * a cut marked (`cut`, waiting for their paste) wear a dashed outline.
 *
 * Editing is a spreadsheet's (lib/plans/sheetKeys): the grid takes focus
 * and keeps the active cell as `aria-activedescendant`; arrows, Enter and
 * Tab move it; typing, F2 or a double-click open the cell's editor
 * (CellEditor, state in useSheetEditing), which sits over the cell. A
 * double-click on a cell that doesn't edit — a row's number, a summary's
 * dates, any cell for someone who may only read — opens Task Information
 * (`onOpenInfo`), as a double-click does in MS Project.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type FocusEvent, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject,
} from 'react';

import type { ComboOption } from '../ComboBox';
import type { PlanTask } from '../../lib/plans/api';
import { taskOfRow, type GroupBand } from '../../lib/plans/filters';
import {
  COLUMN_BY_KEY, SHEET_HEAD_PX, SHEET_OVERSCAN, SHEET_ROW_PX, STATUS_CHIP, columnPrefsSnapshot, columnWidth,
  saveColumnPrefs, subscribeColumnPrefs, type PlanColumn, type SheetContext,
} from '../../lib/plans/columns';
import { MULTILINE_NOTE_TITLE, multiLineNote } from '../../lib/plans/editOps';
import { indicatorsOf, noteExcerpt, type IndicatorKind } from '../../lib/plans/indicators';
import { planUnits } from '../../lib/plans/merge';
import type { MovePlace } from '../../lib/plans/moveTasks';
import { extendRows, moveActive, selectCell, toggleRow, type Selection } from '../../lib/plans/selection';
import { gridKey, keyLike, scrollToShow } from '../../lib/plans/sheetKeys';
import { isPaletteColor } from '../../lib/plans/taskColor';
import CellEditor from './CellEditor';
import { resourceOptions } from './ResourcePicker';
import type { PlanController } from './usePlan';
import { useRowDrag } from './useRowDrag';
import { useSheetEditing } from './useSheetEditing';

import '../../styles/plan-sheet.css';

export interface PlanSheetProps {
  ctl: PlanController;
  /** The rows to show, in order, by key (useSheetView): a task's id, or a
   *  grouped row's or a band's key. */
  rows: string[];
  /** A filter's context rows: dimmed and inert. */
  context?: ReadonlySet<string>;
  /** Group by's bands, by row key. */
  bands?: ReadonlyMap<string, GroupBand>;
  /** The summaries shown collapsed (their chevron points right). */
  collapsed: ReadonlySet<string>;
  rowHeight: number;
  /** The scroll box the sheet (and the Gantt) virtualize against. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** The sheet pane's own sideways scroller (SidePane's scrollbar), when
   *  it has one: the active cell is scrolled into view across it.
   *  Without one, `scrollRef` scrolls both ways. */
  sideScrollRef?: RefObject<HTMLElement | null>;
  selection: Selection;
  onSelect(sel: Selection): void;
  onToggleCollapse(id: string): void;
  /** The blank new-task row is shown (editOps.canAddTasks). */
  blankRow: boolean;
  /** Task Information for the task (a double-click on a cell that doesn't edit). */
  onOpenInfo?(taskId: string): void;
  /** Grouped (Group by): the outline can't change, so rows don't drag. */
  grouped?: boolean;
  /** The tasks a cut marked, waiting for their paste (a dashed outline). */
  cut?: ReadonlySet<string>;
  /** Moves the tasks a row drag let go of (usePlanCommands `moveTasks`);
   *  without it rows don't drag. */
  onMoveTasks?(ids: string[], place: MovePlace): void;
}

/** What a mousedown on a cell needs to know. */
type CellPress = Pick<MouseEvent, 'button' | 'shiftKey' | 'ctrlKey' | 'metaKey'>;

const MAX_WIDTH = 1200;
const KEY_STEP_PX = 8;
const TITLED = new Set(['predecessors', 'successors']);
const NO_OPTIONS: ComboOption[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();
const NO_BANDS: ReadonlyMap<string, GroupBand> = new Map();
/** Grouped, a task's name sits one level in from its band, whatever its
 *  outline level (the outline isn't shown while grouped). */
const GROUPED_LEVEL = 2;

const alignClass = (col: PlanColumn) => (col.align === 'start' ? '' : ` pln-${col.align}`);

export default function PlanSheet({
  ctl, rows, context = NO_KEYS, bands = NO_BANDS, collapsed, rowHeight, scrollRef, sideScrollRef, selection, onSelect,
  onToggleCollapse, blankRow, onOpenInfo, grouped = false, cut = NO_KEYS, onMoveTasks,
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
  // the rows the keys and a Shift-click step through: not context rows, not bands
  const nav = useMemo(() => (context.size || bands.size
    ? rows.filter((key) => !context.has(key) && !bands.has(key)) : rows), [rows, context, bands]);

  const count = rows.length + (blankRow ? 1 : 0);
  const itemKey = useCallback((i: number) => rows[i] ?? 'blank', [rows]);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: SHEET_OVERSCAN,
    scrollMargin: SHEET_HEAD_PX,
    getItemKey: itemKey,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);

  // ── selection, keys and the cell editor ──
  const gridRef = useRef<HTMLDivElement>(null);
  const idBase = useId();
  // back to the grid after an edit, unless the person has gone elsewhere
  const focusGrid = useCallback(() => {
    const at = document.activeElement;
    if (!at || at === document.body || at.closest('.pln-editor, .pln-respick')) {
      gridRef.current?.focus({ preventScroll: true });
    }
  }, []);
  const editing = useSheetEditing({ ctl, columns, rows: nav, blankRow, selection, onSelect, focusGrid });
  const bodyRef = useRef<HTMLDivElement>(null);
  const rowDrag = useRowDrag({
    ctl, rows, context, grouped, rowHeight, selection, onSelect, scrollRef, bodyRef, onMove: onMoveTasks,
  });

  // what the row callbacks read, so they keep one identity (rows are memoized)
  const latest = useRef({ selection, nav, onSelect, editing, onOpenInfo, rowDrag });
  useLayoutEffect(() => {
    latest.current = { selection, nav, onSelect, editing, onOpenInfo, rowDrag };
  });
  const onCellDown = useCallback((id: string | 'blank', col: string, e: CellPress) => {
    if (e.button !== 0) return;
    const { selection: sel, nav: shown, onSelect: select, rowDrag: rows } = latest.current;
    if (col === 'id' && id !== 'blank') {
      if (e.shiftKey) {
        select(extendRows(sel, id, col, shown));
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        select(toggleRow(sel, id, col));
        return;
      }
      // one row of several selected: a drag of them all may follow (a click selects it on release)
      if (rows.keepsSelection(id)) return;
    }
    select(selectCell(id, col));
  }, []);
  const onIdPointerDown = useCallback((id: string, e: PointerEvent<HTMLElement>) => {
    latest.current.rowDrag.onIdPointerDown(e, id);
  }, []);
  const onCellOpen = useCallback((id: string | 'blank', col: string) => {
    const { editing: cells, onOpenInfo: info } = latest.current;
    if (cells.open(id, col, null) || id === 'blank' || cells.editor) return;
    const task = taskOfRow(id);
    if (task) info?.(task);
  }, []);

  // Tab into a sheet with nothing selected: the first row's Task Name is
  // active, as MS Project always has a cell (a click picks its own cell)
  const pressed = useRef(false);
  const onGridPress = () => {
    pressed.current = true;
    window.setTimeout(() => { pressed.current = false; });
  };
  const onGridFocus = (e: FocusEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || pressed.current || selection.active) return;
    // a toolbar command handing focus back (usePlanCommands' focusSheet), not a Tab in
    if (e.currentTarget.dataset.quietFocus) return;
    const first = nav[0] ?? (blankRow ? 'blank' : null);
    const col = columns.some((c) => c.key === 'name') ? 'name' : columns[0]?.key;
    if (first && col) onSelect(selectCell(first, col));
  };

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || editing.editor) return;
    const action = gridKey(keyLike(e));
    if (action.kind === 'move') {
      const next = moveActive(selection, action.dir, blankRow ? [...nav, 'blank'] : nav, columns.map((c) => c.key));
      const moved = next.active?.id !== selection.active?.id || next.active?.col !== selection.active?.col;
      if (!moved && e.key === 'Tab') return;      // the row's edge: Tab leaves the sheet
      e.preventDefault();
      if (moved || selection.rows.size !== next.rows.size) onSelect(next);
    } else if (action.kind === 'edit') {
      const at = selection.active;
      if (at && editing.open(at.id, at.col, action.seed)) e.preventDefault();
    }
  };

  const xOf = (i: number) => widths.slice(0, i).reduce((a, b) => a + b, 0);

  // the active cell scrolls into view under the sticky header (the blank
  // row also as tasks are added above it)
  const active = selection.active;
  const activeIndex = active ? (active.id === 'blank' ? rows.length : rows.indexOf(active.id)) : -1;
  const activeCol = active ? columns.findIndex((c) => c.key === active.col) : -1;
  const reveal = active ? `${active.id}/${active.col}${active.id === 'blank' ? `@${activeIndex}` : ''}` : '';
  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (!box || activeIndex < 0 || activeCol < 0) return;
    const top = scrollToShow(SHEET_HEAD_PX + activeIndex * rowHeight, rowHeight, box.scrollTop, box.clientHeight,
      SHEET_HEAD_PX);
    if (top !== null) box.scrollTop = top;
    const side = sideScrollRef?.current ?? box;
    const left = scrollToShow(xOf(activeCol), widths[activeCol], side.scrollLeft, side.clientWidth, 0);
    if (left !== null) side.scrollLeft = left;
    // only when the active cell changes, not on every redraw
  }, [reveal]);

  // the edited row or column left the sheet (collapsed, hidden, deleted): the edit goes
  const ed = editing.editor;
  const edRow = ed ? (ed.id === 'blank' ? (blankRow ? rows.length : -1) : rows.indexOf(ed.id)) : -1;
  const edCol = ed ? columns.findIndex((c) => c.key === ed.col) : -1;
  const edGone = ed !== null && (edRow < 0 || edCol < 0);
  useEffect(() => {
    if (edGone) editing.cancel(false);
  }, [edGone, editing]);

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
    // the capture went away without a pointerup (the pointer left the
    // window, another element took it): the drag ends, unsaved, rather than
    // following a pointer that no longer reports here. After a pointerup
    // the drag is already over and this does nothing.
    onLostPointerCapture: () => {
      if (!resizing.current) return;
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
  const blankIndex = rows.length;
  const items = virtualizer.getVirtualItems();
  const cellId = (rowKey: string, col: string) => `${idBase}-${rowKey}-${col}`;
  const activeShown = active && activeCol >= 0 && items.some((i) => i.key === active.id);
  const edTask = ed && ed.id !== 'blank' ? tasksById.get(taskOfRow(ed.id) ?? '') : undefined;

  return (
    <div ref={gridRef} className="pln-sheet" role="grid" aria-label="Task sheet" aria-rowcount={count + 1}
         aria-colcount={columns.length} aria-multiselectable="true" style={gridStyle} tabIndex={0}
         aria-activedescendant={activeShown ? cellId(active.id, active.col) : undefined} onKeyDown={onGridKey}
         onMouseDownCapture={onGridPress} onFocus={onGridFocus} data-row-drag={rowDrag.on ? '' : undefined}>
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

      <div ref={bodyRef} className="pln-sheet-body" role="rowgroup" style={{ height: virtualizer.getTotalSize() }}>
        {items.map((item) => {
          const y = item.start - SHEET_HEAD_PX;
          if (item.index === blankIndex) {
            return (
              <BlankRow key="blank" index={item.index} y={y} columns={columns} idBase={idBase}
                        activeCol={active?.id === 'blank' ? active.col : null} onCellDown={onCellDown}
                        onCellOpen={onCellOpen} />
            );
          }
          const key = rows[item.index];
          const band = bands.get(key);
          if (band) {
            return <BandRow key={key} band={band} index={item.index} y={y} span={columns.length} />;
          }
          const task = tasksById.get(taskOfRow(key) ?? '');
          if (!task) return null;
          return (
            <SheetRow key={key} rowKey={key} task={task} index={item.index} y={y} columns={columns} ctx={ctx}
                      level={bands.size ? GROUPED_LEVEL : task.outline_level}
                      idBase={idBase} inert={context.has(key)} collapsed={collapsed.has(task.id)} cut={cut.has(task.id)}
                      selected={selection.rows.has(key)} activeCol={active?.id === key ? active.col : null}
                      onCellDown={onCellDown} onCellOpen={onCellOpen} onToggleCollapse={onToggleCollapse}
                      onIdPointerDown={onIdPointerDown} />
          );
        })}
        {/* where a row drag would land: between two rows, or under the last */}
        {rowDrag.gap !== null && (
          <div className="pln-drop-line" aria-hidden="true"
               style={{ transform: `translateY(${rowDrag.gap * rowHeight}px)` }} />
        )}
        {ed && !edGone && (
          <CellEditor key={ed.seq} editor={ed} column={columns[edCol]}
                      options={ed.kind === 'resources' ? resourceOptions(plan.resources, edTask?.assignees ?? []) : NO_OPTIONS}
                      style={{ transform: `translate(${xOf(edCol)}px, ${edRow * rowHeight}px)`, width: widths[edCol],
                        height: rowHeight }}
                      onChange={editing.change} onCommit={editing.commit} onCancel={editing.cancel}
                      onFail={editing.fail} onTypeAhead={editing.typeAhead} />
        )}
      </div>
    </div>
  );
}

interface RowEvents {
  /** The id of the grid, for each cell's id (aria-activedescendant). */
  idBase: string;
  onCellDown(id: string | 'blank', col: string, e: CellPress): void;
  onCellOpen(id: string | 'blank', col: string): void;
}

interface SheetRowProps extends RowEvents {
  /** The row's key: the task's id, or its group's and its own. */
  rowKey: string;
  task: PlanTask;
  /** A filter's context row: dimmed and inert. */
  inert: boolean;
  /** A cut marked it: waiting for its paste. */
  cut: boolean;
  /** The Task Name's indent: the outline level, or one in from a group's band. */
  level: number;
  index: number;
  y: number;
  columns: PlanColumn[];
  ctx: SheetContext;
  collapsed: boolean;
  selected: boolean;
  activeCol: string | null;
  onToggleCollapse(id: string): void;
  /** A press on the row's ID: maybe a drag (useRowDrag). */
  onIdPointerDown(id: string, e: PointerEvent<HTMLElement>): void;
}

/** One task's row; redraws only when its task object, place or state changes. */
const SheetRow = memo(function SheetRow({
  rowKey, task, index, y, columns, ctx, inert, cut, level, collapsed, selected, activeCol, idBase, onCellDown,
  onCellOpen, onToggleCollapse, onIdPointerDown,
}: SheetRowProps) {
  return (
    <div role="row" aria-rowindex={index + 2} aria-selected={selected} aria-disabled={inert || undefined}
         data-task={task.id}
         className={`pln-row${task.is_summary ? ' pln-summary' : ''}${inert ? ' pln-context' : ''}${cut ? ' pln-cut' : ''}`}
         style={{ transform: `translateY(${y}px)` }}>
      {columns.map((col, i) => (
        <div key={col.key} id={`${idBase}-${rowKey}-${col.key}`} role="gridcell" aria-colindex={i + 1}
             aria-selected={activeCol === col.key} data-col={col.key}
             className={`cell pln-cell${alignClass(col)}${col.key === 'id' ? ' pln-idcell' : ''}${col.key === 'name' ? ' pln-namecell' : ''}`}
             style={col.key === 'name' ? { '--pln-level': level } as CSSProperties : undefined}
             onMouseDown={inert ? undefined : (e) => onCellDown(rowKey, col.key, e)}
             onPointerDown={inert || col.key !== 'id' ? undefined : (e) => onIdPointerDown(rowKey, e)}
             onDoubleClick={inert ? undefined : () => onCellOpen(rowKey, col.key)}>
          <CellContent col={col} task={task} ctx={ctx} collapsed={collapsed}
                       onToggleCollapse={inert ? undefined : onToggleCollapse} />
        </div>
      ))}
    </div>
  );
});

/** A group's band (Group by): its name and how many rows are under it,
 *  across the row. Not a stop for the keys; a click on it selects nothing. */
function BandRow({ band, index, y, span }: { band: GroupBand; index: number; y: number; span: number }) {
  return (
    <div role="row" aria-rowindex={index + 2} className="pln-row pln-band" data-band=""
         style={{ transform: `translateY(${y}px)` }}>
      <div role="rowheader" aria-colspan={span} className="cell pln-cell pln-band-cell">
        <b className="cell-top cell-line" title={band.label}>{band.label}</b>
        <span className="cell-sub">{band.count} task{band.count === 1 ? '' : 's'}</span>
      </div>
    </div>
  );
}

function CellContent({ col, task, ctx, collapsed, onToggleCollapse }: {
  col: PlanColumn; task: PlanTask; ctx: SheetContext; collapsed: boolean;
  /** Absent on a context row: it is always open (it places a match). */
  onToggleCollapse?(id: string): void;
}): ReactNode {
  switch (col.text ?? 'top') {
    case 'name': {
      const name = task.name;
      return (
        <>
          <span className="pln-twisty-slot">
            {task.is_summary && onToggleCollapse && (
              <button type="button" className="pln-twisty" aria-expanded={!collapsed}
                      aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`} tabIndex={-1}
                      onMouseDown={(e) => e.stopPropagation()}
                      onDoubleClick={(e) => e.stopPropagation()}
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
    case 'color': {
      // the bar's color: a swatch, then the palette name (or the hex of a custom one)
      if (!task.color) return null;
      const text = col.value(task, ctx);
      return (
        <>
          <span className="color-swatch" style={{ background: task.color }} aria-hidden="true" />
          <span className={`${isPaletteColor(task.color) ? 'cell-top' : 'mono'} cell-line`} title={text}>{text}</span>
        </>
      );
    }
    default: {
      const text = col.value(task, ctx);
      if (!text) return null;
      const kind = col.text === 'mono' ? 'mono' : col.text === 'sub' ? 'cell-sub' : 'cell-top';
      // a multi-line note is edited in Task Information, not this cell: its
      // lines show on hover, with where to edit it
      const title = col.key === 'notes' && multiLineNote(task) ? `${noteExcerpt(task.notes)}\n\n${MULTILINE_NOTE_TITLE}`
        : kind !== 'mono' || TITLED.has(col.key) ? text : undefined;
      return <span className={`${kind} cell-line`} title={title}>{text}</span>;
    }
  }
}

/** The new-task row under the last task: typing a name there adds one. */
function BlankRow({ index, y, columns, activeCol, idBase, onCellDown, onCellOpen }: RowEvents & {
  index: number; y: number; columns: PlanColumn[]; activeCol: string | null;
}) {
  return (
    <div role="row" aria-rowindex={index + 2} aria-selected={activeCol !== null} data-blank=""
         className="pln-row pln-blank" style={{ transform: `translateY(${y}px)` }}>
      {columns.map((col, i) => (
        <div key={col.key} id={`${idBase}-blank-${col.key}`} role="gridcell" aria-colindex={i + 1}
             aria-selected={activeCol === col.key} data-col={col.key}
             className={`cell pln-cell${col.key === 'id' ? ' pln-idcell' : ''}`}
             onMouseDown={(e) => onCellDown('blank', col.key, e)}
             onDoubleClick={() => onCellOpen('blank', col.key)} />
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
