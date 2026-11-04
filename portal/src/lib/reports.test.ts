import { describe, expect, it } from 'vitest';

import type { InitiativeItem } from './api';
import {
  fmtDate, MOVE_REPORT_SECTIONS, runErrorText, sectionCount, sortInitiativesForPicker,
} from './reports';

describe('run error text', () => {
  it('says each project plan refusal and failure in a sentence', () => {
    expect(runErrorText('project_plans_view_required'))
      .toBe('You need permission to view project plans to run this report.');
    expect(runErrorText('plan_not_found')).toBe('This initiative has no project plan yet.');
    expect(runErrorText('bad_calendar'))
      .toBe('This plan’s calendar can’t be read, so the PDF couldn’t be made. Check Plan settings › Calendar.');
    expect(runErrorText('range_too_long')).toBe('The date range can be at most 10 years.');
    expect(runErrorText('range_outside_plan')).toBe('The dates are outside this plan’s tasks.');
    expect(runErrorText('something_new')).toBe('something_new');
  });
});

const ini = (name: string, status: string, archived = false) => ({
  name, status, archived_at: archived ? '2026-01-01T00:00:00Z' : null,
} as InitiativeItem);

describe('reports helpers', () => {
  it('lists the eight sections in V2 order', () => {
    expect(MOVE_REPORT_SECTIONS.map((s) => s.key)).toEqual([
      'summary', 'assets_by_source', 'assets_by_destination', 'size_weight',
      'rail_usage', 'collisions', 'source_racks', 'destination_racks',
    ]);
    expect(MOVE_REPORT_SECTIONS[1].description).toBe('Assets sorted by source rack and RU');
  });
  it('counts enabled sections', () => {
    expect(sectionCount({ summary: true, collisions: false })).toBe(1);
  });
  it('sorts in_progress, scheduled, planned first, then on_hold, then the rest; name within group; no archived', () => {
    const out = sortInitiativesForPicker([
      ini('Zeta', 'completed'), ini('Beta', 'planned'), ini('Alpha', 'in_progress'),
      ini('Gamma', 'scheduled'), ini('Held', 'on_hold'), ini('Old', 'planned', true),
      ini('Anna', 'planned'), ini('Cancelled', 'cancelled'),
    ]);
    expect(out.map((i) => i.name)).toEqual([
      'Alpha', 'Gamma', 'Anna', 'Beta', 'Held', 'Cancelled', 'Zeta',
    ]);
  });

  describe('fmtDate', () => {
    it('renders the picked calendar day, not the evening before, west of UTC', () => {
      // scheduled_start/scheduled_end are date-only fields stored as
      // midnight UTC for a plain YYYY-MM-DD input. vitest runs under
      // whatever TZ the shell inherits, so a bare `new Date(iso)` bug
      // wouldn't show up on a UTC host — pin a west-of-UTC zone to
      // actually exercise the previous-evening rollback.
      const prevTz = process.env.TZ;
      process.env.TZ = 'America/New_York';
      try {
        expect(fmtDate('2026-09-01')).toBe(new Date(2026, 8, 1).toLocaleDateString());
      } finally {
        if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
      }
    });

    it('returns the dash for a null date', () => {
      expect(fmtDate(null)).toBe('—');
    });
  });
});
