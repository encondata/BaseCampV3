/**
 * lib/plans/drag.ts: what a press on a Gantt bar means (its zones), the
 * snap of each zoom, and the ops a finished drag sends — a move's Start, a
 * resize's Duration in the task's own unit, a progress drag's % Complete,
 * a link drag's FS link — plus the working time a resize measures, the
 * links a drop may make, and where a pointer sits on the scale.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PlanCalendar } from './api';
import { DURATION_UNITS, STANDARD_UNITS, parseDuration } from './durations';
import { toMs } from './floatingTime';
import { makeLink, makePlan, makeTask } from './planFixtures';
import {
  DRAG_THRESHOLD_PX, GRIP_PX, MIN_GRIP_BAR_PX, MOVE_REFUSAL, RESIZE_PX, canLink, dragKind, exactDurationText, gripX,
  moveRefusal, opsForDrag, pointerScaleX, showsTimes, snapMs, snapShift, workMinutes,
} from './drag';
import type { Zoom } from './ganttGeometry';

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

describe('progress only (a locked plan)', () => {
  it('every bar has a handle, at its progress edge, with no resize zone to share', () => {
    const day = { x: 100, width: 18, done: 0, milestone: false };
    expect(dragKind(101, day, true)).toBe('progress');
    expect(dragKind(110, day, true)).toBe('move');           // not a handle: the lane's press
    const full = { ...day, done: 18 };
    expect(gripX(full, true)).toBe(118);
    expect(dragKind(117, full, true)).toBe('progress');
    expect(dragKind(119, full, true)).toBe('progress');
    expect(dragKind(100, { x: 100, width: 0, done: 0, milestone: true }, true)).toBe('move');
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

  it('the finer steps snap to 5 minutes (wide and quarter hours) and to the minute (five minutes)', () => {
    expect(snapMs(at('2026-11-02T08:02'), 'wideHours')).toBe(at('2026-11-02T08:00'));
    expect(snapMs(at('2026-11-02T08:03'), 'wideHours')).toBe(at('2026-11-02T08:05'));
    expect(snapMs(at('2026-11-02T08:07'), 'quarterHours')).toBe(at('2026-11-02T08:05'));
    expect(snapMs(at('2026-11-02T08:07'), 'fiveMinutes')).toBe(at('2026-11-02T08:07'));
    expect(snapMs(at('2026-11-02T08:07') + 31_000, 'fiveMinutes')).toBe(at('2026-11-02T08:08'));
  });

  it('shows times while dragging at every step that snaps finer than a day', () => {
    expect(['fiveMinutes', 'quarterHours', 'wideHours', 'hours', 'days'].every((z) => showsTimes(z as Zoom))).toBe(true);
    expect(['weeks', 'months', 'quarters'].some((z) => showsTimes(z as Zoom))).toBe(false);
  });
});

describe('snapShift', () => {
  const at = (s: string) => toMs(s);

  it('at whole-day snaps the move snaps, so a task keeps its clock time', () => {
    const from = at('2026-11-03T13:00');
    expect(snapShift(from, 0.3 * DAY, 'weeks')).toBe(from);                   // back where it began
    expect(snapShift(from, 7 * DAY + 3 * HOUR, 'weeks')).toBe(at('2026-11-10T13:00'));
    expect(snapShift(from, -1.6 * DAY, 'months')).toBe(at('2026-11-01T13:00'));
    expect(snapShift(from, 40 * DAY, 'quarters')).toBe(at('2026-12-13T13:00'));
  });

  it('at the hour and quarter-hour snaps the move snaps too', () => {
    expect(snapShift(at('2026-11-03T08:00'), DAY + 5.4 * HOUR, 'days')).toBe(at('2026-11-04T13:00'));
    expect(snapShift(at('2026-11-03T08:00'), 0.3 * HOUR, 'hours')).toBe(at('2026-11-03T08:15'));
    // off the snap: the task keeps its minutes, so a drop at its origin is no change
    expect(snapShift(at('2026-11-03T08:10'), 0.3 * HOUR, 'days')).toBe(at('2026-11-03T08:10'));
    expect(snapShift(at('2026-11-03T08:10'), 1.4 * HOUR, 'days')).toBe(at('2026-11-03T09:10'));
    expect(snapShift(at('2026-11-03T08:10'), 0.1 * HOUR, 'hours')).toBe(at('2026-11-03T08:10'));
    expect(snapShift(at('2026-11-03T08:10'), 0.3 * HOUR, 'hours')).toBe(at('2026-11-03T08:25'));
  });
});

describe('the shared work_between vectors (api/tests/fixtures/plans/work_between.json)', () => {
  interface Row { name: string; calendar: PlanCalendar; a: string; b: string; minutes: number }
  const ROWS: Row[] = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '../../../../api/tests/fixtures/plans/work_between.json'), 'utf8'));

  it('has the rows the API wrote', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(20);
  });

  it.each(ROWS.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    expect(workMinutes(row.calendar, toMs(row.a), toMs(row.b))).toBe(row.minutes);
  });
});

describe('exactDurationText', () => {
  it('writes the fewest decimals that parse back to exactly the minutes', () => {
    expect(exactDurationText(960, 'd', false, units)).toBe('2 days');
    expect(exactDurationText(1020, 'd', false, units)).toBe('2.125 days');
    expect(parseDuration(exactDurationText(1020, 'd', false, units), units).minutes).toBe(1020);
    expect(exactDurationText(495, 'd', false, units)).toBe('1.031 days');
    expect(exactDurationText(75, 'h', false, units)).toBe('1.25 hrs');
    expect(exactDurationText(1440, 'd', true, units)).toBe('1 eday');
  });

  it('every quarter hour in every unit round-trips', () => {
    for (const unit of DURATION_UNITS) {
      for (const elapsed of [false, true]) {
        for (let minutes = 15; minutes <= 5 * 2400; minutes += 15) {
          const text = exactDurationText(minutes, unit, elapsed, units);
          const back = parseDuration(text, units);
          // in the task's own unit: the parser's decimals always suffice for it
          expect([back.minutes, back.unit, back.elapsed], text).toEqual([minutes, unit, elapsed]);
        }
      }
    }
  });

  it('falls back to the next smaller unit when no decimals up to the limit round-trip', () => {
    expect(exactDurationText(1020, 'd', false, units, 2)).toBe('17 hrs');
    expect(exactDurationText(1021, 'd', false, units, 2)).toBe('17.02 hrs');
    expect(exactDurationText(61, 'h', false, units, 1)).toBe('61 mins');
  });
});

describe('moveRefusal', () => {
  it('refuses to move a task that has started; nothing else is refused', () => {
    expect(MOVE_REFUSAL).toBe('This task has started — change its Actual Start instead.');
    expect(moveRefusal(makeTask('a', { actual_start: '2026-11-02T08:00', percent_complete: 25 }))).toBe(MOVE_REFUSAL);
    expect(moveRefusal(makeTask('a'))).toBeNull();
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

  it('a resize past the start keeps a minute, in text the API reads as exactly one', () => {
    const [op] = opsForDrag('resize', twoDays(), -3 * DAY, units, calendar);
    const text = (op as { fields: { duration: string } }).fields.duration;
    expect(parseDuration(text, units).minutes).toBe(1);
    const hours = makeTask('h', { duration_minutes: 240, duration_unit: 'h', finish: '2026-11-02T12:00' });
    const [h] = opsForDrag('resize', hours, -DAY, units, calendar);
    expect(parseDuration((h as { fields: { duration: string } }).fields.duration, units).minutes).toBe(1);
  });

  it('a resize’s text parses back to exactly the working time measured', () => {
    // Mon 13:00 to Wed 12:00 is two days; two more hours ends Wed 14:00, past the lunch hour
    const task = makeTask('a', { start: '2026-11-02T13:00', finish: '2026-11-04T12:00', duration_minutes: 960 });
    const [op] = opsForDrag('resize', task, 2 * HOUR, units, calendar);
    const text = (op as { fields: { duration: string } }).fields.duration;
    expect(text).toBe('2.125 days');
    expect(parseDuration(text, units).minutes).toBe(1020);
    // every quarter hour the hours zoom snaps to, through one morning
    const early = makeTask('e', { start: '2026-11-02T08:00', finish: '2026-11-02T09:00', duration_minutes: 60 });
    for (let k = 1; k <= 12; k += 1) {
      const [q] = opsForDrag('resize', early, k * 15 * 60_000, units, calendar);
      expect(parseDuration((q as { fields: { duration: string } }).fields.duration, units).minutes).toBe(60 + 15 * k);
    }
  });

  it('a move keeps a manual task’s clock time at a whole-day snap', () => {
    const manual = twoDays({ mode: 'manual', start: '2026-11-02T13:00' });
    const from = toMs('2026-11-02T13:00');
    expect(opsForDrag('move', manual, snapShift(from, 7 * DAY + 2 * HOUR, 'weeks') - from, units, calendar)).toEqual([
      { op: 'update_task', id: 'a', fields: { start: '2026-11-09T13:00' } },
    ]);
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
