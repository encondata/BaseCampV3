/** The project plan PDF's page geometry (lib/plans/planPdf). The shared
 *  vectors (ganttGeometry.vectors.test.ts) pin the same functions against
 *  the API's port; these say what they are for. */
import { describe, expect, it } from 'vitest';

import { MAX_YEARS } from './durations';
import { FIT_MARGIN, tiers } from './ganttGeometry';
import {
  MAX_PRINT_YEARS, RANGE_TOO_LONG, chartWidth, contentBox, estimatePages, estimateText, ganttRows, planSpan, printFit,
  printRange, printScale, spanTooLong, tablePages, tilesAcross,
} from './planPdf';

describe('the page', () => {
  it('is landscape inside 10 mm margins, with the footer under the content', () => {
    expect(contentBox('letter')).toEqual({ width: 980, height: 702 });
    expect(contentBox('a4')).toEqual({ width: 1046, height: 679 });
    expect(chartWidth('letter')).toBe(740);
    expect(chartWidth('a4')).toBe(806);
    expect(ganttRows('letter')).toBe(35);
    expect(ganttRows('a4')).toBe(34);
  });
});

describe('the range', () => {
  const span = { start: '2026-11-02T08:00', finish: '2026-11-20T17:00' };

  it('the plan’s span takes in a task before the project start', () => {
    expect(planSpan('2026-11-02T08:00', '2026-11-20T17:00', [
      { start: '2026-11-02T08:00', finish: '2026-11-03T17:00' },
      { start: '2026-10-28T08:00', finish: '2026-10-28T12:00' },
      { start: null, finish: null },
    ])).toEqual({ start: '2026-10-28T08:00', finish: '2026-11-20T17:00' });
    expect(planSpan('2026-11-02T08:00', null, [])).toEqual({ start: '2026-11-02T08:00', finish: '2026-11-02T08:00' });
  });

  it('is the plan’s span, or the custom days cut to it; days wholly outside are none', () => {
    expect(printRange(span)).toEqual(span);
    expect(printRange(span, '2026-11-09', '2026-11-12')).toEqual(
      { start: '2026-11-09T00:00', finish: '2026-11-13T00:00' });
    expect(printRange(span, '2026-10-01', '2027-12-31')).toEqual(span);
    expect(printRange(span, '2026-11-15', '2027-01-31')).toEqual(
      { start: '2026-11-15T00:00', finish: '2026-11-20T17:00' });
    expect(printRange(span, '2026-12-01', '2026-12-31')).toBeNull();
    expect(printRange(span, '2026-10-01', '2026-11-01')).toBeNull();
  });

  it('is at most ten calendar years', () => {
    expect(MAX_PRINT_YEARS).toBe(MAX_YEARS);
    expect(spanTooLong('2026-01-01T00:00', '2036-01-01T00:00')).toBe(false);
    expect(spanTooLong('2026-01-01T00:00', '2036-01-01T00:01')).toBe(true);
    expect(spanTooLong('2028-02-29T08:00', '2038-03-01T08:00')).toBe(false);
    expect(RANGE_TOO_LONG).toBe('The date range can be at most 10 years.');
  });
});

describe('printScale', () => {
  it('pads the range by half the fit margin each side, unsnapped', () => {
    const scale = printScale('2026-11-02T08:00', '2026-11-04T08:00', 'days');
    expect(scale.width).toBe(2 * 48 + FIT_MARGIN);
    expect(scale.startMs).toBe(Date.UTC(2026, 10, 2, 8) - (FIT_MARGIN / 2) * 30 * 60_000);
  });

  it('a fit range fills one page across', () => {
    const range = { start: '2026-11-02T08:00', finish: '2027-01-29T17:00' };
    for (const paper of ['letter', 'a4'] as const) {
      const zoom = printFit(range.start, range.finish, paper);
      expect(tilesAcross(printScale(range.start, range.finish, zoom).width, paper)).toBe(1);
    }
  });

  it('its timescale tiers cover the whole width', () => {
    const scale = printScale('2026-11-02T08:00', '2026-11-20T17:00', 'weeks');
    const { bottom } = tiers(scale, 'weeks');
    expect(bottom[0].x).toBe(0);
    const last = bottom[bottom.length - 1];
    expect(last.x + last.width).toBeCloseTo(scale.width, 6);
  });
});

describe('estimatePages', () => {
  const range = { start: '2026-11-02T08:00', finish: '2027-01-29T17:00' };

  it('counts the table under the title, then the Gantt tiles across and down', () => {
    expect(tablePages(10, 'letter')).toBe(1);
    expect(tablePages(60, 'letter')).toBe(3);
    const fit = estimatePages({ rows: 40, ...range, zoom: 'fit', paper: 'letter' });
    expect(fit).toEqual({ zoom: 'months', table: 2, gantt: 2, across: 1, down: 2, total: 4 });
    const days = estimatePages({ rows: 40, ...range, zoom: 'days', paper: 'letter' });
    expect(days.across).toBe(Math.ceil((88.375 * 48 + FIT_MARGIN) / 740));
    expect(days.gantt).toBe(days.across * 2);
  });

  it('changes with the zoom', () => {
    const at = (zoom: 'days' | 'weeks' | 'months') => estimatePages({ rows: 25, ...range, zoom, paper: 'a4' }).total;
    expect(at('days')).toBeGreaterThan(at('weeks'));
    expect(at('weeks')).toBeGreaterThan(at('months'));
  });

  it('reads as a sentence', () => {
    expect(estimateText({ table: 2, gantt: 6, total: 8 })).toBe('About 8 pages (2 table, 6 Gantt)');
  });
});
