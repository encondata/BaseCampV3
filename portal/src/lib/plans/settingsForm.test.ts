/**
 * lib/plans/settingsForm.ts: Plan settings as a form. `toForm` reads the
 * plan (inherited keys marked "Use system default"); `toPatch` sends only
 * what changed, plus base_version (an inherited key sends null; a locked
 * plan only status date and owner); `validate` holds the calendar and the
 * settings to the API's rules.
 */
import { describe, expect, it } from 'vitest';

import { makePlan } from './planFixtures';
import {
  CALENDAR_LIMITS, NO_WORKING_DAY, systemValueText, toCalendar, toForm, toPatch, validate, type SettingsForm,
} from './settingsForm';

const plan = (over = {}) => makePlan({
  version: 7,
  owner_id: 'p1',
  timezone: 'America/New_York',
  project_start: '2026-11-02T08:00',
  status_date: null,
  settings_overrides: { completion: { predecessors: 'warn' } },
  ...over,
});

const edit = (form: SettingsForm, fn: (f: SettingsForm) => void): SettingsForm => {
  const next = structuredClone(form);
  fn(next);
  return next;
};

describe('toForm', () => {
  it('reads the plan: dates as input values, inherited keys marked, the calendar by day', () => {
    const form = toForm(plan());
    expect(form.projectStart).toBe('2026-11-02');
    expect(form.statusDate).toBe('');
    expect(form.ownerId).toBe('p1');
    expect(form.completion.predecessors).toEqual({ inherit: false, value: 'warn' });
    expect(form.completion.subtasks).toEqual({ inherit: true, value: 'cascade' });
    expect(form.reminders.offsets_days).toEqual({ inherit: true, value: '1' });
    expect(form.calendar.week.mon).toEqual({ working: true, ranges: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }] });
    expect(form.calendar.week.sat).toEqual({ working: false, ranges: [] });
    expect(form.criticalSlackDays).toBe('0');
  });

  it('with Show times on, dates carry their time', () => {
    const p = plan({ status_date: '2026-11-04T17:00' });
    const form = toForm({ ...p, settings: { ...p.settings, show_times: true } });
    expect(form.projectStart).toBe('2026-11-02T08:00');
    expect(form.statusDate).toBe('2026-11-04T17:00');
  });
});

describe('toPatch', () => {
  it('nothing changed: base_version alone', () => {
    const p = plan();
    expect(toPatch(toForm(p), p)).toEqual({ base_version: 7 });
  });

  it('turning "Use system default" back on for predecessors sends null for that key only', () => {
    const p = plan();
    const form = edit(toForm(p), (f) => { f.completion.predecessors.inherit = true; });
    expect(toPatch(form, p)).toEqual({ base_version: 7, settings: { completion: { predecessors: null } } });
  });

  it('turning it off sends the value, even when it equals the system value (the plan pins it)', () => {
    const p = plan();
    const form = edit(toForm(p), (f) => { f.reminders.send_time.inherit = false; });
    expect(toPatch(form, p)).toEqual({ base_version: 7, settings: { reminders: { send_time: '08:00' } } });
  });

  it('sends the changed General keys: project start, timezone, owner, status date, slack, mode', () => {
    const p = plan();
    const form = edit(toForm(p), (f) => {
      f.projectStart = '2026-11-09';
      f.timezone = 'America/Chicago';
      f.ownerId = '';
      f.statusDate = '2026-11-05';
      f.criticalSlackDays = '1.5';
      f.defaultTaskMode = 'manual';
      f.showTimes = true;
    });
    expect(toPatch(form, p)).toEqual({
      base_version: 7,
      project_start: '2026-11-09',
      timezone: 'America/Chicago',
      owner_id: null,
      status_date: '2026-11-05',
      settings: { critical_slack_days: 1.5, default_task_mode: 'manual', show_times: true },
    });
  });

  it('clearing the status date sends null (now)', () => {
    const p = plan({ status_date: '2026-11-04T17:00' });
    expect(toPatch(edit(toForm(p), (f) => { f.statusDate = ''; }), p)).toEqual({ base_version: 7, status_date: null });
  });

  it('the offsets go as whole days, largest first', () => {
    const p = plan();
    const form = edit(toForm(p), (f) => { f.reminders.offsets_days = { inherit: false, value: '1, 7,3' }; });
    expect(toPatch(form, p)).toEqual({ base_version: 7, settings: { reminders: { offsets_days: [7, 3, 1] } } });
  });

  it('a calendar change sends the whole calendar; exceptions in the API’s shape', () => {
    const p = plan();
    const form = edit(toForm(p), (f) => {
      f.calendar.week.sat = { working: true, ranges: [{ start: '06:00', end: '24:00' }] };
      f.calendar.exceptions.push(
        { key: 'x1', date: '2026-11-26', name: ' Thanksgiving ', working: false, ranges: [] },
        { key: 'x2', date: '2026-11-14', name: '', working: true, ranges: [{ start: '06:00', end: '22:00' }] },
      );
    });
    const patch = toPatch(form, p);
    expect(Object.keys(patch)).toEqual(['base_version', 'calendar']);
    expect(patch.calendar?.week.sat).toEqual([['06:00', '24:00']]);
    expect(patch.calendar?.exceptions).toEqual([
      { date: '2026-11-26', name: 'Thanksgiving', hours: [] },
      { date: '2026-11-14', name: null, hours: [['06:00', '22:00']] },
    ]);
  });

  it('a locked plan sends only status date and owner', () => {
    const p = plan({ locked_at: '2026-10-27T12:00:00Z' });
    const form = edit(toForm(p), (f) => {
      f.ownerId = 'p2';
      f.timezone = 'America/Chicago';
      f.completion.predecessors.inherit = true;
    });
    expect(toPatch(form, p)).toEqual({ base_version: 7, owner_id: 'p2' });
  });
});

describe('validate', () => {
  const ok = toForm(plan());

  it('the plan as it is passes', () => {
    expect(validate(ok)).toEqual({});
  });

  it('an empty week: "At least one working day is needed"', () => {
    const form = edit(ok, (f) => {
      for (const day of Object.values(f.calendar.week)) day.working = false;
    });
    expect(validate(form)['calendar.week']).toBe(NO_WORKING_DAY);
    expect(NO_WORKING_DAY).toBe('At least one working day is needed');
  });

  it('24:00 ends hours but never starts them; hours end after they start and don’t overlap', () => {
    const at = (ranges: [string, string][]) => validate(edit(ok, (f) => {
      f.calendar.week.mon.ranges = ranges.map(([start, end]) => ({ start, end }));
    }))['calendar.week.mon'];
    expect(at([['08:00', '24:00']])).toBeUndefined();
    expect(at([['24:00', '24:00']])).toMatch(/24:00/);
    expect(at([['12:00', '08:00']])).toMatch(/end after/);
    expect(at([['08:00', '12:00'], ['11:00', '13:00']])).toMatch(/overlap/);
    expect(at([['8am', '12:00']])).toMatch(/HH:MM/);
  });

  it('hours a day, a week and days a month stay within the API’s limits', () => {
    expect(CALENDAR_LIMITS).toEqual({ hoursPerDay: 24, hoursPerWeek: 168, daysPerMonth: 31 });
    const errs = validate(edit(ok, (f) => {
      f.calendar.hoursPerDay = '25';
      f.calendar.hoursPerWeek = '0';
      f.calendar.daysPerMonth = '31.5';
    }));
    expect(Object.keys(errs).sort()).toEqual(['calendar.daysPerMonth', 'calendar.hoursPerDay', 'calendar.hoursPerWeek']);
    expect(validate(edit(ok, (f) => { f.calendar.hoursPerDay = '7.5'; }))).toEqual({});
  });

  it('exceptions: a real date, once each, a one-line name', () => {
    const errs = validate(edit(ok, (f) => {
      f.calendar.exceptions = [
        { key: 'a', date: '2026-11-26', name: 'Thanks\tgiving', working: false, ranges: [] },
        { key: 'b', date: '2026-11-26', name: '', working: false, ranges: [] },
        { key: 'c', date: '', name: '', working: false, ranges: [] },
      ];
    }));
    expect(errs['calendar.exceptions.a']).toMatch(/line break or a tab/);
    expect(errs['calendar.exceptions.b']).toMatch(/once/);
    expect(errs['calendar.exceptions.c']).toMatch(/date/);
  });

  it('default times, default duration, critical slack, offsets and send time', () => {
    const errs = validate(edit(ok, (f) => {
      f.calendar.defaultStart = '17:00';
      f.calendar.defaultEnd = '08:00';
      f.defaultDuration = 'soon';
      f.criticalSlackDays = '-1';
      f.reminders.offsets_days = { inherit: false, value: '3, 3' };
      f.reminders.send_time = { inherit: false, value: '25:00' };
    }));
    expect(Object.keys(errs).sort()).toEqual([
      'calendar.defaults', 'criticalSlackDays', 'defaultDuration', 'reminders.offsets_days', 'reminders.send_time',
    ]);
    // inherited values are the system's: not checked here
    expect(validate(edit(ok, (f) => { f.reminders.send_time = { inherit: true, value: '25:00' }; }))).toEqual({});
  });
});

describe('toCalendar and systemValueText', () => {
  it('a nonworking day sends no hours', () => {
    const form = edit(toForm(plan()), (f) => { f.calendar.week.mon.working = false; });
    expect(toCalendar(form.calendar).week.mon).toEqual([]);
  });

  it('names the system value the way the control does', () => {
    expect(systemValueText('completion', 'subtasks', 'cascade')).toBe('Complete them too');
    expect(systemValueText('completion', 'predecessors', 'block')).toBe('Must be complete first');
    expect(systemValueText('reminders', 'enabled', true)).toBe('On');
    expect(systemValueText('reminders', 'offsets_days', [3, 1])).toBe('3 and 1 days before');
    expect(systemValueText('reminders', 'send_time', '08:00')).toBe('8:00 AM');
    expect(systemValueText('reminders', 'overdue', 'daily')).toBe('Daily');
  });
});
