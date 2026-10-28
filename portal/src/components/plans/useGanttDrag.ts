/**
 * The Gantt chart's drags (Task 9): the pointer state machine behind a
 * press on a bar, a milestone's diamond, a summary's bracket or a link
 * handle. lib/plans/drag says what the press means and what letting go
 * sends; this follows the pointer, shows the ghost and tooltip (through a
 * small store, so the chart itself never redraws while a drag moves), and
 * sends the ops through the PlanController.
 *
 * - A press: `dragKind` of where it landed on the bar. What the plan allows
 *   (`dragAccess`): everything on an open plan the person may change; only
 *   progress on a locked one; nothing on a read-only one. A summary only
 *   links (its dates and progress come from its subtasks). A press that
 *   isn't allowed is left alone, so it is a press on the lane: it selects
 *   the row.
 * - An allowed press is taken (default prevented, so no text selection and
 *   no lane press) and the pointer captured on the element pressed, with
 *   `pointercancel` and `lostpointercapture` ending the drag unsent. Until
 *   it moves DRAG_THRESHOLD_PX it is a click: letting go selects the task.
 * - Once it is a drag it holds editing (`beginEditing('gantt-drag')`), so a
 *   refresh that finds someone else's change waits. Letting go sends the
 *   ops FIRST and lets go of the hold after: the refresh that waited is then
 *   queued behind the drag's write, never ahead of it (which would drop the
 *   write as made against a plan that is gone), the sheet editor's rule.
 *   Esc cancels: nothing is sent and the hold goes. A release outside the
 *   window still commits (the capture brings it).
 * - A release that may never come ends the drag unsent, hold let go: the
 *   window losing focus, the page going hidden, a mouse move with no button
 *   down. So does a press the plan no longer matches (its task gone, on
 *   another row, its bar moved: a refresh between the press and the drag),
 *   and a new scale (a zoom).
 * - A task that has started isn't moved (`moveRefusal`): crossing the
 *   threshold says "This task has started — change its Actual Start
 *   instead." and holds and sends nothing. Its other drags still work.
 * - Snaps (`snapShift`): the move snaps by the zoom's step (whole days at
 *   weeks and coarser, the hour at days, 15 minutes at hours), so a task
 *   keeps its clock time and a drop back at its origin sends nothing.
 * - The pointer's place on the scale is its x in the chart pane plus the
 *   pane's sideways scroll (the content moves by a transform), so a drag
 *   reads the same at any scroll.
 * - What letting go answers is said as everywhere else (useApplyAnswer): a
 *   constraint the move added as a toast with Undo, a completion the rules
 *   stopped to the completion check, a refusal (a link cycle, naming its
 *   tasks' IDs) as a toast.
 */
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

import { useToast } from '../../lib/notificationsContext';
import type { Op, Plan, PlanTask } from '../../lib/plans/api';
import {
  DRAG_THRESHOLD_PX, DROP_SLOP_PX, LINK_DOT_PX, barEnd, canLink, dragKind, moveRefusal, opsForDrag, pointerScaleX,
  snapShift, type DragKind,
} from '../../lib/plans/drag';
import { formatDuration } from '../../lib/plans/durations';
import { formatDay, formatDayTime, fromMs, toMs } from '../../lib/plans/floatingTime';
import {
  MILESTONE_HALF, barOf, msOf, progressWidth, widthOfMs, xOfMs, type Bar, type Scale, type Zoom,
} from '../../lib/plans/ganttGeometry';
import type { BarBox, Fact } from '../../lib/plans/ganttView';
import { planUnits } from '../../lib/plans/merge';
import { useApplyAnswer } from './useCompletion';
import type { PlanController } from './usePlan';

/** What the chart's drags may do here. */
export type DragAccess = 'full' | 'progress' | 'none';

/** Everything while the plan can be changed; only progress while its
 *  schedule is locked; nothing for someone who may only read it. */
export function dragAccess(plan: Pick<Plan, 'permissions' | 'locked_at'> | null): DragAccess {
  if (!plan?.permissions.change) return 'none';
  return plan.locked_at ? 'progress' : 'full';
}

/** Whether a press of `kind` on `task` starts a drag. */
export function canDrag(kind: DragKind, task: Pick<PlanTask, 'is_summary' | 'is_milestone'>, access: DragAccess): boolean {
  if (access === 'none') return false;
  if (access === 'progress') return kind === 'progress' && !task.is_summary && !task.is_milestone;
  return !task.is_summary || kind === 'link';
}

/** What a live drag shows: the ghost, the link's band, the tooltip. Bars are
 *  in scale px, rows by index (the chart's y is row × row height). */
export interface DragPreview {
  kind: DragKind;
  /** The dragged task's row. */
  row: number;
  milestone: boolean;
  /** move, resize: where the bar would go. progress: the bar itself. */
  ghost: Bar | null;
  /** progress: the part of `ghost` done once let go. */
  done: number | null;
  /** link: from the handle to the pointer (x on the scale, y in the chart). */
  band: { x0: number; y0: number; x1: number; y1: number } | null;
  /** link: the bar it would link to. */
  target: { row: number; bar: Bar; milestone: boolean } | null;
  title: string;
  facts: Fact[];
  /** The pointer in the viewport (where the tooltip goes). */
  clientX: number;
  clientY: number;
}

/** The live preview, read by the chart's drag layer (useSyncExternalStore). */
export interface DragStore {
  get(): DragPreview | null;
  subscribe(listener: () => void): () => void;
}

interface Store extends DragStore {
  set(next: DragPreview | null): void;
}

function makeStore(): Store {
  let value: DragPreview | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    set: (next) => {
      value = next;
      listeners.forEach((listener) => listener());
    },
  };
}

/** The captured element's cursor for the drag's length. */
const CURSOR: Record<DragKind, string> = {
  move: 'move', resize: 'ew-resize', progress: 'col-resize', link: 'crosshair',
};

export const HOLD_OWNER = 'gantt-drag';

type Mods = Pick<PointerEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>;

interface Options {
  ctl: PlanController;
  scale: Scale | null;
  zoom: Zoom;
  /** The task ids shown, in order (the sheet's rows). */
  rows: readonly string[];
  rowHeight: number;
  box: BarBox;
  tasksById: ReadonlyMap<string, PlanTask>;
  /** The chart body: rows are measured from its top. */
  chartRef: RefObject<HTMLElement | null>;
  /** The chart's sideways scrollbar: its scrollLeft is the chart's scroll. */
  barRef: RefObject<HTMLElement | null>;
  /** A press too short to be a drag selects its task, as a lane press does. */
  select(id: string, mods: Mods): void;
}

export interface GanttDrag {
  access: DragAccess;
  /** For every bar, diamond, summary bracket and link handle. */
  onBarPointerDown(e: ReactPointerEvent<HTMLElement>, task: PlanTask): void;
  store: DragStore;
}

interface Session {
  pointerId: number;
  el: HTMLElement;
  task: PlanTask;
  kind: DragKind;
  row: number;
  bar: Bar;
  downX: number;                // the press on the scale, px
  downClientX: number;
  downClientY: number;
  mods: Mods;
  live: boolean;
  release: (() => void) | null;
  ops: Op[];
  label: string;
  detach(): void;
}

const taskName = (t: PlanTask): string => t.name || 'Untitled task';

export function useGanttDrag(o: Options): GanttDrag {
  const answer = useApplyAnswer();
  const toast = useToast();
  const store = useMemo(makeStore, []);
  const latest = useRef({ ...o, answer, toast });
  useLayoutEffect(() => {
    latest.current = { ...o, answer, toast };
  });
  const session = useRef<Session | null>(null);

  /** The pointer's x on the scale: in from the chart pane's left edge, plus its sideways scroll. */
  const scaleX = useCallback((clientX: number): number => {
    const { chartRef, barRef } = latest.current;
    const pane = chartRef.current?.closest('.pln-pane') ?? null;
    return pointerScaleX(clientX, pane?.getBoundingClientRect().left ?? 0, barRef.current?.scrollLeft ?? 0);
  }, []);

  /** Ends the session: listeners off, capture and the hold let go, the preview gone. */
  const end = useCallback((s: Session) => {
    if (session.current !== s) return;
    session.current = null;
    s.detach();
    s.el.style.cursor = '';
    try {
      if (s.el.hasPointerCapture?.(s.pointerId)) s.el.releasePointerCapture(s.pointerId);
    } catch {
      // the capture went already
    }
    const release = s.release;
    s.release = null;
    release?.();
    store.set(null);
  }, [store]);

  /** The press no longer matches the plan on screen: its task is gone, on
   *  another row, or its bar has moved (someone else's change landed). */
  const stale = useCallback((s: Session): boolean => {
    const { scale, rows, tasksById } = latest.current;
    const now = tasksById.get(s.task.id);
    const bar = now && scale ? barOf(scale, now) : null;
    return !bar || rows[s.row] !== s.task.id || bar.x !== s.bar.x || bar.width !== s.bar.width;
  }, []);

  /** Where the pointer at (clientX, clientY) puts the drag: its ops, label and preview. */
  const follow = useCallback((s: Session, clientX: number, clientY: number) => {
    const { ctl, scale, zoom, rows, rowHeight, box, tasksById, chartRef } = latest.current;
    const plan = ctl.plan;
    if (!scale || !plan) return;
    const t = s.task;
    const x = scaleX(clientX);
    const moved = (x - s.downX) / scale.pxPerMs;
    const units = planUnits(plan);
    const fine = zoom === 'hours' || zoom === 'days';
    const when = (ms: number) => (fine ? formatDayTime(fromMs(ms)) : formatDay(fromMs(ms)));
    const preview: DragPreview = {
      kind: s.kind, row: s.row, milestone: t.is_milestone, ghost: null, done: null, band: null, target: null,
      title: taskName(t), facts: [], clientX, clientY,
    };

    if (s.kind === 'move') {
      const from = toMs(t.is_milestone ? (t.start ?? t.finish ?? '') : (t.start ?? ''));
      const at = snapShift(from, moved, zoom);
      s.ops = opsForDrag('move', t, at - from, units, plan.calendar);
      s.label = 'Move Task';
      preview.ghost = { x: xOfMs(scale, at), width: s.bar.width };
      preview.facts = [{ label: 'Start', value: when(at) }];
    } else if (s.kind === 'resize') {
      const start = toMs(t.start ?? '');
      const finish = toMs(t.finish ?? '');
      const to = Math.max(start, snapShift(finish, moved, zoom));
      s.ops = opsForDrag('resize', t, to - finish, units, plan.calendar);
      s.label = 'Edit Duration';
      const op = s.ops[0];
      const duration = op?.op === 'update_task' && op.fields.duration
        ? op.fields.duration
        : formatDuration(t.duration_minutes, t.duration_unit, t.elapsed, units);
      preview.ghost = { x: s.bar.x, width: widthOfMs(scale, to - start) };
      preview.facts = [{ label: 'Finish', value: when(to) }, { label: 'Duration', value: duration }];
    } else if (s.kind === 'progress') {
      const start = toMs(t.start ?? '');
      const span = toMs(t.finish ?? '') - start;
      const doneAt = start + (span * t.percent_complete) / 100;
      s.ops = opsForDrag('progress', t, msOf(scale, x) - doneAt, units, plan.calendar);
      const op = s.ops[0];
      const percent = op?.op === 'set_percent' ? op.percent : t.percent_complete;
      s.label = `${percent}% Complete`;
      preview.ghost = s.bar;
      preview.done = progressWidth(s.bar, percent);
      preview.facts = [{ label: '% Complete', value: `${percent}%` }];
    } else {
      // the bar under the pointer: its row by y, and on (or just beside) it by x
      const y = clientY - (chartRef.current?.getBoundingClientRect().top ?? 0);
      const row = Math.floor(y / rowHeight);
      const onto = rows[row] === undefined ? undefined : tasksById.get(rows[row]);
      const ontoBar = onto ? barOf(scale, onto) : null;
      let target: PlanTask | null = null;
      if (onto && ontoBar) {
        const lo = ontoBar.x - (onto.is_milestone ? MILESTONE_HALF : 0) - DROP_SLOP_PX;
        const hi = barEnd({ ...ontoBar, milestone: onto.is_milestone }) + DROP_SLOP_PX;
        if (x >= lo && x <= hi && canLink(plan, t.id, onto.id)) target = onto;
      }
      s.ops = target ? opsForDrag('link', t, target.id, units, plan.calendar) : [];
      s.label = 'Link Tasks';
      preview.band = {
        x0: barEnd({ ...s.bar, milestone: t.is_milestone }) + LINK_DOT_PX / 2, y0: s.row * rowHeight + box.mid,
        x1: x, y1: y,
      };
      preview.target = target && ontoBar ? { row, bar: ontoBar, milestone: target.is_milestone } : null;
      preview.title = 'Finish-to-Start Link';
      preview.facts = [
        { label: 'From', value: taskName(t) },
        { label: 'To', value: target ? taskName(target) : '—' },
      ];
    }
    store.set(preview);
  }, [scaleX, store]);

  /** Letting go of a drag: send, THEN let go of the hold (see the header). */
  const commit = useCallback((s: Session) => {
    const { ctl } = latest.current;
    const ops = s.ops;
    const label = s.label;
    const sent = ops.length ? ctl.apply(ops, label) : null;
    end(s);
    if (sent) void sent.then((result) => { latest.current.answer(result, ops, label); });
  }, [end]);

  const onBarPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>, task: PlanTask) => {
    if (e.button !== 0 || session.current) return;
    const { ctl, scale, rows } = latest.current;
    const plan = ctl.plan;
    const access = dragAccess(plan);
    if (!plan || !scale || access === 'none') return;
    const bar = barOf(scale, task);
    const row = rows.indexOf(task.id);
    if (!bar || row < 0) return;
    const downX = scaleX(e.clientX);
    const kind = dragKind(downX, {
      ...bar, done: progressWidth(bar, task.percent_complete), milestone: task.is_milestone,
    }, access === 'progress');
    if (!canDrag(kind, task, access)) return;      // left to the lane: it selects the row
    e.preventDefault();
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // no capture (an inactive pointer id): the window listeners still follow it
    }
    el.style.cursor = CURSOR[kind];

    const onMove = (ev: PointerEvent) => {
      const s = session.current;
      if (!s || ev.pointerId !== s.pointerId) return;
      // a mouse let go where we never heard it (outside the window, an alert
      // took it): nothing to commit, the drag just ends
      if (ev.pointerType === 'mouse' && ev.buttons === 0) {
        end(s);
        return;
      }
      // the plan changed under the press (a refresh before the hold): the
      // bar isn't where it was pressed any more
      if (stale(s)) {
        end(s);
        return;
      }
      if (!s.live) {
        if (Math.hypot(ev.clientX - s.downClientX, ev.clientY - s.downClientY) < DRAG_THRESHOLD_PX) return;
        // the task as it is now: a refresh since the press may have started it
        const refused = s.kind === 'move' ? moveRefusal(latest.current.tasksById.get(s.task.id) ?? s.task) : null;
        if (refused) {
          end(s);
          latest.current.toast(refused);
          return;
        }
        s.live = true;
        s.release = latest.current.ctl.beginEditing(HOLD_OWNER);
      }
      follow(s, ev.clientX, ev.clientY);
    };
    const onUp = (ev: PointerEvent) => {
      const s = session.current;
      if (!s || ev.pointerId !== s.pointerId) return;
      if (!s.live) {
        end(s);
        latest.current.select(s.task.id, s.mods);   // a click
        return;
      }
      if (stale(s)) {
        end(s);
        return;
      }
      follow(s, ev.clientX, ev.clientY);
      commit(s);
    };
    const onCancel = (ev: PointerEvent) => {
      const s = session.current;
      if (s && ev.pointerId === s.pointerId) end(s);
    };
    const onKey = (ev: KeyboardEvent) => {
      const s = session.current;
      if (!s || ev.key !== 'Escape') return;
      // the drag's Escape: not full screen's, a dialog's or the sheet's
      ev.preventDefault();
      ev.stopPropagation();
      end(s);
    };
    // the window lost focus or the page went out of sight mid-drag: its
    // release may never come, so it ends unsent and lets go of the hold
    const onLeave = () => {
      const s = session.current;
      if (s) end(s);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onLeave();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('lostpointercapture', onCancel);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onLeave);
    document.addEventListener('visibilitychange', onVisibility);

    session.current = {
      pointerId: e.pointerId, el, task, kind, row, bar, downX,
      downClientX: e.clientX, downClientY: e.clientY,
      mods: { shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey },
      live: false, release: null, ops: [], label: '',
      detach: () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('lostpointercapture', onCancel);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', onLeave);
        document.removeEventListener('visibilitychange', onVisibility);
      },
    };
  }, [commit, end, follow, scaleX, stale]);

  // a new scale mid-drag (a zoom, the plan's span changed under it): the
  // press was read on the old one, so the drag is called off unsent
  const { scale } = o;
  useEffect(() => {
    const s = session.current;
    if (s) end(s);
  }, [scale, end]);

  // the chart goes away mid-drag (another initiative, the plan deleted)
  useEffect(() => () => {
    const s = session.current;
    if (s) end(s);
  }, [end]);

  return useMemo(() => ({ access: dragAccess(o.ctl.plan), onBarPointerDown, store }),
    [o.ctl.plan, onBarPointerDown, store]);
}
