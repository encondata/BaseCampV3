// @vitest-environment jsdom
/**
 * The columns, sort values, CSV columns and read-only cells the Assets list
 * and a container's contents list share. The Assets page tests cover the
 * composed page; these pin the moved pieces on their own.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'vitest';

import type { AssetItem } from '../../lib/api';
import {
  ASSET_COLUMNS, ASSET_CSV_COLUMNS, AssetCell, assetSortValue,
} from './assetColumns';

const asset = (over: Partial<AssetItem> = {}): AssetItem => ({
  id: 'a1', legacy_id: 42, serial_number: 'SN-ALPHA', name: 'Web-01',
  rfid_tag: '000ABC', pod_number: 'P7',
  model_id: 'm1',
  model: {
    id: 'm1', make: 'Dell', model: 'R740', category: 'server',
    category_label: 'Server', category_color: null, ru_size: 2,
  },
  client_id: null, client_name: null, site_id: 's1', site_name: 'DC1',
  location_detail: 'Rack 3', status: 'active', status_label: 'Active',
  status_color: '#178a4c', has_rails: true, last_seen_at: null,
  archived_at: null, created_at: '2026-08-05T00:00:00Z',
  ...over,
});

afterEach(cleanup);

const cell = (a: AssetItem, colKey: string, statusExtras?: React.ReactNode) =>
  render(
    <MemoryRouter>
      <AssetCell asset={a} colKey={colKey} statusExtras={statusExtras} />
    </MemoryRouter>,
  ).container;

it('keeps the Assets list column order, defaults and god-only flag', () => {
  expect(ASSET_COLUMNS.map((c) => c.key)).toEqual([
    'primary', 'serial', 'name', 'asset_id', 'model', 'category', 'client', 'site',
    'status', 'ru', 'location', 'pod', 'rfid', 'last_seen', 'has_rails',
  ]);
  expect(ASSET_COLUMNS.filter((c) => c.default).map((c) => c.key)).toEqual([
    'primary', 'asset_id', 'model', 'category', 'client', 'site', 'status',
  ]);
  expect(ASSET_COLUMNS.filter((c) => c.godOnly).map((c) => c.key)).toEqual(['has_rails']);
});

it('sorts by raw lowercase values, zero-padded asset id and placement text', () => {
  const a = asset();
  expect(assetSortValue(a, 'serial')).toBe('sn-alpha');
  expect(assetSortValue(a, 'name')).toBe('web-01');
  expect(assetSortValue(a, 'asset_id')).toBe('000000000042');
  expect(assetSortValue(asset({ legacy_id: null }), 'asset_id')).toBe('');
  expect(assetSortValue(a, 'model')).toBe('dell r740');
  expect(assetSortValue(a, 'ru')).toBe('2');
  expect(assetSortValue(a, 'status')).toBe('active');
  expect(assetSortValue(a, 'has_rails')).toBe('yes');
  expect(assetSortValue(a, 'location')).toBe('rack 3');
  expect(assetSortValue(
    asset({ container_id: 'c1', container_name: 'Crate-9', truck_id: 't1', truck_name: 'Truck-2' }),
    'location',
  )).toBe('crate-9 · on truck-2');
  expect(assetSortValue(a, 'nope')).toBe('');
});

it('exports the Assets CSV columns', () => {
  const a = asset();
  const row = Object.fromEntries(ASSET_CSV_COLUMNS.map(([h, f]) => [h, f(a)]));
  expect(ASSET_CSV_COLUMNS.map(([h]) => h)).toEqual([
    'Asset ID', 'ID', 'Serial', 'Name', 'Make', 'Model', 'Category', 'Client', 'Site',
    'Location', 'Pod #', 'Status', 'RFID', 'Has rails', 'Last seen', 'Created',
  ]);
  expect(row['Asset ID']).toBe('42');
  expect(row.Make).toBe('Dell');
  expect(row.Location).toBe('Rack 3');
  expect(row['Has rails']).toBe('true');
});

it('renders the identity, model and RFID cells with the list cell classes', () => {
  const id = cell(asset(), 'asset_id').querySelector('span.mono.cell-line');
  expect(id?.textContent).toBe('42');
  expect(id?.getAttribute('title')).toBeTruthy();

  const model = cell(asset(), 'model').querySelector('span.cell-top.cell-line');
  expect(model?.textContent).toBe('Dell R740');

  const rfid = cell(asset(), 'rfid').querySelector('span.mono.cell-line');
  expect(rfid?.textContent).toBe('ABC');
  expect(rfid?.getAttribute('title')).toBe('000ABC');

  const primary = cell(asset(), 'primary').querySelector('div.pn');
  expect(primary?.querySelector('b')?.textContent).toBe('SN-ALPHA');
  expect(primary?.querySelector('span')?.textContent).toBe('Web-01');
});

it('renders the status chip, with page extras after it inside the chips box', () => {
  const box = cell(asset(), 'status', <span className="chip tag">Archived</span>)
    .querySelector('div.chips');
  const chips = box?.querySelectorAll('.chip');
  expect(chips?.[0].textContent).toBe('Active');
  expect(chips?.[1].textContent).toBe('Archived');
  expect(screen.queryByText('Pending delete')).toBeNull();
});

it('renders the location cell through AssetLocation', () => {
  const c = cell(
    asset({ container_id: 'c1', container_name: 'Crate-9' }), 'location',
  );
  expect(c.querySelector('a.asset-loc-link')?.textContent).toBe('Crate-9');
});
