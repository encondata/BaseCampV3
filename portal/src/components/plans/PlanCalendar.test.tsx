// @vitest-environment jsdom
/**
 * components/plans/PlanCalendar: the Calendar view — a month grid of the
 * leaf tasks the filter shows, each a bar across the days it covers (one
 * segment per week it touches), milestones as diamond chips on their day,
 * with ‹ Today › month navigation. A click selects the task (Ctrl or ⌘ adds
 * it), a double-click opens Task Information. Days are the plan's own
 * (floating times), and "today" is the plan's now, not the browser's.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Plan, PlanTask } from '../../lib/plans/api';
import { makePlan, makeTask } from '../../lib/plans/planFixtures';
import PlanCalendar from './PlanCalendar';

afterEach(cleanup);

/**
 *  Prep (summary)
 *    Crate racks   Fri Nov 6 → Mon Nov 9 (two working days, across the weekend)
 *    Go live       milestone Fri Nov 6
 *  Survey          Tue Nov 3
 *  Wrap up         Wed Nov 25, out of the filter
 */
function tasks(): PlanTask[] {
  return [
    makeTask('s1', { is_summary: true, name: 'Prep', start: '2026-11-06T08:00', finish: '2026-11-09T17:00' }),
    makeTask('x', { name: 'Crate racks', parent_id: 's1', start: '2026-11-06T08:00', finish: '2026-11-09T17:00' }),
    makeTask('m', { name: 'Go live', parent_id: 's1', is_milestone: true, start: '2026-11-06T17:00',
      finish: '2026-11-06T17:00' }),
    makeTask('a', { name: 'Survey', start: '2026-11-03T08:00', finish: '2026-11-03T17:00' }),
    makeTask('w', { name: 'Wrap up', start: '2026-11-25T08:00', finish: '2026-11-25T17:00' }),
  ];
}

const plan = (over: Partial<Plan> = {}) => makePlan({
  tasks: tasks(), project_start: '2026-11-02T08:00', project_finish: '2026-11-25T17:00', now: '2026-11-04T12:00',
  ...over,
});

function renderCalendar(p: Plan = plan(), opts: {
  rows?: string[]; context?: Set<string>; selected?: Set<string>;
} = {}) {
  const onSelect = vi.fn();
  const onOpenInfo = vi.fn();
  const view = render(
    <PlanCalendar plan={p} rows={opts.rows ?? ['s1', 'x', 'm', 'a']} context={opts.context ?? new Set()}
                  selected={opts.selected ?? new Set()} onSelect={onSelect} onOpenInfo={onOpenInfo} />,
  );
  return { ...view, onSelect, onOpenInfo };
}

const segments = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-task-id="${id}"]`)];
/** The week row a segment sits in. */
const weekOf = (el: HTMLElement) => el.closest<HTMLElement>('.pln-month-week');
const dayNumbers = (week: HTMLElement | null) =>
  [...(week?.querySelectorAll<HTMLElement>('.pln-month-daynum') ?? [])].map((d) => d.textContent);

describe('PlanCalendar', () => {
  it('opens on the month of the plan’s now and names it', () => {
    renderCalendar();
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy();
  });

  it('a two-day task across a week boundary renders two segments, carrying on past the weekend', () => {
    renderCalendar();
    const parts = segments('x');
    expect(parts).toHaveLength(2);
    // Fri–Sun in the week of Nov 2, then Monday in the week of Nov 9
    expect(dayNumbers(weekOf(parts[0]))[0]).toBe('2');
    expect(dayNumbers(weekOf(parts[1]))[0]).toBe('9');
    expect(parts[0].style.gridColumn).toBe('5 / span 3');
    expect(parts[1].style.gridColumn).toBe('1 / span 1');
    expect(parts[0].classList.contains('cont-after')).toBe(true);
    expect(parts[1].classList.contains('cont-before')).toBe(true);
    expect(parts[0].textContent).toContain('Crate racks');
  });

  it('a milestone renders a diamond chip on its day', () => {
    renderCalendar();
    const [chip] = segments('m');
    expect(chip.classList.contains('chip')).toBe(true);
    expect(chip.querySelector('.pln-month-diamond')).not.toBeNull();
    expect(chip.textContent).toContain('Go live');
    // Friday Nov 6: the fifth column of the week of Nov 2
    expect(chip.style.gridColumn).toBe('5 / span 1');
    expect(dayNumbers(weekOf(chip))[0]).toBe('2');
  });

  it('shows the leaf tasks of the rows given: no summary, nothing the filter left out', () => {
    renderCalendar(plan(), { rows: ['s1', 'x', 'm'], context: new Set(['s1']) });
    expect(segments('s1')).toHaveLength(0);
    expect(segments('a')).toHaveLength(0);
    expect(segments('x').length).toBeGreaterThan(0);
  });

  it('‹ › step a month, Today comes back to the plan’s now', async () => {
    const user = userEvent.setup();
    renderCalendar();
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { name: 'December 2026' })).toBeTruthy();
    expect(segments('x')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('heading', { name: 'October 2026' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Today' }));
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy();
  });

  it('marks the plan’s today, whatever the browser’s clock says', () => {
    renderCalendar();
    const today = [...document.querySelectorAll<HTMLElement>('.pln-month-day.today')];
    expect(today).toHaveLength(1);
    expect(within(today[0]).getByText('4')).toBeTruthy();
  });

  it('a click selects the task, Ctrl adds it; a double-click opens Task Information', async () => {
    const user = userEvent.setup();
    const { onSelect, onOpenInfo } = renderCalendar();
    await user.click(segments('a')[0]);
    expect(onSelect).toHaveBeenLastCalledWith('a', false);
    fireEvent.click(segments('m')[0], { ctrlKey: true });
    expect(onSelect).toHaveBeenLastCalledWith('m', true);
    await user.dblClick(segments('x')[1]);
    expect(onOpenInfo).toHaveBeenCalledWith('x');
  });

  it('a selected task’s segments say so', () => {
    renderCalendar(plan(), { selected: new Set(['x']) });
    for (const part of segments('x')) expect(part.getAttribute('aria-pressed')).toBe('true');
    expect(segments('a')[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('a finish at midnight ends on the day before', () => {
    const p = plan({
      tasks: [makeTask('n', { name: 'Night shift', start: '2026-11-03T20:00', finish: '2026-11-05T00:00' })],
    });
    renderCalendar(p, { rows: ['n'] });
    const [part] = segments('n');
    // Tue and Wed: columns 2–3
    expect(part.style.gridColumn).toBe('2 / span 2');
  });

  it('a finish at midnight names the day before in the bar’s name too', () => {
    const p = plan({
      tasks: [makeTask('n', { name: 'Night shift', start: '2026-11-03T20:00', finish: '2026-11-05T00:00' })],
    });
    renderCalendar(p, { rows: ['n'] });
    expect(segments('n')[0].getAttribute('aria-label')).toBe('Night shift, Nov 3–4');
  });

  it('a selected task in another month brings its month into view', () => {
    const { rerender, onSelect, onOpenInfo } = renderCalendar(plan(), { rows: ['s1', 'x', 'm', 'a', 'w'] });
    const p = plan({
      tasks: [...tasks(), makeTask('j', { name: 'Close out', start: '2027-01-12T08:00', finish: '2027-01-12T17:00' })],
    });
    rerender(
      <PlanCalendar plan={p} rows={['s1', 'x', 'm', 'a', 'w', 'j']} context={new Set()} selected={new Set(['j'])}
                    onSelect={onSelect} onOpenInfo={onOpenInfo} />,
    );
    expect(screen.getByRole('heading', { name: 'January 2027' })).toBeTruthy();
    expect(segments('j')).toHaveLength(1);
  });
});

/** A busy week: five Mon–Fri tasks (lanes enough to fold) and a milestone on Wed Nov 4. */
function busyPlan(): Plan {
  const week = Array.from({ length: 5 }, (_, i) => makeTask(`t${i}`, {
    name: `Crew ${i + 1}`, start: '2026-11-02T08:00', finish: '2026-11-06T17:00',
  }));
  const milestone = makeTask('m', { name: 'Go live', is_milestone: true, start: '2026-11-04T17:00',
    finish: '2026-11-04T17:00' });
  return plan({ tasks: [...week, milestone] });
}
const BUSY_ROWS = ['t0', 't1', 't2', 't3', 't4', 'm'];

describe('a busy week', () => {
  it('a milestone never folds into "+N more": it takes the first lane of its day', () => {
    renderCalendar(busyPlan(), { rows: BUSY_ROWS });
    const [chip] = segments('m');
    expect(chip).toBeTruthy();
    expect(chip.style.gridRow).toBe('1');
    expect(chip.style.gridColumn).toBe('3 / span 1');
    // the bars that don't fit fold, the milestone is never one of them
    expect(screen.getByRole('button', { name: '+2 more on Nov 4' })).toBeTruthy();
  });

  it('"+N more" names its day and says it is collapsed; focus goes to Show less and back', async () => {
    const user = userEvent.setup();
    renderCalendar(busyPlan(), { rows: BUSY_ROWS });
    const more = screen.getByRole('button', { name: '+2 more on Nov 4' });
    expect(more.textContent).toBe('+2 more');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await user.click(more);
    const less = screen.getByRole('button', { name: 'Show less' });
    expect(document.activeElement).toBe(less);
    expect(less.getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByRole('button', { name: /more on/ })).toBeNull();
    await user.click(less);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '+2 more on Nov 4' }));
  });

  it('Escape closes the open week, takes the key (full screen stays) and puts focus back', async () => {
    const user = userEvent.setup();
    renderCalendar(busyPlan(), { rows: BUSY_ROWS });
    await user.click(screen.getByRole('button', { name: '+2 more on Nov 2' }));
    const later = vi.fn();
    document.addEventListener('keydown', later);
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { (document.activeElement ?? document.body).dispatchEvent(esc); });
    document.removeEventListener('keydown', later);
    expect(esc.defaultPrevented).toBe(true);
    expect((later.mock.calls[0][0] as KeyboardEvent).defaultPrevented).toBe(true);
    expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '+2 more on Nov 2' }));
  });
});
