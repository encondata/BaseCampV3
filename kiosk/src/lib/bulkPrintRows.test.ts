import { describe, expect, it } from 'vitest';

import type { KioskAssetRow, KioskContainerRow } from './api';
import { ruNumber, toPrintAssetRow, toPrintContainerItem } from './bulkPrintRows';

const base: KioskAssetRow = {
  id: 'u-1', asset_id: '1042', name: 'Web', rfid: 'E1', serial_number: 'SN1',
  make: 'Dell', model: 'R640', make_model: 'Dell R640', label: {},
};

describe('bulkPrintRows', () => {
  it('maps the id, RU and status fields', () => {
    const r = toPrintAssetRow({
      ...base, legacy_id: 1042, source_rack: 'A12', source_ru: '14', source_ru_raw: '14.50',
      destination_ru: null, roster_status_label: 'Packed',
    });
    expect(r.asset_id).toBe('u-1');
    expect(r.id).toBe('u-1');
    expect(r.asset.legacy_id).toBe(1042);
    expect(r.asset.model_make).toBe('Dell');
    expect(r.asset.model_name).toBe('R640');
    expect(r.asset.rfid_tag).toBe('E1');
    expect(r.source_rack).toBe('A12');
    expect(r.source_ru).toBe(14.5);
    expect(r.destination_ru).toBeNull();
    expect(r.status_label).toBe('Packed');
    expect(r.status_color).toBe('');
    expect(ruNumber('U?', null)).toBeNull();
    expect(ruNumber('22', undefined)).toBe(22);
    expect(ruNumber(null, null)).toBeNull();
    expect(toPrintAssetRow({ ...base, asset_id: '' }).asset.legacy_id).toBeNull();
    expect(toPrintAssetRow(base).asset.legacy_id).toBe(1042);
  });

  it('maps a container', () => {
    const c: KioskContainerRow = {
      id: 'c1', name: 'Crate 1', rfid_tag: null, label_tag: 'abc', container_type: 'crate',
      status: 'open', status_label: 'Open', site_id: null, site_name: null, asset_count: 3,
      container_type_label: 'Crate',
    };
    const i = toPrintContainerItem(c);
    expect(i).toMatchObject({
      type_label: 'Crate', type_color: null, archived_at: null, status_color: '',
      asset_count: 3, label_tag: 'abc', location_detail: '',
    });
  });
});
