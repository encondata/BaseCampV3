/** Workers has no test file to carry a rendered column-floors assertion
 *  (see recipe R7) — this asserts the pure computation instead. */
import { describe, expect, it } from 'vitest';

import { LIST_FIT, listGridStyle } from '../lib/listTools';
import { COLUMNS, PRIMARY_COL } from './Workers';

describe('Workers columns', () => {
  it('default columns fit .portal-page at a 1512px window, nav expanded', () => {
    const defaults = [PRIMARY_COL, ...COLUMNS.filter((c) => c.default)];
    expect(listGridStyle(defaults, ['30px']).minWidth).toBeLessThanOrEqual(LIST_FIT.page);
  });
});
