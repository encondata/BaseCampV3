// @vitest-environment jsdom
/**
 * /dashboards/shipments — header controls, counts, the live map's props
 * (current-trip trails, destination pins, wheel zoom off until
 * fullscreen), the update feed (each kind, Show older, prepend on
 * refresh), the trucks table, the move filter, and the refresh cadence
 * including the hidden-tab pause (fake timers + visibilitychange with
 * document.hidden stubbed).
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type {
  TruckFeedEvent, TruckFeedPage, TruckItem, TruckMapPoint, TruckSummary,
} from '../lib/api';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children, scrollWheelZoom }: any) => (
    <div data-testid="map" data-scroll-zoom={String(scrollWheelZoom ?? true)}>{children}</div>
  ),
  TileLayer: () => null,
  Tooltip: ({ children }: any) => <span>{children}</span>,
  CircleMarker: ({ children, eventHandlers, pathOptions }: any) => (
    <div className={pathOptions?.className === 'trucks-dest-pin' ? 'mock-dest' : 'mock-marker'}
         onClick={() => eventHandlers?.click?.()}>{children}</div>
  ),
  Polyline: () => <div className="mock-trail" />,
  useMap: () => ({ fitBounds: vi.fn(), invalidateSize: vi.fn() }),
}));

const auth = vi.hoisted(() => ({ can: (_r: string, _a?: string): boolean => true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can, preferences: { list_size: 'default' } }),
}));

const api = vi.hoisted(() => ({
  listTrucks: vi.fn(),
  getShipmentMap: vi.fn(),
  getTrucksFeed: vi.fn(),
  getTrucksSummary: vi.fn(),
  listInitiatives: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const { default: ShipmentsDashboard } = await import('./ShipmentsDashboard');

/* ── fixtures ──────────────────────────────────────────────────── */

function truck(over: Partial<TruckItem>): TruckItem {
  return {
    id: 't1', legacy_id: null, name: 'Truck 1',
    driver_name: null, co_driver_name: null, team_drive: false, contact_info: '',
    status: 'in_transit', status_label: 'In transit', status_color: '#2f6fed',
    load_number: 'L-1', seal_id: null, tracking_type: {},
    initiative_id: 'i1', initiative_name: 'Denver move',
    start_site_id: 's1', start_site_name: 'DC-East',
    end_site_id: 's2', end_site_name: 'DC-West',
    container_count: 2,
    last_update: { recorded_at: '2026-10-10T12:00:00Z', lat: 40.7, lng: -73.9, approximate_address: 'Newark, NJ' },
    archived_at: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

const TRUCKS: TruckItem[] = [
  truck({ id: 't1', name: 'Truck 10' }),
  truck({ id: 't2', name: 'Truck 2', status: 'active', status_label: 'Active',
    initiative_id: 'i2', initiative_name: 'Austin move', load_number: 'L-2' }),
  truck({ id: 't3', name: 'Truck 3', status: 'historical', status_label: 'Historical' }),
  truck({ id: 't4', name: 'Truck 4', archived_at: '2026-10-02T00:00:00Z' }),
];

function point(t: TruckItem, over: Partial<TruckMapPoint> = {}): TruckMapPoint {
  return {
    id: t.id, name: t.name, status: t.status, status_label: t.status_label,
    status_color: t.status_color, driver_name: null, load_number: t.load_number, seal_id: null,
    last_update: t.last_update!,
    trail: [
      { recorded_at: '2026-10-10T10:00:00Z', lat: 40, lng: -74 },
      { recorded_at: '2026-10-10T12:00:00Z', lat: 40.7, lng: -73.9 },
    ],
    end_site: { name: 'DC-West', latitude: 39.7, longitude: -105 },
    ...over,
  };
}

function ev(over: Partial<TruckFeedEvent>): TruckFeedEvent {
  return {
    id: 'loc:1', at: '2026-10-10T12:00:00Z', kind: 'location',
    truck_id: 't1', truck_name: 'Truck 10', load_number: 'L-1',
    initiative_id: 'i1', initiative_name: 'Denver move', actor_name: null,
    location: null, lat: null, lng: null, address: null, source: null,
    from_status: null, from_label: null, from_color: null,
    to_status: null, to_label: null, to_color: null,
    via: null, container_id: null, container_name: null, asset_count: null,
    from_truck: null, device: null,
    ...over,
  };
}

const FEED_1: TruckFeedPage = {
  events: [
    ev({ id: 'loc:1', at: '2026-10-10T12:00:00Z', address: 'Newark, NJ', source: 'manual' }),
    ev({ id: 'audit:2:status', at: '2026-10-10T11:00:00Z', kind: 'status',
      from_label: 'Active', from_color: '#888', to_label: 'In transit', to_color: '#2f6fed',
      actor_name: 'Ada Lovelace' }),
    ev({ id: 'audit:3', at: '2026-10-10T10:00:00Z', kind: 'load',
      container_name: 'Crate 7', asset_count: 12, via: 'kiosk', truck_id: 't2', truck_name: 'Truck 2' }),
    ev({ id: 'audit:4:unload:c', at: '2026-10-10T09:00:00Z', kind: 'unload',
      container_name: 'Crate 8', via: 'portal' }),
  ],
  next_before: 'cursor-1',
};
const FEED_OLDER: TruckFeedPage = {
  events: [ev({ id: 'loc:old', at: '2026-10-09T08:00:00Z', address: 'Albany, NY', source: 'seed' })],
  next_before: null,
};
const SUMMARY: TruckSummary = { in_transit: 3, active: 2, at_destination: 1, containers_on_board: 7 };

let hidden = false;

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/dashboards/shipments']}>
      <Routes>
        <Route path="/dashboards/shipments" element={<ShipmentsDashboard />} />
        <Route path="/logistics/trucks/:id" element={<div>TRUCK PAGE</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-10-10T12:30:00Z'));
  hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  auth.can = () => true;
  api.listTrucks.mockResolvedValue(TRUCKS);
  api.getShipmentMap.mockResolvedValue([point(TRUCKS[0]), point(TRUCKS[1], { trail: [] })]);
  api.getTrucksFeed.mockImplementation(async ({ before }: { before?: string | null }) =>
    (before ? FEED_OLDER : FEED_1));
  api.getTrucksSummary.mockResolvedValue(SUMMARY);
  api.listInitiatives.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

const panel = (name: string) => screen.getByRole('region', { name });

/* ── tests ─────────────────────────────────────────────────────── */

it('header: title, All moves picker, refresh defaulting to 30 s, updated stamp', async () => {
  renderPage();
  await flush();
  expect(screen.getByRole('heading', { name: 'Shipment tracking' })).not.toBeNull();
  const move = screen.getByRole('combobox', { name: 'Move' }) as HTMLInputElement;
  expect(move.value).toBe('All moves');
  const refresh = screen.getByLabelText('Auto-refresh') as HTMLSelectElement;
  expect(refresh.value).toBe('30');
  expect([...refresh.options].map((o) => o.text)).toEqual(['Off', '15 s', '30 s', '60 s', '5 min']);
  expect(screen.getByText(/^updated /)).not.toBeNull();
});

it('counts: In transit, Loading, At destination, Containers on board', async () => {
  renderPage();
  await flush();
  const kpi = (label: string) => within(panel('Counts')).getByText(label).parentElement!.textContent;
  expect(kpi('In transit')).toContain('3');
  expect(kpi('Loading')).toContain('2');
  expect(kpi('At destination')).toContain('1');
  expect(kpi('Containers on board')).toContain('7');
  expect(api.getTrucksSummary).toHaveBeenCalledWith(null);
});

it('map: current-trip trails, destination pins, wheel zoom off, a truck click opens it', async () => {
  const { container } = renderPage();
  await flush();
  expect(api.getShipmentMap).toHaveBeenCalledWith(null);
  const map = within(panel('Live map'));
  expect(map.getByTestId('map').getAttribute('data-scroll-zoom')).toBe('false');
  expect(container.querySelectorAll('.mock-marker')).toHaveLength(2);
  expect(container.querySelectorAll('.mock-trail')).toHaveLength(1);
  expect(container.querySelectorAll('.mock-dest')).toHaveLength(1);
  fireEvent.click(container.querySelectorAll('.mock-marker')[0]);
  expect(screen.getByText('TRUCK PAGE')).not.toBeNull();
});

it('map: empty state copy when no truck has a position', async () => {
  api.getShipmentMap.mockResolvedValue([]);
  renderPage();
  await flush();
  expect(screen.getByText(
    'No trucks with a recorded position yet. Add a location update on a truck to see it here.',
  )).not.toBeNull();
});

it('fullscreen opens the map in a modal with wheel zoom on', async () => {
  renderPage();
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Fullscreen' }));
  const dialog = screen.getByRole('dialog');
  expect(within(dialog).getByTestId('map').getAttribute('data-scroll-zoom')).toBe('true');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('feed: one row per event with its text, truck link and relative time', async () => {
  renderPage();
  await flush();
  const feed = within(panel('Update feed'));
  expect(feed.getByText('Newark, NJ · manual')).not.toBeNull();
  expect(feed.getByText('by Ada Lovelace')).not.toBeNull();
  expect(feed.getByText('Active')).not.toBeNull();
  expect(feed.getAllByText('In transit').length).toBeGreaterThan(0);
  expect(feed.getByText('Loaded Crate 7 (12 assets) · kiosk')).not.toBeNull();
  expect(feed.getByText('Unloaded Crate 8 · portal')).not.toBeNull();
  const link = feed.getAllByRole('link', { name: 'Truck 2' })[0];
  expect(link.getAttribute('href')).toBe('/logistics/trucks/t2');
  expect(feed.getByText('30m ago')).not.toBeNull();
  expect(api.getTrucksFeed).toHaveBeenCalledWith({ initiativeId: null, limit: 50 });
});

it('feed: Show older fetches with next_before and appends', async () => {
  renderPage();
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Show older' }));
  await flush();
  expect(api.getTrucksFeed).toHaveBeenLastCalledWith({ initiativeId: null, limit: 50, before: 'cursor-1' });
  const feed = within(panel('Update feed'));
  expect(feed.getByText('Albany, NY · seed')).not.toBeNull();
  expect(feed.getByText('Newark, NJ · manual')).not.toBeNull();
  expect(screen.queryByRole('button', { name: 'Show older' })).toBeNull(); // no more pages
});

it('refresh prepends new events without dropping older pages, and a failed tick keeps the data', async () => {
  renderPage();
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Show older' }));
  await flush();

  api.getTrucksFeed.mockResolvedValueOnce({
    events: [ev({ id: 'loc:new', at: '2026-10-10T12:29:00Z', address: 'Trenton, NJ', source: 'manual' }),
      ...FEED_1.events],
    next_before: 'cursor-1',
  });
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  const feed = within(panel('Update feed'));
  const texts = feed.getAllByTestId('feed-row').map((r) => r.textContent ?? '');
  expect(texts[0]).toContain('Trenton, NJ');
  expect(texts.some((t) => t.includes('Albany, NY'))).toBe(true);
  expect(texts).toHaveLength(6);

  api.getTrucksFeed.mockRejectedValueOnce(new Error('down'));
  api.getTrucksSummary.mockRejectedValueOnce(new Error('down'));
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(feed.getAllByTestId('feed-row')).toHaveLength(6);
  expect(screen.getByText('Containers on board').parentElement!.textContent).toContain('7');
});

it('refreshes every 30 s by default, pauses while hidden, refreshes on return, stops when Off', async () => {
  renderPage();
  await flush();
  expect(api.getTrucksSummary).toHaveBeenCalledTimes(1);

  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(api.getTrucksSummary).toHaveBeenCalledTimes(2);

  hidden = true;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await act(() => vi.advanceTimersByTimeAsync(90_000));
  expect(api.getTrucksSummary).toHaveBeenCalledTimes(2);

  hidden = false;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await flush();
  expect(api.getTrucksSummary).toHaveBeenCalledTimes(3);
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(api.getTrucksSummary).toHaveBeenCalledTimes(4);

  fireEvent.change(screen.getByLabelText('Auto-refresh'), { target: { value: '0' } });
  await act(() => vi.advanceTimersByTimeAsync(120_000));
  expect(api.getTrucksSummary).toHaveBeenCalledTimes(4);

  // Off: coming back to the tab does not refresh either
  hidden = true;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  hidden = false;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
  await flush();
  expect(api.getTrucksSummary).toHaveBeenCalledTimes(4);
});

it('changing the move refetches with its id and clears the old move’s panels', async () => {
  renderPage();
  await flush();
  let resolveSummary: (s: TruckSummary) => void = () => {};
  api.getTrucksSummary.mockImplementationOnce(() => new Promise((r) => { resolveSummary = r; }));
  api.getTrucksFeed.mockImplementation(() => new Promise(() => {}));

  const move = screen.getByRole('combobox', { name: 'Move' });
  fireEvent.focus(move);
  fireEvent.mouseDown(screen.getByRole('button', { name: 'Austin move' }));
  await flush();

  expect(api.getTrucksSummary).toHaveBeenLastCalledWith('i2');
  expect(api.getShipmentMap).toHaveBeenLastCalledWith('i2');
  expect(api.getTrucksFeed).toHaveBeenLastCalledWith({ initiativeId: 'i2', limit: 50 });
  // the old move's numbers and feed are gone while the new ones load
  expect(screen.getByText('Containers on board').parentElement!.textContent).not.toContain('7');
  expect(within(panel('Update feed')).queryByText('Newark, NJ · manual')).toBeNull();
  // the table filters to the move straight away (trucks come from one list)
  const table = within(panel('Trucks'));
  expect(table.queryByRole('link', { name: 'Truck 10' })).toBeNull();
  expect(table.getByRole('link', { name: 'Truck 2' })).not.toBeNull();

  await act(async () => { resolveSummary({ ...SUMMARY, containers_on_board: 4 }); });
  expect(screen.getByText('Containers on board').parentElement!.textContent).toContain('4');
});

it('trucks table: live, non-archived trucks, naturally sorted, linked', async () => {
  renderPage();
  await flush();
  const table = within(panel('Trucks'));
  const links = table.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/logistics/trucks/'));
  expect(links.map((a) => a.textContent)).toEqual(['Truck 2', 'Truck 10']);
  expect(links[0].getAttribute('href')).toBe('/logistics/trucks/t2');
  expect(table.queryByText('Truck 3')).toBeNull();
  expect(table.queryByText('Truck 4')).toBeNull();
  expect(table.getAllByText('DC-East').length).toBeGreaterThan(0);
  expect(table.getAllByText('Newark, NJ').length).toBe(2);
  // sort by the name header flips the order
  fireEvent.click(table.getByRole('button', { name: /^Truck/ }));
  const after = table.getAllByRole('link').filter((a) => a.getAttribute('href')?.startsWith('/logistics/trucks/'));
  expect(after.map((a) => a.textContent)).toEqual(['Truck 10', 'Truck 2']);
});
