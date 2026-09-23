/** SiteSurveyList has no test file (and SiteDetail.tsx, the page that
 *  mounts it, has none either) to carry a rendered column-floors
 *  assertion — see recipe R7. This asserts the pure computation instead,
 *  against the registry's home in lib/ so the test needs no DOM. */
import { describe, expect, it } from 'vitest';

import { LIST_FIT, listGridStyle } from '../../lib/listTools';
import {
  SITE_SURVEY_COLUMNS as COLUMNS, SITE_SURVEY_PRIMARY_COL as PRIMARY_COL,
} from '../../lib/surveyColumns';

describe('SiteSurveyList columns', () => {
  it('default columns fit .init-panel (LIST_FIT.initPanel) at 1512px, nav expanded', () => {
    const defaults = [PRIMARY_COL, ...COLUMNS.filter((c) => c.default)];
    expect(listGridStyle(defaults).minWidth).toBeLessThanOrEqual(LIST_FIT.initPanel);
  });
});
