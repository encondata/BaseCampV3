import { describe, expect, it } from 'vitest';

import type { InitiativeAssetRow, SurveySchema } from './api';
import {
  assetPreviewRows, buildRunOptions, findMissingRequiredFields,
} from './siteMoveSurvey';

function asset(over: Partial<InitiativeAssetRow['asset']> = {}): InitiativeAssetRow['asset'] {
  return {
    id: 'a', legacy_id: 1, serial_number: 'SN1', name: null, rfid_tag: null,
    model_make: 'Dell', model_name: 'R640', ru_size: 1, location_detail: null,
    client_name: null, model_category: null, model_category_label: null,
    model_category_color: null, status: 'active', status_label: 'Active',
    status_color: '#000', ...over,
  };
}
function row(id: string, over: Partial<InitiativeAssetRow> = {}): InitiativeAssetRow {
  return {
    id, asset_id: id, priority_wave: null, disposition: null, owner: null,
    source_rack: 'R1', source_ru: 1, source_verified: null, source_position: null,
    destination_rack: null, destination_ru: null, destination_verified: null,
    destination_position: null, cable_info: null, vendor_involved: null,
    status: 'active', status_label: 'Active', status_color: '#000',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    asset: asset(), ...over,
  };
}

describe('assetPreviewRows', () => {
  it('returns one row per asset in per-asset mode', () => {
    const rows = [
      row('1', { source_rack: 'R1' }),
      row('2', { source_rack: 'R2', asset: asset({ model_make: 'HP', model_name: 'DL380' }) }),
    ];
    const preview = assetPreviewRows(rows, false);
    expect(preview).toHaveLength(2);
    expect(preview[0]).toEqual({ key: '1', make: 'Dell', model: 'R640', ru: 1, rack: 'R1', qty: 1 });
    expect(preview[1].rack).toBe('R2');
  });

  it('groups by make/model with a summed qty in condensed mode', () => {
    const rows = [
      row('1'),
      row('2'),
      row('3', { asset: asset({ model_make: 'HP', model_name: 'DL380' }) }),
    ];
    const preview = assetPreviewRows(rows, true);
    expect(preview).toHaveLength(2);
    const dell = preview.find((p) => p.make === 'Dell');
    expect(dell?.qty).toBe(2);
    const hp = preview.find((p) => p.make === 'HP');
    expect(hp?.qty).toBe(1);
  });

  it('falls back to Unknown for a missing make/model', () => {
    const preview = assetPreviewRows(
      [row('1', { asset: asset({ model_make: null, model_name: null }) })], true);
    expect(preview[0].make).toBe('Unknown');
    expect(preview[0].model).toBe('Unknown');
  });
});

const SCHEMA: SurveySchema = {
  groups: [
    {
      key: 'contact', label: 'Site contact', fields: [
        { key: 'contact_name', label: 'Contact name', kind: 'text', options: [] },
      ],
    },
    {
      key: 'facility', label: 'Facility', fields: [
        { key: 'floor', label: 'Floor', kind: 'int', options: [] },
        { key: 'elevator_available', label: 'Elevator available', kind: 'bool', options: [] },
      ],
    },
    {
      key: 'notes', label: 'Notes', fields: [
        { key: 'additional_notes', label: 'Additional notes', kind: 'textarea', options: [] },
      ],
    },
  ],
};

describe('findMissingRequiredFields', () => {
  it('lists required fields with an empty/null/undefined answer', () => {
    const missing = findMissingRequiredFields(SCHEMA, {
      contact_name: '', floor: null, elevator_available: undefined,
    });
    expect(missing.map((m) => m.key)).toEqual(['contact_name', 'floor', 'elevator_available']);
    expect(missing[1].kind).toBe('int');
  });

  it('excludes answered fields', () => {
    const missing = findMissingRequiredFields(SCHEMA, {
      contact_name: 'Jane Doe', floor: 2, elevator_available: false,
    });
    expect(missing).toEqual([]);
  });

  it('never flags the Notes group, even when empty', () => {
    const missing = findMissingRequiredFields(SCHEMA, {
      contact_name: 'Jane', floor: 2, elevator_available: true, additional_notes: '',
    });
    expect(missing).toEqual([]);
  });
});

describe('buildRunOptions', () => {
  it('always includes partner_id and the three booleans', () => {
    const options = buildRunOptions({
      partnerId: 'p1', contactPersonId: '', sourceSiteId: '', destinationSiteId: '',
      assetNotes: '', includeTransportationStandards: true, includeSitePhotos: false,
      condensedAssets: true,
    });
    expect(options).toEqual({
      partner_id: 'p1', include_transportation_standards: true,
      include_site_photos: false, condensed_assets: true,
    });
  });

  it('adds optional keys only when set, and trims asset notes', () => {
    const options = buildRunOptions({
      partnerId: 'p1', contactPersonId: 'u1', sourceSiteId: 's1', destinationSiteId: 's2',
      assetNotes: '  40 servers  ', includeTransportationStandards: false,
      includeSitePhotos: true, condensedAssets: false,
    });
    expect(options).toEqual({
      partner_id: 'p1', contact_person_id: 'u1', source_site_id: 's1',
      destination_site_id: 's2', asset_notes: '40 servers',
      include_transportation_standards: false, include_site_photos: true,
      condensed_assets: false,
    });
  });
});
