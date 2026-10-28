// @vitest-environment jsdom
/**
 * components/plans/PlanGantt.tsx: the Gantt chart beside the task sheet —
 * bars, the summary bracket, milestone diamonds, critical path, baseline,
 * deadline markers, the window band, links, the hover card — and how it
 * shares the view with the sheet: one vertical scroll box both virtualize
 * against, its own sideways scroll, the splitter, zoom kept per plan, Fit
 * and Scroll to Task (Review Focus 5). Direct renders for the drawing; the
 * real PlanTab and usePlan against a mocked lib/plans/api for the rest.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useRef } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Plan, PlanTask } from '../../lib/plans/api';
import { fitScrollLeft, makeScale, type Zoom } from '../../lib/plans/ganttGeometry';
import {
  TIER_CHAR_PX, TIER_PAD, pillAt, pillWidth, scaleSpan, taskScrollLeft, windowPillX, windowSpan,
} from '../../lib/plans/ganttView';
import { planView } from '../../lib/plans/merge';
import { makeLink, makePlan, makeTask } from '../../lib/plans/planFixtures';
import { EMPTY_SELECTION, selectCell, type Selection } from '../../lib/plans/selection';
import type { PlanController } from './usePlan';
import type { ChartScroll, GanttDisplay } from './usePlanCommands';

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

// who asked for a virtualizer, and against which scroll element
const virt = vi.hoisted(() => ({ calls: [] as { opts: Record<string, unknown>; stack: string }[] }));
vi.mock('@tanstack/react-virtual', async (importActual) => {
  const actual = await importActual<typeof import('@tanstack/react-virtual')>();
  return {
    ...actual,
    useVirtualizer: ((opts: Parameters<typeof actual.useVirtualizer>[0]) => {
      virt.calls.push({ opts: opts as unknown as Record<string, unknown>, stack: new Error().stack ?? '' });
      return actual.useVirtualizer(opts);
    }) as typeof actual.useVirtualizer,
  };
});

const { default: PlanTab } = await import('./PlanTab');
const { default: PlanGantt } = await import('./PlanGantt');

const INITIATIVE = { name: 'NAP11 Hall Migration', scheduled_start: '2026-11-14', scheduled_end: '2026-11-16' };
const NO_WINDOW = { start: null, end: null };
const OFF: GanttDisplay = { critical: false, baseline: false };

/** Survey, Pack (FS after Survey), Move: a day each; Go live, a milestone. */
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

/** Prep (summary) › Order crates, Labels (summary) › Print labels; Go live. */
function outlineTasks(): PlanTask[] {
  return [
    makeTask('s1', { display_id: 1, wbs: '1', outline_level: 1, position: 0, is_summary: true, name: 'Prep',
      finish: '2026-11-03T17:00' }),
    makeTask('a', { display_id: 2, wbs: '1.1', outline_level: 2, position: 0, parent_id: 's1', name: 'Order crates' }),
    makeTask('s2', { display_id: 3, wbs: '1.2', outline_level: 2, position: 1, parent_id: 's1', is_summary: true,
      name: 'Labels', start: '2026-11-03T08:00', finish: '2026-11-03T17:00' }),
    makeTask('b', { display_id: 4, wbs: '1.2.1', outline_level: 3, position: 0, parent_id: 's2', name: 'Print labels',
      start: '2026-11-03T08:00', finish: '2026-11-03T17:00' }),
    makeTask('c', { display_id: 5, wbs: '2', outline_level: 1, position: 1, name: 'Go live', is_milestone: true,
      start: '2026-11-04T17:00', finish: '2026-11-04T17:00' }),
  ];
}

interface HarnessProps {
  plan: Plan;
  rows?: string[];
  zoom?: Zoom;
  display?: GanttDisplay;
  selection?: Selection;
  onSelect?: (sel: Selection) => void;
  scheduled?: { start: string | null; end: string | null };
  scrollRequest?: ChartScroll | null;
}

/** The chart alone, as PlanTab drives it. */
function Harness({
  plan, rows = plan.tasks.map((t) => t.id), zoom = 'days', display = OFF, selection = EMPTY_SELECTION,
  onSelect = () => {}, scheduled, scrollRequest = null,
}: HarnessProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const view = planView(plan);
  const ctl = { status: 'ready', plan: view.plan, outline: view.outline } as unknown as PlanController;
  return (
    <div ref={scrollRef} className="pln-panes">
      <PlanGantt ctl={ctl} rows={rows} rowHeight={30} scrollRef={scrollRef} zoom={zoom} display={display}
                 selection={selection} onSelect={onSelect} scheduled={scheduled}
                 scrollRequest={scrollRequest} />
    </div>
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
const ids = (sel: string) => qa(sel).map((el) => el.getAttribute('data-task-id'));
const px = (v: string) => Number.parseFloat(v);
const chartBar = () => q('.pln-pane-chart > .pln-hbar') as HTMLElement;
const sheetBar = () => q('.pln-pane-sheet > .pln-hbar') as HTMLElement;
const grid = () => screen.getByRole('grid', { name: 'Task sheet' });

/** The scale PlanGantt draws for a plan at a zoom, the window band included. */
function scaleFor(plan: Plan, zoom: Zoom, scheduled = plan.initiative_window) {
  const span = scaleSpan(plan.project_start, plan.project_finish, windowSpan(scheduled));
  return makeScale(span.start, span.finish, zoom);
}

// jsdom does no layout: every box gets a size, so the virtualizer sees a
// 600px-tall scroller and the chart an 800px-wide pane
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
  virt.calls = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  SIZES.forEach((key, i) => {
    const real = realSizes[i];
    if (real) Object.defineProperty(HTMLElement.prototype, key, real);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  });
  localStorage.clear();
});

describe('bars and links', () => {
  it('a 3-task fixture with an FS link and a milestone draws three bars, one link path and a diamond', () => {
    render(<Harness plan={plan3()} />);
    expect(ids('.pln-bar')).toEqual(['a', 'b', 'c']);
    expect(qa('svg.pln-links path.pln-link-path')).toHaveLength(1);
    expect(qa('svg.pln-links polygon')).toHaveLength(1);
    expect(ids('.pln-diamond')).toEqual(['m']);
    // the milestone's date beside its diamond
    expect(q('.pln-diamond-date')?.textContent).toBe('11/5');
  });

  it('places a bar by its dates: 08:00 to 17:00 is 18px at 48px a day', () => {
    const plan = plan3();
    render(<Harness plan={plan} />);
    const scale = scaleFor(plan, 'days');
    const bar = q('.pln-bar[data-task-id="a"]') as HTMLElement;
    expect(px(bar.style.width)).toBeCloseTo(18);
    expect(px(bar.style.left)).toBeCloseTo((Date.UTC(2026, 10, 2, 8) - scale.startMs) / 86_400_000 * 48);
  });

  it('marks critical tasks in red only while Critical Path is on', () => {
    const tasks = tasks3().map((t) => (t.id === 'a' || t.id === 'b' || t.id === 'm' ? { ...t, is_critical: true } : t));
    const plan = plan3({ tasks });
    const { rerender } = render(<Harness plan={plan} />);
    expect(qa('.pln-bar-critical')).toHaveLength(0);
    expect(qa('.pln-link-critical')).toHaveLength(0);
    rerender(<Harness plan={plan} display={{ critical: true, baseline: false }} />);
    expect(ids('.pln-bar-critical')).toEqual(['a', 'b']);
    expect(ids('.pln-diamond-critical')).toEqual(['m']);
    expect(qa('path.pln-link-critical')).toHaveLength(1);
    rerender(<Harness plan={plan} />);
    expect(qa('.pln-bar-critical')).toHaveLength(0);
  });

  it('draws a summary as a bracket, progress in the bar, resource names to its right', () => {
    const tasks = outlineTasks();
    tasks[1] = { ...tasks[1], percent_complete: 50, assignees: [{ kind: 'person', id: 'p1', name: 'Dana Reyes' }] };
    render(<Harness plan={makePlan({ tasks, initiative_window: NO_WINDOW })} />);
    expect(ids('.pln-bar-summary')).toEqual(['s1', 's2']);
    expect(ids('.pln-bar')).toEqual(['a', 'b']);
    const bar = q('.pln-bar[data-task-id="a"]') as HTMLElement;
    const done = bar.querySelector('.pln-bar-done') as HTMLElement;
    expect(px(done.style.width)).toBeCloseTo(px(bar.style.width) / 2);
    const names = q('.pln-lane[data-lane="a"] .pln-bar-names') as HTMLElement;
    expect(names.textContent).toBe('Dana Reyes');
    expect(px(names.style.left)).toBeGreaterThan(px(bar.style.left) + px(bar.style.width));
  });

  it('draws the baseline under the bar only while Baseline is on, and the deadline marker', () => {
    const tasks = tasks3();
    tasks[0] = { ...tasks[0], baseline_start: '2026-11-02T08:00', baseline_finish: '2026-11-02T17:00',
      deadline: '2026-11-03T17:00' };
    tasks[3] = { ...tasks[3], baseline_start: '2026-11-04T17:00', baseline_finish: '2026-11-04T17:00' };
    const plan = plan3({ tasks });
    const { rerender } = render(<Harness plan={plan} />);
    expect(qa('.pln-baseline')).toHaveLength(0);
    expect(qa('.pln-lane[data-lane="a"] .pln-deadline')).toHaveLength(1);
    rerender(<Harness plan={plan} display={{ critical: false, baseline: true }} />);
    expect(qa('.pln-lane[data-lane="a"] .pln-baseline')).toHaveLength(1);
    expect(qa('.pln-lane[data-lane="m"] .pln-baseline')).toHaveLength(1);
    expect(qa('.pln-lane[data-lane="b"] .pln-baseline')).toHaveLength(0);
    // the bar moves up to make room for the baseline under it
    const bar = q('.pln-bar[data-task-id="a"]') as HTMLElement;
    const base = q('.pln-lane[data-lane="a"] .pln-baseline') as HTMLElement;
    expect(px(base.style.top)).toBeGreaterThanOrEqual(px(bar.style.top) + px(bar.style.height));
  });

  it('skips a task with no dates to draw', () => {
    const tasks = tasks3();
    tasks[2] = { ...tasks[2], start: null, finish: null };
    render(<Harness plan={plan3({ tasks })} />);
    expect(ids('.pln-bar')).toEqual(['a', 'b']);
  });
});

describe('timescale and markers', () => {
  it('has a two-tier header as tall as the sheet’s (44px)', () => {
    render(<Harness plan={plan3()} />);
    const gantt = q('.pln-gantt') as HTMLElement;
    expect(gantt.style.getPropertyValue('--pln-head-h')).toBe('44px');
    // weeks (from their Monday) over days, from Saturday Oct 31: two days before the start
    expect(qa('.pln-scale-top .pln-tick').map((t) => t.textContent).slice(0, 2)).toEqual(["Oct 26, '26", "Nov 2, '26"]);
    expect(qa('.pln-scale-bottom .pln-tick').slice(0, 7).map((t) => t.textContent).join('')).toBe('SSMTWTF');
  });

  it('labels the initiative window band "Scheduled: Nov 14–16" in the timescale, clear of the bars', () => {
    render(<Harness plan={plan3()} scheduled={{ start: '2026-11-14', end: '2026-11-16' }} />);
    const label = q('.pln-window-label') as HTMLElement;
    expect(label.textContent).toBe('Scheduled: Nov 14–16');
    // in the timescale's top tier, not over the lanes
    expect(label.closest('.pln-scale-top')).not.toBeNull();
    expect(q('.pln-chart .pln-window-label')).toBeNull();
    const band = q('.pln-window') as HTMLElement;
    expect(px(band.style.width)).toBeCloseTo(3 * 48);
    // beside the band (it ends at or past the band's start), clear of every week's label ("Nov 16, '26" here)
    const [left, width] = [px(label.style.left), pillWidth(label.textContent ?? '')];
    expect(left + width).toBeGreaterThanOrEqual(px(band.style.left));
    expect(left).toBeLessThanOrEqual(px(band.style.left) + px(band.style.width));
    for (const tick of qa('.pln-scale-top .pln-tick')) {
      const [x, chars] = [px(tick.style.left), (tick.textContent ?? '').length];
      expect(left >= x + TIER_PAD + chars * TIER_CHAR_PX || left + width <= x).toBe(true);
    }
    // the band's span is tinted in the timescale too
    expect(px((q('.pln-scale .pln-window-cap') as HTMLElement).style.left)).toBeCloseTo(px(band.style.left));
  });

  it('moves the window label past the tier label held at the view’s left edge as the chart scrolls', () => {
    render(<Harness plan={plan3()} scheduled={{ start: '2026-11-03', end: '2026-11-04' }} />);
    const label = q('.pln-window-label') as HTMLElement;
    const text = label.textContent ?? '';
    const ticks = qa('.pln-scale-top .pln-tick')
      .map((t) => ({ x: px(t.style.left), width: px(t.style.width), label: t.textContent ?? '' }));
    const base = windowPillX(px((q('.pln-window') as HTMLElement).style.left), text, ticks);
    const at = (x: number) => {
      act(() => {
        chartBar().scrollLeft = x;
        chartBar().dispatchEvent(new Event('scroll'));
      });
      return px(label.style.left);
    };
    expect(at(0)).toBeCloseTo(pillAt(base, text, ticks, 0));
    // "Nov 2, '26" held at the view's edge (101px in) would run into it: it moves past
    expect(at(101)).toBeCloseTo(pillAt(base, text, ticks, 101));
    expect(at(101)).toBeGreaterThan(at(0));
  });

  it('falls back to the plan’s copy of the initiative window', () => {
    render(<Harness plan={plan3({ initiative_window: { start: '2026-11-30', end: '2026-12-02' } })} />);
    expect(q('.pln-window-label')?.textContent).toBe('Scheduled: Nov 30 – Dec 2');
  });

  it('draws the today line, the status date when set, and shades nonworking days at the days zoom', () => {
    const { rerender } = render(<Harness plan={plan3({ now: '2026-11-03T12:00' })} />);
    expect(qa('.pln-today')).toHaveLength(1);
    expect(qa('.pln-status-date')).toHaveLength(0);
    expect(qa('.pln-offday').length).toBeGreaterThan(0);
    // titled by a mark at its top in the timescale, not by the line over the bars
    expect(q('.pln-scale .pln-today-mark')?.getAttribute('title')).toBe('Today Tue 11/3/26');
    expect(q('.pln-scale .pln-today-mark')?.style.left).toBe((q('.pln-today') as HTMLElement).style.left);
    rerender(<Harness plan={plan3({ now: '2026-11-03T12:00', status_date: '2026-11-04T17:00' })} />);
    expect(qa('.pln-status-date')).toHaveLength(1);
    // told apart from the today line on hover
    expect(q('.pln-scale .pln-status-mark')?.getAttribute('title')).toBe('Status date Wed 11/4/26');
    rerender(<Harness plan={plan3()} zoom="weeks" />);
    expect(qa('.pln-offday')).toHaveLength(0);
  });
});

describe('drawing only what is visible (Review Focus 5)', () => {
  it('a 3-year plan at the hours zoom draws a window of the scale, never one element as wide as it', () => {
    const long = makeTask('long', { name: 'Hall build-out', start: '2026-01-05T08:00', finish: '2029-01-05T17:00' });
    const plan = makePlan({
      project_start: '2026-01-05T08:00', project_finish: '2029-01-05T17:00', tasks: [long],
      initiative_window: NO_WINDOW,
    });
    render(<Harness plan={plan} zoom="hours" />);
    const scale = scaleFor(plan, 'hours');
    expect(scale.width).toBeGreaterThan(500_000);
    expect(qa('.pln-tick').length).toBeLessThan(200);
    const gantt = q('.pln-gantt') as HTMLElement;
    for (const el of [gantt, ...gantt.querySelectorAll<HTMLElement>('*')]) {
      const width = el instanceof SVGElement ? Number(el.getAttribute('width') ?? 0) : px(el.style.width || '0');
      expect(width).toBeLessThanOrEqual(1600);
    }
    // the bar runs past the window: cut there, its end not drawn
    expect(q('.pln-bar[data-task-id="long"]')?.classList.contains('pln-cut-end')).toBe(true);
    // only the scrollbar's empty spacer spans the scale, so the scrollbar can reach its end
    expect(px((chartBar().firstElementChild as HTMLElement).style.width)).toBeCloseTo(scale.width);
  });

  it('a 1,500-task plan draws lanes, bars and links for the rendered rows only', () => {
    const tasks = Array.from({ length: 1500 }, (_, i) => makeTask(`t${i}`, {
      display_id: i + 1, wbs: String(i + 1), position: i, name: `Task ${i + 1}`,
    }));
    const links = [
      ...Array.from({ length: 1499 }, (_, i) => makeLink(`l${i}`, `t${i}`, `t${i + 1}`)),
      makeLink('far', 't0', 't1400'),
    ];
    render(<Harness plan={makePlan({ tasks, links, initiative_window: NO_WINDOW })} />);
    expect(qa('.pln-lane').length).toBeGreaterThan(0);
    expect(qa('.pln-lane').length).toBeLessThan(80);
    expect(qa('.pln-bar').length).toBeLessThan(80);
    const drawn = qa('svg.pln-links path.pln-link-path').map((p) => p.getAttribute('data-link'));
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(100);
    // t0 is in view: its link to row 1,400 runs off the bottom edge, as in MS Project
    expect(drawn).toContain('far');
    const svg = q('svg.pln-links') as unknown as SVGSVGElement;
    const height = Number(svg.getAttribute('height'));
    expect(height).toBeLessThan(80 * 30);
    const far = q('svg.pln-links path.pln-link-path[data-link="far"]')?.getAttribute('d') ?? '';
    const drops = [...far.matchAll(/V (-?[\d.]+)/g)].map((m) => Number(m[1]));
    // its far end is held one row past the SVG, which cuts it: the line leaves the edge, the SVG stays small
    expect(Math.max(...drops)).toBeGreaterThan(height);
    expect(Math.max(...drops)).toBeLessThan(height + 2 * 30);
    // the body is as tall as every row, as the sheet's is
    expect((q('.pln-chart') as HTMLElement).style.height).toBe(`${1500 * 30}px`);
  });

  it('moves the content sideways as the chart’s scrollbar scrolls, redrawing only past a lead', () => {
    const long = makeTask('long', { start: '2026-01-05T08:00', finish: '2029-01-05T17:00' });
    const plan = makePlan({ project_start: '2026-01-05T08:00', project_finish: '2029-01-05T17:00', tasks: [long],
      initiative_window: NO_WINDOW });
    render(<Harness plan={plan} zoom="hours" />);
    const shift = q('.pln-pane-chart > .pln-pane-shift') as HTMLElement;
    const firstTick = () => q('.pln-scale-top .pln-tick')?.textContent;
    const before = firstTick();
    act(() => {
      chartBar().scrollLeft = 300;
      chartBar().dispatchEvent(new Event('scroll'));
    });
    expect(shift.style.transform).toBe('translateX(-300px)');
    expect(firstTick()).toBe(before);
    // the top tier's labels hold to the view's left edge (no redraw: one custom property)
    const top = q('.pln-scale-top') as HTMLElement;
    expect(top.style.getPropertyValue('--pln-view-x')).toBe('300px');
    const tick = q('.pln-scale-top .pln-tick') as HTMLElement;
    expect(tick.style.getPropertyValue('--pln-tick-x')).toBe('0px');
    // its width and label length, so the label stops whole at the tick's end
    expect(tick.style.getPropertyValue('--pln-tick-w')).toBe(tick.style.width);
    expect(tick.style.getPropertyValue('--pln-label-ch')).toBe(String(tick.textContent?.length));
    act(() => {
      chartBar().scrollLeft = 50_000;
      chartBar().dispatchEvent(new Event('scroll'));
    });
    // a new window [49,600 .. 51,600): drawn from its own left edge
    expect(shift.style.transform).toBe('translateX(-400px)');
    expect(firstTick()).not.toBe(before);
    expect(top.style.getPropertyValue('--pln-view-x')).toBe('400px');
  });
});

describe('hover card', () => {
  it('shows the task’s details 180ms after the pointer comes to rest on its bar, and goes when it leaves', async () => {
    const tasks = tasks3();
    tasks[0] = { ...tasks[0], percent_complete: 40, deadline: '2026-11-06T17:00',
      assignees: [{ kind: 'person', id: 'p1', name: 'Dana Reyes' }] };
    render(<Harness plan={plan3({ tasks })} />);
    const bar = q('.pln-bar[data-task-id="a"]') as HTMLElement;
    fireEvent.mouseMove(bar, { clientX: 300, clientY: 200 });
    expect(q('.pln-hover')).toBeNull();
    const card = await waitFor(() => {
      const el = q('.pln-hover');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // nothing points at it and the chart it describes is hidden from the tree: so is the card
    expect(card.getAttribute('aria-hidden')).toBe('true');
    expect(card.getAttribute('role')).toBeNull();
    expect(card.querySelector('.pln-hover-name')?.textContent).toBe('Survey');
    const facts = [...card.querySelectorAll('dt')].map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`);
    expect(facts).toEqual([
      'Start: Mon 11/2/26', 'Finish: Mon 11/2/26', 'Duration: 1 day', '% Complete: 40%',
      'Resource Names: Dana Reyes', 'Deadline: Fri 11/6/26', 'Total Slack: 0 days',
    ]);
    fireEvent.mouseLeave(q('.pln-chart') as HTMLElement);
    expect(q('.pln-hover')).toBeNull();
  });

  it('shows and follows the pointer without redrawing the chart', async () => {
    render(<Harness plan={plan3()} />);
    const bar = q('.pln-bar[data-task-id="a"]') as HTMLElement;
    const ganttRenders = () => virt.calls.filter((c) => /PlanGantt/.test(c.stack)).length;
    const before = ganttRenders();
    fireEvent.mouseMove(bar, { clientX: 300, clientY: 200 });
    await waitFor(() => expect(q('.pln-hover')).not.toBeNull());
    const left = (q('.pln-hover') as HTMLElement).style.left;
    fireEvent.mouseMove(bar, { clientX: 340, clientY: 200 });
    await waitFor(() => expect((q('.pln-hover') as HTMLElement).style.left).not.toBe(left));
    // the card moved; the chart (its timescale, lanes and links) didn't render again
    expect(ganttRenders()).toBe(before);
  });

  it('goes when the chart scrolls sideways, or the view up and down', async () => {
    render(<Harness plan={plan3()} />);
    const bar = q('.pln-bar[data-task-id="b"]') as HTMLElement;
    fireEvent.mouseMove(bar, { clientX: 300, clientY: 200 });
    await waitFor(() => expect(q('.pln-hover')).not.toBeNull());
    act(() => {
      chartBar().scrollLeft = 120;
      chartBar().dispatchEvent(new Event('scroll'));
    });
    expect(q('.pln-hover')).toBeNull();
    fireEvent.mouseMove(bar, { clientX: 310, clientY: 200 });
    await waitFor(() => expect(q('.pln-hover')).not.toBeNull());
    act(() => { (q('.pln-panes') as HTMLElement).dispatchEvent(new Event('scroll')); });
    expect(q('.pln-hover')).toBeNull();
  });
});

describe('selection and scroll requests', () => {
  it('a press on a task’s lane selects its row; selected rows are marked', () => {
    const onSelect = vi.fn();
    render(<Harness plan={plan3()} onSelect={onSelect} selection={selectCell('c', 'duration')} />);
    expect(q('.pln-lane[data-lane="c"]')?.classList.contains('on')).toBe(true);
    expect(q('.pln-lane[data-lane="a"]')?.classList.contains('on')).toBe(false);
    fireEvent.mouseDown(q('.pln-lane[data-lane="b"]') as HTMLElement, { button: 0 });
    expect(onSelect).toHaveBeenCalledWith(selectCell('b', 'duration'));
  });

  it('opens at the project start, even when the initiative window lies months before it', () => {
    const plan = plan3();
    const scheduled = { start: '2026-09-07', end: '2026-09-25' };
    render(<Harness plan={plan} scheduled={scheduled} />);
    const scale = scaleFor(plan, 'days', scheduled);
    expect(chartBar().scrollLeft).toBeCloseTo(fitScrollLeft(scale, plan.project_start));
    expect(chartBar().scrollLeft).toBeGreaterThan(2000);
    expect(ids('.pln-bar')).toEqual(['a', 'b', 'c']);
  });

  it('Fit scrolls to the project start; Scroll to Task to the task’s bar', () => {
    const plan = plan3();
    const { rerender } = render(<Harness plan={plan} />);
    const scale = scaleFor(plan, 'days');
    rerender(<Harness plan={plan} scrollRequest={{ seq: 1, to: 'fit' }} />);
    expect(chartBar().scrollLeft).toBeCloseTo(fitScrollLeft(scale, plan.project_start));
    rerender(<Harness plan={plan} scrollRequest={{ seq: 2, to: 'task', taskId: 'c' }} />);
    expect(chartBar().scrollLeft).toBeCloseTo(taskScrollLeft(scale, plan.tasks[2]) as number);
    // the same request again is not a new one
    act(() => { chartBar().scrollLeft = 0; });
    rerender(<Harness plan={plan} scrollRequest={{ seq: 2, to: 'task', taskId: 'c' }} />);
    expect(chartBar().scrollLeft).toBe(0);
  });
});

describe('in the tab beside the sheet', () => {
  it('the sheet and the chart virtualize against the one scroll box, with the same settings', async () => {
    api.getPlan.mockResolvedValueOnce(plan3());
    const { container } = renderTab();
    await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
    const panes = container.querySelector('.pln-panes');
    const sheet = virt.calls.filter((c) => /PlanSheet/.test(c.stack));
    const gantt = virt.calls.filter((c) => /PlanGantt/.test(c.stack));
    expect(sheet.length).toBeGreaterThan(0);
    expect(gantt.length).toBeGreaterThan(0);
    const [s, g] = [sheet[sheet.length - 1].opts, gantt[gantt.length - 1].opts];
    expect((s.getScrollElement as () => Element)()).toBe(panes);
    expect((g.getScrollElement as () => Element)()).toBe(panes);
    for (const key of ['count', 'overscan', 'scrollMargin'] as const) expect(g[key]).toBe(s[key]);
    expect((g.estimateSize as (i: number) => number)(0)).toBe((s.estimateSize as (i: number) => number)(0));
  });

  it('collapsing a summary in the sheet hides its subtasks’ bars too', async () => {
    api.getPlan.mockResolvedValueOnce(makePlan({ tasks: outlineTasks() }));
    renderTab();
    await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
    expect(ids('.pln-bar')).toEqual(['a', 'b']);
    expect(ids('.pln-bar-summary')).toEqual(['s1', 's2']);
    fireEvent.click(within(grid()).getByRole('button', { name: 'Collapse Labels' }));
    expect(ids('.pln-bar')).toEqual(['a']);
    fireEvent.click(within(grid()).getByRole('button', { name: 'Collapse Prep' }));
    expect(ids('.pln-bar')).toEqual([]);
    expect(ids('.pln-bar-summary')).toEqual(['s1']);
    expect(ids('.pln-diamond')).toEqual(['c']);
    // the lanes line up with the sheet's rows, one for one
    expect(qa('.pln-lane').map((l) => l.getAttribute('data-lane'))).toEqual(['s1', 'c', 'blank']);
  });

  it('hides a link into a task collapsed away under its summary', async () => {
    api.getPlan.mockResolvedValueOnce(makePlan({
      tasks: outlineTasks(), links: [makeLink('ab', 'a', 'b'), makeLink('ac', 'a', 'c')],
    }));
    renderTab();
    await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
    const links = () => qa('svg.pln-links path.pln-link-path').map((p) => p.getAttribute('data-link'));
    expect(links()).toEqual(['ab', 'ac']);
    fireEvent.click(within(grid()).getByRole('button', { name: 'Collapse Labels' }));
    expect(links()).toEqual(['ac']);
  });

  it('each pane scrolls sideways on its own; the shared box never does', async () => {
    api.getPlan.mockResolvedValueOnce(plan3());
    const { container } = renderTab();
    await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
    const panes = container.querySelector('.pln-panes') as HTMLElement;
    const sheetShift = q('.pln-pane-sheet > .pln-pane-shift') as HTMLElement;
    const chartShift = q('.pln-pane-chart > .pln-pane-shift') as HTMLElement;
    const chartBefore = chartShift.style.transform;
    act(() => {
      sheetBar().scrollLeft = 120;
      sheetBar().dispatchEvent(new Event('scroll'));
    });
    expect(sheetShift.style.transform).toBe('translateX(-120px)');
    expect(chartShift.style.transform).toBe(chartBefore);
    act(() => {
      chartBar().scrollLeft = 300;
      chartBar().dispatchEvent(new Event('scroll'));
    });
    expect(chartShift.style.transform).toBe('translateX(-300px)');
    expect(sheetShift.style.transform).toBe('translateX(-120px)');
    expect(panes.scrollLeft).toBe(0);

    // a sideways wheel (trackpad swipe, Shift+wheel) over a pane scrolls that pane alone
    Object.defineProperty(sheetBar(), 'scrollWidth', { configurable: true, value: 3000 });
    expect(fireEvent.wheel(q('.pln-pane-sheet') as HTMLElement, { deltaX: 40 })).toBe(false);
    expect(sheetBar().scrollLeft).toBe(160);
    expect(sheetShift.style.transform).toBe('translateX(-160px)');
    expect(chartBar().scrollLeft).toBe(300);
    fireEvent.wheel(q('.pln-pane-sheet') as HTMLElement, { deltaY: 30, shiftKey: true });
    expect(sheetBar().scrollLeft).toBe(190);
    // a mostly-up-and-down swipe with a little sideways drift stays the browser's (native vertical scroll)
    expect(fireEvent.wheel(q('.pln-pane-sheet') as HTMLElement, { deltaX: 2, deltaY: 40 })).toBe(true);
    expect(sheetBar().scrollLeft).toBe(190);
  });

  it('keeps the zoom per plan; Ctrl+wheel over the chart zooms', async () => {
    api.getPlan.mockResolvedValue(plan3());
    renderTab();
    await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Zoom In' }));
    expect(localStorage.getItem('plans.zoom.plan-1')).toBe('hours');
    cleanup();
    renderTab();
    await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
    expect(screen.getByRole('button', { name: 'Zoom In' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.wheel(q('.pln-pane-chart') as HTMLElement, { deltaY: 100, ctrlKey: true });
    expect(localStorage.getItem('plans.zoom.plan-1')).toBe('days');
  });

  it('Fit picks the zoom from the chart pane’s width and scrolls to the project start', async () => {
    localStorage.setItem('plans.zoom.plan-1', 'hours');
    const plan = plan3();
    api.getPlan.mockResolvedValueOnce(plan);
    renderTab();
    await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
    fireEvent.click(screen.getByRole('button', { name: 'Fit Project' }));
    // 3.4 days fit 800px at 48px a day (162px), not at 480 (1,620px)
    expect(localStorage.getItem('plans.zoom.plan-1')).toBe('days');
    const scale = scaleFor(plan, 'days', { start: INITIATIVE.scheduled_start, end: INITIATIVE.scheduled_end });
    await waitFor(() => expect(chartBar().scrollLeft).toBeCloseTo(fitScrollLeft(scale, plan.project_start)));
  });

  it('Scroll to Task scrolls the chart to the selected task’s bar', async () => {
    const plan = plan3();
    api.getPlan.mockResolvedValueOnce(plan);
    renderTab();
    await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
    const row = within(grid()).getAllByRole('row').find((r) => r.getAttribute('data-task') === 'c') as HTMLElement;
    fireEvent.mouseDown(row.querySelector('[data-col="name"]') as HTMLElement, { button: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to Task' }));
    const scale = scaleFor(plan, 'days', { start: INITIATIVE.scheduled_start, end: INITIATIVE.scheduled_end });
    await waitFor(() => expect(chartBar().scrollLeft).toBeCloseTo(taskScrollLeft(scale, plan.tasks[2]) as number));
  });

  it('the splitter moves the sheet’s edge, by drag or arrows, and keeps its place', async () => {
    api.getPlan.mockResolvedValue(plan3());
    renderTab();
    await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
    const split = () => q('.pln-split')?.style.getPropertyValue('--pln-split');
    const splitter = screen.getByRole('separator', { name: 'Resize the task sheet' });
    // 45% of the 800px view until moved
    expect(split()).toBe('360px');
    expect(splitter.getAttribute('aria-valuenow')).toBe('360');
    expect(splitter.getAttribute('aria-valuetext')).toBe('Sheet 360 pixels wide');
    fireEvent.pointerDown(splitter, { clientX: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(splitter, { clientX: 560, pointerId: 1 });
    expect(split()).toBe('420px');
    fireEvent.pointerUp(splitter, { clientX: 560, pointerId: 1 });
    expect(localStorage.getItem('plans.split.v1')).toBe('420');
    fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
    expect(split()).toBe('404px');
    expect(localStorage.getItem('plans.split.v1')).toBe('404');
    cleanup();
    renderTab();
    await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
    expect(split()).toBe('404px');
  });
});
