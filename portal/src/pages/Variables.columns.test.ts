// @vitest-environment jsdom
/**
 * Variables has no page-level test file (its render behavior is covered
 * per-tab, and no other test mounts it) and each tab's grid is unsorted —
 * this file just checks that every tab's default columns fit the recipe's
 * fit target, per the migration recipe's R7 fallback.
 */
import { describe, expect, it } from 'vitest';

import { listGridStyle } from '../lib/listTools';
import {
  CATEGORY_COLUMNS, SITE_TYPE_COLUMNS, STATUS_COLUMNS, WORKER_LEVEL_COLUMNS,
} from './Variables';

const FIT_TARGET = 1176;

describe('Variables columns', () => {
  it('Statuses tab: default columns fit .portal-page at a 1512px window', () => {
    const defaults = STATUS_COLUMNS.filter((c) => c.default);
    expect(listGridStyle(defaults, ['30px']).minWidth).toBeLessThanOrEqual(FIT_TARGET);
  });

  it('Site types tab: default columns fit .portal-page at a 1512px window', () => {
    const defaults = SITE_TYPE_COLUMNS.filter((c) => c.default);
    expect(listGridStyle(defaults, ['30px']).minWidth).toBeLessThanOrEqual(FIT_TARGET);
  });

  it('Worker levels tab: default columns fit .portal-page at a 1512px window', () => {
    const defaults = WORKER_LEVEL_COLUMNS.filter((c) => c.default);
    expect(listGridStyle(defaults, ['30px']).minWidth).toBeLessThanOrEqual(FIT_TARGET);
  });

  it('Asset categories tab: default columns fit .portal-page at a 1512px window', () => {
    const defaults = CATEGORY_COLUMNS.filter((c) => c.default);
    expect(listGridStyle(defaults, ['30px']).minWidth).toBeLessThanOrEqual(FIT_TARGET);
  });
});
