// @vitest-environment jsdom
/**
 * TruckDetail (/logistics/trucks/:id) — sections render from the mocked
 * getTruck/listTruckUpdates payloads, the manual Add-update / Clear-
 * updates flows against the location-updates API, and the 404 empty
 * state. react-leaflet is mocked to plain DOM stand-ins the same way
 * Trucks.test.tsx / TrucksMap.test.tsx do, since the Trail panel renders
 * the real TrucksMap whenever an update carries coordinates.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type TruckDetail as TruckDetailData, type TruckUpdate } from '../lib/api';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
  Tooltip: ({ children }: any) => <span>{children}</span>,
  CircleMarker: ({ children, eventHandlers }: any) => (
    <div className="mock-marker" onClick={() => eventHandlers?.click?.()}>{children}</div>
  ),
  Polyline: () => <div className="mock-trail" />,
  useMap: () => ({ fitBounds: vi.fn() }),
}));

const state = vi.hoisted(() => ({ id: 't1' }));

vi.mock('react-router-dom', async (importActual) => ({
  ...(await importActual<typeof import('react-router-dom')>()),
  useParams: () => ({ id: state.id }),
}));

const auth = vi.hoisted(() => ({ can: (_r: string, _a?: string): boolean => true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can }),
}));

const api = vi.hoisted(() => ({
  getTruck: vi.fn(),
  listTruckUpdates: vi.fn(),
  addTruckUpdate: vi.fn(),
  clearTruckUpdates: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const TRUCK: TruckDetailData = {
  id: 't1', legacy_id: null, name: 'Truck One',
  driver_name: 'Ada Lovelace', co_driver_name: 'Grace Hopper', team_drive: true,
  contact_info: '555-1212', status: 'en_route', status_label: 'En route', status_color: '#178a4c',
  load_number: '1001', seal_id: 'SEAL-1',
  tracking_type: { type: 'gps', update_type: 'API', tracker_id: 'TRK-1' },
  initiative_id: 'i1', initiative_name: 'Denver DC migration',
  start_site_id: 's1', start_site_name: 'DC-East',
  end_site_id: 's2', end_site_name: 'DC-West',
  container_count: 1,
  last_update: { recorded_at: '2026-09-10T02:00:00Z', lat: 40.7, lng: -73.9, approximate_address: 'Newark, NJ' },
  archived_at: null, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
  containers: [
    { id: 'c1', name: 'Container A', status: 'active', status_label: 'Active', status_color: '#178a4c', asset_count: 3 },
  ],
};

const UPDATES: TruckUpdate[] = [
  {
    id: 'u2', truck_id: 't1', recorded_at: '2026-09-10T02:00:00Z',
    location: '40.7, -73.9', lat: 40.7, lng: -73.9,
    approximate_address: 'Newark, NJ', source: 'manual',
  },
  {
    id: 'u1', truck_id: 't1', recorded_at: '2026-09-09T00:00:00Z',
    location: '40.6, -74.0', lat: 40.6, lng: -74.0,
    approximate_address: 'Jersey City, NJ', source: 'gps',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  state.id = 't1';
  api.getTruck.mockResolvedValue(TRUCK);
  api.listTruckUpdates.mockResolvedValue(UPDATES);
});

afterEach(cleanup);

const { default: TruckDetail } = await import('./TruckDetail');

function renderPage() {
  return render(<MemoryRouter><TruckDetail /></MemoryRouter>);
}

it('renders the hero, drivers, tracking, route link, containers, and updates from the mocked payloads', async () => {
  const { container } = renderPage();

  expect(await screen.findByText('Truck One')).not.toBeNull();
  expect(screen.getByText('Team drive')).not.toBeNull();
  expect(screen.getByText('Ada Lovelace')).not.toBeNull();
  expect(screen.getByText('Grace Hopper')).not.toBeNull();
  expect(screen.getByText('TRK-1')).not.toBeNull();

  const siteLink = screen.getByRole('link', { name: 'DC-East' });
  expect(siteLink.getAttribute('href')).toBe('/sites/s1');

  expect(screen.getByText('Container A')).not.toBeNull();

  const rows = container.querySelectorAll('table.data-table tbody tr');
  expect(rows).toHaveLength(2);
});

it('adds a location update and re-lists', async () => {
  const user = userEvent.setup();
  api.addTruckUpdate.mockResolvedValue(UPDATES[0]);
  renderPage();
  await screen.findByText('Truck One');

  await user.click(screen.getByRole('button', { name: /^add update$/i }));
  const heading = await screen.findByRole('heading', { name: /^add update$/i });
  const dialog = heading.closest('.modal-card') as HTMLElement;

  await user.type(within(dialog).getByLabelText(/location/i), '32.7767, -96.797');
  await user.type(within(dialog).getByLabelText(/address/i), 'Dallas, TX');
  await user.click(within(dialog).getByRole('button', { name: /^add update$/i }));

  await waitFor(() => expect(api.addTruckUpdate).toHaveBeenCalledWith('t1', {
    location: '32.7767, -96.797',
    approximate_address: 'Dallas, TX',
  }));
  await waitFor(() => expect(api.listTruckUpdates).toHaveBeenCalledTimes(2));
});

it('rejects an invalid location and never posts', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Truck One');

  await user.click(screen.getByRole('button', { name: /^add update$/i }));
  const heading = await screen.findByRole('heading', { name: /^add update$/i });
  const dialog = heading.closest('.modal-card') as HTMLElement;

  await user.type(within(dialog).getByLabelText(/location/i), 'not a location');
  await user.click(within(dialog).getByRole('button', { name: /^add update$/i }));

  expect(await within(dialog).findByText('Enter a location as "lat, lng".')).not.toBeNull();
  expect(api.addTruckUpdate).not.toHaveBeenCalled();
});

it('clears updates after confirmation', async () => {
  const user = userEvent.setup();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.clearTruckUpdates.mockResolvedValue(undefined);
  renderPage();
  await screen.findByText('Truck One');

  await user.click(screen.getByRole('button', { name: /^clear updates$/i }));

  expect(window.confirm).toHaveBeenCalledWith('Clear every location update for this truck?');
  await waitFor(() => expect(api.clearTruckUpdates).toHaveBeenCalledWith('t1'));
});

it('shows a not-found empty state for a missing truck', async () => {
  api.getTruck.mockRejectedValue(new ApiError(404, 'truck_not_found'));
  renderPage();

  expect(await screen.findByText('That truck no longer exists.')).not.toBeNull();
});

it('ignores a stale getTruck response for a previous id after navigating to a new one', async () => {
  let resolveA!: (v: TruckDetailData) => void;
  let resolveB!: (v: TruckDetailData) => void;
  const truckA: TruckDetailData = { ...TRUCK, id: 't1', name: 'Truck One' };
  const truckB: TruckDetailData = { ...TRUCK, id: 't2', name: 'Truck Two' };

  api.getTruck.mockImplementation((id: string) => new Promise((res) => {
    if (id === 't1') resolveA = res; else resolveB = res;
  }));
  api.listTruckUpdates.mockResolvedValue([]);

  state.id = 't1';
  const { rerender } = renderPage();
  await waitFor(() => expect(api.getTruck).toHaveBeenCalledWith('t1'));

  state.id = 't2';
  rerender(<MemoryRouter><TruckDetail /></MemoryRouter>);
  await waitFor(() => expect(api.getTruck).toHaveBeenCalledWith('t2'));

  // Resolve the new id's request first, then the stale (previous-id)
  // one — the stale response must never overwrite what's on screen.
  resolveB(truckB);
  await screen.findByText('Truck Two');
  resolveA(truckA);
  await new Promise((r) => setTimeout(r, 0));

  expect(screen.getByText('Truck Two')).not.toBeNull();
  expect(screen.queryByText('Truck One')).toBeNull();
});

it('falls back to the truck\'s last_update for the Trail panel when listTruckUpdates has no located rows', async () => {
  api.listTruckUpdates.mockRejectedValue(new Error('network error'));
  renderPage();

  await screen.findByText('Truck One');
  expect(screen.getByTestId('map')).not.toBeNull();
  expect(screen.queryByText('No location reported yet.')).toBeNull();
});
