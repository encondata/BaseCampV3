/**
 * lib/plans/drag.ts: what a press on a Gantt bar means (its zones), the
 * snap of each zoom, and the ops a finished drag sends — a move's Start, a
 * resize's Duration in the task's own unit, a progress drag's % Complete,
 * a link drag's FS link — plus the working time a resize measures, the
 * links a drop may make, and where a pointer sits on the scale.
 */
import { describe, expect, it } from 'vitest';

import { STANDARD_UNITS, parseDuration } from './durations';
import { toMs } from './floatingTime';
import { makeLink, makePlan, makeTask } from './planFixtures';
import {
  DRAG_THRESHOLD_PX, GRIP_PX, MIN_GRIP_BAR_PX, RESIZE_PX, canLink, dragKind, gripX, opsForDrag, pointerScaleX, snapMs,
  workMinutes,
} from './drag';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const calendar = makePlan().calendar;     // Mon-Fri 08:00-12:00, 13:00-17:00
const units = STANDARD_UNITS;

/** Mon Nov 2 08:00 to Tue Nov 3 17:00: two working days. */
const twoDays = (over = {}) => makeTask('a', {
  start: '2026-11-02T08:00', finish: '2026-11-03T17:00', duration_minutes: 960, duration_text: '2 days', ...over,
});

describe('dragKind', () => {
  const bar = { x: 100, width: 96, done: 0, milestone: false };

  it('the right 6px resize, past the end is the link handle, the rest moves', () => {
    expect(RESIZE_PX).toBe(6);
    expect(dragKind(196, bar)).toBe('resize');
    expect(dragKind(190, bar)).toBe('resize');
    expect(dragKind(189, bar)).toBe('move');
    expect(dragKind(150, bar)).toBe('move');
    expect(dragKind(197, bar)).toBe('link');
    expect(dragKind(210, bar)).toBe('link');
  });

  it('the progress handle sits at the progress edge', () => {
    const half = { ...bar, done: 48 };
    expect(gripX(half)).toBe(148);
    expect(dragKind(148, half)).toBe('progress');
    expect(dragKind(148 + GRIP_PX, half)).toBe('progress');
    expect(dragKind(148 - GRIP_PX, half)).toBe('progress');
    expect(dragKind(148 + GRIP_PX + 1, half)).toBe('move');
    // at 0% it is the bar's left edge
    expect(dragKind(101, bar)).toBe('progress');
    expect(dragKind(110, bar)).toBe('move');
  });

  it('at 100% the handle stays just inside the resize zone, so both can be grabbed', () => {
    const full = { ...bar, done: 96 };
    expect(gripX(full)).toBe(190);
    expect(dragKind(187, full)).toBe('progress');
    expect(dragKind(192, full)).toBe('resize');
  });

  it('a milestone moves or links; it never resizes or takes progress', () => {
    const mark = { x: 100, width: 0, done: 0, milestone: true };
    expect(dragKind(100, mark)).toBe('move');
    expect(dragKind(95, mark)).toBe('move');
    expect(dragKind(106, mark)).toBe('move');
    expect(dragKind(107, mark)).toBe('link');
  });

  it('a narrow bar keeps room to move: a third of it resizes, and it has no progress handle', () => {
    const thin = { x: 100, width: 9, done: 0, milestone: false };
    expect(dragKind(100, thin)).toBe('move');
    expect(dragKind(105, thin)).toBe('move');
    expect(dragKind(106, thin)).toBe('resize');
    expect(dragKind(110, thin)).toBe('link');
    // a day at the days zoom (18px), half done: its middle moves it, it has no handle to catch instead
    const day = { x: 100, width: 18, done: 9, milestone: false };
    expect(MIN_GRIP_BAR_PX).toBeGreaterThan(18);
    expect(dragKind(109, day)).toBe('move');
    expect(dragKind(100, day)).toBe('move');
  });

  it('the handle reaches a few px either side of the edge, never most of a bar', () => {
    expect(GRIP_PX).toBeLessThanOrEqual(3);
    const wide = { x: 100, width: 66, done: 33, milestone: false };
    expect(dragKind(133 + GRIP_PX + 1, wide)).toBe('move');
    expect(dragKind(133 - GRIP_PX - 1, wide)).toBe('move');
  });
});

describe('snapMs', () => {
  const at = (s: string) => toMs(s);

  it('hours snap to 15 minutes, days to the hour, weeks and coarser to the day', () => {
    expect(snapMs(at('2026-11-02T08:07'), 'hours')).toBe(at('2026-11-02T08:00'));
    expect(snapMs(at('2026-11-02T08:08'), 'hours')).toBe(at('2026-11-02T08:15'));
    expect(snapMs(at('2026-11-02T08:29'), 'days')).toBe(at('2026-11-02T08:00'));
    expect(snapMs(at('2026-11-02T08:31'), 'days')).toBe(at('2026-11-02T09:00'));
    expect(snapMs(at('2026-11-02T11:00'), 'weeks')).toBe(at('2026-11-02T00:00'));
    expect(snapMs(at('2026-11-02T13:00'), 'weeks')).toBe(at('2026-11-03T00:00'));
    expect(snapMs(at('2026-11-02T13:00'), 'months')).toBe(at('2026-11-03T00:00'));
    expect(snapMs(at('2026-11-02T13:00'), 'quarters')).toBe(at('2026-11-03T00:00'));
  });
});

describe('opsForDrag', () => {
  it('move sends the new Start (the API adds Start No Earlier Than)', () => {
    expect(opsForDrag('move', twoDays(), DAY + 5 * HOUR, units, calendar)).toEqual([
      { op: 'update_task', id: 'a', fields: { start: '2026-11-03T13:00' } },
    ]);
  });

  it('move sends the same Start on a manual task, whose span the API keeps', () => {
    expect(opsForDrag('move', twoDays({ mode: 'manual' }), -DAY, units, calendar)).toEqual([
      { op: 'update_task', id: 'a', fields: { start: '2026-11-01T08:00' } },
    ]);
  });

  it('move sends a milestone’s new date', () => {
    const mark = makeTask('m', { is_milestone: true, start: '2026-11-05T17:00', finish: '2026-11-05T17:00' });
    expect(opsForDrag('move', mark, DAY, units, calendar)).toEqual([
      { op: 'update_task', id: 'm', fields: { start: '2026-11-06T17:00' } },
    ]);
  });

  it('a drag that lands where it began sends nothing', () => {
    expect(opsForDrag('move', twoDays(), 0, units, calendar)).toEqual([]);
    expect(opsForDrag('resize', twoDays(), 0, units, calendar)).toEqual([]);
    expect(opsForDrag('progress', twoDays(), 0, units, calendar)).toEqual([]);
  });

  it('a summary is never moved, resized or given progress by a drag', () => {
    const summary = twoDays({ is_summary: true });
    expect(opsForDrag('move', summary, DAY, units, calendar)).toEqual([]);
    expect(opsForDrag('resize', summary, DAY, units, calendar)).toEqual([]);
    expect(opsForDrag('progress', summary, DAY, units, calendar)).toEqual([]);
  });

  it('resize of a 2-day task by +1 day at the days zoom is 3 days', () => {
    expect(opsForDrag('resize', twoDays(), DAY, units, calendar)).toEqual([
      { op: 'update_task', id: 'a', fields: { duration: '3 days' } },
    ]);
  });

  it('resize measures working time in the task’s own unit (the lunch hour isn’t work)', () => {
    const fourHours = makeTask('a', {
      start: '2026-11-02T08:00', finish: '2026-11-02T12:00', duration_minutes: 240, duration_unit: 'h',
      duration_text: '4 hrs',
    });
    expect(opsForDrag('resize', fourHours, 2 * HOUR, units, calendar)).toEqual([
      { op: 'update_task', id: 'a', fields: { duration: '5 hrs' } },
    ]);
    // over a weekend: Friday 08:00 to Monday 17:00 is two working days
    const friday = makeTask('f', { start: '2026-11-06T08:00', finish: '2026-11-06T17:00' });
    expect(opsForDrag('resize', friday, 3 * DAY, units, calendar)).toEqual([
      { op: 'update_task', id: 'f', fields: { duration: '2 days' } },
    ]);
  });

  it('an elapsed duration stays elapsed: wall-clock time', () => {
    const elapsed = makeTask('e', {
      start: '2026-11-02T08:00', finish: '2026-11-04T08:00', duration_minutes: 2880, elapsed: true,
      duration_text: '2 edays',
    });
    expect(opsForDrag('resize', elapsed, DAY, units, calendar)).toEqual([
      { op: 'update_task', id: 'e', fields: { duration: '3 edays' } },
    ]);
  });

  it('a resize past the start keeps at least a minute, in text the API reads as one', () => {
    const [op] = opsForDrag('resize', twoDays(), -3 * DAY, units, calendar);
    const text = (op as { fields: { duration: string } }).fields.duration;
    expect(text).toBe('0.01 days');
    expect(parseDuration(text, units).minutes).toBeGreaterThanOrEqual(1);
    const hours = makeTask('h', { duration_minutes: 240, duration_unit: 'h', finish: '2026-11-02T12:00' });
    const [h] = opsForDrag('resize', hours, -DAY, units, calendar);
    expect(parseDuration((h as { fields: { duration: string } }).fields.duration, units).minutes).toBe(1);
  });

  it('progress sets % Complete rounded to 5%, within 0 to 100', () => {
    const task = makeTask('a');              // 08:00 to 17:00, 9 hours wide
    expect(opsForDrag('progress', task, 4.5 * HOUR, units, calendar)).toEqual([
      { op: 'set_percent', ids: ['a'], percent: 50 },
    ]);
    expect(opsForDrag('progress', task, 0.37 * 9 * HOUR, units, calendar)).toEqual([
      { op: 'set_percent', ids: ['a'], percent: 35 },
    ]);
    expect(opsForDrag('progress', task, 20 * HOUR, units, calendar)).toEqual([
      { op: 'set_percent', ids: ['a'], percent: 100 },
    ]);
    expect(opsForDrag('progress', makeTask('a', { percent_complete: 40 }), -20 * HOUR, units, calendar)).toEqual([
      { op: 'set_percent', ids: ['a'], percent: 0 },
    ]);
  });

  it('link adds a Finish-to-Start link to the task dropped on', () => {
    expect(opsForDrag('link', twoDays(), 'b', units, calendar)).toEqual([
      { op: 'add_link', predecessor_id: 'a', successor_id: 'b', link_type: 'FS' },
    ]);
    expect(opsForDrag('link', twoDays(), 'a', units, calendar)).toEqual([]);
  });
});

describe('workMinutes', () => {
  const at = (s: string) => toMs(s);

  it('counts the calendar’s working time between two moments, negative backwards', () => {
    expect(workMinutes(calendar, at('2026-11-02T08:00'), at('2026-11-04T17:00'))).toBe(1440);
    expect(workMinutes(calendar, at('2026-11-02T10:00'), at('2026-11-02T14:00'))).toBe(180);
    expect(workMinutes(calendar, at('2026-11-06T08:00'), at('2026-11-09T17:00'))).toBe(960);
    expect(workMinutes(calendar, at('2026-11-04T17:00'), at('2026-11-02T08:00'))).toBe(-1440);
  });

  it('a dated exception replaces the weekday’s hours', () => {
    const holiday = { ...calendar, exceptions: [{ date: '2026-11-03', name: 'Holiday', hours: [] }] };
    expect(workMinutes(holiday, at('2026-11-02T08:00'), at('2026-11-04T17:00'))).toBe(960);
    const short = { ...calendar, exceptions: [{ date: '2026-11-07', name: null, hours: [['06:00', '24:00']] as [string, string][] }] };
    expect(workMinutes(short, at('2026-11-07T00:00'), at('2026-11-08T00:00'))).toBe(18 * 60);
  });
});

describe('canLink', () => {
  const plan = makePlan({
    tasks: [
      makeTask('s', { display_id: 1, is_summary: true }),
      makeTask('a', { display_id: 2, parent_id: 's', outline_level: 2 }),
      makeTask('b', { display_id: 3 }),
    ],
    links: [makeLink('ab', 'a', 'b')],
  });

  it('refuses the same task, a link that exists, and a summary with its own subtask', () => {
    expect(canLink(plan, 'a', 'a')).toBe(false);
    expect(canLink(plan, 'a', 'b')).toBe(false);
    expect(canLink(plan, 's', 'a')).toBe(false);
    expect(canLink(plan, 'a', 's')).toBe(false);
  });

  it('leaves the rest to the API (a reversed pair is its link_cycle)', () => {
    expect(canLink(plan, 'b', 'a')).toBe(true);
    expect(canLink(plan, 's', 'b')).toBe(true);
  });
});

describe('pointerScaleX', () => {
  it('is the pointer’s x on the scale: in from the pane’s left edge, plus the sideways scroll', () => {
    expect(pointerScaleX(300, 100, 0)).toBe(200);
    expect(pointerScaleX(300, 100, 500)).toBe(700);
    expect(DRAG_THRESHOLD_PX).toBe(3);
  });
});
