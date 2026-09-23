// @vitest-environment jsdom
/** The login terrain scene lives in lib/ so the kiosk app can import it
 *  without pulling in a React component. jsdom has no SVG geometry, so
 *  the few methods gsap's MotionPath needs are stubbed. */
import { gsap } from 'gsap';
import { expect, it } from 'vitest';

import { buildBrandScene } from './brandScene';

Object.assign(SVGElement.prototype, {
  getTotalLength: () => 100,
  getPointAtLength: () => ({ x: 0, y: 0 }),
  getBBox: () => ({ x: 0, y: 0, width: 100, height: 100 }),
});

it('builds the scene into an svg and returns a cleanup that empties it', () => {
  const brand = document.createElement('section');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  brand.appendChild(svg);
  document.body.appendChild(brand);
  const cleanup = buildBrandScene(brand, svg, true);
  expect(typeof cleanup).toBe('function');
  cleanup();
  expect(svg.innerHTML).toBe('');
});

function mount() {
  const brand = document.createElement('section');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  brand.appendChild(svg);
  document.body.appendChild(brand);
  return { brand, svg };
}

it('map layout draws the Dallas → Las Vegas route with callout and state names', () => {
  const { brand, svg } = mount();
  const cleanup = buildBrandScene(brand, svg, true, { layout: 'map' });
  const text = svg.textContent ?? '';
  expect(text).toContain('ORIGIN · DAL-7');
  expect(text).toContain('Dallas, TX · HALL B');
  expect(text).toContain('DESTINATION · LAS-9');
  expect(text).toContain('ROUTE 07');
  expect(svg.querySelectorAll('.map-state')).toHaveLength(4);
  expect(svg.querySelector('.waypoint-dot')).not.toBeNull();
  cleanup();
});

it('map layout reduced motion: whole route shown lit and still, marker hidden', () => {
  const { brand, svg } = mount();
  const cleanup = buildBrandScene(brand, svg, true, { layout: 'map' });
  const reveal = svg.querySelector('mask path') as SVGPathElement;
  expect(svg.querySelector('.route-lit')).not.toBeNull();
  expect(reveal.style.strokeDashoffset).toBe('0');
  expect((svg.querySelector('.route-marker') as SVGGElement).style.opacity).toBe('0');
  expect(gsap.getById('routeTrip')).toBeFalsy();
  cleanup();
});

it('map layout with motion runs the route trip loop instead of the sherpa trek', () => {
  const { brand, svg } = mount();
  const cleanup = buildBrandScene(brand, svg, false, { layout: 'map' });
  const trip = gsap.getById('routeTrip');
  if (!trip) throw new Error('routeTrip timeline was not created');
  expect(trip.repeat()).toBe(-1);
  expect(trip.repeatDelay()).toBeGreaterThanOrEqual(5);
  expect(trip.repeatDelay()).toBeLessThanOrEqual(8);
  expect(svg.querySelector('.walker')).toBeNull();
  // the trail starts dark: nothing revealed before the marker moves
  const reveal = svg.querySelector('mask path') as SVGPathElement;
  expect(reveal.style.strokeDashoffset).toBe(reveal.style.strokeDasharray);
  cleanup();
});

it('classic layout (the kiosk default) keeps the original route and no map extras', () => {
  const { brand, svg } = mount();
  const cleanup = buildBrandScene(brand, svg, true);
  const text = svg.textContent ?? '';
  expect(text).toContain('DEST · ZRH-3');
  expect(svg.querySelector('.route-callout')).toBeNull();
  expect(svg.querySelectorAll('.map-state')).toHaveLength(0);
  expect(svg.querySelector('.route-marker')).toBeNull();
  expect(svg.querySelector('.walker')).not.toBeNull();
  cleanup();
});
