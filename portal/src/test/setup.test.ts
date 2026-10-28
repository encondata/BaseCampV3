// @vitest-environment jsdom
/** The portal's test setup (src/test/setup.ts, vite.config.ts `test.setupFiles`). */
import { getConfig } from '@testing-library/react';
import { expect, it } from 'vitest';

it('async queries (findBy…, waitFor) wait up to 3 s: a loaded machine renders slower', () => {
  expect(getConfig().asyncUtilTimeout).toBe(3000);
});
