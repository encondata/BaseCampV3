import { describe, expect, it } from 'vitest';

import type { ProcessedScanRow } from './api';
import {
  matchedHref, processedScanCellText, processedScanSearchText,
  PROCESSED_SCAN_GOD_FIELDS, SCANS_ERRORS,
} from './scans';

const row: ProcessedScanRow = {
  id: 'p1', scanned_value: 'EPC-001', scan_type: 'rfid',
  scan_type_label: 'RFID', scan_type_color: '#1668a7',
  scanned_at: '2026-08-27T09:00:00Z', device_id: 'dock-1',
  operator_id: 'op1', operator_name: 'Op Erator',
  site_id: 's1', site_name: 'DC-East', location_detail: 'Dock 3',
  source: 'reader', raw_scan_id: 42, match_type: 'asset',
  match_type_label: 'Asset', match_type_color: '#178a4c',
  asset_id: 'a1', container_id: null, person_id: null,
  matched_name: 'srv-9', processed_at: '2026-08-27T09:01:00Z',
  archived_at: null, created_at: '2026-08-27T09:01:00Z',
};

describe('processedScanSearchText', () => {
  it('joins the searchable fields lowercased', () => {
    const t = processedScanSearchText(row);
    expect(t).toContain('epc-001');
    expect(t).toContain('srv-9');
    expect(t).toContain('dock-1');
    expect(t).toContain('dc-east');
    expect(t).toContain('op erator');
    expect(t).toContain('asset');
  });
});

describe('processedScanCellText', () => {
  it('mirrors cell rendering including dashes', () => {
    expect(processedScanCellText(row, 'primary')).toBe('EPC-001');
    expect(processedScanCellText(row, 'match')).toBe('Asset');
    expect(processedScanCellText(row, 'matched')).toBe('srv-9');
    expect(processedScanCellText(row, 'scan_type')).toBe('RFID');
    expect(processedScanCellText(row, 'device')).toBe('dock-1');
    expect(processedScanCellText(row, 'operator')).toBe('Op Erator');
    expect(processedScanCellText(row, 'site')).toBe('DC-East');
    expect(processedScanCellText(row, 'location')).toBe('Dock 3');
    expect(processedScanCellText(row, 'source')).toBe('reader');
    expect(processedScanCellText(row, 'archived')).toBe('No');
    expect(processedScanCellText(
      { ...row, matched_name: null }, 'matched')).toBe('—');
    expect(processedScanCellText(
      { ...row, operator_name: null }, 'operator')).toBe('—');
    expect(processedScanCellText({ ...row, location_detail: '' }, 'location'))
      .toBe('—');
  });
  it('formats the timestamp columns as locale strings', () => {
    expect(processedScanCellText(row, 'scanned'))
      .toBe(new Date(row.scanned_at).toLocaleString());
    expect(processedScanCellText(row, 'processed'))
      .toBe(new Date(row.processed_at).toLocaleString());
  });
});

describe('matchedHref', () => {
  it('links each match type to its list page deep-link', () => {
    expect(matchedHref(row)).toBe('/assets?open=a1');
    expect(matchedHref({ ...row, match_type: 'container', asset_id: null,
      container_id: 'c1' })).toBe('/logistics/containers?open=c1');
    expect(matchedHref({ ...row, match_type: 'person', asset_id: null,
      person_id: 'x1' })).toBe('/people/users?open=x1');
    expect(matchedHref({ ...row, asset_id: null })).toBeNull();
  });
});

describe('god fields', () => {
  it('exposes exactly the PATCH surface', () => {
    const fields = PROCESSED_SCAN_GOD_FIELDS({
      sites: () => [{ value: 's1', label: 'DC-East' }],
      people: () => [{ value: 'op1', label: 'Op Erator' }],
    });
    expect(fields.map((f) => f.field).sort())
      .toEqual(['location_detail', 'operator_id', 'site_id']);
    const site = fields.find((f) => f.field === 'site_id')!;
    expect(site.column).toBe('site');
    expect(site.kind).toBe('combo');
    expect(site.fromRow(row)).toBe('s1');
  });
});

describe('SCANS_ERRORS', () => {
  it('covers the API error codes', () => {
    for (const code of ['processed_scan_not_found', 'site_not_found',
      'operator_not_found', 'location_detail_required', 'forbidden']) {
      expect(SCANS_ERRORS[code]).toBeTruthy();
    }
  });
});
