/**
 * A container's contents list: the columns it offers, and one text / sort /
 * CSV vocabulary over its two kinds of row — rows that carry the full asset
 * record (shared with the Assets list through components/assets/assetColumns)
 * and rows whose asset the viewer cannot open, which only have the flat
 * fields the contents endpoint always returns.
 */

import { ASSET_COLUMNS, ASSET_CSV_COLUMNS, assetSortValue } from '../components/assets/assetColumns';
import type { ContainerAssetRow } from './api';
import { assetCellText } from './assets';
import type { ColumnDef } from './listTools';

/** Default visible columns, in this order; every other shared asset column
 *  (bar the combined Serial / Name and the god-only ones) is offered. */
const DEFAULT_ORDER = ['asset_id', 'rfid', 'name', 'serial', 'model'];

const shared = ASSET_COLUMNS.filter((c) => c.key !== 'primary' && !c.godOnly);

// Fit: default columns + trailing ≤ LIST_FIT.page (see ContainerContentsList.test).
export const CONTENTS_COLUMNS: ColumnDef[] = [
  ...DEFAULT_ORDER.map((k) => ({ ...shared.find((c) => c.key === k)!, default: true })),
  ...shared.filter((c) => !DEFAULT_ORDER.includes(c.key)).map((c) => ({ ...c, default: false })),
  { key: 'packed', label: 'Packed', width: '1fr', default: false, min: 110 },
];

export const CONTENTS_ALL_KEYS = new Set(CONTENTS_COLUMNS.map((c) => c.key));
export const CONTENTS_DEFAULT_VISIBLE = new Set(
  CONTENTS_COLUMNS.filter((c) => c.default).map((c) => c.key));

/** The Packed column's date (local), from `added_at`. */
export const packedDate = (r: ContainerAssetRow): string =>
  new Date(r.added_at).toLocaleDateString();

const modelText = (r: ContainerAssetRow): string => r.model_name ?? '';

/** Display / filter text for one cell. Rows without an asset record fall
 *  back to the flat fields and '—' for what they cannot know. */
export function contentsCellText(r: ContainerAssetRow, key: string): string {
  if (key === 'packed') return packedDate(r);
  if (r.asset) return assetCellText(r.asset, key);
  switch (key) {
    case 'serial': return r.serial_number ?? '—';
    case 'name': return r.name ?? '—';
    case 'model': return r.model_name ?? '—';
    case 'status': return r.status_label;
    default: return '—';
  }
}

/** Raw, lowercase value per column for ordering (natural compare). */
export function contentsSortValue(r: ContainerAssetRow, key: string): string {
  if (key === 'packed') return r.added_at;
  if (r.asset) return assetSortValue(r.asset, key);
  switch (key) {
    case 'serial': return (r.serial_number ?? '').toLowerCase();
    case 'name': return (r.name ?? '').toLowerCase();
    case 'model': return modelText(r).toLowerCase();
    case 'status': return r.status_label.toLowerCase();
    default: return '';
  }
}

/** Everything a row shows (every column, shown or not) plus who packed it. */
export function contentsSearchText(r: ContainerAssetRow): string {
  return [
    ...CONTENTS_COLUMNS.map((c) => contentsCellText(r, c.key)),
    r.added_by_name ?? '',
  ].join(' ').toLowerCase();
}

/** Flat-field answers for the CSV headers a row without an asset can fill. */
const CSV_FALLBACK: Record<string, (r: ContainerAssetRow) => string> = {
  ID: (r) => r.asset_id,
  Serial: (r) => r.serial_number ?? '',
  Name: (r) => r.name ?? '',
  Model: modelText,
  Status: (r) => r.status_label,
};

export const CONTENTS_CSV_COLUMNS: [string, (r: ContainerAssetRow) => string][] = [
  ...ASSET_CSV_COLUMNS.map(([head, fn]): [string, (r: ContainerAssetRow) => string] => [
    head, (r) => (r.asset ? fn(r.asset) : (CSV_FALLBACK[head]?.(r) ?? '')),
  ]),
  ['Packed', (r) => r.added_at],
  ['Packed by', (r) => r.added_by_name ?? ''],
];
