// @vitest-environment jsdom
/**
 * TruckEditModal — create/edit form covering the client-side name
 * validation (never calls the API on a blank name), the container
 * multi-picker feeding `container_ids` into the payload, the
 * `contact_info` never-null guarantee from lib/trucks.ts's truckPayload,
 * and the TRUCK_ERRORS mapping on a server rejection.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError,
  type ContainerItem, type InitiativeItem, type SiteItem,
  type StatusValue, type TruckDetail, type TruckItem,
} from '../../lib/api';

const api = vi.hoisted(() => ({
  listTruckStatuses: vi.fn(),
  listInitiatives: vi.fn(),
  listSites: vi.fn(),
  listContainers: vi.fn(),
  getTruck: vi.fn(),
  createTruck: vi.fn(),
  updateTruck: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const STATUSES: StatusValue[] = [
  {
    record_type: 'truck', key: 'created', label: 'Created', description: '',
    color: '#8a8f98', sort_order: 0, is_active: true, usage_count: null, progress_weight: null,
  },
  {
    record_type: 'truck', key: 'en_route', label: 'En route', description: '',
    color: '#178a4c', sort_order: 1, is_active: true, usage_count: null, progress_weight: null,
  },
];

const INITIATIVES: InitiativeItem[] = [];
const SITES: SiteItem[] = [];

const CONTAINER: ContainerItem = {
  id: 'c1', name: 'Container A', rfid_tag: null,
  container_type: null, type_label: null, type_color: null,
  status: 'active', status_label: 'Active', status_color: '#178a4c',
  site_id: null, site_name: null, location_detail: '', asset_count: 3,
  last_audit_at: null, last_validated_at: null,
  archived_at: null, created_at: '2026-08-01T00:00:00Z',
};

const TRUCK: TruckItem = {
  id: 't1', legacy_id: null, name: 'Truck One',
  driver_name: 'Ada Lovelace', co_driver_name: null, team_drive: false,
  contact_info: '', status: 'created', status_label: 'Created', status_color: '#8a8f98',
  load_number: '1001', seal_id: 'SEAL-1',
  tracking_type: {}, initiative_id: null, initiative_name: null,
  start_site_id: null, start_site_name: null, end_site_id: null, end_site_name: null,
  container_count: 0, last_update: null,
  archived_at: null, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};

const TRUCK_DETAIL: TruckDetail = { ...TRUCK, containers: [] };

beforeEach(() => {
  vi.clearAllMocks();
  api.listTruckStatuses.mockResolvedValue(STATUSES);
  api.listInitiatives.mockResolvedValue(INITIATIVES);
  api.listSites.mockResolvedValue(SITES);
  api.listContainers.mockResolvedValue([CONTAINER]);
  api.getTruck.mockResolvedValue(TRUCK_DETAIL);
});

afterEach(cleanup);

const { default: TruckEditModal } = await import('./TruckEditModal');

function renderCreate() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<TruckEditModal truck={null} onClose={onClose} onSaved={onSaved} />);
  return { onSaved, onClose };
}

function renderEdit() {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<TruckEditModal truck={TRUCK} onClose={onClose} onSaved={onSaved} />);
  return { onSaved, onClose };
}

it('renders with the loaded lookups', async () => {
  renderCreate();

  expect(await screen.findByText('Container A')).not.toBeNull();
  // status defaults to 'created', which the loaded statuses resolve to
  // a label — the combo shows it as the current value.
  expect(screen.getByDisplayValue('Created')).not.toBeNull();
  expect(screen.getByPlaceholderText('Type to search moves…')).not.toBeNull();
});

it('shows a blank-name error and never calls the API', async () => {
  const user = userEvent.setup();
  renderCreate();
  await screen.findByText('Container A');

  await user.click(screen.getByRole('button', { name: /create truck/i }));

  expect(await screen.findByText('Give the truck a name.')).not.toBeNull();
  expect(api.createTruck).not.toHaveBeenCalled();
});

it('save sends contact_info as an empty string (never null) and the picked container ids', async () => {
  const user = userEvent.setup();
  api.updateTruck.mockResolvedValue(TRUCK_DETAIL);
  const { onSaved, onClose } = renderEdit();

  await screen.findByText('Container A');
  await user.click(screen.getByRole('checkbox', { name: /container a/i }));
  await user.click(screen.getByRole('button', { name: /^save$/i }));

  await waitFor(() => expect(api.updateTruck).toHaveBeenCalledWith('t1', expect.objectContaining({
    contact_info: '',
    container_ids: ['c1'],
  })));
  expect(onSaved).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

it('maps an unknown_status API error onto the status field guidance', async () => {
  const user = userEvent.setup();
  api.updateTruck.mockRejectedValue(new ApiError(422, 'unknown_status'));
  renderEdit();

  await screen.findByText('Container A');
  await user.click(screen.getByRole('button', { name: /^save$/i }));

  expect(await screen.findByText('Pick a status from the list.')).not.toBeNull();
});
