// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { AssetScanRow } from '../../lib/api';

const api = vi.hoisted(() => ({ listAssetScans: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));
afterEach(cleanup);

const { default: ScanHistoryTable } = await import('./ScanHistoryTable');

function row(over: Partial<AssetScanRow>): AssetScanRow {
  return {
    id: 's1', scanned_value: 'EPC', scan_type: 'rfid',
    scan_type_label: 'RFID', scan_type_color: '#1668a7',
    status: null, status_label: null, status_color: null,
    scanned_at: '2026-08-27T09:00:00Z', processed_at: '2026-08-27T09:01:00Z',
    device_id: 'dock-1', operator_id: null, operator_name: null,
    site_id: null, site_name: null, location_detail: '', source: 'reader',
    off_move: false, ...over,
  };
}

it('shows the Off move chip on the flagged scan only', async () => {
  api.listAssetScans.mockResolvedValue([
    row({ id: 's1', device_id: 'dock-in' }),
    row({ id: 's2', device_id: 'dock-off', off_move: true }),
  ]);
  render(<ScanHistoryTable assetId="a1" />);
  await waitFor(() => expect(screen.queryByText('dock-off')).not.toBeNull());
  const chips = screen.getAllByText('Off move');
  expect(chips).toHaveLength(1);
  expect(chips[0].closest('tr')?.textContent).toContain('dock-off');
});
