/**
 * The plan's Board view (spec "Views": Board) — "work off the plan during
 * the move": three columns, Not started / In progress / Complete, each
 * with its count, holding the leaf tasks the filter bar shows as cards in
 * outline order (lib/plans/board). A card shows the task's name, the path
 * of its summaries ("Prep › Crating"), Start → Finish, its resources, a
 * Late badge and its deadline.
 *
 * Moving a card sets its % Complete: 0, 50 or 100 for the column it lands
 * in, built by the toolbar's own setPercent (lib/plans/commands) and sent
 * through the tab's completion runner (useCompletion `run`), so 100% meets
 * the plan's completion rules and its dialog like every other 100%, and
 * each move is one undo step in usePlan's write queue. Two ways to move:
 * drag the card to another column, or, from the keyboard, its actions menu
 * (RowActionsMenu: Move to …, and Task Information…). Moving is progress,
 * so a locked plan still takes it; people who can't change the plan get no
 * dragging and no Move items.
 *
 * A click on a card selects its task (the sheet's selection, shared by
 * every view; Ctrl or ⌘ adds it), so the toolbar's commands work on it;
 * a double-click opens Task Information. A task selected elsewhere (Go to
 * task) scrolls its card into view.
 */
import {
  useEffect, useId, useMemo, useRef, useState, type DragEvent, type MouseEvent, type ReactNode,
} from 'react';

import type { Plan, PlanTask } from '../../lib/plans/api';
import {
  BOARD_COLUMNS, boardCards, columnOf, percentForColumn, type BoardCard, type BoardColumn,
} from '../../lib/plans/board';
import { COMMAND_TIPS } from '../../lib/plans/commandTips';
import { setPercent } from '../../lib/plans/commands';
import { formatDay } from '../../lib/plans/floatingTime';
import { selectCell } from '../../lib/plans/selection';
import { RowActionsMenu, type RowAction } from '../hardware/RowActionsMenu';
import Tip from '../Tip';
import type { Completion } from './useCompletion';

const LABELS: Record<BoardColumn, string> = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.key, c.label])) as
  Record<BoardColumn, string>;

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

/** "Mon 11/2/26 → Tue 11/3/26"; one day for a milestone (or a task on one day). */
function datesOf(task: PlanTask): string {
  const start = formatDay(task.start);
  const finish = formatDay(task.finish);
  return !finish || finish === start || task.is_milestone ? start : `${start} → ${finish}`;
}

export default function PlanBoard({
  plan, rows, context, selected, onSelect, onOpenInfo, completion,
}: PlanBoardProps) {
  const tasksById = useMemo(() => new Map(plan.tasks.map((t) => [t.id, t])), [plan.tasks]);
  const cards = useMemo(() => boardCards(rows.filter((id) => !context.has(id)), tasksById), [rows, context, tasksById]);
  const canMove = plan.permissions.change;
  const boardRef = useRef<HTMLDivElement>(null);

  // the card being dragged (a ref too: a drop reads it in the same tick as the drag's start)
  const dragged = useRef<{ task: PlanTask; from: BoardColumn } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<BoardColumn | null>(null);
  const endDrag = () => {
    dragged.current = null;
    setDragging(null);
    setOver(null);
  };

  /** The task to `to`'s percent, through the completion runner: one undo step. */
  const move = (task: PlanTask, to: BoardColumn) => {
    if (!canMove || columnOf(task) === to) return;
    const cmd = setPercent(selectCell(task.id, 'name'), percentForColumn(to), { plan, tempId: () => '' });
    if ('error' in cmd || !cmd.ops.length) return;
    void completion.run(cmd.ops, `Move to ${LABELS[to]}`);
  };

  // a task picked elsewhere (Go to task): its card into view
  const selectedKey = [...selected].join(',');
  useEffect(() => {
    const first = selectedKey.split(',')[0];
    if (!first) return;
    const card = boardRef.current?.querySelector<HTMLElement>(`[data-task-id="${first}"]`);
    card?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selectedKey]);

  return (
    <div className="pln-board" ref={boardRef}>
      {BOARD_COLUMNS.map(({ key }) => (
        <Column key={key} column={key} cards={cards[key]} over={over === key}
                onDragOver={(e) => {
                  const from = dragged.current?.from;
                  if (!from || from === key) return;
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
                  if (drag) move(drag.task, key);
                }}>
          {cards[key].map((card) => (
            <Card key={card.task.id} card={card} on={selected.has(card.task.id)} canMove={canMove}
                  dragging={dragging === card.task.id} onSelect={onSelect} onOpenInfo={onOpenInfo}
                  onMove={(to) => move(card.task, to)}
                  onDragStart={(e) => {
                    if (!canMove) {
                      e.preventDefault();
                      return;
                    }
                    dragged.current = { task: card.task, from: key };
                    setDragging(card.task.id);
                    if (e.dataTransfer) {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', card.task.name);
                    }
                  }}
                  onDragEnd={endDrag} />
          ))}
        </Column>
      ))}
    </div>
  );
}

function Column({ column, cards, over, onDragOver, onDragLeave, onDrop, children }: {
  column: BoardColumn;
  cards: readonly BoardCard[];
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
        <span className="pln-board-count">{cards.length}</span>
      </div>
      <div className="pln-board-cards">
        {cards.length ? children : <p className="pln-board-empty">No tasks</p>}
      </div>
    </section>
  );
}

function Card({ card, on, canMove, dragging, onSelect, onOpenInfo, onMove, onDragStart, onDragEnd }: {
  card: BoardCard;
  on: boolean;
  canMove: boolean;
  dragging: boolean;
  onSelect(id: string, additive: boolean): void;
  onOpenInfo(id: string): void;
  onMove(to: BoardColumn): void;
  onDragStart(e: DragEvent<HTMLElement>): void;
  onDragEnd(): void;
}) {
  const { task, path } = card;
  const name = task.name || 'Untitled task';
  const here = columnOf(task);
  const actions: RowAction[] = [];
  if (canMove) {
    for (const c of BOARD_COLUMNS) {
      if (c.key !== here) actions.push({ key: c.key, label: `Move to ${c.label}`, onSelect: () => onMove(c.key) });
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
         onDoubleClick={() => onOpenInfo(task.id)} onDragStart={onDragStart} onDragEnd={onDragEnd}>
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
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}
