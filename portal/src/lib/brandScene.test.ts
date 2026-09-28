// @vitest-environment jsdom
/** The login terrain scene lives in lib/ so the kiosk app can import it
 *  without pulling in a React component. jsdom has no SVG geometry, so
 *  the few methods gsap's MotionPath needs are stubbed. */
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

it('the kiosk scene keeps the original route, traveler and no map extras', () => {
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
