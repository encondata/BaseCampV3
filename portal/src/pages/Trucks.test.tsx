// @vitest-environment jsdom
/**
 * /logistics/trucks — covers what's specific to this page: seeded rows,
 * the historical-hides-by-default toggle, the map panel's markers
 * tracking the list's own filtered/visible set, and the refresh-cadence
 * re-fetch. Generic toolbar/column-menu/reorder/CSV behavior is covered
 * by lib/listTools.test.tsx and lib/columnMenu.test.tsx.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { TruckItem, TruckMapPoint, UiPreferences } from '../lib/api';

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

const auth = vi.hoisted(() => ({ can: (_r: string, _a?: string): boolean => true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true,
      notif: { critical: true, email: true, maint: true, digest: true },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  listTrucks: vi.fn(),
  getTrucksMap: vi.fn(),
  archiveTruck: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

function truck(overrides: Partial<TruckItem>): TruckItem {
  return {
    id: 't1', legacy_id: null, name: 'Truck 1',
    driver_name: 'Ada Lovelace', co_driver_name: null, team_drive: false,
    contact_info: '555-1212',
    status: 'en_route', status_label: 'En route', status_color: '#178a4c',
    load_number: '1001', seal_id: 'SEAL-1',
    tracking_type: { type: 'gps', update_type: 'API', tracker_id: 'TRK-1' },
    initiative_id: 'i1', initiative_name: 'Denver DC migration',
    start_site_id: 's1', start_site_name: 'DC-East',
    end_site_id: 's2', end_site_name: 'DC-West',
    container_count: 2,
    last_update: {
      recorded_at: '2026-09-10T00:00:00Z', lat: 40.7, lng: -73.9,
      approximate_address: 'Newark, NJ',
    },
    archived_at: null, created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function point(t: TruckItem): TruckMapPoint {
  return {
    id: t.id, name: t.name, status: t.status, status_label: t.status_label,
    status_color: t.status_color, driver_name: t.driver_name, load_number: t.load_number,
    seal_id: t.seal_id,
    last_update: t.last_update ?? { recorded_at: '', lat: null, lng: null, approximate_address: '' },
    trail: [],
  };
}

const TRUCKS: TruckItem[] = [
  truck({ id: 't1', name: 'Truck One' }),
  truck({ id: 't2', name: 'Truck Two', load_number: '1002' }),
  truck({ id: 't3', name: 'Truck Three', status: 'historical', status_label: 'Historical', load_number: '1003' }),
];

const { default: Trucks } = await import('./Trucks');

function renderPage() {
  return render(<MemoryRouter><Trucks /></MemoryRouter>);
}

beforeEach(() => {
  auth.can = () => true;
  api.listTrucks.mockResolvedValue(TRUCKS);
  api.getTrucksMap.mockImplementation(async () => TRUCKS.map(point));
  api.archiveTruck.mockResolvedValue(undefined);
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

it('renders seeded rows and hides historical trucks by default', async () => {
  renderPage();

  expect(await screen.findByText('Truck One')).not.toBeNull();
  expect(screen.getByText('Truck Two')).not.toBeNull();
  expect(screen.queryByText('Truck Three')).toBeNull();
});

it('shows historical trucks once the toggle is on', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Truck One');

  await user.click(screen.getByRole('checkbox', { name: /show historical/i }));

  expect(await screen.findByText('Truck Three')).not.toBeNull();
});

it('map markers follow the filtered/visible list', async () => {
  const { container } = renderPage();
  await screen.findByText('Truck One');

  // Two non-historical trucks are visible by default → two markers.
  expect(container.querySelectorAll('.mock-marker')).toHaveLength(2);

  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('Filter this list…'), 'Truck One');

  expect(screen.queryByText('Truck Two')).toBeNull();
  expect(container.querySelectorAll('.mock-marker')).toHaveLength(1);
});

it('changing the refresh option re-fetches on that cadence', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  renderPage();
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByText('Truck One')).not.toBeNull();
  const before = api.listTrucks.mock.calls.length;

  fireEvent.change(screen.getByLabelText(/Refresh/i), { target: { value: '15' } });

  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(api.listTrucks.mock.calls.length).toBe(before + 1);

  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(api.listTrucks.mock.calls.length).toBe(before + 2);
});
