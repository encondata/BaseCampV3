// @vitest-environment jsdom
/**
 * TrucksMap — react-leaflet is mocked to plain DOM stand-ins (per the
 * plan) so these assert marker/trail counts, the empty state, and the
 * click → onOpen wiring without a real Leaflet canvas.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { TruckMapPoint } from '../../lib/api';

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
  useMap: () => ({ fitBounds: vi.fn() }),
}));

const { default: TrucksMap } = await import('./TrucksMap');

afterEach(cleanup);

function point(overrides: Partial<TruckMapPoint>): TruckMapPoint {
  return {
    id: 't1', name: 'Truck 1', status: 'en_route', status_label: 'En route',
    status_color: '#178a4c', driver_name: 'Ada Lovelace', load_number: '1042',
    seal_id: 'SEAL-9',
    last_update: { recorded_at: '2026-09-10T00:00:00Z', lat: 40.7, lng: -73.9, approximate_address: 'Newark, NJ' },
    trail: [],
    ...overrides,
  };
}

it('renders one marker per located point and no trails by default', () => {
  const points = [
    point({ id: 't1' }),
    point({ id: 't2', name: 'Truck 2' }),
  ];
  const { container } = render(<TrucksMap points={points} trails={false} onOpen={vi.fn()} />);
  expect(container.querySelectorAll('.mock-marker')).toHaveLength(2);
  expect(container.querySelectorAll('.mock-trail')).toHaveLength(0);
});

it('draws a trail per point with more than one trail entry when trails is on', () => {
  const points = [
    point({ id: 't1', trail: [{ recorded_at: 'a', lat: 40.7, lng: -73.9 }, { recorded_at: 'b', lat: 40.8, lng: -74 }] }),
    point({ id: 't2', trail: [{ recorded_at: 'a', lat: 41, lng: -73 }] }), // single point: no trail line
    point({ id: 't3', trail: [] }),
  ];
  const { container } = render(<TrucksMap points={points} trails={true} onOpen={vi.fn()} />);
  expect(container.querySelectorAll('.mock-trail')).toHaveLength(1);
});

it('excludes points with no coordinates from markers and trails', () => {
  const points = [
    point({ id: 't1' }),
    point({
      id: 't2',
      last_update: { recorded_at: '2026-09-10T00:00:00Z', lat: null, lng: null, approximate_address: '' },
    }),
  ];
  const { container } = render(<TrucksMap points={points} trails={false} onOpen={vi.fn()} />);
  expect(container.querySelectorAll('.mock-marker')).toHaveLength(1);
});

it('shows the empty state copy when there are no located points', () => {
  render(<TrucksMap points={[]} trails={false} onOpen={vi.fn()} />);
  expect(screen.getByText('No trucks are reporting a location.')).not.toBeNull();
  expect(screen.queryByTestId('map')).toBeNull();
});

it('clicking a marker calls onOpen with that truck id', () => {
  const points = [point({ id: 't1' }), point({ id: 't2' })];
  const onOpen = vi.fn();
  const { container } = render(<TrucksMap points={points} trails={false} onOpen={onOpen} />);
  const markers = container.querySelectorAll('.mock-marker');
  (markers[1] as HTMLElement).click();
  expect(onOpen).toHaveBeenCalledWith('t2');
});

it('draws one hollow destination pin per destination site when asked, none by default', () => {
  const dest = { name: 'DC-West', latitude: 39.7, longitude: -105 };
  const points = [
    point({ id: 't1', end_site: dest }),
    point({ id: 't2', end_site: dest }),          // same site: one pin
    point({ id: 't3', end_site: { name: 'DC-South', latitude: 30.2, longitude: -97.7 } }),
    point({ id: 't4', end_site: null }),
  ];
  const off = render(<TrucksMap points={points} trails={false} onOpen={vi.fn()} />);
  expect(off.container.querySelectorAll('.mock-dest')).toHaveLength(0);
  cleanup();
  const { container } = render(
    <TrucksMap points={points} trails={false} onOpen={vi.fn()} destinations />);
  const pins = container.querySelectorAll('.mock-dest');
  expect(pins).toHaveLength(2);
  expect(pins[0].textContent).toContain('DC-West');
  expect(container.querySelectorAll('.mock-marker')).toHaveLength(4);
});

it('passes scrollWheelZoom through and shows a custom empty text', () => {
  const { getByTestId } = render(
    <TrucksMap points={[point({})]} trails={false} onOpen={vi.fn()} scrollWheelZoom={false} />);
  expect(getByTestId('map').getAttribute('data-scroll-zoom')).toBe('false');
  cleanup();
  render(<TrucksMap points={[]} trails={false} onOpen={vi.fn()} emptyText="Nothing here yet." />);
  expect(screen.getByText('Nothing here yet.')).not.toBeNull();
});
