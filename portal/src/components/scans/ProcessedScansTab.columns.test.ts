/** ProcessedScansTab has no test file (and Scans.tsx, the page that
 *  mounts it, has none either) to carry a rendered column-floors
 *  assertion — see recipe R7. This asserts the pure computation instead,
 *  against the registry's home in lib/ so the test needs no DOM. */
import { describe, expect, it } from 'vitest';

import { LIST_FIT, listGridStyle } from '../../lib/listTools';
import {
  PROCESSED_SCAN_COLUMNS as COLUMNS, PROCESSED_SCAN_PRIMARY_COL as PRIMARY_COL,
} from '../../lib/scanColumns';

describe('ProcessedScansTab columns', () => {
  it('default columns fit .portal-page at a 1512px window, nav expanded', () => {
    const defaults = [PRIMARY_COL, ...COLUMNS.filter((c) => c.default)];
    expect(listGridStyle(defaults, ['30px']).minWidth).toBeLessThanOrEqual(LIST_FIT.page);
  });
});
