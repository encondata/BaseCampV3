import { describe, expect, it } from 'vitest';

import type { MacroPointGroup, MacroPointPreview, MacroPointTruckOption } from './api';
import {
  assignmentsPayload, initialAssignments, isEml, mergeFiles, noteText, reasonText, truckOptions,
} from './macropoint';

const truck = (id: string, name: string, extra: Partial<MacroPointTruckOption> = {}): MacroPointTruckOption => ({
  id, name, status: 'active', status_label: 'Active', tracker_id: null, initiative_name: null, ...extra,
});
const group = (key: string, truckId: string | null, ambiguous: string[] = []): MacroPointGroup => ({
  group_key: key, id_number: key, order_token: null, carrier: 'Landstar - ATL',
  match: { truck_id: truckId, by: truckId ? 'tracker_id' : null, ambiguous_ids: ambiguous },
  rows: [], new: 0, duplicates: 0,
});

describe('reasonText', () => {
  it('words parse and apply reasons', () => {
    expect(reasonText('not_macropoint')).toBe('Not a MacroPoint email');
    expect(reasonText('missing_field:date_time')).toBe('Missing Date/Time');
    expect(reasonText('truck_not_active')).toBe('Truck is no longer active');
    expect(reasonText('something_new')).toBe('something_new');
  });
  it('words notes', () => {
    expect(noteText('linked_to_other_order')).toMatch(/different MacroPoint order/);
    expect(noteText(null)).toBe('');
  });
});

describe('assignments', () => {
  it('pre-fills matched groups and leaves the rest blank', () => {
    const preview: MacroPointPreview = {
      groups: [group('a', 't1'), group('b', null)], errors: [], trucks: [],
    };
    expect(initialAssignments(preview)).toEqual({ a: 't1', b: '' });
  });
  it('sends null for blank picks', () => {
    expect(assignmentsPayload([group('a', null), group('b', null)], { a: 't9', b: '' }))
      .toEqual({ a: 't9', b: null });
  });
});

describe('truckOptions', () => {
  it('labels with status and move and lists ambiguous candidates first', () => {
    const opts = truckOptions(
      [truck('t1', 'Alpha'), truck('t2', 'Bravo', { initiative_name: 'NAP11' })], ['t2'],
    );
    expect(opts.map((o) => o.value)).toEqual(['t2', 't1']);
    expect(opts[0]).toEqual({ value: 't2', label: 'Bravo', sub: 'Active · NAP11' });
    expect(opts[1].sub).toBe('Active');
  });
});

describe('files', () => {
  const f = (name: string, size = 3, lastModified = 1) =>
    new File(['x'.repeat(size)], name, { lastModified });
  it('accepts .eml only', () => {
    expect(isEml(f('a.EML'))).toBe(true);
    expect(isEml(f('a.msg'))).toBe(false);
  });
  it('appends without duplicating the same file', () => {
    const a = f('a.eml');
    expect(mergeFiles([a], [f('a.eml'), f('b.eml')]).map((x) => x.name)).toEqual(['a.eml', 'b.eml']);
  });
});
