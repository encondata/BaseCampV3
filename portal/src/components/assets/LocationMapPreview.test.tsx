// @vitest-environment jsdom
/**
 * LocationMapPreview — the map card shown when hovering (or focusing) an
 * asset's location. react-leaflet is mocked to plain DOM stand-ins, as in
 * TrucksMap.test.tsx, and the position cache is mocked so each test
 * picks the answer. Covers: no fetch before the delay or on a quick pass,
 * the truck map, a truck with no report, a site pin, the error line,
 * keyboard open/close, closing on leave / scroll / Escape, and that
 * wrapping never swallows a click.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ContainerPosition } from '../../lib/api';

vi.mock('react-leaflet', () => ({
  MapContainer: ({ children, center }: any) => (
    <div data-testid="map" data-center={String(center)}>{children}</div>
  ),
  TileLayer: () => null,
  CircleMarker: ({ pathOptions }: any) => <div className={pathOptions?.className} />,
}));

const loadContainerPosition = vi.fn();
vi.mock('../../lib/containerPosition', async (orig) => ({
  ...(await orig<typeof import('../../lib/containerPosition')>()),
  loadContainerPosition: (id: string) => loadContainerPosition(id),
}));

const { default: LocationMapPreview } = await import('./LocationMapPreview');
const { PREVIEW_DELAY_MS } = await import('../PhotoPreview');

const TRUCK: ContainerPosition = {
  kind: 'truck', name: 'Truck 1', lat: 33.1, lng: -84.2,
  recorded_at: new Date().toISOString(), approximate_address: 'I-85 N',
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  loadContainerPosition.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const card = () => document.querySelector('.lmp-card');

function shell(onClick = vi.fn()) {
  return render(
    <div className="portal-shell" data-testid="shell" onClick={onClick}>
      <LocationMapPreview containerId="c1">
        <a href="#crate" data-testid="link">CR-0001</a>
      </LocationMapPreview>
    </div>,
  );
}

function hover(el: Element) {
  fireEvent.mouseOver(el);
  fireEvent.mouseEnter(el);
}

async function openOn(el: Element) {
  hover(el);
  await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
}

it('fetches nothing before 300 ms and nothing on a quick pass', async () => {
  loadContainerPosition.mockResolvedValue(TRUCK);
  const { getByTestId } = shell();
  const link = getByTestId('link');
  hover(link);
  await act(async () => { vi.advanceTimersByTime(200); });
  fireEvent.mouseLeave(link);
  await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS * 2); });
  expect(loadContainerPosition).not.toHaveBeenCalled();
  expect(card()).toBeNull();
});

it('shows the truck map after the delay', async () => {
  let resolve!: (p: ContainerPosition) => void;
  loadContainerPosition.mockReturnValue(new Promise((r) => { resolve = r; }));
  const { getByTestId } = shell();
  await openOn(getByTestId('link'));
  expect(loadContainerPosition).toHaveBeenCalledWith('c1');
  expect(card()!.textContent).toContain('Loading position…');

  await act(async () => { resolve(TRUCK); });
  const c = card()!;
  expect(getByTestId('shell').contains(c)).toBe(true);
  expect(c.querySelector('[data-testid="map"]')!.getAttribute('data-center')).toBe('33.1,-84.2');
  expect(c.querySelector('.lmp-pin-truck')).not.toBeNull();
  expect(c.querySelector('.lmp-title')!.textContent).toBe('Truck 1');
  expect(c.querySelector('.lmp-detail')!.textContent).toMatch(/^Last report \d\d:\d\d · just now · I-85 N$/);
});

it('shows a note and no map for a truck with no report', async () => {
  loadContainerPosition.mockResolvedValue({
    ...TRUCK, lat: null, lng: null, recorded_at: null, approximate_address: '',
  });
  const { getByTestId } = shell();
  await openOn(getByTestId('link'));
  const c = card()!;
  expect(c.querySelector('[data-testid="map"]')).toBeNull();
  expect(c.querySelector('.lmp-title')!.textContent).toBe('Truck 1');
  expect(c.querySelector('.lmp-note')!.textContent).toBe("Truck 1 hasn't reported a position yet");
});

it('labels a site pin', async () => {
  loadContainerPosition.mockResolvedValue({
    kind: 'site', name: 'Atlanta DC', lat: 33.7, lng: -84.4,
    recorded_at: null, approximate_address: '',
  });
  const { getByTestId } = shell();
  await openOn(getByTestId('link'));
  const c = card()!;
  expect(c.querySelector('.lmp-pin-site')).not.toBeNull();
  expect(c.querySelector('.lmp-pin-truck')).toBeNull();
  expect(c.querySelector('.lmp-title')!.textContent).toBe('Atlanta DC');
  expect(c.querySelector('.lmp-detail')!.textContent).toBe('Site location, not a live position');
});

it('shows "No known position" and no map for kind none', async () => {
  loadContainerPosition.mockResolvedValue({
    kind: 'none', name: null, lat: null, lng: null,
    recorded_at: null, approximate_address: '',
  });
  const { getByTestId } = shell();
  await openOn(getByTestId('link'));
  const c = card()!;
  expect(c.querySelector('[data-testid="map"]')).toBeNull();
  expect(c.querySelector('.lmp-title')).toBeNull();
  expect(c.querySelector('.lmp-note')!.textContent).toBe('No known position');
});

it('shows the error line when loading fails', async () => {
  loadContainerPosition.mockRejectedValue(new Error('boom'));
  const { getByTestId } = shell();
  await openOn(getByTestId('link'));
  expect(card()!.textContent).toContain("Couldn't load the position");
  expect(card()!.querySelector('[data-testid="map"]')).toBeNull();
});

it('opens on focus and closes on blur', async () => {
  loadContainerPosition.mockResolvedValue(TRUCK);
  const { getByTestId } = shell();
  const link = getByTestId('link');
  act(() => { link.focus(); });
  await act(async () => { vi.advanceTimersByTime(PREVIEW_DELAY_MS); });
  expect(card()).not.toBeNull();
  expect(card()!.querySelector('.lmp-title')!.textContent).toBe('Truck 1');
  act(() => { link.blur(); });
  expect(card()).toBeNull();
});

it('closes on leave, scroll and Escape', async () => {
  loadContainerPosition.mockResolvedValue(TRUCK);
  const { getByTestId } = shell();
  const link = getByTestId('link');

  await openOn(link);
  expect(card()).not.toBeNull();
  fireEvent.mouseLeave(link);
  expect(card()).toBeNull();

  await openOn(link);
  expect(card()).not.toBeNull();
  fireEvent.scroll(window);
  expect(card()).toBeNull();

  await openOn(link);
  expect(card()).not.toBeNull();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(card()).toBeNull();
});

it('closes on unmount', async () => {
  loadContainerPosition.mockResolvedValue(TRUCK);
  const { getByTestId, unmount } = shell();
  await openOn(getByTestId('link'));
  expect(card()).not.toBeNull();
  unmount();
  expect(card()).toBeNull();
});

it('does not stop clicks on the wrapped link', async () => {
  loadContainerPosition.mockResolvedValue(TRUCK);
  const onClick = vi.fn();
  const { getByTestId } = shell(onClick);
  const link = getByTestId('link');
  await openOn(link);
  fireEvent.click(link);
  expect(onClick).toHaveBeenCalledTimes(1);
});
