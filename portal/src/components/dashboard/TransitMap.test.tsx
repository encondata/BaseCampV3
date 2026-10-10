// @vitest-environment jsdom
/**
 * Home's in-transit map: the old "coming soon" badge is now a link to the
 * Shipments dashboard, shown only to callers with trucks:view.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children }: any) => <div data-testid="map">{children}</div>,
  TileLayer: () => null,
  Popup: ({ children }: any) => <span>{children}</span>,
  CircleMarker: ({ children }: any) => <div>{children}</div>,
  Polyline: () => null,
  useMap: () => ({ fitBounds: vi.fn() }),
}));

const { default: TransitMap } = await import('./TransitMap');

afterEach(cleanup);

it('shows the Live tracking link to the Shipments dashboard with trucks:view', () => {
  render(<MemoryRouter><TransitMap moves={[]} sites={[]} liveTracking /></MemoryRouter>);
  const link = screen.getByRole('link', { name: 'Live tracking →' });
  expect(link.getAttribute('href')).toBe('/dashboards/shipments');
  expect(screen.queryByText(/coming soon/i)).toBeNull();
});

it('shows no badge at all without trucks:view', () => {
  render(<MemoryRouter><TransitMap moves={[]} sites={[]} liveTracking={false} /></MemoryRouter>);
  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.queryByText(/coming soon|live tracking/i)).toBeNull();
});
