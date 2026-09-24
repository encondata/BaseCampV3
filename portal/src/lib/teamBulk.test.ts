import { describe, expect, it } from 'vitest';

import { jobOptionDetail, TEAM_COLUMN_GUIDE, TEAM_BULK_ERRORS } from './teamBulk';

describe('team bulk guide', () => {
  it('lists exactly the API columns, worker required', () => {
    expect(TEAM_COLUMN_GUIDE.map((c) => c.key)).toEqual(['worker', 'site', 'role']);
    expect(TEAM_COLUMN_GUIDE.filter((c) => c.required).map((c) => c.key)).toEqual(['worker']);
  });
  it('maps the API error codes the page can hit', () => {
    for (const code of ['rows_invalid', 'initiative_archived', 'invalid_overrides',
      'invalid_row_numbers', 'unknown_columns', 'too_many_rows', 'forbidden']) {
      expect(TEAM_BULK_ERRORS[code]).toBeTruthy();
    }
  });
  it('describes a job so two same-named jobs are distinguishable', () => {
    const job = { type_label: 'Move', client_name: 'Acme', scheduled_start: '2026-10-01T00:00:00Z' };
    expect(jobOptionDetail(job as never)).toBe('Move · Acme · Oct 1, 2026');
    expect(jobOptionDetail({ type_label: 'Event', client_name: null, scheduled_start: null } as never)).toBe('Event');
  });
});
