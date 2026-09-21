// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ updateInitiativeAsset: vi.fn() }));
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  ...api,
}));

import AssetEditDialog from './AssetEditDialog';
import { ApiError } from '../../lib/api';
import type { InitiativeAssetRow, InitiativeAssetSummary } from '../../lib/api';

afterEach(cleanup);

function makeAsset(overrides: Partial<InitiativeAssetSummary> = {}): InitiativeAssetSummary {
  return {
    id: 'asset-1', legacy_id: null, serial_number: 'SN-1', name: 'w1-hs4-m0407',
    rfid_tag: null, model_make: null, model_name: null, ru_size: 1,
    model_form_factor: null, location_detail: null, client_name: null,
    model_category: null, model_category_label: null, model_category_color: null,
    status: 'active', status_label: 'Active', status_color: '#000',
    ...overrides,
  };
}

function makeRow(overrides: Partial<InitiativeAssetRow> = {}): InitiativeAssetRow {
  return {
    id: 'row-1', asset_id: 'asset-1',
    priority_wave: null, disposition: null, owner: null,
    source_rack: 'R1', source_ru: 10, source_verified: true, source_position: 'rear',
    destination_rack: null, destination_ru: null,
    destination_verified: null, destination_position: null,
    cable_info: null, vendor_involved: null,
    status: 'active', status_label: 'Active', status_color: '#000',
    created_at: '2026-01-01', updated_at: '2026-01-01',
    asset: makeAsset(),
    ...overrides,
  };
}

describe('AssetEditDialog rule failures', () => {
  it('shows which rule failed and why', async () => {
    api.updateInitiativeAsset.mockRejectedValue(new ApiError(409, 'rule_failed', {
      code: 'rule_failed', rule_name: 'Stage it', reason: 'unknown status no-such-status',
    }));
    render(<AssetEditDialog asset={makeRow()} moveStatuses={[]} onClose={() => {}}
                            onSaved={async () => {}} />);
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText("Rule 'Stage it' failed: unknown status no-such-status"))
      .toBeTruthy();
  });
});
