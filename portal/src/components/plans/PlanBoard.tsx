/**
 * The plan's Board view (spec "Views": Board) — "work off the plan during
 * the move": three columns, Not started / In progress / Complete, each
 * with its count, holding the leaf tasks the filter bar shows as cards in
 * outline order (lib/plans/board). A card shows the task's name, the path
 * of its summaries ("Prep › Crating"), Start → Finish (the finish day being
 * its last working minute's, floatingTime `lastDay`), its resources, a Late
 * badge and its deadline.
 *
 * Moving a card sets its % Complete: 0, 50 or 100 for the column it lands
 * in, built by the toolbar's own setPercent (lib/plans/commands) and sent
 * through the tab's completion runner (useCompletion `run`), so 100% meets
 * the plan's completion rules and its dialog like every other 100%, and
 * each move is one undo step in usePlan's write queue. A milestone moves
 * between Not started and Complete only. Two ways to move:
 *  - drag the card to another column (the drag carries the task's id under
 *    its own type, `application/x-plan-task`, so a card dropped on a text
 *    field types nothing);
 *  - from the keyboard, its actions menu (RowActionsMenu: Move to …, and
 *    Task Information…). Focus follows the card to its new column once it
 *    lands there (its ⋯ button), so the next key (Ctrl+Z, say) is the
 *    Board's. A move that doesn't happen (the completion check stopped it,
 *    the API refused it) leaves nothing waiting to take focus later.
 * Either way a polite note says "Moved <task> to <column>" once it lands.
 * Moving is progress, so a locked plan still takes it; people who can't
 * change the plan get no dragging and no Move items.
 *
 * A click on a card selects its task (the sheet's selection, shared by
 * every view; Ctrl or ⌘ adds it), so the toolbar's commands work on it;
 * a double-click opens Task Information. A task selected elsewhere (Go to
 * task) scrolls its card into view inside its column, never the page.
 *
 * 1,500 tasks: a card is memoized on props that only change with its own
 * task, selection or drag, so a click redraws the cards it changes and no
 * others; off-screen cards skip their layout (`content-visibility`).
 */
import {
  memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent,
  type ReactNode,
} from 'react';

import type { Plan, PlanTask } from '../../lib/plans/api';
import {
  BOARD_COLUMNS, boardCards, columnOf, columnsFor, percentForColumn, type BoardCard, type BoardColumn,
} from '../../lib/plans/board';
import { COMMAND_TIPS } from '../../lib/plans/commandTips';
import { setPercent } from '../../lib/plans/commands';
import { formatDay, lastDay } from '../../lib/plans/floatingTime';
import { selectCell } from '../../lib/plans/selection';
import { DotsIcon, RowActionsMenu, type RowAction } from '../hardware/RowActionsMenu';
import Tip from '../Tip';
import type { Completion } from './useCompletion';

const LABELS: Record<BoardColumn, string> = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, c.label])) as
  Record<BoardColumn, string>;

/** What a dragged card carries: its task's id, under a type of its own. */
export const TASK_DRAG_TYPE = 'application/x-plan-task';

export interface PlanBoardProps {
  plan: Plan;
  /** The tasks the filter bar shows, in outline order (useSheetView's rows). */
  rows: readonly string[];
  /** The rows only there to place a match (summaries): never cards. */
  context: ReadonlySet<string>;
  /** The selected tasks' ids. */
  selected: ReadonlySet<string>;
  /** A click on a card; `additive` with Ctrl or ⌘. */
  onSelect(id: string, additive: boolean): void;
  /** A double-click, or the menu's Task Information…. */
  onOpenInfo(id: string): void;
  /** The tab's completion check: a move goes through its runner. */
  completion: Pick<Completion, 'run'>;
}

/** A move sent and not yet landed: where its card should arrive, whether
 *  focus goes with it (a move from the keyboard), and whether its write has
 *  answered (once it has, with no completion check open, a card that
 *  hasn't arrived never will). */
interface PendingMove {
  id: string;
  to: BoardColumn;
  focus: boolean;
  answered: boolean;
}

/** "Mon 11/2/26 → Tue 11/3/26"; one day for a milestone (or a task on one day). */
function datesOf(task: PlanTask): string {
  const start = formatDay(task.start);
  const finish = formatDay(task.start ? lastDay(task.start, task.finish) : task.finish);
  return !finish || finish === start || task.is_milestone ? start : `${start} → ${finish}`;
}

/** Scrolls `box` the least that brings `el` into it, on one axis (the
 *  column up and down, the board sideways): never the page. */
function revealIn(box: HTMLElement | null, el: HTMLElement, axis: 'y' | 'x'): void {
  if (!box) return;
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const [start, end, from, to] = axis === 'y' ? [r.top, r.bottom, b.top, b.bottom] : [r.left, r.right, b.left, b.right];
  let by = 0;
  if (start < from) by = start - from;
  else if (end > to) by = Math.min(end - to, start - from);
  if (!by) return;
  if (axis === 'y') box.scrollTop += by;
  else box.scrollLeft += by;
}

export default function PlanBoard({
  plan, rows, context, selected, onSelect, onOpenInfo, completion,
}: PlanBoardProps) {
  const tasksById = useMemo(() => new Map(plan.tasks.map((t) => [t.id, t])), [plan.tasks]);
  const cards = useMemo(() => boardCards(rows.filter((id) => !context.has(id)), tasksById), [rows, context, tasksById]);
  const canMove = plan.permissions.change;
  const boardRef = useRef<HTMLDivElement>(null);

  // what the stable callbacks below read (the cards are memoized on them)
  const latest = useRef({ plan, tasksById, completion, canMove });
  useLayoutEffect(() => {
    latest.current = { plan, tasksById, completion, canMove };
  });

  // ── moves ──
  const pending = useRef<PendingMove | null>(null);
  const [note, setNote] = useState('');
  const [, setAnswered] = useState(0);

  /** The task to `to`'s percent, through the completion runner: one undo step. */
  const move = useCallback((id: string, to: BoardColumn, fromKeys: boolean) => {
    const { plan: now, tasksById: byId, completion: check, canMove: may } = latest.current;
    const task = byId.get(id);
    if (!may || !task || columnOf(task) === to || !columnsFor(task).includes(to)) return;
    const cmd = setPercent(selectCell(id, 'name'), percentForColumn(to), { plan: now, tempId: () => '' });
    if ('error' in cmd || !cmd.ops.length) return;
    const mine: PendingMove = { id, to, focus: fromKeys, answered: false };
    pending.current = mine;
    setNote('');
    void Promise.resolve(check.run(cmd.ops, `Move to ${LABELS[to]}`)).finally(() => {
      if (pending.current !== mine) return;
      mine.answered = true;
      setAnswered((n) => n + 1);
    });
  }, []);
  const moveByKeys = useCallback((id: string, to: BoardColumn) => move(id, to, true), [move]);

  // a move landed: say so, and (from the keyboard) focus its card's ⋯ in
  // the new column; answered and not landed, with no check open: forget it
  useLayoutEffect(() => {
    const wait = pending.current;
    if (!wait) return;
    const task = tasksById.get(wait.id);
    if (task && columnOf(task) === wait.to) {
      pending.current = null;
      setNote(`Moved ${task.name || 'Untitled task'} to ${LABELS[wait.to]}`);
      if (wait.focus) {
        boardRef.current?.querySelector<HTMLElement>(
          `.pln-board-col[data-column="${wait.to}"] [data-task-id="${wait.id}"] .pln-card-menu`)?.focus();
      }
    } else if (wait.answered && !document.querySelector('.modal-scrim')) {
      pending.current = null;
    }
  });

  // ── dragging ──
  // the card being dragged (a ref too: a drop reads it in the same tick as the drag's start)
  const dragged = useRef<{ id: string; from: BoardColumn } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<BoardColumn | null>(null);
  const endDrag = useCallback(() => {
    dragged.current = null;
    setDragging(null);
    setOver(null);
  }, []);
  const startDrag = useCallback((id: string, from: BoardColumn, e: DragEvent<HTMLElement>) => {
    if (!latest.current.canMove) {
      e.preventDefault();
      return;
    }
    dragged.current = { id, from };
    setDragging(id);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData(TASK_DRAG_TYPE, id);
    }
  }, []);
  /** The dragged card could land in `column`. */
  const lands = (column: BoardColumn): boolean => {
    const drag = dragged.current;
    const task = drag ? tasksById.get(drag.id) : undefined;
    return !!drag && !!task && drag.from !== column && columnsFor(task).includes(column);
  };

  // a task picked elsewhere (Go to task): its card into view, in its column
  const selectedKey = [...selected].join(',');
  useEffect(() => {
    const first = selectedKey.split(',')[0];
    const card = first ? boardRef.current?.querySelector<HTMLElement>(`[data-task-id="${first}"]`) : null;
    if (!card) return;
    revealIn(card.closest<HTMLElement>('.pln-board-cards'), card, 'y');
    revealIn(boardRef.current, card, 'x');
  }, [selectedKey]);

  return (
    <div className="pln-board" ref={boardRef}>
      {BOARD_COLUMNS.map(({ key }) => (
        <Column key={key} column={key} count={cards[key].length} over={over === key}
                onDragOver={(e) => {
                  if (!lands(key)) return;
                  e.preventDefault();
                  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
                  if (over !== key) setOver(key);
                }}
                onDragLeave={(e) => {
                  if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === key ? null : o));
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  const drag = dragged.current;
                  endDrag();
                  if (drag) move(drag.id, key, false);
                }}>
          {cards[key].map((card) => (
            <Card key={card.task.id} card={card} column={key} on={selected.has(card.task.id)} canMove={canMove}
                  dragging={dragging === card.task.id} onSelect={onSelect} onOpenInfo={onOpenInfo}
                  onMove={moveByKeys} onDragStart={startDrag} onDragEnd={endDrag} />
          ))}
        </Column>
      ))}
      <p className="pln-sr" role="status" aria-live="polite">{note}</p>
    </div>
  );
}

function Column({ column, count, over, onDragOver, onDragLeave, onDrop, children }: {
  column: BoardColumn;
  count: number;
  over: boolean;
  onDragOver(e: DragEvent<HTMLElement>): void;
  onDragLeave(e: DragEvent<HTMLElement>): void;
  onDrop(e: DragEvent<HTMLElement>): void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={`pln-board-col${over ? ' on' : ''}`} aria-labelledby={id} data-column={column}
             onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
      <div className="pln-board-top">
        <h3 id={id} className="pln-board-title">{LABELS[column]}</h3>
        <span className="pln-board-count">{count}</span>
      </div>
      <div className="pln-board-cards">
        {count ? children : <p className="pln-board-empty">No tasks</p>}
      </div>
    </section>
  );
}

/** One card. Memoized: its props change only with its own task (a new
 *  `card`), its selection, its drag, or the plan's permission; the handlers
 *  are the board's stable ones, called with the card's own id. */
const Card = memo(function Card({
  card, column, on, canMove, dragging, onSelect, onOpenInfo, onMove, onDragStart, onDragEnd,
}: {
  card: BoardCard;
  column: BoardColumn;
  on: boolean;
  canMove: boolean;
  dragging: boolean;
  onSelect(id: string, additive: boolean): void;
  onOpenInfo(id: string): void;
  onMove(id: string, to: BoardColumn): void;
  onDragStart(id: string, from: BoardColumn, e: DragEvent<HTMLElement>): void;
  onDragEnd(): void;
}) {
  const { task, path } = card;
  const name = task.name || 'Untitled task';
  const actions: RowAction[] = [];
  if (canMove) {
    for (const to of columnsFor(task)) {
      if (to !== column) actions.push({ key: to, label: `Move to ${LABELS[to]}`, onSelect: () => onMove(task.id, to) });
    }
  }
  actions.push({ key: 'info', label: 'Task Information…', onSelect: () => onOpenInfo(task.id) });
  const tip = canMove ? COMMAND_TIPS.cardActions : COMMAND_TIPS.cardActionsReadOnly;
  const menuName = `Actions for ${name}`;
  const names = task.assignees.map((a) => a.name).join(', ');
  const classes = ['cell', 'pln-card'];
  if (on) classes.push('on');
  if (dragging) classes.push('dragging');

  return (
    <div role="group" aria-label={name} className={classes.join(' ')} data-task-id={task.id} draggable={canMove}
         onClick={(e: MouseEvent<HTMLDivElement>) => onSelect(task.id, e.ctrlKey || e.metaKey)}
         onDoubleClick={() => onOpenInfo(task.id)} onDragStart={(e) => onDragStart(task.id, column, e)}
         onDragEnd={onDragEnd}>
      <div className="pln-card-top">
        <button type="button" className="cell-top pln-card-name" aria-pressed={on}>{name}</button>
        <Tip label={menuName} desc={tip.desc}>
          <RowActionsMenu label={menuName} icon={<DotsIcon />} triggerClassName="mini-btn pln-card-menu"
                          actions={actions} />
        </Tip>
      </div>
      {path && <span className="cell-sub pln-card-path">{path}</span>}
      <span className="mono pln-card-dates">{datesOf(task)}</span>
      {names && <span className="cell-sub pln-card-who">{names}</span>}
      {(task.status === 'late' || task.deadline) && (
        <div className="pln-card-tags">
          {task.status === 'late' && <span className="chip c-red">Late</span>}
          {task.deadline && (
            <span className={`cell-sub pln-card-deadline${task.missed_deadline ? ' missed' : ''}`}>
              {`Deadline ${formatDay(task.deadline)}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
});
