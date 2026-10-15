// @vitest-environment jsdom
/**
 * /initiatives/:id/assets/:rowId — the parent-asset panel's Location links
 * to the asset's container and truck.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AssetItem, InitiativeAssetRow } from '../lib/api';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (res: string) => res !== 'scans',
    godMode: false,
    preferences: { list_prefs: {} },
    updatePreferences: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  getAsset: vi.fn(),
  getInitiative: vi.fn(),
  listAssetStatuses: vi.fn(async () => []),
  listInitiativeAssets: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const ROW = {
  id: 'ia1', asset_id: 'a1', priority_wave: null, disposition: null, owner: null,
  source_pod: null, destination_pod: null, source_rack: null, source_ru: null,
  source_verified: null, source_position: null, destination_rack: null, destination_ru: null,
  destination_verified: null, destination_position: null, cable_info: null, vendor_involved: null,
  status: 'staged', status_label: 'Staged', status_color: '#178a4c',
  created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z',
  asset: {
    id: 'a1', legacy_id: null, serial_number: 'SN-0001', name: 'switch-01', rfid_tag: null,
    pod_number: null, model_make: null, model_name: null, ru_size: null, model_form_factor: null,
    location_detail: 'Bay 3', client_name: null, model_category: null, model_category_label: null,
    model_category_color: null, status: 'active', status_label: 'Active', status_color: '#178a4c',
  },
} as InitiativeAssetRow;

const ASSET = {
  id: 'a1', legacy_id: null, serial_number: 'SN-0001', name: 'switch-01', rfid_tag: null,
  pod_number: null, model_id: null, model: null, client_id: null, client_name: null,
  site_id: null, site_name: null, location_detail: 'Bay 3', status: 'active', status_label: 'Active',
  status_color: '#178a4c', has_rails: null, last_seen_at: null, archived_at: null,
  created_at: '2026-08-05T00:00:00Z',
  container_id: 'c1', container_name: 'ATL1-W1M-DC-01', truck_id: 't1', truck_name: 'ATL1-T01',
} as AssetItem;

beforeEach(() => {
  vi.clearAllMocks();
  api.listInitiativeAssets.mockResolvedValue([ROW]);
  api.getAsset.mockResolvedValue(ASSET);
  api.getInitiative.mockResolvedValue({ id: 'i1', name: 'Move', initiative_type: 'project' });
});
afterEach(cleanup);

const { default: MoveAssetDetail } = await import('./MoveAssetDetail');

it('the parent-asset Location links to the container and truck', async () => {
  render(
    <MemoryRouter initialEntries={['/initiatives/i1/assets/ia1']}>
      <Routes><Route path="/initiatives/:id/assets/:rowId" element={<MoveAssetDetail />} /></Routes>
    </MemoryRouter>,
  );
  const c = await screen.findByRole('link', { name: 'ATL1-W1M-DC-01' });
  expect(c.getAttribute('href')).toBe('/logistics/containers?open=c1');
  expect(screen.getByRole('link', { name: 'ATL1-T01' }).getAttribute('href')).toBe('/logistics/trucks/t1');
});
