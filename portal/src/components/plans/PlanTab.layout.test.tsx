// @vitest-environment jsdom
/**
 * The Gantt view's layouts (Task 10b) and the hover tips on the tab's own
 * commands. Beside (the default): the sheet, the splitter and the chart
 * side by side in one scroll box. Below: the sheet on top, a horizontal
 * splitter, the chart under it, each pane in its own scroller, the two kept
 * on the same row both ways without a feedback loop, the bars labeled with
 * their tasks' names; selection, drag, the hover card, Fit and Scroll to
 * Task all on the chart's own scroller. Hidden: no chart at all, the
 * chart-only commands off. The layout is kept for the browser
 * (`plans.layout.v1`), Below's split height apart (`plans.split.below.v1`);
 * a switch keeps the selection and the vertical position, row for row; full
 * screen works in all three. The real PlanTab and usePlan run against a
 * mocked lib/plans/api.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Plan, PlanTask } from '../../lib/plans/api';
import { COMMAND_TIPS, OFF_NOTES } from '../../lib/plans/commandTips';
import { fitScrollLeft, makeScale, xOf, type Zoom } from '../../lib/plans/ganttGeometry';
import {
  LABEL_MAX_PX, LAYOUT_KEY, SPLIT_BELOW_KEY, SPLIT_KEY, chartWindow, scaleSpan, taskScrollLeft, windowSpan,
} from '../../lib/plans/ganttView';
import { makeOpsResult, makePlan, makeTask } from '../../lib/plans/planFixtures';
import { planShortcutKeys } from '../../lib/plans/shortcuts';
import { TIP_DELAY_MS } from '../Tip';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const auth = vi.hoisted(() => ({
  plans: { view: true, add: true, change: true, delete: true } as Record<string, boolean>,
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string, action = 'view') => resource === 'project_plans' && auth.plans[action] === true,
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
const virt = vi.hoisted(() => ({
  calls: [] as { opts: Record<string, unknown>; stack: string; el: Element | null }[],
}));
vi.mock('@tanstack/react-virtual', async (importActual) => {
  const actual = await importActual<typeof import('@tanstack/react-virtual')>();
  return {
    ...actual,
    useVirtualizer: ((opts: Parameters<typeof actual.useVirtualizer>[0]) => {
      virt.calls.push({
        opts: opts as unknown as Record<string, unknown>, stack: new Error().stack ?? '',
        el: (opts.getScrollElement as () => Element | null)(),
      });
      return actual.useVirtualizer(opts);
    }) as typeof actual.useVirtualizer,
  };
});

const { default: PlanTab } = await import('./PlanTab');

const INITIATIVE = { name: 'NAP11 Hall Migration', scheduled_start: '2026-11-14', scheduled_end: '2026-11-16' };
const ROW = 30;
const HEAD = 44;

/** 40 one-day tasks, two a day from Mon Nov 2: t0 … t39. */
function tasks40(): PlanTask[] {
  return Array.from({ length: 40 }, (_, i) => {
    const day = String(2 + Math.floor(i / 2)).padStart(2, '0');
    return makeTask(`t${i}`, {
      display_id: i + 1, wbs: String(i + 1), position: i, name: `Step ${i + 1}`,
      start: `2026-11-${day}T08:00`, finish: `2026-11-${day}T17:00`,
    });
  });
}
const plan40 = (over: Partial<Plan> = {}) => makePlan({
  tasks: tasks40(), project_finish: '2026-11-21T17:00', ...over,
});

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/initiatives/init-1?tab=plan']}>
      <Routes>
        <Route path="/initiatives/:id" element={<PlanTab initiativeId="init-1" initiative={INITIATIVE} />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function ready(plan: Plan = plan40()) {
  api.getPlan.mockResolvedValue(plan);
  const view = renderTab();
  await screen.findByRole('grid', { name: 'Task sheet' }, { timeout: 3000 });
  return view;
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const button = (name: string) => screen.getByRole('button', { name });
const grid = () => screen.getByRole('grid', { name: 'Task sheet' });
const scrollers = () => qa('.pln-panes');
const sheetBox = () => (q('.pln-pane-sheet') as HTMLElement).closest('.pln-panes') as HTMLElement;
const chartBox = () => (q('.pln-pane-chart') as HTMLElement).closest('.pln-panes') as HTMLElement;
const chartBar = () => q('.pln-pane-chart > .pln-hbar') as HTMLElement;
const rowOf = (id: string) => within(grid()).getAllByRole('row').find((r) => r.getAttribute('data-task') === id) as HTMLElement;
const sheetIds = () => within(grid()).getAllByRole('row').map((r) => r.getAttribute('data-task')).filter(Boolean);
const laneIds = () => qa('.pln-lane').map((l) => l.getAttribute('data-lane')).filter((id) => id !== 'blank');
/** Picks a layout from the Display group's Gantt Layout menu (`detail` 1: a mouse click). */
function choose(layout: 'Beside' | 'Below' | 'Hidden', detail = 0) {
  fireEvent.click(button('Gantt Layout'), { detail });
  fireEvent.click(screen.getByRole('menuitemradio', { name: layout }), { detail });
}
/** The layout the menu has checked (it opens and closes the menu). */
function checkedLayout(): string | null {
  fireEvent.click(button('Gantt Layout'));
  const on = screen.getAllByRole('menuitemradio').find((i) => i.getAttribute('aria-checked') === 'true');
  fireEvent.keyDown(document, { key: 'Escape' });
  return on?.getAttribute('aria-label') ?? null;
}

/** The browser's part in a scroll the person makes: the box moves, then
 *  says so. (jsdom fires no scroll event of its own.) */
function userScroll(el: HTMLElement, top: number) {
  act(() => {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
  });
}

/** Records the scrollTop writes code makes on `el` (a person's scroll goes
 *  through `userScroll`, which this sees too: tests read `writes` after it). */
function watchTop(el: HTMLElement) {
  let top = el.scrollTop;
  const writes: number[] = [];
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = v; writes.push(v); },
  });
  return writes;
}

/** The scale the chart draws for a plan in the tab (the initiative window widens it). */
function scaleFor(plan: Plan, zoom: Zoom = 'days') {
  const span = scaleSpan(plan.project_start, plan.project_finish,
    windowSpan({ start: INITIATIVE.scheduled_start, end: INITIATIVE.scheduled_end }));
  return makeScale(span.start, span.finish, zoom);
}

/** What a hover on `el` shows (fake timers). */
function hoverTip(el: HTMLElement) {
  fireEvent.pointerEnter(el);
  act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
  const tip = screen.getByRole('tooltip');
  const read = {
    label: tip.querySelector('.tip-label')?.textContent ?? '',
    keys: [...tip.querySelectorAll('kbd')].map((k) => k.textContent),
    desc: tip.querySelector('.tip-desc')?.textContent ?? null,
    note: tip.querySelector('.tip-note')?.textContent ?? null,
  };
  fireEvent.pointerLeave(el);
  return read;
}

// jsdom does no layout: every box gets a size, so each virtualizer sees a
// 600px-tall scroller and the chart an 800px-wide pane
const SIZES = ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth'] as const;
const realSizes = SIZES.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
  ?? Object.getOwnPropertyDescriptor(Element.prototype, key));
const RECT = { top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, x: 0, y: 0, toJSON: () => ({}) };
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(RECT as DOMRect);
  for (const [key, size] of [['offsetHeight', 600], ['offsetWidth', 1200], ['clientHeight', 600], ['clientWidth', 800]] as const) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => size });
  }
  for (const fn of [toast, ...Object.values(api)]) fn.mockReset();
  auth.plans = { view: true, add: true, change: true, delete: true };
  virt.calls = [];
  localStorage.clear();
  // a browser's scrollTo, which the virtualizers scroll with (jsdom has none,
  // so a virtualizer's scroll would otherwise go unseen)
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    value(this: HTMLElement, opts: ScrollToOptions) {
      if (typeof opts === 'object' && opts.top !== undefined) this.scrollTop = opts.top;
      if (typeof opts === 'object' && opts.left !== undefined) this.scrollLeft = opts.left;
    },
  });
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
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTo;
  localStorage.clear();
});

describe('the layout control', () => {
  it('Beside by default: the sheet, the splitter and the chart side by side in one scroll box', async () => {
    await ready();
    expect(checkedLayout()).toBe('Beside');
    expect(button('Gantt Layout').querySelector('svg')?.getAttribute('data-layout')).toBe('beside');
    expect(scrollers()).toHaveLength(1);
    expect(sheetBox()).toBe(chartBox());
    expect(screen.getByRole('separator', { name: 'Resize the task sheet' }).getAttribute('aria-orientation'))
      .toBe('vertical');
    expect(q('.pln-view')?.getAttribute('data-layout')).toBe('beside');
  });

  it('Below: the sheet above the chart, each in its own scroller, a horizontal splitter between; kept for the browser', async () => {
    await ready();
    virt.calls = [];
    choose('Below');
    expect(localStorage.getItem(LAYOUT_KEY)).toBe('below');
    expect(checkedLayout()).toBe('Below');
    expect(q('.pln-view')?.getAttribute('data-layout')).toBe('below');
    expect(scrollers()).toHaveLength(2);
    const [top, bottom] = scrollers();
    expect(top.contains(q('.pln-pane-sheet'))).toBe(true);
    expect(bottom.contains(q('.pln-pane-chart'))).toBe(true);
    const splitter = screen.getByRole('separator', { name: 'Resize the task sheet' });
    expect(splitter.getAttribute('aria-orientation')).toBe('horizontal');
    // sheet, then the splitter, then the chart, down the view
    expect(top.compareDocumentPosition(splitter) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(splitter.compareDocumentPosition(bottom) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // each virtualizes against its own scroller, with the same settings
    const last = (re: RegExp) => virt.calls.filter((c) => re.test(c.stack)).at(-1)?.opts as Record<string, unknown>;
    const [s, g] = [last(/PlanSheet/), last(/PlanGantt/)];
    expect((s.getScrollElement as () => Element)()).toBe(top);
    expect((g.getScrollElement as () => Element)()).toBe(bottom);
    for (const key of ['count', 'overscan', 'scrollMargin'] as const) expect(g[key]).toBe(s[key]);
    expect(g.scrollMargin).toBe(HEAD);
    // the chart is drawn once its box exists: its virtualizer has the box from its first render
    const chartCalls = virt.calls.filter((c) => /PlanGantt/.test(c.stack) && c.el !== top);
    expect(chartCalls.length).toBeGreaterThan(0);
    expect(chartCalls.every((c) => c.el === bottom)).toBe(true);
    // the sheet's and the chart's sticky headers and sideways scrollbars, one each per pane
    expect(top.querySelectorAll('.pln-sheet-head')).toHaveLength(1);
    expect(bottom.querySelectorAll('.pln-scale')).toHaveLength(1);
    expect(top.querySelectorAll('.pln-hbar')).toHaveLength(1);
    expect(bottom.querySelectorAll('.pln-hbar')).toHaveLength(1);

    cleanup();
    await ready();
    expect(checkedLayout()).toBe('Below');
    expect(scrollers()).toHaveLength(2);
  });

  it('a stored layout that isn’t one opens Beside', async () => {
    localStorage.setItem(LAYOUT_KEY, 'sideways');
    await ready();
    expect(checkedLayout()).toBe('Beside');
    expect(scrollers()).toHaveLength(1);
  });

  it('Hidden: no chart at all, the sheet the whole width; the chart-only commands off, saying why', async () => {
    const plan = plan40();
    await ready(plan);
    choose('Hidden');
    expect(localStorage.getItem(LAYOUT_KEY)).toBe('hidden');
    expect(q('.pln-pane-chart')).toBeNull();
    expect(q('.pln-gantt')).toBeNull();
    expect(screen.queryByRole('separator', { name: 'Resize the task sheet' })).toBeNull();
    expect(scrollers()).toHaveLength(1);
    expect(q('.pln-view')?.getAttribute('data-layout')).toBe('hidden');
    // no virtualizer for a chart that isn't there
    virt.calls = [];
    fireEvent.mouseDown(rowOf('t3').querySelector('[data-col="name"]') as HTMLElement, { button: 0 });
    expect(virt.calls.some((c) => /PlanGantt/.test(c.stack))).toBe(false);
    const fit = button('Fit Project');
    expect(fit.getAttribute('aria-disabled')).toBe('true');
    vi.useFakeTimers();
    expect(hoverTip(fit).note).toBe(OFF_NOTES.noChart);
    vi.useRealTimers();
    fireEvent.click(fit);
    expect(localStorage.getItem('plans.zoom.plan-1')).toBeNull();
    // Ctrl+Shift+F5 (Scroll to Task) has no chart to scroll: the sheet doesn't move either
    const box = sheetBox();
    const writes = watchTop(box);
    // handled, as a disabled button would be: the browser doesn't reload on it either
    expect(fireEvent.keyDown(grid(), { key: 'F5', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(writes).toEqual([]);
    // the rest of the toolbar works
    expect(button('Indent').getAttribute('aria-disabled')).toBeNull();
    choose('Beside');
    expect(q('.pln-pane-chart')).not.toBeNull();
  });
});

describe('Below: two scrollers on the same row', () => {
  it('scrolling the sheet moves the chart to the same scrollTop and back, with no feedback loop', async () => {
    await ready();
    choose('Below');
    const sheet = sheetBox();
    const chart = chartBox();
    const sheetWrites = watchTop(sheet);
    const chartWrites = watchTop(chart);

    userScroll(sheet, 450);
    expect(chart.scrollTop).toBe(450);
    sheetWrites.length = 0;
    // the browser's scroll event for that write: nothing is written back
    act(() => { chart.dispatchEvent(new Event('scroll')); });
    expect(sheetWrites).toEqual([]);
    expect(chartWrites).toEqual([450]);

    chartWrites.length = 0;
    userScroll(chart, 900);
    expect(sheet.scrollTop).toBe(900);
    chartWrites.length = 0;
    act(() => { sheet.dispatchEvent(new Event('scroll')); });
    expect(chartWrites).toEqual([]);
    expect(chart.scrollTop).toBe(900);

    // already level: a scroll event writes nothing
    sheetWrites.length = 0;
    act(() => { chart.dispatchEvent(new Event('scroll')); });
    expect(sheetWrites).toEqual([]);

    // and the chart's lanes are the sheet's rows
    await waitFor(() => expect(laneIds()).toEqual(sheetIds()));
  });

  it('the panes stay the same height for scrolling: the taller one gets the difference at its end', async () => {
    await ready();
    // a 300px sheet over a 400px chart
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains('pln-panes-sheet')) return 300;
        return this.classList.contains('pln-panes-chart') ? 400 : 600;
      },
    });
    choose('Below');
    await waitFor(() => {
      expect((q('.pln-pane-chart > .pln-pane-shift') as HTMLElement).style.paddingBottom).toBe('100px');
    });
    expect((q('.pln-pane-sheet > .pln-pane-shift') as HTMLElement).style.paddingBottom).toBe('');
    // the same rows in both, to the last: scrolled to the end, both stop at the same place
    userScroll(sheetBox(), 5000);
    expect(chartBox().scrollTop).toBe(5000);
    choose('Beside');
    expect((q('.pln-pane-sheet > .pln-pane-shift') as HTMLElement).style.paddingBottom).toBe('');
  });
});

describe('switching layouts', () => {
  it('keeps the selection and the vertical position, row for row', async () => {
    await ready();
    fireEvent.mouseDown(rowOf('t20').querySelector('[data-col="name"]') as HTMLElement, { button: 0 });
    const selected = () => rowOf('t20').getAttribute('aria-selected');
    const before = selected();
    userScroll(sheetBox(), 450);

    choose('Below');
    expect(sheetBox().scrollTop).toBe(450);
    expect(chartBox().scrollTop).toBe(450);
    expect(selected()).toBe(before);
    expect(q('.pln-lane[data-lane="t20"]')?.classList.contains('on')).toBe(true);

    choose('Hidden');
    expect(sheetBox().scrollTop).toBe(450);
    expect(selected()).toBe(before);

    choose('Beside');
    expect(sheetBox().scrollTop).toBe(450);
    expect(sheetBox()).toBe(chartBox());
    expect(q('.pln-lane[data-lane="t20"]')?.classList.contains('on')).toBe(true);

    // Below scrolled from the chart, back to Beside: the chart's row is the one shown
    choose('Below');
    userScroll(chartBox(), 630);
    choose('Beside');
    expect(sheetBox().scrollTop).toBe(630);
  });

  it('a mouse click on a layout with nothing selected keeps the place too (no first row selected)', async () => {
    await ready();
    userScroll(sheetBox(), 450);
    choose('Below', 1);
    expect(sheetBox().scrollTop).toBe(450);
    expect(chartBox().scrollTop).toBe(450);
    choose('Hidden', 1);
    expect(sheetBox().scrollTop).toBe(450);
    expect(within(grid()).getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true')).toEqual([]);
  });

  it('a toolbar command clicked with nothing selected selects no row and keeps the place (focus comes back quietly)', async () => {
    await ready();
    userScroll(sheetBox(), 450);
    fireEvent.click(button('Zoom In'), { detail: 1 });
    expect(localStorage.getItem('plans.zoom.plan-1')).toBe('hours');
    // the command handed focus back to the sheet, which took it without selecting its first row
    expect(document.activeElement).toBe(grid());
    expect(within(grid()).getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true')).toEqual([]);
    expect(grid().querySelector('[aria-selected="true"], .on')).toBeNull();
    expect(sheetBox().scrollTop).toBe(450);
    expect(grid().hasAttribute('data-quiet-focus')).toBe(false);
  });

  it('full screen works in all three', async () => {
    const { container } = await ready();
    const root = container.querySelector('.pln-tab') as HTMLElement;
    for (const [layout, boxes, chart] of [['Below', 2, true], ['Hidden', 1, false], ['Beside', 1, true]] as const) {
      choose(layout);
      fireEvent.click(button('Full screen'));
      expect(root.classList.contains('pln-fullscreen'), layout).toBe(true);
      expect(scrollers(), layout).toHaveLength(boxes);
      expect(q('.pln-pane-chart') !== null, layout).toBe(chart);
      // the layout can change in full screen too
      expect(checkedLayout()).toBe(layout);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(root.classList.contains('pln-fullscreen'), layout).toBe(false);
    }
    fireEvent.click(button('Full screen'));
    choose('Below');
    expect(root.classList.contains('pln-fullscreen')).toBe(true);
    expect(scrollers()).toHaveLength(2);
  });
});

describe('Below: the chart on its own scroller', () => {
  it('draws each task’s name at its bar; Beside doesn’t', async () => {
    await ready();
    expect(qa('.pln-bar-label')).toHaveLength(0);
    choose('Below');
    const label = q('.pln-lane[data-lane="t30"] .pln-bar-label') as HTMLElement;
    expect(label?.textContent).toBe('Step 31');
    expect(label.getAttribute('title')).toBeNull();
    choose('Beside');
    expect(qa('.pln-bar-label')).toHaveLength(0);
  });

  it('opens with room for the names left of the first bars', async () => {
    const plan = plan40();
    await ready(plan);
    // beside the sheet: at the project start
    const start = fitScrollLeft(scaleFor(plan, 'days'), plan.project_start);
    expect(start).toBeGreaterThan(0);
    expect(chartBar().scrollLeft).toBeCloseTo(start);
    // opened under it: the names' room further left, as far as the scale goes
    cleanup();
    localStorage.setItem(LAYOUT_KEY, 'below');
    await ready(plan);
    expect(chartBar().scrollLeft).toBeCloseTo(Math.max(0, start - LABEL_MAX_PX));
    cleanup();
    localStorage.setItem('plans.zoom.plan-1', 'months');
    await ready(plan);
    const later = fitScrollLeft(scaleFor(plan, 'months'), plan.project_start);
    expect(later).toBeGreaterThan(LABEL_MAX_PX);
    expect(chartBar().scrollLeft).toBeCloseTo(later - LABEL_MAX_PX);
  });

  it('keeps the chart’s place in time across a switch: Beside → Below → Hidden → Beside', async () => {
    const plan = plan40();
    await ready(plan);
    const scrollChartTo = (x: number) => act(() => {
      chartBar().scrollLeft = x;
      chartBar().dispatchEvent(new Event('scroll'));
    });
    scrollChartTo(1234);
    choose('Below');
    // the same moment at the left edge (the same zoom: the same px), not the project start
    expect(chartBar().scrollLeft).toBeCloseTo(1234);
    scrollChartTo(1500);
    choose('Hidden');
    expect(q('.pln-pane-chart')).toBeNull();
    choose('Beside');
    expect(chartBar().scrollLeft).toBeCloseTo(1500);
    // the content is drawn there too: the window follows the restored scroll
    const shift = q('.pln-pane-chart > .pln-pane-shift') as HTMLElement;
    const [from] = chartWindow(1500, 800, scaleFor(plan).width);
    expect(from).toBeGreaterThan(0);
    expect(shift.style.transform).toBe(`translateX(${from - 1500}px)`);
    // another zoom is another scale: still the same moment, in its px
    fireEvent.click(button('Zoom Out'));
    const atWeeks = chartBar().scrollLeft;
    choose('Below');
    expect(chartBar().scrollLeft).toBeCloseTo(atWeeks);
  });

  it('Fit picks the zoom from the chart pane, less the names’ room, and scrolls the chart; Scroll to Task brings the row and the bar', async () => {
    localStorage.setItem('plans.zoom.plan-1', 'hours');
    const plan = plan40();
    await ready(plan);
    choose('Below');
    fireEvent.click(button('Fit Project'));
    // 20 days don't fit the 600px the names leave of 800 at the days zoom (960px); at the weeks zoom they do
    expect(localStorage.getItem('plans.zoom.plan-1')).toBe('weeks');
    await waitFor(() => expect(chartBar().scrollLeft)
      .toBeCloseTo(Math.max(0, fitScrollLeft(scaleFor(plan, 'weeks'), plan.project_start) - LABEL_MAX_PX)));

    const sheet = sheetBox();
    const chart = chartBox();
    fireEvent.mouseDown(rowOf('t30').querySelector('[data-col="name"]') as HTMLElement, { button: 0 });
    fireEvent.click(button('Scroll to Task'));
    // the row comes to the middle of the sheet; the chart follows it there
    await waitFor(() => expect(sheet.scrollTop).toBeGreaterThan(0));
    act(() => { sheet.dispatchEvent(new Event('scroll')); });
    expect(chart.scrollTop).toBe(sheet.scrollTop);
    await waitFor(() => expect(chartBar().scrollLeft)
      .toBeCloseTo(taskScrollLeft(scaleFor(plan, 'weeks'), plan.tasks[30]) as number));
  });

  it('the hover card goes when the chart’s own scroller scrolls', async () => {
    await ready();
    choose('Below');
    const bar = q('.pln-bar[data-task-id="t2"]') as HTMLElement;
    fireEvent.mouseMove(bar, { clientX: 300, clientY: 200 });
    await waitFor(() => expect(q('.pln-hover')).not.toBeNull());
    act(() => { chartBox().dispatchEvent(new Event('scroll')); });
    expect(q('.pln-hover')).toBeNull();
    // the sheet scrolling moves the chart, and so takes the card too
    fireEvent.mouseMove(bar, { clientX: 310, clientY: 200 });
    await waitFor(() => expect(q('.pln-hover')).not.toBeNull());
    userScroll(sheetBox(), 60);
    act(() => { chartBox().dispatchEvent(new Event('scroll')); });
    expect(q('.pln-hover')).toBeNull();
  });

  it('a link dragged on the chart scrolled mid-plan lands on the row under the pointer', async () => {
    const plan = plan40();
    await ready(plan);
    choose('Below');
    const chart = chartBox();
    // laid out as a browser would: the sheet's 297px and the splitter's 6 above
    // the chart's scroller; its body starts under the 44px timescale, moved up by its scroll
    const CHART_TOP = 297 + 6;
    userScroll(chart, 10 * ROW);
    const bodyTop = CHART_TOP + HEAD - chart.scrollTop;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('pln-chart')) {
        return { ...RECT, top: bodyTop, y: bodyTop, bottom: bodyTop + 40 * ROW, height: 40 * ROW } as DOMRect;
      }
      return RECT as DOMRect;
    });
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7 }));
    const scale = scaleFor(plan);
    const x = (time: string) => xOf(scale, time) - chartBar().scrollLeft;
    const y = (row: number) => bodyTop + row * ROW + ROW / 2;
    const dot = q('.pln-link-dot[data-task-id="t12"]') as HTMLElement;
    fireEvent.pointerDown(dot, { clientX: x('2026-11-08T17:00') + 6, clientY: y(12), pointerId: 1, button: 0 });
    fireEvent.pointerMove(dot, { clientX: x('2026-11-09T12:00'), clientY: y(14), pointerId: 1 });
    expect(q('.pln-drag-tip')?.textContent).toContain('Step 15');
    fireEvent.pointerUp(dot, { clientX: x('2026-11-09T12:00'), clientY: y(14), pointerId: 1 });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(api.postOps.mock.calls[0][2]).toEqual([
      { op: 'add_link', predecessor_id: 't12', successor_id: 't14', link_type: 'FS' },
    ]);
  });

  it('the splitter moves the sheet’s bottom edge by drag or arrows, and keeps its place apart from Beside’s', async () => {
    localStorage.setItem(SPLIT_KEY, '404');
    await ready();
    choose('Below');
    const height = () => (scrollers()[0] as HTMLElement).style.height;
    const splitter = screen.getByRole('separator', { name: 'Resize the task sheet' });
    // half the 600px view (less the splitter) until moved
    expect(height()).toBe('297px');
    expect(splitter.getAttribute('aria-valuetext')).toBe('Sheet 297 pixels tall');
    fireEvent.pointerDown(splitter, { clientY: 300, pointerId: 1, button: 0 });
    fireEvent.pointerMove(splitter, { clientY: 340, pointerId: 1 });
    expect(height()).toBe('337px');
    fireEvent.pointerUp(splitter, { clientY: 340, pointerId: 1 });
    expect(localStorage.getItem(SPLIT_BELOW_KEY)).toBe('337');
    fireEvent.keyDown(splitter, { key: 'ArrowUp' });
    expect(height()).toBe('321px');
    fireEvent.keyDown(splitter, { key: 'ArrowDown', shiftKey: true });
    expect(height()).toBe('385px');
    expect(localStorage.getItem(SPLIT_BELOW_KEY)).toBe('385');
    // sideways arrows are Beside's
    fireEvent.keyDown(splitter, { key: 'ArrowLeft' });
    expect(height()).toBe('385px');
    expect(localStorage.getItem(SPLIT_KEY)).toBe('404');
    choose('Beside');
    expect(q('.pln-split')?.style.getPropertyValue('--pln-split')).toBe('404px');
  });
});

describe('hover tips on the tab’s own commands', () => {
  it('the view switcher, Full screen and its Esc, the lock banner’s Unlock: a tip each, no native title', async () => {
    await ready(plan40({ locked_at: '2026-10-28T15:30:00Z', locked_by_name: 'Dana Reyes' }));
    vi.useFakeTimers();
    const bar = screen.getByRole('toolbar', { name: 'Project plan' });
    const buttons = [...within(bar).getAllByRole('button'),
      within(screen.getByRole('status', { name: 'Schedule locked' })).getByRole('button', { name: 'Unlock' })];
    for (const b of buttons) {
      const copy = b.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
      const name = b.getAttribute('aria-label') ?? (copy.textContent ?? '').trim();
      const tip = hoverTip(b);
      expect(tip.label, name).toBe(name);
      const entry = Object.values(COMMAND_TIPS).find((t) => t.label === tip.label);
      expect(entry, name).toBeDefined();
      expect(tip.desc, name).toBeTruthy();
      expect(b.hasAttribute('title'), name).toBe(false);
    }
    expect(hoverTip(button('Gantt')).desc).toBe(COMMAND_TIPS.viewGantt.desc);
    expect(hoverTip(button('Unlock')).desc).toBe(COMMAND_TIPS.unlock.desc);
    // a locked plan: the schedule commands say why they're off
    expect(hoverTip(button('Indent')).note).toBe('Schedule is locked');
    vi.useRealTimers();
    fireEvent.click(button('Full screen'));
    vi.useFakeTimers();
    const exit = hoverTip(button('Exit full screen'));
    expect(exit.keys).toEqual([planShortcutKeys('exitFullScreen', 'win')]);
    expect(exit.keys).toEqual(['Esc']);
    expect(exit.desc).toBe('Show the portal’s menus and page header again.');
  });
});
