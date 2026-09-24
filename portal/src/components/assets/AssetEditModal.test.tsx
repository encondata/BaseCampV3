// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ updateAsset: vi.fn() }));
vi.mock('../../lib/api', async (orig) => ({
  ...(await orig<typeof import('../../lib/api')>()),
  ...api,
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ can: () => false }),
}));

import AssetEditModal from './AssetEditModal';
import { ApiError } from '../../lib/api';
import type { AssetItem } from '../../lib/api';

afterEach(cleanup);

function makeAsset(overrides: Partial<AssetItem> = {}): AssetItem {
  return {
    id: 'asset-1', legacy_id: null, serial_number: 'SN-1', name: 'db-01',
    rfid_tag: null, pod_number: null, model_id: null, model: null,
    client_id: null, client_name: null, site_id: null, site_name: null,
    location_detail: '', status: 'active', status_label: 'Active',
    status_color: '#000', has_rails: null, last_seen_at: null,
    archived_at: null, created_at: '2026-01-01',
    ...overrides,
  };
}

describe('AssetEditModal rule failures', () => {
  it('shows which rule failed and why', async () => {
    api.updateAsset.mockRejectedValue(new ApiError(409, 'rule_failed', {
      code: 'rule_failed', rule_name: 'Stage it', reason: 'unknown status no-such-status',
    }));
    render(<AssetEditModal asset={makeAsset()} statuses={[]} clients={[]} sites={[]}
                           existingSerials={new Set()} canChange
                           onClose={() => {}} onSaved={async () => {}} />);
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByText("Rule 'Stage it' failed: unknown status no-such-status"))
      .toBeTruthy();
  });
});
