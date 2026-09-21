import { describe, expect, it } from 'vitest';

import type { AssetItem, AssetModelItem } from './api';
import type { ColumnDef } from './listTools';
import { applyColumnOrder } from './listTools';
import {
  ASSET_ERRORS, ASSET_GOD_FIELDS, IDENTITY_KEYS, MODEL_ERRORS, MODEL_GOD_FIELDS,
  assetCellText, assetSearchText, assetPayload, duplicateSerials, formFromAsset, formFromModel,
  formatDims, formFactorLabel, identityFirst, migrateIdentityColumns, modelCellText, modelPayload,
  modelSearchText, needsModelCreate, parseDims, partnerFor,
} from './assets';

const asset = (over: Partial<AssetItem> = {}): AssetItem => ({
  id: 'a1', legacy_id: 100042, serial_number: 'SN1', name: 'web-01', rfid_tag: null,
  pod_number: null, model_id: null, model: null, client_id: null, client_name: null,
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
  mount_type: 'rails', rail_type: 'B7', form_factor: null, knowledge: 'Careful with rails.',
  aliases: ['R740'], created_at: '', updated_at: '',
  ...over,
});

describe('modelSearchText', () => {
  it('includes the form factor so searching "chassis" finds flagged models', () => {
    expect(modelSearchText(assetModel({ form_factor: 'chassis' }))).toContain('chassis');
    expect(modelSearchText(assetModel({ form_factor: null }))).not.toContain('chassis');
  });
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

  it('pod_number round-trips and nulls when blank', () => {
    const f = formFromAsset(asset({ pod_number: '14' }));
    expect(f.pod_number).toBe('14');
    f.pod_number = '  ';
    expect(assetPayload(f).pod_number).toBeNull();
    f.pod_number = ' P-07 ';
    expect(assetPayload(f).pod_number).toBe('P-07');
  });
});

describe('model form payload', () => {
  const model: AssetModelItem = {
    id: 'm1', make: 'Dell', model: 'R740', category: 'server',
    category_label: 'Server', category_color: '#1668a7', ru_size: 2,
    weight_lbs: 50, weight_kg: 22.68, length_in: 32, width_in: 17,
    height_in: 3.4, length_cm: 81.28, width_cm: 43.18, height_cm: 8.64,
    mount_type: 'rails', rail_type: 'B7', form_factor: 'chassis', knowledge: '', aliases: [],
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
  it('sends form_factor when changed and null when cleared', () => {
    const f = formFromModel(model);
    expect(f.form_factor).toBe('chassis');
    f.form_factor = 'node';
    expect(modelPayload(f, model)).toEqual({ form_factor: 'node' });
    f.form_factor = '';
    expect(modelPayload(f, model)).toEqual({ form_factor: null });
  });
  it('modelCellText and formFactorLabel read the form factor', () => {
    expect(modelCellText(model, 'form')).toBe('Chassis');
    expect(modelCellText({ ...model, form_factor: null }, 'form')).toBe('—');
    expect(formFactorLabel('node')).toBe('Node');
    expect(formFactorLabel(null)).toBe('—');
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

describe('assetCellText', () => {
  const full = asset({
    serial_number: 'SN9', name: 'web-09', rfid_tag: 'RF1',
    pod_number: '14',
    location_detail: 'Rack 3, U12',
    model_id: 'm1', model: {
      id: 'm1', make: 'Dell', model: 'R740', category: 'server',
      category_label: 'Server', category_color: '#1668a7', ru_size: 2,
    },
    client_id: 'c1', client_name: 'Acme',
    site_id: 's1', site_name: 'DC1',
    status: 'active', status_label: 'Active',
    has_rails: true,
    last_seen_at: '2026-01-15T00:00:00Z',
    archived_at: null,
  });

  const blank = asset({
    serial_number: null, name: null, rfid_tag: null,
    pod_number: null,
    location_detail: '', model_id: null, model: null,
    client_id: null, client_name: null, site_id: null, site_name: null,
    has_rails: null, last_seen_at: null, archived_at: '2026-01-01T00:00:00Z',
  });

  it('primary combines serial + name', () => {
    expect(assetCellText(full, 'primary')).toBe('SN9 web-09');
  });

  it('status reads status_label', () => {
    expect(assetCellText(full, 'status')).toBe('Active');
  });

  it('category reads the model category label', () => {
    expect(assetCellText(full, 'category')).toBe('Server');
    expect(assetCellText(blank, 'category')).toBe('');
  });

  it('client reads client_name', () => {
    expect(assetCellText(full, 'client')).toBe('Acme');
    expect(assetCellText(blank, 'client')).toBe('');
  });

  it('site reads site_name', () => {
    expect(assetCellText(full, 'site')).toBe('DC1');
    expect(assetCellText(blank, 'site')).toBe('');
  });

  it('model combines make + model', () => {
    expect(assetCellText(full, 'model')).toBe('Dell R740');
    expect(assetCellText(blank, 'model')).toBe('');
  });

  it('location reads location_detail, dashing when blank', () => {
    expect(assetCellText(full, 'location')).toBe('Rack 3, U12');
    expect(assetCellText(blank, 'location')).toBe('—');
  });

  it('rfid reads rfid_tag, dashing when null', () => {
    expect(assetCellText(full, 'rfid')).toBe('RF1');
    expect(assetCellText(blank, 'rfid')).toBe('—');
  });

  it('pod reads pod_number, dashing when null', () => {
    expect(assetCellText(full, 'pod')).toBe('14');
    expect(assetCellText(blank, 'pod')).toBe('—');
  });

  it('ru reads the model ru_size, dashing when unset', () => {
    expect(assetCellText(full, 'ru')).toBe('2');
    expect(assetCellText(blank, 'ru')).toBe('—');
  });

  it('last_seen formats the date, dashing when unset', () => {
    expect(assetCellText(full, 'last_seen')).toBe(new Date(full.last_seen_at!).toLocaleDateString());
    expect(assetCellText(blank, 'last_seen')).toBe('—');
  });

  it('has_rails maps true/false/null to Yes/No/—', () => {
    expect(assetCellText(full, 'has_rails')).toBe('Yes');
    expect(assetCellText(asset({ has_rails: false }), 'has_rails')).toBe('No');
    expect(assetCellText(blank, 'has_rails')).toBe('—');
  });

  it('archived maps archived_at presence to Yes/No', () => {
    expect(assetCellText(full, 'archived')).toBe('No');
    expect(assetCellText(blank, 'archived')).toBe('Yes');
  });

  it('unknown column keys return empty string', () => {
    expect(assetCellText(full, 'nonsense')).toBe('');
  });
});

describe('modelCellText', () => {
  const full = assetModel({
    make: 'Dell', model: 'R740', category_label: 'Server',
    ru_size: 2, weight_lbs: 50, weight_kg: 22.68,
    length_in: 32, width_in: 17, height_in: 3.4,
    mount_type: 'rails', rail_type: 'B7', knowledge: 'Careful with rails.',
    aliases: ['R740', 'PowerEdge R740'],
  });

  const blank = assetModel({
    category: null, category_label: null, ru_size: null,
    weight_lbs: null, weight_kg: null,
    length_in: null, width_in: null, height_in: null,
    mount_type: null, rail_type: null, knowledge: '', aliases: [],
  });

  it('primary combines make + model', () => {
    expect(modelCellText(full, 'primary')).toBe('Dell R740');
  });

  it('category reads category_label, dashing when blank', () => {
    expect(modelCellText(full, 'category')).toBe('Server');
    expect(modelCellText(blank, 'category')).toBe('');
  });

  it('ru reads ru_size, dashing when unset', () => {
    expect(modelCellText(full, 'ru')).toBe('2');
    expect(modelCellText(blank, 'ru')).toBe('—');
  });

  it('weight combines both units into the display string', () => {
    expect(modelCellText(full, 'weight')).toBe('50 lb / 22.68 kg');
    expect(modelCellText(blank, 'weight')).toBe('—');
  });

  it('dims formats the L x W x H display string', () => {
    expect(modelCellText(full, 'dims')).toBe('32 × 17 × 3.4 in');
    expect(modelCellText(blank, 'dims')).toBe('—');
  });

  it('mount title-cases the mount type, dashing when unset', () => {
    expect(modelCellText(full, 'mount')).toBe('Rails');
    expect(modelCellText(blank, 'mount')).toBe('—');
  });

  it('rail reads rail_type, dashing when unset', () => {
    expect(modelCellText(full, 'rail')).toBe('B7');
    expect(modelCellText(blank, 'rail')).toBe('—');
  });

  it('aliases joins the list, dashing when empty', () => {
    expect(modelCellText(full, 'aliases')).toBe('R740, PowerEdge R740');
    expect(modelCellText(blank, 'aliases')).toBe('—');
  });

  it('the per-unit godOnly columns show the bare number, not the combined display string', () => {
    expect(modelCellText(full, 'weight_lbs')).toBe('50');
    expect(modelCellText(full, 'weight_kg')).toBe('22.68');
    expect(modelCellText(full, 'length_in')).toBe('32');
    expect(modelCellText(full, 'width_in')).toBe('17');
    expect(modelCellText(full, 'height_in')).toBe('3.4');
    expect(modelCellText(blank, 'weight_lbs')).toBe('—');
  });

  it('knowledge reads the free-text field, dashing when blank', () => {
    expect(modelCellText(full, 'knowledge')).toBe('Careful with rails.');
    expect(modelCellText(blank, 'knowledge')).toBe('—');
  });

  it('unknown column keys return empty string', () => {
    expect(modelCellText(full, 'nonsense')).toBe('');
  });
});

/* ── god-edit descriptors ──────────────────────────────────────────── */

const ASSET_WRITABLE_FIELDS = new Set([
  'serial_number', 'name', 'rfid_tag', 'pod_number', 'model_id', 'client_id',
  'site_id', 'location_detail', 'status', 'has_rails',
]);

const MODEL_WRITABLE_FIELDS = new Set([
  'make', 'model', 'category', 'ru_size', 'weight_lbs', 'weight_kg',
  'length_in', 'width_in', 'height_in', 'length_cm', 'width_cm',
  'height_cm', 'mount_type', 'rail_type', 'form_factor', 'knowledge',
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
      serial_number: 'SN9', name: 'web-09', rfid_tag: 'RF1', pod_number: '14',
      model_id: 'model-1', client_id: 'client-1', site_id: 'site-1',
      location_detail: 'Rack 3', status: 'active', has_rails: true,
    });
    const expected: Record<string, string> = {
      primary: 'SN9', primary2: 'web-09', rfid: 'RF1', pod: '14', location: 'Rack 3',
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
      mount: 'rails', rail: 'B7', form: '', knowledge: 'Careful with rails.',
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

describe('assetCellText rfid', () => {
  it('shows the EPC without its zero padding (raw stays in the row)', () => {
    const a = asset({ rfid_tag: '000000000000000000100418' });
    expect(assetCellText(a, 'rfid')).toBe('100418');
    expect(a.rfid_tag).toBe('000000000000000000100418');
    expect(assetCellText(asset({ rfid_tag: null }), 'rfid')).toBe('—');
  });
});

describe('Asset ID column', () => {
  it('renders the number and searches by it', () => {
    expect(assetCellText(asset(), 'asset_id')).toBe('100042');
    expect(assetCellText(asset({ legacy_id: null }), 'asset_id')).toBe('—');
    expect(assetSearchText(asset())).toContain('100042');
  });
});

describe('identity columns (Serial / Name, Serial, Name)', () => {
  it('assetCellText reads the split serial and name columns', () => {
    const a = asset({ serial_number: 'SN9', name: 'web-09' });
    expect(assetCellText(a, 'serial')).toBe('SN9');
    expect(assetCellText(a, 'name')).toBe('web-09');
    expect(assetCellText(a, 'primary')).toBe('SN9 web-09');
  });

  it('assetCellText dashes a null serial or name', () => {
    const blank = asset({ serial_number: null, name: null });
    expect(assetCellText(blank, 'serial')).toBe('—');
    expect(assetCellText(blank, 'name')).toBe('—');
  });

  it('IDENTITY_KEYS names the three identity columns', () => {
    expect([...IDENTITY_KEYS]).toEqual(['primary', 'serial', 'name']);
  });

  describe('identityFirst', () => {
    const cols: ColumnDef[] = [
      { key: 'primary', label: 'Serial / Name', width: '2.2fr', default: true },
      { key: 'serial', label: 'Serial', width: '1.2fr', default: false },
      { key: 'name', label: 'Name', width: '1.4fr', default: false },
      { key: 'asset_id', label: 'Asset ID', width: '0.7fr', default: true },
      { key: 'model', label: 'Make / Model', width: '1.5fr', default: true },
      { key: 'client', label: 'Client', width: '1.2fr', default: true },
    ];
    const keys = (list: ColumnDef[]) => list.map((c) => c.key);

    it('puts every unmentioned identity column first, not last', () => {
      const order = ['model', 'client'];
      expect(keys(identityFirst(applyColumnOrder(cols, order), order)))
        .toEqual(['primary', 'serial', 'name', 'model', 'client', 'asset_id']);
    });

    it('respects an identity column the saved order does place', () => {
      const order = ['model', 'primary'];
      expect(keys(identityFirst(applyColumnOrder(cols, order), order)))
        .toEqual(['serial', 'name', 'model', 'primary', 'asset_id', 'client']);
    });

    it('is a no-op once the saved order mentions all three', () => {
      const order = ['model', 'primary', 'serial', 'name', 'client', 'asset_id'];
      expect(keys(identityFirst(applyColumnOrder(cols, order), order))).toEqual(order);
    });
  });

  describe('migrateIdentityColumns', () => {
    const OTHERS = ['asset_id', 'model', 'category', 'client', 'site', 'status'];

    it('leaves a pre-`seen` layout alone (the hook already surfaces primary)', () => {
      // shape (a): no `seen` at all — usePersistentListState's never-seen
      // surfacing turns the default-visible combined column on by itself.
      const stored = { visible: [...OTHERS], order: ['model', 'client'] };
      expect(migrateIdentityColumns(stored)).toBe(stored);
    });

    it("turns the combined column back on when 'primary' was only a pseudo-key", () => {
      // shape (b): saved while 'primary' lived in ALL_COLUMN_KEYS but not in
      // COLUMNS, so `seen` names it and `visible` never could.
      const stored = { visible: [...OTHERS], seen: ['primary', ...OTHERS, 'archived'] };
      expect(migrateIdentityColumns(stored)).toEqual({
        visible: [...OTHERS, 'primary'],
        seen: ['primary', ...OTHERS, 'archived'],
      });
    });

    it('respects a layout saved after the split, with all three turned off', () => {
      // shape (c): the user was offered serial/name and unchecked everything.
      const stored = {
        visible: ['model'],
        seen: ['primary', 'serial', 'name', ...OTHERS, 'archived'],
      };
      expect(migrateIdentityColumns(stored)).toBe(stored);
    });

    it('leaves a layout that already shows an identity column alone', () => {
      for (const key of ['primary', 'serial', 'name']) {
        const stored = { visible: [key, ...OTHERS], seen: ['primary', ...OTHERS] };
        expect(migrateIdentityColumns(stored)).toBe(stored);
      }
    });

    it('leaves non-array visible/seen fields untouched', () => {
      const noSeen = { visible: ['model'] };
      expect(migrateIdentityColumns(noSeen)).toBe(noSeen);
      const junkSeen = { visible: ['model'], seen: 'primary' };
      expect(migrateIdentityColumns(junkSeen)).toBe(junkSeen);
      const junkVisible = { visible: 'model', seen: ['primary'] };
      expect(migrateIdentityColumns(junkVisible)).toBe(junkVisible);
    });

    it('preserves every other stored field', () => {
      const stored = {
        visible: ['model'], seen: ['primary', 'model'], order: ['model'],
        sortKey: 'primary', sortDir: -1 as const, filters: { model: { text: 'dell' } },
      };
      expect(migrateIdentityColumns(stored)).toEqual({ ...stored, visible: ['model', 'primary'] });
    });
  });
});
