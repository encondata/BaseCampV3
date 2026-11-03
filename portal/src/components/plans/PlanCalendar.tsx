/**
 * The plan's Calendar view (spec "Views": Calendar): a Monday-first month
 * grid of the leaf tasks the filter bar shows, the way the all-initiatives
 * calendar (pages/InitiativeTimeline.tsx) draws initiatives — `monthGrid()`
 * and `calendarWeeks()` from lib/timeline, each task one bar across the days
 * it covers, a segment per week row it reaches, square-ended where it
 * carries on into the next row. A milestone is a diamond chip on its day.
 * A week shows four lanes; the rest fold into "+N more" on the days they
 * cross, one click from showing every lane.
 *
 * Days are the plan's own: a task's floating Start and Finish read as their
 * day strings (lib/plans/floatingTime; a finish at midnight ends the day
 * before), never through the browser's zone, and "today" is the plan's now.
 * It opens on the month of the plan's now when the project spans it, else
 * the project's first month; ‹ › step a month and Today comes back. A task
 * selected elsewhere (the Gantt, Go to task, the `&task=` link) that has no
 * bar on the month shown brings its month into view.
 *
 * A click on a bar selects its task (the sheet's selection, shared by every
 * view); Ctrl or ⌘ adds it to the selection. A double-click, or Shift+F2 on
 * a bar, opens Task Information. Hovering a bar shows the Gantt's hover card.
 */
import {
  useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent,
} from 'react';

import type { Plan, PlanTask } from '../../lib/plans/api';
import { COMMAND_TIPS } from '../../lib/plans/commandTips';
import { dayOf, formatDayRange, fromMs, toMs } from '../../lib/plans/floatingTime';
import {
  calendarWeeks, monthGrid, parseApiDay, type CalendarSegment, type TimelineItem,
} from '../../lib/timeline';
import Tip from '../Tip';
import { GanttHover } from './GanttHoverCard';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
  'November', 'December'];
/** Lanes a week shows before the rest fold into "+N more" (the all-initiatives calendar's). */
const MAX_LANES = 4;

/** A leaf task as lib/timeline's calendar item: its days as `YYYY-MM-DD`. */
interface CalendarTask extends TimelineItem {
  task: PlanTask;
}

export interface PlanCalendarProps {
  plan: Plan;
  /** The tasks the filter bar shows, in outline order (useSheetView's rows). */
  rows: readonly string[];
  /** The rows only there to place a match (summaries): never drawn. */
  context: ReadonlySet<string>;
  /** The selected tasks' ids. */
  selected: ReadonlySet<string>;
  /** A click on a task's bar; `additive` with Ctrl or ⌘. */
  onSelect(id: string, additive: boolean): void;
  /** A double-click (Task Information). */
  onOpenInfo(id: string): void;
}

/** The day of a task's last working minute: a finish at midnight is the
 *  day before; a milestone (or a finish not after the start) is its start's day. */
function lastDay(start: string, finish: string | null): string {
  const from = toMs(start);
  const to = finish ? toMs(finish) : Number.NaN;
  return to > from ? dayOf(fromMs(to - 60_000)) : dayOf(start);
}

/** A plan day (`YYYY-MM-DD…`) as a local Date of the same digits (lib/timeline's dates). */
const localDay = (s: string): Date => parseApiDay(dayOf(s));

/** Local calendar date as `YYYY-MM-DD`, from its parts (never toISOString). */
function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const firstOfMonth = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), 1);

/** The month to open on: the plan's now when the project spans it, else its first month. */
function openingMonth(plan: Plan): Date {
  const now = toMs(plan.now);
  const start = toMs(plan.project_start);
  const finish = plan.project_finish ? toMs(plan.project_finish) : start;
  return firstOfMonth(localDay(now >= start && now <= finish ? plan.now : plan.project_start));
}

export default function PlanCalendar({ plan, rows, context, selected, onSelect, onOpenInfo }: PlanCalendarProps) {
  const [anchor, setAnchor] = useState<Date>(() => openingMonth(plan));
  const [expanded, setExpanded] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const monthRef = useRef<HTMLDivElement>(null);
  const noBar = useRef<HTMLElement>(null);

  const tasksById = useMemo(() => new Map(plan.tasks.map((t) => [t.id, t])), [plan.tasks]);
  const items = useMemo(() => {
    const out: CalendarTask[] = [];
    for (const id of rows) {
      const task = tasksById.get(id);
      if (!task || task.is_summary || context.has(id) || !task.start) continue;
      out.push({
        task, name: task.name, scheduled_start: dayOf(task.start), scheduled_end: lastDay(task.start, task.finish),
      });
    }
    return out;
  }, [rows, context, tasksById]);

  const cells = useMemo(() => monthGrid(anchor), [anchor]);
  const weeks = useMemo(() => calendarWeeks(items, cells), [items, cells]);
  const today = dayOf(plan.now);

  // a month step swaps the grid out from under the open week, and starts at its top
  useEffect(() => {
    setExpanded(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [anchor]);

  // a selected task with no bar on the month shown brings its month into view;
  // only when the selection changes, so stepping away from it stays put
  const latest = useRef({ items, cells, selected });
  useLayoutEffect(() => {
    latest.current = { items, cells, selected };
  });
  const selectedKey = [...selected].join(',');
  useEffect(() => {
    if (!selectedKey) return;
    const { items: now, cells: grid, selected: picks } = latest.current;
    const first = grid[0].date.getTime();
    const last = grid[grid.length - 1].date.getTime();
    const picked = now.filter((i) => picks.has(i.task.id));
    const shown = picked.some((i) => parseApiDay(i.scheduled_end as string).getTime() >= first
      && parseApiDay(i.scheduled_start as string).getTime() <= last);
    if (picked.length && !shown) setAnchor(firstOfMonth(parseApiDay(picked[0].scheduled_start as string)));
  }, [selectedKey]);

  useEffect(() => {
    if (!expanded) return undefined;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setExpanded(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [expanded]);

  const step = (months: number) => setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + months, 1));
  const tips = { prev: COMMAND_TIPS.calPrev, today: COMMAND_TIPS.calToday, next: COMMAND_TIPS.calNext };

  return (
    <div className="pln-month">
      <div className="pln-month-nav">
        <h3 className="pln-month-title" aria-live="polite">{MONTHS[anchor.getMonth()]} {anchor.getFullYear()}</h3>
        <div className="pln-month-steps">
          <Tip label={tips.prev.label} desc={tips.prev.desc}>
            <button type="button" className="mini-btn" aria-label={tips.prev.label} onClick={() => step(-1)}>‹</button>
          </Tip>
          <Tip label={tips.today.label} desc={tips.today.desc}>
            <button type="button" className="mini-btn" onClick={() => setAnchor(firstOfMonth(localDay(plan.now)))}>
              {tips.today.label}
            </button>
          </Tip>
          <Tip label={tips.next.label} desc={tips.next.desc}>
            <button type="button" className="mini-btn" aria-label={tips.next.label} onClick={() => step(1)}>›</button>
          </Tip>
        </div>
      </div>

      <div className="pln-month-scroll" ref={scrollRef}>
        <div className="pln-month-body" ref={monthRef}>
          <div className="pln-month-weekdays" aria-hidden="true">
            {WEEKDAYS.map((w) => <div key={w} className="pln-month-weekday">{w}</div>)}
          </div>

          {weeks.map((week) => {
            const key = isoDay(week.days[0].date);
            const open = expanded === key;
            const cap = open ? week.laneCount : MAX_LANES;
            const shown = week.segments.filter((s) => s.lane < cap);
            const hidden = week.segments.filter((s) => s.lane >= cap);
            // a day's "+N more" counts the bars crossing it that the cap dropped
            const hiddenOn = (col: number) => hidden.filter((s) => col >= s.startCol && col < s.startCol + s.span).length;
            const lanes = Math.min(week.laneCount, cap) + (hidden.length || open ? 1 : 0);
            return (
              <div key={key} className={`pln-month-week${open ? ' open' : ''}`} style={{ '--lanes': lanes } as CSSProperties}>
                {week.days.map((cell, col) => {
                  const more = hiddenOn(col);
                  const day = isoDay(cell.date);
                  return (
                    <div key={day} className={`cell pln-month-day${cell.inMonth ? '' : ' muted'}${day === today ? ' today' : ''}`}>
                      <span className="mono pln-month-daynum">{cell.date.getDate()}</span>
                      {more > 0 && (
                        <button type="button" className="pln-month-more" onClick={() => setExpanded(key)}
                                aria-label={`Show all tasks for the week of ${MONTHS[week.days[0].date.getMonth()]} `
                                  + `${week.days[0].date.getDate()}`}>
                          +{more} more
                        </button>
                      )}
                    </div>
                  );
                })}

                <div className="pln-month-bars">
                  {shown.map((seg) => (
                    <Segment key={seg.item.task.id} seg={seg} on={selected.has(seg.item.task.id)}
                             onSelect={onSelect} onOpenInfo={onOpenInfo} />
                  ))}
                </div>

                {open && (
                  <button type="button" className="pln-month-less" onClick={() => setExpanded(null)}>Show less</button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <GanttHover chartRef={monthRef} scrollRef={scrollRef} barRef={noBar} tasksById={tasksById} plan={plan} />
    </div>
  );
}

/** One task's bar across the days it covers in one week row; a milestone's
 *  diamond chip. Its color is the task's (Properties › Task color), else
 *  the accent the Gantt's bars use. */
function Segment({ seg, on, onSelect, onOpenInfo }: {
  seg: CalendarSegment<CalendarTask>;
  on: boolean;
  onSelect(id: string, additive: boolean): void;
  onOpenInfo(id: string): void;
}) {
  const { task } = seg.item;
  const name = task.name || 'Untitled task';
  const click = (e: MouseEvent<HTMLButtonElement>) => onSelect(task.id, e.ctrlKey || e.metaKey);
  // Shift+F2 is the tab's Task Information for the selection; with none, the bar's own
  const key = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'F2' && e.shiftKey && !e.defaultPrevented) {
      e.preventDefault();
      onOpenInfo(task.id);
    }
  };
  const classes = ['chip', 'custom', 'pln-month-span'];
  if (task.is_milestone) classes.push('pln-month-milestone');
  if (seg.continuesBefore) classes.push('cont-before');
  if (seg.continuesAfter) classes.push('cont-after');
  if (on) classes.push('on');
  return (
    <button type="button" className={classes.join(' ')} data-task-id={task.id} aria-pressed={on}
            aria-label={`${name}, ${formatDayRange(task.start, task.finish)}`}
            style={{
              gridColumn: `${seg.startCol + 1} / span ${seg.span}`,
              gridRow: seg.lane + 1,
              '--chip': task.color ?? 'var(--accent)',
            } as CSSProperties}
            onClick={click} onDoubleClick={() => onOpenInfo(task.id)} onKeyDown={key}>
      {task.is_milestone
        ? <span className="pln-month-diamond" aria-hidden="true" />
        : <span className="dot" aria-hidden="true" />}
      <span className="pln-month-name">{name}</span>
    </button>
  );
}
