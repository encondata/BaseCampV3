/**
 * The Gantt's hover card: what a bar stands for, without opening anything —
 * the task's name, then Start, Finish, Duration (in the plan's units),
 * % Complete, Resource Names, Deadline and Total Slack (lib/plans/ganttView
 * `hoverFacts`).
 *
 * The mechanics are InitiativeHoverCard's: a 180 ms intent delay, a
 * position:fixed card that follows the pointer (below and right of it,
 * flipped near a viewport edge: its `cardPosition`), portaled so the pane's
 * clipping can't cut it, and `pointer-events: none` so it never takes the
 * hover that opened it. It is `aria-hidden`, like the chart it describes:
 * the sheet carries the same facts.
 *
 * `GanttHover` holds the hover state itself and listens on the chart body
 * (one delegated listener: the bar under the pointer is the nearest
 * `[data-task-id]`), so a card that appears or follows the pointer redraws
 * only itself, never the chart. Scrolling the view, or the chart sideways,
 * hides it (the bar has moved from under the pointer), and so does a press
 * (a drag shows its own tooltip, GanttDragTip). Class prefix `pln-hover`.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';

import type { Plan, PlanTask } from '../../lib/plans/api';
import { hoverFacts, type Fact } from '../../lib/plans/ganttView';
import { cardPosition } from '../initiatives/InitiativeHoverCard';

const HOVER_DELAY_MS = 180;

type HoverPlan = Pick<Plan, 'calendar' | 'settings'>;

/** A dark fact card at `left`/`top` in the viewport: a title over label /
 *  value lines. Portaled under the shell, so it sits above full screen and
 *  keeps the theme's tokens; it never takes the pointer. */
function FactCard({ title, facts, left, top, className = '', cardRef }: {
  title: string;
  facts: readonly Fact[];
  left: number;
  top: number;
  className?: string;
  cardRef?: RefObject<HTMLDivElement>;
}) {
  const host = document.querySelector('.portal-shell') ?? document.body;
  return createPortal(
    <div className={`pln-hover${className ? ` ${className}` : ''}`} aria-hidden="true" style={{ left, top }}
         ref={cardRef}>
      <span className="pln-hover-name">{title}</span>
      <dl className="pln-hover-facts">
        {facts.map((fact) => (
          <div key={fact.label} className="pln-hover-fact">
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </div>,
    host,
  );
}

/** The card itself, at `left`/`top` in the viewport. */
export default function GanttHoverCard({ task, plan, left, top }: {
  task: PlanTask;
  plan: HoverPlan;
  left: number;
  top: number;
}) {
  return <FactCard title={task.name || 'Untitled task'} facts={hoverFacts(task, plan)} left={left} top={top} />;
}

/** A drag's tooltip (useGanttDrag): what letting go would set — the new
 *  Start, Finish and Duration, % Complete, or the link — beside the
 *  pointer at `x`/`y`, placed like the hover card but by its measured size,
 *  so near the right edge it flips to sit right beside the pointer. */
export function GanttDragTip({ title, facts, x, y }: { title: string; facts: readonly Fact[]; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !el.offsetWidth) return;
    if (size?.w !== el.offsetWidth || size.h !== el.offsetHeight) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  });
  const { left, top } = cardPosition(x, y, window.innerWidth, window.innerHeight, size?.w, size?.h);
  return <FactCard className="pln-drag-tip" title={title} facts={facts} left={left} top={top} cardRef={ref} />;
}

/**
 * The chart's hover, as a component of its own: listens on `chartRef` (the
 * chart body), hides on a scroll of `scrollRef` (the view) or `barRef` (the
 * chart's sideways scrollbar), and renders only the card.
 */
export function GanttHover({ chartRef, scrollRef, barRef, tasksById, plan }: {
  chartRef: RefObject<HTMLElement | null>;
  scrollRef: RefObject<HTMLElement | null>;
  barRef: RefObject<HTMLElement | null>;
  tasksById: ReadonlyMap<string, PlanTask>;
  plan: HoverPlan | null;
}) {
  const timer = useRef<number | null>(null);
  const frame = useRef<number | null>(null);
  // the latest pointer, kept out of state: only the visible card redraws for it
  const cursor = useRef({ x: 0, y: 0 });
  const under = useRef<string | null>(null);
  const [shown, setShown] = useState<{ id: string; left: number; top: number } | null>(null);
  const shownRef = useRef(false);

  const stop = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    timer.current = null;
    frame.current = null;
  }, []);

  const show = useCallback((id: string) => {
    const { x, y } = cursor.current;
    shownRef.current = true;
    setShown({ id, ...cardPosition(x, y, window.innerWidth, window.innerHeight) });
  }, []);

  const hide = useCallback(() => {
    stop();
    under.current = null;
    if (shownRef.current) {
      shownRef.current = false;
      setShown(null);
    }
  }, [stop]);

  useEffect(() => {
    const chart = chartRef.current;
    const box = scrollRef.current;
    const bar = barRef.current;
    const onMove = (e: MouseEvent) => {
      cursor.current = { x: e.clientX, y: e.clientY };
      const target = e.target as Element | null;
      const id = target?.closest?.('[data-task-id]')?.getAttribute('data-task-id') ?? null;
      if (id !== under.current) {
        hide();
        under.current = id;
        if (id) timer.current = window.setTimeout(() => show(id), HOVER_DELAY_MS);
        return;
      }
      // the card is up: it follows the pointer along the bar, once a frame
      if (id && shownRef.current && frame.current === null) {
        frame.current = requestAnimationFrame(() => {
          frame.current = null;
          show(id);
        });
      }
    };
    chart?.addEventListener('mousemove', onMove);
    chart?.addEventListener('mouseleave', hide);
    chart?.addEventListener('pointerdown', hide);
    box?.addEventListener('scroll', hide, { passive: true });
    bar?.addEventListener('scroll', hide, { passive: true });
    return () => {
      chart?.removeEventListener('mousemove', onMove);
      chart?.removeEventListener('mouseleave', hide);
      chart?.removeEventListener('pointerdown', hide);
      box?.removeEventListener('scroll', hide);
      bar?.removeEventListener('scroll', hide);
      stop();
    };
  }, [chartRef, scrollRef, barRef, hide, show, stop]);

  const task = shown ? tasksById.get(shown.id) : undefined;
  return shown && task && plan ? <GanttHoverCard task={task} plan={plan} left={shown.left} top={shown.top} /> : null;
}
