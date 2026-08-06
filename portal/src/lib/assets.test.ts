import { describe, expect, it } from 'vitest';

import type { AssetItem, AssetModelItem } from './api';
import {
  ASSET_ERRORS, ASSET_GOD_FIELDS, MODEL_ERRORS, MODEL_GOD_FIELDS,
  assetPayload, duplicateSerials, formFromAsset, formFromModel,
  formatDims, modelPayload, needsModelCreate, parseDims, partnerFor,
} from './assets';

const asset = (over: Partial<AssetItem> = {}): AssetItem => ({
  id: 'a1', serial_number: 'SN1', name: 'web-01', rfid_tag: null,
  model_id: null, model: null, client_id: null, client_name: null,
  site_id: null, site_name: null, location_detail: '', status: 'active',
  status_label: 'Active', status_color: '#178a4c', has_rails: null,
  last_seen_at: null, archived_at: null, created_at: '2026-08-05T00:00:00Z',
  ...over,
});

const assetModel = (over: Partial<AssetModelItem> = {}): AssetModelItem => ({
  id: 'm1', make: 'Dell', model: 'R740', category: 'server',
  category_label: 'Server', category_color: '#1668a7', ru_size: 2,
  weight_lbs: 50, weight_kg: 22.68, length_in: 32, width_in: 17,
  height_in: 3.4, length_cm: 81.28, width_cm: 43.18, height_cm: 8.64,
  mount_type: 'rails', rail_type: 'B7', knowledge: 'Careful with rails.',
  aliases: ['R740'], created_at: '', updated_at: '',
  ...over,
});

describe('partnerFor', () => {
  it('converts lbs to kg and back', () => {
    expect(partnerFor(50, 0.453592, true)).toBe(22.68);
    expect(partnerFor(10, 0.453592, false)).toBe(22.05);
    expect(partnerFor(null, 0.453592, true)).toBeNull();
  });
});

describe('parseDims', () => {
  it('parses x-separated dims', () => {
    expect(parseDims('32 x 1.5 x 18.5')).toEqual([32, 1.5, 18.5]);
    expect(parseDims('32x1.5x18.5')).toEqual([32, 1.5, 18.5]);
    expect(parseDims('32 × 1.5 × 18.5')).toEqual([32, 1.5, 18.5]);
    expect(parseDims('32, 1.5, 18.5')).toEqual([32, 1.5, 18.5]);
  });
  it('rejects garbage', () => {
    expect(parseDims('32 x 1.5')).toBeNull();
    expect(parseDims('a x b x c')).toBeNull();
    expect(parseDims('')).toBeNull();
  });
});

describe('formatDims', () => {
  it('formats a trio', () => {
    expect(formatDims(32, 1.5, 18.5, 'in')).toBe('32 × 1.5 × 18.5 in');
  });
  it('dashes when incomplete', () => {
    expect(formatDims(32, null, 18.5, 'in')).toBe('—');
  });
});

describe('asset form round-trip', () => {
  it('create-mode defaults', () => {
    const f = formFromAsset(null);
    expect(f.status).toBe('unknown');
    expect(f.serial_number).toBe('');
  });
  it('payload nulls empties (patch clears; create drops server-side)', () => {
    const f = formFromAsset(null);
    f.serial_number = ' SN9 ';
    f.has_rails = 'yes';
    const p = assetPayload(f);
    expect(p.serial_number).toBe('SN9');
    expect(p.has_rails).toBe(true);
    expect(p.rfid_tag).toBeNull();     // null clears on PATCH; POST ignores it
  });
});

describe('model form payload', () => {
  const model: AssetModelItem = {
    id: 'm1', make: 'Dell', model: 'R740', category: 'server',
    category_label: 'Server', category_color: '#1668a7', ru_size: 2,
    weight_lbs: 50, weight_kg: 22.68, length_in: 32, width_in: 17,
    height_in: 3.4, length_cm: 81.28, width_cm: 43.18, height_cm: 8.64,
    mount_type: 'rails', rail_type: 'B7', knowledge: '', aliases: [],
    created_at: '', updated_at: '',
  };
  it('sends only the CHANGED unit side so the API recomputes the partner', () => {
    const f = formFromModel(model);
    f.weight_kg = '30';
    const p = modelPayload(f, model);
    expect(p.weight_kg).toBe(30);
    expect('weight_lbs' in p).toBe(false);     // partner recomputed server-side
  });
  it('clears a pair with null when blanked', () => {
    const f = formFromModel(model);
    f.weight_lbs = '';
    f.weight_kg = '';
    const p = modelPayload(f, model);
    expect(p.weight_lbs).toBeNull();
  });
  it('create mode sends entered fields only', () => {
    const f = formFromModel(null);
    f.make = 'HPE';
    f.model = 'DL380';
    f.weight_lbs = '40';
    const p = modelPayload(f, null);
    expect(p).toEqual({ make: 'HPE', model: 'DL380', weight_lbs: 40 });
  });
  it('blanking one side alone sends null, not a fabricated 0', () => {
    const f = formFromModel(model);
    f.weight_lbs = '';
    const p = modelPayload(f, model);
    expect(p.weight_lbs).toBeNull();
    expect('weight_kg' in p).toBe(false);   // untouched side omitted; server clears it
  });
});

describe('needsModelCreate', () => {
  it('true in fresh create mode', () => {
    expect(needsModelCreate({ isCreateMode: true, createdId: null })).toBe(true);
  });
  it('false in edit mode', () => {
    expect(needsModelCreate({ isCreateMode: false, createdId: null })).toBe(false);
  });
  it('false once a create already succeeded this session', () => {
    expect(needsModelCreate({ isCreateMode: true, createdId: 'm-new' })).toBe(false);
  });
});

describe('duplicateSerials', () => {
  it('flags case-insensitive dupes, ignores blanks', () => {
    const dupes = duplicateSerials([
      asset({ id: '1', serial_number: 'SN1' }),
      asset({ id: '2', serial_number: 'sn1' }),
      asset({ id: '3', serial_number: null }),
      asset({ id: '4', serial_number: null }),
    ]);
    expect(dupes.has('sn1')).toBe(true);
    expect(dupes.size).toBe(1);
  });
});

/* ── god-edit descriptors ──────────────────────────────────────────── */

const ASSET_WRITABLE_FIELDS = new Set([
  'serial_number', 'name', 'rfid_tag', 'model_id', 'client_id',
  'site_id', 'location_detail', 'status', 'has_rails',
]);

const MODEL_WRITABLE_FIELDS = new Set([
  'make', 'model', 'category', 'ru_size', 'weight_lbs', 'weight_kg',
  'length_in', 'width_in', 'height_in', 'length_cm', 'width_cm',
  'height_cm', 'mount_type', 'rail_type', 'knowledge',
]);

describe('ASSET_GOD_FIELDS', () => {
  const fields = ASSET_GOD_FIELDS({
    models: () => [{ value: 'model-1', label: 'Dell R740' }],
    clients: () => [{ value: 'client-1', label: 'Acme' }],
    sites: () => [{ value: 'site-1', label: 'DC1' }],
    statuses: () => [{ value: 'active', label: 'Active' }],
  });

  it('only exposes fields on the writable allowlist', () => {
    for (const f of fields) expect(ASSET_WRITABLE_FIELDS.has(f.field)).toBe(true);
  });

  it('every fromRow round-trips a sample row', () => {
    const a = asset({
      serial_number: 'SN9', name: 'web-09', rfid_tag: 'RF1',
      model_id: 'model-1', client_id: 'client-1', site_id: 'site-1',
      location_detail: 'Rack 3', status: 'active', has_rails: true,
    });
    const expected: Record<string, string> = {
      primary: 'SN9', primary2: 'web-09', rfid: 'RF1', location: 'Rack 3',
      model: 'model-1', client: 'client-1', site: 'site-1', status: 'active',
      has_rails: 'yes',
    };
    expect(fields.map((f) => f.column).sort()).toEqual(Object.keys(expected).sort());
    for (const f of fields) expect(f.fromRow(a)).toBe(expected[f.column]);
  });

  it('has_rails tri-state: true/false/null map to yes/no/empty and back', () => {
    const f = fields.find((x) => x.column === 'has_rails')!;
    expect(f.fromRow(asset({ has_rails: true }))).toBe('yes');
    expect(f.fromRow(asset({ has_rails: false }))).toBe('no');
    expect(f.fromRow(asset({ has_rails: null }))).toBe('');
    expect(f.toPatch?.('yes')).toBe(true);
    expect(f.toPatch?.('no')).toBe(false);
    expect(f.toPatch?.('')).toBeNull();
  });
});

describe('MODEL_GOD_FIELDS', () => {
  const fields = MODEL_GOD_FIELDS({
    categories: () => [{ value: 'server', label: 'Server' }],
  });

  it('only exposes fields on the writable allowlist', () => {
    for (const f of fields) expect(MODEL_WRITABLE_FIELDS.has(f.field)).toBe(true);
  });

  it('every fromRow round-trips a sample row', () => {
    const m = assetModel();
    const expected: Record<string, string> = {
      primary: 'Dell', primary2: 'R740', category: 'server', ru: '2',
      weight_lbs: '50', weight_kg: '22.68', length_in: '32', width_in: '17',
      height_in: '3.4', length_cm: '81.28', width_cm: '43.18', height_cm: '8.64',
      mount: 'rails', rail: 'B7', knowledge: 'Careful with rails.',
    };
    expect(fields.map((f) => f.column).sort()).toEqual(Object.keys(expected).sort());
    for (const f of fields) expect(f.fromRow(m)).toBe(expected[f.column]);
  });

  it('numeric god columns: blank clears, non-numeric throws not_a_number', () => {
    const f = fields.find((x) => x.column === 'weight_lbs')!;
    expect(f.toPatch?.('12.5')).toBe(12.5);
    expect(f.toPatch?.('')).toBeNull();
    expect(() => f.toPatch?.('abc')).toThrow('not_a_number');
  });

  it('mount select offers the fixed enum; no custom toPatch means the default null-on-blank applies', () => {
    const f = fields.find((x) => x.column === 'mount')!;
    expect(f.options?.().map((o) => o.value)).toEqual(['rails', 'ears', 'shelf', 'custom']);
    expect(f.toPatch).toBeUndefined();
  });
});

describe('ASSET_ERRORS / MODEL_ERRORS', () => {
  it('are non-empty error maps usable by both the modal and GodCell', () => {
    expect(ASSET_ERRORS.forbidden).toBeTruthy();
    expect(MODEL_ERRORS.forbidden).toBeTruthy();
  });
});
