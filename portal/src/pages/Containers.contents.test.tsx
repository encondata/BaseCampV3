// @vitest-environment jsdom
/**
 * The expanded row's contents list refetches when the Edit container dialog
 * saves (it adds / removes packed assets without changing the container id).
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ContainerItem, UiPreferences } from '../lib/api';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
      motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      list_prefs: {},
    } as unknown as UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  listContainers: vi.fn(),
  listContainerStatuses: vi.fn(),
  listContainerTypes: vi.fn(),
  listSites: vi.fn(),
  listInitiatives: vi.fn(),
  listContainerAssets: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

// The dialog's own behavior is covered by ContainerEditModal.test.tsx; here it
// is a stub whose button reports "saved" the way an add / remove does.
vi.mock('../components/containers/ContainerEditModal', () => ({
  default: ({ onSaved }: { onSaved: () => Promise<void> | void }) => (
    <button onClick={() => void onSaved()}>Stub save</button>
  ),
}));

const CONTAINER: ContainerItem = {
  id: 'c1', name: 'Rack Cart 1', rfid_tag: null,
  container_type: 'cart', type_label: 'Cart', type_color: '#1890ff',
  status: 'available', status_label: 'Available', status_color: '#22aa55',
  site_id: null, site_name: null, location_detail: '', asset_count: 0,
  last_audit_at: null, last_validated_at: null,
  archived_at: null, created_at: '2026-09-01T00:00:00Z',
  initiative_id: null, initiative_name: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  api.listContainers.mockResolvedValue([CONTAINER]);
  api.listContainerStatuses.mockResolvedValue([]);
  api.listContainerTypes.mockResolvedValue([]);
  api.listSites.mockResolvedValue([]);
  api.listInitiatives.mockResolvedValue([]);
  api.listContainerAssets.mockResolvedValue([]);
});

afterEach(cleanup);

const { default: Containers } = await import('./Containers');

it('refetches the open row\'s contents after the Edit dialog saves', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><Containers /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Rack Cart 1')).not.toBeNull());
  await user.click(screen.getByText('Rack Cart 1'));
  expect(await screen.findByText('No assets in this container.')).toBeTruthy();
  expect(api.listContainerAssets).toHaveBeenCalledTimes(1);

  api.listContainerAssets.mockResolvedValue([{
    asset_id: 'a1', serial_number: 'SN-NEW', name: 'New-01', model_name: null,
    status: 'active', status_label: 'Active', status_color: '#22aa55',
    added_at: '2026-09-02T12:00:00Z', added_by_name: null, asset: null,
  }]);
  await user.click(screen.getByRole('button', { name: 'Edit' }));
  await user.click(await screen.findByRole('button', { name: 'Stub save' }));

  expect(await screen.findByText('SN-NEW')).toBeTruthy();
  expect(api.listContainerAssets).toHaveBeenCalledTimes(2);
});
