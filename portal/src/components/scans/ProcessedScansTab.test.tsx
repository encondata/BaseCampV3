// @vitest-environment jsdom
/**
 * Off move on the processed-scans list: the chip shows on flagged rows
 * only, and the always-present Off move filter (default view, no column
 * changes) narrows the list to them.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ProcessedScanRow, UiPreferences } from '../../lib/api';

const auth = vi.hoisted(() => ({
  value: null as unknown,
}));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => auth.value }));
auth.value = {
  can: () => true,
  godMode: false,
  preferences: {
    accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
    motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
    list_prefs: {},
  } as unknown as UiPreferences,
  updatePreferences: vi.fn(() => Promise.resolve()),
};

const api = vi.hoisted(() => ({
  listProcessedScans: vi.fn(),
  listSites: vi.fn(),
  listUsers: vi.fn(),
  updateProcessedScan: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));
vi.mock('../../lib/pendingDeletes', () => ({
  usePendingDeletes: () => ({
    pendingIds: new Set<string>(), mark: vi.fn(), unmark: vi.fn(),
  }),
}));

function scan(over: Partial<ProcessedScanRow>): ProcessedScanRow {
  return {
    id: 'p1', scanned_value: 'EPC-IN', scan_type: 'rfid',
    scan_type_label: 'RFID', scan_type_color: '#1668a7',
    status: null, status_label: null, status_color: null,
    scanned_at: '2026-08-27T09:00:00Z', device_id: 'dock-1',
    operator_id: null, operator_name: null, site_id: null, site_name: null,
    location_detail: '', source: 'reader', raw_scan_id: 1,
    match_type: 'asset', match_type_label: 'Asset', match_type_color: '#178a4c',
    asset_id: 'a1', container_id: null, person_id: null, matched_name: 'srv-in',
    processed_at: '2026-08-27T09:01:00Z', archived_at: null,
    created_at: '2026-08-27T09:01:00Z', off_move: false,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.listProcessedScans.mockResolvedValue([
    scan({ id: 'p1', scanned_value: 'EPC-IN', matched_name: 'srv-in' }),
    scan({ id: 'p2', scanned_value: 'EPC-OFF', matched_name: 'srv-off',
           off_move: true, scanned_at: '2026-08-27T09:05:00Z' }),
  ]);
  api.listSites.mockResolvedValue([]);
  api.listUsers.mockResolvedValue([]);
});
afterEach(cleanup);

const { default: ProcessedScansTab } = await import('./ProcessedScansTab');
const mount = () => render(<MemoryRouter><ProcessedScansTab onCount={() => {}} /></MemoryRouter>);

it('shows the Off move chip on the flagged row only', async () => {
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-OFF')).not.toBeNull());
  expect(screen.getAllByText('Off move')).toHaveLength(1);
  const chip = document.querySelector('.chip.c-amber') as HTMLElement;
  expect(chip.closest('.dir-row')?.textContent).toContain('EPC-OFF');
});

it('the default-view Off move filter narrows the list to flagged rows', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-IN')).not.toBeNull());

  await user.click(screen.getByRole('button', { name: 'Off move column menu' }));
  const menu = document.querySelector('.colmenu-menu') as HTMLElement;
  // The checklist starts all-checked; unchecking No leaves only Yes.
  const no = Array.from(menu.querySelectorAll('.colmenu-list .pop-item'))
    .find((el) => el.textContent?.trim() === 'No') as HTMLElement;
  await user.click(no);

  await waitFor(() => expect(screen.queryByText('EPC-IN')).toBeNull());
  expect(screen.queryByText('EPC-OFF')).not.toBeNull();
});
