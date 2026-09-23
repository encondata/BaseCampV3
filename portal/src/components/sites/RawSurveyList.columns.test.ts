/** RawSurveyList has no test file (and SiteDetail.tsx, the page that
 *  mounts it, has none either) to carry a rendered column-floors
 *  assertion — see recipe R7. This asserts the pure computation instead. */
import { describe, expect, it } from 'vitest';

import { listGridStyle } from '../../lib/listTools';
import { COLUMNS, PRIMARY_COL } from './RawSurveyList';

describe('RawSurveyList columns', () => {
  it('default columns fit .init-panel (1176 - 36 = 1140px) at a 1512px window, nav expanded', () => {
    const defaults = [PRIMARY_COL, ...COLUMNS.filter((c) => c.default)];
    expect(listGridStyle(defaults).minWidth).toBeLessThanOrEqual(1140);
  });
});
