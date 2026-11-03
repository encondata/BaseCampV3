/**
 * Rows drag-reorder by the ID cell (spec "The task sheet"): the pointer
 * state machine behind a press on a row's ID. lib/plans/moveTasks says
 * what moves and where a drop lands; the sheet draws the drop line at
 * `gap`; the tab's commands send the move (usePlanCommands `moveTasks`:
 * one `move_tasks` batch, one undo step). The Gantt follows by itself: it
 * draws the same rows.
 *
 * - A press on an ID cell with no modifier key (Shift and Ctrl/⌘ pick
 *   rows) starts a press, its pointer captured on the cell, the Gantt
 *   drag's way. Until it moves DRAG_THRESHOLD_PX it is a click: the sheet
 *   selects the row on mousedown as it always has — except a row that is
 *   one of several selected, whose click selects it alone on release, so
 *   a drag of the selection can start from it (`keepsSelection`).
 * - Once it is a drag: the row and its subtasks move, or, when the row is
 *   selected, every selected task (the top-most ones: subtasks go with
 *   their summary). It holds editing (`beginEditing('row-drag')`), so a
 *   refresh that finds someone else's change waits; letting go sends the
 *   move FIRST and lets go of the hold after (the sheet editor's rule).
 * - The drop line shows between rows where a drop would land (dropGap /
 *   dropPlace / moveOp): not inside what moves, not above a context row,
 *   not where the tasks already are. Below the last row is the end of the
 *   plan. Near the scroller's top (under the sticky header) or bottom
 *   edge the sheet scrolls, faster the closer the pointer.
 * - Esc calls it off, as do a lost capture, the window losing focus and
 *   the page going hidden: nothing is sent and the hold goes.
 * - Off (`on` false: no grab cursor) while the plan is locked or grouped,
 *   and for someone who may not change it. Locked or grouped, a press
 *   that becomes a drag says why ("Schedule is locked", the grouped note)
 *   and does nothing else; read-only, it is only ever a click.
 */
import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';

import { useToast } from '../../lib/notificationsContext';
import { SHEET_HEAD_PX } from '../../lib/plans/columns';
import { OFF_NOTES } from '../../lib/plans/commandTips';
import { DRAG_THRESHOLD_PX } from '../../lib/plans/drag';
import { PLAN_ERRORS } from '../../lib/plans/errors';
import { dropGap, dropPlace, moveOp, moveTops, type MovePlace } from '../../lib/plans/moveTasks';
import { selectCell, type Selection } from '../../lib/plans/selection';
import type { PlanController } from './usePlan';

export const ROW_DRAG_OWNER = 'row-drag';
/** How close to the scroller's top or bottom edge a drag scrolls it, px. */
export const EDGE_PX = 32;
/** How often an edge scroll steps, ms. */
const EDGE_TICK_MS = 30;

type Access = 'full' | 'locked' | 'grouped' | 'none';

interface Options {
  ctl: PlanController;
  /** The rows shown, in order, by key (task ids: the drag is off while grouped). */
  rows: readonly string[];
  /** A filter's context rows: never a drop place. */
  context: ReadonlySet<string>;
  /** The sheet is grouped (Group by): the outline can't change. */
  grouped: boolean;
  rowHeight: number;
  selection: Selection;
  onSelect(sel: Selection): void;
  /** The scroll box the rows scroll in (it scrolls near its edges). */
  scrollRef: RefObject<HTMLElement | null>;
  /** The rows' box: a drop's y is measured from its top. */
  bodyRef: RefObject<HTMLElement | null>;
  /** Sends the move (the tab's commands); without it there is no drag. */
  onMove?(ids: string[], place: MovePlace): void;
}

export interface RowDrag {
  /** ID cells take a drag here (the grab cursor). */
  on: boolean;
  /** The gap the drop line marks while a drag is over a place it can land. */
  gap: number | null;
  /** For each row's ID cell. */
  onIdPointerDown(e: ReactPointerEvent<HTMLElement>, key: string): void;
  /** A mousedown on `key`'s ID: true when the selection stays as it is
   *  for now (the row is one of several selected; a click selects it on
   *  release). */
  keepsSelection(key: string): boolean;
}

interface Press {
  pointerId: number;
  el: HTMLElement;
  key: string;
  access: Access;
  downX: number;
  downY: number;
  lastY: number;
  live: boolean;
  /** A click on this row, once let go, selects it alone. */
  selectOnRelease: boolean;
  tops: string[];
  place: MovePlace | null;
  release: (() => void) | null;
  timer: number | null;
  speed: number;
  detach(): void;
}

function accessOf(plan: PlanController['plan'], grouped: boolean): Access {
  if (!plan?.permissions.change) return 'none';
  if (plan.locked_at) return 'locked';
  return grouped ? 'grouped' : 'full';
}

/** A scroll step for a pointer this far into an edge zone, px a tick. */
const edgeStep = (depth: number, rowHeight: number) =>
  Math.ceil((Math.min(depth, EDGE_PX) / EDGE_PX) * (rowHeight / 2));

export function useRowDrag(o: Options): RowDrag {
  const toast = useToast();
  const latest = useRef({ ...o, toast });
  useLayoutEffect(() => {
    latest.current = { ...o, toast };
  });
  const press = useRef<Press | null>(null);
  const [gap, setGap] = useState<number | null>(null);

  const stopScroll = (p: Press) => {
    if (p.timer !== null) window.clearInterval(p.timer);
    p.timer = null;
    p.speed = 0;
  };

  /** Ends the press: listeners off, capture and the hold let go, the line gone. */
  const end = useCallback((p: Press) => {
    if (press.current !== p) return;
    press.current = null;
    p.detach();
    stopScroll(p);
    p.el.style.cursor = '';
    try {
      if (p.el.hasPointerCapture?.(p.pointerId)) p.el.releasePointerCapture(p.pointerId);
    } catch {
      // the capture went already
    }
    const release = p.release;
    p.release = null;
    release?.();
    setGap(null);
  }, []);

  /** Where the pointer at `clientY` puts the drop: the line, and the place it sends. */
  const follow = useCallback((p: Press, clientY: number) => {
    const { ctl, rows, context, rowHeight, bodyRef } = latest.current;
    const plan = ctl.plan;
    p.lastY = clientY;
    if (!plan) return;
    const top = bodyRef.current?.getBoundingClientRect().top ?? 0;
    const at = dropGap(clientY - top, rowHeight, rows.length);
    const place = dropPlace(at, rows, (key) => context.has(key));
    const op = place ? moveOp(plan, p.tops, place) : null;
    p.place = op && op !== 'inside' ? place : null;
    setGap(p.place ? at : null);
  }, []);

  /** Near the scroller's top (under the sticky header) or bottom edge, the
   *  sheet scrolls while the pointer stays there, and the drop follows. */
  const edgeScroll = useCallback((p: Press, clientY: number) => {
    const { scrollRef, rowHeight } = latest.current;
    const box = scrollRef.current;
    if (!box) return;
    const rect = box.getBoundingClientRect();
    const high = rect.top + SHEET_HEAD_PX + EDGE_PX - clientY;
    const low = clientY - (rect.bottom - EDGE_PX);
    p.speed = high > 0 ? -edgeStep(high, rowHeight) : low > 0 ? edgeStep(low, rowHeight) : 0;
    if (!p.speed) {
      stopScroll(p);
      return;
    }
    if (p.timer !== null) return;
    p.timer = window.setInterval(() => {
      const el = latest.current.scrollRef.current;
      if (press.current !== p || !el || !p.speed) {
        stopScroll(p);
        return;
      }
      const before = el.scrollTop;
      el.scrollTop = Math.max(0, before + p.speed);
      if (el.scrollTop !== before) follow(p, p.lastY);
    }, EDGE_TICK_MS);
  }, [follow]);

  const onIdPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>, key: string) => {
    if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey || press.current) return;
    const { ctl, grouped, onMove, rows } = latest.current;
    const access = onMove ? accessOf(ctl.plan, grouped) : 'none';
    if (access === 'none' || !rows.includes(key)) return;
    // not prevented: the mousedown that follows still selects the row and focuses the sheet
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // no capture (an inactive pointer id): the window listeners still follow it
    }

    const onMoveEvent = (ev: PointerEvent) => {
      const p = press.current;
      if (!p || ev.pointerId !== p.pointerId) return;
      // a mouse let go where we never heard it: nothing to commit
      if (ev.pointerType === 'mouse' && ev.buttons === 0) {
        end(p);
        return;
      }
      if (!p.live) {
        if (Math.hypot(ev.clientX - p.downX, ev.clientY - p.downY) < DRAG_THRESHOLD_PX) return;
        p.selectOnRelease = false;
        if (p.access !== 'full') {
          end(p);
          latest.current.toast(p.access === 'locked' ? PLAN_ERRORS.plan_locked : `${OFF_NOTES.grouped}.`);
          return;
        }
        // what moves: the selection when the row is in it, else the row (both as they are now)
        const now = latest.current;
        const plan = now.ctl.plan;
        if (!plan || !now.rows.includes(p.key)) {
          end(p);
          return;
        }
        p.tops = moveTops(now.selection.rows.has(p.key) ? now.selection.rows : [p.key], plan);
        p.live = true;
        p.release = now.ctl.beginEditing(ROW_DRAG_OWNER);
        p.el.style.cursor = 'grabbing';
      }
      follow(p, ev.clientY);
      edgeScroll(p, ev.clientY);
    };
    const onUp = (ev: PointerEvent) => {
      const p = press.current;
      if (!p || ev.pointerId !== p.pointerId) return;
      if (!p.live) {
        end(p);
        // a click on one row of several picked: that row alone
        if (p.selectOnRelease) latest.current.onSelect(selectCell(p.key, 'id'));
        return;
      }
      follow(p, ev.clientY);
      const { tops, place } = p;
      // send first, then let go of the hold (see the header)
      if (place) latest.current.onMove?.(tops, place);
      end(p);
    };
    const onCancel = (ev: PointerEvent) => {
      const p = press.current;
      if (p && ev.pointerId === p.pointerId) end(p);
    };
    const onKey = (ev: KeyboardEvent) => {
      const p = press.current;
      if (!p || ev.key !== 'Escape') return;
      // the drag's Escape: not full screen's, a dialog's or the sheet's
      ev.preventDefault();
      ev.stopPropagation();
      end(p);
    };
    const onLeave = () => {
      const p = press.current;
      if (p) end(p);
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') onLeave();
    };
    window.addEventListener('pointermove', onMoveEvent);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('lostpointercapture', onCancel);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onLeave);
    document.addEventListener('visibilitychange', onVisibility);

    press.current = {
      pointerId: e.pointerId, el, key, access, downX: e.clientX, downY: e.clientY, lastY: e.clientY,
      live: false, selectOnRelease: false, tops: [], place: null, release: null, timer: null, speed: 0,
      detach: () => {
        window.removeEventListener('pointermove', onMoveEvent);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('pointercancel', onCancel);
        window.removeEventListener('lostpointercapture', onCancel);
        window.removeEventListener('keydown', onKey, true);
        window.removeEventListener('blur', onLeave);
        document.removeEventListener('visibilitychange', onVisibility);
      },
    };
  }, [end, follow, edgeScroll]);

  const keepsSelection = useCallback((key: string): boolean => {
    const p = press.current;
    const { selection } = latest.current;
    if (!p || p.key !== key || p.live || p.access !== 'full') return false;
    if (!selection.rows.has(key) || selection.rows.size < 2) return false;
    p.selectOnRelease = true;
    return true;
  }, []);

  // the sheet goes away mid-drag (another initiative, the plan deleted)
  useEffect(() => () => {
    const p = press.current;
    if (p) end(p);
  }, [end]);

  const on = accessOf(o.ctl.plan, o.grouped) === 'full' && !!o.onMove;
  return useMemo(() => ({ on, gap, onIdPointerDown, keepsSelection }), [on, gap, onIdPointerDown, keepsSelection]);
}
