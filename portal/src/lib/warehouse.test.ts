import { describe, expect, it } from 'vitest';

import type {
  AssetRef, StockLine, WarehouseContainer, WarehouseInventory, WarehouseSite,
} from './api';
import {
  flattenInventory, formFromStockLine, inventoryCellText, inventorySearchText,
  KIND_LABEL, modelLabel, STOCK_ERRORS, stockPayload, UNIT_SUGGESTIONS,
} from './warehouse';

const site: WarehouseSite = {
  id: 'site1', name: 'ACC4 Storage', code: 'ACC4', city: 'Denver', region: 'CO',
  status: 'active', status_label: 'Active', status_color: '#178a4c',
  container_count: 2, asset_count: 3, stock_line_count: 2, stock_units: 64,
};

const assetInCrate: AssetRef = {
  id: 'a1', legacy_id: 101, serial_number: 'SN-1', name: 'Router 1',
  model_name: 'Cisco 9300', status: 'in_stock', status_label: 'In stock',
  status_color: '#178a4c', location_detail: 'Bay 3',
};

const stockInCrate: StockLine = {
  id: 'sl1', site_id: 'site1', site_name: 'ACC4 Storage',
  container_id: 'c1', container_name: 'Crate A',
  model_id: null, model_make: null, model_model: null,
  description: 'Cat6 cable', quantity: 40, unit: 'spool',
  location_detail: 'Bay 3', notes: 'coil these',
  archived_at: null, created_at: '2026-09-01T00:00:00Z',
  updated_at: '2026-09-01T00:00:00Z',
};

const crateWithBoth: WarehouseContainer = {
  id: 'c1', name: 'Crate A', rfid_tag: 'RFID-A', container_type: 'crate',
  type_label: 'Crate', type_color: '#5b7cfa',
  status: 'available', status_label: 'Available', status_color: '#178a4c',
  location_detail: 'Bay 3', updated_at: '2026-09-05T00:00:00Z',
  assets: [assetInCrate], stock: [stockInCrate],
};

const emptyCrate: WarehouseContainer = {
  id: 'c2', name: 'Crate B (empty)', rfid_tag: null, container_type: 'crate',
  type_label: 'Crate', type_color: '#5b7cfa',
  status: 'available', status_label: 'Available', status_color: '#178a4c',
  location_detail: 'Bay 4', updated_at: '2026-09-06T00:00:00Z',
  assets: [], stock: [],
};

const assetsOnlyCrate: WarehouseContainer = {
  ...emptyCrate, id: 'c3', name: 'Crate C', assets: [assetInCrate], stock: [],
};

const stockOnlyCrate: WarehouseContainer = {
  ...emptyCrate, id: 'c4', name: 'Crate D', assets: [], stock: [stockInCrate],
};

const looseAssetWithSerial: AssetRef = {
  id: 'a2', legacy_id: 102, serial_number: 'SN-2', name: 'Switch 2',
  model_name: 'Cisco 3850', status: 'in_stock', status_label: 'In stock',
  status_color: '#178a4c', location_detail: 'Floor',
};

const looseAssetNoSerial: AssetRef = {
  id: 'a3', legacy_id: null, serial_number: null, name: 'Spare unit',
  model_name: null, status: 'in_stock', status_label: 'In stock',
  status_color: '#178a4c', location_detail: 'Floor',
};

const looseAssetBlank: AssetRef = {
  id: 'a4', legacy_id: null, serial_number: null, name: null,
  model_name: null, status: 'in_stock', status_label: 'In stock',
  status_color: '#178a4c', location_detail: '',
};

const looseStockWithModel: StockLine = {
  id: 'sl2', site_id: 'site1', site_name: 'ACC4 Storage',
  container_id: null, container_name: null,
  model_id: 'm1', model_make: 'Panduit', model_model: 'Patch-24',
  description: 'Patch panels', quantity: 12, unit: 'each',
  location_detail: 'Rack 5', notes: '',
  archived_at: null, created_at: '2026-09-02T00:00:00Z',
  updated_at: '2026-09-02T00:00:00Z',
};

const looseStockNoModel: StockLine = {
  id: 'sl3', site_id: 'site1', site_name: 'ACC4 Storage',
  container_id: null, container_name: null,
  model_id: null, model_make: null, model_model: null,
  description: 'Zip ties', quantity: 200, unit: 'bag',
  location_detail: '', notes: 'assorted sizes',
  archived_at: null, created_at: '2026-09-03T00:00:00Z',
  updated_at: '2026-09-03T00:00:00Z',
};

function inventory(overrides: Partial<WarehouseInventory> = {}): WarehouseInventory {
  return {
    site,
    containers: [crateWithBoth],
    loose_assets: [looseAssetWithSerial],
    loose_stock: [looseStockWithModel],
    ...overrides,
  };
}

describe('flattenInventory', () => {
  it('orders containers (natural name order) before loose assets before loose stock', () => {
    const inv = inventory({
      containers: [
        { ...emptyCrate, id: 'c10', name: 'Crate 10' },
        { ...emptyCrate, id: 'c2b', name: 'Crate 2' },
      ],
      loose_assets: [looseAssetWithSerial],
      loose_stock: [looseStockWithModel],
    });
    const rows = flattenInventory(inv);
    expect(rows.map((r) => r.key)).toEqual([
      'container:c2b', 'container:c10', 'asset:a2', 'stock:sl2',
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['container', 'container', 'asset', 'stock']);
  });

  it('container qtyText combines assets and units, omitting zero parts', () => {
    const inv = inventory({
      containers: [crateWithBoth, emptyCrate, assetsOnlyCrate, stockOnlyCrate],
      loose_assets: [], loose_stock: [],
    });
    const rows = flattenInventory(inv);
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId.c1.qtyText).toBe('1 asset · 40 units');
    expect(byId.c2.qtyText).toBe('');
    expect(byId.c3.qtyText).toBe('1 asset');
    expect(byId.c4.qtyText).toBe('40 units');
  });

  it('container row carries the container object and null asset/stock', () => {
    const rows = flattenInventory(inventory({ loose_assets: [], loose_stock: [] }));
    const row = rows[0];
    expect(row.kind).toBe('container');
    expect(row.container).toBe(crateWithBoth);
    expect(row.asset).toBeNull();
    expect(row.stock).toBeNull();
    expect(row.status).toEqual({ key: 'available', label: 'Available', color: '#178a4c' });
    expect(row.updated).toBe('2026-09-05T00:00:00Z');
    expect(row.model).toBe('Crate');
    expect(row.secondary).toBe('RFID-A');
  });

  it('asset row qtyText is always 1 and carries the asset object', () => {
    const rows = flattenInventory(inventory({ containers: [], loose_stock: [] }));
    const row = rows[0];
    expect(row.kind).toBe('asset');
    expect(row.qtyText).toBe('1');
    expect(row.asset).toBe(looseAssetWithSerial);
    expect(row.container).toBeNull();
    expect(row.stock).toBeNull();
    expect(row.status).toEqual({ key: 'in_stock', label: 'In stock', color: '#178a4c' });
    expect(row.updated).toBeNull();
  });

  it('asset row primary/secondary: serial as primary, name as secondary', () => {
    const rows = flattenInventory(inventory({ containers: [], loose_stock: [] }));
    expect(rows[0].primary).toBe('SN-2');
    expect(rows[0].secondary).toBe('Switch 2');
  });

  it('asset row falls back to name when no serial, and secondary is blank', () => {
    const rows = flattenInventory(inventory({
      containers: [], loose_assets: [looseAssetNoSerial], loose_stock: [],
    }));
    expect(rows[0].primary).toBe('Spare unit');
    expect(rows[0].secondary).toBe('');
  });

  it('asset row falls back to em-dash when neither serial nor name exist', () => {
    const rows = flattenInventory(inventory({
      containers: [], loose_assets: [looseAssetBlank], loose_stock: [],
    }));
    expect(rows[0].primary).toBe('—');
  });

  it('stock row qtyText is "quantity unit" and status is null', () => {
    const rows = flattenInventory(inventory({ containers: [], loose_assets: [] }));
    const row = rows[0];
    expect(row.kind).toBe('stock');
    expect(row.qtyText).toBe('12 each');
    expect(row.status).toBeNull();
    expect(row.stock).toBe(looseStockWithModel);
    expect(row.container).toBeNull();
    expect(row.asset).toBeNull();
    expect(row.updated).toBe('2026-09-02T00:00:00Z');
  });

  it('stock row model is "Make Model" when both present, else blank', () => {
    const rows = flattenInventory(inventory({
      containers: [], loose_assets: [],
      loose_stock: [looseStockWithModel, looseStockNoModel],
    }));
    expect(rows[0].model).toBe('Panduit Patch-24');
    expect(rows[1].model).toBe('');
  });

  it('stock row primary/secondary: description then notes', () => {
    const rows = flattenInventory(inventory({
      containers: [], loose_assets: [], loose_stock: [looseStockNoModel],
    }));
    expect(rows[0].primary).toBe('Zip ties');
    expect(rows[0].secondary).toBe('assorted sizes');
  });
});

describe('inventorySearchText', () => {
  it('includes name/rfid for a container row', () => {
    const rows = flattenInventory(inventory({ loose_assets: [], loose_stock: [] }));
    const t = inventorySearchText(rows[0]);
    expect(t).toContain('crate a');
    expect(t).toContain('rfid-a');
    expect(t).toContain('bay 3');
  });

  it('includes serial/model/location for an asset row', () => {
    const rows = flattenInventory(inventory({ containers: [], loose_stock: [] }));
    const t = inventorySearchText(rows[0]);
    expect(t).toContain('sn-2');
    expect(t).toContain('switch 2');
    expect(t).toContain('cisco 3850');
    expect(t).toContain('floor');
  });

  it('includes description/location for a stock row', () => {
    const rows = flattenInventory(inventory({ containers: [], loose_assets: [] }));
    const t = inventorySearchText(rows[0]);
    expect(t).toContain('patch panels');
    expect(t).toContain('rack 5');
    expect(t).not.toContain('null');
    expect(t).not.toContain('undefined');
  });
});

describe('inventoryCellText', () => {
  const row = flattenInventory(inventory({ loose_assets: [], loose_stock: [] }))[0];
  const stockRow = flattenInventory(inventory({ containers: [], loose_assets: [] }))[0];

  it('reads each column', () => {
    expect(inventoryCellText(row, 'primary')).toBe('Crate A');
    expect(inventoryCellText(row, 'kind')).toBe('Container');
    expect(inventoryCellText(row, 'model')).toBe('Crate');
    expect(inventoryCellText(row, 'qty')).toBe('1 asset · 40 units');
    expect(inventoryCellText(row, 'location')).toBe('Bay 3');
    expect(inventoryCellText(row, 'status')).toBe('Available');
    expect(inventoryCellText(row, 'updated')).not.toBe('');
  });

  it('status falls back to em-dash for stock rows (null status)', () => {
    expect(inventoryCellText(stockRow, 'status')).toBe('—');
  });

  it('updated is blank when the row has no timestamp (loose assets)', () => {
    const assetRow = flattenInventory(inventory({ containers: [], loose_stock: [] }))[0];
    expect(inventoryCellText(assetRow, 'updated')).toBe('');
  });
});

describe('KIND_LABEL / UNIT_SUGGESTIONS / STOCK_ERRORS', () => {
  it('labels each kind', () => {
    expect(KIND_LABEL.container).toBe('Container');
    expect(KIND_LABEL.asset).toBe('Asset');
    expect(KIND_LABEL.stock).toBe('Stock');
  });

  it('offers the standard unit suggestions', () => {
    expect(UNIT_SUGGESTIONS).toEqual(['each', 'box', 'pallet', 'spool', 'roll', 'bag', 'case']);
  });

  it('maps every stock error code to copy', () => {
    expect(STOCK_ERRORS.description_required).toBe('Describe the stock line.');
    expect(STOCK_ERRORS.quantity_required).toBe('Enter a quantity.');
    expect(STOCK_ERRORS.unit_required).toBe('Enter a unit.');
    expect(STOCK_ERRORS.site_not_found).toBe('That warehouse no longer exists.');
    expect(STOCK_ERRORS.site_not_warehouse).toBe('That site is not typed Warehouse.');
    expect(STOCK_ERRORS.container_not_found).toBe('That container no longer exists.');
    expect(STOCK_ERRORS.container_not_at_site).toBe('That container is at a different site.');
    expect(STOCK_ERRORS.model_not_found).toBe('That model no longer exists.');
    expect(STOCK_ERRORS.stock_line_not_found).toBe('That stock line no longer exists.');
    expect(STOCK_ERRORS.forbidden).toBe('You do not have permission to change warehouse stock.');
  });
});

describe('formFromStockLine', () => {
  it('defaults for a null line (new stock)', () => {
    const f = formFromStockLine(null);
    expect(f).toEqual({
      description: '', quantity: '', unit: 'each', model_id: '',
      container_id: '', location_detail: '', notes: '',
    });
  });

  it('round-trips an existing line', () => {
    const f = formFromStockLine(looseStockWithModel);
    expect(f).toEqual({
      description: 'Patch panels', quantity: '12', unit: 'each',
      model_id: 'm1', container_id: '', location_detail: 'Rack 5', notes: '',
    });
  });

  it('maps a contained line container_id and blank model/location', () => {
    const f = formFromStockLine(stockInCrate);
    expect(f.container_id).toBe('c1');
    expect(f.model_id).toBe('');
    expect(f.location_detail).toBe('Bay 3');
    expect(f.notes).toBe('coil these');
  });
});

describe('stockPayload', () => {
  it('always includes site_id and coerces quantity to a number', () => {
    const payload = stockPayload({
      description: '  Cat6 cable  ', quantity: '24', unit: 'each',
      model_id: '', container_id: '', location_detail: '  Bay 3  ', notes: ' ',
    }, 'site1');
    expect(payload).toEqual({
      site_id: 'site1', description: 'Cat6 cable', quantity: 24, unit: 'each',
      model_id: null, container_id: null, location_detail: 'Bay 3', notes: '',
    });
  });

  it('maps blank ids to null and keeps populated ids', () => {
    const payload = stockPayload({
      description: 'Cable', quantity: '5', unit: 'spool',
      model_id: 'm1', container_id: 'c1', location_detail: '', notes: '',
    }, 'site1');
    expect(payload.model_id).toBe('m1');
    expect(payload.container_id).toBe('c1');
  });

  it('defaults a blank unit to "each"', () => {
    const payload = stockPayload({
      description: 'Cable', quantity: '5', unit: '  ',
      model_id: '', container_id: '', location_detail: '', notes: '',
    }, 'site1');
    expect(payload.unit).toBe('each');
  });
});

describe('modelLabel', () => {
  it('joins make and model', () => {
    expect(modelLabel({ make: 'Cisco', model: '9300' })).toBe('Cisco 9300');
  });
});
