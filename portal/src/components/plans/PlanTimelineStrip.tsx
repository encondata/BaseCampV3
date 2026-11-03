/**
 * The Timeline strip (MS Project's Timeline view; spec "Views": Gantt): one
 * band above the Gantt view, toggled by Display › Timeline strip and kept
 * per plan in this browser (`plans.strip.<planId>`, PlanTab). It shows:
 *
 * - the project's span, the band's first and last days named at its ends
 *   (Start, Finish; a timeline task outside the project widens the band,
 *   and the names follow it; the last day is that of the last working
 *   minute, floatingTime `lastDay`, as every day label in these views);
 * - a today marker at the plan's now (plan-local, never the browser's);
 * - every task flagged Show on timeline (Properties › Add to Timeline, Task
 *   Information): milestones as diamonds with their name and date over the
 *   band (a label that would run into the one before it takes a second
 *   row), other tasks (summaries too) as bars with their names, stacked
 *   into at most three lanes — a bar that finds no free lane takes the one
 *   that frees up first; a bar is never narrower than 24px, and the
 *   selected one sits over any it overlaps.
 *
 * It is the view area's top band (MS Project's Timeline pane is part of the
 * view) and compact (18px rows on a 20px pitch): it takes its height from
 * the area, which keeps its floor, so the page never scrolls for it; it
 * reports that height (`onHeight`) for Below's splitter.
 *
 * The band is the project's span from end to end, so every place on it is
 * a share of that span (floating times through lib/plans/floatingTime). The
 * strip doesn't follow the filter bar (MS Project's Timeline doesn't).
 * A click on a task selects it in the sheet and scrolls it into view (Go
 * to task), a double-click opens Task Information; a hover shows the
 * Gantt's hover card.
 */
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { Plan, PlanTask } from '../../lib/plans/api';
import { formatDay, formatDayRange, formatShortDay, fromMs, lastDay, toMs } from '../../lib/plans/floatingTime';
import { MS_PER_DAY } from '../../lib/plans/ganttGeometry';
import { GanttHover } from './GanttHoverCard';

/** Bars stack into at most this many lanes. */
const MAX_LANES = 3;
/** Past this share of the band a milestone's label sits left of its diamond. */
const FLIP_AT = 72;
/** Milestone labels that would run into each other take a second row. */
const MARK_ROWS = 2;
/** The least room between two labels on one row, in px. */
const MARK_GAP = 10;

/** Each milestone's label row: greedy by where the labels sit on screen, a
 *  label that would touch the one before it on a row going to the next row
 *  (with every row taken, the one whose last label ends first). */
function labelRows(spans: readonly { id: string; left: number; right: number }[]): Record<string, number> {
  const ends: number[] = [];
  const rows: Record<string, number> = {};
  for (const span of [...spans].sort((a, b) => a.left - b.left)) {
    let row = ends.findIndex((end) => end + MARK_GAP <= span.left);
    if (row < 0) row = ends.length < MARK_ROWS ? ends.length : ends.indexOf(Math.min(...ends));
    ends[row] = Math.max(ends[row] ?? span.right, span.right);
    rows[span.id] = row;
  }
  return rows;
}

export interface PlanTimelineStripProps {
  plan: Plan;
  /** The selected tasks' ids. */
  selected: ReadonlySet<string>;
  /** A click on a task (PlanTab: Go to task). */
  onSelect(id: string): void;
  /** A double-click (Task Information). */
  onOpenInfo(id: string): void;
  /** Its height in px as it changes, 0 once it goes (the panes under it share the rest). */
  onHeight?(px: number): void;
}

interface StripBar { task: PlanTask; left: number; width: number; lane: number }
interface StripMark { task: PlanTask; left: number }
interface StripLayout {
  bars: StripBar[];
  marks: StripMark[];
  /** Lanes the bars use (at least one, for the band's height). */
  lanes: number;
  /** The plan's now as a share of the band, or null off it. */
  today: number | null;
  /** The band's own span, for its end labels: its first day and the day its
   *  work ends (a timeline task outside the project widens it). */
  firstDay: string;
  endDay: string;
}

/** A share in percent, rounded so a style reads cleanly. */
const share = (n: number) => Math.round(n * 10_000) / 10_000;

/** Where everything on the strip goes (see the header). */
function stripLayout(plan: Pick<Plan, 'tasks' | 'project_start' | 'project_finish' | 'now'>): StripLayout {
  const on = plan.tasks.filter((t) => t.show_on_timeline && t.start && !Number.isNaN(toMs(t.start)));
  const startOf = (t: PlanTask) => toMs(t.start as string);
  const finishOf = (t: PlanTask) => {
    const f = t.finish ? toMs(t.finish) : Number.NaN;
    return f > startOf(t) ? f : startOf(t);
  };
  let from = toMs(plan.project_start);
  let to = plan.project_finish ? toMs(plan.project_finish) : from;
  for (const t of on) {
    from = Math.min(from, startOf(t));
    to = Math.max(to, finishOf(t));
  }
  const firstDay = fromMs(from);
  const endDay = lastDay(firstDay, fromMs(to));
  if (!(to > from)) to = from + MS_PER_DAY;
  const at = (ms: number) => share(((ms - from) / (to - from)) * 100);

  const marks = on.filter((t) => t.is_milestone).map((task) => ({ task, left: at(startOf(task)) }));
  // earliest first, the longer of two that start together first
  const runs = on.filter((t) => !t.is_milestone)
    .map((task, order) => ({ task, order, s: startOf(task), f: finishOf(task) }))
    .sort((a, b) => a.s - b.s || (b.f - b.s) - (a.f - a.s) || a.order - b.order);
  const ends: number[] = [];
  const bars: StripBar[] = [];
  for (const run of runs) {
    let lane = ends.findIndex((end) => end <= run.s);
    if (lane < 0 && ends.length < MAX_LANES) lane = ends.length;
    // every lane taken: the one that frees up first
    if (lane < 0) lane = ends.indexOf(Math.min(...ends));
    ends[lane] = Math.max(ends[lane] ?? run.f, run.f);
    bars.push({ task: run.task, left: at(run.s), width: share(at(run.f) - at(run.s)), lane });
  }
  const now = toMs(plan.now);
  const today = now >= from && now <= to ? at(now) : null;
  return { bars, marks, lanes: Math.max(1, ends.length), today, firstDay, endDay };
}

export default function PlanTimelineStrip({ plan, selected, onSelect, onOpenInfo, onHeight }: PlanTimelineStripProps) {
  const { tasks, project_start: start, project_finish: finish, now } = plan;
  const layout = useMemo(() => stripLayout({ tasks, project_start: start, project_finish: finish, now }),
    [tasks, start, finish, now]);
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const bandRef = useRef<HTMLDivElement>(null);
  const marksRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLElement>(null);
  const tellHeight = useRef(onHeight);
  useLayoutEffect(() => {
    tellHeight.current = onHeight;
  });
  // its height for the panes under it: now, as it changes, and 0 when it goes
  useLayoutEffect(() => {
    const el = stripRef.current;
    if (!el) return undefined;
    const tell = () => tellHeight.current?.(el.offsetHeight);
    tell();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(tell);
    observer?.observe(el);
    return () => {
      observer?.disconnect();
      tellHeight.current?.(0);
    };
  }, []);
  const noScroll = useRef<HTMLElement>(null);
  const empty = !layout.bars.length && !layout.marks.length;

  // the milestones' label rows, from where their labels sit (measured: a
  // label's width is its text's); again whenever the band changes width
  const [rows, setRows] = useState<Record<string, number>>({});
  const markKey = layout.marks.map((m) => `${m.task.id}:${m.left}:${m.task.name}`).join('|');
  useLayoutEffect(() => {
    const box = marksRef.current;
    if (!box) return undefined;
    const place = () => {
      const spans = [...box.querySelectorAll<HTMLElement>('.pln-strip-mark')].map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.getAttribute('data-task-id') ?? '', left: r.left, right: r.right };
      });
      const next = labelRows(spans);
      setRows((now) => (JSON.stringify(now) === JSON.stringify(next) ? now : next));
    };
    place();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(place);
    observer.observe(box);
    return () => observer.disconnect();
  }, [markKey]);
  const markRows = layout.marks.length ? Math.max(1, ...layout.marks.map((m) => (rows[m.task.id] ?? 0) + 1)) : 0;

  const handlers = (task: PlanTask) => ({
    onClick: () => onSelect(task.id),
    onDoubleClick: () => onOpenInfo(task.id),
  });

  return (
    <section className="pln-strip" aria-label="Timeline" data-lanes={layout.lanes} ref={stripRef}>
      <div className="pln-strip-end">
        <span className="pln-strip-cap">Start</span>
        <span className="pln-strip-date">{formatDay(layout.firstDay)}</span>
      </div>

      <div className="pln-strip-band" ref={bandRef}
           style={{ '--lanes': layout.lanes, '--marks': markRows } as CSSProperties}>
        {layout.marks.length > 0 && (
          <div className="pln-strip-marks" ref={marksRef}>
            {layout.marks.map(({ task, left }) => {
              const on = selected.has(task.id);
              return (
                <button key={task.id} type="button" data-task-id={task.id} aria-pressed={on}
                        className={`pln-strip-mark${left > FLIP_AT ? ' flip' : ''}${on ? ' on' : ''}`}
                        style={{
                          left: `${left}%`, '--row': rows[task.id] ?? 0, '--pln-task': task.color ?? undefined,
                        } as CSSProperties}
                        {...handlers(task)}>
                  <span className={`pln-strip-diamond${task.color ? ' pln-tinted' : ''}`} aria-hidden="true" />
                  <span className="pln-strip-label">{task.name || 'Untitled task'}</span>
                  <span className="pln-strip-mdate">{formatShortDay(task.start)}</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="pln-strip-track">
          {layout.bars.map(({ task, left, width, lane }) => {
            const on = selected.has(task.id);
            const name = task.name || 'Untitled task';
            return (
              <button key={task.id} type="button" data-task-id={task.id} data-lane={lane} aria-pressed={on}
                      aria-label={`${name}, ${formatDayRange(task.start, lastDay(task.start as string, task.finish))}`}
                      className={`chip custom pln-strip-bar${on ? ' on' : ''}`}
                      style={{
                        left: `${left}%`, width: `${width}%`, '--lane': lane,
                        '--chip': task.color ?? 'var(--accent)',
                      } as CSSProperties}
                      {...handlers(task)}>
                <span className="pln-strip-name">{name}</span>
              </button>
            );
          })}
          {empty && (
            <p className="pln-strip-empty">
              {plan.permissions.change
                ? 'Add tasks to the timeline with Properties › Add to Timeline.'
                : 'No tasks on the timeline yet.'}
            </p>
          )}
        </div>

        {layout.today !== null && (
          <div className="pln-strip-today" style={{ left: `${layout.today}%` }} aria-hidden="true" />
        )}
      </div>

      <div className="pln-strip-end pln-strip-finish">
        <span className="pln-strip-cap">Finish</span>
        <span className="pln-strip-date">{formatDay(layout.endDay)}</span>
      </div>

      <GanttHover chartRef={bandRef} scrollRef={noScroll} barRef={noScroll} tasksById={tasksById} plan={plan} />
    </section>
  );
}
