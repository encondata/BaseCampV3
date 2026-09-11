import { describe, expect, it } from 'vitest';

import type { ScanHistoryPreviewStatus } from './api';
import { buildRunOptions, columnsForMode, formatDefaults } from './moveScanHistory';

function status(over: Partial<ScanHistoryPreviewStatus> = {}): ScanHistoryPreviewStatus {
  return {
    key: 'pre_stage', label: 'Pre-Stage', color: '#3366ff', in_pipeline: true, scan_count: 0, ...over,
  };
}

describe('columnsForMode', () => {
  const statuses: ScanHistoryPreviewStatus[] = [
    status({ key: 'pre_stage', label: 'Pre-Stage', in_pipeline: true, scan_count: 10 }),
    status({ key: 'complete', label: 'Complete', in_pipeline: true, scan_count: 8 }),
    // not in the move-scan-history pipeline, but scanned anyway
    status({ key: 'on_hold', label: 'On Hold', color: null, in_pipeline: false, scan_count: 2 }),
    // not in the pipeline and never scanned — should never appear
    status({ key: 'cancelled', label: 'Cancelled', in_pipeline: false, scan_count: 0 }),
  ];

  it('all mode returns every status in order, none flagged', () => {
    const cols = columnsForMode(statuses, 'all');
    expect(cols.map((c) => c.key)).toEqual(['pre_stage', 'complete', 'on_hold', 'cancelled']);
    expect(cols.every((c) => !c.alsoScanned)).toBe(true);
  });

  it('pipeline mode keeps pipeline columns first, then appends scanned extras flagged alsoScanned', () => {
    const cols = columnsForMode(statuses, 'pipeline');
    expect(cols.map((c) => c.key)).toEqual(['pre_stage', 'complete', 'on_hold']);
    expect(cols.map((c) => c.alsoScanned)).toEqual([false, false, true]);
  });

  it('pipeline mode drops a non-pipeline status with zero scans', () => {
    const cols = columnsForMode(statuses, 'pipeline');
    expect(cols.some((c) => c.key === 'cancelled')).toBe(false);
  });
});

describe('buildRunOptions', () => {
  it('assembles the format + status_columns payload', () => {
    expect(buildRunOptions('pdf', 'all')).toEqual({ format: 'pdf', status_columns: 'all' });
    expect(buildRunOptions('xlsx', 'pipeline')).toEqual({ format: 'xlsx', status_columns: 'pipeline' });
  });
});

describe('formatDefaults', () => {
  it('reads the definition\'s default_format/status_columns', () => {
    expect(formatDefaults({ options: { default_format: 'pdf', status_columns: 'all' } }))
      .toEqual({ format: 'pdf', statusColumns: 'all' });
  });

  it('falls back to xlsx/pipeline for missing or unrecognized values', () => {
    expect(formatDefaults({ options: {} })).toEqual({ format: 'xlsx', statusColumns: 'pipeline' });
    expect(formatDefaults({ options: { default_format: 'csv', status_columns: 'bogus' } }))
      .toEqual({ format: 'xlsx', statusColumns: 'pipeline' });
  });
});
