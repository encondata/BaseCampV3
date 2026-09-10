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
  MapContainer: ({ children }: any) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
  Tooltip: ({ children }: any) => <span>{children}</span>,
  CircleMarker: ({ children, eventHandlers }: any) => (
    <div className="mock-marker" onClick={() => eventHandlers?.click?.()}>{children}</div>
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
