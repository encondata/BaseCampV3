/**
 * Warehouse page logic — pure functions the components delegate to
 * (the lib/trucks.ts pattern), unit-testable without jsdom.
 */
import type { AssetRef, StockLine, WarehouseContainer, WarehouseInventory } from './api';
import { relativeTime } from './format';
import { naturalCompare } from './sites';

export type InventoryRowKind = 'container' | 'asset' | 'stock';

export interface InventoryRow {
  key: string;                 // `${kind}:${id}`
  kind: InventoryRowKind;
  id: string;
  primary: string;             // container name | asset serial ?? name ?? '—' | stock description
  secondary: string;           // container: rfid or '' | asset: name when serial shown | stock: notes
  model: string;               // container: type_label ?? '' | asset: model_name ?? '' | stock: "Make Model" or ''
  qtyText: string;             // container: "3 assets · 40 units" | asset: '1' | stock: `${quantity} ${unit}`
  location: string;
  status: { key: string; label: string; color: string } | null; // null for stock
  updated: string | null;      // ISO
  container: WarehouseContainer | null;
  asset: AssetRef | null;
  stock: StockLine | null;
}

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

function containerQtyText(c: WarehouseContainer): string {
  const assetsN = c.assets.length;
  const units = c.stock.reduce((sum, l) => sum + l.quantity, 0);
  const parts: string[] = [];
  if (assetsN > 0) parts.push(plural(assetsN, 'asset'));
  if (units > 0) parts.push(plural(units, 'unit'));
  return parts.join(' · ');
}

function containerRow(c: WarehouseContainer): InventoryRow {
  return {
    key: `container:${c.id}`, kind: 'container', id: c.id,
    primary: c.name,
    secondary: c.rfid_tag ?? '',
    model: c.type_label ?? '',
    qtyText: containerQtyText(c),
    location: c.location_detail,
    status: { key: c.status, label: c.status_label, color: c.status_color },
    updated: c.updated_at,
    container: c, asset: null, stock: null,
  };
}

function assetRow(a: AssetRef): InventoryRow {
  const primary = a.serial_number ?? a.name ?? '—';
  const secondary = a.serial_number ? (a.name ?? '') : '';
  return {
    key: `asset:${a.id}`, kind: 'asset', id: a.id,
    primary, secondary,
    model: a.model_name ?? '',
    qtyText: '1',
    location: a.location_detail,
    status: { key: a.status, label: a.status_label, color: a.status_color },
    updated: null,
    container: null, asset: a, stock: null,
  };
}

function stockModelText(l: StockLine): string {
  return l.model_make && l.model_model ? modelLabel({ make: l.model_make, model: l.model_model }) : '';
}

function stockRow(l: StockLine): InventoryRow {
  return {
    key: `stock:${l.id}`, kind: 'stock', id: l.id,
    primary: l.description,
    secondary: l.notes,
    model: stockModelText(l),
    qtyText: `${l.quantity} ${l.unit}`,
    location: l.location_detail,
    status: null,
    updated: l.updated_at,
    container: null, asset: null, stock: l,
  };
}

/** Containers (natural name order), then loose assets, then loose stock. */
export function flattenInventory(inv: WarehouseInventory): InventoryRow[] {
  const containers = [...inv.containers].sort((a, b) => naturalCompare(a.name, b.name));
  return [
    ...containers.map(containerRow),
    ...inv.loose_assets.map(assetRow),
    ...inv.loose_stock.map(stockRow),
  ];
}

export function inventorySearchText(r: InventoryRow): string {
  return [r.primary, r.secondary, r.model, r.location, r.status?.label]
    .filter(Boolean).join(' ').toLowerCase();
}

/** Column-menu accessor — one row's display text per column key, mirroring
 *  the page's cell renderer exactly (including '—' fallbacks). */
export function inventoryCellText(
  r: InventoryRow,
  colKey: 'primary' | 'kind' | 'model' | 'qty' | 'location' | 'status' | 'updated',
): string {
  switch (colKey) {
    case 'primary': return r.primary;
    case 'kind': return KIND_LABEL[r.kind];
    case 'model': return r.model;
    case 'qty': return r.qtyText;
    case 'location': return r.location;
    case 'status': return r.status?.label ?? '—';
    case 'updated': return r.updated ? relativeTime(r.updated) : '';
    default: return '';
  }
}

export const KIND_LABEL: Record<InventoryRowKind, string> = {
  container: 'Container', asset: 'Asset', stock: 'Stock',
};

export const UNIT_SUGGESTIONS = ['each', 'box', 'pallet', 'spool', 'roll', 'bag', 'case'];

export const STOCK_ERRORS: Record<string, string> = {
  description_required: 'Describe the stock line.',
  quantity_required: 'Enter a quantity.',
  unit_required: 'Enter a unit.',
  site_not_found: 'That warehouse no longer exists.',
  site_not_warehouse: 'That site is not typed Warehouse.',
  container_not_found: 'That container no longer exists.',
  container_not_at_site: 'That container is at a different site.',
  model_not_found: 'That model no longer exists.',
  stock_line_not_found: 'That stock line no longer exists.',
  forbidden: 'You do not have permission to change warehouse stock.',
};

export interface StockFormState {
  description: string;
  quantity: string;
  unit: string;
  model_id: string;
  container_id: string;
  location_detail: string;
  notes: string;
}

export function formFromStockLine(line: StockLine | null): StockFormState {
  return {
    description: line?.description ?? '',
    quantity: line ? String(line.quantity) : '',
    unit: line?.unit || 'each',
    model_id: line?.model_id ?? '',
    container_id: line?.container_id ?? '',
    location_detail: line?.location_detail ?? '',
    notes: line?.notes ?? '',
  };
}

/** Payload for create AND patch. Trims strings; blank ids become null;
 *  quantity is coerced to a Number; a blank unit defaults to 'each';
 *  site_id is ALWAYS included (the warehouse is fixed by the page). */
export function stockPayload(f: StockFormState, siteId: string): Record<string, unknown> {
  return {
    site_id: siteId,
    description: f.description.trim(),
    quantity: Number(f.quantity),
    unit: f.unit.trim() || 'each',
    model_id: f.model_id.trim() || null,
    container_id: f.container_id.trim() || null,
    location_detail: f.location_detail.trim(),
    notes: f.notes.trim(),
  };
}

export function modelLabel(m: { make: string; model: string }): string {
  return `${m.make} ${m.model}`;
}
