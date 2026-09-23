/** RawScansTab has no test file (and Scans.tsx, the page that mounts it,
 *  has none either) to carry a rendered column-floors assertion — see
 *  recipe R7. This asserts the pure computation instead. */
import { describe, expect, it } from 'vitest';

import { listGridStyle } from '../../lib/listTools';
import { COLUMNS, PRIMARY_COL } from './RawScansTab';

describe('RawScansTab columns', () => {
  it('default columns fit .portal-page at a 1512px window, nav expanded', () => {
    const defaults = [PRIMARY_COL, ...COLUMNS.filter((c) => c.default)];
    expect(listGridStyle(defaults, ['30px']).minWidth).toBeLessThanOrEqual(1176);
  });
});
