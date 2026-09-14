// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';

import {
  DEFAULT_APPEARANCE, hslCss, readAppearance, subscribeAppearance, writeAppearance,
} from './appearance';

afterEach(() => localStorage.clear());

it('defaults to the good/not-found colors when nothing is stored', () => {
  expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
  expect(DEFAULT_APPEARANCE.good_scan).toEqual({ h: 150, s: 60, l: 45 });
  expect(DEFAULT_APPEARANCE.not_found_scan).toEqual({ h: 0, s: 70, l: 50 });
});

it('writes a patch, keeps the other color, and notifies subscribers', () => {
  let calls = 0;
  const off = subscribeAppearance(() => { calls += 1; });
  expect(writeAppearance({ good_scan: { h: 200, s: 80, l: 40 } })).toBe(true);
  expect(calls).toBe(1);
  expect(readAppearance()).toEqual({
    good_scan: { h: 200, s: 80, l: 40 },
    not_found_scan: DEFAULT_APPEARANCE.not_found_scan,
  });
  off();
});

it('re-reads the persisted value on a fresh read and keeps a stable snapshot', () => {
  writeAppearance({ not_found_scan: { h: 310, s: 50, l: 55 } });
  const first = readAppearance();
  expect(first.not_found_scan).toEqual({ h: 310, s: 50, l: 55 });
  expect(readAppearance()).toBe(first); // referentially stable for useSyncExternalStore
});

it('falls back to the defaults for malformed or out-of-range stored JSON', () => {
  localStorage.setItem('ss.kiosk.appearance', '{oops');
  expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
  localStorage.setItem('ss.kiosk.appearance', JSON.stringify({ good_scan: { h: 999, s: 1, l: 1 } }));
  expect(readAppearance()).toEqual(DEFAULT_APPEARANCE);
});

it('hslCss renders the CSS color function', () => {
  expect(hslCss({ h: 150, s: 60, l: 45 })).toBe('hsl(150 60% 45%)');
  expect(hslCss({ h: 0, s: 70, l: 50 })).toBe('hsl(0 70% 50%)');
});
