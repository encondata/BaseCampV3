// @vitest-environment jsdom
/**
 * TruckEditModal — create/edit form covering the client-side name
 * validation (never calls the API on a blank name), the containers
 * section (lists only the truck's own containers; Add container searches
 * the truck's move; Remove drops one; both feed `container_ids`), the
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

// A truck on move i1 already carrying Container A.
const ON_MOVE: ContainerItem[] = [
  { ...CONTAINER, initiative_id: 'i1', initiative_name: 'Move One' },
  { ...CONTAINER, id: 'c2', name: 'Container B', asset_count: 5, initiative_id: 'i1', initiative_name: 'Move One' },
  { ...CONTAINER, id: 'c3', name: 'Container C', initiative_id: 'i2', initiative_name: 'Move Two' },
  { ...CONTAINER, id: 'c4', name: 'Container D', initiative_id: 'i1', archived_at: '2026-09-01T00:00:00Z' },
];
const MOVE_TRUCK: TruckItem = { ...TRUCK, initiative_id: 'i1', initiative_name: 'Move One', container_count: 1 };
const MOVE_TRUCK_DETAIL: TruckDetail = {
  ...MOVE_TRUCK,
  containers: [{ id: 'c1', name: 'Container A', status: 'active', status_label: 'Active', status_color: '#178a4c', asset_count: 3 }],
};

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

function renderEdit(truck: TruckItem = TRUCK) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  render(<TruckEditModal truck={truck} onClose={onClose} onSaved={onSaved} />);
  return { onSaved, onClose };
}

async function lookupsLoaded() {
  await waitFor(() => expect(api.listContainers).toHaveBeenCalled());
  await screen.findByDisplayValue('Created');
}

async function openAddContainer(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByPlaceholderText('Type to search containers…'));
}

it('renders with the loaded lookups', async () => {
  renderCreate();

  expect(await screen.findByText('No containers on this truck yet.')).not.toBeNull();
  // Containers are not listed until added.
  expect(screen.queryByText('Container A')).toBeNull();
  // status defaults to 'created', which the loaded statuses resolve to
  // a label — the combo shows it as the current value.
  expect(screen.getByDisplayValue('Created')).not.toBeNull();
  expect(screen.getByPlaceholderText('Type to search moves…')).not.toBeNull();
});

it('shows a blank-name error and never calls the API', async () => {
  const user = userEvent.setup();
  renderCreate();
  await lookupsLoaded();

  await user.click(screen.getByRole('button', { name: /create truck/i }));

  expect(await screen.findByText('Give the truck a name.')).not.toBeNull();
  expect(api.createTruck).not.toHaveBeenCalled();
});

it('save sends contact_info as an empty string (never null) and the added container ids', async () => {
  const user = userEvent.setup();
  api.updateTruck.mockResolvedValue(TRUCK_DETAIL);
  const { onSaved, onClose } = renderEdit();

  await lookupsLoaded();
  await openAddContainer(user);
  await user.click(await screen.findByRole('button', { name: /container a/i }));
  await user.click(screen.getByRole('button', { name: /^save$/i }));

  await waitFor(() => expect(api.updateTruck).toHaveBeenCalledWith('t1', expect.objectContaining({
    contact_info: '',
    container_ids: ['c1'],
  })));
  expect(onSaved).toHaveBeenCalled();
  expect(onClose).toHaveBeenCalled();
});

it('keeps the row\'s known fields when getTruck fails, and saves them (not blanks/created)', async () => {
  const user = userEvent.setup();
  api.getTruck.mockRejectedValue(new ApiError(500, 'server_error'));
  api.updateTruck.mockResolvedValue(TRUCK_DETAIL);
  renderEdit();

  // The failed detail fetch settles into a form seeded from the row —
  // never the all-blank/'created' defaults formFromTruck(null) would give.
  expect(await screen.findByDisplayValue('Truck One')).not.toBeNull();
  expect(screen.getByDisplayValue('Ada Lovelace')).not.toBeNull();
  expect(screen.getByDisplayValue('Created')).not.toBeNull();
  expect(screen.getByText("Couldn't load the containers on this truck.")).not.toBeNull();

  await user.click(screen.getByRole('button', { name: /^save$/i }));

  await waitFor(() => expect(api.updateTruck).toHaveBeenCalledWith('t1', expect.objectContaining({
    name: 'Truck One',
    driver_name: 'Ada Lovelace',
    status: 'created',
  })));
});

it('maps an unknown_status API error onto the status field guidance', async () => {
  const user = userEvent.setup();
  api.updateTruck.mockRejectedValue(new ApiError(422, 'unknown_status'));
  renderEdit();

  await lookupsLoaded();
  await user.click(screen.getByRole('button', { name: /^save$/i }));

  expect(await screen.findByText('Pick a status from the list.')).not.toBeNull();
});

it('lists only the containers on the truck, each with a Remove button', async () => {
  api.listContainers.mockResolvedValue(ON_MOVE);
  api.getTruck.mockResolvedValue(MOVE_TRUCK_DETAIL);
  renderEdit(MOVE_TRUCK);

  expect(await screen.findByText('Container A')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Remove Container A' })).not.toBeNull();
  expect(screen.queryByText('Container B')).toBeNull();
  expect(screen.queryByText('Container C')).toBeNull();
});

it('Add container offers only unarchived containers on the truck\'s move not already on it', async () => {
  const user = userEvent.setup();
  api.listContainers.mockResolvedValue(ON_MOVE);
  api.getTruck.mockResolvedValue(MOVE_TRUCK_DETAIL);
  api.updateTruck.mockResolvedValue(MOVE_TRUCK_DETAIL);
  renderEdit(MOVE_TRUCK);
  await screen.findByText('Container A');

  await openAddContainer(user);
  expect(await screen.findByRole('button', { name: /container b/i })).not.toBeNull();
  expect(screen.queryByRole('button', { name: /container c/i })).toBeNull();   // other move
  expect(screen.queryByRole('button', { name: /container d/i })).toBeNull();   // archived
  expect(screen.queryByRole('button', { name: /^container a/i })).toBeNull();  // already on

  await user.click(screen.getByRole('button', { name: /container b/i }));
  expect(screen.getByRole('button', { name: 'Remove Container B' })).not.toBeNull();

  await user.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() => expect(api.updateTruck).toHaveBeenCalledWith('t1', expect.objectContaining({
    container_ids: ['c1', 'c2'],
  })));
});

it('without a move, Add container offers every unarchived container', async () => {
  const user = userEvent.setup();
  api.listContainers.mockResolvedValue(ON_MOVE);
  renderEdit();
  await lookupsLoaded();

  await openAddContainer(user);
  expect(await screen.findByRole('button', { name: /container a/i })).not.toBeNull();
  expect(screen.getByRole('button', { name: /container b/i })).not.toBeNull();
  expect(screen.getByRole('button', { name: /container c/i })).not.toBeNull();
  expect(screen.queryByRole('button', { name: /container d/i })).toBeNull();
});

it('Remove takes a container off the truck on Save', async () => {
  const user = userEvent.setup();
  api.listContainers.mockResolvedValue(ON_MOVE);
  api.getTruck.mockResolvedValue(MOVE_TRUCK_DETAIL);
  api.updateTruck.mockResolvedValue(MOVE_TRUCK_DETAIL);
  renderEdit(MOVE_TRUCK);

  await user.click(await screen.findByRole('button', { name: 'Remove Container A' }));
  expect(screen.queryByText('Container A')).toBeNull();
  expect(screen.getByText('No containers on this truck yet.')).not.toBeNull();

  await user.click(screen.getByRole('button', { name: /^save$/i }));
  await waitFor(() => expect(api.updateTruck).toHaveBeenCalledWith('t1', expect.objectContaining({
    container_ids: [],
  })));
});
