/** Plain-language text for the plan API's error codes. Every code the API
 *  can answer gets a sentence (Ruling B4): the test reads the codes from the
 *  API source itself, so a new one fails here until it has wording. */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ApiError } from '../api';
import { PLAN_ERRORS, planErrorDetail, planErrorText } from './errors';

const API = path.resolve(__dirname, '../../../../api/src/serversherpa');

/** Every error or notice code written in the plan package and its route. */
function apiCodes(): Set<string> {
  const files = [
    ...fs.readdirSync(path.join(API, 'plans')).filter((f) => f.endsWith('.py'))
      .map((f) => path.join(API, 'plans', f)),
    path.join(API, 'api/routes/plans.py'),
  ];
  const patterns = [
    /err\(\s*\d{3},\s*"([a-z_]+)"/g,                // err(422, "bad_field", ...)
    /"code":\s*"([a-z_]+)"/g,                       // notices
    /\bcode(?::\s*str)?\s*=\s*"([a-z_]+)"/g,        // error classes
    /CalendarError\([^()]*,\s*"([a-z_]+)"\)/g,      // CalendarError(message, "bad_calendar")
  ];
  const codes = new Set<string>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const re of patterns) {
      for (const m of text.matchAll(re)) codes.add(m[1]);
    }
  }
  return codes;
}

const apiError = (status: number, detail: Record<string, unknown>) =>
  new ApiError(status, String(detail.code), detail);

describe('PLAN_ERRORS', () => {
  it('has a sentence for every code the plan API answers', () => {
    const codes = apiCodes();
    // sanity: the scan found the codes the brief names
    for (const code of ['plan_changed', 'link_cycle', 'bad_restore', 'constraint_added',
      'completion_confirm', 'bad_calendar', 'no_working_time', 'schedule_error']) {
      expect(codes).toContain(code);
    }
    const missing = [...codes].filter((code) => !PLAN_ERRORS[code]);
    expect(missing).toEqual([]);
  });

  it('covers the codes every route shares', () => {
    for (const code of ['forbidden', 'initiative_not_found', 'plan_not_found', 'no_plan', 'plan_exists']) {
      expect(PLAN_ERRORS[code]).toBeTruthy();
    }
  });

  it('writes one plain sentence per code', () => {
    for (const [code, text] of Object.entries(PLAN_ERRORS)) {
      expect(text, code).toMatch(/^[A-Z%].*[.]$/);
      expect(text, code).not.toMatch(/[a-z]_[a-z]/);    // no field or code names
      expect(text, code).not.toMatch(/[.!?]\s/);        // one sentence
    }
  });
});

describe('planErrorText', () => {
  it('names the display IDs of a cycle', () => {
    expect(planErrorText(apiError(422, { code: 'link_cycle', task_ids: ['a', 'b'], display_ids: [2, 5] })))
      .toBe('Tasks 2 and 5 would depend on each other.');
    expect(planErrorText(apiError(422, { code: 'link_cycle', task_ids: [], display_ids: [2, 5, 7] })))
      .toBe('Tasks 2, 5 and 7 would depend on each other.');
    expect(planErrorText(apiError(422, { code: 'link_cycle', display_ids: [] })))
      .toBe(PLAN_ERRORS.link_cycle);
  });

  it('names the tasks at fault in an outline or summary error', () => {
    expect(planErrorText(apiError(422, { code: 'link_to_outline', display_ids: [1, 2], link_ids: ['l1'] })))
      .toBe(`${PLAN_ERRORS.link_to_outline} Check tasks 1 and 2.`);
    expect(planErrorText(apiError(422, { code: 'bad_summary_constraint', display_ids: [4] })))
      .toBe(`${PLAN_ERRORS.bad_summary_constraint} Check task 4.`);
  });

  it('names the field of a bad value', () => {
    expect(planErrorText(apiError(422, { code: 'bad_field', field: 'constraint_date' })))
      .toBe('Check the Constraint Date value.');
    expect(planErrorText(apiError(422, { code: 'bad_field', field: 'settings.reminders.offsets_days' })))
      .toBe('Check the “Days before due” setting.');
    expect(planErrorText(apiError(422, { code: 'bad_field', field: 'default_duration' })))
      .toBe('Check the “Default duration” setting.');
    expect(planErrorText(apiError(422, { code: 'bad_field', field: 'settings.made_up' })))
      .toBe('Check the plan settings.');
    expect(planErrorText(apiError(422, { code: 'bad_field', field: 'mystery' })))
      .toBe(PLAN_ERRORS.bad_field);
    expect(planErrorText(apiError(422, { code: 'bad_field' }))).toBe(PLAN_ERRORS.bad_field);
  });

  it('tells a bad lag from a bad duration', () => {
    expect(planErrorText(apiError(422, { code: 'bad_duration', field: 'lag' })))
      .toMatch(/^Enter a lag like/);
    expect(planErrorText(apiError(422, { code: 'bad_duration', field: 'duration' })))
      .toBe(PLAN_ERRORS.bad_duration);
  });

  it('passes on the parser’s detail for bad predecessors', () => {
    expect(planErrorText(apiError(422, {
      code: 'bad_predecessor', field: 'predecessors', task_id: 't', message: 'task 12 does not exist in this plan',
    }))).toBe('Task 12 does not exist in this plan.');
  });

  it('adds the calendar’s own message', () => {
    expect(planErrorText(apiError(422, { code: 'bad_calendar', message: 'calendar.week is missing mon' })))
      .toBe(`${PLAN_ERRORS.bad_calendar} Calendar.week is missing mon.`);
  });

  it('falls back to apiErrorText for everything else', () => {
    expect(planErrorText(apiError(409, { code: 'plan_locked' }))).toBe(PLAN_ERRORS.plan_locked);
    expect(planErrorText(apiError(403, { code: 'forbidden' }))).toBe(PLAN_ERRORS.forbidden);
    expect(planErrorText(apiError(422, { code: 'something_new', message: 'Server says no.' })))
      .toBe('Server says no.');
    expect(planErrorText(new Error('boom'))).toBe('Something went wrong. Try again.');
  });
});

describe('planErrorDetail', () => {
  it('reads the typed detail of a plan error', () => {
    const detail = { code: 'completion_blocked', blockers: [{ task_id: 't', display_id: 3, name: 'Rack', reason: 'predecessor' }] };
    expect(planErrorDetail(apiError(409, detail))).toEqual(detail);
  });

  it('answers null for anything that is not an ApiError with a detail object', () => {
    expect(planErrorDetail(new Error('x'))).toBeNull();
    expect(planErrorDetail(new ApiError(500, 'unknown_error'))).toBeNull();
    expect(planErrorDetail(new ApiError(500, 'unknown_error', 'text'))).toBeNull();
  });
});
