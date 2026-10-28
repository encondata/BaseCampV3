// @vitest-environment jsdom
/**
 * The Gantt chart's interactions (Task 9): dragging a bar to move it,
 * its right end to resize it, its progress handle to set % Complete, and
 * its link handle onto another bar to link them; Esc, a canceled pointer
 * and a press too short to be a drag; what a locked or read-only plan
 * allows; and a link's Task Dependency dialog. The chart alone with a
 * stand-in controller for the gesture mechanics; the real PlanTab and
 * usePlan against a mocked lib/plans/api for what reaches the API.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { Plan, PlanTask } from '../../lib/plans/api';
import type { ApplyResult } from '../../lib/plans/applyResult';
import { makeScale, xOf, type Zoom } from '../../lib/plans/ganttGeometry';
import { scaleSpan, windowSpan } from '../../lib/plans/ganttView';
import { planView } from '../../lib/plans/merge';
import { makeLink, makeOpsResult, makePlan, makeRestore, makeTask } from '../../lib/plans/planFixtures';
import { EMPTY_SELECTION, selectCell, type Selection } from '../../lib/plans/selection';
import type { PlanController } from './usePlan';
import type { GanttDisplay } from './usePlanCommands';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string) => resource === 'project_plans',
    person: { id: 'p-me', display_name: 'Jimmy Henderson' },
    preferences: {},
  }),
}));

const api = vi.hoisted(() => ({
  getPlan: vi.fn(),
  createPlan: vi.fn(),
  deletePlan: vi.fn(),
  postOps: vi.fn(),
  patchPlan: vi.fn(),
  lockPlan: vi.fn(),
  unlockPlan: vi.fn(),
  setBaseline: vi.fn(),
  clearBaseline: vi.fn(),
  updateProject: vi.fn(),
  getPlanVersion: vi.fn(),
}));
vi.mock('../../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/plans/api')>()),
  ...api,
}));

const { default: PlanTab } = await import('./PlanTab');
const { default: PlanGantt } = await import('./PlanGantt');
const { CompletionHost } = await import('./useCompletion');

const INITIATIVE = { name: 'NAP11 Hall Migration', scheduled_start: '2026-11-14', scheduled_end: '2026-11-16' };
const NO_WINDOW = { start: null, end: null };
const OFF: GanttDisplay = { critical: false, baseline: false };
const ROW = 30;

/** Survey (Mon), Pack (Tue, FS after Survey), Move (Wed): a day each; Go live, a milestone on Thu. */
function tasks3(): PlanTask[] {
  return [
    makeTask('a', { display_id: 1, wbs: '1', position: 0, name: 'Survey' }),
    makeTask('b', {
      display_id: 2, wbs: '2', position: 1, name: 'Pack', predecessors: '1',
      start: '2026-11-03T08:00', finish: '2026-11-03T17:00',
    }),
    makeTask('c', { display_id: 3, wbs: '3', position: 2, name: 'Move', start: '2026-11-04T08:00', finish: '2026-11-04T17:00' }),
    makeTask('m', {
      display_id: 4, wbs: '4', position: 3, name: 'Go live', is_milestone: true, duration_minutes: 0,
      duration_text: '0 days', start: '2026-11-05T17:00', finish: '2026-11-05T17:00',
    }),
  ];
}

const plan3 = (over: Partial<Plan> = {}) => makePlan({
  tasks: tasks3(), links: [makeLink('ab', 'a', 'b')], project_finish: '2026-11-05T17:00',
  initiative_window: NO_WINDOW, ...over,
});

/** Prep (summary) › Order crates; Go live. */
function outlineTasks(): PlanTask[] {
  return [
    makeTask('s1', { display_id: 1, wbs: '1', outline_level: 1, position: 0, is_summary: true, name: 'Prep',
      start: '2026-11-02T08:00', finish: '2026-11-03T17:00' }),
    makeTask('a', { display_id: 2, wbs: '1.1', outline_level: 2, position: 0, parent_id: 's1', name: 'Order crates' }),
    makeTask('c', { display_id: 3, wbs: '2', outline_level: 1, position: 1, name: 'Go live',
      start: '2026-11-04T08:00', finish: '2026-11-04T17:00' }),
  ];
}

const OK: ApplyResult = { ok: true, notices: [], tempIds: {} };

interface Stand {
  apply: ReturnType<typeof vi.fn>;
  beginEditing: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  undo: ReturnType<typeof vi.fn>;
  calls: string[];
}

/** A controller's writes and holds, recorded in the order they happen. */
function stand(result: ApplyResult = OK): Stand {
  const calls: string[] = [];
  const release = vi.fn(() => { calls.push('release'); });
  return {
    calls,
    release,
    apply: vi.fn(async () => { calls.push('apply'); return result; }),
    beginEditing: vi.fn((owner: string) => { calls.push(`hold:${owner}`); return release; }),
    undo: vi.fn(),
  };
}

interface HarnessProps {
  plan: Plan;
  s: Stand;
  zoom?: Zoom;
  selection?: Selection;
  onSelect?: (sel: Selection) => void;
  onLinkClick?: (id: string) => void;
  onBarDoubleClick?: (task: PlanTask) => void;
}

/** The chart alone, as PlanTab drives it, with a stand-in controller. */
function Harness({ plan, s, zoom = 'days', selection = EMPTY_SELECTION, onSelect = () => {}, onLinkClick,
  onBarDoubleClick }: HarnessProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const view = planView(plan);
  const ctl = {
    status: 'ready', plan: view.plan, outline: view.outline, apply: s.apply, beginEditing: s.beginEditing,
    undo: s.undo,
  } as unknown as PlanController;
  return (
    <CompletionHost ctl={ctl}>
      <div ref={scrollRef} className="pln-panes">
        <PlanGantt ctl={ctl} rows={plan.tasks.map((t) => t.id)} rowHeight={ROW} scrollRef={scrollRef} zoom={zoom}
                   display={OFF} selection={selection} onSelect={onSelect} onLinkClick={onLinkClick}
                   onBarDoubleClick={onBarDoubleClick} />
      </div>
    </CompletionHost>
  );
}

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/initiatives/init-1?tab=plan']}>
      <Routes>
        <Route path="/initiatives/:id" element={<PlanTab initiativeId="init-1" initiative={INITIATIVE} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const px = (v: string) => Number.parseFloat(v);
const chartBar = () => q('.pln-pane-chart > .pln-hbar') as HTMLElement;
const barOf = (id: string) => q(`[data-task-id="${id}"]:not(.pln-link-dot)`) as HTMLElement;
const dotOf = (id: string) => q(`.pln-link-dot[data-task-id="${id}"]`) as HTMLElement;
const sentOps = (call = 0) => api.postOps.mock.calls[call][2];

/** The scale PlanGantt draws for a plan at a zoom, the window band included. */
function scaleFor(plan: Plan, zoom: Zoom, scheduled = plan.initiative_window) {
  const span = scaleSpan(plan.project_start, plan.project_finish, windowSpan(scheduled));
  return makeScale(span.start, span.finish, zoom);
}

/** The pointer's clientX over a plan time: the pane's left edge is 0 here,
 *  so it is the time's x on the scale less the chart's sideways scroll. */
const clientAt = (plan: Plan, time: string, zoom: Zoom = 'days', scheduled = plan.initiative_window) =>
  xOf(scaleFor(plan, zoom, scheduled), time) - chartBar().scrollLeft;
/** The middle of row `i` (the chart's top is 0 here). */
const rowY = (i: number) => i * ROW + ROW / 2;

/** One gesture: press, the moves, let go — all at the element pressed (the
 *  pointer is captured there). */
function drag(el: HTMLElement, from: [number, number], ...to: [number, number][]) {
  fireEvent.pointerDown(el, { clientX: from[0], clientY: from[1], pointerId: 1, button: 0 });
  for (const [x, y] of to) fireEvent.pointerMove(el, { clientX: x, clientY: y, pointerId: 1 });
  const [x, y] = to.length ? to[to.length - 1] : from;
  fireEvent.pointerUp(el, { clientX: x, clientY: y, pointerId: 1 });
}

// jsdom does no layout: every box gets a size, so the virtualizer sees a
// 600px-tall scroller and the chart an 800px-wide pane at the left edge
const SIZES = ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth'] as const;
const realSizes = SIZES.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
  ?? Object.getOwnPropertyDescriptor(Element.prototype, key));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  for (const [key, size] of [['offsetHeight', 600], ['offsetWidth', 1200], ['clientHeight', 600], ['clientWidth', 800]] as const) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => size });
  }
  for (const fn of [toast, ...Object.values(api)]) fn.mockReset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  SIZES.forEach((key, i) => {
    const real = realSizes[i];
    if (real) Object.defineProperty(HTMLElement.prototype, key, real);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  });
  localStorage.clear();
});

describe('moving a bar', () => {
  it('pointerdown, moves and pointerup on a bar post one update_task with the snapped start', async () => {
    const plan = plan3();
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    const x = clientAt(plan, '2026-11-03T12:00');
    // 58px at 48px a day is a day and 5 hours (the days zoom snaps to the hour)
    drag(barOf('b'), [x, rowY(1)], [x + 20, rowY(1)], [x + 58.6, rowY(1) + 4]);
    expect(s.apply).toHaveBeenCalledTimes(1);
    expect(s.apply).toHaveBeenCalledWith([{ op: 'update_task', id: 'b', fields: { start: '2026-11-04T13:00' } }],
      'Move Task');
  });

  it('holds editing while the drag is live, and sends it before letting go', () => {
    const plan = plan3();
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    const x = clientAt(plan, '2026-11-03T12:00');
    fireEvent.pointerDown(barOf('b'), { clientX: x, clientY: rowY(1), pointerId: 1, button: 0 });
    expect(s.beginEditing).not.toHaveBeenCalled();
    fireEvent.pointerMove(barOf('b'), { clientX: x + 48, clientY: rowY(1), pointerId: 1 });
    expect(s.calls).toEqual(['hold:gantt-drag']);
    fireEvent.pointerUp(barOf('b'), { clientX: x + 48, clientY: rowY(1), pointerId: 1 });
    expect(s.calls).toEqual(['hold:gantt-drag', 'apply', 'release']);
  });

  it('shows a ghost bar and the new Start while dragging, gone once it ends', () => {
    const plan = plan3();
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    const x = clientAt(plan, '2026-11-03T12:00');
    const bar = barOf('b');
    fireEvent.pointerDown(bar, { clientX: x, clientY: rowY(1), pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: x + 58, clientY: rowY(1), pointerId: 1 });
    const ghost = q('.pln-drag-ghost') as HTMLElement;
    expect(px(ghost.style.left) - px(bar.style.left)).toBeCloseTo(58);
    expect(px(ghost.style.width)).toBeCloseTo(px(bar.style.width));
    expect(px(ghost.style.top)).toBeGreaterThanOrEqual(ROW);
    const tip = q('.pln-drag-tip') as HTMLElement;
    expect(tip.textContent).toContain('Pack');
    expect(tip.textContent).toContain('Start');
    expect(tip.textContent).toContain('Wed 11/4/26 1:00 PM');
    fireEvent.pointerUp(bar, { clientX: x + 58, clientY: rowY(1), pointerId: 1 });
    expect(q('.pln-drag-ghost')).toBeNull();
    expect(q('.pln-drag-tip')).toBeNull();
  });

  it('reads the pointer on the scale at any sideways scroll of the chart', () => {
    const plan = plan3();
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    expect(chartBar().scrollLeft).toBeGreaterThan(0);        // the chart opens scrolled to the project start
    act(() => {
      chartBar().scrollLeft += 210;
      chartBar().dispatchEvent(new Event('scroll'));
    });
    const x = clientAt(plan, '2026-11-03T12:00');
    expect(x).toBeLessThan(xOf(scaleFor(plan, 'days'), '2026-11-03T12:00') - 210);
    drag(barOf('b'), [x, rowY(1)], [x + 48, rowY(1)]);
    expect(s.apply).toHaveBeenCalledWith([{ op: 'update_task', id: 'b', fields: { start: '2026-11-04T08:00' } }],
      'Move Task');
    // pressed at its right end at this scroll: a resize
    const end = clientAt(plan, '2026-11-03T17:00') - 1;
    drag(barOf('b'), [end, rowY(1)], [end + 48, rowY(1)]);
    expect(s.apply).toHaveBeenLastCalledWith([{ op: 'update_task', id: 'b', fields: { duration: '2 days' } }],
      'Edit Duration');
  });

  it('moves a milestone; its diamond has no resize', () => {
    const plan = plan3();
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    const x = clientAt(plan, '2026-11-05T17:00') + 5;
    drag(barOf('m'), [x, rowY(3)], [x + 48, rowY(3)]);
    expect(s.apply).toHaveBeenCalledWith([{ op: 'update_task', id: 'm', fields: { start: '2026-11-06T17:00' } }],
      'Move Task');
  });

  it('Esc cancels the drag: nothing is sent and editing is let go', () => {
    const plan = plan3();
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    const x = clientAt(plan, '2026-11-03T12:00');
    const bar = barOf('b');
    fireEvent.pointerDown(bar, { clientX: x, clientY: rowY(1), pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: x + 48, clientY: rowY(1), pointerId: 1 });
    const esc = fireEvent.keyDown(document, { key: 'Escape' });
    expect(esc).toBe(false);                     // handled: full screen and dialogs leave it alone
    expect(q('.pln-drag-ghost')).toBeNull();
    expect(s.release).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(bar, { clientX: x + 48, clientY: rowY(1), pointerId: 1 });
    expect(s.apply).not.toHaveBeenCalled();
  });

  it('a canceled pointer, or a lost capture, sends nothing', () => {
    const plan = plan3();
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    const x = clientAt(plan, '2026-11-03T12:00');
    const bar = barOf('b');
    fireEvent.pointerDown(bar, { clientX: x, clientY: rowY(1), pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: x + 48, clientY: rowY(1), pointerId: 1 });
    fireEvent.pointerCancel(bar, { pointerId: 1 });
    fireEvent.pointerDown(bar, { clientX: x, clientY: rowY(1), pointerId: 2, button: 0 });
    fireEvent.pointerMove(bar, { clientX: x + 48, clientY: rowY(1), pointerId: 2 });
    fireEvent(bar, new PointerEvent('lostpointercapture', { pointerId: 2, bubbles: true }));
    fireEvent.pointerUp(bar, { clientX: x + 48, clientY: rowY(1), pointerId: 2 });
    expect(s.apply).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledTimes(2);
    expect(q('.pln-drag-ghost')).toBeNull();
  });

  it('a zoom mid-drag cancels it: the press was read on the old scale', () => {
    const plan = plan3();
    const s = stand();
    const { rerender } = render(<Harness plan={plan} s={s} />);
    const x = clientAt(plan, '2026-11-03T12:00');
    const bar = barOf('b');
    fireEvent.pointerDown(bar, { clientX: x, clientY: rowY(1), pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: x + 48, clientY: rowY(1), pointerId: 1 });
    expect(q('.pln-drag-ghost')).not.toBeNull();
    rerender(<Harness plan={plan} s={s} zoom="weeks" />);
    expect(q('.pln-drag-ghost')).toBeNull();
    expect(s.release).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(bar, { clientX: x + 48, clientY: rowY(1), pointerId: 1 });
    expect(s.apply).not.toHaveBeenCalled();
  });

  it('a press that moves under 3px is a click: it selects the task and sends nothing', () => {
    const plan = plan3();
    const s = stand();
    const onSelect = vi.fn();
    render(<Harness plan={plan} s={s} onSelect={onSelect} />);
    const x = clientAt(plan, '2026-11-03T12:00');
    drag(barOf('b'), [x, rowY(1)], [x + 2, rowY(1)]);
    expect(s.apply).not.toHaveBeenCalled();
    expect(s.beginEditing).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(selectCell('b', 'name'));
  });

  it('a summary is not dragged; a press on it selects its row', () => {
    const plan = makePlan({ tasks: outlineTasks(), initiative_window: NO_WINDOW, project_finish: '2026-11-04T17:00' });
    const s = stand();
    const onSelect = vi.fn();
    render(<Harness plan={plan} s={s} onSelect={onSelect} />);
    const summary = q('.pln-bar-summary[data-task-id="s1"]') as HTMLElement;
    const x = clientAt(plan, '2026-11-02T12:00');
    const down = fireEvent.pointerDown(summary, { clientX: x, clientY: rowY(0), pointerId: 1, button: 0 });
    expect(down).toBe(true);                     // not taken: the lane press selects it
    fireEvent.pointerMove(summary, { clientX: x + 48, clientY: rowY(0), pointerId: 1 });
    fireEvent.pointerUp(summary, { clientX: x + 48, clientY: rowY(0), pointerId: 1 });
    expect(s.apply).not.toHaveBeenCalled();
    expect(s.beginEditing).not.toHaveBeenCalled();
    fireEvent.mouseDown(summary, { button: 0, clientY: rowY(0) });
    expect(onSelect).toHaveBeenCalledWith(selectCell('s1', 'name'));
  });

  it('a press on the status-date line over a bar’s end takes the bar, not the line', () => {
    const plan = plan3({ status_date: '2026-11-03T17:00', now: '2026-11-03T17:00' });
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    // the lines carry no title or hover strip of their own: their marks in the timescale do
    expect(q('.pln-status-date')?.getAttribute('title')).toBeNull();
    expect(q('.pln-today')?.getAttribute('title')).toBeNull();
    expect(q('.pln-scale .pln-status-mark')?.getAttribute('title')).toBe('Status date Tue 11/3/26');
    expect(q('.pln-scale .pln-today-mark')?.getAttribute('title')).toBe('Today Tue 11/3/26');
    const at = clientAt(plan, '2026-11-03T17:00');
    expect(px((q('.pln-status-date') as HTMLElement).style.left)).toBeCloseTo(
      px(barOf('b').style.left) + px(barOf('b').style.width));
    drag(barOf('b'), [at - 1, rowY(1)], [at + 47, rowY(1)]);
    expect(s.apply).toHaveBeenCalledWith([{ op: 'update_task', id: 'b', fields: { duration: '2 days' } }],
      'Edit Duration');
  });

  it('a press on an empty part of a lane selects its row, wherever the lines are', () => {
    const plan = plan3();
    const onSelect = vi.fn();
    render(<Harness plan={plan} s={stand()} onSelect={onSelect} />);
    fireEvent.mouseDown(q('.pln-chart') as HTMLElement, { button: 0, clientX: 5, clientY: rowY(2) });
    expect(onSelect).toHaveBeenCalledWith(selectCell('c', 'name'));
  });
});

describe('resizing and progress', () => {
  it('dragging the right end sets the Duration in the task’s unit', () => {
    const plan = plan3();
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    const end = clientAt(plan, '2026-11-03T17:00') - 2;
    const bar = barOf('b');
    fireEvent.pointerDown(bar, { clientX: end, clientY: rowY(1), pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: end + 48, clientY: rowY(1), pointerId: 1 });
    const ghost = q('.pln-drag-ghost') as HTMLElement;
    expect(px(ghost.style.left)).toBeCloseTo(px(bar.style.left));
    expect(px(ghost.style.width)).toBeCloseTo(px(bar.style.width) + 48);
    expect(q('.pln-drag-tip')?.textContent).toContain('2 days');
    fireEvent.pointerUp(bar, { clientX: end + 48, clientY: rowY(1), pointerId: 1 });
    expect(s.apply).toHaveBeenCalledWith([{ op: 'update_task', id: 'b', fields: { duration: '2 days' } }],
      'Edit Duration');
  });

  it('dragging the progress handle sets % Complete to where it is let go, rounded to 5%', () => {
    const plan = plan3();
    const s = stand();
    render(<Harness plan={plan} s={s} zoom="hours" />);
    const left = clientAt(plan, '2026-11-03T08:00', 'hours');
    // the handle sits at the left edge at 0%; the bar is 180px wide at 20px an hour, so 92px in is 50%
    drag(barOf('b'), [left + 1, rowY(1)], [left + 40, rowY(1)], [left + 92, rowY(1)]);
    expect(s.apply).toHaveBeenCalledWith([{ op: 'set_percent', ids: ['b'], percent: 50 }], '50% Complete');
  });

  it('a one-day bar at the days zoom has no progress handle: a press at its left edge moves it', () => {
    const plan = plan3();
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    expect(barOf('b').querySelector('.pln-pct-grip')).toBeNull();
    const left = clientAt(plan, '2026-11-03T08:00');
    drag(barOf('b'), [left + 1, rowY(1)], [left + 49, rowY(1)]);
    expect(s.apply).toHaveBeenCalledWith([{ op: 'update_task', id: 'b', fields: { start: '2026-11-04T08:00' } }],
      'Move Task');
  });

  it('a progress drag to 100% goes through the completion check', async () => {
    const plan = plan3();
    const s = stand({ ok: false, kind: 'confirm', willComplete: [], openPredecessors: [
      { task_id: 'a', display_id: 1, name: 'Survey', reason: 'predecessor' }] });
    render(<Harness plan={plan} s={s} zoom="hours" />);
    const left = clientAt(plan, '2026-11-03T08:00', 'hours');
    drag(barOf('b'), [left + 1, rowY(1)], [left + 200, rowY(1)]);
    expect(s.apply).toHaveBeenCalledWith([{ op: 'set_percent', ids: ['b'], percent: 100 }], '100% Complete');
    const check = await screen.findByRole('dialog', { name: 'Confirm completion' });
    expect(within(check).getByText('Survey')).toBeTruthy();
    fireEvent.click(within(check).getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(s.apply).toHaveBeenLastCalledWith([{ op: 'set_percent', ids: ['b'], percent: 100 }],
      '100% Complete', { confirm: true }));
  });
});

describe('linking', () => {
  it('a drag from the link handle onto another bar posts add_link', () => {
    const plan = plan3();
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    const from = clientAt(plan, '2026-11-02T17:00') + 6;
    const onto = clientAt(plan, '2026-11-04T12:00');
    const dot = dotOf('a');
    fireEvent.pointerDown(dot, { clientX: from, clientY: rowY(0), pointerId: 1, button: 0 });
    fireEvent.pointerMove(dot, { clientX: onto, clientY: rowY(2), pointerId: 1 });
    expect(q('.pln-drag-band')).not.toBeNull();
    expect(q('.pln-drag-tip')?.textContent).toContain('Move');
    fireEvent.pointerUp(dot, { clientX: onto, clientY: rowY(2), pointerId: 1 });
    expect(s.apply).toHaveBeenCalledWith(
      [{ op: 'add_link', predecessor_id: 'a', successor_id: 'c', link_type: 'FS' }], 'Link Tasks');
  });

  it('a drop on the same task, a link that exists, or off any bar does nothing', () => {
    const plan = plan3();
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    const from = clientAt(plan, '2026-11-02T17:00') + 6;
    drag(dotOf('a'), [from, rowY(0)], [clientAt(plan, '2026-11-02T12:00'), rowY(0)]);
    drag(dotOf('a'), [from, rowY(0)], [clientAt(plan, '2026-11-03T12:00'), rowY(1)]);     // a→b exists
    drag(dotOf('a'), [from, rowY(0)], [clientAt(plan, '2026-11-08T12:00'), rowY(2)]);     // past Move's bar
    expect(s.apply).not.toHaveBeenCalled();
  });

  it('a summary can’t be linked to its own subtask', () => {
    const plan = makePlan({ tasks: outlineTasks(), initiative_window: NO_WINDOW, project_finish: '2026-11-04T17:00' });
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    const from = clientAt(plan, '2026-11-03T17:00') + 6;
    drag(dotOf('s1'), [from, rowY(0)], [clientAt(plan, '2026-11-02T12:00'), rowY(1)]);
    expect(s.apply).not.toHaveBeenCalled();
    drag(dotOf('s1'), [from, rowY(0)], [clientAt(plan, '2026-11-04T12:00'), rowY(2)]);
    expect(s.apply).toHaveBeenCalledWith(
      [{ op: 'add_link', predecessor_id: 's1', successor_id: 'c', link_type: 'FS' }], 'Link Tasks');
  });

  it('clicking a link opens its dialog; double-clicking a bar is Task Information’s hook', () => {
    const plan = plan3();
    const onLinkClick = vi.fn();
    const onBarDoubleClick = vi.fn();
    render(<Harness plan={plan} s={stand()} onLinkClick={onLinkClick} onBarDoubleClick={onBarDoubleClick} />);
    const hit = q('.pln-link-hit') as HTMLElement;
    expect(hit.getAttribute('data-link-hit')).toBe('ab');
    fireEvent.click(hit);
    expect(onLinkClick).toHaveBeenCalledWith('ab');
    fireEvent.doubleClick(barOf('c'));
    expect(onBarDoubleClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }));
  });
});

describe('fix round 1', () => {
  /** Pack at 13:00 Tue to noon Wed, so its clock time shows. */
  const afternoon = (over: Partial<PlanTask> = {}) => plan3({
    tasks: tasks3().map((t) => (t.id === 'b'
      ? { ...t, start: '2026-11-03T13:00', finish: '2026-11-04T12:00', ...over }
      : t)),
  });

  it('at the weeks zoom a drop back at its origin sends nothing', () => {
    const plan = afternoon();
    const s = stand();
    render(<Harness plan={plan} s={s} zoom="weeks" />);
    const x = clientAt(plan, '2026-11-03T13:00', 'weeks') + 5;
    drag(barOf('b'), [x, rowY(1)], [x + 40, rowY(1)], [x + 1, rowY(1)]);
    expect(s.apply).not.toHaveBeenCalled();
  });

  it('at the weeks zoom a one-week move keeps the task’s 13:00, and a manual task’s too', () => {
    for (const mode of ['auto', 'manual'] as const) {
      const plan = afternoon({ mode });
      const s = stand();
      const { unmount } = render(<Harness plan={plan} s={s} zoom="weeks" />);
      const x = clientAt(plan, '2026-11-03T13:00', 'weeks') + 5;
      drag(barOf('b'), [x, rowY(1)], [x + 60, rowY(1)], [x + 7 * 18 + 4, rowY(1)]);
      expect(s.apply).toHaveBeenCalledWith([{ op: 'update_task', id: 'b', fields: { start: '2026-11-10T13:00' } }],
        'Move Task');
      unmount();
    }
  });

  it('a resize’s tooltip shows the text it sends, which parses back to exactly the working time', () => {
    const plan = makePlan({
      tasks: [makeTask('r', { name: 'Rack', start: '2026-11-02T13:00', finish: '2026-11-04T12:00', duration_minutes: 960,
        duration_text: '2 days' })],
      project_finish: '2026-11-04T12:00', initiative_window: NO_WINDOW,
    });
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    const end = clientAt(plan, '2026-11-04T12:00') - 1;
    const bar = barOf('r');
    fireEvent.pointerDown(bar, { clientX: end, clientY: rowY(0), pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: end + 4, clientY: rowY(0), pointerId: 1 });
    expect(q('.pln-drag-tip')?.textContent).toContain('2.125 days');
    fireEvent.pointerUp(bar, { clientX: end + 4, clientY: rowY(0), pointerId: 1 });
    expect(s.apply).toHaveBeenCalledWith([{ op: 'update_task', id: 'r', fields: { duration: '2.125 days' } }],
      'Edit Duration');
  });

  it('losing the window, the page going hidden, or a mouse let go unseen ends the drag unsent', () => {
    const plan = plan3();
    const ends: [string, () => void][] = [
      ['blur', () => { fireEvent.blur(window); }],
      ['hidden', () => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        fireEvent(document, new Event('visibilitychange'));
        Reflect.deleteProperty(document, 'visibilityState');
      }],
      ['no buttons', () => {
        fireEvent.pointerMove(barOf('b'), { clientX: 900, clientY: rowY(1), pointerId: 1, pointerType: 'mouse',
          buttons: 0 });
      }],
    ];
    for (const [name, endIt] of ends) {
      const s = stand();
      const { unmount } = render(<Harness plan={plan} s={s} />);
      const x = clientAt(plan, '2026-11-03T12:00');
      const bar = barOf('b');
      fireEvent.pointerDown(bar, { clientX: x, clientY: rowY(1), pointerId: 1, button: 0, pointerType: 'mouse' });
      fireEvent.pointerMove(bar, { clientX: x + 48, clientY: rowY(1), pointerId: 1, pointerType: 'mouse', buttons: 1 });
      expect(q('.pln-drag-ghost'), name).not.toBeNull();
      endIt();
      expect(q('.pln-drag-ghost'), name).toBeNull();
      expect(s.release, name).toHaveBeenCalledTimes(1);
      fireEvent.pointerUp(bar, { clientX: x + 48, clientY: rowY(1), pointerId: 1, pointerType: 'mouse' });
      expect(s.apply, name).not.toHaveBeenCalled();
      unmount();
    }
  });

  it('a task that has started can’t be moved: it says so, holds nothing and sends nothing', () => {
    const plan = plan3({
      tasks: tasks3().map((t) => (t.id === 'b' ? { ...t, actual_start: '2026-11-03T08:00', percent_complete: 25 } : t)),
    });
    const s = stand();
    const onSelect = vi.fn();
    render(<Harness plan={plan} s={s} onSelect={onSelect} />);
    const x = clientAt(plan, '2026-11-03T12:00');
    drag(barOf('b'), [x, rowY(1)], [x + 20, rowY(1)], [x + 48, rowY(1)]);
    expect(toast).toHaveBeenCalledWith('This task has started — change its Actual Start instead.');
    expect(toast).toHaveBeenCalledTimes(1);
    expect(s.beginEditing).not.toHaveBeenCalled();
    expect(s.apply).not.toHaveBeenCalled();
    expect(q('.pln-drag-ghost')).toBeNull();
    // a click still selects it, and its end still resizes it
    drag(barOf('b'), [x, rowY(1)], [x + 1, rowY(1)]);
    expect(onSelect).toHaveBeenCalledWith(selectCell('b', 'name'));
    const end = clientAt(plan, '2026-11-03T17:00') - 1;
    drag(barOf('b'), [end, rowY(1)], [end + 48, rowY(1)]);
    expect(s.apply).toHaveBeenCalledWith([{ op: 'update_task', id: 'b', fields: { duration: '2 days' } }],
      'Edit Duration');
  });

  it('a refresh between the press and the drag that moves the task’s row calls the drag off', () => {
    const plan = plan3();
    const s = stand();
    const { rerender } = render(<Harness plan={plan} s={s} />);
    const x = clientAt(plan, '2026-11-03T12:00');
    fireEvent.pointerDown(barOf('b'), { clientX: x, clientY: rowY(1), pointerId: 1, button: 0 });
    // someone else's change lands: Pack is now the third row
    const [a, b, c, m] = tasks3();
    rerender(<Harness plan={plan3({ tasks: [a, { ...c, position: 1 }, { ...b, position: 2 }, m] })} s={s} />);
    fireEvent.pointerMove(barOf('b'), { clientX: x + 48, clientY: rowY(1), pointerId: 1 });
    expect(q('.pln-drag-ghost')).toBeNull();
    expect(s.beginEditing).not.toHaveBeenCalled();
    fireEvent.pointerUp(barOf('b'), { clientX: x + 48, clientY: rowY(1), pointerId: 1 });
    expect(s.apply).not.toHaveBeenCalled();
  });

  it('on a locked plan a one-day bar at the days zoom has a progress handle too', () => {
    const plan = plan3({ locked_at: '2026-10-27T12:00:00Z' });
    const s = stand();
    render(<Harness plan={plan} s={s} />);
    expect(barOf('b').querySelector('.pln-pct-grip')).not.toBeNull();
    const left = clientAt(plan, '2026-11-03T08:00');
    drag(barOf('b'), [left + 1, rowY(1)], [left + 5, rowY(1)], [left + 9, rowY(1)]);
    expect(s.apply).toHaveBeenCalledWith([{ op: 'set_percent', ids: ['b'], percent: 50 }], '50% Complete');
  });

  it('a touch tap under the threshold selects the task', () => {
    const plan = plan3();
    const s = stand();
    const onSelect = vi.fn();
    render(<Harness plan={plan} s={s} onSelect={onSelect} />);
    const x = clientAt(plan, '2026-11-03T12:00');
    const bar = barOf('b');
    fireEvent.pointerDown(bar, { clientX: x, clientY: rowY(1), pointerId: 7, button: 0, pointerType: 'touch' });
    fireEvent.pointerMove(bar, { clientX: x + 2, clientY: rowY(1), pointerId: 7, pointerType: 'touch', buttons: 0 });
    fireEvent.pointerUp(bar, { clientX: x + 2, clientY: rowY(1), pointerId: 7, pointerType: 'touch' });
    expect(onSelect).toHaveBeenCalledWith(selectCell('b', 'name'));
    expect(s.apply).not.toHaveBeenCalled();
  });
});

describe('locked and read-only plans', () => {
  it('a locked plan only takes progress drags', () => {
    const plan = plan3({ locked_at: '2026-10-27T12:00:00Z' });
    const s = stand();
    render(<Harness plan={plan} s={s} zoom="hours" />);
    expect(qa('.pln-link-dot')).toHaveLength(0);
    expect(q('.pln-gantt')?.getAttribute('data-drag')).toBe('progress');
    const x = clientAt(plan, '2026-11-03T12:00', 'hours');
    drag(barOf('b'), [x, rowY(1)], [x + 480, rowY(1)]);
    const end = clientAt(plan, '2026-11-03T17:00', 'hours') - 2;
    drag(barOf('b'), [end, rowY(1)], [end + 480, rowY(1)]);
    expect(s.apply).not.toHaveBeenCalled();
    const left = clientAt(plan, '2026-11-03T08:00', 'hours');
    drag(barOf('b'), [left + 1, rowY(1)], [left + 92, rowY(1)]);
    expect(s.apply).toHaveBeenCalledWith([{ op: 'set_percent', ids: ['b'], percent: 50 }], '50% Complete');
  });

  it('a read-only plan has no handles and no drags', () => {
    const plan = plan3({ permissions: { view: true, add: false, change: false, delete: false } });
    const s = stand();
    render(<Harness plan={plan} s={s} zoom="hours" />);
    expect(qa('.pln-link-dot')).toHaveLength(0);
    expect(qa('.pln-pct-grip')).toHaveLength(0);
    expect(q('.pln-gantt')?.getAttribute('data-drag')).toBe('none');
    const left = clientAt(plan, '2026-11-03T08:00', 'hours');
    drag(barOf('b'), [left + 1, rowY(1)], [left + 92, rowY(1)]);
    const x = clientAt(plan, '2026-11-03T12:00', 'hours');
    drag(barOf('b'), [x, rowY(1)], [x + 480, rowY(1)]);
    expect(s.apply).not.toHaveBeenCalled();
    expect(s.beginEditing).not.toHaveBeenCalled();
  });
});

describe('in the tab', () => {
  async function ready(plan: Plan) {
    api.getPlan.mockResolvedValue(plan);
    renderTab();
    await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
  }
  const tabX = (plan: Plan, time: string) =>
    clientAt(plan, time, 'days', { start: INITIATIVE.scheduled_start, end: INITIATIVE.scheduled_end });

  it('a move posts its Start, says the constraint it added, and Undo takes it back', async () => {
    const plan = plan3();
    await ready(plan);
    api.postOps.mockResolvedValueOnce(makeOpsResult({
      tasks: [{ ...plan.tasks[1], start: '2026-11-04T08:00', finish: '2026-11-04T17:00', constraint_type: 'snet',
        constraint_date: '2026-11-04T08:00' }],
      notices: [{ code: 'constraint_added', task_id: 'b', constraint_type: 'snet' }],
    }));
    const x = tabX(plan, '2026-11-03T12:00');
    drag(barOf('b'), [x, rowY(1)], [x + 48, rowY(1)]);
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sentOps()).toEqual([{ op: 'update_task', id: 'b', fields: { start: '2026-11-04T08:00' } }]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Start No Earlier Than constraint added',
      expect.objectContaining({ label: 'Undo' })));
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7 }));
    const undo = toast.mock.calls.find((c) => c[1]?.label === 'Undo')?.[1] as { onClick(): void };
    act(() => undo.onClick());
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sentOps(1)).toEqual([makeRestore('inv')]);
  });

  it('a link the API refuses as a cycle says which tasks, by their IDs', async () => {
    const plan = plan3();
    await ready(plan);
    api.postOps.mockRejectedValueOnce(new ApiError(422, 'link_cycle',
      { code: 'link_cycle', display_ids: [1, 2] }, 'link_cycle'));
    const from = tabX(plan, '2026-11-03T17:00') + 6;
    drag(dotOf('b'), [from, rowY(1)], [tabX(plan, '2026-11-02T12:00'), rowY(0)]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Tasks 1 and 2 would depend on each other.'));
    expect(sentOps()).toEqual([{ op: 'add_link', predecessor_id: 'b', successor_id: 'a', link_type: 'FS' }]);
  });

  it('a double-click on a bar opens Task Information for its task', async () => {
    await ready(plan3());
    fireEvent.doubleClick(barOf('c'));
    const dialog = await screen.findByRole('dialog', { name: 'Task Information' });
    expect((within(dialog).getByLabelText('Task Name') as HTMLInputElement).value).toBe('Move');
  });
});

describe('Task Dependency dialog', () => {
  async function open(plan: Plan) {
    api.getPlan.mockResolvedValue(plan);
    renderTab();
    await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
    fireEvent.click(q('.pln-link-hit[data-link-hit="ab"]') as HTMLElement);
    return screen.findByRole('dialog', { name: 'Task Dependency' });
  }

  it('names the two tasks; changing the type to SS with a 1d lag posts update_link', async () => {
    const dialog = await open(plan3());
    expect(within(dialog).getByText('Project plan')).toBeTruthy();
    expect(dialog.querySelector('.page-hint')?.textContent).toBeTruthy();
    expect(within(dialog).getByLabelText('From').textContent).toContain('Survey');
    expect(within(dialog).getByLabelText('To').textContent).toContain('Pack');
    const type = within(dialog).getByRole('combobox', { name: 'Type' });
    fireEvent.click(type);
    const option = await screen.findByRole('button', { name: 'Start-to-Start (SS)' });
    expect(option.closest('.combo-menu')?.closest('.modal-card')).toBeNull();    // portaled
    fireEvent.mouseDown(option);
    const lag = within(dialog).getByLabelText('Lag') as HTMLInputElement;
    expect(lag.value).toBe('0 days');
    fireEvent.change(lag, { target: { value: '1d' } });
    api.postOps.mockResolvedValueOnce(makeOpsResult({ links: [makeLink('ab', 'a', 'b', { link_type: 'SS',
      lag_minutes: 480, lag_text: '+1 day' })] }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sentOps()).toEqual([{ op: 'update_link', id: 'ab', link_type: 'SS', lag: '1d' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('sends only what changed; nothing changed sends nothing', async () => {
    let dialog = await open(plan3({ links: [makeLink('ab', 'a', 'b', { lag_minutes: 960, lag_text: '+2 days' })] }));
    // the same lag typed another way is no change
    fireEvent.change(within(dialog).getByLabelText('Lag'), { target: { value: '2d' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(api.postOps).not.toHaveBeenCalled();
    fireEvent.click(q('.pln-link-hit[data-link-hit="ab"]') as HTMLElement);
    dialog = await screen.findByRole('dialog', { name: 'Task Dependency' });
    fireEvent.change(within(dialog).getByLabelText('Lag'), { target: { value: '-4h' } });
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sentOps()).toEqual([{ op: 'update_link', id: 'ab', lag: '-4h' }]);
  });

  it('a lag that isn’t one is shown under the field and nothing is sent', async () => {
    const dialog = await open(plan3());
    fireEvent.change(within(dialog).getByLabelText('Lag'), { target: { value: 'soon' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    expect(dialog.querySelector('.pf-error')?.textContent).toContain('isn’t a lag');
    expect(api.postOps).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Task Dependency' })).toBeTruthy();
  });

  it('Delete posts delete_link', async () => {
    const dialog = await open(plan3());
    api.postOps.mockResolvedValueOnce(makeOpsResult({ deleted_links: ['ab'] }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sentOps()).toEqual([{ op: 'delete_link', id: 'ab' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a refusal stays in the dialog with its reason', async () => {
    const dialog = await open(plan3());
    fireEvent.click(within(dialog).getByRole('combobox', { name: 'Type' }));
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'Finish-to-Finish (FF)' }));
    api.postOps.mockRejectedValueOnce(new ApiError(422, 'bad_summary_link',
      { code: 'bad_summary_link', display_ids: [2] }, 'bad_summary_link'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(dialog.querySelector('.pf-error')?.textContent).toContain('Check task 2.'));
    expect(screen.getByRole('dialog', { name: 'Task Dependency' })).toBeTruthy();
  });

  it('on a locked plan it is read-only', async () => {
    const dialog = await open(plan3({ locked_at: '2026-10-27T12:00:00Z', locked_by_name: 'Dana Reyes' }));
    expect((within(dialog).getByRole('combobox', { name: 'Type' }) as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText('Lag') as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).queryByRole('button', { name: 'OK' })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
