import { describe, expect, it } from 'vitest';

import { ApiError, type ImportJobOut, type ImportRowDetail } from './api';
import {
  countDetails, etaSeconds, importErrorMessage, jobIsActive,
  jobProgressPct, rowsPerSecond,
} from './moveAssetImport';

const detail = (status: ImportRowDetail['status']): ImportRowDetail => ({
  row: 2, serial_number: 'sn', status, message: '',
});

const job = (over: Partial<ImportJobOut>): ImportJobOut => ({
  id: 'j1', initiative_id: 'i1', kind: 'move_assets', filename: 'ft.csv',
  options: {}, phase: 'validate', status: 'queued',
  total_rows: 0, processed_rows: 0, created_count: 0, updated_count: 0,
  error_count: 0, results: null, error: null,
  created_at: '2026-08-26T00:00:00Z', started_at: null, finished_at: null,
  ...over,
});

describe('countDetails', () => {
  it('tallies by status', () => {
    const details = [detail('created'), detail('created'), detail('updated'),
                     detail('review'), detail('error')];
    expect(countDetails(details)).toEqual(
      { created: 2, updated: 1, review: 1, error: 1 });
  });
  it('handles empty', () => {
    expect(countDetails([])).toEqual(
      { created: 0, updated: 0, review: 0, error: 0 });
  });
});

describe('job state helpers', () => {
  it('active for queued/running only', () => {
    expect(jobIsActive(job({ status: 'queued' }))).toBe(true);
    expect(jobIsActive(job({ status: 'running' }))).toBe(true);
    expect(jobIsActive(job({ status: 'completed' }))).toBe(false);
    expect(jobIsActive(job({ status: 'failed' }))).toBe(false);
    expect(jobIsActive(job({ status: 'cancelled' }))).toBe(false);
  });
  it('progress pct clamps and survives zero totals', () => {
    expect(jobProgressPct(job({ total_rows: 0 }))).toBe(0);
    expect(jobProgressPct(job({ total_rows: 200, processed_rows: 50 })))
      .toBe(25);
    expect(jobProgressPct(job({ total_rows: 10, processed_rows: 20 })))
      .toBe(100);
  });
});

describe('speed + eta', () => {
  it('averages recent samples', () => {
    const speed = rowsPerSecond([
      { at: 0, processed: 0 },
      { at: 2000, processed: 100 },
      { at: 4000, processed: 300 },
    ]);
    expect(speed).toBe(75);   // (50 + 100) / 2
  });
  it('needs two samples', () => {
    expect(rowsPerSecond([{ at: 0, processed: 0 }])).toBe(0);
  });
  it('eta from remaining rows', () => {
    const j = job({ total_rows: 1000, processed_rows: 250 });
    expect(etaSeconds(j, 75)).toBe(10);
    expect(etaSeconds(j, 0)).toBeNull();
  });
});

describe('importErrorMessage', () => {
  it('maps known codes', () => {
    // ApiError's real constructor is (status, code, detail) — api.ts:141 —
    // not (status, { code }) as a nested body; mirrors SiteBulkImport's
    // mapError, which reads err.code directly (SiteBulkImport.tsx:112).
    const err = new ApiError(422, 'not_a_move');
    expect(importErrorMessage(err)).toMatch(/move/i);
  });
  it('falls back for unknown input', () => {
    expect(importErrorMessage(new Error('boom'))).toMatch(/wrong/i);
  });
});
