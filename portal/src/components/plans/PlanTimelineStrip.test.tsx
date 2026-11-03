// @vitest-environment jsdom
/**
 * components/plans/PlanTimelineStrip: MS Project's Timeline above the
 * Gantt — the project's span with its Start and Finish, a today marker,
 * and every task flagged Show on timeline: milestones as diamonds, other
 * tasks as labeled bars stacked into at most three lanes. A click selects
 * the task in the sheet; a double-click opens Task Information.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Plan, PlanTask } from '../../lib/plans/api';
import { makePlan, makeTask } from '../../lib/plans/planFixtures';
import PlanTimelineStrip from './PlanTimelineStrip';

afterEach(cleanup);

/** The project: Mon Nov 2 08:00 → Thu Nov 12 08:00 (ten days, so 10% a day). */
const plan = (tasks: PlanTask[], over: Partial<Plan> = {}) => makePlan({
  tasks, project_start: '2026-11-02T08:00', project_finish: '2026-11-12T08:00', now: '2026-11-04T08:00', ...over,
});
const bar = (id: string, name: string, start: string, finish: string, on = true) => makeTask(id, {
  name, start: `2026-11-${start}`, finish: `2026-11-${finish}`, show_on_timeline: on,
});

function renderStrip(p: Plan, selected: Set<string> = new Set()) {
  const onSelect = vi.fn();
  const onOpenInfo = vi.fn();
  const view = render(<PlanTimelineStrip plan={p} selected={selected} onSelect={onSelect} onOpenInfo={onOpenInfo} />);
  return { ...view, onSelect, onOpenInfo };
}

const items = () => [...document.querySelectorAll<HTMLElement>('.pln-strip [data-task-id]')];
const ids = () => items().map((el) => el.getAttribute('data-task-id'));
const laneOf = (id: string) => items().find((el) => el.getAttribute('data-task-id') === id)?.getAttribute('data-lane');

describe('PlanTimelineStrip', () => {
  it('only tasks flagged Show on timeline appear', () => {
    renderStrip(plan([
      bar('a', 'Survey', '02T08:00', '03T08:00'),
      bar('b', 'Pack', '03T08:00', '04T08:00', false),
      makeTask('m', { name: 'Move day', is_milestone: true, start: '2026-11-10T08:00', finish: '2026-11-10T08:00',
        show_on_timeline: true }),
      makeTask('n', { name: 'Not on it', is_milestone: true, start: '2026-11-11T08:00', finish: '2026-11-11T08:00' }),
    ]));
    expect(ids()).toEqual(['m', 'a']);
    expect(screen.queryByText('Pack')).toBeNull();
    expect(screen.queryByText('Not on it')).toBeNull();
  });

  it('three overlapping bars use three lanes', () => {
    renderStrip(plan([
      bar('a', 'Survey', '02T08:00', '06T08:00'),
      bar('b', 'Pack', '03T08:00', '07T08:00'),
      bar('c', 'Crate', '04T08:00', '08T08:00'),
    ]));
    expect(['a', 'b', 'c'].map(laneOf)).toEqual(['0', '1', '2']);
    expect(document.querySelector('.pln-strip')?.getAttribute('data-lanes')).toBe('3');
  });

  it('bars that don’t overlap share a lane; a fourth overlapping bar stays within three', () => {
    renderStrip(plan([
      bar('a', 'Survey', '02T08:00', '04T08:00'),
      bar('b', 'Pack', '04T08:00', '06T08:00'),
      bar('c', 'Crate', '03T08:00', '09T08:00'),
      bar('d', 'Load', '03T08:00', '09T08:00'),
      bar('e', 'Drive', '03T08:00', '09T08:00'),
    ]));
    expect(laneOf('a')).toBe('0');
    expect(laneOf('b')).toBe('0');
    expect(['c', 'd', 'e'].map((id) => Number(laneOf(id))).every((lane) => lane >= 0 && lane <= 2)).toBe(true);
    expect(document.querySelector('.pln-strip')?.getAttribute('data-lanes')).toBe('3');
  });

  it('a bar sits at its share of the project span, labeled with its name', () => {
    renderStrip(plan([bar('a', 'Survey', '03T08:00', '05T08:00')]));
    const [el] = items();
    expect(el.style.left).toBe('10%');
    expect(el.style.width).toBe('20%');
    expect(el.textContent).toContain('Survey');
  });

  it('milestones are diamonds with their name and date', () => {
    renderStrip(plan([
      makeTask('m', { name: 'Move day', is_milestone: true, start: '2026-11-07T08:00', finish: '2026-11-07T08:00',
        show_on_timeline: true }),
    ]));
    const [el] = items();
    expect(el.querySelector('.pln-strip-diamond')).not.toBeNull();
    expect(el.textContent).toContain('Move day');
    expect(el.textContent).toContain('11/7');
    expect(el.style.left).toBe('50%');
  });

  it('milestone labels that would run into each other take a second row', () => {
    // a 1000px band: a label sits at its share of it and is 150px wide
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rectOf(this: HTMLElement) {
      const left = Number.parseFloat(this.style.left || '0') * 10;
      return { left, right: left + 150, top: 0, bottom: 22, width: 150, height: 22, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    try {
      const mark = (id: string, day: string) => makeTask(id, {
        name: `Mark ${id}`, is_milestone: true, start: `2026-11-${day}T08:00`, finish: `2026-11-${day}T08:00`,
        show_on_timeline: true,
      });
      // 10%, 20% (its label runs into the first's), 60%
      renderStrip(plan([mark('a', '03'), mark('b', '04'), mark('c', '08')]));
      const row = (id: string) => items().find((el) => el.getAttribute('data-task-id') === id)?.style.getPropertyValue('--row');
      expect([row('a'), row('b'), row('c')]).toEqual(['0', '1', '0']);
      expect((document.querySelector('.pln-strip-band') as HTMLElement).style.getPropertyValue('--marks')).toBe('2');
    } finally {
      rect.mockRestore();
    }
  });

  it('the project’s Start and Finish at its ends, and the today marker at the plan’s now', () => {
    renderStrip(plan([bar('a', 'Survey', '03T08:00', '05T08:00')]));
    const strip = document.querySelector<HTMLElement>('.pln-strip') as HTMLElement;
    expect(within(strip).getByText('Start').nextElementSibling?.textContent).toBe('Mon 11/2/26');
    expect(within(strip).getByText('Finish').nextElementSibling?.textContent).toBe('Thu 11/12/26');
    const today = strip.querySelector<HTMLElement>('.pln-strip-today');
    expect(today?.style.left).toBe('20%');
  });

  it('the ends name the band’s own span: a timeline task outside the project widens it, and the labels follow', () => {
    renderStrip(plan([
      bar('a', 'Survey', '03T08:00', '05T08:00'),
      makeTask('e', { name: 'Early walk', start: '2026-10-29T08:00', finish: '2026-10-30T17:00', show_on_timeline: true }),
      makeTask('z', { name: 'Late audit', start: '2026-11-16T08:00', finish: '2026-11-19T00:00', show_on_timeline: true }),
    ]));
    const strip = document.querySelector<HTMLElement>('.pln-strip') as HTMLElement;
    expect(within(strip).getByText('Start').nextElementSibling?.textContent).toBe('Thu 10/29/26');
    // a finish at midnight ends the day before
    expect(within(strip).getByText('Finish').nextElementSibling?.textContent).toBe('Wed 11/18/26');
  });

  it('a bar’s name gives its days, a finish at midnight ending the day before', () => {
    renderStrip(plan([makeTask('n', { name: 'Night shift', start: '2026-11-03T20:00', finish: '2026-11-05T00:00',
      show_on_timeline: true })]));
    expect(items()[0].getAttribute('aria-label')).toBe('Night shift, Nov 3–4');
  });

  it('no today marker when the plan’s now is outside the span', () => {
    renderStrip(plan([bar('a', 'Survey', '03T08:00', '05T08:00')], { now: '2026-12-01T08:00' }));
    expect(document.querySelector('.pln-strip-today')).toBeNull();
  });

  it('a click selects the task, a double-click opens Task Information; the selected one says so', async () => {
    const user = userEvent.setup();
    const { onSelect, onOpenInfo } = renderStrip(plan([
      bar('a', 'Survey', '02T08:00', '04T08:00'),
      bar('b', 'Pack', '04T08:00', '06T08:00'),
    ]), new Set(['b']));
    await user.click(screen.getByRole('button', { name: /Survey/ }));
    expect(onSelect).toHaveBeenLastCalledWith('a');
    fireEvent.doubleClick(screen.getByRole('button', { name: /Pack/ }));
    expect(onOpenInfo).toHaveBeenCalledWith('b');
    expect(screen.getByRole('button', { name: /Pack/ }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /Survey/ }).getAttribute('aria-pressed')).toBe('false');
  });

  it('with nothing on the timeline, says how to add tasks', () => {
    renderStrip(plan([bar('a', 'Survey', '02T08:00', '04T08:00', false)]));
    expect(screen.getByText('Add tasks to the timeline with Properties › Add to Timeline.')).toBeTruthy();
  });
});
