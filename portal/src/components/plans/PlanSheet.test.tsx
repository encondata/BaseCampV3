// @vitest-environment jsdom
/**
 * components/plans/PlanSheet.tsx: the task sheet, display only — headers in
 * MS Project order, outline rows with collapse chevrons (collapse state per
 * plan in localStorage), indicators with tooltips, the Columns dialog, the
 * `&task=` deep link, and virtualized rows for large plans (Review Focus
 * 5). The sheet runs inside the real PlanTab and usePlan against a mocked
 * lib/plans/api, plus one direct render for the props contract the Gantt
 * shares.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Plan, PlanTask } from '../../lib/plans/api';
import { makePlan, makeTask } from '../../lib/plans/planFixtures';
import { planView } from '../../lib/plans/merge';
import { EMPTY_SELECTION, selectCell } from '../../lib/plans/selection';
import type { PlanController } from './usePlan';
import { findSheet } from './planTabTesting';

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

// counts each row's redraws: a row draws its indicators once per render
const drawn = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('../../lib/plans/indicators', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/plans/indicators')>();
  return {
    ...actual,
    indicatorsOf: (...args: Parameters<typeof actual.indicatorsOf>) => {
      drawn.ids.push(args[0].id);
      return actual.indicatorsOf(...args);
    },
  };
});

const { default: PlanTab } = await import('./PlanTab');
const { default: PlanSheet } = await import('./PlanSheet');

const INITIATIVE = { name: 'NAP11 Hall Migration', scheduled_start: '2026-11-14', scheduled_end: '2026-11-16' };
const COLLAPSED_KEY = 'plans.collapsed.plan-1';

/** Prep (summary) › Order crates, Labels (summary) › Print labels; Go live. */
function outlineTasks(): PlanTask[] {
  return [
    makeTask('s1', { display_id: 1, wbs: '1', outline_level: 1, position: 0, is_summary: true, name: 'Prep' }),
    makeTask('a', {
      display_id: 2, wbs: '1.1', outline_level: 2, position: 0, parent_id: 's1', name: 'Order crates',
      constraint_type: 'snet', constraint_date: '2026-11-05T08:00',
    }),
    makeTask('s2', {
      display_id: 3, wbs: '1.2', outline_level: 2, position: 1, parent_id: 's1', is_summary: true, name: 'Labels',
    }),
    makeTask('b', { display_id: 4, wbs: '1.2.1', outline_level: 3, position: 0, parent_id: 's2', name: 'Print labels' }),
    makeTask('c', { display_id: 5, wbs: '2', outline_level: 1, position: 1, name: 'Go live', is_milestone: true }),
  ];
}

const outlinePlan = (over: Partial<Plan> = {}) => makePlan({ tasks: outlineTasks(), ...over });

function renderTab(search = '?tab=plan') {
  return render(
    <MemoryRouter initialEntries={[`/initiatives/init-1${search}`]}>
      <Routes>
        <Route path="/initiatives/:id" element={<PlanTab initiativeId="init-1" initiative={INITIATIVE} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const grid = () => screen.getByRole('grid', { name: 'Task sheet' });
const headers = () => within(grid()).getAllByRole('columnheader').map((h) => h.textContent);
/** More › Columns… (the toolbar's More menu). */
async function openColumns(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'More' }));
  await user.click(screen.getByRole('menuitem', { name: 'Columns…' }));
}
/** The task rows on screen (not the header, not the blank new-task row), by name. */
const rowNames = () => within(grid()).getAllByRole('row')
  .filter((r) => r.hasAttribute('data-task'))
  .map((r) => r.querySelector('[data-col="name"]')?.textContent);
const rowOf = (name: string) => within(grid()).getAllByRole('row')
  .find((r) => r.querySelector('[data-col="name"]')?.textContent === name) as HTMLElement;

// jsdom does no layout: give every box a size, so the virtualizer (which
// reads the scroller's offset size) sees a 600px-tall scroller, as
// virtualRows.test.tsx does
const SIZES = ['offsetHeight', 'offsetWidth', 'clientHeight'] as const;
const realSizes = SIZES.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
  ?? Object.getOwnPropertyDescriptor(Element.prototype, key));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  for (const [key, px] of [['offsetHeight', 600], ['offsetWidth', 1200], ['clientHeight', 600]] as const) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => px });
  }
  for (const fn of [toast, ...Object.values(api)]) fn.mockReset();
  drawn.ids = [];
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

describe('columns', () => {
  it('renders the default columns’ headers in MS Project order', async () => {
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    expect(headers()).toEqual([
      'Indicators', 'ID', 'Mode', 'Task Name', 'Duration', 'Start', 'Finish', 'Predecessors',
      'Resource Names', '% Complete', 'Deadline',
    ]);
    expect(grid().getAttribute('aria-colcount')).toBe('11');
  });

  it('shows each task’s values in its row', async () => {
    const tasks = outlineTasks();
    tasks[1] = { ...tasks[1], percent_complete: 45, duration_text: '2 days',
      assignees: [{ kind: 'person', id: 'p1', name: 'Dana Reyes' }, { kind: 'partner', id: 'x', name: 'Champagne Logistics' }] };
    api.getPlan.mockResolvedValueOnce(outlinePlan({ tasks }));
    renderTab();
    await findSheet();
    const row = rowOf('Order crates');
    const text = (col: string) => row.querySelector(`[data-col="${col}"]`)?.textContent;
    expect(text('id')).toBe('2');
    expect(text('duration')).toBe('2 days');
    expect(text('start')).toBe('Mon 11/2/26');
    expect(text('percent')).toBe('45%');
    expect(text('resources')).toBe('Dana Reyes, Champagne Logistics');
  });

  it('the Columns dialog hides Predecessors, and the choice persists', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    await openColumns(user);
    const dialog = screen.getByRole('dialog', { name: 'Columns' });
    const toggle = within(dialog).getByRole('checkbox', { name: 'Show Predecessors' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await user.click(toggle);
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(headers()).not.toContain('Predecessors');
    expect(headers()).toHaveLength(10);
    const stored = JSON.parse(localStorage.getItem('plans.columns.v1')!);
    expect(stored.visible).not.toContain('predecessors');
    expect(stored.visible).toContain('resources');
  });

  it('the Columns dialog moves a column, and Reset to default puts them back', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    await openColumns(user);
    let dialog = screen.getByRole('dialog', { name: 'Columns' });
    await user.click(within(dialog).getByRole('button', { name: 'Move Duration up' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'Show WBS' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(headers().slice(3, 5)).toEqual(['Duration', 'Task Name']);
    expect(headers()).toContain('WBS');

    await openColumns(user);
    dialog = screen.getByRole('dialog', { name: 'Columns' });
    // ID and Task Name are always shown
    expect((within(dialog).getByRole('checkbox', { name: 'Show Task Name' }) as HTMLInputElement).disabled).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Reset to default' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(headers().slice(3, 5)).toEqual(['Task Name', 'Duration']);
    expect(headers()).not.toContain('WBS');
  });

  it('Cancel leaves the columns as they were', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    await openColumns(user);
    const dialog = screen.getByRole('dialog', { name: 'Columns' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Show Deadline' }));
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(headers()).toContain('Deadline');
    expect(localStorage.getItem('plans.columns.v1')).toBeNull();
  });

  it('a column border resizes from the keyboard and the width persists', async () => {
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    const border = screen.getByRole('separator', { name: 'Resize Task Name' });
    const before = Number(border.getAttribute('aria-valuenow'));
    fireEvent.keyDown(border, { key: 'ArrowRight' });
    expect(Number(border.getAttribute('aria-valuenow'))).toBe(before + 8);
    expect(JSON.parse(localStorage.getItem('plans.columns.v1')!).widths.name).toBe(before + 8);
  });

  it('a column border resizes by dragging, never below the column minimum', async () => {
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    const border = screen.getByRole('separator', { name: 'Resize Duration' });
    const before = Number(border.getAttribute('aria-valuenow'));
    fireEvent.pointerDown(border, { clientX: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(border, { clientX: 540, pointerId: 1 });
    expect(Number(border.getAttribute('aria-valuenow'))).toBe(before + 40);
    fireEvent.pointerMove(border, { clientX: 0, pointerId: 1 });
    fireEvent.pointerUp(border, { clientX: 0, pointerId: 1 });
    const min = Number(border.getAttribute('aria-valuemin'));
    expect(Number(border.getAttribute('aria-valuenow'))).toBe(min);
    expect(JSON.parse(localStorage.getItem('plans.columns.v1')!).widths.duration).toBe(min);
  });

  it('a drag whose pointer capture is lost ends without saving, and later moves do nothing', async () => {
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    const border = screen.getByRole('separator', { name: 'Resize Duration' });
    const before = Number(border.getAttribute('aria-valuenow'));
    fireEvent.pointerDown(border, { clientX: 500, pointerId: 1, button: 0 });
    fireEvent.pointerMove(border, { clientX: 540, pointerId: 1 });
    expect(Number(border.getAttribute('aria-valuenow'))).toBe(before + 40);
    fireEvent(border, new Event('lostpointercapture', { bubbles: true }));
    expect(Number(border.getAttribute('aria-valuenow'))).toBe(before);
    fireEvent.pointerMove(border, { clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(border, { clientX: 600, pointerId: 1 });
    expect(Number(border.getAttribute('aria-valuenow'))).toBe(before);
    expect(localStorage.getItem('plans.columns.v1')).toBeNull();
  });
});

describe('outline rows', () => {
  it('indents Task Name by outline level and shows summaries bold', async () => {
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    const level = (name: string) =>
      (rowOf(name).querySelector('[data-col="name"]') as HTMLElement).style.getPropertyValue('--pln-level');
    expect(['Prep', 'Order crates', 'Print labels', 'Go live'].map(level)).toEqual(['1', '2', '3', '1']);
    expect(rowOf('Prep').querySelector('[data-col="name"] b.cell-top')?.textContent).toBe('Prep');
    expect(rowOf('Go live').querySelector('[data-col="name"] b')).toBeNull();
  });

  it('a summary’s chevron hides its subtasks, from the DOM and from the rows, and remembers it', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    expect(rowNames()).toEqual(['Prep', 'Order crates', 'Labels', 'Print labels', 'Go live']);
    // header + 5 tasks + the blank new-task row
    expect(grid().getAttribute('aria-rowcount')).toBe('7');
    expect(within(rowOf('Go live')).queryByRole('button', { name: /Collapse|Expand/ })).toBeNull();

    const chevron = within(rowOf('Prep')).getByRole('button', { name: 'Collapse Prep' });
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
    await user.click(chevron);
    expect(rowNames()).toEqual(['Prep', 'Go live']);
    expect(grid().getAttribute('aria-rowcount')).toBe('4');
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual(['s1']);

    await user.click(within(rowOf('Prep')).getByRole('button', { name: 'Expand Prep' }));
    expect(rowNames()).toEqual(['Prep', 'Order crates', 'Labels', 'Print labels', 'Go live']);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual([]);
  });

  it('reads the collapsed summaries saved for the plan', async () => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(['s2']));
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    expect(rowNames()).toEqual(['Prep', 'Order crates', 'Labels', 'Go live']);
  });

  it('collapsing a summary above the active cell moves it to the summary', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    await user.click(rowOf('Print labels').querySelector('[data-col="duration"]')!);
    expect(rowOf('Print labels').getAttribute('aria-selected')).toBe('true');
    await user.click(within(rowOf('Prep')).getByRole('button', { name: 'Collapse Prep' }));
    expect(rowOf('Prep').getAttribute('aria-selected')).toBe('true');
    expect(rowOf('Prep').querySelector('[data-col="duration"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('a read-only plan has no blank new-task row', async () => {
    api.getPlan.mockResolvedValueOnce(outlinePlan({
      permissions: { view: true, add: false, change: false, delete: false },
    }));
    renderTab();
    await findSheet();
    expect(grid().getAttribute('aria-rowcount')).toBe('6');
    expect(grid().querySelector('[data-blank]')).toBeNull();
  });
});

describe('indicators', () => {
  it('a constraint shows its type and date in the tooltip', async () => {
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    const icon = within(rowOf('Order crates')).getByTitle('Start No Earlier Than Thu 11/5/26');
    expect(icon.closest('[data-col]')?.getAttribute('data-col')).toBe('indicators');
    expect(icon.getAttribute('aria-label')).toBe('Start No Earlier Than Thu 11/5/26');
  });

  it('a locked schedule marks every row', async () => {
    api.getPlan.mockResolvedValueOnce(outlinePlan({ locked_at: '2026-10-28T15:30:00Z', locked_by_name: 'Dana' }));
    renderTab();
    await findSheet();
    expect(within(grid()).getAllByTitle('Schedule locked — progress updates only')).toHaveLength(5);
  });
});

describe('selection', () => {
  it('clicking a cell selects its row and makes it the active cell', async () => {
    const user = userEvent.setup();
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab();
    await findSheet();
    const cell = rowOf('Go live').querySelector('[data-col="finish"]') as HTMLElement;
    await user.click(cell);
    expect(rowOf('Go live').getAttribute('aria-selected')).toBe('true');
    expect(cell.getAttribute('aria-selected')).toBe('true');
    expect(rowOf('Prep').getAttribute('aria-selected')).toBe('false');
  });
});

describe('deep link (&task=)', () => {
  it('expands the collapsed summaries above the task and selects its row', async () => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(['s1', 's2']));
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab('?tab=plan&task=b');
    await findSheet();
    await waitFor(() => expect(rowNames()).toContain('Print labels'));
    expect(rowOf('Print labels').getAttribute('aria-selected')).toBe('true');
    expect(rowNames()).toEqual(['Prep', 'Order crates', 'Labels', 'Print labels', 'Go live']);
    expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY)!)).toEqual([]);
  });

  it('scrolls the task into view once', async () => {
    const many = Array.from({ length: 300 }, (_, i) => makeTask(`t${i}`, {
      display_id: i + 1, wbs: String(i + 1), position: i, name: `Task ${i + 1}`,
    }));
    api.getPlan.mockResolvedValueOnce(makePlan({ tasks: many }));
    const { container } = renderTab('?tab=plan&task=t250');
    await findSheet();
    const scroller = container.querySelector('.pln-panes') as HTMLElement;
    await waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
    // about row 250 of 30px rows, centered in the 600px pane
    expect(scroller.scrollTop).toBeGreaterThan(240 * 30);
    expect(scroller.scrollTop).toBeLessThan(251 * 30);
    // the user scrolls away; nothing pulls them back
    act(() => {
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event('scroll'));
    });
    await waitFor(() => expect(within(grid()).getAllByRole('row').some((r) => r.textContent?.includes('Task 1'))).toBe(true));
    expect(scroller.scrollTop).toBe(0);
  });

  it('ignores a task the plan does not have', async () => {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(['s1']));
    api.getPlan.mockResolvedValueOnce(outlinePlan());
    renderTab('?tab=plan&task=nope');
    await findSheet();
    expect(rowNames()).toEqual(['Prep', 'Go live']);
    expect(within(grid()).getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true')).toEqual([]);
  });
});

describe('large plans (Review Focus 5)', () => {
  it('renders a 1,500-task plan as a window of fewer than 80 rows', async () => {
    const tasks = Array.from({ length: 1500 }, (_, i) => makeTask(`t${i}`, {
      display_id: i + 1, wbs: String(i + 1), position: i, name: `Task ${i + 1}`,
    }));
    api.getPlan.mockResolvedValueOnce(makePlan({ tasks }));
    renderTab();
    await findSheet();
    const rows = within(grid()).getAllByRole('row').filter((r) => r.hasAttribute('data-task'));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(80);
    expect(grid().getAttribute('aria-rowcount')).toBe('1502');
    // the body is as tall as every row, so the scroller scrolls the whole plan
    const body = grid().querySelector('.pln-sheet-body') as HTMLElement;
    expect(body.style.height).toBe(`${1501 * 30}px`);
  });
});

describe('PlanSheet props', () => {
  /** The sheet alone, as PlanTab (and later the Gantt) drive it. */
  function Harness({ plan, rows, onToggle = () => {}, collapsed = new Set<string>() }: {
    plan: Plan; rows: string[]; onToggle?: (id: string) => void; collapsed?: ReadonlySet<string>;
  }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const view = planView(plan);
    const ctl = { status: 'ready', plan: view.plan, outline: view.outline } as unknown as PlanController;
    return (
      <div ref={scrollRef} className="pln-panes">
        <PlanSheet ctl={ctl} rows={rows} collapsed={collapsed} rowHeight={24} scrollRef={scrollRef}
                   selection={selectCell('c', 'name')} onSelect={() => {}}
                   onToggleCollapse={onToggle} blankRow={false} />
      </div>
    );
  }

  it('renders exactly the rows it is given, in their order, at the row height given', () => {
    render(<Harness plan={outlinePlan()} rows={['c', 'a']} />);
    expect(rowNames()).toEqual(['Go live', 'Order crates']);
    expect((grid().querySelector('.pln-sheet-body') as HTMLElement).style.height).toBe('48px');
    expect(rowOf('Go live').getAttribute('aria-selected')).toBe('true');
  });

  it('a chevron asks its owner to collapse; the rows stay until the owner changes them', async () => {
    const onToggle = vi.fn();
    render(<Harness plan={outlinePlan()} rows={['s1', 'a', 's2', 'b', 'c']} onToggle={onToggle} />);
    fireEvent.click(within(rowOf('Labels')).getByRole('button', { name: 'Collapse Labels' }));
    expect(onToggle).toHaveBeenCalledWith('s2');
    expect(rowNames()).toHaveLength(5);
  });

  it('an op redraws only the rows whose tasks changed', () => {
    const scroll = { current: null as HTMLDivElement | null };
    const noop = () => {};
    const collapsed = new Set<string>();
    function Stable({ plan }: { plan: Plan }) {
      const view = planView(plan);
      const ctl = { status: 'ready', plan: view.plan, outline: view.outline } as unknown as PlanController;
      return (
        <div ref={(el) => { scroll.current = el; }} className="pln-panes">
          <PlanSheet ctl={ctl} rows={['s1', 'a', 's2', 'b', 'c']} collapsed={collapsed} rowHeight={30}
                     scrollRef={scroll} selection={EMPTY_SELECTION} onSelect={noop}
                     onToggleCollapse={noop} blankRow={false} />
        </div>
      );
    }
    const before = outlinePlan();
    const { rerender } = render(<Stable plan={before} />);
    expect(new Set(drawn.ids)).toEqual(new Set(['s1', 'a', 's2', 'b', 'c']));
    drawn.ids = [];
    const tasks = [...before.tasks];
    tasks[4] = { ...tasks[4], name: 'Go live now' };
    rerender(<Stable plan={{ ...before, version: 6, tasks }} />);
    expect(drawn.ids).toEqual(['c']);
  });

  it('with no selection marks nothing', () => {
    function Bare() {
      const scrollRef = useRef<HTMLDivElement>(null);
      const view = planView(outlinePlan());
      const ctl = { status: 'ready', plan: view.plan, outline: view.outline } as unknown as PlanController;
      return (
        <div ref={scrollRef}>
          <PlanSheet ctl={ctl} rows={['a']} collapsed={new Set()} rowHeight={30} scrollRef={scrollRef}
                     selection={EMPTY_SELECTION} onSelect={() => {}} onToggleCollapse={() => {}} blankRow />
        </div>
      );
    }
    render(<Bare />);
    expect(within(grid()).getAllByRole('row').filter((r) => r.getAttribute('aria-selected') === 'true')).toEqual([]);
  });
});
