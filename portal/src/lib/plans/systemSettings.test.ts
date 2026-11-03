/**
 * lib/plans/systemSettings.ts: System settings › Project plans as a form.
 * `toDraft` reads GET /system/project-plans; `evaluate` checks the draft
 * with Plan settings' own rules (settingsForm) and builds the PUT: only the
 * keys that changed, and a changed group (`completion`, `reminders`) or
 * calendar goes whole, since the API replaces nested objects.
 */
import { describe, expect, it } from 'vitest';

import { makeSystemSettings } from './planFixtures';
import { evaluate, fixHint, isDirty, isValid, toDraft, type SystemSettingsDraft } from './systemSettings';

const SYSTEM_SETTINGS = makeSystemSettings();

const edit = (fn: (d: SystemSettingsDraft) => void): SystemSettingsDraft => {
  const next = structuredClone(toDraft(SYSTEM_SETTINGS));
  fn(next);
  return next;
};
const run = (fn: (d: SystemSettingsDraft) => void) => evaluate(edit(fn), SYSTEM_SETTINGS);

describe('toDraft', () => {
  it('reads the settings: numbers as text, the offsets as picked days, the calendar by day', () => {
    const d = toDraft(SYSTEM_SETTINGS);
    expect(d.criticalSlackDays).toBe('0');
    expect(d.defaultDuration).toBe('1d');
    expect(d.defaultTaskMode).toBe('auto');
    expect(d.honorConstraints).toBe(true);
    expect(d.showTimes).toBe(false);
    expect(d.reminders.offsets_days).toEqual(['3', '1']);
    expect(d.reminders.send_time).toBe('08:00');
    expect(d.completion).toEqual({ subtasks: 'cascade', predecessors: 'block' });
    expect(d.calendar.week.mon).toEqual({ working: true, ranges: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }] });
    expect(d.calendar.week.sat.working).toBe(false);
    expect(d.calendar.exceptions[0]).toMatchObject({ date: '2026-11-26', name: 'Thanksgiving', working: false });
  });

  it('does not share the saved settings’ objects', () => {
    const d = toDraft(SYSTEM_SETTINGS);
    d.completion.subtasks = 'none';
    d.reminders.enabled = false;
    expect(SYSTEM_SETTINGS.completion.subtasks).toBe('cascade');
    expect(SYSTEM_SETTINGS.reminders.enabled).toBe(true);
  });
});

describe('evaluate', () => {
  it('nothing changed: clean and valid, an empty patch', () => {
    const e = evaluate(toDraft(SYSTEM_SETTINGS), SYSTEM_SETTINGS);
    expect(e.patch).toEqual({});
    expect(e.errors).toEqual({});
    expect(isDirty(e)).toBe(false);
    expect(isValid(e)).toBe(true);
  });

  it('new offsets send the whole reminders group, days largest first', () => {
    const e = run((d) => { d.reminders.offsets_days = ['2', '7']; });
    expect(e.patch).toEqual({ reminders: { ...SYSTEM_SETTINGS.reminders, offsets_days: [7, 2] } });
    expect(isDirty(e)).toBe(true);
    expect(isValid(e)).toBe(true);
  });

  it('the same days in another order are no change', () => {
    expect(run((d) => { d.reminders.offsets_days = ['1', '3']; }).patch).toEqual({});
  });

  it('offsets: 1 to 5 days', () => {
    expect(run((d) => { d.reminders.offsets_days = []; }).errors['reminders.offsets_days']).toBe('Pick 1 to 5 days.');
    expect(run((d) => { d.reminders.offsets_days = ['6', '5', '4', '3', '2', '1']; }).errors['reminders.offsets_days'])
      .toBe('Pick 1 to 5 days.');
    expect(run((d) => { d.reminders.offsets_days = ['14', '7', '3', '2', '1']; }).errors).toEqual({});
  });

  it('a switch or the send time in reminders sends the whole group', () => {
    const e = run((d) => { d.reminders.email_assignees = false; d.reminders.send_time = '07:30'; });
    expect(e.patch).toEqual({ reminders: { ...SYSTEM_SETTINGS.reminders, email_assignees: false, send_time: '07:30' } });
  });

  it('a cleared send time is an error', () => {
    const e = run((d) => { d.reminders.send_time = ''; });
    expect(e.errors['reminders.send_time']).toBe('Enter a time like 08:00.');
    expect(isValid(e)).toBe(false);
  });

  it('a completion rule sends the whole completion group', () => {
    expect(run((d) => { d.completion.predecessors = 'warn'; }).patch)
      .toEqual({ completion: { subtasks: 'cascade', predecessors: 'warn' } });
  });

  it('the scheduling keys go one by one; the duration trimmed', () => {
    const e = run((d) => {
      d.honorConstraints = false;
      d.showTimes = true;
      d.defaultTaskMode = 'manual';
      d.defaultDuration = ' 2d ';
    });
    expect(e.patch).toEqual({ honor_constraints: false, show_times: true, default_task_mode: 'manual', default_duration: '2d' });
  });

  it('critical slack takes fractions of a day', () => {
    expect(run((d) => { d.criticalSlackDays = '0.5'; }).patch).toEqual({ critical_slack_days: 0.5 });
    expect(run((d) => { d.criticalSlackDays = '0.0'; }).patch).toEqual({});
    for (const bad of ['', '-1', '31', 'abc']) {
      const e = run((d) => { d.criticalSlackDays = bad; });
      expect(e.errors.criticalSlackDays, bad).toBe('Enter 0 to 30 days (halves and quarters are fine).');
      expect(isValid(e)).toBe(false);
      // changed, but nothing sendable: a blank is not 0
      expect(isDirty(e)).toBe(true);
      expect(e.patch, bad).toEqual({});
    }
  });

  it('a duration the parser refuses is an error, and the draft still counts as changed', () => {
    const e = run((d) => { d.defaultDuration = 'abc'; });
    expect(e.errors.defaultDuration).toBeTruthy();
    expect(isValid(e)).toBe(false);
    expect(isDirty(e)).toBe(true);
    expect(e.patch).toEqual({});
  });

  it('the patch holds only good values: a wrong calendar or reminder group stays out of it', () => {
    const e = run((d) => {
      d.calendar.hoursPerDay = '25';
      d.reminders.offsets_days = [];
      d.honorConstraints = false;
    });
    expect(e.patch).toEqual({ honor_constraints: false });
    expect(isDirty(e)).toBe(true);
    expect(isValid(e)).toBe(false);
  });

  it('the errors come in page order: Scheduling, the calendar, then Reminders', () => {
    const e = run((d) => {
      d.reminders.send_time = '';
      d.reminders.offsets_days = [];
      d.calendar.hoursPerDay = '25';
      d.defaultDuration = 'abc';
      d.criticalSlackDays = '';
    });
    expect(Object.keys(e.errors)).toEqual([
      'criticalSlackDays', 'defaultDuration', 'calendar.hoursPerDay', 'reminders.offsets_days', 'reminders.send_time',
    ]);
  });

  it('a calendar change sends the whole calendar; the same calendar is no change', () => {
    const e = run((d) => { d.calendar.week.sat = { working: true, ranges: [{ start: '09:00', end: '13:00' }] }; });
    expect(e.patch).toEqual({
      calendar: { ...SYSTEM_SETTINGS.calendar, week: { ...SYSTEM_SETTINGS.calendar.week, sat: [['09:00', '13:00']] } },
    });
    expect(run((d) => { d.calendar.hoursPerDay = '8.0'; }).patch).toEqual({});
  });

  it('the calendar is checked by Plan settings’ rules, keyed for CalendarEditor', () => {
    const e = run((d) => {
      for (const day of ['mon', 'tue', 'wed', 'thu', 'fri'] as const) d.calendar.week[day].working = false;
      d.calendar.hoursPerDay = '25';
    });
    expect(e.errors['calendar.week']).toBe('At least one working day is needed');
    expect(e.errors['calendar.hoursPerDay']).toBe('Hours per day: more than 0, at most 24.');
    expect(isValid(e)).toBe(false);
  });

  it('the default duration is held to 10 years in the draft calendar’s units', () => {
    expect(run((d) => { d.defaultDuration = '600mo'; }).errors.defaultDuration).toBe('A duration can be at most 10 years.');
  });
});

describe('fixHint', () => {
  const hint = (fn: (d: SystemSettingsDraft) => void) => {
    const d = edit(fn);
    return fixHint(evaluate(d, SYSTEM_SETTINGS).errors, d);
  };

  it('nothing wrong: no hint', () => {
    expect(hint(() => {})).toBeNull();
  });

  it('names the first field that needs fixing, by the label it shows under', () => {
    expect(hint((d) => { d.defaultDuration = 'abc'; })).toBe('Fix “Default duration” above.');
    expect(hint((d) => { d.criticalSlackDays = ''; })).toBe('Fix “Critical slack (days)” above.');
    expect(hint((d) => { d.reminders.offsets_days = []; })).toBe('Fix “Days before due” above.');
    expect(hint((d) => { d.reminders.send_time = ''; })).toBe('Fix “Send time” above.');
    expect(hint((d) => { d.calendar.hoursPerDay = '25'; })).toBe('Fix “Hours per day” above.');
    expect(hint((d) => { d.calendar.week.tue.ranges = [{ start: '17:00', end: '08:00' }]; })).toBe('Fix “Tuesday” above.');
    expect(hint((d) => { d.calendar.defaultEnd = '07:00'; })).toBe('Fix “Default start and end time” above.');
    expect(hint((d) => { d.calendar.exceptions[0].date = ''; })).toBe('Fix “Exception 1” above.');
    expect(hint((d) => {
      for (const day of ['mon', 'tue', 'wed', 'thu', 'fri'] as const) d.calendar.week[day].working = false;
    })).toBe('Fix “Working week” above.');
  });

  it('counts the rest', () => {
    expect(hint((d) => { d.defaultDuration = 'abc'; d.reminders.send_time = ''; }))
      .toBe('Fix “Default duration” and 1 more above.');
    expect(hint((d) => { d.criticalSlackDays = ''; d.defaultDuration = 'abc'; d.reminders.send_time = ''; }))
      .toBe('Fix “Critical slack (days)” and 2 more above.');
  });
});
