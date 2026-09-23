/** Audit has no test file to carry a rendered column-floors assertion
 *  (see recipe R7) — this asserts the pure computation instead.
 *  AUDIT_PRIMARY_COL/AUDIT_COLUMNS live in lib/auditFormat.ts (not
 *  Audit.tsx) so this stays cheap: importing the page module would drag
 *  in ComboBox/DataTable/lib/api. */
import { describe, expect, it } from 'vitest';

import { AUDIT_COLUMNS, AUDIT_PRIMARY_COL } from '../lib/auditFormat';
import { LIST_FIT, listGridStyle } from '../lib/listTools';

describe('Audit columns', () => {
  it('default columns fit .portal-page at a 1512px window, nav expanded', () => {
    const defaults = [AUDIT_PRIMARY_COL, ...AUDIT_COLUMNS.filter((c) => c.default)];
    expect(listGridStyle(defaults, ['30px']).minWidth).toBeLessThanOrEqual(LIST_FIT.page);
  });
});
