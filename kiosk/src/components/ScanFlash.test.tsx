// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { flash } from '../lib/flash';
import ScanFlash from './ScanFlash';

/** hsl(150 60% 45%) as jsdom reports it back. */
const GOOD_RGB = 'rgb(46, 184, 115)';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({
    matches: false, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('renders nothing until a flash fires, then paints the overlay in that color', () => {
  render(<ScanFlash />);
  expect(document.querySelector('.scan-flash')).toBeNull();

  act(() => { flash('hsl(150 60% 45%)', 350); });
  const overlay = document.querySelector('.scan-flash') as HTMLElement;
  expect(overlay).not.toBeNull();
  expect(overlay.style.background).toBe(GOOD_RGB); // jsdom normalizes hsl() to rgb()

  act(() => { vi.advanceTimersByTime(400); });
  expect(document.querySelector('.scan-flash')).toBeNull();
});
