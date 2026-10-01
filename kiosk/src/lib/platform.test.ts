// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { isLaptop, platform } from './platform';

afterEach(() => { delete window.__KIOSK_CONFIG__; });

describe('platform', () => {
  it('is web by default', () => {
    expect(platform()).toEqual({ mode: 'web', label: 'Web' });
    expect(isLaptop()).toBe(false);
  });

  it('is laptop when the edge config says so', () => {
    window.__KIOSK_CONFIG__ = { mode: 'laptop' };
    expect(platform()).toEqual({ mode: 'laptop', label: 'Laptop' });
    expect(isLaptop()).toBe(true);
  });
});
